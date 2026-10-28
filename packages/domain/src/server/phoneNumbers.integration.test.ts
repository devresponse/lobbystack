import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businesses, createDatabaseClient, onboardingNumberClaimEvents, phoneNumbers, users, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { completeNumberProvisioning, reserveOnboardingNumberClaim, searchBusinessNumberInventory } from "./phoneNumbers";
import { createBusiness } from "./tenancy";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Reliability integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const claimTokenSecret = "number-claim-test-secret";
const inventory = { listAvailablePhoneNumbers: async () => [{ phoneE164: "+14165550123", countryCode: "CA", capabilities: { sms: true, voice: true } }] };

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

/** A self-hosted workspace on the number step with one earlier claim left in provisioning. */
async function workspaceWithProvisioningClaim(tx: DatabaseTransaction, idleMinutes: number) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid`, name: "Sam" });
  await tx.execute(sql`set local role lobbystack_app`);
  const { businessId } = await createBusiness({ db: tx as unknown as Database }, { userId, name: "Claim workspace", timezone: "America/Toronto", businessType: "test" });
  await tx.execute(sql`reset role`);
  await tx.update(businesses).set({ onboardingStage: "phone_number", deploymentMode: "self_hosted_standard" }).where(eq(businesses.id, businessId));
  const updatedAt = new Date(Date.now() - idleMinutes * 60_000);
  const [stalled] = await tx.insert(onboardingNumberClaimEvents).values({ businessId, userId, requestedE164: "+14165550100", selectionContext: {}, claimTokenHash: "earlier", idempotencyKey: "earlier", status: "provisioning", reservedAt: updatedAt, updatedAt }).returning({ id: onboardingNumberClaimEvents.id });
  return { userId, businessId, stalledId: stalled!.id };
}

// The reservation function trusts only the app's login identity, so switch session_user rather than the current role.
async function reserveAsApp(tx: DatabaseTransaction, input: { userId: string; businessId: string }) {
  await tx.execute(sql`set local session authorization lobbystack_app`);
  try {
    const db = tx as unknown as Database;
    const { numbers } = await searchBusinessNumberInventory({ db }, { ...input, claimTokenSecret }, inventory);
    return await reserveOnboardingNumberClaim({ db }, { ...input, claimToken: numbers[0]!.claimToken, claimTokenSecret, idempotencyKey: randomUUID() });
  } finally {
    await tx.execute(sql`reset session authorization`);
  }
}

describe.skipIf(!testUrl)("onboarding number claims against dedicated PostgreSQL roles", () => {
  it("refuses a second claim while a worker still holds the first", async () => {
    await rollbackTest(async (tx) => {
      const { userId, businessId } = await workspaceWithProvisioningClaim(tx, 1);
      await expect(reserveAsApp(tx, { userId, businessId })).rejects.toMatchObject({ status: 409, code: "number_claim_in_progress", cause: { message: "number_claim_in_progress" } });
    });
  });

  it("answers the carrier refusing the filters as the person's to fix, and any other carrier failure as a server failure", async () => {
    await rollbackTest(async (tx) => {
      const { userId, businessId } = await workspaceWithProvisioningClaim(tx, 1);
      const carrier = (error: Error) => ({ listAvailablePhoneNumbers: async () => { throw error; } });
      await tx.execute(sql`set local session authorization lobbystack_app`);
      try {
        const db = tx as unknown as Database;
        await expect(searchBusinessNumberInventory({ db }, { userId, businessId, claimTokenSecret }, carrier(Object.assign(new Error("Invalid areaCode"), { status: 400, code: 21452 })))).rejects.toMatchObject({ status: 400, code: "number_search_invalid" });
        // The carrier's 401 is about our account, not the person's session.
        const unauthorized = Object.assign(new Error("Authenticate"), { status: 401, code: 20003 });
        const failure = await searchBusinessNumberInventory({ db }, { userId, businessId, claimTokenSecret }, carrier(unauthorized)).catch((error: unknown) => error);
        expect(failure).toMatchObject({ message: "The carrier's number search failed.", cause: unauthorized });
        expect(failure).not.toHaveProperty("status");
      } finally {
        await tx.execute(sql`reset session authorization`);
      }
    });
  });

  it("fails a claim no worker has touched for 30 minutes so the business can pick again", async () => {
    await rollbackTest(async (tx) => {
      const { userId, businessId, stalledId } = await workspaceWithProvisioningClaim(tx, 31);
      expect(await reserveAsApp(tx, { userId, businessId })).toMatch(/^[0-9a-f-]{36}$/);
      const [stalled] = await tx.select({ status: onboardingNumberClaimEvents.status }).from(onboardingNumberClaimEvents).where(eq(onboardingNumberClaimEvents.id, stalledId));
      expect(stalled?.status).toBe("failed");
    });
  });

  it("saves a number bought again after its release, and still refuses one a business holds", async () => {
    await rollbackTest(async (tx) => {
      // The claim in provisioning is for +14165550100, which an earlier business released.
      const { businessId, stalledId } = await workspaceWithProvisioningClaim(tx, 1);
      const [earlier] = await tx.insert(businesses).values({ slug: `released-${randomUUID()}`, name: "Earlier owner", timezone: "UTC", businessType: "test" }).returning({ id: businesses.id });
      await tx.insert(phoneNumbers).values({ businessId: earlier!.id, e164: "+14165550100", providerPhoneId: `PN-${randomUUID()}`, status: "reclaimed", voiceEnabled: false, smsEnabled: false });
      await tx.execute(sql`set local role lobbystack_worker`);
      const numberId = await completeNumberProvisioning({ db: tx as unknown as Database }, { businessId, claimId: stalledId, e164: "+14165550100", providerPhoneId: `PN-${randomUUID()}`, voiceUrl: "https://voice.test/twiml", smsUrl: "https://admin.test/api/webhooks/twilio/sms" });
      await tx.execute(sql`reset role`);
      const holders = await tx.select({ id: phoneNumbers.id, businessId: phoneNumbers.businessId, status: phoneNumbers.status }).from(phoneNumbers).where(eq(phoneNumbers.e164, "+14165550100"));
      expect(holders).toHaveLength(2);
      expect(holders).toContainEqual({ id: numberId, businessId, status: "active" });
      await expect(tx.transaction(async (savepoint) => {
        await savepoint.insert(phoneNumbers).values({ businessId: earlier!.id, e164: "+14165550100", providerPhoneId: `PN-${randomUUID()}` });
      })).rejects.toMatchObject({ cause: { code: "23505", constraint: "phone_numbers_e164_unreclaimed_unique" } });
    });
  });
});
