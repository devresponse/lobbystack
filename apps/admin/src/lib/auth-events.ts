import { isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";

import { users } from "@lobbystack/db";
import { errorText, logEvent, type LogLevel } from "@lobbystack/telemetry/node";

import { getDatabase } from "./databases";
import { reportServerError } from "./error-reporting";
import { trustedClientIp, trustedClientIpFromHeaders } from "./trusted-client-ip";

// Sign-in and account lines (docs/features/observability.md). Each names the
// account by userId, never by email address, and carries the caller's ip only
// when TRUSTED_CLIENT_IP_HEADER is set. Passwords, codes and tokens never appear.

type AuthHookContext = {
  path?: string | undefined;
  body?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
  headers?: Headers | undefined;
  context: {
    returned?: unknown;
    newSession?: { session: { id: string }; user: { id: string } } | null | undefined;
    session?: { user: { id: string } } | null | undefined;
  };
};

/** The line each auth route writes when it succeeds and when it fails. */
const ROUTE_EVENTS: Record<string, { succeeded?: string; failed: string; method?: "link" | "code" }> = {
  "/sign-in/email": { succeeded: "auth.signed_in", failed: "auth.sign_in_failed" },
  // A repeated sign-up answers like a new one, so the user-create hook logs auth.signed_up.
  "/sign-up/email": { failed: "auth.sign_up_failed" },
  "/request-password-reset": { succeeded: "auth.password_reset_requested", failed: "auth.password_reset_request_failed", method: "link" },
  "/email-otp/request-password-reset": { succeeded: "auth.password_reset_requested", failed: "auth.password_reset_request_failed", method: "code" },
  // onPasswordReset logs auth.password_reset, since only it knows the account.
  "/reset-password": { failed: "auth.password_reset_failed", method: "link" },
  "/email-otp/reset-password": { failed: "auth.password_reset_failed", method: "code" },
  "/change-password": { succeeded: "auth.password_changed", failed: "auth.password_change_failed" },
  "/change-email": { succeeded: "auth.email_change_requested", failed: "auth.email_change_failed" },
  "/verify-email": { succeeded: "auth.email_verified", failed: "auth.email_verification_failed", method: "link" },
  "/email-otp/verify-email": { succeeded: "auth.email_verified", failed: "auth.email_verification_failed", method: "code" },
};

/** A Better Auth path, such as /sign-in/email, from a request's /api/auth/sign-in/email. */
export function authPath(pathname: string): string {
  return pathname.startsWith("/api/auth/") ? pathname.slice("/api/auth".length) : pathname;
}

/** The route's path and, for resets and verification, whether it took an emailed link or a code. */
export function routeFields(path: string | undefined): { path?: string; method?: "link" | "code" } {
  if (!path) return {};
  const method = ROUTE_EVENTS[path]?.method;
  return { path, ...(method ? { method } : {}) };
}

function clientIp(headers: Headers | null | undefined): { ip?: string } {
  const ip = headers ? trustedClientIpFromHeaders(headers) : undefined;
  return ip ? { ip } : {};
}

/** One sign-in or account line, with the caller's address when it can be trusted. */
export function logAuthEvent(level: LogLevel, event: string, fields: Record<string, unknown>, headers?: Headers | null): void {
  logEvent(level, event, { ...fields, ...clientIp(headers) });
}

const rateLimitsLogged = new Map<string, number>();

/** auth.rate_limited, at most once a minute for each route, limit and address, so a flood of requests can't flood the logs. */
export function logRateLimited(fields: { path?: string; limit: "route" | "recipient"; ip?: string; retryAfter?: number }): void {
  const key = `${fields.path ?? ""} ${fields.limit} ${fields.ip ?? ""}`;
  const now = Date.now();
  const last = rateLimitsLogged.get(key);
  if (last !== undefined && now - last < 60_000) return;
  if (rateLimitsLogged.size >= 1_000) rateLimitsLogged.clear();
  rateLimitsLogged.set(key, now);
  logEvent("warn", "auth.rate_limited", fields);
}

/** Logs Better Auth's own rate limit, which answers 429 with X-Retry-After before any hook runs. */
export function logAuthRateLimit(request: Request, response: Response): void {
  if (response.status !== 429 || !response.headers.has("x-retry-after")) return;
  const ip = trustedClientIp(request);
  const retryAfter = Number(response.headers.get("x-retry-after"));
  logRateLimited({ path: authPath(new URL(request.url).pathname), limit: "route", ...(ip ? { ip } : {}), ...(Number.isFinite(retryAfter) ? { retryAfter } : {}) });
}

function failureFields(error: { statusCode: number; status: unknown; body?: { code?: unknown; message?: unknown } | undefined }): { status: number; code: string; detail?: string } {
  const code = typeof error.body?.code === "string" ? error.body.code : String(error.status);
  // A refusal without a code, such as our failed challenge or Better Auth's
  // "Email is the same", gives its message instead.
  const detail = typeof error.body?.code !== "string" && typeof error.body?.message === "string" ? errorText(error.body.message) : undefined;
  return { status: error.statusCode, code, ...(detail ? { detail } : {}) };
}

/** The status and Better Auth error code of a failed request, or nothing when it succeeded. */
function failureOf(returned: unknown): { status: number; code: string; detail?: string } | undefined {
  if (!isAPIError(returned)) return undefined;
  if (returned.statusCode >= 400) return failureFields(returned);
  // verify-email with a callbackURL redirects even when it fails, with the code in the address.
  try {
    const location = new Headers(returned.headers).get("location");
    const code = location ? new URL(location, "http://localhost").searchParams.get("error") : null;
    return code ? { status: returned.statusCode, code } : undefined;
  } catch {
    return undefined;
  }
}

/** The email and email-change step an emailed verification link carries. The token is never logged. */
function linkClaims(token: unknown): { email?: unknown; updateTo?: unknown; requestType?: unknown } {
  if (typeof token !== "string") return {};
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : {};
  } catch {
    return {};
  }
}

async function accountIdFor(email: unknown): Promise<string | undefined> {
  if (typeof email !== "string" || !email.trim()) return undefined;
  const [account] = await getDatabase("lobbystack_auth").db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  return account?.id;
}

/**
 * Logs how an auth request ended, from Better Auth's after hook. The account
 * comes from the session, else from the email address the request named
 * (accountFound false on auth.sign_in_failed means no account has it), else
 * from the address an emailed link carries. Never throws.
 */
export async function logAuthOutcome(ctx: AuthHookContext): Promise<void> {
  const route = ctx.path ? ROUTE_EVENTS[ctx.path] : undefined;
  if (!route) return;
  try {
    const failure = failureOf(ctx.context.returned);
    const claims = ctx.path === "/verify-email" ? linkClaims(ctx.query?.token) : {};
    const emailChange = typeof claims.updateTo === "string";
    const confirmation = claims.requestType === "change-email-confirmation";
    const succeeded = !emailChange ? route.succeeded : confirmation ? "auth.email_change_confirmed" : "auth.email_changed";
    const event = failure ? route.failed : succeeded;
    if (!event) return;
    let userId = ctx.context.newSession?.user.id ?? ctx.context.session?.user.id;
    let accountFound: boolean | undefined;
    const email = ctx.body?.email;
    if (!userId && typeof email === "string") {
      try {
        userId = await accountIdFor(email);
        accountFound = userId !== undefined;
      } catch {
        // Logged without the account.
      }
    } else if (!userId) {
      // A finished change has moved the account to its new address.
      userId = await accountIdFor(emailChange && !failure && !confirmation ? claims.updateTo : claims.email).catch(() => undefined);
    }
    logAuthEvent(failure ? "warn" : "info", event, {
      ...routeFields(ctx.path),
      userId,
      ...(accountFound === undefined ? {} : { accountFound }),
      ...(emailChange ? { emailChange } : {}),
      ...failure,
      ...(!failure && ctx.path === "/sign-in/email" ? { authSessionId: ctx.context.newSession?.session.id } : {}),
      ...(!failure && ctx.path === "/change-password" ? { revokedOtherSessions: ctx.body?.revokeOtherSessions === true } : {}),
    }, ctx.headers);
  } catch {
    // A log line must never turn a sign-in into an outage.
  }
}

/** Runs Better Auth's before hook, logging the requests it refuses, such as a weak password or a failed challenge, as failures. */
export async function logRefusals<R>(ctx: AuthHookContext, check: () => Promise<R>): Promise<R> {
  try {
    return await check();
  } catch (error) {
    const route = ctx.path ? ROUTE_EVENTS[ctx.path] : undefined;
    if (route && isAPIError(error)) logAuthEvent("warn", route.failed, { ...routeFields(ctx.path), ...failureFields(error) }, ctx.headers);
    throw error;
  }
}

/** Better Auth's warnings that repeat a line above, left out so a wrong password writes one line, not two. */
const REPEATED_WARNINGS = new Set(["User not found", "Invalid password", "Reset Password: User not found", "Password is too short", "Password is too long", "Email is the same"]);

/**
 * Better Auth's own log as ours. An error with an exception, such as a
 * database failure behind a sign-in, reaches error tracking. Its other errors,
 * mostly refused requests such as one from an untrusted origin, and its
 * warnings print as auth.better_auth_error and auth.better_auth_warning lines,
 * without their arguments, which can hold an email address.
 */
export const betterAuthLogger = {
  log(level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]): void {
    const exception = level === "error" ? args.find((arg) => arg instanceof Error) : undefined;
    if (exception) void reportServerError(exception, { operation: "auth.better_auth", detail: errorText(message) });
    else if (level === "error") logEvent("error", "auth.better_auth_error", { error: message });
    else if (level === "warn" && !REPEATED_WARNINGS.has(message)) logEvent("warn", "auth.better_auth_warning", { error: message });
  },
};
