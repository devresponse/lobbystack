import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getCurrentAdapter, runWithAdapter } from "@better-auth/core/context";
import { APIError } from "better-auth/api";

const mocks = vi.hoisted(() => ({
  config: undefined as any,
  createOtp: vi.fn(), enqueue: vi.fn(), allowed: vi.fn(), role: vi.fn(), challenge: vi.fn(),
  select: vi.fn(), acquired: true, lockHeld: false, adapter: vi.fn(), emailOtp: undefined as any,
  log: vi.fn(), report: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@lobbystack/telemetry/node", async importOriginal => ({ ...await importOriginal<typeof import("@lobbystack/telemetry/node")>(), logEvent: mocks.log }));
vi.mock("./error-reporting", () => ({ reportServerError: mocks.report }));
vi.mock("better-auth", () => ({ betterAuth: (config: unknown) => {
  mocks.config = config;
  return { $context: Promise.resolve({ adapter: (config as any).database }), api: { createVerificationOTP: mocks.createOtp } };
} }));
vi.mock("better-auth/api", async importOriginal => ({ ...await importOriginal<typeof import("better-auth/api")>(), createAuthMiddleware: (handler: unknown) => handler }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: mocks.adapter }));
vi.mock("better-auth/plugins/email-otp", () => ({ emailOTP: (options: unknown) => { mocks.emailOtp = options; return { id: "email-otp" }; } }));
vi.mock("./turnstile", () => ({ verifyTurnstile: mocks.challenge }));
vi.mock("./email-verification-policy", async importOriginal => ({ ...await importOriginal<typeof import("./email-verification-policy")>(), assertEmailVerificationSendAllowed: mocks.allowed }));
vi.mock("./databases", () => {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.select }) }) }),
    transaction: async (callback: (tx: unknown) => unknown) => {
      let owned = false;
      const tx = { ...db, execute: async () => {
        owned = mocks.acquired && !mocks.lockHeld;
        if (owned) mocks.lockHeld = true;
        return { rows: [{ acquired: owned }] };
      } };
      try { return await callback(tx); }
      finally { if (owned) mocks.lockHeld = false; }
    },
  };
  return { getDatabase: (role: string) => ({ db, role }) };
});
vi.mock("@lobbystack/db", async importOriginal => ({
  ...await importOriginal<typeof import("@lobbystack/db")>(),
  assertDatabaseRole: mocks.role,
  enqueueOutbox: mocks.enqueue,
  withBusinessTransaction: async (_db: unknown, _scope: unknown, callback: (tx: unknown) => unknown) => callback({}),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "");
  vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
  mocks.acquired = true;
  mocks.lockHeld = false;
  mocks.adapter.mockReturnValue({});
  mocks.role.mockResolvedValue(undefined);
  mocks.allowed.mockResolvedValue(undefined);
  mocks.challenge.mockResolvedValue(undefined);
  mocks.createOtp.mockResolvedValue("123456");
  mocks.select.mockResolvedValue([{ id: "user-1", email: "owner@example.invalid", emailVerified: false }]);
});
afterEach(() => vi.unstubAllEnvs());

it("passes wildcard trusted origins through to Better Auth next to APP_BASE_URL", async () => {
  vi.stubEnv("APP_BASE_URL", "https://app.example.test/");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", " *.example.test , https://app.example.test, myapp://callback,not a url");
  const { getAuth } = await import("./auth"); getAuth();
  expect(mocks.config.trustedOrigins).toEqual(["https://app.example.test", "*.example.test", "myapp://callback", "not a url"]);
});

it("sends a localized sign-in reminder for a verified duplicate signup", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  mocks.select.mockResolvedValue([{ preferredLocale: "fr" }]);
  await mocks.config.emailAndPassword.onExistingUserSignUp({ user: { id: "user-1", email: "owner@example.invalid", emailVerified: true } });
  expect(mocks.createOtp).not.toHaveBeenCalled();
  expect(mocks.allowed).toHaveBeenCalledOnce();
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ payload: expect.objectContaining({ template: "existing_account", variables: expect.objectContaining({ locale: "fr", signInUrl: expect.stringContaining("/fr/login") }) }) }));
});

it("sends a verification code for an unverified duplicate signup", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  await mocks.config.emailAndPassword.onExistingUserSignUp({ user: { id: "user-1", email: "owner@example.invalid", emailVerified: false } });
  expect(mocks.createOtp).toHaveBeenCalledOnce();
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ payload: expect.objectContaining({ template: "verify_email" }) }));
});

it("deduplicates by issuance identity rather than repeated OTP digits", async () => {
  const { issueEmailVerificationCode } = await import("./auth");
  await issueEmailVerificationCode("Owner@example.invalid");
  await issueEmailVerificationCode("owner@example.invalid");
  const deliveries = mocks.enqueue.mock.calls.map(call => call[1]);
  expect(deliveries).toHaveLength(2);
  expect(deliveries[0].payload.variables.code).toBe("123456");
  expect(deliveries[1].payload.variables.code).toBe("123456");
  expect(deliveries[0].dedupeKey).not.toBe(deliveries[1].dedupeKey);
  expect(deliveries[0].dedupeKey).not.toContain("123456");
  expect(mocks.allowed).toHaveBeenCalledTimes(2);
  expect(mocks.role.mock.calls.map(call => call[0].role)).toEqual(["lobbystack_auth", "lobbystack_app"]);
});

it("uses the shared issuance policy in signup/signin callbacks and forwards request IP", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  expect(mocks.config.emailVerification.sendOnSignUp).toBe(true);
  expect(mocks.config.emailVerification.sendOnSignIn).toBe(true);
  await mocks.config.emailVerification.sendVerificationEmail(
    { user: { id: "user-1", email: "owner@example.invalid" }, url: "https://app.example.test/verify" },
    new Request("https://app.example.test", { headers: { "x-real-ip": "203.0.113.10", "cf-connecting-ip": "198.51.100.20" } }),
  );
  expect(mocks.allowed).toHaveBeenCalledExactlyOnceWith({ email: "owner@example.invalid", remoteIp: "203.0.113.10" });
  expect(mocks.createOtp).toHaveBeenCalledTimes(1);
});

it("rejects overlapping requests while an earlier OTP generation is still running", async () => {
  const { issueEmailVerificationCode } = await import("./auth");
  let release!: (otp: string) => void;
  mocks.createOtp.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  const first = issueEmailVerificationCode("owner@example.invalid");
  await vi.waitFor(() => expect(mocks.createOtp).toHaveBeenCalledTimes(1));
  await expect(issueEmailVerificationCode("owner@example.invalid")).rejects.toThrow("Please wait");
  release("123456");
  await expect(first).resolves.toBe(true);
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  expect(mocks.allowed).toHaveBeenCalledTimes(1);
  expect(mocks.adapter.mock.calls[0]![0]).toHaveProperty("execute");
});

it("overrides an enclosing signup adapter while generating the OTP", async () => {
  const { issueEmailVerificationCode } = await import("./auth");
  const outerAdapter = { id: "signup" } as any;
  const issuanceAdapter = { id: "issuance" } as any;
  mocks.adapter.mockReturnValue(issuanceAdapter);
  mocks.createOtp.mockImplementationOnce(async () => {
    expect(await getCurrentAdapter(outerAdapter)).toBe(issuanceAdapter);
    return "123456";
  });
  await runWithAdapter(outerAdapter, async () => {
    await expect(issueEmailVerificationCode("owner@example.invalid")).resolves.toBe(true);
    expect(await getCurrentAdapter(issuanceAdapter)).toBe(outerAdapter);
  });
});

it("suppresses callback cooldowns but propagates protection outages", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  const { EmailVerificationRateLimitError } = await import("./email-verification-policy");
  const callback = mocks.config.emailVerification.sendVerificationEmail;
  const input = { user: { id: "user-1", email: "owner@example.invalid" }, url: "https://app.example.test/verify" };
  mocks.allowed.mockRejectedValueOnce(new EmailVerificationRateLimitError());
  await expect(callback(input)).resolves.toBeUndefined();
  mocks.allowed.mockRejectedValueOnce(new Error("offline"));
  await expect(callback(input)).rejects.toThrow("offline");
  expect(mocks.createOtp).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("blocks concurrent issuance and policy failures before generating or delivering", async () => {
  const { issueEmailVerificationCode } = await import("./auth");
  mocks.acquired = false;
  await expect(issueEmailVerificationCode("owner@example.invalid")).rejects.toThrow("Please wait");
  expect(mocks.allowed).not.toHaveBeenCalled();
  mocks.acquired = true;
  mocks.allowed.mockRejectedValueOnce(new Error("offline"));
  await expect(issueEmailVerificationCode("owner@example.invalid")).rejects.toThrow("offline");
  expect(mocks.createOtp).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("does not issue for missing or already verified users", async () => {
  const { issueEmailVerificationCode } = await import("./auth");
  mocks.select.mockResolvedValueOnce([]).mockResolvedValueOnce([{ emailVerified: true }]);
  expect(await issueEmailVerificationCode("missing@example.invalid")).toBe(false);
  expect(await issueEmailVerificationCode("verified@example.invalid")).toBe(false);
  expect(mocks.createOtp).not.toHaveBeenCalled();
});

it("fails closed on an effective database role mismatch before auth or issuance", async () => {
  mocks.role.mockRejectedValue(new Error("Database role assertion failed"));
  const { getAuth, issueEmailVerificationCode } = await import("./auth"); getAuth();
  await expect(mocks.config.hooks.before({ path: "/sign-in/email" })).rejects.toThrow("Database role assertion failed");
  await expect(issueEmailVerificationCode("owner@example.invalid")).rejects.toThrow("Database role assertion failed");
  expect(mocks.createOtp).not.toHaveBeenCalled();
});

it("runs signup challenge at the boundary with the trusted IP and blocks disabled endpoints", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  await mocks.config.hooks.before({ path: "/sign-up/email", body: { password: "StrongPassword123!", turnstileToken: "challenge" }, headers: new Headers({ "x-real-ip": "203.0.113.10", "cf-connecting-ip": "198.51.100.20" }) });
  expect(mocks.challenge).toHaveBeenCalledWith({ token: "challenge", remoteIp: "203.0.113.10" });
  await expect(mocks.config.hooks.before({ path: "/email-otp/send-verification-otp" })).rejects.toThrow("Endpoint not enabled");
  expect(mocks.allowed).not.toHaveBeenCalled();
});

it("shares one in-flight database role assertion across concurrent requests", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mocks.role.mockImplementation(() => gate);
  const first = mocks.config.hooks.before({ path: "/sign-in/email" });
  const second = mocks.config.hooks.before({ path: "/sign-in/email" });
  await vi.waitFor(() => expect(mocks.role).toHaveBeenCalledTimes(2));
  release();
  await Promise.all([first, second]);
  expect(mocks.role).toHaveBeenCalledTimes(2);
});

it("re-checks the database role assertion after a transient failure instead of caching it", async () => {
  const { issueEmailVerificationCode } = await import("./auth");
  mocks.role.mockRejectedValueOnce(new Error("Database role assertion failed"));
  await expect(issueEmailVerificationCode("owner@example.invalid")).rejects.toThrow("Database role assertion failed");
  await expect(issueEmailVerificationCode("owner@example.invalid")).resolves.toBe(true);
  expect(mocks.role).toHaveBeenCalledTimes(4);
  expect(mocks.createOtp).toHaveBeenCalledTimes(1);
});

it("declares explicit per-path recovery rules that preserve plugin semantics", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  expect(mocks.config.rateLimit.customRules).toMatchObject({
    "/email-otp/request-password-reset": { window: 60, max: 3 },
    "/email-otp/reset-password": { window: 60, max: 3 },
    "/email-otp/verify-email": { window: 60, max: 3 },
  });
  expect(Object.keys(mocks.config.rateLimit.customRules)).not.toContain("/email-otp/send-verification-otp");
  // Resets go by code only: Better Auth has no link reset to send or limit.
  expect(Object.keys(mocks.config.rateLimit.customRules)).not.toContain("/request-password-reset");
  expect(mocks.config.emailAndPassword.sendResetPassword).toBeUndefined();
});

it("caps reset sends per recipient and answers a capped request as if it were sent", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  const { EmailVerificationRateLimitError } = await import("./email-verification-policy");
  mocks.allowed.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    .mockRejectedValue(new EmailVerificationRateLimitError());
  const request = (path: string) => mocks.config.hooks.before({
    path, body: { email: "owner@example.invalid" }, headers: new Headers({ "x-real-ip": "203.0.113.10" }), json: (body: unknown) => body,
  });
  for (let n = 0; n < 3; n++) await expect(request("/email-otp/request-password-reset")).resolves.toBeUndefined();
  // A returned body short-circuits Better Auth, so the 4th request creates no code.
  await expect(request("/email-otp/request-password-reset")).resolves.toEqual({ success: true });
  await expect(request("/request-password-reset")).rejects.toThrow("Endpoint not enabled");
  expect(mocks.allowed).toHaveBeenCalledWith({ email: "owner@example.invalid", remoteIp: "203.0.113.10", scope: "password-reset" });
  mocks.allowed.mockRejectedValueOnce(new Error("offline"));
  await expect(request("/email-otp/request-password-reset")).rejects.toThrow("offline");
});

it("writes verification and reset codes in the account's language", async () => {
  const { getAuth, issueEmailVerificationCode } = await import("./auth"); getAuth();
  mocks.select.mockResolvedValue([{ id: "user-1", emailVerified: false, preferredLocale: "es" }]);
  await issueEmailVerificationCode("owner@example.invalid");
  expect(mocks.enqueue.mock.calls[0]![1].payload).toMatchObject({ template: "verify_email", subject: expect.stringContaining("Su código de verificación de "), variables: { code: "123456", locale: "es" } });
  mocks.select.mockResolvedValue([{ id: "user-1", preferredLocale: "fr" }]);
  await mocks.emailOtp.sendVerificationOTP({ email: "owner@example.invalid", otp: "654321", type: "forget-password" });
  expect(mocks.enqueue.mock.calls[1]![1].payload).toMatchObject({ template: "password_reset", subject: expect.stringContaining("Réinitialisez votre mot de passe "), variables: { code: "654321", locale: "fr" } });
});

it("names the new address in an email change and sends both emails in the account's language", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  mocks.select.mockResolvedValue([{ preferredLocale: "sr" }]);
  await mocks.config.user.changeEmail.sendChangeEmailConfirmation({ user: { id: "user-1", email: "owner@example.invalid" }, newEmail: "new@example.invalid", url: "https://app.example.test/api/auth/verify-email?token=t" });
  expect(mocks.enqueue.mock.calls[0]![1].payload).toMatchObject({ template: "verify_email", to: "owner@example.invalid", subject: expect.stringContaining("Potvrdite promenu imejl adrese"), variables: { purpose: "email_change", newEmail: "new@example.invalid", locale: "sr" } });
  // Once the current address approves, the new one gets its own link.
  mocks.select.mockResolvedValue([{ email: "owner@example.invalid", preferredLocale: "sr" }]);
  await mocks.config.emailVerification.sendVerificationEmail({ user: { id: "user-1", email: "new@example.invalid" }, url: "https://app.example.test/api/auth/verify-email?token=t2" });
  const second = mocks.enqueue.mock.calls[1]![1].payload;
  expect(second).toMatchObject({ template: "verify_email", to: "new@example.invalid", subject: expect.stringContaining("Potvrdite novu imejl adresu"), variables: { locale: "sr", url: expect.stringContaining("/sr/confirm-email-change?token=t2") } });
  expect(second.variables).not.toHaveProperty("purpose");
});

it("logs sign-ins and their failures from Better Auth's after hook", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  await mocks.config.hooks.after({
    path: "/sign-in/email", body: { email: "owner@example.invalid", password: "not-my-password" }, headers: new Headers({ "x-real-ip": "203.0.113.10" }),
    context: { returned: APIError.from("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }) },
  });
  await mocks.config.hooks.after({ path: "/sign-in/email", body: {}, context: { returned: {}, newSession: { session: { id: "session-1" }, user: { id: "user-1" } } } });
  expect(mocks.log.mock.calls).toEqual([
    ["warn", "auth.sign_in_failed", { path: "/sign-in/email", userId: "user-1", accountFound: true, status: 401, code: "INVALID_EMAIL_OR_PASSWORD", ip: "203.0.113.10" }],
    ["info", "auth.signed_in", { path: "/sign-in/email", userId: "user-1", authSessionId: "session-1" }],
  ]);
});

it("logs what the before hook refuses and the reset requests the recipient cooldown holds", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  const { EmailVerificationRateLimitError } = await import("./email-verification-policy");
  await expect(mocks.config.hooks.before({ path: "/sign-up/email", body: { password: "short" }, headers: new Headers() })).rejects.toThrow("Invalid password");
  mocks.allowed.mockRejectedValueOnce(new EmailVerificationRateLimitError());
  await mocks.config.hooks.before({ path: "/email-otp/request-password-reset", body: { email: "owner@example.invalid" }, headers: new Headers({ "x-real-ip": "203.0.113.10" }), json: (body: unknown) => body });
  expect(mocks.log.mock.calls).toEqual([
    ["warn", "auth.sign_up_failed", { path: "/sign-up/email", status: 400, code: "INVALID_PASSWORD" }],
    ["warn", "auth.rate_limited", { path: "/email-otp/request-password-reset", limit: "recipient", ip: "203.0.113.10" }],
  ]);
});

it("logs new and repeated sign-ups and finished resets from Better Auth's callbacks", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  mocks.select.mockResolvedValue([{ preferredLocale: "en" }]);
  await mocks.config.databaseHooks.user.create.after({ id: "user-2" }, { path: "/sign-up/email", headers: new Headers({ "x-real-ip": "203.0.113.10" }) });
  await mocks.config.emailAndPassword.onExistingUserSignUp({ user: { id: "user-1", email: "owner@example.invalid", emailVerified: true } });
  await mocks.config.emailAndPassword.onPasswordReset({ user: { id: "user-1" } }, new Request("https://app.example.test/api/auth/email-otp/reset-password", { method: "POST" }));
  expect(mocks.log.mock.calls).toEqual([
    ["info", "auth.signed_up", { userId: "user-2", path: "/sign-up/email", ip: "203.0.113.10" }],
    ["info", "auth.sign_up_existing_account", { userId: "user-1", verified: true }],
    ["info", "auth.password_reset", { userId: "user-1", path: "/email-otp/reset-password" }],
  ]);
});

it("logs each verification code it sends or skips", async () => {
  const { issueEmailVerificationCode } = await import("./auth");
  await issueEmailVerificationCode("owner@example.invalid", "203.0.113.10");
  mocks.select.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "user-1", emailVerified: true }]);
  await issueEmailVerificationCode("missing@example.invalid");
  await issueEmailVerificationCode("owner@example.invalid");
  expect(mocks.log.mock.calls).toEqual([
    ["info", "auth.verification_code_sent", { userId: "user-1", ip: "203.0.113.10" }],
    ["info", "auth.verification_code_skipped", { reason: "no_account" }],
    ["info", "auth.verification_code_skipped", { userId: "user-1", reason: "already_verified" }],
  ]);
});

it("sends Better Auth's own errors, such as a database outage behind a sign-in, to error tracking", async () => {
  const { getAuth } = await import("./auth"); getAuth();
  const failure = new Error("connect ECONNREFUSED");
  mocks.config.logger.log("error", "Error", failure);
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "auth.better_auth", detail: "Error" });
});
