import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseClient, DatabaseRole } from "@lobbystack/db";

const mocks = vi.hoisted(() => ({ getDatabase: vi.fn(), closeDatabases: vi.fn(async () => undefined) }));

vi.mock("@lobbystack/telemetry/node", async (importOriginal) => ({
  ...await importOriginal<typeof import("@lobbystack/telemetry/node")>(),
  initializeTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));
vi.mock("@/lib/databases", () => ({ getDatabase: mocks.getDatabase, closeDatabases: mocks.closeDatabases }));

import { register } from "../../instrumentation";

function runtimeClient(role: DatabaseRole, rows: Array<{ role: string; privileged: boolean }>) {
  return { role, pool: { query: vi.fn().mockResolvedValue({ rows }) } } as unknown as DatabaseClient;
}

function ownRole(role: DatabaseRole) {
  return runtimeClient(role, [{ role, privileged: false }]);
}

describe("production storage startup validation", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    for (const name of ["BETTER_AUTH_SECRET", "INTERNAL_SERVICE_SECRET", "INTERNAL_SERVICE_TOKEN", "WIDGET_SESSION_SECRET", "ENCRYPTION_KEY", "OTP_HASH_SECRET"]) {
      vi.stubEnv(name, "strong-production-fixture-secret-12345");
    }
    vi.stubEnv("LOCAL_STORAGE_SIGNING_SECRET", "");
    mocks.getDatabase.mockImplementation((role: DatabaseRole) => ownRole(role));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("starts an S3 deployment without an unused local-storage signing key", async () => {
    vi.stubEnv("STORAGE_PROVIDER", "s3");
    await expect(register()).resolves.toBeUndefined();
  });

  it("retains the required signing key for local storage", async () => {
    vi.stubEnv("STORAGE_PROVIDER", "local");
    await expect(register()).rejects.toThrow("LOCAL_STORAGE_SIGNING_SECRET is required in production");
    vi.stubEnv("LOCAL_STORAGE_SIGNING_SECRET", "strong-local-storage-signing-key-12345");
    await expect(register()).resolves.toBeUndefined();
  });
});

describe("production database role startup validation", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    for (const name of ["BETTER_AUTH_SECRET", "INTERNAL_SERVICE_SECRET", "INTERNAL_SERVICE_TOKEN", "WIDGET_SESSION_SECRET", "ENCRYPTION_KEY", "OTP_HASH_SECRET", "LOCAL_STORAGE_SIGNING_SECRET"]) {
      vi.stubEnv(name, "strong-production-fixture-secret-12345");
    }
    vi.stubEnv("STORAGE_PROVIDER", "local");
    mocks.getDatabase.mockImplementation((role: DatabaseRole) => ownRole(role));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("asserts every runtime role before startup completes", async () => {
    await expect(register()).resolves.toBeUndefined();
    expect(mocks.getDatabase).toHaveBeenCalledTimes(4);
    for (const role of ["lobbystack_app", "lobbystack_auth", "lobbystack_worker", "lobbystack_dispatcher"]) {
      expect(mocks.getDatabase).toHaveBeenCalledWith(role);
    }
  });

  it("closes the check's pools once the roles are asserted, since the routes never use them", async () => {
    await expect(register()).resolves.toBeUndefined();
    expect(mocks.closeDatabases).toHaveBeenCalledTimes(1);
    // After every role answered, not while one is still asked.
    expect(mocks.closeDatabases.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...mocks.getDatabase.mock.invocationCallOrder));
  });

  it("rejects startup when a runtime role resolves to the privileged base role", async () => {
    mocks.getDatabase.mockImplementation((role: DatabaseRole) => (
      role === "lobbystack_worker"
        ? runtimeClient(role, [{ role: "postgres", privileged: true }])
        : ownRole(role)
    ));
    await expect(register()).rejects.toThrow("Database role assertion failed");
  });

  it.each([
    ["development", { NODE_ENV: "development" }],
    ["a production build", { NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }],
    ["maintenance mode", { NODE_ENV: "production", LOBBYSTACK_MAINTENANCE_MODE: "true" }],
  ] as const)("does not open database clients during %s", async (_label, environment) => {
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    await expect(register()).resolves.toBeUndefined();
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("skips all startup work in the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(register()).resolves.toBeUndefined();
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });
});

describe("email verification startup warning", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    for (const name of ["BETTER_AUTH_SECRET", "INTERNAL_SERVICE_SECRET", "INTERNAL_SERVICE_TOKEN", "WIDGET_SESSION_SECRET", "ENCRYPTION_KEY", "OTP_HASH_SECRET", "LOCAL_STORAGE_SIGNING_SECRET"]) {
      vi.stubEnv(name, "strong-production-fixture-secret-12345");
    }
    vi.stubEnv("STORAGE_PROVIDER", "local");
    mocks.getDatabase.mockImplementation((role: DatabaseRole) => ownRole(role));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function verificationWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
    return warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("auth.email_verification_off"));
  }

  it("warns as a production server starts with the email code turned off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("REQUIRE_EMAIL_VERIFICATION", "false");
    await expect(register()).resolves.toBeUndefined();
    expect(verificationWarnings(warn)).toHaveLength(1);
    expect(JSON.parse(verificationWarnings(warn)[0]!)).toMatchObject({ level: "warn", message: "auth.email_verification_off" });
  });

  it.each([undefined, "true"])("stays quiet while the email code is required (%s)", async (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("REQUIRE_EMAIL_VERIFICATION", value);
    await expect(register()).resolves.toBeUndefined();
    expect(verificationWarnings(warn)).toHaveLength(0);
  });
});

describe("billing provider startup validation", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    for (const name of ["BETTER_AUTH_SECRET", "INTERNAL_SERVICE_SECRET", "INTERNAL_SERVICE_TOKEN", "WIDGET_SESSION_SECRET", "ENCRYPTION_KEY", "OTP_HASH_SECRET", "LOCAL_STORAGE_SIGNING_SECRET"]) {
      vi.stubEnv(name, "strong-production-fixture-secret-12345");
    }
    vi.stubEnv("STORAGE_PROVIDER", "local");
    mocks.getDatabase.mockImplementation((role: DatabaseRole) => ownRole(role));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("refuses a billing provider the worker would refuse, before opening database clients", async () => {
    vi.stubEnv("BILLING_PROVIDER", "strpe");
    await expect(register()).rejects.toThrow("BILLING_PROVIDER must be polar or stripe, not \"strpe\".");
    expect(mocks.getDatabase).not.toHaveBeenCalled();
    vi.stubEnv("BILLING_PROVIDER", "stripe");
    await expect(register()).resolves.toBeUndefined();
  });
});

// AUDIT-004: the website chat's limits per IP address always run on Railway, and its check's absence is said out loud.
describe("website chat startup checks", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    for (const name of ["BETTER_AUTH_SECRET", "INTERNAL_SERVICE_SECRET", "INTERNAL_SERVICE_TOKEN", "WIDGET_SESSION_SECRET", "ENCRYPTION_KEY", "OTP_HASH_SECRET", "LOCAL_STORAGE_SIGNING_SECRET"]) {
      vi.stubEnv(name, "strong-production-fixture-secret-12345");
    }
    vi.stubEnv("STORAGE_PROVIDER", "local");
    for (const name of ["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID", "TRUSTED_CLIENT_IP_HEADER", "NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "WIDGET_TURNSTILE"]) vi.stubEnv(name, undefined);
    mocks.getDatabase.mockImplementation((role: DatabaseRole) => ownRole(role));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function turnstileWarnings(warn: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
    return warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("widget.turnstile_off")).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("refuses to start on Railway without the trusted IP header, before opening database clients", async () => {
    vi.stubEnv("RAILWAY_SERVICE_ID", "service");
    await expect(register()).rejects.toThrow("TRUSTED_CLIENT_IP_HEADER is not set");
    expect(mocks.getDatabase).not.toHaveBeenCalled();
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
    await expect(register()).resolves.toBeUndefined();
  });

  it("builds on Railway without the header, since a build serves no one", async () => {
    vi.stubEnv("RAILWAY_SERVICE_ID", "service");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await expect(register()).resolves.toBeUndefined();
  });

  it("starts off Railway without the header, where it can't tell which proxy is in front", async () => {
    await expect(register()).resolves.toBeUndefined();
  });

  it("warns when a production server answers website chats without Turnstile's keys", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(register()).resolves.toBeUndefined();
    expect(turnstileWarnings(warn)).toEqual([expect.objectContaining({ level: "warn", message: "widget.turnstile_off", reason: "keys_missing" })]);
  });

  it("warns when the check is turned off on purpose", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    vi.stubEnv("WIDGET_TURNSTILE", "false");
    await expect(register()).resolves.toBeUndefined();
    expect(turnstileWarnings(warn)).toEqual([expect.objectContaining({ reason: "turned_off" })]);
  });

  it("stays quiet when the website chat has its check", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    await expect(register()).resolves.toBeUndefined();
    expect(turnstileWarnings(warn)).toEqual([]);
  });
});

// The access gate: PROTECTION_TOKEN closes a test deployment to strangers (docs/features/access-gate.md).
describe("access gate startup checks", () => {
  const token = "protection-token-fixture-0123456789-abcdef";

  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    for (const name of ["BETTER_AUTH_SECRET", "INTERNAL_SERVICE_SECRET", "INTERNAL_SERVICE_TOKEN", "WIDGET_SESSION_SECRET", "ENCRYPTION_KEY", "OTP_HASH_SECRET", "LOCAL_STORAGE_SIGNING_SECRET"]) {
      vi.stubEnv(name, "strong-production-fixture-secret-12345");
    }
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("PROTECTION_TOKEN", undefined);
    mocks.getDatabase.mockImplementation((role: DatabaseRole) => ownRole(role));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function gateOnLines(info: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
    return info.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("access_gate.on")).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("refuses to start with a token that can be guessed or breaks the access link, before opening database clients", async () => {
    vi.stubEnv("PROTECTION_TOKEN", "too-short");
    await expect(register()).rejects.toThrow("PROTECTION_TOKEN is 9 characters long and needs at least 32");
    vi.stubEnv("PROTECTION_TOKEN", `${token}+plus`);
    await expect(register()).rejects.toThrow("PROTECTION_TOKEN has a character an address can't carry as it is");
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it("says at every start that the gate is on, without the token", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("PROTECTION_TOKEN", token);
    await expect(register()).resolves.toBeUndefined();
    expect(gateOnLines(info)).toEqual([expect.objectContaining({ level: "info", message: "access_gate.on" })]);
    expect(info.mock.calls.flat().join("\n")).not.toContain(token);
  });

  it.each([undefined, "", "  "])("stays quiet while the deployment is open (%j)", async (value) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("PROTECTION_TOKEN", value);
    await expect(register()).resolves.toBeUndefined();
    expect(gateOnLines(info)).toEqual([]);
  });

  it("builds with any token and says nothing, since a build serves no one", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("PROTECTION_TOKEN", "too-short");
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("PROTECTION_TOKEN", token);
    await expect(register()).resolves.toBeUndefined();
    expect(gateOnLines(info)).toEqual([]);
  });
});
