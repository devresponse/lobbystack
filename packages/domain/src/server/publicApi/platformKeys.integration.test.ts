import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiKeys, auditLogs, businessMemberships, businesses, contacts, createDatabaseClient, idempotencyKeys, outboxMessages, platformPartnerBusinesses, users } from "@lobbystack/db";

import { generateApiKey, resolveApiKey } from "./apiKeys";
import { PublicApiError } from "./errors";
import { runIdempotent } from "./idempotency";
import { createContactForApi, createKnowledgeEntryForApi, getPlatformMeForApi, resolveActingUserId, type ApiKeyCaller, type PlatformKeyCaller } from "./operations";
import { generatePlatformKey, linkPlatformPartnerBusiness, requirePlatformBusinessAccess, resolvePlatformKey, resolvePlatformKeyOwner } from "./platformKeys";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Platform key integration tests require a dedicated local test database.");
  }
}

// The admin serves /api/v1 with the lobbystack_worker role; run the same role here.
function roleUrl(role: string): string {
  const url = new URL(testUrl!);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

const admin = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
const worker = testUrl ? createDatabaseClient("lobbystack_worker", { DATABASE_URL: roleUrl("lobbystack_worker") }) : undefined;
const app = testUrl ? createDatabaseClient("lobbystack_app", { DATABASE_URL: roleUrl("lobbystack_app") }) : undefined;

const businessA = randomUUID();
const businessB = randomUUID();
const ownerId = randomUUID();
const ownerEmail = `platform-owner-${ownerId}@example.invalid`;
const unverifiedId = randomUUID();
const unverifiedEmail = `platform-unverified-${unverifiedId}@example.invalid`;
const memberId = randomUUID();

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (value: unknown) => value);
  expect(error).toBeInstanceOf(PublicApiError);
  expect(error).toMatchObject({ status, code });
}

describe.skipIf(!testUrl)("platform keys against PostgreSQL with RLS", () => {
  beforeAll(async () => {
    await admin!.db.insert(businesses).values([
      { id: businessA, slug: `platform-a-${businessA}`, name: "Partner Business", timezone: "UTC", businessType: "test" },
      { id: businessB, slug: `platform-b-${businessB}`, name: "Someone Else", timezone: "UTC", businessType: "test" },
    ]);
    await admin!.db.insert(users).values([
      { id: ownerId, email: ownerEmail, normalizedEmail: ownerEmail, emailVerified: true },
      { id: unverifiedId, email: unverifiedEmail, normalizedEmail: unverifiedEmail },
      { id: memberId, email: `${memberId}@example.invalid`, normalizedEmail: `${memberId}@example.invalid` },
    ]);
    await admin!.db.insert(businessMemberships).values({ businessId: businessA, userId: memberId, role: "business_owner" });
  });

  afterAll(async () => {
    const ids = [businessA, businessB];
    await admin?.db.delete(idempotencyKeys).where(inArray(idempotencyKeys.businessId, ids));
    await admin?.db.delete(contacts).where(inArray(contacts.businessId, ids));
    await admin?.db.delete(outboxMessages).where(inArray(outboxMessages.businessId, ids));
    await admin?.db.delete(businesses).where(inArray(businesses.id, ids));
    await admin?.db.delete(users).where(inArray(users.id, [ownerId, unverifiedId, memberId]));
    await Promise.all([admin?.pool.end(), worker?.pool.end(), app?.pool.end()]);
  });

  it("maps a key's owner_email to its account, ignoring case and spaces", async () => {
    const context = { db: worker!.db };
    expect(await resolvePlatformKeyOwner(context, ownerEmail)).toBe(ownerId);
    expect(await resolvePlatformKeyOwner(context, `  ${ownerEmail.toUpperCase()} `)).toBe(ownerId);
    expect(await resolvePlatformKeyOwner(context, "nobody@example.invalid")).toBeNull();
    // Someone who signs up with an owner_email but never verifies it is not the owner.
    expect(await resolvePlatformKeyOwner(context, unverifiedEmail)).toBeNull();
  });

  it("lets only the worker role look owners up", async () => {
    const error = await app!.db.execute(sql`select app.resolve_platform_key_owner(${ownerEmail})`).then(() => null, (value: unknown) => value);
    expect(String((error as { cause?: unknown } | null)?.cause ?? error)).toMatch(/permission denied/);
  });

  it("lets a partner key reach only the businesses linked to its partner", async () => {
    const context = { db: worker!.db };
    await expectApiError(requirePlatformBusinessAccess(context, { businessId: businessA, partnerId: "acme", access: "partner" }), 404, "not_found");
    await linkPlatformPartnerBusiness(context, { businessId: businessA, partnerId: "acme", platformKeyId: randomUUID() });
    // Linking again is a no-op.
    await linkPlatformPartnerBusiness(context, { businessId: businessA, partnerId: "acme", platformKeyId: randomUUID() });
    await requirePlatformBusinessAccess(context, { businessId: businessA, partnerId: "acme", access: "partner" });
    await expectApiError(requirePlatformBusinessAccess(context, { businessId: businessB, partnerId: "acme", access: "partner" }), 404, "not_found");
    await expectApiError(requirePlatformBusinessAccess(context, { businessId: businessA, partnerId: "other", access: "partner" }), 404, "not_found");
    await expectApiError(requirePlatformBusinessAccess(context, { businessId: randomUUID(), partnerId: "acme", access: "all" }), 404, "not_found");
  });

  it("lets a key with access all reach any active business", async () => {
    const context = { db: worker!.db };
    await requirePlatformBusinessAccess(context, { businessId: businessB, partnerId: "lobbystack", access: "all" });
    await admin!.db.update(businesses).set({ status: "suspended" }).where(eq(businesses.id, businessB));
    await expectApiError(requirePlatformBusinessAccess(context, { businessId: businessB, partnerId: "lobbystack", access: "all" }), 404, "not_found");
    await admin!.db.update(businesses).set({ status: "active" }).where(eq(businesses.id, businessB));
  });

  it("shows members which partner manages their business and lets only the worker link one", async () => {
    const visible = await app!.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.business_id', ${businessA}, true), set_config('app.user_id', ${memberId}, true), set_config('app.actor_type', 'operator', true)`);
      return await tx.select({ partnerId: platformPartnerBusinesses.partnerId }).from(platformPartnerBusinesses).where(eq(platformPartnerBusinesses.businessId, businessA));
    });
    expect(visible).toEqual([{ partnerId: "acme" }]);
    const insert = await app!.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.business_id', ${businessA}, true), set_config('app.user_id', ${memberId}, true), set_config('app.actor_type', 'operator', true)`);
      await tx.insert(platformPartnerBusinesses).values({ businessId: businessA, partnerId: "sneaky" });
    }).then(() => null, (value: unknown) => value);
    expect(String((insert as { cause?: unknown } | null)?.cause ?? insert)).toMatch(/permission denied/);
    // A worker scoped to business B cannot link business A.
    const crossTenant = await worker!.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.business_id', ${businessB}, true), set_config('app.actor_type', 'worker', true)`);
      await tx.insert(platformPartnerBusinesses).values({ businessId: businessA, partnerId: "sneaky" });
    }).then(() => null, (value: unknown) => value);
    expect(String((crossTenant as { cause?: unknown } | null)?.cause ?? crossTenant)).toMatch(/row-level security/);
  });

  it("reports the platform key, its partner and the header's business on GET /me", async () => {
    const { key, entry } = generatePlatformKey({ name: "Acme onboarding", partner: "acme", ownerEmail });
    const resolved = resolvePlatformKey(key, { PLATFORM_API_KEYS: JSON.stringify([entry]) })!;
    const caller: PlatformKeyCaller = { businessId: businessA, platformKeyId: resolved.platformKeyId, partnerId: "acme", actingUserId: ownerId, actor: "platform_key" };
    const context = { db: worker!.db };
    expect(await getPlatformMeForApi(context, resolved, caller)).toEqual({
      api_key: { id: entry.id, name: "Acme onboarding", prefix: entry.prefix, scopes: resolved.scopes, created_at: entry.created_at },
      business: { id: businessA, name: "Partner Business" },
      platform: { partner: "acme", access: "partner" },
    });
    expect((await getPlatformMeForApi(context, resolved, null)).business).toBeNull();
  });

  it("audits a platform key's change with the key, its partner and its owner", async () => {
    const platformKeyId = randomUUID();
    const caller: PlatformKeyCaller = { businessId: businessA, platformKeyId, partnerId: "acme", actingUserId: ownerId, actor: "platform_key" };
    const entry = await createKnowledgeEntryForApi({ db: worker!.db }, caller, { type: "faq", question: "Do you park?", answer: "Yes, behind the building." });
    const [row] = await admin!.db.select({ actorUserId: auditLogs.actorUserId, payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, businessA), eq(auditLogs.entityId, entry.id)));
    expect(row).toEqual({ actorUserId: null, payload: { actor: "platform_key", platformKeyId, partnerId: "acme", actingUserId: ownerId, type: "faq" } });
  });

  it("keeps a platform key's Idempotency-Keys apart per business", async () => {
    const context = { db: worker!.db };
    const principal = `platform:${randomUUID()}`;
    const run = (businessId: string, phone: string) => async (transactional: typeof context) => ({ status: 201, body: JSON.stringify({ data: await createContactForApi(transactional, { businessId, apiKeyId: randomUUID() }, { phone }) }) });
    // The request pipeline adds the business to a platform key's scope.
    expect((await runIdempotent(context, { businessId: businessA, apiKeyId: `${principal}:${businessA}`, operation: "createContact", key: "same" }, "hash-a", run(businessA, "+14165557001"))).replayed).toBe(false);
    expect((await runIdempotent(context, { businessId: businessB, apiKeyId: `${principal}:${businessB}`, operation: "createContact", key: "same" }, "hash-b", run(businessB, "+14165557002"))).replayed).toBe(false);
    // Without it, the second business would be stuck behind the first one's record.
    await expectApiError(runIdempotent(context, { businessId: businessB, apiKeyId: `${principal}:${businessA}`, operation: "createContact", key: "same" }, "hash-b", run(businessB, "+14165557003")), 409, "idempotency_request_in_progress");
  });

  it("never lets a per-business key act with a platform-only scope", async () => {
    const generated = generateApiKey();
    await admin!.db.insert(apiKeys).values({ businessId: businessA, name: "Seeded with every scope", prefix: generated.prefix, keyHash: generated.keyHash, scopes: ["business:read", "businesses:create", "users:create"] });
    expect((await resolveApiKey({ db: worker!.db }, generated.key))?.scopes).toEqual(["business:read"]);
  });

  it("acts as a per-business key's creator only while they own or run the business", async () => {
    const generated = generateApiKey();
    const [key] = await admin!.db.insert(apiKeys).values({ businessId: businessA, name: "Zapier", prefix: generated.prefix, keyHash: generated.keyHash, scopes: ["business:read"], createdByUserId: memberId }).returning({ id: apiKeys.id });
    const caller: ApiKeyCaller = { businessId: businessA, apiKeyId: key!.id };
    const context = { db: worker!.db };
    expect(await resolveActingUserId(context, caller)).toBe(memberId);
    await admin!.db.update(businessMemberships).set({ role: "viewer" }).where(and(eq(businessMemberships.businessId, businessA), eq(businessMemberships.userId, memberId)));
    await expectApiError(resolveActingUserId(context, caller), 403, "key_owner_inactive");
    await admin!.db.update(businessMemberships).set({ role: "business_owner" }).where(and(eq(businessMemberships.businessId, businessA), eq(businessMemberships.userId, memberId)));
    await admin!.db.update(apiKeys).set({ createdByUserId: null }).where(eq(apiKeys.id, key!.id));
    await expectApiError(resolveActingUserId(context, caller), 403, "key_owner_inactive");
    // A platform key acts as its resolved owner without another lookup.
    expect(await resolveActingUserId(context, { businessId: businessA, platformKeyId: randomUUID(), partnerId: "acme", actingUserId: ownerId, actor: "platform_key" })).toBe(ownerId);
  });
});
