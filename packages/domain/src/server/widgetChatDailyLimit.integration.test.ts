import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingAccounts, billingPackPlans, billingPacks, billingUsageEvents, businesses, createDatabaseClient, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { reserveWidgetChatUsageInTransaction, widgetChatDailyLimit } from "./billing";
import { loadBusinessPlanLimits } from "./usage";

// AUDIT-004: the receptionist starts at most a share of a business's website
// chats in one UTC day, so a script that gets past the other limits can't
// spend the month's chats in an afternoon.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Website chat limit integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const DAY = 86_400_000;

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

/** Runs one step in the business's own transaction as the worker, as the chat route does. */
async function inBusiness<T>(tx: DatabaseTransaction, businessId: string, run: (scoped: DatabaseTransaction) => Promise<T>): Promise<T> {
  await tx.execute(sql`set local role lobbystack_worker`);
  const result = await withBusinessTransaction(tx as unknown as Database, { businessId, actorType: "worker" }, run);
  await tx.execute(sql`reset role`);
  return result;
}

async function business(tx: DatabaseTransaction, plan: "starter" | "free_cloud" | "self_host") {
  const businessId = randomUUID();
  // A self-hosted business is on its deployment's plan, which has no chat allowance.
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Website chat limit test", timezone: "UTC", businessType: "test", telemetryEnabled: false, ...(plan === "self_host" ? { deploymentMode: "self_hosted_standard" as const } : {}) });
  const subscribed = plan === "starter";
  await tx.insert(billingAccounts).values({ businessId, billingKey: `test:${businessId}`, plan, subscriptionState: subscribed ? "active" : null, billingInterval: subscribed ? "month" : null, subscriptionId: subscribed ? `sub_${businessId}` : null });
  return businessId;
}

function chat(tx: DatabaseTransaction, businessId: string, conversationId: string, dailyPercent: number | null = 25) {
  return inBusiness(tx, businessId, (scoped) => reserveWidgetChatUsageInTransaction(scoped, { businessId, conversationId, dailyPercent }));
}

async function startChats(tx: DatabaseTransaction, businessId: string, count: number): Promise<string[]> {
  const started: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const conversationId = randomUUID();
    expect((await chat(tx, businessId, conversationId)).allowed).toBe(true);
    started.push(conversationId);
  }
  return started;
}

describe.skipIf(!testUrl)("the website chat's daily limit against PostgreSQL", () => {
  it("starts the day's share of a plan's chats, then refuses new ones while chats already started go on", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, "starter");
      const { limits } = await inBusiness(tx, businessId, (scoped) => loadBusinessPlanLimits(scoped, businessId));
      const limit = widgetChatDailyLimit(limits.chatAiTokensIncluded, 25)!;
      expect(limit).toBeLessThan(limits.chatAiTokensIncluded!);
      const started = await startChats(tx, businessId, limit);

      expect(await chat(tx, businessId, randomUUID())).toEqual({ allowed: false, errorCode: "chat_daily_limit_reached", plan: "starter", dailyLimit: limit });
      // A chat that started today keeps its receptionist.
      expect(await chat(tx, businessId, started[0]!)).toEqual({ allowed: true, errorCode: null, plan: "starter" });
      // The refusal reserved nothing.
      const reserved = await tx.select({ id: billingUsageEvents.id }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.usageKind, "chat_ai_tokens")));
      expect(reserved).toHaveLength(limit);
      // A deployment that turned the limit off leaves the month's allowance to decide.
      expect((await chat(tx, businessId, randomUUID(), null)).allowed).toBe(true);
    });
  });

  it("counts only the chats started since midnight UTC", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, "starter");
      const { limits } = await inBusiness(tx, businessId, (scoped) => loadBusinessPlanLimits(scoped, businessId));
      const limit = widgetChatDailyLimit(limits.chatAiTokensIncluded, 25)!;
      await startChats(tx, businessId, limit);
      expect((await chat(tx, businessId, randomUUID())).allowed).toBe(false);
      // Yesterday's chats: the day starts again.
      await tx.update(billingUsageEvents).set({ createdAt: new Date(Date.now() - DAY) }).where(eq(billingUsageEvents.businessId, businessId));
      expect((await chat(tx, businessId, randomUUID())).allowed).toBe(true);
    });
  });

  it("takes a pack's share of its chats", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, "free_cloud");
      await tx.insert(billingPackPlans).values({ code: "pack_chat_limit_test", status: "active", names: { en: "Test pack", fr: "Test pack", es: "Test pack", sr: "Test pack" }, voiceSec: 15_000, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 48, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, termsHash: "0".repeat(64) }).onConflictDoNothing();
      const paidAt = new Date(Date.now() - DAY);
      await tx.insert(billingPacks).values({ businessId, pack: "pack_chat_limit_test", days: 90, provider: "stripe", providerRef: `pi_${randomUUID()}`, amountCents: 10_000, currency: "cad", secondsTotal: 3_000, smsSeg: 50, callsOut: 20, chatUnits: 48, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, paidAt, endsAt: new Date(paidAt.getTime() + 90 * DAY) });
      // 25% of the pack's 48 chats.
      await startChats(tx, businessId, 12);
      expect(await chat(tx, businessId, randomUUID())).toMatchObject({ allowed: false, errorCode: "chat_daily_limit_reached", plan: "prepaid", dailyLimit: 12 });
    });
  });

  it("leaves a plan without a chat allowance unlimited", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, "self_host");
      for (let index = 0; index < 12; index += 1) expect(await chat(tx, businessId, randomUUID())).toEqual({ allowed: true, errorCode: null, plan: "self_host" });
    });
  });

  it("never starts more than the day's limit when chats start at once", async () => {
    // Separate transactions, as separate visitors' chats are: the lock makes them count one after the other.
    const businessId = randomUUID();
    await client!.db.insert(businesses).values({ id: businessId, slug: businessId, name: "Website chat limit race", timezone: "UTC", businessType: "test", telemetryEnabled: false });
    try {
      await client!.db.insert(billingAccounts).values({ businessId, billingKey: `test:${businessId}`, plan: "starter", subscriptionState: "active", billingInterval: "month", subscriptionId: `sub_${businessId}` });
      const percent = 1;
      const limit = widgetChatDailyLimit(50, percent)!;
      const results = await Promise.all(Array.from({ length: limit + 5 }, () => client!.db.transaction(async (tx) => {
        await tx.execute(sql`set local role lobbystack_worker`);
        return await withBusinessTransaction(tx as unknown as Database, { businessId, actorType: "worker" }, (scoped) => reserveWidgetChatUsageInTransaction(scoped, { businessId, conversationId: randomUUID(), dailyPercent: percent }));
      })));
      expect(results.filter((result) => result.allowed)).toHaveLength(limit);
      expect(results.filter((result) => result.errorCode === "chat_daily_limit_reached")).toHaveLength(5);
    } finally {
      await client!.db.delete(businesses).where(eq(businesses.id, businessId));
    }
  });
});
