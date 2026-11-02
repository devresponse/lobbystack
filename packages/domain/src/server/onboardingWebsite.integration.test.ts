import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businesses, businessMemberships, createDatabaseClient, knowledgeDocuments, outboxMessages, users, websiteIngestionJobs, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { createBusiness } from "./tenancy";
import { saveOnboardingWebsite } from "./onboarding";

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

async function newBusiness(tx: DatabaseTransaction) {
  const userId = randomUUID();
  const email = `${randomUUID()}@example.invalid`;
  await tx.insert(users).values({ id: userId, email, normalizedEmail: email, name: "Sam Owner" });
  await tx.execute(sql`set local role lobbystack_app`);
  const { businessId } = await createBusiness({ db: tx as unknown as Database }, { userId, name: `Acme ${randomUUID()}`, timezone: "UTC", businessType: "test" });
  await tx.execute(sql`reset role`);
  return { userId, businessId };
}

// Runs as the dashboard's database role, so row security and grants apply.
async function asApp<T>(tx: DatabaseTransaction, run: () => Promise<T>): Promise<T> {
  await tx.execute(sql`set local role lobbystack_app`);
  try {
    return await run();
  } finally {
    await tx.execute(sql`reset role`);
  }
}

async function readBusiness(tx: DatabaseTransaction, businessId: string) {
  return (await tx.select({ websiteUrl: businesses.websiteUrl, onboardingStage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, businessId)))[0];
}

// Everything a crawl leaves behind; the website step must leave none of it.
async function queuedReads(tx: DatabaseTransaction, businessId: string) {
  return {
    documents: (await tx.select({ id: knowledgeDocuments.id }).from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, businessId))).length,
    imports: (await tx.select({ id: websiteIngestionJobs.id }).from(websiteIngestionJobs).where(eq(websiteIngestionJobs.businessId, businessId))).length,
    outbox: (await tx.select({ topic: outboxMessages.topic }).from(outboxMessages).where(eq(outboxMessages.businessId, businessId))).map((message) => message.topic).filter((topic) => topic.startsWith("knowledge.")),
  };
}

describe.skipIf(!testUrl)("onboarding website step against dedicated PostgreSQL roles", () => {
  it("saves the website and moves to knowledge without queuing a crawl", async () => {
    await rollbackTest(async (tx) => {
      const { userId, businessId } = await newBusiness(tx);
      expect((await readBusiness(tx, businessId))?.onboardingStage).toBe("website");
      const saved = await asApp(tx, () => saveOnboardingWebsite({ db: tx as unknown as Database }, { userId, businessId, websiteUrl: " Example.com/ " }));
      expect(saved).toEqual({ websiteUrl: "https://example.com/", stage: "knowledge" });
      expect(await readBusiness(tx, businessId)).toEqual({ websiteUrl: "https://example.com/", onboardingStage: "knowledge" });
      expect(await queuedReads(tx, businessId)).toEqual({ documents: 0, imports: 0, outbox: [] });
    });
  });

  it("only changes the address when the owner comes back to the step later", async () => {
    await rollbackTest(async (tx) => {
      const { userId, businessId } = await newBusiness(tx);
      await tx.update(businesses).set({ onboardingStage: "plan" }).where(eq(businesses.id, businessId));
      const saved = await asApp(tx, () => saveOnboardingWebsite({ db: tx as unknown as Database }, { userId, businessId, websiteUrl: "https://www.example.org/menu/" }));
      expect(saved).toEqual({ websiteUrl: "https://www.example.org/menu", stage: "plan" });
      expect(await readBusiness(tx, businessId)).toEqual({ websiteUrl: "https://www.example.org/menu", onboardingStage: "plan" });
      expect(await queuedReads(tx, businessId)).toEqual({ documents: 0, imports: 0, outbox: [] });
    });
  });

  it("rejects an address it can't use and saves nothing", async () => {
    await rollbackTest(async (tx) => {
      const { userId, businessId } = await newBusiness(tx);
      await expect(asApp(tx, () => saveOnboardingWebsite({ db: tx as unknown as Database }, { userId, businessId, websiteUrl: "file:///etc/passwd" }))).rejects.toMatchObject({ status: 422, code: "website_url_invalid" });
      expect(await readBusiness(tx, businessId)).toEqual({ websiteUrl: null, onboardingStage: "website" });
    });
  });

  it("lets only an admin of the business save it", async () => {
    await rollbackTest(async (tx) => {
      const { businessId } = await newBusiness(tx);
      const viewerId = randomUUID();
      const email = `${randomUUID()}@example.invalid`;
      await tx.insert(users).values({ id: viewerId, email, normalizedEmail: email, name: "Vic Viewer" });
      await tx.insert(businessMemberships).values({ businessId, userId: viewerId, role: "viewer", status: "active" });
      await expect(asApp(tx, () => saveOnboardingWebsite({ db: tx as unknown as Database }, { userId: viewerId, businessId, websiteUrl: "example.com" }))).rejects.toMatchObject({ status: 403 });
      expect(await readBusiness(tx, businessId)).toEqual({ websiteUrl: null, onboardingStage: "website" });
    });
  });
});
