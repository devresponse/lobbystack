import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { billingAccounts, businesses, businessMemberships, createDatabaseClient, users, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { advanceOnboardingStage, getActiveOnboardingState, saveOnboardingWebsite, type OnboardingStage } from "./onboarding";
import { NumberSelectionError, searchBusinessNumberInventory, skipOnboardingNumber } from "./phoneNumbers";
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
afterEach(() => { vi.unstubAllEnvs(); });

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      // The plan in force is read from the catalog, which the catalog tests rewrite: wait for them, as they wait for this.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('lobbystack.billing_catalog'))`);
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

/**
 * Whether the deployment takes payments, which gives its onboarding a plan
 * step: its billing provider's settings are all there, or none is.
 */
function deployment(takesPayments: boolean) {
  vi.stubEnv("DEPLOYMENT_MODE", "cloud");
  vi.stubEnv("BILLING_PROVIDER", "");
  vi.stubEnv("POLAR_ACCESS_TOKEN", takesPayments ? "token" : "");
  vi.stubEnv("POLAR_ORGANIZATION_ID", takesPayments ? "organization" : "");
}

const context = (tx: DatabaseTransaction) => ({ db: tx as unknown as Database });

// Runs as the dashboard's database role, so row security and grants apply.
async function asApp<T>(tx: DatabaseTransaction, run: () => Promise<T>): Promise<T> {
  await tx.execute(sql`set local role lobbystack_app`);
  try {
    return await run();
  } finally {
    await tx.execute(sql`reset role`);
  }
}

async function newOwner(tx: DatabaseTransaction) {
  const userId = randomUUID();
  const email = `${userId}@example.invalid`;
  await tx.insert(users).values({ id: userId, email, normalizedEmail: email, name: "Sam Owner" });
  return userId;
}

/** A business as the name step creates it, with what the name step was told comes next. */
async function newBusiness(tx: DatabaseTransaction) {
  const userId = await newOwner(tx);
  const created = await asApp(tx, () => createBusiness(context(tx), { userId, name: `Acme ${randomUUID()}`, timezone: "UTC", businessType: "test" }));
  return { userId, businessId: created.businessId, next: created.onboardingStage };
}

const store = async (tx: DatabaseTransaction, businessId: string, stage: string) => { await tx.update(businesses).set({ onboardingStage: stage }).where(eq(businesses.id, businessId)); };
const stored = async (tx: DatabaseTransaction, businessId: string) => (await tx.select({ stage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, businessId)))[0]?.stage;
const subscribe = async (tx: DatabaseTransaction, businessId: string, plan: "starter" | "pro" | "enterprise") => {
  await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan, subscriptionState: "active", billingInterval: "monthly", ...(plan === "enterprise" ? { source: "managed" } : {}) });
};
/** Asks for a step as the dashboard does, and answers with the step the server says to open. */
const ask = (tx: DatabaseTransaction, input: { userId: string; businessId: string }, to: OnboardingStage) => asApp(tx, () => advanceOnboardingStage(context(tx), { ...input, to }));
const shown = (tx: DatabaseTransaction, userId: string) => asApp(tx, async () => (await getActiveOnboardingState(tx as unknown as Database, userId)).stage);

describe.skipIf(!testUrl)("the plan step right after the name, on a deployment that takes payments", () => {
  it("starts a new business on the plan step and tells the name step so", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      const { userId, businessId, next } = await newBusiness(tx);
      expect(next).toBe("plan");
      expect(await stored(tx, businessId)).toBe("plan");
      expect(await shown(tx, userId)).toBe("plan");
    });
  });

  it("moves a business that starts on the name step, as a claimed demo does, to the plan step, whichever step is asked for", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      for (const to of ["plan", "website"] as const) {
        const owner = await newBusiness(tx);
        await store(tx, owner.businessId, "create_business");
        expect(await ask(tx, owner, to)).toBe("plan");
        expect(await stored(tx, owner.businessId)).toBe("plan");
      }
    });
  });

  it("moves on from the plan step to the website step only", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      const owner = await newBusiness(tx);
      for (const to of ["knowledge", "greeting", "attribution"] as const) {
        await expect(ask(tx, owner, to)).rejects.toThrow(`Invalid onboarding transition from plan to ${to}.`);
      }
      // The number step is no way past the steps in between either: Free is answered with the last step, which the plan step can't reach.
      await expect(ask(tx, owner, "phone_number")).rejects.toThrow("Invalid onboarding transition from plan to attribution.");
      expect(await stored(tx, owner.businessId)).toBe("plan");
      expect(await ask(tx, owner, "website")).toBe("website");
      expect(await stored(tx, owner.businessId)).toBe("website");
      expect(await ask(tx, owner, "knowledge")).toBe("knowledge");
      expect(await ask(tx, owner, "greeting")).toBe("greeting");
      expect(await stored(tx, owner.businessId)).toBe("greeting");
    });
  });

  it("opens the plan step again from a later step and moves nothing", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      const owner = await newBusiness(tx);
      for (const stage of ["website", "knowledge", "greeting", "phone_number", "attribution", "complete"] as const) {
        await store(tx, owner.businessId, stage);
        // The name step asks for the plan step, and the plan step for the website step.
        expect(await ask(tx, owner, "plan")).toBe("plan");
        expect(await ask(tx, owner, "website")).toBe("website");
        expect(await stored(tx, owner.businessId)).toBe(stage);
      }
    });
  });

  it("goes from the greeting to the number step on a paid plan, and past it on Free", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      const free = await newBusiness(tx);
      await store(tx, free.businessId, "greeting");
      expect(await ask(tx, free, "phone_number")).toBe("attribution");
      expect(await stored(tx, free.businessId)).toBe("attribution");

      for (const plan of ["starter", "pro", "enterprise"] as const) {
        const paid = await newBusiness(tx);
        await subscribe(tx, paid.businessId, plan);
        await store(tx, paid.businessId, "greeting");
        expect(await ask(tx, paid, "phone_number")).toBe("phone_number");
        expect(await stored(tx, paid.businessId)).toBe("phone_number");
        expect(await shown(tx, paid.userId)).toBe("phone_number");
      }

      // A plan that ended is Free again.
      const ended = await newBusiness(tx);
      await subscribe(tx, ended.businessId, "starter");
      await tx.update(billingAccounts).set({ subscriptionState: "canceled" }).where(eq(billingAccounts.businessId, ended.businessId));
      await store(tx, ended.businessId, "greeting");
      expect(await ask(tx, ended, "phone_number")).toBe("attribution");
    });
  });

  it("sends a business on the number step without a number to pick back to its plan, and on from there by the plan it has then", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      const owner = await newBusiness(tx);
      await store(tx, owner.businessId, "phone_number");
      expect(await shown(tx, owner.userId)).toBe("plan");
      // Free on the plan step asks for the last step.
      expect(await ask(tx, owner, "attribution")).toBe("attribution");
      expect(await stored(tx, owner.businessId)).toBe("attribution");

      // A paid plan bought there asks for the number step, and stays on it.
      const paid = await newBusiness(tx);
      await store(tx, paid.businessId, "phone_number");
      expect(await shown(tx, paid.userId)).toBe("plan");
      await subscribe(tx, paid.businessId, "pro");
      expect(await ask(tx, paid, "phone_number")).toBe("phone_number");
      expect(await stored(tx, paid.businessId)).toBe("phone_number");
      expect(await shown(tx, paid.userId)).toBe("phone_number");
    });
  });

  it("refuses a number search and a skip from the plan step, which comes before the number step", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      const owner = await newBusiness(tx);
      await subscribe(tx, owner.businessId, "pro");
      const inventory = { listAvailablePhoneNumbers: async () => [{ phoneE164: "+14165550123", countryCode: "CA", capabilities: { sms: true, voice: true } }] };
      const search = () => asApp(tx, () => searchBusinessNumberInventory(context(tx), { ...owner, claimTokenSecret: "number-claim-test-secret" }, inventory));
      for (const stage of ["plan", "website", "greeting"] as const) {
        await store(tx, owner.businessId, stage);
        const refusal = await search().then(() => null, (error: unknown) => error);
        expect(refusal).toBeInstanceOf(NumberSelectionError);
        expect((refusal as NumberSelectionError).reason).toBe("stage");
        await expect(asApp(tx, () => skipOnboardingNumber(context(tx), owner))).rejects.toThrow();
        expect(await stored(tx, owner.businessId)).toBe(stage);
      }
      await store(tx, owner.businessId, "phone_number");
      expect((await search()).numbers.map((number) => number.phoneE164)).toEqual(["+14165550123"]);
      await asApp(tx, () => skipOnboardingNumber(context(tx), owner));
      expect(await stored(tx, owner.businessId)).toBe("attribution");
    });
  });

  it("only changes the address for a business that hasn't reached the website step", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      const owner = await newBusiness(tx);
      const saved = await asApp(tx, () => saveOnboardingWebsite(context(tx), { ...owner, websiteUrl: "example.com" }));
      expect(saved).toEqual({ websiteUrl: "https://example.com/", stage: "plan" });
      expect(await stored(tx, owner.businessId)).toBe("plan");
    });
  });

  it("lets only an admin of the business move it", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      const owner = await newBusiness(tx);
      const viewerId = await newOwner(tx);
      await tx.insert(businessMemberships).values({ businessId: owner.businessId, userId: viewerId, role: "viewer", status: "active" });
      await expect(ask(tx, { userId: viewerId, businessId: owner.businessId }, "website")).rejects.toMatchObject({ status: 403 });
      expect(await stored(tx, owner.businessId)).toBe("plan");
    });
  });
});

describe.skipIf(!testUrl)("no plan step, on a deployment that takes no payments", () => {
  it("starts a new business on the website step and tells the name step so", async () => {
    await rollbackTest(async (tx) => {
      deployment(false);
      const { userId, businessId, next } = await newBusiness(tx);
      expect(next).toBe("website");
      expect(await stored(tx, businessId)).toBe("website");
      expect(await shown(tx, userId)).toBe("website");
    });
  });

  it("starts a self-hosted server's business on the website step though its billing settings are there", async () => {
    await rollbackTest(async (tx) => {
      deployment(true);
      vi.stubEnv("DEPLOYMENT_MODE", "self_hosted_standard");
      const { userId, businessId, next } = await newBusiness(tx);
      expect(next).toBe("website");
      expect(await stored(tx, businessId)).toBe("website");
      // Its unlimited plan is no paid one, so the greeting is followed by the last step, and the number is added in Settings.
      await store(tx, businessId, "greeting");
      expect(await ask(tx, { userId, businessId }, "phone_number")).toBe("attribution");
    });
  });

  it("moves a business that starts on the name step to the website step, whichever step is asked for", async () => {
    await rollbackTest(async (tx) => {
      deployment(false);
      for (const to of ["plan", "website"] as const) {
        const owner = await newBusiness(tx);
        await store(tx, owner.businessId, "create_business");
        expect(await ask(tx, owner, to)).toBe("website");
        expect(await stored(tx, owner.businessId)).toBe("website");
      }
    });
  });

  it("reads a business stored on the plan step as on the website step, and stores it there when it moves", async () => {
    await rollbackTest(async (tx) => {
      deployment(false);
      const owner = await newBusiness(tx);
      await store(tx, owner.businessId, "plan");
      expect(await shown(tx, owner.userId)).toBe("website");
      // Asking for the plan step again opens the website step, and stores the business there.
      expect(await ask(tx, owner, "plan")).toBe("website");
      expect(await stored(tx, owner.businessId)).toBe("website");
      // And from the plan step straight on to the documents, as the website step's Skip asks.
      await store(tx, owner.businessId, "plan");
      expect(await ask(tx, owner, "knowledge")).toBe("knowledge");
      expect(await stored(tx, owner.businessId)).toBe("knowledge");
    });
  });

  it("saves the website of a business stored on the plan step and moves it to the documents", async () => {
    await rollbackTest(async (tx) => {
      deployment(false);
      const owner = await newBusiness(tx);
      await store(tx, owner.businessId, "plan");
      const saved = await asApp(tx, () => saveOnboardingWebsite(context(tx), { ...owner, websiteUrl: "example.com" }));
      expect(saved).toEqual({ websiteUrl: "https://example.com/", stage: "knowledge" });
      expect(await stored(tx, owner.businessId)).toBe("knowledge");
    });
  });

  it("goes from the greeting to the number step on a plan the operator manages, and past it on Free", async () => {
    await rollbackTest(async (tx) => {
      deployment(false);
      const free = await newBusiness(tx);
      await store(tx, free.businessId, "greeting");
      expect(await ask(tx, free, "phone_number")).toBe("attribution");
      expect(await stored(tx, free.businessId)).toBe("attribution");

      const managed = await newBusiness(tx);
      await subscribe(tx, managed.businessId, "enterprise");
      await store(tx, managed.businessId, "greeting");
      expect(await ask(tx, managed, "phone_number")).toBe("phone_number");
      expect(await stored(tx, managed.businessId)).toBe("phone_number");
    });
  });

  it("leaves a business on the number step without a number to pick there, where it can skip", async () => {
    await rollbackTest(async (tx) => {
      deployment(false);
      const owner = await newBusiness(tx);
      await store(tx, owner.businessId, "phone_number");
      expect(await shown(tx, owner.userId)).toBe("phone_number");
      await asApp(tx, () => skipOnboardingNumber(context(tx), owner));
      expect(await stored(tx, owner.businessId)).toBe("attribution");
    });
  });
});
