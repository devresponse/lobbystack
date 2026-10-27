import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabaseClient, outboxMessages, users } from "@lobbystack/db";
import { currentBrand } from "@lobbystack/shared";

import { PublicApiError } from "./errors";
import { generatePlatformKey, resolvePlatformKey } from "./platformKeys";
import { createUserForApi, enqueueAccountSetupEmail, platformUserId } from "./users";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("User integration tests require a dedicated local test database.");
  }
}

// The admin writes accounts with the lobbystack_auth role and queues email with lobbystack_app; run the same roles here.
function roleUrl(role: string): string {
  const url = new URL(testUrl!);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

const admin = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
const auth = testUrl ? createDatabaseClient("lobbystack_auth", { DATABASE_URL: roleUrl("lobbystack_auth") }) : undefined;
const app = testUrl ? createDatabaseClient("lobbystack_app", { DATABASE_URL: roleUrl("lobbystack_app") }) : undefined;
const made: string[] = [];

afterAll(async () => {
  if (admin && made.length) {
    await admin.db.delete(outboxMessages).where(inArray(outboxMessages.aggregateId, made));
    await admin.db.delete(users).where(inArray(users.id, made));
  }
  await Promise.all([admin?.pool.end(), auth?.pool.end(), app?.pool.end()]);
});

describe.skipIf(!testUrl)("POST /users", () => {
  const { key, entry } = generatePlatformKey({ name: "AlloPlace CLI", partner: "alloplace", ownerEmail: "ops@alloplace.example" });
  const resolved = () => resolvePlatformKey(key, { PLATFORM_API_KEYS: JSON.stringify([entry]) })!;

  it("makes an unverified account with no password, and returns it again for the same Idempotency-Key", async () => {
    const idempotencyKey = `owner-${randomUUID()}`;
    const email = `owner-${randomUUID()}@example.invalid`;
    const first = await createUserForApi(auth!.db, { key: resolved(), idempotencyKey, body: { email: ` ${email.toUpperCase()} `, name: "Ana Owner", locale: "fr" } });
    made.push(first.user.id);
    expect(first).toEqual({ replayed: false, user: { id: platformUserId(entry.id, idempotencyKey), email, name: "Ana Owner", locale: "fr", email_verified: false, created_at: expect.any(String) } });
    const [row] = await admin!.db.select({ normalizedEmail: users.normalizedEmail, passwordHash: users.passwordHash }).from(users).where(eq(users.id, first.user.id));
    expect(row).toEqual({ normalizedEmail: email, passwordHash: null });

    const again = await createUserForApi(auth!.db, { key: resolved(), idempotencyKey, body: { email } });
    expect(again).toEqual({ replayed: true, user: first.user });
    await expect(createUserForApi(auth!.db, { key: resolved(), idempotencyKey, body: { email: `other-${email}` } })).rejects.toMatchObject({ status: 422, code: "idempotency_key_reused" });
  });

  it("refuses an email that already has an account", async () => {
    const email = `taken-${randomUUID()}@example.invalid`;
    const first = await createUserForApi(auth!.db, { key: resolved(), idempotencyKey: `a-${randomUUID()}`, body: { email } });
    made.push(first.user.id);
    const error = await createUserForApi(auth!.db, { key: resolved(), idempotencyKey: `b-${randomUUID()}`, body: { email: email.toUpperCase() } }).then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(PublicApiError);
    expect(error).toMatchObject({ status: 409, code: "conflict" });
  });

  it("queues one setup email in the account's language, however often it's asked for", async () => {
    const created = await createUserForApi(auth!.db, { key: resolved(), idempotencyKey: `c-${randomUUID()}`, body: { email: `setup-${randomUUID()}@example.invalid`, locale: "es" } });
    made.push(created.user.id);
    await enqueueAccountSetupEmail(app!.db, { user: created.user, appBaseUrl: "https://app.example.com" });
    await enqueueAccountSetupEmail(app!.db, { user: created.user, appBaseUrl: "https://app.example.com" });
    const queued = await admin!.db.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.aggregateId, created.user.id), eq(outboxMessages.topic, "email.send")));
    expect(queued).toEqual([{ payload: { template: "account_setup", to: created.user.email, subject: `Configure su cuenta de ${currentBrand().appName}`, variables: { locale: "es", email: created.user.email, url: "https://app.example.com/es/forgot-password" } } }]);
  });
});
