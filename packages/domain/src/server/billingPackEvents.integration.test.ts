import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingAccounts, billingPackCheckouts, billingPackPlans, billingPackPrices, billingPacks, billingTransactions, businesses, createDatabaseClient, outboxMessages, phoneNumbers, productEvents, providerEvents, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { reconcileBillingProviderEvent } from "./billing";
import { PACK_RECLAIM_REASON } from "./billingPacks";
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

/** A pack checkout the business asked for, a Stripe one unless it names a Polar pack and checkout; createdAt is when it asked. */
async function packCheckout(tx: DatabaseTransaction, businessId: string, priceId: string, options: { pack?: string; providerCheckoutId?: string; createdAt?: Date } = {}) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid` });
  const [row] = await tx.insert(billingPackCheckouts).values({ businessId, requestedByUserId: userId, pack: options.pack ?? "pack_events_stripe", priceId, status: "ready", checkoutId: options.providerCheckoutId ?? `cs_${randomUUID()}`, checkoutUrl: "https://checkout.stripe.test/pay", expiresAt: new Date(Date.now() + DAY), ...(options.createdAt ? { createdAt: options.createdAt } : {}) }).returning({ id: billingPackCheckouts.id });
  return row!.id;
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
});
