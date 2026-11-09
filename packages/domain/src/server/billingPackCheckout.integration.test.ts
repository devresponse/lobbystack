import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { apiKeys, auditLogs, billingAccounts, billingCheckoutRequests, billingPackCheckouts, billingPackPlans, billingPackPrices, billingPacks, businessMemberships, businesses, createDatabaseClient, outboxMessages, users, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { apiPackCheckoutSchema } from "@lobbystack/shared";

import { createBillingCheckoutRequestInTransaction, loadBillingCheckoutRequest, OPEN_PURCHASE_REFUSAL, setManagedPlanInTransaction } from "./billing";
import { claimPackCheckout, createPackCheckoutRequest, createPackCheckoutRequestInTransaction, loadPackCheckoutRequest, markPackCheckoutFailed, markPackCheckoutPaidInTransaction, markPackCheckoutReady, PACK_CHECKOUT_PAGE_MS, readPackCheckoutInTransaction, releasePackCheckout } from "./billingPackCheckout";
import { createBillingSubscriptionRequestInTransaction } from "./billingSubscription";
import { PACK_CHECKOUT_CLOSED_FOR_PLAN } from "./billingPacks";
import { workUnderWay } from "./businessDeletion";
import { generateApiKey } from "./publicApi/apiKeys";
import { PublicApiError } from "./publicApi/errors";
import { createPackCheckoutForApi, getPackCheckoutForApi, type ApiKeyCaller, type PlatformKeyCaller } from "./publicApi/operations";

// Prepaid pack checkouts against PostgreSQL: who may buy a pack, the one open
// purchase a business makes at a time across packs and plans, and the steps
// the job and billing.reconcile take on a checkout. A business that never
// starts a pack checkout is covered by the plan checkout tests, which these
// changes must leave as they were.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Pack checkout integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const MINUTE = 60_000;
const stripe = { BILLING_PROVIDER: "stripe" };

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

/** Runs a step as a runtime role, as the dashboard (lobbystack_app) or the jobs (lobbystack_worker) do, with its row-level security. */
async function as<T>(tx: DatabaseTransaction, role: "lobbystack_app" | "lobbystack_worker", run: (context: { db: Database }) => Promise<T>): Promise<T> {
  await tx.execute(sql.raw(`set local role ${role}`));
  try {
    return await run({ db: tx as unknown as Database });
  } finally {
    await tx.execute(sql`reset role`);
  }
}

type AccountInput = { plan?: string; state?: string | null; interval?: string | null; replaced?: boolean; source?: string };

/** A business, and its billing account unless account is null: Free without a plan, else a live subscription. */
async function business(tx: DatabaseTransaction, input: { account?: AccountInput | null; deploymentMode?: string } = {}) {
  const businessId = randomUUID();
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Pack checkout test", timezone: "UTC", businessType: "test", telemetryEnabled: false, ...(input.deploymentMode ? { deploymentMode: input.deploymentMode } : {}) });
  if (input.account !== null) {
    const account = input.account ?? {};
    const paying = account.plan !== undefined && account.plan !== "free_cloud";
    const subscriptionId = paying ? `sub_${businessId}` : null;
    await tx.insert(billingAccounts).values({
      businessId,
      billingKey: `business:${businessId}`,
      source: account.source ?? "stripe",
      customerId: `cus_${businessId}`,
      plan: account.plan ?? "free_cloud",
      subscriptionId,
      subscriptionState: account.state === undefined ? (paying ? "active" : null) : account.state,
      billingInterval: account.interval === undefined ? (paying ? "monthly" : null) : account.interval,
      replacedSubscriptionId: account.replaced ? subscriptionId : null,
    });
  }
  return businessId;
}

/** A person, an owner of the business when one is given. */
async function person(tx: DatabaseTransaction, businessId?: string) {
  const id = randomUUID();
  await tx.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid` });
  if (businessId) await tx.insert(businessMemberships).values({ businessId, userId: id, role: "business_owner" });
  return id;
}

/** A pack and its live price: on sale once a link recorded the price at the provider, and while the pack is active. */
async function pack(tx: DatabaseTransaction, input: { linked?: boolean; status?: "draft" | "active" } = {}) {
  const code = `pk_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await tx.insert(billingPackPlans).values({ code, status: input.status ?? "active", names: { en: "Test pack", fr: "Test pack", es: "Test pack", sr: "Test pack" }, voiceSec: 30_000, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, termsHash: "0".repeat(64) });
  const [price] = await tx.insert(billingPackPrices).values({ pack: code, currency: "cad", cents: 9900, providerRef: input.linked === false ? null : `price_${randomUUID()}` }).returning({ id: billingPackPrices.id, providerRef: billingPackPrices.providerRef });
  return { code, priceId: price!.id, priceRef: price!.providerRef };
}

/** A live pack the business bought, which puts it on the prepaid tier. */
async function livePack(tx: DatabaseTransaction, businessId: string, code: string) {
  const paidAt = new Date(Date.now() - 86_400_000);
  await tx.insert(billingPacks).values({ businessId, pack: code, days: 90, provider: "stripe", providerRef: `pi_${randomUUID()}`, amountCents: 9900, currency: "cad", secondsTotal: 30_000, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, paidAt, endsAt: new Date(paidAt.getTime() + 90 * 86_400_000) });
}

/** A pack checkout row as the app or the job left it, made minutes ago. */
async function checkoutRow(tx: DatabaseTransaction, input: { businessId: string; userId: string; pack: { code: string; priceId: string }; status?: string; minutes?: number; updatedMinutes?: number; expiresInMinutes?: number }) {
  const created = new Date(Date.now() - (input.minutes ?? 1) * MINUTE);
  const ready = input.status === "ready";
  const [row] = await tx.insert(billingPackCheckouts).values({
    businessId: input.businessId,
    requestedByUserId: input.userId,
    pack: input.pack.code,
    priceId: input.pack.priceId,
    status: input.status ?? "pending",
    ...(ready ? { checkoutId: `cs_${randomUUID()}`, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test" } : {}),
    expiresAt: new Date(created.getTime() + (input.expiresInMinutes ?? 15) * MINUTE),
    createdAt: created,
    updatedAt: new Date(Date.now() - (input.updatedMinutes ?? input.minutes ?? 1) * MINUTE),
  }).returning({ id: billingPackCheckouts.id });
  return row!.id;
}

/** What a call threw: its status, code and sentence. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const { status, code, message } = error as { status?: number; code?: string; message: string };
    return { status, code, message };
  }
  throw new Error("The call went through.");
}

const buy = (tx: DatabaseTransaction, input: { userId: string; businessId: string; pack: string; billingEmail?: string; checkLimit?: (subject: { businessId: string; userId: string }) => Promise<void> }, env: Record<string, string | undefined> = stripe) => createPackCheckoutRequestInTransaction(tx, input, env);

async function row(tx: DatabaseTransaction, id: string) {
  const [found] = await tx.select().from(billingPackCheckouts).where(eq(billingPackCheckouts.id, id));
  return found!;
}

async function outbox(tx: DatabaseTransaction, aggregateId: string) {
  return (await tx.select({ topic: outboxMessages.topic, aggregateType: outboxMessages.aggregateType, dedupeKey: outboxMessages.dedupeKey, payload: outboxMessages.payload }).from(outboxMessages).where(eq(outboxMessages.aggregateId, aggregateId))).sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
}

describe.skipIf(!testUrl)("prepaid pack checkouts against PostgreSQL", () => {
  it("queues a business's checkout for a pack on sale from the dashboard, once, with the job's 15 minutes", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, { account: null });
      const userId = await person(tx, businessId);
      const sold = await pack(tx);
      const checkLimit = vi.fn(async () => undefined);
      const before = Date.now();

      // The dashboard's request, under the app's row-level security.
      const id = await as(tx, "lobbystack_app", (context) => createPackCheckoutRequest(context, { userId, businessId, pack: sold.code, checkLimit }));
      const made = await row(tx, id);
      expect(made).toMatchObject({ businessId, requestedByUserId: userId, pack: sold.code, priceId: sold.priceId, status: "pending", checkoutId: null, checkoutUrl: null, billingEmail: null, packId: null });
      // The terms the business saw, which its payment adds the pack with whatever the catalog says by then.
      expect(made.terms).toEqual({ voiceSec: 30_000, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1 });
      expect(made.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 15 * MINUTE - 1_000);
      expect(made.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * MINUTE + 1_000);
      expect(await outbox(tx, id)).toEqual([{ topic: "billing.createPackCheckout", aggregateType: "billing_pack_checkout", dedupeKey: `billing-pack-checkout:${id}`, payload: { checkoutId: id } }]);
      // The account the payment lands on, as a plan checkout opens it.
      expect((await tx.select({ billingKey: billingAccounts.billingKey }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)))[0]).toEqual({ billingKey: `business:${businessId}` });
      expect(checkLimit).toHaveBeenCalledExactlyOnceWith({ businessId, userId });

      // A second click gets the same checkout and counts nothing against the limits.
      expect(await buy(tx, { userId, businessId, pack: sold.code, checkLimit })).toEqual({ id, created: false });
      expect(checkLimit).toHaveBeenCalledTimes(1);
      // Another billing email is another purchase, which waits for the first.
      expect(await refusal(buy(tx, { userId, businessId, pack: sold.code, billingEmail: "billing@example.com" }))).toEqual({ status: 409, code: "plan_change_pending", message: OPEN_PURCHASE_REFUSAL });
      // A refusal of the limits stops it before any row.
      await tx.update(billingPackCheckouts).set({ status: "failed" }).where(eq(billingPackCheckouts.id, id));
      expect(await refusal(buy(tx, { userId, businessId, pack: sold.code, checkLimit: async () => { throw Object.assign(new Error("Too many checkouts started."), { status: 429, code: "billing_rate_limited" }); } }))).toMatchObject({ status: 429, code: "billing_rate_limited" });
      expect(await tx.select({ id: billingPackCheckouts.id }).from(billingPackCheckouts).where(eq(billingPackCheckouts.businessId, businessId))).toHaveLength(1);
    });
  });

  it("opens a new account on the deployment's provider, and keeps the billing email a person gives", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx, { account: null });
      const userId = await person(tx);
      const sold = await pack(tx);
      const made = await buy(tx, { userId, businessId, pack: sold.code, billingEmail: "billing@example.com" }, stripe);
      expect(made.created).toBe(true);
      expect((await row(tx, made.id)).billingEmail).toBe("billing@example.com");
      expect((await tx.select({ source: billingAccounts.source }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)))[0]?.source).toBe("stripe");
      expect(await buy(tx, { userId, businessId, pack: sold.code, billingEmail: "billing@example.com" })).toEqual({ id: made.id, created: false });
    });
  });

  it("sells packs to Free and prepaid businesses and to monthly subscribers, and refuses yearly ones (6a), past-due ones (6b) and an upgrade waiting for its payment", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const userId = await person(tx);
      const allowed = async (account: AccountInput | null) => (await buy(tx, { userId, businessId: await business(tx, { account }), pack: sold.code })).created;

      expect(await allowed(null)).toBe(true);
      expect(await allowed({})).toBe(true);
      expect(await allowed({ plan: "starter" })).toBe(true);
      expect(await allowed({ plan: "pro", source: "polar" })).toBe(true);
      // A business on a pack tops up.
      const prepaid = await business(tx);
      await livePack(tx, prepaid, sold.code);
      expect((await buy(tx, { userId, businessId: prepaid, pack: sold.code })).created).toBe(true);
      // An ended subscription is Free.
      expect(await allowed({ plan: "starter", state: "canceled", interval: "annual" })).toBe(true);

      const yearly = await business(tx, { account: { plan: "starter", interval: "annual" } });
      expect(await refusal(buy(tx, { userId, businessId: yearly, pack: sold.code }))).toEqual({ status: 409, code: "pack_yearly_plan", message: "This business pays for a yearly plan. Set it to end at its renewal, and buy a pack once it ends." });
      const pastDue = await business(tx, { account: { plan: "pro", state: "past_due" } });
      expect(await refusal(buy(tx, { userId, businessId: pastDue, pack: sold.code }))).toEqual({ status: 409, code: "pack_past_due", message: "This business has a payment past due. Settle it before buying a pack." });
      // An upgrade still waiting on the page that pays it: the pack would end the subscription it upgrades.
      const upgrading = await business(tx, { account: { plan: "starter" } });
      await tx.insert(billingCheckoutRequests).values({ businessId: upgrading, requestedByUserId: userId, target: "pro", billingInterval: "monthly", status: "ready", checkoutId: `sub_${upgrading}`, checkoutUrl: "https://invoice.stripe.com/i/in_1" });
      expect(await refusal(buy(tx, { userId, businessId: upgrading, pack: sold.code }))).toEqual({ status: 409, code: "plan_change_payment_waiting", message: "An upgrade of this business's plan is waiting for its payment. Pay it, or buy a pack once it expires." });
      for (const businessId of [yearly, pastDue, upgrading]) expect(await tx.select({ id: billingPackCheckouts.id }).from(billingPackCheckouts).where(eq(billingPackCheckouts.businessId, businessId))).toEqual([]);
    });
  });

  it("treats a subscription a pack already replaced as ended, whatever its interval or state", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const userId = await person(tx);
      const yearly = await business(tx, { account: { plan: "starter", interval: "annual", replaced: true } });
      expect((await buy(tx, { userId, businessId: yearly, pack: sold.code })).created).toBe(true);
      const pastDue = await business(tx, { account: { plan: "pro", state: "past_due", replaced: true } });
      expect((await buy(tx, { userId, businessId: pastDue, pack: sold.code })).created).toBe(true);
    });
  });

  it("refuses a pack on a managed plan, a self-hosted deployment or the Enterprise plan, and one that isn't on sale", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const userId = await person(tx);
      const refused = async (businessId: string, code = sold.code) => await refusal(buy(tx, { userId, businessId, pack: code }));

      expect(await refused(await business(tx, { account: { plan: "enterprise", source: "managed", interval: null } }))).toEqual({ status: 409, code: "managed_plan", message: "This business is on a managed plan, billed directly by the operator." });
      expect(await refused(await business(tx, { deploymentMode: "self_hosted_standard" }))).toEqual({ status: 409, code: "pack_not_sold_on_plan", message: "Prepaid packs aren't sold on a self-hosted deployment." });
      expect(await refused(await business(tx, { account: { plan: "enterprise" } }))).toEqual({ status: 409, code: "pack_not_sold_on_plan", message: "Prepaid packs aren't sold to a business on the Enterprise plan." });

      const free = await business(tx);
      const notOnSale = { status: 409, code: "pack_not_on_sale", message: "This pack isn't on sale right now." };
      // No link recorded its price, the pack is still a draft, or there's no such pack.
      expect(await refused(free, (await pack(tx, { linked: false })).code)).toEqual(notOnSale);
      expect(await refused(free, (await pack(tx, { status: "draft" })).code)).toEqual(notOnSale);
      expect(await refused(free, "pk_no_such_pack")).toEqual(notOnSale);
      // Retired from sale.
      await tx.update(billingPackPlans).set({ status: "retired", retiredAt: new Date() }).where(eq(billingPackPlans.code, sold.code));
      expect(await refused(free)).toEqual(notOnSale);
      expect(await tx.select({ id: billingPackCheckouts.id }).from(billingPackCheckouts).where(eq(billingPackCheckouts.businessId, free))).toEqual([]);
    });
  });

  it("makes one purchase at a time across packs and plans: an open plan request or subscription change holds a pack, and an open pack checkout holds them", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const other = await pack(tx);
      const businessId = await business(tx);
      const [first, second] = [await person(tx), await person(tx)];
      const pending = { status: 409, code: "plan_change_pending", message: OPEN_PURCHASE_REFUSAL };

      const opened = await buy(tx, { userId: first, businessId, pack: sold.code });
      // Someone else's pack, or another pack, waits.
      expect(await refusal(buy(tx, { userId: second, businessId, pack: sold.code }))).toEqual(pending);
      expect(await refusal(buy(tx, { userId: first, businessId, pack: other.code }))).toEqual(pending);
      // So does a plan checkout, from the dashboard or the API.
      expect(await refusal(createBillingCheckoutRequestInTransaction(tx, { userId: second, businessId, target: "starter", billingInterval: "monthly" }, stripe))).toEqual(pending);

      // Once the provider made its page, nothing waits: a page left unpaid holds nothing.
      await tx.update(billingPackCheckouts).set({ status: "ready", checkoutId: "cs_1", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1" }).where(eq(billingPackCheckouts.id, opened.id));
      const plan = await createBillingCheckoutRequestInTransaction(tx, { userId: second, businessId, target: "starter", billingInterval: "monthly" }, stripe);
      expect(plan.created).toBe(true);
      // Now the plan's request holds a pack.
      expect(await refusal(buy(tx, { userId: first, businessId, pack: other.code }))).toEqual(pending);
      // One older than its 15 minutes holds nothing: it fails rather than runs.
      await tx.update(billingCheckoutRequests).set({ createdAt: new Date(Date.now() - 20 * MINUTE) }).where(eq(billingCheckoutRequests.id, plan.id));
      expect((await buy(tx, { userId: first, businessId, pack: other.code })).created).toBe(true);

      // A Stripe subscriber's cancel waits for an open pack checkout, and an open cancel holds a pack.
      const subscriber = await business(tx, { account: { plan: "pro" } });
      const checkout = await buy(tx, { userId: first, businessId: subscriber, pack: sold.code });
      expect(await refusal(createBillingSubscriptionRequestInTransaction(tx, { userId: second, businessId: subscriber, action: "cancel" }, stripe))).toEqual(pending);
      await tx.update(billingPackCheckouts).set({ status: "failed" }).where(eq(billingPackCheckouts.id, checkout.id));
      expect((await createBillingSubscriptionRequestInTransaction(tx, { userId: second, businessId: subscriber, action: "cancel" }, stripe)).created).toBe(true);
      expect(await refusal(buy(tx, { userId: first, businessId: subscriber, pack: sold.code }))).toEqual(pending);
    });
  });

  it("lets a business on a pack buy a plan, which then starts a new subscription rather than changing the one a pack replaced", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const userId = await person(tx);
      // A former Starter subscriber whose pack replaced the subscription, which Stripe still shows active.
      const businessId = await business(tx, { account: { plan: "starter", replaced: true, source: "polar" } });
      await livePack(tx, businessId, sold.code);
      const plan = await createBillingCheckoutRequestInTransaction(tx, { userId, businessId, target: "starter", billingInterval: "monthly" }, {});
      expect(plan.created).toBe(true);
      const request = await as(tx, "lobbystack_worker", (context) => loadBillingCheckoutRequest(context, { businessId, requestId: plan.id }));
      expect(request?.subscription).toBeNull();
      // Nor can its old subscription be cancelled, resumed or kept.
      await tx.update(billingCheckoutRequests).set({ status: "ready", checkoutId: "checkout-1", checkoutUrl: "https://polar.test/checkout/1" }).where(eq(billingCheckoutRequests.id, plan.id));
      expect(await refusal(createBillingSubscriptionRequestInTransaction(tx, { userId, businessId, action: "cancel" }, stripe))).toEqual({ status: 404, code: "not_found", message: "This business has no live subscription." });
    });
  });

  it("claims a checkout once, hands it back for a retry, records its page in one update, fails it, and expires one that waited too long", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const businessId = await business(tx);
      const userId = await person(tx);
      const fresh = await checkoutRow(tx, { businessId, userId, pack: sold });
      const stale = await checkoutRow(tx, { businessId, userId, pack: sold, minutes: 20 });
      const failing = await checkoutRow(tx, { businessId, userId, pack: sold, minutes: 2 });

      await as(tx, "lobbystack_worker", async (context) => {
        expect(await claimPackCheckout(context, { businessId, checkoutId: fresh })).toEqual({ claimed: true });
        const held = await claimPackCheckout(context, { businessId, checkoutId: fresh });
        expect(held).toMatchObject({ claimed: false, retryAt: expect.any(Date) });
        expect(await releasePackCheckout(context, { businessId, checkoutId: fresh })).toBe(true);
        expect(await claimPackCheckout(context, { businessId, checkoutId: fresh })).toEqual({ claimed: true });
        const pageEnds = new Date(Date.now() + 61 * MINUTE);
        expect(await markPackCheckoutReady(context, { businessId, checkoutId: fresh, providerCheckoutId: "cs_1", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1", expiresAt: pageEnds })).toBe(true);
        // Only once.
        expect(await markPackCheckoutReady(context, { businessId, checkoutId: fresh, providerCheckoutId: "cs_2", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_2", expiresAt: pageEnds })).toBe(false);

        expect(await claimPackCheckout(context, { businessId, checkoutId: stale })).toEqual({ claimed: false, retryAt: null, expired: true });

        expect(await claimPackCheckout(context, { businessId, checkoutId: failing })).toEqual({ claimed: true });
        expect(await markPackCheckoutFailed(context, { businessId, checkoutId: failing, error: "Stripe checkout creation failed." })).toBe(true);
        // A failure stands.
        expect(await claimPackCheckout(context, { businessId, checkoutId: failing })).toEqual({ claimed: false, retryAt: null });
      });

      expect(await row(tx, fresh)).toMatchObject({ status: "ready", checkoutId: "cs_1", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1", error: null });
      expect(await row(tx, stale)).toMatchObject({ status: "expired", error: "This request waited too long to run." });
      expect(await row(tx, failing)).toMatchObject({ status: "failed", error: "Stripe checkout creation failed." });
      // Each change tells the page.
      expect((await outbox(tx, fresh)).map((message) => message.dedupeKey)).toEqual([`billing-pack-checkout:${fresh}:ready`]);
      expect((await outbox(tx, stale)).map((message) => message.dedupeKey)).toEqual([`billing-pack-checkout:${stale}:expired`]);
      expect((await outbox(tx, failing)).map((message) => message.dedupeKey)).toEqual([`billing-pack-checkout:${failing}:failed`]);
    });
  });

  it("gives a page without the provider's expiry an hour, and shows its link only while it's open", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const businessId = await business(tx);
      const userId = await person(tx);
      const id = await checkoutRow(tx, { businessId, userId, pack: sold, status: "processing" });
      const before = Date.now();
      await as(tx, "lobbystack_worker", (context) => markPackCheckoutReady(context, { businessId, checkoutId: id, providerCheckoutId: "checkout-1", checkoutUrl: "https://polar.test/checkout/1", expiresAt: null }));
      const ready = await row(tx, id);
      expect(ready.expiresAt.getTime()).toBeGreaterThanOrEqual(before + PACK_CHECKOUT_PAGE_MS - 1_000);
      expect(ready.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + PACK_CHECKOUT_PAGE_MS + 1_000);

      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId: id })).toMatchObject({ status: "ready", checkoutUrl: "https://polar.test/checkout/1", error: null, packStatus: null });
      // Left unpaid past its expiry, the page reads as expired, as nobody can pay on it.
      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId: id }, new Date(ready.expiresAt.getTime() + 1_000))).toMatchObject({ status: "expired", checkoutUrl: null, error: "This payment page expired." });
      expect((await row(tx, id)).status).toBe("ready");
      // Another business's, or no such checkout.
      expect(await readPackCheckoutInTransaction(tx, { businessId: await business(tx), checkoutId: id })).toBeNull();
      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId: "not-a-checkout" })).toBeNull();
    });
  });

  it("says what became of the pack a paid checkout added, once its payment named it", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const businessId = await business(tx);
      const userId = await person(tx);
      const id = await checkoutRow(tx, { businessId, userId, pack: sold, status: "paid" });
      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId: id })).toMatchObject({ status: "paid", packStatus: null });
      // A plan bought while the page was open started first, so the pack ended as it arrived.
      const paidAt = new Date(Date.now() - 60_000);
      const [added] = await tx.insert(billingPacks).values({ businessId, pack: sold.code, days: 90, provider: "stripe", providerRef: `pi_${randomUUID()}`, amountCents: 9900, currency: "cad", secondsTotal: 30_000, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, paidAt, endsAt: new Date(paidAt.getTime() + 90 * 86_400_000), status: "replaced", endedAt: new Date(), unusedSeconds: 30_000 }).returning({ id: billingPacks.id });
      await tx.update(billingPackCheckouts).set({ packId: added!.id }).where(eq(billingPackCheckouts.id, id));
      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId: id })).toMatchObject({ status: "paid", packStatus: "replaced" });
    });
  });

  it("loads what the job needs, and no price once the pack stops selling at the row's price", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const businessId = await business(tx);
      const userId = await person(tx);
      const id = await checkoutRow(tx, { businessId, userId, pack: sold, status: "processing" });
      const load = async () => await as(tx, "lobbystack_worker", (context) => loadPackCheckoutRequest(context, { businessId, checkoutId: id }));

      expect(await load()).toEqual({ id, businessId, pack: sold.code, priceId: sold.priceId, status: "processing", priceRef: sold.priceRef, customerEmail: `${userId}@example.invalid`, billingEmail: null, externalCustomerId: `business:${businessId}`, customerId: `cus_${businessId}`, businessName: "Pack checkout test", onboardingStage: "create_business" });
      await tx.update(billingPackPrices).set({ retiredAt: new Date() }).where(eq(billingPackPrices.id, sold.priceId));
      expect((await load())?.priceRef).toBeNull();
      await tx.update(billingPackPrices).set({ retiredAt: null }).where(eq(billingPackPrices.id, sold.priceId));
      await tx.update(billingPackPlans).set({ status: "retired", retiredAt: new Date() }).where(eq(billingPackPlans.code, sold.code));
      expect((await load())?.priceRef).toBeNull();
      expect(await as(tx, "lobbystack_worker", (context) => loadPackCheckoutRequest(context, { businessId, checkoutId: randomUUID() }))).toBeNull();
    });
  });

  it("marks a checkout paid whatever its status, once, as billing.reconcile does when the payment arrives", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const businessId = await business(tx);
      const userId = await person(tx);
      const expired = await checkoutRow(tx, { businessId, userId, pack: sold, status: "expired", minutes: 90 });

      const paid = await as(tx, "lobbystack_worker", (context) => withWorker(context, businessId, (scoped) => markPackCheckoutPaidInTransaction(scoped, { businessId, checkoutId: expired })));
      expect(paid).toBe(true);
      expect(await row(tx, expired)).toMatchObject({ status: "paid", error: null });
      expect((await outbox(tx, expired)).map((message) => message.dedupeKey)).toEqual([`billing-pack-checkout:${expired}:paid`]);
      // Again, for another business, or for an ID that isn't one: nothing.
      expect(await as(tx, "lobbystack_worker", (context) => withWorker(context, businessId, (scoped) => markPackCheckoutPaidInTransaction(scoped, { businessId, checkoutId: expired })))).toBe(false);
      const stranger = await business(tx);
      expect(await as(tx, "lobbystack_worker", (context) => withWorker(context, stranger, (scoped) => markPackCheckoutPaidInTransaction(scoped, { businessId: stranger, checkoutId: expired })))).toBe(false);
      expect(await as(tx, "lobbystack_worker", (context) => withWorker(context, businessId, (scoped) => markPackCheckoutPaidInTransaction(scoped, { businessId, checkoutId: "pack-checkout-1" })))).toBe(false);
    });
  });

  it("fails pack checkouts still being made when the business moves to a managed plan", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const businessId = await business(tx);
      const userId = await person(tx);
      const pending = await checkoutRow(tx, { businessId, userId, pack: sold });
      const ready = await checkoutRow(tx, { businessId, userId, pack: sold, status: "ready" });
      expect(await setManagedPlanInTransaction(tx, { businessId })).toBe("set");
      expect(await row(tx, pending)).toMatchObject({ status: "failed", error: "The business moved to a managed plan." });
      expect((await row(tx, ready)).status).toBe("ready");
    });
  });

  it("counts a pack checkout someone could still pay as work under way, until its page expires", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const businessId = await business(tx);
      const userId = await person(tx);
      expect(await workUnderWay(tx, businessId)).toBeNull();
      const id = await checkoutRow(tx, { businessId, userId, pack: sold, status: "ready", minutes: 30, expiresInMinutes: 61 });
      expect(await workUnderWay(tx, businessId)).toBe("checkout_open");
      await tx.update(billingPackCheckouts).set({ expiresAt: new Date(Date.now() - MINUTE) }).where(eq(billingPackCheckouts.id, id));
      expect(await workUnderWay(tx, businessId)).toBeNull();
      // Paid, failed or expired ones are done.
      await tx.update(billingPackCheckouts).set({ status: "paid", expiresAt: new Date(Date.now() + 30 * MINUTE) }).where(and(eq(billingPackCheckouts.id, id), eq(billingPackCheckouts.businessId, businessId)));
      expect(await workUnderWay(tx, businessId)).toBeNull();
      await tx.update(billingPackCheckouts).set({ status: "expired" }).where(and(eq(billingPackCheckouts.id, id), eq(billingPackCheckouts.businessId, businessId)));
      expect(await workUnderWay(tx, businessId)).toBeNull();
      // One a plan's start closed stays payable on Polar, and on Stripe until the close went through, so it counts until its page expires.
      await tx.update(billingPackCheckouts).set({ error: PACK_CHECKOUT_CLOSED_FOR_PLAN }).where(and(eq(billingPackCheckouts.id, id), eq(billingPackCheckouts.businessId, businessId)));
      expect(await workUnderWay(tx, businessId)).toBe("checkout_open");
      await tx.update(billingPackCheckouts).set({ expiresAt: new Date(Date.now() - MINUTE) }).where(and(eq(billingPackCheckouts.id, id), eq(billingPackCheckouts.businessId, businessId)));
      expect(await workUnderWay(tx, businessId)).toBeNull();
    });
  });

  it("starts the API's pack checkout as the dashboard's, made out to the key's creator, audited once, with its refusals as 409s", async () => {
    await rollbackTest(async (tx) => {
      const sold = await pack(tx);
      const businessId = await business(tx);
      const ownerId = await person(tx, businessId);
      const generated = generateApiKey();
      const [key] = await tx.insert(apiKeys).values({ businessId, name: "billing", prefix: generated.prefix, keyHash: generated.keyHash, scopes: ["billing:manage"], createdByUserId: ownerId }).returning({ id: apiKeys.id });
      const caller: ApiKeyCaller = { businessId, apiKeyId: key!.id };
      const checkLimit = vi.fn(async () => undefined);
      const audited = async () => await tx.select({ entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "api.billing.pack_checkout_started")));

      // The API runs as the worker's login, with the worker's actor.
      const checkout = await as(tx, "lobbystack_worker", (context) => createPackCheckoutForApi(context, caller, { pack: sold.code, billing_email: "billing@example.invalid" }, { available: true, checkLimit }));
      expect(apiPackCheckoutSchema.safeParse(checkout).success).toBe(true);
      expect(checkout).toMatchObject({ pack: sold.code, status: "pending", checkout_url: null, error: null, paid: false });
      expect(await row(tx, checkout.id)).toMatchObject({ requestedByUserId: ownerId, billingEmail: "billing@example.invalid", priceId: sold.priceId });
      expect(checkLimit).toHaveBeenCalledExactlyOnceWith({ businessId, userId: ownerId });
      expect(await audited()).toEqual([{ entityId: checkout.id, payload: expect.objectContaining({ pack: sold.code, payerUserId: ownerId }) }]);
      // Asked again, the same open checkout comes back, counted and audited once.
      const again = await as(tx, "lobbystack_worker", (context) => createPackCheckoutForApi(context, caller, { pack: sold.code, billing_email: "billing@example.invalid" }, { available: true, checkLimit }));
      expect(again.id).toBe(checkout.id);
      expect(checkLimit).toHaveBeenCalledTimes(1);
      expect(await audited()).toHaveLength(1);
      expect(await as(tx, "lobbystack_worker", (context) => getPackCheckoutForApi(context, caller, checkout.id))).toEqual(checkout);

      // Paid, it reads as paid; another business's key doesn't find it.
      await tx.update(billingPackCheckouts).set({ status: "paid" }).where(eq(billingPackCheckouts.id, checkout.id));
      expect(await as(tx, "lobbystack_worker", (context) => getPackCheckoutForApi(context, caller, checkout.id))).toMatchObject({ status: "paid", paid: true });
      const stranger = await business(tx);
      const strangerOwner = await person(tx, stranger);
      const strangerKey = generateApiKey();
      const [other] = await tx.insert(apiKeys).values({ businessId: stranger, name: "billing", prefix: strangerKey.prefix, keyHash: strangerKey.keyHash, scopes: ["billing:manage"], createdByUserId: strangerOwner }).returning({ id: apiKeys.id });
      await expect(as(tx, "lobbystack_worker", (context) => getPackCheckoutForApi(context, { businessId: stranger, apiKeyId: other!.id }, checkout.id))).rejects.toMatchObject({ status: 404, code: "not_found" });

      // The dashboard's refusals are the API's 409, with their sentence.
      await tx.update(billingAccounts).set({ plan: "starter", subscriptionId: `sub_${businessId}`, subscriptionState: "active", billingInterval: "annual" }).where(eq(billingAccounts.businessId, businessId));
      const yearly = await as(tx, "lobbystack_worker", (context) => createPackCheckoutForApi(context, caller, { pack: sold.code }, { available: true })).catch((error: unknown) => error);
      expect(yearly).toBeInstanceOf(PublicApiError);
      expect(yearly).toMatchObject({ status: 409, code: "conflict", message: "This business pays for a yearly plan. Set it to end at its renewal, and buy a pack once it ends." });
      // A deployment that doesn't sell packs refuses before anything else.
      await expect(as(tx, "lobbystack_worker", (context) => createPackCheckoutForApi(context, caller, { pack: sold.code }, { available: false }))).rejects.toMatchObject({ status: 409, code: "conflict", message: expect.stringMatching(/^This deployment doesn't sell packs through /) });

      // A platform key makes it out to the business's own owner, and refuses while the business has none but the key's account.
      const operator: PlatformKeyCaller = { businessId: stranger, platformKeyId: randomUUID(), partnerId: "lobbystack", actingUserId: strangerOwner, actor: "platform_key" };
      await expect(as(tx, "lobbystack_worker", (context) => createPackCheckoutForApi(context, operator, { pack: sold.code }, { available: true }))).rejects.toMatchObject({ status: 409, message: "Only the business's own owner can pay for a pack, and this business hasn't been claimed yet. Send the claim link first, or give it a managed plan." });
    });
  });
});

/** Runs one step in the business's own transaction as the worker, as billing.reconcile does. */
async function withWorker<T>(context: { db: Database }, businessId: string, run: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  const { withBusinessTransaction } = await import("@lobbystack/db");
  return await withBusinessTransaction(context.db, { businessId, actorType: "worker" }, run);
}
