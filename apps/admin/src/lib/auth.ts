import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { runWithAdapter } from "@better-auth/core/context";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { assertDatabaseRole, enqueueOutbox, withBusinessTransaction } from "@lobbystack/db";
import { deploymentAppName } from "@lobbystack/domain";
import { accounts, sessions, users, verifications } from "@lobbystack/db";

import { configuredAppOrigins } from "./app-origins";
import { getDatabase } from "./databases";
import { SUPPORTED_LOCALES, resolveLocale, type SupportedLocale } from "./locale";
import { ensureMcpResource, isDisabledOAuthEndpoint, mcpOAuthPlugins, needsMcpResource, oauthProviderSchema, registrationWithApplicationType } from "./oauth-provider";
import { hashReplacementPassword, isLegacyScryptHash, meetsPasswordRequirements, verifyLegacyPassword } from "./password";
import { readyRedis } from "./redis";
import { trustedClientIp, trustedClientIpFromHeaders, trustedClientIpHeader } from "./trusted-client-ip";
import { verifyTurnstile } from "./turnstile";

let instance: any;
let databaseRolesReady: Promise<void> | undefined;

function assertAuthDatabaseRoles(): Promise<void> {
  // Share one in-flight assertion with concurrent callers, but clear it on
  // rejection so a transient role mismatch is re-checked on the next request
  // instead of caching the failure for the life of the process.
  databaseRolesReady ??= Promise.all([
    assertDatabaseRole(getAuthDatabase()),
    assertDatabaseRole(getEmailDatabase()),
  ]).then(
    () => undefined,
    (error: unknown) => {
      databaseRolesReady = undefined;
      throw error;
    },
  );
  return databaseRolesReady;
}

const EXISTING_ACCOUNT_SUBJECTS: Record<SupportedLocale, (appName: string) => string> = {
  en: (appName) => `You already have an account on ${appName}`,
  fr: (appName) => `Votre compte ${appName} existe déjà`,
  es: (appName) => `Ya tiene una cuenta de ${appName}`,
  sr: (appName) => `Već imate ${appName} nalog`,
};

type AuthEmailPurpose = "verification" | "email_change";

// French puts no "de" before the app's name and Serbian never declines it (see docs/branding.md).
const AUTH_EMAIL_SUBJECTS: Record<AuthEmailPurpose | "verification_code" | "password_reset", Record<SupportedLocale, (appName: string) => string>> = {
  verification_code: {
    en: (appName) => `Your ${appName} verification code`,
    fr: (appName) => `Votre code de vérification ${appName}`,
    es: (appName) => `Su código de verificación de ${appName}`,
    sr: (appName) => `Vaš ${appName} kod za potvrdu`,
  },
  verification: {
    en: (appName) => `Confirm your new ${appName} email address`,
    fr: (appName) => `Confirmez votre nouvelle adresse courriel pour ${appName}`,
    es: (appName) => `Confirme su nueva dirección de correo de ${appName}`,
    sr: (appName) => `Potvrdite novu imejl adresu za ${appName} nalog`,
  },
  password_reset: {
    en: (appName) => `Reset your ${appName} password`,
    fr: (appName) => `Réinitialisez votre mot de passe ${appName}`,
    es: (appName) => `Restablezca su contraseña de ${appName}`,
    sr: (appName) => `Resetujte lozinku za ${appName} nalog`,
  },
  email_change: {
    en: (appName) => `Confirm your ${appName} email change`,
    fr: (appName) => `Confirmez le changement d'adresse courriel de votre compte ${appName}`,
    es: (appName) => `Confirme el cambio de correo de su cuenta de ${appName}`,
    sr: (appName) => `Potvrdite promenu imejl adrese za ${appName} nalog`,
  },
};

/** The deployment's name, as auth emails call it (see docs/branding.md). */
async function authEmailAppName(): Promise<string> {
  return await deploymentAppName(getEmailDatabase().db);
}

const enabledEmailOtpPaths = new Set([
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
  "/email-otp/verify-email",
]);

// Password resets go by emailed code only: the forgot-password page asks for
// nothing else. Better Auth's link reset stays off, so no request can have a
// reset link mailed to an account by a route the dashboard doesn't use.
const disabledResetLinkPaths = new Set(["/request-password-reset", "/forget-password", "/reset-password"]);

export function isDisabledAuthEmailEndpoint(path?: string): boolean {
  if (!path) return false;
  if (path === "/send-verification-email") return true;
  if (disabledResetLinkPaths.has(path) || path.startsWith("/reset-password/")) return true;
  return (path.startsWith("/email-otp/") || path.endsWith("/email-otp")) && !enabledEmailOtpPaths.has(path);
}

export function getAuthDatabase() {
  return getDatabase("lobbystack_auth");
}

function getEmailDatabase() {
  return getDatabase("lobbystack_app");
}

function getAuthSecondaryStorage() {
  if (!process.env.REDIS_URL) {
    return undefined;
  }
  const prefix = `${process.env.REDIS_PREFIX ?? "lobbystack"}:better-auth:`;
  const redis = async () => (await readyRedis())!;
  return {
    get: async (key: string) => await (await redis()).get(`${prefix}${key}`),
    set: async (key: string, value: string, ttl?: number) => {
      const store = await redis();
      if (ttl !== undefined && ttl > 0) {
        await store.setex(`${prefix}${key}`, ttl, value);
        return;
      }
      await store.set(`${prefix}${key}`, value);
    },
    delete: async (key: string) => {
      await (await redis()).del(`${prefix}${key}`);
    },
    getAndDelete: async (key: string) => await (await redis()).getdel(`${prefix}${key}`),
    increment: async (key: string, ttl: number) => {
      const result = await (await redis()).eval(
        "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
        1,
        `${prefix}${key}`,
        Math.max(1, Math.ceil(ttl)),
      );
      return Number(result);
    },
  };
}

/** Queues one auth email through the transactional outbox. */
async function enqueueAuthEmailOutbox(input: { userId: string; dedupeKey: string; payload: Record<string, unknown> }): Promise<void> {
  await withBusinessTransaction(getEmailDatabase().db, { actorType: "system" }, async (tx) => {
    await enqueueOutbox(tx, { topic: "email.send", aggregateType: "auth_email", aggregateId: input.userId, dedupeKey: input.dedupeKey, payload: input.payload });
  });
}

/** The account's dashboard language, which its emails are written in. */
async function accountLocale(userId: string): Promise<SupportedLocale> {
  const stored = (await getAuthDatabase().db.select({ preferredLocale: users.preferredLocale }).from(users).where(eq(users.id, userId)).limit(1))[0];
  return resolveLocale(stored?.preferredLocale);
}

/** `newEmail` is where an email change moves the account, which the email to the current address names. */
async function enqueueAuthEmail(input: {
  purpose: AuthEmailPurpose;
  userId: string;
  email: string;
  url: string;
  locale: SupportedLocale;
  newEmail?: string;
}): Promise<void> {
  const urlHash = createHash("sha256").update(input.url).digest("hex");
  await enqueueAuthEmailOutbox({
    userId: input.userId,
    dedupeKey: `auth-email:${input.purpose}:${input.userId}:${urlHash}`,
    payload: {
      template: "verify_email",
      to: input.email,
      subject: AUTH_EMAIL_SUBJECTS[input.purpose][input.locale](await authEmailAppName()),
      variables: {
        url: input.url,
        locale: input.locale,
        ...(input.purpose === "email_change" ? { purpose: "email_change", ...(input.newEmail ? { newEmail: input.newEmail } : {}) } : {}),
      },
    },
  });
}

async function enqueueEmailVerificationCode(input: { userId: string; email: string; otp: string; issuanceId: string; locale: SupportedLocale }): Promise<boolean> {
  await enqueueAuthEmailOutbox({
    userId: input.userId,
    dedupeKey: `auth-email:verification-code:${input.userId}:${input.issuanceId}`,
    payload: {
      template: "verify_email",
      to: input.email,
      subject: AUTH_EMAIL_SUBJECTS.verification_code[input.locale](await authEmailAppName()),
      variables: { code: input.otp, locale: input.locale },
    },
  });
  return true;
}

export async function issueEmailVerificationCode(email: string, remoteIp?: string | null): Promise<boolean> {
  const { assertEmailVerificationSendAllowed, EmailVerificationRateLimitError } = await import("./email-verification-policy");
  await assertAuthDatabaseRoles();
  const normalizedEmail = email.trim().toLowerCase();
  // Serialize generation and delivery across processes, including slow requests
  // that outlive the Redis cooldown. Bind the OTP adapter to this transaction
  // so concurrent issuances cannot exhaust the pool waiting for a second slot.
  return await getAuthDatabase().db.transaction(async (tx) => {
    const lock = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`email-verification:${normalizedEmail}`}, 0)) as acquired`);
    if (!lock.rows[0]?.acquired) throw new EmailVerificationRateLimitError();
    await assertEmailVerificationSendAllowed({ email: normalizedEmail, ...(remoteIp ? { remoteIp } : {}) });
    const user = (await tx.select({ id: users.id, emailVerified: users.emailVerified, preferredLocale: users.preferredLocale }).from(users).where(eq(users.email, normalizedEmail)).limit(1))[0];
    if (!user || user.emailVerified) return false;
    const issuanceId = randomUUID();
    const issuer = createAuth(tx);
    const { adapter } = await issuer.$context;
    // Signup runs inside Better Auth's adapter AsyncLocalStorage. A nested
    // instance alone does not replace that adapter for internal writes.
    const otp = await runWithAdapter(adapter, () => issuer.api.createVerificationOTP({ body: { email: normalizedEmail, type: "email-verification" } }));
    return await enqueueEmailVerificationCode({ userId: user.id, email: normalizedEmail, otp, issuanceId, locale: resolveLocale(user.preferredLocale) });
  });
}

async function rehashLegacyPassword(userId: string, password: string): Promise<void> {
  const database = getAuthDatabase();
  const account = (await database.db.select({ id: accounts.id, password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), isNotNull(accounts.password)))
    .limit(1))[0];
  const legacyHash = account?.password;
  if (!account || !legacyHash || !isLegacyScryptHash(legacyHash) || !(await verifyLegacyPassword(legacyHash, password))) {
    return;
  }

  const replacementHash = await hashReplacementPassword(password);
  await database.db.update(accounts)
    .set({ password: replacementHash, updatedAt: new Date() })
    .where(and(eq(accounts.id, account.id), eq(accounts.password, legacyHash)));
}

export function getAuth() {
  return instance ??= createAuth();
}

function createAuth(adapterDatabase?: Parameters<typeof drizzleAdapter>[0]) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Better Auth.");
  }
  if (process.env.NODE_ENV === "production" && !process.env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required in production.");
  }
  const secureCookies = process.env.BETTER_AUTH_USE_SECURE_COOKIES === undefined
    ? process.env.NODE_ENV === "production"
    : process.env.BETTER_AUTH_USE_SECURE_COOKIES === "true";
  const trustedIpHeader = trustedClientIpHeader();
  const database = getAuthDatabase();
  const secondaryStorage = getAuthSecondaryStorage();
  const trustedOrigins = configuredAppOrigins(process.env, [], true);
  return betterAuth({
    database: drizzleAdapter(adapterDatabase ?? database.db, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications, ...oauthProviderSchema },
    }),
    baseURL: process.env.APP_BASE_URL ?? "http://localhost:3000",
    trustedOrigins: trustedOrigins.length > 0 ? trustedOrigins : ["http://localhost:3000"],
    secret: process.env.BETTER_AUTH_SECRET ?? process.env.SESSION_ENCRYPTION_KEY ?? "development-only-change-me",
    ...(secondaryStorage ? { secondaryStorage } : {}),
    advanced: {
      useSecureCookies: secureCookies,
      database: { generateId: () => randomUUID() },
      // Only an explicitly configured, ingress-controlled single-value header
      // is trusted. Without the opt-in Better Auth keeps its default
      // `x-forwarded-for`, which rejects a multi-hop chain and fails closed to
      // the shared per-path bucket rather than trusting a spoofable value.
      ...(trustedIpHeader ? { ipAddress: { ipAddressHeaders: [trustedIpHeader] } } : {}),
    },
    plugins: [...mcpOAuthPlugins(), emailOTP({
      disableSignUp: true,
      storeOTP: "hashed",
      expiresIn: 600,
      allowedAttempts: 3,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "forget-password") throw new Error("Only password recovery codes use the public OTP sender.");
        const user = (await database.db.select({ id: users.id, preferredLocale: users.preferredLocale }).from(users).where(eq(users.email, email)).limit(1))[0];
        if (!user) return;
        const locale = resolveLocale(user.preferredLocale);
        await enqueueAuthEmailOutbox({
          userId: user.id,
          dedupeKey: `auth-reset-code:${user.id}:${randomUUID()}`,
          payload: { template: "password_reset", to: email, subject: AUTH_EMAIL_SUBJECTS.password_reset[locale](await authEmailAppName()), variables: { code: otp, locale } },
        });
      },
    })],
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
      onExistingUserSignUp: async ({ user }, request) => {
        const { assertEmailVerificationSendAllowed, EmailVerificationRateLimitError } = await import("./email-verification-policy");
        try {
          const remoteIp = request ? trustedClientIp(request) : undefined;
          if (!user.emailVerified) {
            await issueEmailVerificationCode(user.email, remoteIp);
            return;
          }
          await assertEmailVerificationSendAllowed({ email: user.email, ...(remoteIp ? { remoteIp } : {}) });
          const stored = (await database.db.select({ preferredLocale: users.preferredLocale }).from(users).where(eq(users.id, user.id)).limit(1))[0];
          const locale = resolveLocale(stored?.preferredLocale);
          const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
          await enqueueAuthEmailOutbox({
            userId: user.id,
            dedupeKey: `auth-existing-account:${user.id}:${randomUUID()}`,
            payload: { template: "existing_account", to: user.email,
              subject: EXISTING_ACCOUNT_SUBJECTS[locale](await authEmailAppName()),
              variables: { locale, signInUrl: new URL(`/${locale}/login`, base).href, resetUrl: new URL(`/${locale}/forgot-password`, base).href } },
          });
        } catch (error) {
          if (!(error instanceof EmailVerificationRateLimitError)) throw error;
        }
      },
      password: {
        hash: hashReplacementPassword,
        verify: async ({ hash, password }: { hash: string; password: string }) => await verifyLegacyPassword(hash, password),
      },
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      afterEmailVerification: async (user: { id: string; email: string }) => {
        await database.db.update(users).set({ normalizedEmail: user.email.trim().toLowerCase(), updatedAt: new Date() }).where(eq(users.id, user.id));
      },
      sendVerificationEmail: async ({ user, url }: { user: { id: string; email: string }; url: string }, request?: Request) => {
        const storedUser = (await database.db.select({ email: users.email, preferredLocale: users.preferredLocale }).from(users).where(eq(users.id, user.id)).limit(1))[0];
        if (!storedUser) return;
        if (storedUser.email === user.email) {
          try {
            await issueEmailVerificationCode(user.email, request ? trustedClientIp(request) : undefined);
          } catch (error) {
            const { EmailVerificationRateLimitError } = await import("./email-verification-policy");
            // Sign-up/sign-in keep their normal response when a prior issuance
            // already covers this recipient. Other failures remain fail-closed.
            if (!(error instanceof EmailVerificationRateLimitError)) throw error;
          }
          return;
        }
        // Keep the link callback for the existing two-address email-change flow.
        const verificationUrl = new URL(url);
        const recipientLocale = resolveLocale(storedUser.preferredLocale);
        const confirmationUrl = new URL(`/${recipientLocale}/confirm-email-change`, process.env.APP_BASE_URL ?? "http://localhost:3000");
        confirmationUrl.searchParams.set("token", verificationUrl.searchParams.get("token") ?? "");
        confirmationUrl.searchParams.set("email", user.email);
        await enqueueAuthEmail({ purpose: "verification", userId: user.id, email: user.email, url: confirmationUrl.toString(), locale: recipientLocale });
      },
    },
    user: {
      additionalFields: {
        // The database trigger replaces this placeholder with lower(email) on
        // insert and update. Declaring it keeps Better Auth's schema validator
        // aware that every user insert satisfies the required column.
        normalizedEmail: { type: "string", required: false, defaultValue: "", input: false, returned: false },
        preferredLocale: { type: "string", required: false, defaultValue: "en", input: true, validator: { input: z.enum(SUPPORTED_LOCALES) } },
      },
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }: { user: { id: string; email: string }; newEmail: string; url: string }) => {
          await enqueueAuthEmail({ purpose: "email_change", userId: user.id, email: user.email, url, newEmail, locale: await accountLocale(user.id) });
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      storeSessionInDatabase: true,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      storage: secondaryStorage ? "secondary-storage" : "memory",
      // Explicit per-path rules for the account-recovery endpoints, matching
      // the email-OTP plugin's own window/max so the plugin semantics are
      // preserved. Better Auth keys each path separately, so a recovery attempt
      // never consumes the verification recipient cooldown (or vice versa) and
      // one purpose cannot lock out another.
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
        "/email-otp/request-password-reset": { window: 60, max: 3 },
        "/email-otp/reset-password": { window: 60, max: 3 },
        "/email-otp/verify-email": { window: 60, max: 3 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        await assertAuthDatabaseRoles();
        // Enable verification and recovery only; the OTP plugin must not
        // introduce passwordless sign-in or email-change endpoints.
        // Server-only plugin methods, including createVerificationOTP, do not
        // have a route path. They remain callable from trusted application
        // code while every unapproved public OTP route is rejected.
        if (isDisabledAuthEmailEndpoint(ctx.path) || isDisabledOAuthEndpoint(ctx.path)) {
          throw new APIError("NOT_FOUND", { message: "Endpoint not enabled." });
        }
        if (needsMcpResource(ctx.path)) await ensureMcpResource(database.db, getEmailDatabase().db);
        const registration = registrationWithApplicationType(ctx.path, ctx.body);
        if (registration) return { context: { body: registration } };
        const resetRequestPaths = ["/email-otp/request-password-reset"];
        const recoveryPaths = [...resetRequestPaths, "/email-otp/reset-password"];
        if (recoveryPaths.includes(ctx.path) && !z.email().safeParse(ctx.body?.email).success) {
          throw new APIError("BAD_REQUEST", { message: "Invalid email address." });
        }
        if (resetRequestPaths.includes(ctx.path)) {
          // Better Auth limits only per IP; each new code also resets the guess
          // budget, so cap sends per recipient as well.
          const { assertEmailVerificationSendAllowed, EmailVerificationRateLimitError } = await import("./email-verification-policy");
          const remoteIp = ctx.headers ? trustedClientIpFromHeaders(ctx.headers) : undefined;
          try {
            await assertEmailVerificationSendAllowed({ email: ctx.body.email, scope: "password-reset", ...(remoteIp ? { remoteIp } : {}) });
          } catch (error) {
            if (!(error instanceof EmailVerificationRateLimitError)) throw error;
            // Answer as if sent, matching the endpoint's own success body.
            return ctx.json({ success: true });
          }
        }
        if (["/sign-up/email", "/email-otp/reset-password", "/change-password"].includes(ctx.path)) {
          const password = ctx.body?.newPassword ?? ctx.body?.password;
          if (typeof password !== "string" || !meetsPasswordRequirements(password)) {
            throw new APIError("BAD_REQUEST", { code: "INVALID_PASSWORD", message: "Invalid password" });
          }
        }
        if (ctx.path !== "/sign-up/email") {
          return;
        }
        const token = typeof ctx.body?.turnstileToken === "string"
          ? ctx.body.turnstileToken
          : ctx.body?.["cf-turnstile-response"];
        const remoteIp = ctx.headers ? trustedClientIpFromHeaders(ctx.headers) : undefined;
        try {
          await verifyTurnstile({
            token,
            ...(remoteIp ? { remoteIp } : {}),
          });
        } catch (error) {
          throw new APIError("BAD_REQUEST", { message: error instanceof Error ? error.message : "Turnstile verification failed." });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") {
          return;
        }
        const userId = ctx.context.newSession?.user.id;
        const password = typeof ctx.body?.password === "string" ? ctx.body.password : undefined;
        if (!userId || !password) {
          return;
        }
        try {
          await rehashLegacyPassword(userId, password);
        } catch {
          // A failed upgrade must not turn a successful login into an outage.
        }
      }),
    },
  });
}

export type Session = { user: { id: string; name?: string | null; email?: string | null; emailVerified?: boolean }; session: { id: string; userId: string; expiresAt: Date } } | null;

export async function getSession(headers: Headers): Promise<Session> {
  return (await getAuth().api.getSession({ headers })) as Session;
}
