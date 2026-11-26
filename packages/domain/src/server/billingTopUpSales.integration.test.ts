import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { apiKeys, auditLogs, billingAccounts, billingPackCheckouts, billingPackPlans, billingPackPrices, billingPacks, billingTopUps, businessMemberships, businesses, createDatabaseClient, outboxMessages, providerEvents, users, withBusinessTransaction, type BillingPackCheckoutTerms, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { apiTopUpCheckoutSchema } from "@lobbystack/shared";

import { OPEN_PURCHASE_REFUSAL, reconcileBillingProviderEvent, setManagedPlanInTransaction } from "./billing";
import { createTopUpCheckoutRequest, createTopUpCheckoutRequestInTransaction, readPackCheckoutInTransaction, TOP_UP_NOT_ON_SALE } from "./billingPackCheckout";
import { loadPackOffers, loadTopUpOffers, topUpCheckoutEligibility } from "./billingPackView";
import { PACK_CHECKOUT_CLOSED_FOR_PLAN } from "./billingPacks";
import { listBusinessTopUps } from "./billingTopUps";
import { generateApiKey } from "./publicApi/apiKeys";
import type { ApiKeyCaller } from "./publicApi/operations";
import { createTopUpCheckoutForApi, getPackCheckoutForApi, getTopUpCheckoutForApi } from "./publicApi/packCheckouts";
import { loadBusinessPlanLimits } from "./usage";

// Top-ups on sale (0155) against PostgreSQL: who may buy one, the checkout it
// shares with prepaid packs, and what the billing provider's events do to it.
// A top-up's payment adds a top-up and changes nothing else; refunds take
// their share off it, a whole refund or a lost dispute ends it, and an open
// dispute freezes it. Events are stored as the webhook stores them and
// applied with reconcileBillingProviderEvent, as billing.reconcile does. A
// deployment that sells no top-up is covered by the pack tests, which pass
// unchanged.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Top-up sale integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const DAY = 86_400_000;
const stripe = { BILLING_PROVIDER: "stripe" };
const NAMES = { en: "100 extra minutes", fr: "100 minutes supplémentaires", es: "100 minutos adicionales", sr: "100 dodatnih minuta" };
/** The terms a top-up checkout keeps: 100 minutes for 90 days, and no limit. */
const TOP_UP_TERMS: BillingPackCheckoutTerms = { voiceSec: 6_000, days: 90, smsSeg: 0, callsOut: 0, chatUnits: 0, kbBytes: 0, numbers: 0, receptionists: 0 };

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

/** Runs a step as a runtime role, as the dashboard (lobbystack_app) or the jobs and the API (lobbystack_worker) do. */
async function as<T>(tx: DatabaseTransaction, role: "lobbystack_app" | "lobbystack_worker", run: (context: { db: Database }) => Promise<T>): Promise<T> {
  await tx.execute(sql.raw(`set local role ${role}`));
  try {
    return await run({ db: tx as unknown as Database });
  } finally {
    await tx.execute(sql`reset role`);
  }
}

const code = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** A top-up on sale, 100 minutes for CA$25 lasting 90 days: on sale once a link recorded its price at the provider. priceRef is that object's id. */
async function topUpOnSale(tx: DatabaseTransaction, input: { linked?: boolean; priceRef?: string } = {}) {
  const topUp = code("tu");
  await tx.insert(billingPackPlans).values({ code: topUp, kind: "top_up", status: "active", names: NAMES, voiceSec: 6_000, days: 90, smsSeg: 0, callsOut: 0, chatUnits: 0, kbBytes: 0, numbers: 0, receptionists: 0, sort: 10, termsHash: "1".repeat(64) });
  const providerRef = input.linked === false ? null : input.priceRef ?? `price_${randomUUID()}`;
  const [price] = await tx.insert(billingPackPrices).values({ pack: topUp, currency: "cad", cents: 2_500, providerRef }).returning({ id: billingPackPrices.id });
  return { code: topUp, priceId: price!.id, priceRef: providerRef };
}

/** A prepaid pack on sale beside it. */
async function packOnSale(tx: DatabaseTransaction) {
  const pack = code("pk");
  await tx.insert(billingPackPlans).values({ code: pack, status: "active", names: { en: "Test pack", fr: "Test pack", es: "Test pack", sr: "Test pack" }, voiceSec: 30_000, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, termsHash: "0".repeat(64) });
  const [price] = await tx.insert(billingPackPrices).values({ pack, currency: "cad", cents: 9_900, providerRef: `price_${randomUUID()}` }).returning({ id: billingPackPrices.id });
  return { code: pack, priceId: price!.id };
}

/** A business on Free, or on a live subscription to plan; source is the provider that bills it. */
async function business(tx: DatabaseTransaction, input: { plan?: string; source?: string; interval?: string } = {}) {
  const businessId = randomUUID();
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Top-up sale test", timezone: "UTC", businessType: "test", telemetryEnabled: false });
  const paying = input.plan !== undefined && input.plan !== "free_cloud";
  await tx.insert(billingAccounts).values({
    businessId,
    billingKey: `business:${businessId}`,
    source: input.source ?? "stripe",
    customerId: `cus_${businessId}`,
    plan: input.plan ?? "free_cloud",
    subscriptionId: paying ? `sub_${businessId}` : null,
    subscriptionState: paying ? "active" : null,
    billingInterval: paying ? input.interval ?? "monthly" : null,
  });
  return businessId;
}

/** A person, an owner of the business. */
async function owner(tx: DatabaseTransaction, businessId: string) {
  const id = randomUUID();
  await tx.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid` });
  await tx.insert(businessMemberships).values({ businessId, userId: id, role: "business_owner" });
  return id;
}

/** A live pack the business bought, which puts it on the prepaid tier. */
async function livePack(tx: DatabaseTransaction, businessId: string, pack: string) {
  const paidAt = new Date(Date.now() - DAY);
  const [row] = await tx.insert(billingPacks).values({ businessId, pack, days: 90, provider: "stripe", providerRef: `pi_${randomUUID()}`, amountCents: 9_900, currency: "cad", secondsTotal: 30_000, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, paidAt, endsAt: new Date(paidAt.getTime() + 90 * DAY) }).returning({ id: billingPacks.id });
  return row!.id;
}

/** A checkout the business asked for, with a ready page unless status says otherwise, as the job leaves it. */
async function checkoutRow(tx: DatabaseTransaction, businessId: string, sold: { code: string; priceId: string }, input: { status?: "pending" | "ready"; terms?: BillingPackCheckoutTerms } = {}) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid` });
  const status = input.status ?? "ready";
  const [row] = await tx.insert(billingPackCheckouts).values({ businessId, requestedByUserId: userId, pack: sold.code, priceId: sold.priceId, status, ...(status === "ready" ? { checkoutId: `cs_${randomUUID()}`, checkoutUrl: "https://checkout.stripe.test/pay" } : {}), expiresAt: new Date(Date.now() + DAY), terms: input.terms ?? TOP_UP_TERMS, subscriptionId: null }).returning({ id: billingPackCheckouts.id });
  return row!.id;
}

/** Stores an event as the webhook route does, for the business it named. */
async function store(tx: DatabaseTransaction, businessId: string, input: { provider?: "stripe" | "polar"; eventType: string; payload: Record<string, unknown> }) {
  const [row] = await tx.insert(providerEvents).values({ provider: input.provider ?? "stripe", providerEventId: `evt_${randomUUID()}`, eventType: input.eventType, businessId, payload: input.payload }).returning({ id: providerEvents.id });
  return row!.id;
}

/** Applies a stored event under the worker's role, as the billing.reconcile job does. */
async function reconcile(tx: DatabaseTransaction, businessId: string, providerEventId: string, refundInvoice?: string | null) {
  await tx.execute(sql`set local role lobbystack_worker`);
  try {
    return await reconcileBillingProviderEvent({ db: tx as unknown as Database }, { businessId, providerEventId, ...(refundInvoice !== undefined ? { refundInvoice } : {}) });
  } finally {
    await tx.execute(sql`reset role`);
  }
}

/** A Stripe checkout session paid for the top-up, as stripe/events.ts stores it: the worker puts the code and its price on the payment, as for a pack. */
function stripeSession(businessId: string, sold: { code: string; priceRef: string | null }, input: { paymentRef: string; checkoutId?: string; occurredAt?: Date }) {
  const occurredAt = input.occurredAt ?? new Date();
  return {
    id: `cs_${randomUUID()}`,
    object: "checkout.session",
    created: Math.floor((occurredAt.getTime() - 60_000) / 1_000),
    metadata: { lobbystack_business: businessId, lobbystack_pack: sold.code, ...(input.checkoutId ? { lobbystack_pack_checkout: input.checkoutId } : {}) },
    kind: "checkout",
    role: "pack",
    customerId: `cus_${businessId}`,
    ...(input.checkoutId ? { packCheckoutId: input.checkoutId } : {}),
    packCode: sold.code,
    packPriceRef: sold.priceRef,
    paymentRef: input.paymentRef,
    packOutcome: "paid",
    amountCents: 2_500,
    currency: "cad",
    occurredAt: occurredAt.toISOString(),
  };
}

async function topUpsOf(tx: DatabaseTransaction, businessId: string) {
  return await tx.select({ id: billingTopUps.id, source: billingTopUps.source, offer: billingTopUps.offer, priceId: billingTopUps.priceId, status: billingTopUps.status, provider: billingTopUps.provider, providerRef: billingTopUps.providerRef, transactionId: billingTopUps.transactionId, amountCents: billingTopUps.amountCents, refundedCents: billingTopUps.refundedCents, currency: billingTopUps.currency, voiceSec: billingTopUps.voiceSec, smsSeg: billingTopUps.smsSeg, startsAt: billingTopUps.startsAt, endsAt: billingTopUps.endsAt, refundedAt: billingTopUps.refundedAt })
    .from(billingTopUps).where(eq(billingTopUps.businessId, businessId)).orderBy(billingTopUps.createdAt);
}

/** What Settings > Plan shows: each top-up's status and what it gives after refunds. */
async function shown(tx: DatabaseTransaction, businessId: string) {
  return (await listBusinessTopUps(tx, businessId)).map((topUp) => ({ status: topUp.status, voiceSeconds: topUp.gives.voiceSeconds, refundedCents: topUp.refundedCents }));
}

async function planInForce(tx: DatabaseTransaction, businessId: string) {
  await tx.execute(sql`set local role lobbystack_worker`);
  try {
    return (await withBusinessTransaction(tx as unknown as Database, { businessId, actorType: "worker" }, (scoped) => loadBusinessPlanLimits(scoped, businessId))).plan;
  } finally {
    await tx.execute(sql`reset role`);
  }
}

async function accountOf(tx: DatabaseTransaction, businessId: string) {
  const [row] = await tx.select({ plan: billingAccounts.plan, subscriptionId: billingAccounts.subscriptionId, allowancesSince: billingAccounts.allowancesSince }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId));
  return row!;
}

/** What a call threw: its status, code and sentence. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const { status, code: refusalCode, message } = error as { status?: number; code?: string; message: string };
    return { status, code: refusalCode, message };
  }
  throw new Error("The call went through.");
}

const buy = (tx: DatabaseTransaction, input: { userId: string; businessId: string; topUp: string; billingEmail?: string }) => createTopUpCheckoutRequestInTransaction(tx, input, stripe);

describe.skipIf(!testUrl)("top-up checkouts against PostgreSQL", () => {
  it("queues a top-up's checkout on Free, once, as a pack's, and leaves it naming no subscription", async () => {
    await rollbackTest(async (tx) => {
      const sold = await topUpOnSale(tx);
      const businessId = await business(tx);
      const userId = await owner(tx, businessId);
      const checkLimit = vi.fn(async () => undefined);

      // The dashboard's request, under the app's row-level security.
      const id = await as(tx, "lobbystack_app", (context) => createTopUpCheckoutRequest(context, { userId, businessId, topUp: sold.code, checkLimit }));
      const [made] = await tx.select().from(billingPackCheckouts).where(eq(billingPackCheckouts.id, id));
      expect(made).toMatchObject({ businessId, requestedByUserId: userId, pack: sold.code, priceId: sold.priceId, status: "pending", packId: null, topUpId: null, subscriptionId: null, terms: TOP_UP_TERMS });
      expect(checkLimit).toHaveBeenCalledExactlyOnceWith({ businessId, userId });
      const jobs = await tx.select({ topic: outboxMessages.topic, payload: outboxMessages.payload }).from(outboxMessages).where(eq(outboxMessages.aggregateId, id));
      expect(jobs).toEqual([{ topic: "billing.createPackCheckout", payload: { checkoutId: id } }]);
      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId: id })).toMatchObject({ id, pack: sold.code, kind: "top_up", status: "pending", packStatus: null, topUpId: null, topUpStatus: null });

      // A second click gets the same checkout; another purchase waits for it, a pack's included.
      expect(await buy(tx, { userId, businessId, topUp: sold.code })).toEqual({ id, created: false });
      expect(await refusal(buy(tx, { userId, businessId, topUp: sold.code, billingEmail: "billing@example.com" }))).toEqual({ status: 409, code: "plan_change_pending", message: OPEN_PURCHASE_REFUSAL });
    });
  });

  it("sells a top-up on Free and on a prepaid pack only, and only one that is on sale", async () => {
    await rollbackTest(async (tx) => {
      const sold = await topUpOnSale(tx);
      const pack = await packOnSale(tx);

      // On a prepaid pack.
      const prepaid = await business(tx);
      await livePack(tx, prepaid, pack.code);
      expect(await planInForce(tx, prepaid)).toBe("prepaid");
      expect((await buy(tx, { userId: await owner(tx, prepaid), businessId: prepaid, topUp: sold.code })).created).toBe(true);

      // Starter and Pro go on past their allowance, so they buy none.
      const starter = await business(tx, { plan: "starter" });
      expect(await refusal(buy(tx, { userId: await owner(tx, starter), businessId: starter, topUp: sold.code }))).toEqual({ status: 409, code: "top_up_not_sold_on_plan", message: "Top-ups are sold on Free and on prepaid packs. On Starter and Pro, use past the plan's allowance goes on and is billed with the plan." });
      const managed = await business(tx);
      expect(await setManagedPlanInTransaction(tx, { businessId: managed })).toBe("set");
      expect(await refusal(buy(tx, { userId: await owner(tx, managed), businessId: managed, topUp: sold.code }))).toEqual({ status: 409, code: "managed_plan", message: "This business is on a managed plan, billed directly by the operator." });

      // Not on sale: no price at the provider yet, a pack's code, or no such code.
      const free = await business(tx);
      const freeOwner = await owner(tx, free);
      const unlinked = await topUpOnSale(tx, { linked: false });
      for (const topUp of [unlinked.code, pack.code, "tu_missing"]) {
        expect(await refusal(buy(tx, { userId: freeOwner, businessId: free, topUp }))).toEqual({ status: 409, code: "top_up_not_on_sale", message: TOP_UP_NOT_ON_SALE });
      }
    });
  });

  it("lists the top-ups on sale apart from the packs, and says before anyone clicks who may buy one", async () => {
    await rollbackTest(async (tx) => {
      const sold = await topUpOnSale(tx);
      const unlinked = await topUpOnSale(tx, { linked: false });
      const pack = await packOnSale(tx);
      const mine = new Set([sold.code, unlinked.code, pack.code]);

      const topUps = (await loadTopUpOffers(tx, { checkout: true })).filter((offer) => mine.has(offer.code));
      expect(topUps).toEqual(expect.arrayContaining([
        { code: sold.code, names: NAMES, gives: { voiceSeconds: 6_000, alertSmsSegments: 0, outboundCallAttempts: 0, chatAiUnits: 0 }, days: 90, amountCents: 2_500, currency: "cad", checkoutAvailable: true },
        expect.objectContaining({ code: unlinked.code, checkoutAvailable: false }),
      ]));
      expect(topUps).toHaveLength(2);
      expect((await loadTopUpOffers(tx, { checkout: false })).find((offer) => offer.code === sold.code)?.checkoutAvailable).toBe(false);
      // The packs on sale leave the top-ups out.
      expect((await loadPackOffers(tx, { checkout: true })).filter((offer) => mine.has(offer.code)).map((offer) => offer.code)).toEqual([pack.code]);

      const free = await business(tx);
      expect(await topUpCheckoutEligibility(tx, { businessId: free })).toBeNull();
      const prepaid = await business(tx);
      await livePack(tx, prepaid, pack.code);
      expect(await topUpCheckoutEligibility(tx, { businessId: prepaid })).toBeNull();
      expect(await topUpCheckoutEligibility(tx, { businessId: await business(tx, { plan: "pro" }) })).toBe("top_up_not_sold_on_plan");
      const managed = await business(tx);
      await setManagedPlanInTransaction(tx, { businessId: managed });
      expect(await topUpCheckoutEligibility(tx, { businessId: managed })).toBe("managed_plan");
    });
  });

  it("starts the API's top-up checkout as the dashboard's, audited once, and keeps a pack's and a top-up's checkouts apart", async () => {
    await rollbackTest(async (tx) => {
      const sold = await topUpOnSale(tx);
      const pack = await packOnSale(tx);
      const businessId = await business(tx);
      const ownerId = await owner(tx, businessId);
      const generated = generateApiKey();
      const [key] = await tx.insert(apiKeys).values({ businessId, name: "billing", prefix: generated.prefix, keyHash: generated.keyHash, scopes: ["billing:manage"], createdByUserId: ownerId }).returning({ id: apiKeys.id });
      const caller: ApiKeyCaller = { businessId, apiKeyId: key!.id };
      const audited = async () => await tx.select({ entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "api.billing.top_up_checkout_started")));

      const checkout = await as(tx, "lobbystack_worker", (context) => createTopUpCheckoutForApi(context, caller, { top_up: sold.code, billing_email: "billing@example.invalid" }, { available: true }));
      expect(apiTopUpCheckoutSchema.safeParse(checkout).success).toBe(true);
      expect(checkout).toMatchObject({ top_up: sold.code, status: "pending", top_up_id: null, top_up_status: null, checkout_url: null, error: null, paid: false });
      expect(await audited()).toEqual([{ entityId: checkout.id, payload: expect.objectContaining({ topUp: sold.code, payerUserId: ownerId }) }]);
      const again = await as(tx, "lobbystack_worker", (context) => createTopUpCheckoutForApi(context, caller, { top_up: sold.code, billing_email: "billing@example.invalid" }, { available: true }));
      expect(again.id).toBe(checkout.id);
      expect(await audited()).toHaveLength(1);
      expect(await as(tx, "lobbystack_worker", (context) => getTopUpCheckoutForApi(context, caller, checkout.id))).toEqual(checkout);
      // A pack's checkout isn't a top-up's, nor the other way round.
      await expect(as(tx, "lobbystack_worker", (context) => getPackCheckoutForApi(context, caller, checkout.id))).rejects.toMatchObject({ status: 404, code: "not_found" });
      await tx.update(billingPackCheckouts).set({ status: "failed" }).where(eq(billingPackCheckouts.id, checkout.id));
      const packCheckout = await checkoutRow(tx, businessId, pack, { status: "pending" });
      await expect(as(tx, "lobbystack_worker", (context) => getTopUpCheckoutForApi(context, caller, packCheckout))).rejects.toMatchObject({ status: 404, code: "not_found" });

      // Refusals are the API's 409; a deployment that sells none says so first.
      await tx.update(billingAccounts).set({ plan: "starter", subscriptionId: `sub_${businessId}`, subscriptionState: "active", billingInterval: "monthly" }).where(eq(billingAccounts.businessId, businessId));
      await expect(as(tx, "lobbystack_worker", (context) => createTopUpCheckoutForApi(context, caller, { top_up: sold.code }, { available: true }))).rejects.toMatchObject({ status: 409, code: "conflict", message: expect.stringMatching(/^Top-ups are sold on Free and on prepaid packs\./) });
      await expect(as(tx, "lobbystack_worker", (context) => createTopUpCheckoutForApi(context, caller, { top_up: sold.code }, { available: false }))).rejects.toMatchObject({ status: 409, code: "conflict", message: expect.stringMatching(/^This deployment doesn't sell top-ups through /) });
    });
  });
});

describe.skipIf(!testUrl)("top-up payments against PostgreSQL", () => {
  it("adds a top-up once from a Stripe payment, names it on its checkout, and changes nothing else", async () => {
    await rollbackTest(async (tx) => {
      const sold = await topUpOnSale(tx);
      const businessId = await business(tx);
      const checkoutId = await checkoutRow(tx, businessId, sold);
      const paidAt = new Date(Date.now() - 5 * 60_000);
      const payload = stripeSession(businessId, sold, { paymentRef: "pi_top_up_1", checkoutId, occurredAt: paidAt });
      const before = await accountOf(tx, businessId);

      await expect(reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload }))).resolves.toBe("processed");
      const [topUp] = await topUpsOf(tx, businessId);
      expect(topUp).toMatchObject({ source: "purchase", offer: sold.code, priceId: sold.priceId, status: "active", provider: "stripe", providerRef: "pi_top_up_1", amountCents: 2_500, refundedCents: 0, currency: "cad", voiceSec: 6_000, smsSeg: 0, refundedAt: null });
      expect(topUp!.transactionId).not.toBeNull();
      expect(topUp!.startsAt.getTime()).toBe(paidAt.getTime());
      expect(topUp!.endsAt!.getTime() - paidAt.getTime()).toBe(90 * DAY);
      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId })).toMatchObject({ kind: "top_up", status: "paid", topUpId: topUp!.id, topUpStatus: "active", packStatus: null });
      // The plan, its allowances and its account stay as they were, and no pack was added.
      expect(await accountOf(tx, businessId)).toEqual(before);
      expect(await planInForce(tx, businessId)).toBe("free_cloud");
      expect(await tx.select({ id: billingPacks.id }).from(billingPacks).where(eq(billingPacks.businessId, businessId))).toEqual([]);
      // Its minutes and length are fixed now that a business bought it.
      const [catalogRow] = await tx.select({ frozenAt: billingPackPlans.frozenAt }).from(billingPackPlans).where(eq(billingPackPlans.code, sold.code));
      expect(catalogRow?.frozenAt).toBeInstanceOf(Date);
      const purchased = await tx.select({ entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "billing.top_up_purchased")));
      expect(purchased).toEqual([{ entityId: topUp!.id, payload: expect.objectContaining({ topUp: sold.code, provider: "stripe", providerRef: "pi_top_up_1", amountCents: 2_500, currency: "cad", voiceSec: 6_000, days: 90 }) }]);

      // The same payment delivered again adds nothing.
      await expect(reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.async_payment_succeeded", payload: { ...payload, id: `cs_${randomUUID()}` } }))).resolves.toBe("processed");
      expect(await topUpsOf(tx, businessId)).toHaveLength(1);
      expect(await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "billing.top_up_purchased")))).toHaveLength(1);
    });
  });

  it("takes a partial refund's share off the top-up and ends it on a full refund, matched on the payment", async () => {
    await rollbackTest(async (tx) => {
      const sold = await topUpOnSale(tx);
      const businessId = await business(tx);
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, sold, { paymentRef: "pi_top_up_refund_1" }) }));
      const refund = (refundedAmount: number) => ({ id: `ch_${randomUUID()}`, object: "charge", kind: "refund", paymentRef: "pi_top_up_refund_1", customerId: `cus_${businessId}`, amount: 2_500, refundedAmount, currency: "cad", status: refundedAmount >= 2_500 ? "refunded" : "partially_refunded", occurredAt: new Date().toISOString() });

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "charge.refunded", payload: refund(1_250) }), null);
      expect(await topUpsOf(tx, businessId)).toMatchObject([{ status: "active", refundedCents: 1_250, refundedAt: null }]);
      // Half the payment back, half the minutes left to use.
      expect(await shown(tx, businessId)).toEqual([{ status: "active", voiceSeconds: 3_000, refundedCents: 1_250 }]);

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "charge.refunded", payload: refund(2_500) }), null);
      const [ended] = await topUpsOf(tx, businessId);
      expect(ended).toMatchObject({ status: "refunded", refundedCents: 2_500 });
      expect(ended!.refundedAt).toBeInstanceOf(Date);
      expect(await shown(tx, businessId)).toEqual([{ status: "refunded", voiceSeconds: 0, refundedCents: 2_500 }]);
      // An older refund total arriving late takes nothing back.
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "charge.refunded", payload: refund(1_250) }), null);
      expect(await topUpsOf(tx, businessId)).toMatchObject([{ status: "refunded", refundedCents: 2_500 }]);
    });
  });

  it("freezes a top-up while its payment is disputed, gives it back when the dispute is won, and ends it when one is lost", async () => {
    await rollbackTest(async (tx) => {
      const sold = await topUpOnSale(tx);
      const businessId = await business(tx);
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, sold, { paymentRef: "pi_top_up_dispute_1" }) }));
      const dispute = (eventType: string, disputeOutcome: string) => store(tx, businessId, { eventType, payload: { id: `dp_${randomUUID()}`, kind: "dispute", paymentRef: "pi_top_up_dispute_1", disputeOutcome, occurredAt: new Date().toISOString() } });

      await expect(reconcile(tx, businessId, await dispute("charge.dispute.created", "opened"))).resolves.toBe("processed");
      expect(await shown(tx, businessId)).toMatchObject([{ status: "frozen" }]);
      await reconcile(tx, businessId, await dispute("charge.dispute.closed", "won"));
      expect(await shown(tx, businessId)).toMatchObject([{ status: "active" }]);
      // A lost dispute ends it even when its opening never arrived.
      await reconcile(tx, businessId, await dispute("charge.dispute.closed", "lost"));
      expect(await topUpsOf(tx, businessId)).toMatchObject([{ status: "refunded", refundedCents: 2_500 }]);
    });
  });

  it("adds a top-up from a Polar order for its product with the order's refunds", async () => {
    await rollbackTest(async (tx) => {
      // Polar names its products by uuid, which the link keeps as the price's provider_ref.
      const product = randomUUID();
      const sold = await topUpOnSale(tx, { priceRef: product });
      const businessId = await business(tx, { source: "polar" });
      const order = (status: string, refunded: number) => ({ kind: "payment", billingKey: `business:${businessId}`, id: "order_top_up_1", status, total_amount: 2_500, refunded_amount: refunded, refunded_tax_amount: 0, currency: "cad", created_at: new Date(Date.now() - 60_000).toISOString(), billing_reason: "purchase", productId: product, priceRef: product, metadata: {} });

      await expect(reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.paid", payload: order("paid", 0) }))).resolves.toBe("processed");
      expect(await topUpsOf(tx, businessId)).toMatchObject([{ source: "purchase", offer: sold.code, provider: "polar", providerRef: "order_top_up_1", amountCents: 2_500, status: "active" }]);
      await reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.refunded", payload: order("partially_refunded", 500) }));
      expect(await shown(tx, businessId)).toEqual([{ status: "active", voiceSeconds: 4_800, refundedCents: 500 }]);
      await reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.refunded", payload: order("refunded", 2_500) }));
      expect(await topUpsOf(tx, businessId)).toMatchObject([{ status: "refunded", refundedCents: 2_500 }]);
      expect(await planInForce(tx, businessId)).toBe("free_cloud");
    });
  });

  it("adds a top-up beside a live pack, which stays as it was", async () => {
    await rollbackTest(async (tx) => {
      const sold = await topUpOnSale(tx);
      const pack = await packOnSale(tx);
      const businessId = await business(tx);
      const packId = await livePack(tx, businessId, pack.code);

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, sold, { paymentRef: "pi_top_up_pack_1" }) }));
      expect(await topUpsOf(tx, businessId)).toMatchObject([{ status: "active", providerRef: "pi_top_up_pack_1" }]);
      const packs = await tx.select({ id: billingPacks.id, status: billingPacks.status, secondsTotal: billingPacks.secondsTotal }).from(billingPacks).where(eq(billingPacks.businessId, businessId));
      expect(packs).toEqual([{ id: packId, status: "active", secondsTotal: 30_000 }]);
      expect(await planInForce(tx, businessId)).toBe("prepaid");
    });
  });

  it("leaves a top-up's checkout open when a plan starts, closing only the packs', and adds its later payment on that plan", async () => {
    await rollbackTest(async (tx) => {
      const sold = await topUpOnSale(tx);
      const pack = await packOnSale(tx);
      const businessId = await business(tx);
      const topUpCheckout = await checkoutRow(tx, businessId, sold);
      const packCheckout = await checkoutRow(tx, businessId, pack, { terms: { voiceSec: 30_000, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1 } });

      const started = await store(tx, businessId, { eventType: "customer.subscription.created", payload: { kind: "subscription", customerId: `cus_${businessId}`, subscriptionId: "sub_top_up_open_1", plan: "starter", planCode: "starter", billingInterval: "monthly", subscriptionState: "active", subscriptionModifiedAt: new Date().toISOString() } });
      await expect(reconcile(tx, businessId, started)).resolves.toBe("processed");
      const rows = new Map((await tx.select({ id: billingPackCheckouts.id, status: billingPackCheckouts.status, error: billingPackCheckouts.error }).from(billingPackCheckouts).where(eq(billingPackCheckouts.businessId, businessId))).map((row) => [row.id, row]));
      expect(rows.get(packCheckout)).toMatchObject({ status: "expired", error: PACK_CHECKOUT_CLOSED_FOR_PLAN });
      expect(rows.get(topUpCheckout)).toMatchObject({ status: "ready", error: null });

      // Paid once the plan started, it adds to that plan as any top-up does, and the subscription stays.
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, sold, { paymentRef: "pi_top_up_late_1", checkoutId: topUpCheckout }) }));
      expect(await topUpsOf(tx, businessId)).toMatchObject([{ status: "active", providerRef: "pi_top_up_late_1" }]);
      expect(await accountOf(tx, businessId)).toMatchObject({ plan: "starter", subscriptionId: "sub_top_up_open_1" });
      expect(await planInForce(tx, businessId)).toBe("starter");
      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId: topUpCheckout })).toMatchObject({ status: "paid", topUpStatus: "active" });
    });
  });
});
