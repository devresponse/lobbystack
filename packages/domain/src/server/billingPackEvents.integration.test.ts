import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLogs, billingAccounts, billingPackCheckouts, billingPackPlans, billingPackPrices, billingPacks, billingTransactions, businesses, createDatabaseClient, outboxMessages, phoneNumbers, productEvents, providerEvents, users, withBusinessTransaction, type BillingPackCheckoutTerms, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { reconcileBillingProviderEvent } from "./billing";
import { readPackCheckoutInTransaction } from "./billingPackCheckout";
import { expireBusinessPacks } from "./billingPackExpiry";
import { PACK_CHECKOUT_CLOSED_FOR_PLAN, PACK_RECLAIM_REASON } from "./billingPacks";
import { loadBusinessPlanLimits } from "./usage";

// What the billing provider's events do to prepaid packs, against
// PostgreSQL and under the worker's role: a pack's payment on Stripe and on
// Polar, refunds and disputes of it, and decision 6's switch between a pack
// and a subscription in both directions. Events are stored as the webhook
// stores them (packages/providers/src/*/events.ts) and applied with
// reconcileBillingProviderEvent, as the billing.reconcile job does. Events
// about no pack are covered by the reconcile tests, which must pass unchanged.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Prepaid pack integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const DAY = 86_400_000;
const STRIPE_PRICE = "price_pack_events_test";
// Polar names its products by uuid, as LobbyStack names its price rows.
const POLAR_PRODUCT = randomUUID();

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

/** The packs this deployment sells: one linked to a Stripe price, one to a Polar product. */
async function catalog(tx: DatabaseTransaction) {
  const terms = { status: "active", names: { en: "Test pack", fr: "Test pack", es: "Test pack", sr: "Test pack" }, voiceSec: 15_000, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, termsHash: "0".repeat(64) };
  await tx.insert(billingPackPlans).values([{ code: "pack_events_stripe", ...terms }, { code: "pack_events_polar", ...terms, days: 180 }]).onConflictDoNothing();
  const [stripe] = await tx.insert(billingPackPrices).values({ pack: "pack_events_stripe", currency: "cad", cents: 5_500, providerRef: STRIPE_PRICE }).returning({ id: billingPackPrices.id });
  const [polar] = await tx.insert(billingPackPrices).values({ pack: "pack_events_polar", currency: "usd", cents: 9_900, providerRef: POLAR_PRODUCT }).returning({ id: billingPackPrices.id });
  return { stripePriceId: stripe!.id, polarPriceId: polar!.id };
}

type Account = { plan?: "free_cloud" | "starter"; state?: string; interval?: "monthly" | "annual"; subscriptionId?: string; replacedSubscriptionId?: string; source?: "stripe" | "polar"; telemetry?: boolean };

async function business(tx: DatabaseTransaction, account: Account = {}) {
  const businessId = randomUUID();
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Pack events test", timezone: "UTC", businessType: "test", telemetryEnabled: account.telemetry ?? false });
  await tx.insert(billingAccounts).values({
    businessId,
    billingKey: `business:${businessId}`,
    source: account.source ?? "stripe",
    customerId: `cus_${businessId}`,
    plan: account.plan ?? "free_cloud",
    subscriptionState: account.state ?? null,
    billingInterval: account.interval ?? null,
    subscriptionId: account.subscriptionId ?? null,
    replacedSubscriptionId: account.replacedSubscriptionId ?? null,
  });
  return businessId;
}

/**
 * A pack checkout the business asked for, a Stripe one unless it names a Polar
 * pack and checkout; createdAt is when it asked. A ready page by default; one
 * still being made has no page. terms are those it kept when it was asked for.
 */
async function packCheckout(tx: DatabaseTransaction, businessId: string, priceId: string, options: { pack?: string; providerCheckoutId?: string; createdAt?: Date; status?: "pending" | "processing" | "ready" | "paid"; expiresAt?: Date; terms?: BillingPackCheckoutTerms } = {}) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid` });
  const status = options.status ?? "ready";
  const page = status === "pending" || status === "processing" ? {} : { checkoutId: options.providerCheckoutId ?? `cs_${randomUUID()}`, checkoutUrl: "https://checkout.stripe.test/pay" };
  const [row] = await tx.insert(billingPackCheckouts).values({ businessId, requestedByUserId: userId, pack: options.pack ?? "pack_events_stripe", priceId, status, ...page, expiresAt: options.expiresAt ?? new Date(Date.now() + DAY), ...(options.createdAt ? { createdAt: options.createdAt } : {}), ...(options.terms ? { terms: options.terms } : {}) }).returning({ id: billingPackCheckouts.id });
  return row!.id;
}

/** Marks a subscription's first event processed at `at`, as the reconcile of its start would have left it. */
async function subscribedAt(tx: DatabaseTransaction, businessId: string, subscriptionId: string, at: Date, provider: "stripe" | "polar" = "stripe") {
  const id = await store(tx, businessId, { provider, eventType: provider === "polar" ? "subscription.active" : "customer.subscription.created", payload: { kind: "subscription", subscriptionId }, createdAt: at });
  await tx.update(providerEvents).set({ status: "processed" }).where(eq(providerEvents.id, id));
}

/** Stores an event as the webhook route does, for the business it named. */
async function store(tx: DatabaseTransaction, businessId: string, input: { provider?: "stripe" | "polar"; eventType: string; payload: Record<string, unknown>; createdAt?: Date }) {
  const [row] = await tx.insert(providerEvents).values({ provider: input.provider ?? "stripe", providerEventId: `evt_${randomUUID()}`, eventType: input.eventType, businessId, payload: input.payload, ...(input.createdAt ? { createdAt: input.createdAt } : {}) }).returning({ id: providerEvents.id });
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

/** A Stripe pack checkout session as stripe/events.ts stores it. */
function stripeSession(businessId: string, input: { outcome?: "paid" | "pending" | "failed" | "expired"; paymentRef?: string; checkoutId?: string; invoiceRef?: string; createdAt?: Date; occurredAt?: Date; amountCents?: number }) {
  const occurredAt = input.occurredAt ?? new Date();
  return {
    id: `cs_${randomUUID()}`,
    object: "checkout.session",
    created: Math.floor((input.createdAt ?? new Date(occurredAt.getTime() - 60_000)).getTime() / 1_000),
    metadata: { lobbystack_business: businessId, lobbystack_role: "pack", lobbystack_pack: "pack_events_stripe", ...(input.checkoutId ? { lobbystack_pack_checkout: input.checkoutId } : {}) },
    kind: "checkout",
    role: "pack",
    customerId: `cus_${businessId}`,
    ...(input.checkoutId ? { packCheckoutId: input.checkoutId } : {}),
    packCode: "pack_events_stripe",
    packPriceRef: STRIPE_PRICE,
    ...(input.paymentRef ? { paymentRef: input.paymentRef } : {}),
    ...(input.invoiceRef ? { invoiceRef: input.invoiceRef } : {}),
    packOutcome: input.outcome ?? "paid",
    amountCents: input.amountCents ?? 5_500,
    currency: "cad",
    occurredAt: occurredAt.toISOString(),
  };
}

async function packsOf(tx: DatabaseTransaction, businessId: string) {
  return await tx.select({ id: billingPacks.id, pack: billingPacks.pack, status: billingPacks.status, provider: billingPacks.provider, providerRef: billingPacks.providerRef, amountCents: billingPacks.amountCents, refundedCents: billingPacks.refundedCents, secondsTotal: billingPacks.secondsTotal, paidAt: billingPacks.paidAt, endsAt: billingPacks.endsAt, transactionId: billingPacks.transactionId, unusedSeconds: billingPacks.unusedSeconds, priceId: billingPacks.priceId })
    .from(billingPacks).where(eq(billingPacks.businessId, businessId)).orderBy(billingPacks.paidAt);
}

async function accountOf(tx: DatabaseTransaction, businessId: string) {
  const [row] = await tx.select({ subscriptionId: billingAccounts.subscriptionId, replacedSubscriptionId: billingAccounts.replacedSubscriptionId, allowancesSince: billingAccounts.allowancesSince, plan: billingAccounts.plan, subscriptionState: billingAccounts.subscriptionState }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId));
  return row!;
}

async function orderOf(tx: DatabaseTransaction, sourceId: string) {
  const [row] = await tx.select({ id: billingTransactions.id, status: billingTransactions.status, amountCents: billingTransactions.amountCents, refundedAmountCents: billingTransactions.refundedAmountCents }).from(billingTransactions).where(and(eq(billingTransactions.kind, "order"), eq(billingTransactions.sourceId, sourceId)));
  return row;
}

async function outbox(tx: DatabaseTransaction, businessId: string) {
  return await tx.select({ topic: outboxMessages.topic, dedupeKey: outboxMessages.dedupeKey, payload: outboxMessages.payload }).from(outboxMessages).where(eq(outboxMessages.businessId, businessId));
}

async function eventStatus(tx: DatabaseTransaction, id: string) {
  const [row] = await tx.select({ status: providerEvents.status }).from(providerEvents).where(eq(providerEvents.id, id));
  return row?.status;
}

/** Runs the daily expiry job's call for the business under the worker's own login, as the job does. */
async function runExpiry(tx: DatabaseTransaction, businessId: string) {
  await tx.execute(sql`set local session authorization lobbystack_worker`);
  try {
    return await expireBusinessPacks({ db: tx as unknown as Database }, { businessId, appUrl: "https://app.example.test" });
  } finally {
    await tx.execute(sql`reset session authorization`);
  }
}

/** A subscription event as stripe/events.ts stores it: Stripe's own object, with its start in seconds, under reconcile's names. */
function stripeSubscription(businessId: string, input: { subscriptionId: string; state?: string; startedAt: Date; eventAt: Date }) {
  const seconds = Math.floor(input.startedAt.getTime() / 1_000);
  return { id: input.subscriptionId, object: "subscription", created: seconds, start_date: seconds, status: input.state ?? "active", kind: "subscription", customerId: `cus_${businessId}`, subscriptionId: input.subscriptionId, plan: "starter", planCode: "starter", billingInterval: "monthly", subscriptionState: input.state ?? "active", subscriptionModifiedAt: input.eventAt.toISOString() };
}

async function auditsOf(tx: DatabaseTransaction, businessId: string, eventType: string) {
  return await tx.select({ entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, eventType)));
}

async function planInForce(tx: DatabaseTransaction, businessId: string) {
  await tx.execute(sql`set local role lobbystack_worker`);
  try {
    return (await withBusinessTransaction(tx as unknown as Database, { businessId, actorType: "worker" }, (scoped) => loadBusinessPlanLimits(scoped, businessId))).plan;
  } finally {
    await tx.execute(sql`reset role`);
  }
}

describe.skipIf(!testUrl)("prepaid pack events against PostgreSQL", () => {
  it("adds a pack once from a Stripe checkout paid through Stripe as merchant of record, with its order row on the payment, and starts its allowances from Free", async () => {
    await rollbackTest(async (tx) => {
      const { stripePriceId } = await catalog(tx);
      const businessId = await business(tx, { telemetry: true });
      const checkoutId = await packCheckout(tx, businessId, stripePriceId);
      const paidAt = new Date(Date.now() - 5 * 60_000);
      const payload = stripeSession(businessId, { paymentRef: "pi_mor_1", checkoutId, occurredAt: paidAt });
      const first = await store(tx, businessId, { eventType: "checkout.session.completed", payload });

      await expect(reconcile(tx, businessId, first)).resolves.toBe("processed");
      const [pack] = await packsOf(tx, businessId);
      expect(pack).toMatchObject({ pack: "pack_events_stripe", status: "active", provider: "stripe", providerRef: "pi_mor_1", amountCents: 5_500, refundedCents: 0, secondsTotal: 15_000, priceId: stripePriceId });
      expect(pack!.endsAt!.getTime() - pack!.paidAt.getTime()).toBe(90 * DAY);
      expect(pack!.paidAt.getTime()).toBe(paidAt.getTime());
      const order = await orderOf(tx, "pi_mor_1");
      expect(order).toMatchObject({ status: "paid", amountCents: 5_500, refundedAmountCents: 0 });
      expect(pack!.transactionId).toBe(order!.id);
      const [checkout] = await tx.select({ status: billingPackCheckouts.status }).from(billingPackCheckouts).where(eq(billingPackCheckouts.id, checkoutId));
      expect(checkout?.status).toBe("paid");
      expect((await accountOf(tx, businessId)).allowancesSince).toBeInstanceOf(Date);
      expect(await planInForce(tx, businessId)).toBe("prepaid");
      const topics = (await outbox(tx, businessId)).map((message) => message.topic);
      expect(topics).toContain("receptionists.enforceAllowance");
      expect(topics).toContain("realtime.publish");
      const [purchased] = await tx.select({ properties: productEvents.properties }).from(productEvents).where(and(eq(productEvents.businessId, businessId), eq(productEvents.name, "billing.pack_purchased")));
      expect(purchased?.properties).toMatchObject({ pack: "pack_events_stripe", days: "90", provider: "stripe", previousPlan: "free_cloud" });

      // Stripe sends the same payment again, as checkout.session.async_payment_succeeded would after a delay.
      const again = await store(tx, businessId, { eventType: "checkout.session.async_payment_succeeded", payload: { ...payload, id: `cs_${randomUUID()}` } });
      await expect(reconcile(tx, businessId, again)).resolves.toBe("processed");
      expect(await packsOf(tx, businessId)).toHaveLength(1);
    });
  });

  it("leaves the order row of a pack Stripe invoiced to the invoice's own events", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx);
      const [invoice] = await tx.insert(billingTransactions).values({ businessId, kind: "order", sourceId: "in_pack_1", orderId: "in_pack_1", status: "paid", amountCents: 5_500, refundedAmountCents: 0, currency: "cad", occurredAt: new Date(), lastSyncedAt: new Date() }).returning({ id: billingTransactions.id });
      const event = await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_direct_1", invoiceRef: "in_pack_1" }) });

      await reconcile(tx, businessId, event);
      const [pack] = await packsOf(tx, businessId);
      expect(pack).toMatchObject({ providerRef: "pi_direct_1", transactionId: invoice!.id });
      expect(await orderOf(tx, "pi_direct_1")).toBeUndefined();
    });
  });

  it("takes a partial refund's share off the pack and ends it on a full refund, matched on the payment", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx);
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_refund_1" }) }));
      const refund = (refundedAmount: number) => ({ id: `ch_${randomUUID()}`, object: "charge", kind: "refund", paymentRef: "pi_refund_1", customerId: `cus_${businessId}`, amount: 5_500, refundedAmount, currency: "cad", status: refundedAmount >= 5_500 ? "refunded" : "partially_refunded", occurredAt: new Date().toISOString() });

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "charge.refunded", payload: refund(2_750) }), null);
      let [pack] = await packsOf(tx, businessId);
      expect(pack).toMatchObject({ status: "active", refundedCents: 2_750 });
      expect(await orderOf(tx, "pi_refund_1")).toMatchObject({ status: "partially_refunded", refundedAmountCents: 2_750 });

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "charge.refunded", payload: refund(5_500) }), null);
      [pack] = await packsOf(tx, businessId);
      expect(pack).toMatchObject({ status: "refunded", refundedCents: 5_500, unusedSeconds: 0 });
      expect(await orderOf(tx, "pi_refund_1")).toMatchObject({ status: "refunded", refundedAmountCents: 5_500 });
      // The expiry job settles the ended pack: the number's release once no live pack is left.
      expect((await outbox(tx, businessId)).map((message) => message.dedupeKey)).toContain(`billing-pack:${pack!.id}:ended:run`);
      expect(await planInForce(tx, businessId)).toBe("free_cloud");
    });
  });

  it("ends a pack refunded in full when the refund arrived, not when the refunded charge was made", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx);
      const paidAt = new Date(Date.now() - 45 * DAY);
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_late_refund_1", occurredAt: paidAt }) }));
      // stripe/events.ts dates a charge.refunded event by the charge's own created time, which is the payment's.
      const refundedAt = new Date(Date.now() - 60_000);
      const refund = { id: `ch_${randomUUID()}`, object: "charge", kind: "refund", paymentRef: "pi_late_refund_1", customerId: `cus_${businessId}`, amount: 5_500, refundedAmount: 5_500, currency: "cad", status: "refunded", occurredAt: paidAt.toISOString() };
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "charge.refunded", payload: refund, createdAt: refundedAt }), null);

      // The expiry job sets the number to go 30 days after this, so a pack refunded on its 45th day keeps the number 30 more days.
      const [pack] = await tx.select({ status: billingPacks.status, endedAt: billingPacks.endedAt }).from(billingPacks).where(eq(billingPacks.businessId, businessId));
      expect(pack).toEqual({ status: "refunded", endedAt: refundedAt });
      // The payment's order row keeps the payment's time.
      const [order] = await tx.select({ status: billingTransactions.status, occurredAt: billingTransactions.occurredAt }).from(billingTransactions).where(and(eq(billingTransactions.kind, "order"), eq(billingTransactions.sourceId, "pi_late_refund_1")));
      expect(order).toEqual({ status: "refunded", occurredAt: paidAt });
    });
  });

  it("applies a refund that came before the pack's payment once the payment arrives", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx);
      const early = await store(tx, businessId, { eventType: "charge.refunded", payload: { id: "ch_early", kind: "refund", paymentRef: "pi_early_1", amount: 5_500, refundedAmount: 1_100, currency: "cad", status: "partially_refunded", occurredAt: new Date().toISOString() } });
      await expect(reconcile(tx, businessId, early, null)).resolves.toBe("processed");
      // No pack had the payment yet, so the refund wrote nothing.
      expect(await orderOf(tx, "pi_early_1")).toBeUndefined();

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_early_1" }) }));
      const [pack] = await packsOf(tx, businessId);
      expect(pack).toMatchObject({ status: "active", refundedCents: 1_100 });
      expect(await orderOf(tx, "pi_early_1")).toMatchObject({ status: "partially_refunded", refundedAmountCents: 1_100 });
    });
  });

  it("freezes a pack while its payment is disputed, gives it back when the dispute is won, and ends it when one is lost", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx);
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_dispute_1" }) }));
      const dispute = (eventType: string, disputeOutcome: string) => store(tx, businessId, { eventType, payload: { id: `dp_${randomUUID()}`, kind: "dispute", paymentRef: "pi_dispute_1", disputeOutcome, occurredAt: new Date().toISOString() } });

      await reconcile(tx, businessId, await dispute("charge.dispute.created", "opened"));
      expect((await packsOf(tx, businessId))[0]?.status).toBe("frozen");
      // A frozen pack isn't live: the business is on Free meanwhile.
      expect(await planInForce(tx, businessId)).toBe("free_cloud");
      await reconcile(tx, businessId, await dispute("charge.dispute.closed", "won"));
      expect((await packsOf(tx, businessId))[0]?.status).toBe("active");

      // A lost dispute ends the pack even when its opening never arrived.
      await reconcile(tx, businessId, await dispute("charge.dispute.closed", "lost"));
      expect((await packsOf(tx, businessId))[0]).toMatchObject({ status: "refunded", refundedCents: 5_500 });
    });
  });

  it("keeps a pack live when a dispute's close was applied before its opening, and still freezes it for a later dispute of the same payment", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx);
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_dispute_order_1" }) }));
      const dispute = (eventType: string, disputeId: string, status: string, disputeOutcome: string) => store(tx, businessId, { eventType, payload: { id: disputeId, object: "dispute", kind: "dispute", paymentRef: "pi_dispute_order_1", status, disputeOutcome, occurredAt: new Date().toISOString() } });

      // An inquiry the bank closed without a chargeback, its close applied first.
      const inquiry = `dp_${randomUUID()}`;
      await expect(reconcile(tx, businessId, await dispute("charge.dispute.closed", inquiry, "warning_closed", "won"))).resolves.toBe("processed");
      await expect(reconcile(tx, businessId, await dispute("charge.dispute.created", inquiry, "warning_needs_response", "opened"))).resolves.toBe("processed");
      expect((await packsOf(tx, businessId))[0]?.status).toBe("active");
      expect(await planInForce(tx, businessId)).toBe("prepaid");

      // A chargeback on the same payment is a dispute of its own, which the inquiry's close says nothing about.
      await reconcile(tx, businessId, await dispute("charge.dispute.created", `dp_${randomUUID()}`, "needs_response", "opened"));
      expect((await packsOf(tx, businessId))[0]?.status).toBe("frozen");
    });
  });

  it("marks a live monthly subscription replaced when a pack's payment arrives, starts the pack's allowances and queues the job that ends it at the provider", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx, { plan: "starter", state: "active", interval: "monthly", subscriptionId: "sub_monthly_1" });
      await store(tx, businessId, { eventType: "customer.subscription.created", payload: { kind: "subscription", subscriptionId: "sub_monthly_1" }, createdAt: new Date(Date.now() - 30 * DAY) }).then((id) => tx.update(providerEvents).set({ status: "processed" }).where(eq(providerEvents.id, id)));

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_switch_1" }) }));
      const account = await accountOf(tx, businessId);
      // The plan and its subscription stay as Stripe reports them, so no later event reads as a new start.
      expect(account).toMatchObject({ plan: "starter", subscriptionState: "active", subscriptionId: "sub_monthly_1", replacedSubscriptionId: "sub_monthly_1" });
      expect(account.allowancesSince).toBeInstanceOf(Date);
      expect(await planInForce(tx, businessId)).toBe("prepaid");
      const [pack] = await packsOf(tx, businessId);
      const end = (await outbox(tx, businessId)).find((message) => message.topic === "billing.endPlanForPack");
      expect(end).toMatchObject({ dedupeKey: "end-plan-for-pack:sub_monthly_1", payload: { subscriptionId: "sub_monthly_1", packId: pack!.id } });

      // Stripe's read-back still shows the subscription live until the end lands: it starts nothing and gets no overage.
      const later = await store(tx, businessId, { eventType: "customer.subscription.updated", payload: { kind: "subscription", subscriptionId: "sub_monthly_1", customerId: `cus_${businessId}`, plan: "starter", planCode: "starter", billingInterval: "monthly", subscriptionState: "active", subscriptionModifiedAt: new Date().toISOString() } });
      await expect(reconcile(tx, businessId, later)).resolves.toBe("processed");
      expect((await packsOf(tx, businessId))[0]?.status).toBe("active");
      expect((await outbox(tx, businessId)).map((message) => message.topic)).not.toContain("billing.ensureOverage");
      expect(await planInForce(tx, businessId)).toBe("prepaid");
    });
  });

  it("leaves a yearly or past-due subscription in force and keeps the pack beside it", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      for (const [index, account] of ([{ interval: "annual", state: "active" }, { interval: "monthly", state: "past_due" }] as const).entries()) {
        const businessId = await business(tx, { plan: "starter", state: account.state, interval: account.interval, subscriptionId: `sub_beside_${index}` });
        await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: `pi_beside_${index}` }) }));
        expect((await accountOf(tx, businessId)).replacedSubscriptionId).toBeNull();
        expect((await packsOf(tx, businessId))[0]?.status).toBe("active");
        expect(await planInForce(tx, businessId)).toBe("starter");
        expect((await outbox(tx, businessId)).map((message) => message.topic)).not.toContain("billing.endPlanForPack");
      }
    });
  });

  it("lets the pack give way when the business subscribed after it started buying the pack", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx, { plan: "starter", state: "active", interval: "monthly", subscriptionId: "sub_after_1" });
      const startedBuying = new Date(Date.now() - 2 * DAY);
      await store(tx, businessId, { eventType: "customer.subscription.created", payload: { kind: "subscription", subscriptionId: "sub_after_1" }, createdAt: new Date(Date.now() - DAY) }).then((id) => tx.update(providerEvents).set({ status: "processed" }).where(eq(providerEvents.id, id)));

      // A payment that settled days after the checkout, once the business had subscribed.
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.async_payment_succeeded", payload: stripeSession(businessId, { paymentRef: "pi_after_1", createdAt: startedBuying }) }));
      expect((await packsOf(tx, businessId))[0]?.status).toBe("replaced");
      expect((await accountOf(tx, businessId)).replacedSubscriptionId).toBeNull();
      expect(await planInForce(tx, businessId)).toBe("starter");
    });
  });

  it("ends the live packs when a subscription starts, starts its allowances, and keeps a number a pack's end set to go", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx, { source: "polar" });
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_then_plan_1" }) }));
      await tx.insert(phoneNumbers).values({ businessId, e164: "+15815550190", status: "active", reclaimScheduledAt: new Date(Date.now() + 20 * DAY), reclaimReason: PACK_RECLAIM_REASON });
      const before = (await accountOf(tx, businessId)).allowancesSince!;

      const started = await store(tx, businessId, { provider: "polar", eventType: "subscription.active", payload: { kind: "subscription", billingKey: `business:${businessId}`, subscriptionId: "sub_polar_1", plan: "starter", planCode: "starter", billingInterval: "monthly", subscriptionState: "active", subscriptionModifiedAt: new Date().toISOString() } });
      await expect(reconcile(tx, businessId, started)).resolves.toBe("processed");
      const [pack] = await packsOf(tx, businessId);
      expect(pack).toMatchObject({ status: "replaced", unusedSeconds: 15_000 });
      const account = await accountOf(tx, businessId);
      expect(account).toMatchObject({ plan: "starter", subscriptionState: "active", subscriptionId: "sub_polar_1" });
      expect(account.allowancesSince!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(await planInForce(tx, businessId)).toBe("starter");
      const [number] = await tx.select({ reclaimScheduledAt: phoneNumbers.reclaimScheduledAt, reclaimReason: phoneNumbers.reclaimReason }).from(phoneNumbers).where(eq(phoneNumbers.businessId, businessId));
      expect(number).toEqual({ reclaimScheduledAt: null, reclaimReason: null });
    });
  });

  it("counts a new subscription bought while the one a pack replaced is still being ended as a start, which ends the packs", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx, { plan: "starter", state: "active", interval: "monthly", subscriptionId: "sub_old_1", replacedSubscriptionId: "sub_old_1" });
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_old_1" }) }));
      expect((await packsOf(tx, businessId))[0]?.status).toBe("active");

      const fresh = await store(tx, businessId, { eventType: "customer.subscription.created", payload: { kind: "subscription", customerId: `cus_${businessId}`, subscriptionId: "sub_new_1", plan: "pro", planCode: "pro", billingInterval: "monthly", subscriptionState: "active", subscriptionModifiedAt: new Date().toISOString() } });
      await reconcile(tx, businessId, fresh);
      expect((await packsOf(tx, businessId))[0]?.status).toBe("replaced");
      expect(await accountOf(tx, businessId)).toMatchObject({ subscriptionId: "sub_new_1", plan: "pro" });
      expect(await planInForce(tx, businessId)).toBe("pro");
    });
  });

  it("finds a Stripe pack by LobbyStack's own price id, which the worker puts on the payment, when it names no pack checkout", async () => {
    await rollbackTest(async (tx) => {
      const { stripePriceId } = await catalog(tx);
      const businessId = await business(tx);
      // The price id is a uuid, as a Polar product's is, but on Stripe it names LobbyStack's own row. The code names no pack, so only the price can.
      const payload = { ...stripeSession(businessId, { paymentRef: "pi_own_price_1" }), packCode: "pack_missing", packPriceRef: stripePriceId };
      await expect(reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload }))).resolves.toBe("processed");
      expect(await packsOf(tx, businessId)).toMatchObject([{ pack: "pack_events_stripe", providerRef: "pi_own_price_1", status: "active", priceId: stripePriceId }]);
    });
  });

  it("adds a pack from a Polar order for a pack's product with the order's refunds, and leaves orders for other products alone", async () => {
    await rollbackTest(async (tx) => {
      const { polarPriceId } = await catalog(tx);
      const businessId = await business(tx, { source: "polar" });
      const order = (id: string, status: string, refunded: number, product = POLAR_PRODUCT) => ({ kind: "payment", billingKey: `business:${businessId}`, id, status, total_amount: 10_890, refunded_amount: refunded, refunded_tax_amount: 0, currency: "usd", created_at: new Date(Date.now() - 60_000).toISOString(), billing_reason: "purchase", productId: product, priceRef: product, metadata: {} });

      await expect(reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.paid", payload: order("order_pack_1", "paid", 0) }))).resolves.toBe("processed");
      let [pack] = await packsOf(tx, businessId);
      const row = await orderOf(tx, "order_pack_1");
      expect(pack).toMatchObject({ pack: "pack_events_polar", provider: "polar", providerRef: "order_pack_1", amountCents: 10_890, status: "active", transactionId: row!.id, priceId: polarPriceId });
      expect(pack!.endsAt!.getTime() - pack!.paidAt.getTime()).toBe(180 * DAY);

      // Polar reports a partial refund on the order, with its whole refunded amount so far.
      await reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.refunded", payload: order("order_pack_1", "partially_refunded", 3_630) }));
      [pack] = await packsOf(tx, businessId);
      expect(pack).toMatchObject({ status: "active", refundedCents: 3_630 });

      await reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.refunded", payload: order("order_pack_1", "refunded", 10_890) }));
      [pack] = await packsOf(tx, businessId);
      expect(pack).toMatchObject({ status: "refunded", refundedCents: 10_890 });

      // A refund that arrives first still adds the pack, and ends it.
      await reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.refunded", payload: order("order_pack_2", "refunded", 10_890) }));
      expect((await packsOf(tx, businessId)).find((entry) => entry.providerRef === "order_pack_2")).toMatchObject({ status: "refunded" });

      // So does a partial refund, which takes its share off.
      await reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.refunded", payload: order("order_pack_3", "partially_refunded", 3_630) }));
      expect((await packsOf(tx, businessId)).find((entry) => entry.providerRef === "order_pack_3")).toMatchObject({ status: "active", refundedCents: 3_630, priceId: polarPriceId });

      // A price retired since the checkout keeps its product, so an order at it still finds the pack.
      await tx.update(billingPackPrices).set({ retiredAt: new Date() }).where(eq(billingPackPrices.id, polarPriceId));
      await reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.paid", payload: order("order_pack_4", "paid", 0) }));
      expect((await packsOf(tx, businessId)).find((entry) => entry.providerRef === "order_pack_4")).toMatchObject({ status: "active", priceId: polarPriceId });

      await reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.paid", payload: order("order_plan_1", "paid", 0, randomUUID()) }));
      expect((await packsOf(tx, businessId)).map((entry) => entry.providerRef)).toEqual(["order_pack_1", "order_pack_2", "order_pack_3", "order_pack_4"]);
    });
  });

  it("orders a Polar pack against a subscription from when the business asked for its checkout, as Stripe does from its session", async () => {
    await rollbackTest(async (tx) => {
      const { polarPriceId } = await catalog(tx);
      const askedAt = new Date(Date.now() - 2 * 60 * 60_000);
      // A monthly Starter business whose subscription began at subscribedAt pays for a pack it asked for at askedAt.
      // The order names its pack checkout in its metadata, or only Polar's checkout.
      const buyPack = async (subscribedAt: Date, names: "metadata" | "checkout") => {
        const subscriptionId = `sub_${randomUUID()}`;
        const businessId = await business(tx, { source: "polar", plan: "starter", state: "active", interval: "monthly", subscriptionId });
        const providerCheckoutId = randomUUID();
        const checkoutId = await packCheckout(tx, businessId, polarPriceId, { pack: "pack_events_polar", providerCheckoutId, createdAt: askedAt });
        await store(tx, businessId, { provider: "polar", eventType: "subscription.active", payload: { kind: "subscription", subscriptionId }, createdAt: subscribedAt }).then((id) => tx.update(providerEvents).set({ status: "processed" }).where(eq(providerEvents.id, id)));
        const payload = { kind: "payment", billingKey: `business:${businessId}`, id: `order_${randomUUID()}`, status: "paid", total_amount: 10_890, refunded_amount: 0, refunded_tax_amount: 0, currency: "usd", created_at: new Date(Date.now() - 60_000).toISOString(), billing_reason: "purchase", productId: POLAR_PRODUCT, priceRef: POLAR_PRODUCT, ...(names === "metadata" ? { metadata: { lobbystack_pack_checkout: checkoutId } } : { metadata: {}, checkout_id: providerCheckoutId }) };
        await expect(reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.paid", payload }))).resolves.toBe("processed");
        const [checkout] = await tx.select({ status: billingPackCheckouts.status }).from(billingPackCheckouts).where(eq(billingPackCheckouts.id, checkoutId));
        expect(checkout?.status).toBe("paid");
        return { businessId, subscriptionId };
      };

      // Subscribed in another tab while the pack's payment page was open: the subscription is the later choice.
      for (const names of ["metadata", "checkout"] as const) {
        const { businessId } = await buyPack(new Date(Date.now() - 60 * 60_000), names);
        expect((await packsOf(tx, businessId))[0]?.status).toBe("replaced");
        expect((await accountOf(tx, businessId)).replacedSubscriptionId).toBeNull();
        expect(await planInForce(tx, businessId)).toBe("starter");
        expect((await outbox(tx, businessId)).map((message) => message.topic)).not.toContain("billing.endPlanForPack");
      }

      // Subscribed before it asked for the pack: the pack replaces the subscription.
      const { businessId, subscriptionId } = await buyPack(new Date(Date.now() - 30 * DAY), "metadata");
      expect((await packsOf(tx, businessId))[0]?.status).toBe("active");
      expect((await accountOf(tx, businessId)).replacedSubscriptionId).toBe(subscriptionId);
      expect(await planInForce(tx, businessId)).toBe("prepaid");
      expect((await outbox(tx, businessId)).map((message) => message.topic)).toContain("billing.endPlanForPack");
    });
  });

  it("records a pack checkout that expired or whose payment failed, and never moves a paid one back", async () => {
    await rollbackTest(async (tx) => {
      const { stripePriceId } = await catalog(tx);
      const businessId = await business(tx);
      const expiring = await packCheckout(tx, businessId, stripePriceId);
      const failing = await packCheckout(tx, businessId, stripePriceId);
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.expired", payload: stripeSession(businessId, { outcome: "expired", checkoutId: expiring }) }));
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.async_payment_failed", payload: stripeSession(businessId, { outcome: "failed", checkoutId: failing, paymentRef: "pi_failed_1" }) }));
      const rows = await tx.select({ id: billingPackCheckouts.id, status: billingPackCheckouts.status, error: billingPackCheckouts.error }).from(billingPackCheckouts).where(eq(billingPackCheckouts.businessId, businessId));
      expect(rows.find((row) => row.id === expiring)).toMatchObject({ status: "expired", error: null });
      expect(rows.find((row) => row.id === failing)).toMatchObject({ status: "failed", error: "The payment didn't go through." });
      expect(await packsOf(tx, businessId)).toHaveLength(0);

      await tx.update(billingPackCheckouts).set({ status: "paid" }).where(eq(billingPackCheckouts.id, expiring));
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.expired", payload: stripeSession(businessId, { outcome: "expired", checkoutId: expiring }) }));
      const [paid] = await tx.select({ status: billingPackCheckouts.status }).from(billingPackCheckouts).where(eq(billingPackCheckouts.id, expiring));
      expect(paid?.status).toBe("paid");
    });
  });

  it("leaves a paid pack's event to retry when it names nothing the catalog sells", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const payload = { ...stripeSession(businessId, { paymentRef: "pi_unknown_1" }), packCode: "pack_missing", packPriceRef: "price_missing" };
      const event = await store(tx, businessId, { eventType: "checkout.session.completed", payload });
      await tx.execute(sql`savepoint unknown_pack`);
      await expect(reconcile(tx, businessId, event)).rejects.toThrow("names no pack in the catalog");
      await tx.execute(sql`rollback to savepoint unknown_pack`);
      expect(await eventStatus(tx, event)).toBe("received");
      expect(await packsOf(tx, businessId)).toHaveLength(0);
    });
  });

  it("adds a pack whose payment was refunded in full before it arrived as ended, and leaves the plan, its allowances and the number as they were", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      // A monthly Starter business subscribed long before, and a Free one whose number a pack's end set to go.
      const starter = await business(tx, { plan: "starter", state: "active", interval: "monthly", subscriptionId: "sub_refund_first_1", telemetry: true });
      await subscribedAt(tx, starter, "sub_refund_first_1", new Date(Date.now() - 30 * DAY));
      const free = await business(tx, { telemetry: true });
      await tx.insert(phoneNumbers).values({ businessId: free, e164: "+15815550191", status: "active", reclaimScheduledAt: new Date(Date.now() + 20 * DAY), reclaimReason: PACK_RECLAIM_REASON });

      for (const [businessId, paymentRef] of [[starter, "pi_refund_first_1"], [free, "pi_refund_first_2"]] as const) {
        // Stripe's refund is applied before the payment's own event, when no pack has the payment yet.
        const refund = { id: `ch_${randomUUID()}`, kind: "refund", paymentRef, amount: 5_500, refundedAmount: 5_500, currency: "cad", status: "refunded", occurredAt: new Date().toISOString() };
        await expect(reconcile(tx, businessId, await store(tx, businessId, { eventType: "charge.refunded", payload: refund }), null)).resolves.toBe("processed");
        await expect(reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef }) }))).resolves.toBe("processed");
        const [pack] = await packsOf(tx, businessId);
        expect(pack).toMatchObject({ status: "refunded", refundedCents: 5_500, unusedSeconds: 0 });
        // The expiry job settles it as any ended pack, and nothing switches or reports a purchase.
        const messages = await outbox(tx, businessId);
        expect(messages.map((message) => message.dedupeKey)).toContain(`billing-pack:${pack!.id}:ended:run`);
        expect(messages.map((message) => message.topic)).not.toContain("billing.endPlanForPack");
        const purchased = await tx.select({ id: productEvents.id }).from(productEvents).where(and(eq(productEvents.businessId, businessId), eq(productEvents.name, "billing.pack_purchased")));
        expect(purchased).toEqual([]);
      }
      expect(await accountOf(tx, starter)).toMatchObject({ plan: "starter", subscriptionState: "active", subscriptionId: "sub_refund_first_1", replacedSubscriptionId: null, allowancesSince: null });
      expect(await planInForce(tx, starter)).toBe("starter");
      expect((await accountOf(tx, free)).allowancesSince).toBeNull();
      expect(await planInForce(tx, free)).toBe("free_cloud");
      const [number] = await tx.select({ reclaimReason: phoneNumbers.reclaimReason }).from(phoneNumbers).where(eq(phoneNumbers.businessId, free));
      expect(number?.reclaimReason).toBe(PACK_RECLAIM_REASON);
    });
  });

  it("starts no number's release from a pack whose payment went back before it arrived, which was never in force", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      // A Free business still holding the number its lapsed plan had, which answers calls.
      const businessId = await business(tx);
      await tx.insert(phoneNumbers).values({ businessId, e164: "+15815550192", status: "active" });
      const refund = { id: `ch_${randomUUID()}`, kind: "refund", paymentRef: "pi_never_held_1", amount: 5_500, refundedAmount: 5_500, currency: "cad", status: "refunded", occurredAt: new Date().toISOString() };
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "charge.refunded", payload: refund }), null);
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_never_held_1" }) }));
      const [pack] = await tx.select({ status: billingPacks.status, notices: billingPacks.notices }).from(billingPacks).where(eq(billingPacks.businessId, businessId));
      expect(pack).toEqual({ status: "refunded", notices: ["ended"] });

      // The run the refund queued, or the daily one, settles nothing and leaves the number answering.
      await expect(runExpiry(tx, businessId)).resolves.toMatchObject({ settled: 0, releaseAt: null });
      const [number] = await tx.select({ reclaimScheduledAt: phoneNumbers.reclaimScheduledAt, reclaimReason: phoneNumbers.reclaimReason }).from(phoneNumbers).where(eq(phoneNumbers.businessId, businessId));
      expect(number).toEqual({ reclaimScheduledAt: null, reclaimReason: null });
      expect(await auditsOf(tx, businessId, "billing.pack_number_release_set")).toEqual([]);
    });
  });

  it("adds a pack whose dispute was lost before its payment arrived as ended, and leaves the subscription in force", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx, { plan: "starter", state: "active", interval: "monthly", subscriptionId: "sub_lost_first_1" });
      await subscribedAt(tx, businessId, "sub_lost_first_1", new Date(Date.now() - 30 * DAY));
      const lost = { id: `dp_${randomUUID()}`, object: "dispute", kind: "dispute", paymentRef: "pi_lost_first_1", status: "lost", disputeOutcome: "lost", occurredAt: new Date().toISOString() };
      await expect(reconcile(tx, businessId, await store(tx, businessId, { eventType: "charge.dispute.closed", payload: lost }))).resolves.toBe("processed");

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_lost_first_1" }) }));
      expect((await packsOf(tx, businessId))[0]).toMatchObject({ status: "refunded", refundedCents: 5_500 });
      expect(await accountOf(tx, businessId)).toMatchObject({ replacedSubscriptionId: null, allowancesSince: null });
      expect(await planInForce(tx, businessId)).toBe("starter");
      expect((await outbox(tx, businessId)).map((message) => message.topic)).not.toContain("billing.endPlanForPack");
    });
  });

  it("adds a Polar pack whose order was refunded in full before its paid event as ended, and leaves the subscription in force", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const subscriptionId = `sub_${randomUUID()}`;
      const businessId = await business(tx, { source: "polar", plan: "starter", state: "active", interval: "monthly", subscriptionId });
      await subscribedAt(tx, businessId, subscriptionId, new Date(Date.now() - 30 * DAY), "polar");
      const order = (status: string, refunded: number) => ({ kind: "payment", billingKey: `business:${businessId}`, id: "order_refunded_first_1", status, total_amount: 10_890, refunded_amount: refunded, refunded_tax_amount: 0, currency: "usd", created_at: new Date(Date.now() - 60_000).toISOString(), billing_reason: "purchase", productId: POLAR_PRODUCT, priceRef: POLAR_PRODUCT, metadata: {} });

      await expect(reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.refunded", payload: order("refunded", 10_890) }))).resolves.toBe("processed");
      expect(await packsOf(tx, businessId)).toMatchObject([{ status: "refunded", refundedCents: 10_890 }]);
      // The order's paid event, delivered after, changes nothing.
      await reconcile(tx, businessId, await store(tx, businessId, { provider: "polar", eventType: "order.paid", payload: order("paid", 0) }));
      expect(await packsOf(tx, businessId)).toMatchObject([{ status: "refunded", refundedCents: 10_890 }]);
      expect(await accountOf(tx, businessId)).toMatchObject({ subscriptionId, replacedSubscriptionId: null, allowancesSince: null });
      expect(await planInForce(tx, businessId)).toBe("starter");
      expect((await outbox(tx, businessId)).map((message) => message.topic)).not.toContain("billing.endPlanForPack");
    });
  });

  it("reports a pack that gave way to a plan with the payment to refund, and names it on its checkout", async () => {
    await rollbackTest(async (tx) => {
      const { stripePriceId } = await catalog(tx);
      const businessId = await business(tx, { plan: "starter", state: "active", interval: "monthly", subscriptionId: "sub_gave_way_1", telemetry: true });
      const startedBuying = new Date(Date.now() - 2 * DAY);
      const checkoutId = await packCheckout(tx, businessId, stripePriceId, { createdAt: startedBuying });
      await subscribedAt(tx, businessId, "sub_gave_way_1", new Date(Date.now() - DAY));

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.async_payment_succeeded", payload: stripeSession(businessId, { paymentRef: "pi_gave_way_1", checkoutId, createdAt: startedBuying }) }));
      const [pack] = await packsOf(tx, businessId);
      expect(pack).toMatchObject({ status: "replaced", unusedSeconds: 15_000 });
      expect(await planInForce(tx, businessId)).toBe("starter");
      const audits = await tx.select({ eventType: auditLogs.eventType, entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs).where(eq(auditLogs.businessId, businessId));
      expect(audits).toContainEqual({ eventType: "billing.pack_gave_way", entityId: pack!.id, payload: { pack: "pack_events_stripe", provider: "stripe", providerRef: "pi_gave_way_1", amountCents: 5_500, currency: "cad", subscriptionId: "sub_gave_way_1" } });
      expect(audits).toContainEqual({ eventType: "billing.pack_replaced", entityId: pack!.id, payload: { pack: "pack_events_stripe", unusedSeconds: 15_000 } });
      const [reported] = await tx.select({ properties: productEvents.properties }).from(productEvents).where(and(eq(productEvents.businessId, businessId), eq(productEvents.name, "ops.billing.pack_gave_way")));
      expect(reported?.properties).toMatchObject({ provider: "stripe", pack: "pack_events_stripe", providerRef: "pi_gave_way_1", amountCents: 5_500, currency: "cad" });
      // The checkout names the pack, so the page waiting on it says the pack gave way rather than that it was added.
      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId })).toMatchObject({ status: "paid", packStatus: "replaced" });
    });
  });

  it("reports a pack paid after a plan started when the plan's start is applied after the pack, and not one paid before it", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const now = Date.now();
      // Both businesses were on Free and bought Starter at Stripe 90 minutes ago, whose events LobbyStack applies only now.
      const subscriptionStart = new Date(now - 90 * 60_000);
      const late = await business(tx, { telemetry: true });
      const early = await business(tx, { telemetry: true });
      // One paid its pack after subscribing, on a page opened before; the other paid it before subscribing.
      for (const [businessId, paymentRef, paidAt] of [[late, "pi_paid_after_plan_1", new Date(now - 60 * 60_000)], [early, "pi_paid_before_plan_1", new Date(now - 2 * 60 * 60_000)]] as const) {
        await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef, occurredAt: paidAt, createdAt: new Date(now - 3 * 60 * 60_000) }) }));
        // Applied first, the pack finds Free and goes live.
        expect((await packsOf(tx, businessId))[0]?.status).toBe("active");
        // The first of the plan's events LobbyStack applies is a later update of it.
        const update = stripeSubscription(businessId, { subscriptionId: `sub_${paymentRef}`, startedAt: subscriptionStart, eventAt: new Date(now - 60_000) });
        await expect(reconcile(tx, businessId, await store(tx, businessId, { eventType: "customer.subscription.updated", payload: update }))).resolves.toBe("processed");
        expect((await packsOf(tx, businessId))[0]).toMatchObject({ status: "replaced", unusedSeconds: 15_000 });
        expect(await planInForce(tx, businessId)).toBe("starter");
      }
      const [lateReport] = await auditsOf(tx, late, "billing.pack_gave_way");
      expect(lateReport?.payload).toEqual({ pack: "pack_events_stripe", provider: "stripe", providerRef: "pi_paid_after_plan_1", amountCents: 5_500, currency: "cad", subscriptionId: "sub_pi_paid_after_plan_1" });
      const [reported] = await tx.select({ properties: productEvents.properties }).from(productEvents).where(and(eq(productEvents.businessId, late), eq(productEvents.name, "ops.billing.pack_gave_way")));
      expect(reported?.properties).toMatchObject({ provider: "stripe", providerRef: "pi_paid_after_plan_1", amountCents: 5_500, currency: "cad" });
      // A pack bought before the plan ends as decision 6 says, its minutes lost and nothing to refund.
      expect(await auditsOf(tx, early, "billing.pack_gave_way")).toEqual([]);
      expect(await auditsOf(tx, early, "billing.pack_replaced")).toHaveLength(1);
    });
  });

  it("ends a pack at once, and keeps the plan, when the subscription it found was unpaid as the business started buying and was paid since", async () => {
    await rollbackTest(async (tx) => {
      const { stripePriceId } = await catalog(tx);
      const businessId = await business(tx, { plan: "starter", state: "active", interval: "monthly", subscriptionId: "sub_restarted_1", telemetry: true });
      const snapshot = async (state: string, at: Date) => {
        const id = await store(tx, businessId, { eventType: "customer.subscription.updated", payload: { kind: "subscription", subscriptionId: "sub_restarted_1", subscriptionState: state }, createdAt: at });
        await tx.update(providerEvents).set({ status: "processed" }).where(eq(providerEvents.id, id));
      };
      // Subscribed two months ago, unpaid for weeks, then paid again yesterday, while the pack's bank debit cleared.
      await snapshot("active", new Date(Date.now() - 60 * DAY));
      await snapshot("unpaid", new Date(Date.now() - 10 * DAY));
      const startedBuying = new Date(Date.now() - 2 * DAY);
      const checkoutId = await packCheckout(tx, businessId, stripePriceId, { createdAt: startedBuying });
      await snapshot("active", new Date(Date.now() - DAY));

      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.async_payment_succeeded", payload: stripeSession(businessId, { paymentRef: "pi_restarted_1", checkoutId, createdAt: startedBuying }) }));
      expect((await packsOf(tx, businessId))[0]).toMatchObject({ status: "replaced" });
      expect(await accountOf(tx, businessId)).toMatchObject({ subscriptionId: "sub_restarted_1", replacedSubscriptionId: null });
      expect(await planInForce(tx, businessId)).toBe("starter");
      expect((await outbox(tx, businessId)).map((message) => message.topic)).not.toContain("billing.endPlanForPack");
      expect(await auditsOf(tx, businessId, "billing.pack_gave_way")).toHaveLength(1);
    });
  });

  it("closes the business's open pack checkouts when a subscription starts, and asks the provider to close a page already made", async () => {
    await rollbackTest(async (tx) => {
      const { stripePriceId } = await catalog(tx);
      const businessId = await business(tx);
      const ready = await packCheckout(tx, businessId, stripePriceId, { providerCheckoutId: "cs_open_page_1" });
      const pending = await packCheckout(tx, businessId, stripePriceId, { status: "pending" });
      const processing = await packCheckout(tx, businessId, stripePriceId, { status: "processing" });
      const lapsed = await packCheckout(tx, businessId, stripePriceId, { expiresAt: new Date(Date.now() - 60_000) });
      // A page whose job claimed it late, still being made past its request's 15 minutes.
      const lateProcessing = await packCheckout(tx, businessId, stripePriceId, { status: "processing", expiresAt: new Date(Date.now() - 60_000) });
      const paid = await packCheckout(tx, businessId, stripePriceId, { status: "paid" });

      const started = await store(tx, businessId, { eventType: "customer.subscription.created", payload: { kind: "subscription", customerId: `cus_${businessId}`, subscriptionId: "sub_close_pages_1", plan: "starter", planCode: "starter", billingInterval: "monthly", subscriptionState: "active", subscriptionModifiedAt: new Date().toISOString() } });
      await expect(reconcile(tx, businessId, started)).resolves.toBe("processed");
      const rows = new Map((await tx.select({ id: billingPackCheckouts.id, status: billingPackCheckouts.status, error: billingPackCheckouts.error }).from(billingPackCheckouts).where(eq(billingPackCheckouts.businessId, businessId))).map((row) => [row.id, row]));
      expect(rows.get(ready)).toMatchObject({ status: "expired", error: PACK_CHECKOUT_CLOSED_FOR_PLAN });
      expect(rows.get(pending)).toMatchObject({ status: "failed", error: PACK_CHECKOUT_CLOSED_FOR_PLAN });
      expect(rows.get(processing)).toMatchObject({ status: "failed", error: PACK_CHECKOUT_CLOSED_FOR_PLAN });
      expect(rows.get(lateProcessing)).toMatchObject({ status: "failed", error: PACK_CHECKOUT_CLOSED_FOR_PLAN });
      // A page whose own expiry passed is the sweep's, and a paid checkout never moves.
      expect(rows.get(lapsed)).toMatchObject({ status: "ready", error: null });
      expect(rows.get(paid)).toMatchObject({ status: "paid", error: null });
      const messages = await outbox(tx, businessId);
      expect(messages.filter((message) => message.topic === "billing.closePackCheckout")).toEqual([{ topic: "billing.closePackCheckout", dedupeKey: `billing-pack-checkout:${ready}:close`, payload: { checkoutId: ready, providerCheckoutId: "cs_open_page_1" } }]);
      // Each page waiting on its checkout hears of it.
      expect(messages.map((message) => message.dedupeKey)).toEqual(expect.arrayContaining([`billing-pack-checkout:${ready}:expired`, `billing-pack-checkout:${pending}:failed`, `billing-pack-checkout:${processing}:failed`]));
      expect(await readPackCheckoutInTransaction(tx, { businessId, checkoutId: ready })).toMatchObject({ status: "expired", checkoutUrl: null, packStatus: null });
    });
  });

  it("makes the order row of a pack's invoice when the checkout's event comes before the invoice's, which then fills in the same row", async () => {
    await rollbackTest(async (tx) => {
      await catalog(tx);
      const businessId = await business(tx);
      const paidAt = new Date(Date.now() - 60_000);
      await reconcile(tx, businessId, await store(tx, businessId, { eventType: "checkout.session.completed", payload: stripeSession(businessId, { paymentRef: "pi_invoice_late_1", invoiceRef: "in_pack_late_1", occurredAt: paidAt }) }));
      const [pack] = await packsOf(tx, businessId);
      const made = await orderOf(tx, "in_pack_late_1");
      expect(made).toMatchObject({ status: "paid", amountCents: 5_500, refundedAmountCents: 0 });
      expect(pack!.transactionId).toBe(made!.id);
      expect(await orderOf(tx, "pi_invoice_late_1")).toBeUndefined();

      // Stripe's invoice.paid, as stripe/events.ts stores it, lands on the same row.
      const invoice = { id: "in_pack_late_1", object: "invoice", kind: "payment", customerId: `cus_${businessId}`, orderId: "in_pack_late_1", status: "paid", amountCents: 5_500, currency: "cad", occurredAt: paidAt.toISOString(), description: "Invoice PACK-0001" };
      await expect(reconcile(tx, businessId, await store(tx, businessId, { eventType: "invoice.paid", payload: invoice }))).resolves.toBe("processed");
      const rows = await tx.select({ id: billingTransactions.id, status: billingTransactions.status, description: billingTransactions.description }).from(billingTransactions).where(and(eq(billingTransactions.kind, "order"), eq(billingTransactions.sourceId, "in_pack_late_1")));
      expect(rows).toEqual([{ id: made!.id, status: "paid", description: "Invoice PACK-0001" }]);
      expect((await packsOf(tx, businessId))[0]?.transactionId).toBe(made!.id);
    });
  });

  it("adds the pack with the terms its checkout kept when the catalog changed before the payment arrived", async () => {
    await rollbackTest(async (tx) => {
      const { stripePriceId, polarPriceId } = await catalog(tx);
      const kept = { voiceSec: 15_000, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1 };
      const stripeBusiness = await business(tx);
      const stripeCheckout = await packCheckout(tx, stripeBusiness, stripePriceId, { terms: kept });
      const polarBusiness = await business(tx, { source: "polar" });
      const providerCheckoutId = randomUUID();
      const polarCheckout = await packCheckout(tx, polarBusiness, polarPriceId, { pack: "pack_events_polar", providerCheckoutId, terms: { ...kept, days: 180 } });
      // A catalog apply gives both packs fewer minutes and a shorter life while their pages are open.
      await tx.update(billingPackPlans).set({ voiceSec: 6_000, days: 30, smsSeg: 10 }).where(sql`${billingPackPlans.code} in ('pack_events_stripe', 'pack_events_polar')`);

      await reconcile(tx, stripeBusiness, await store(tx, stripeBusiness, { eventType: "checkout.session.completed", payload: stripeSession(stripeBusiness, { paymentRef: "pi_kept_terms_1", checkoutId: stripeCheckout }) }));
      const order = { kind: "payment", billingKey: `business:${polarBusiness}`, id: "order_kept_terms_1", status: "paid", total_amount: 10_890, refunded_amount: 0, refunded_tax_amount: 0, currency: "usd", created_at: new Date(Date.now() - 60_000).toISOString(), billing_reason: "purchase", productId: POLAR_PRODUCT, priceRef: POLAR_PRODUCT, metadata: {}, checkout_id: providerCheckoutId };
      await reconcile(tx, polarBusiness, await store(tx, polarBusiness, { provider: "polar", eventType: "order.paid", payload: order }));

      const [stripePack] = await packsOf(tx, stripeBusiness);
      expect(stripePack).toMatchObject({ pack: "pack_events_stripe", secondsTotal: 15_000, priceId: stripePriceId });
      expect(stripePack!.endsAt!.getTime() - stripePack!.paidAt.getTime()).toBe(90 * DAY);
      const [polarPack] = await packsOf(tx, polarBusiness);
      expect(polarPack).toMatchObject({ pack: "pack_events_polar", secondsTotal: 15_000, priceId: polarPriceId });
      expect(polarPack!.endsAt!.getTime() - polarPack!.paidAt.getTime()).toBe(180 * DAY);
      const [allowances] = await tx.select({ smsSeg: billingPacks.smsSeg }).from(billingPacks).where(eq(billingPacks.id, stripePack!.id));
      expect(allowances?.smsSeg).toBe(50);
      // A payment that names no checkout reads the catalog, as before checkouts kept terms.
      await reconcile(tx, stripeBusiness, await store(tx, stripeBusiness, { eventType: "checkout.session.completed", payload: stripeSession(stripeBusiness, { paymentRef: "pi_catalog_terms_1" }) }));
      expect((await packsOf(tx, stripeBusiness)).find((entry) => entry.providerRef === "pi_catalog_terms_1")).toMatchObject({ secondsTotal: 6_000 });
    });
  });
});
