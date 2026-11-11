import { randomUUID } from "node:crypto";

import type { JobEnvelope } from "@lobbystack/contracts";
import { claimBillingSubscription, claimBillingUsageSync, confirmBillingUsageSync, loadBillingUsageEvent, loadPlanEndForPackWork, releaseBillingSubscription, type PlanEndForPackWork } from "@lobbystack/domain";
import type { PolarBillingClient } from "@lobbystack/providers/polar/adapter";
import { PolarRequestError, type PolarBillingProvider, type PolarSubscription } from "@lobbystack/providers/polar/polarBilling";
import { StripeBilling } from "@lobbystack/providers/stripe/adapter";
import { createFakeStripe, permissionDenied, type FakeStripe } from "@lobbystack/providers/stripe/fake";
import { reportError } from "@lobbystack/telemetry/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));
vi.mock("@lobbystack/telemetry/node", async (importOriginal) => ({ ...await importOriginal<typeof import("@lobbystack/telemetry/node")>(), reportError: vi.fn(), reportWarning: vi.fn() }));

import { handleJob } from "../handlers";
import { polarFake } from "./polarFake";

// billing.endPlanForPack (decision 6, subscription to pack): ending, at the
// provider, the subscription a prepaid pack replaced, on a fake Polar client
// and on the in-memory Stripe.

const domain = { db: undefined as never };
const switchedAt = new Date("2026-11-09T12:00:00.000Z");
/** A time this many minutes after the switch. */
const minutes = (count: number) => new Date(switchedAt.getTime() + count * 60_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(minutes(40));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function work(fields: Partial<PlanEndForPackWork> = {}): PlanEndForPackWork {
  return { current: true, overageSubscriptionId: null, billingInterval: "monthly", subscriptionState: "active", periodEnd: new Date("2026-11-20T00:00:00.000Z"), switchedAt, pendingUsage: [], unsettled: 0, ...fields };
}

function job(businessId: string, payload: Record<string, unknown> = { subscriptionId: "sub_1", packId: "pack-1", since: switchedAt.toISOString() }): JobEnvelope {
  return { jobId: randomUUID(), type: "billing.endPlanForPack", queue: "critical", businessId, payload, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
}

/** A Polar that keeps what the job changes on the subscription; periodEnds is Polar ending it at its period's end. */
function polar(initial: Partial<PolarSubscription> = {}) {
  let subscription: PolarSubscription = { id: "sub_1", status: "active", productId: "product-starter-monthly", cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null, discountId: null, currentPeriodEnd: "2026-11-20T00:00:00.000Z", ...initial };
  const client = {
    recordUsage: vi.fn<PolarBillingProvider["recordUsage"]>(async () => undefined),
    getSubscription: vi.fn(async () => subscription),
    cancelSubscriptionAtPeriodEnd: vi.fn(async () => (subscription = { ...subscription, cancelAtPeriodEnd: true })),
    moveSubscriptionPeriodEnd: vi.fn(async (_id: string, at: Date) => (subscription = { ...subscription, currentPeriodEnd: at.toISOString() })),
  } satisfies PolarBillingClient;
  return { client, billing: polarFake(client), periodEnds: () => { subscription = { ...subscription, status: "canceled", endedAt: subscription.currentPeriodEnd }; } };
}

/** Starter usage rows the job finds pending, each with one event to send. */
function pendingUsage() {
  vi.mocked(loadBillingUsageEvent).mockImplementation(async (_context, input) => ({ id: input.usageEventId, sourceKey: `voice:${input.usageEventId}`, isFinal: true, plan: "starter", businessId: input.businessId, usageKind: "voice_seconds", quantity: 120, billableQuantity: 60, billingIntervalAtRecordTime: "monthly", createdAt: minutes(-30), syncStatus: "pending", billingKey: `business:${input.businessId}`, customerId: "polar-customer", periodStart: null, periodEnd: null }));
  vi.mocked(claimBillingUsageSync).mockImplementation(async (_context, input) => ({ externalId: `voice:${input.usageEventId}`, quantity: 60, seq: 0, rateCents: null, sentAt: new Date(), expired: false }));
  vi.mocked(confirmBillingUsageSync).mockResolvedValue(true);
}

/** A Stripe account with a plan subscription, and optionally its separate overage subscription. */
function stripeWith(plan: { id: string; overageOnPlan?: boolean }, overage?: string): { stripe: FakeStripe; billing: StripeBilling } {
  const stripe = createFakeStripe({ accountId: "acct_1" });
  const overagePrices = ["price_overage_voice", "price_overage_sms", "price_overage_transfers"];
  stripe.addSubscription({ id: plan.id, customer: "cus_1", ...(plan.overageOnPlan ? { overagePrices } : {}) });
  if (overage) stripe.addSubscription({ id: overage, customer: "cus_1", overagePrices, metadata: { lobbystack_role: "overage", lobbystack_plan_subscription: plan.id } });
  return { stripe, billing: new StripeBilling(stripe, { accountId: "acct_1", env: "sandbox" }) };
}

const errors = () => vi.mocked(reportError).mock.calls.map(([error]) => (error as Error).message);

describe("ending a subscription a prepaid pack replaced", () => {
  it("waits for calls that began on the old plan, and stops waiting 32 minutes after the switch: the longest call and two minutes", async () => {
    const businessId = randomUUID();
    const { client, billing } = polar();
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work({ unsettled: 2 }));
    vi.setSystemTime(minutes(10));
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "deferred", entityId: businessId, retryAt: minutes(11) });
    vi.setSystemTime(minutes(31.5));
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "deferred", entityId: businessId, retryAt: minutes(32) });
    expect(client.getSubscription).not.toHaveBeenCalled();
    expect(claimBillingSubscription).not.toHaveBeenCalled();
    vi.setSystemTime(minutes(32));
    await handleJob(job(businessId), { domain, billing });
    expect(client.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(1);
    expect(loadPlanEndForPackWork).toHaveBeenLastCalledWith(domain, { businessId, subscriptionId: "sub_1", since: switchedAt.toISOString(), now: minutes(32) });
  });

  it("stops waiting for calls at once when the plan would renew before the wait is over", async () => {
    const { client, billing } = polar({ currentPeriodEnd: minutes(20).toISOString() });
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work({ unsettled: 1, periodEnd: minutes(20) }));
    vi.setSystemTime(minutes(1));
    await handleJob(job(randomUUID()), { domain, billing });
    expect(client.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(1);
    expect(client.moveSubscriptionPeriodEnd).toHaveBeenCalledWith("sub_1", minutes(6));
  });

  it("sends the usage still pending before it claims and ends the subscription, oldest first", async () => {
    const { client, billing } = polar();
    pendingUsage();
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work({ pendingUsage: ["usage-1", "usage-2"] }));
    await handleJob(job(randomUUID()), { domain, billing });
    expect(client.recordUsage.mock.calls.map(([input]) => input.idempotencyKey)).toEqual(["voice:usage-1", "voice:usage-2"]);
    expect(confirmBillingUsageSync).toHaveBeenCalledTimes(2);
    const lastSend = Math.max(...client.recordUsage.mock.invocationCallOrder);
    expect(lastSend).toBeLessThan(vi.mocked(claimBillingSubscription).mock.invocationCallOrder[0]!);
    expect(lastSend).toBeLessThan(client.cancelSubscriptionAtPeriodEnd.mock.invocationCallOrder[0]!);
  });

  it("leaves the subscription alone and fails the try when pending usage can't be sent, so the job tries again", async () => {
    const { client, billing } = polar();
    pendingUsage();
    client.recordUsage.mockRejectedValueOnce(new PolarRequestError(502, null));
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work({ pendingUsage: ["usage-1"] }));
    await expect(handleJob(job(randomUUID()), { domain, billing })).rejects.toMatchObject({ status: 502 });
    expect(claimBillingSubscription).not.toHaveBeenCalled();
    expect(client.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
  });

  it("looks again until Polar shows the subscription ended, not just set to end, asking nothing more of it meanwhile", async () => {
    const businessId = randomUUID();
    const { client, billing, periodEnds } = polar();
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work());
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "deferred", entityId: businessId, retryAt: minutes(46) });
    expect(client.moveSubscriptionPeriodEnd).toHaveBeenCalledWith("sub_1", minutes(45));
    // Polar hasn't got to the new end yet.
    vi.setSystemTime(minutes(47));
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "deferred", entityId: businessId, retryAt: minutes(48) });
    expect(client.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(1);
    expect(client.moveSubscriptionPeriodEnd).toHaveBeenCalledTimes(1);
    periodEnds();
    vi.setSystemTime(minutes(49));
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "completed", entityId: businessId });
    expect(releaseBillingSubscription).toHaveBeenCalledTimes(3);
    expect(errors()).toEqual([]);
  });

  it("tells the operator when Polar still shows it live an hour after it should have ended, and stops, leaving the daily pack job to queue it again", async () => {
    const businessId = randomUUID();
    const { client, billing } = polar({ cancelAtPeriodEnd: true, currentPeriodEnd: minutes(45).toISOString() });
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work());
    vi.setSystemTime(minutes(105));
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "deferred", entityId: businessId, retryAt: minutes(106) });
    expect(errors()).toEqual([]);
    vi.setSystemTime(minutes(106));
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "skipped", entityId: businessId });
    expect(errors()).toEqual(["Polar still shows the subscription a prepaid pack replaced live an hour after it should have ended."]);
    expect(client.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
    expect(client.moveSubscriptionPeriodEnd).not.toHaveBeenCalled();
    expect(releaseBillingSubscription).toHaveBeenCalledTimes(2);
  });

  it("tells the operator, and stops trying, when the worker's Polar token can't end subscriptions", async () => {
    const businessId = randomUUID();
    const { client, billing } = polar();
    client.cancelSubscriptionAtPeriodEnd.mockRejectedValueOnce(new PolarRequestError(403, "insufficient_scope"));
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work());
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "skipped", entityId: businessId });
    expect(errors()).toEqual(["Polar refused to end the subscription a prepaid pack replaced: the worker's POLAR_ACCESS_TOKEN needs subscriptions:write."]);
    expect(releaseBillingSubscription).toHaveBeenCalledWith(domain, { businessId, claimId: "subscription-claim" });
  });

  it("tells the operator, and stops trying, when the worker's Stripe key can't end subscriptions", async () => {
    const businessId = randomUUID();
    const { stripe, billing } = stripeWith({ id: "sub_1", overageOnPlan: true });
    vi.spyOn(stripe.subscriptions, "cancel").mockRejectedValue(permissionDenied());
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work({ overageSubscriptionId: "sub_1" }));
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "skipped", entityId: businessId });
    expect(errors()).toEqual(["Stripe refused to end the subscription a prepaid pack replaced: the worker's STRIPE_API_KEY needs write access to subscriptions."]);
    expect(releaseBillingSubscription).toHaveBeenCalledWith(domain, { businessId, claimId: "subscription-claim" });
  });

  it("tells the operator, and stops trying, when Polar refuses the subscription as not active", async () => {
    const businessId = randomUUID();
    const { client, billing } = polar();
    client.cancelSubscriptionAtPeriodEnd.mockRejectedValueOnce(new PolarRequestError(403, "InactiveSubscription"));
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work());
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "skipped", entityId: businessId });
    expect(errors()).toEqual([expect.stringContaining("Polar refused to end the subscription a prepaid pack replaced, as it does for one that isn't active.")]);
    expect(releaseBillingSubscription).toHaveBeenCalledTimes(1);
  });

  it("hands the subscription back and fails the try after any other refusal, so the job tries again", async () => {
    const businessId = randomUUID();
    const { client, billing } = polar();
    client.cancelSubscriptionAtPeriodEnd.mockRejectedValueOnce(new PolarRequestError(409, "SubscriptionLocked"));
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work());
    await expect(handleJob(job(businessId), { domain, billing })).rejects.toMatchObject({ status: 409 });
    expect(releaseBillingSubscription).toHaveBeenCalledWith(domain, { businessId, claimId: "subscription-claim" });
    expect(errors()).toEqual([]);
  });

  it("waits while a plan change holds the subscription", async () => {
    const retryAt = minutes(41);
    vi.mocked(claimBillingSubscription).mockResolvedValueOnce({ retryAt });
    const { client, billing } = polar();
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work());
    expect(await handleJob(job(randomUUID()), { domain, billing })).toMatchObject({ status: "deferred", retryAt });
    expect(client.getSubscription).not.toHaveBeenCalled();
  });

  it("ends a plan carrying the overage prices, as merchant of record sells it, at once on Stripe, invoicing its meters with no proration", async () => {
    const businessId = randomUUID();
    const { stripe, billing } = stripeWith({ id: "sub_1", overageOnPlan: true });
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work({ overageSubscriptionId: "sub_1" }));
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "completed", entityId: businessId });
    expect(stripe.requests.filter((request) => request.call !== "subscriptions.retrieve")).toEqual([{ call: "subscriptions.cancel", params: { id: "sub_1", invoice_now: true, prorate: false }, idempotencyKey: "cancel:pack-end:sub_1" }]);
    expect(stripe.state.subscriptions.get("sub_1")?.status).toBe("canceled");
    expect(stripe.state.invoices.size).toBe(1);
  });

  it("ends a plan sold by Stripe directly at once, and sets its overage subscription to end with its month", async () => {
    const { stripe, billing } = stripeWith({ id: "sub_plan" }, "sub_overage");
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work({ overageSubscriptionId: "sub_overage" }));
    expect(await handleJob(job(randomUUID(), { subscriptionId: "sub_plan", since: switchedAt.toISOString() }), { domain, billing })).toMatchObject({ status: "completed" });
    expect(stripe.state.subscriptions.get("sub_plan")?.status).toBe("canceled");
    expect(stripe.state.subscriptions.get("sub_overage")).toMatchObject({ status: "active", cancel_at_period_end: true });
  });

  it("ends a subscription the business replaced with a newer one, leaving out the overage subscription and the yearly check, which describe the newer one", async () => {
    const { stripe, billing } = stripeWith({ id: "sub_old" }, "sub_overage");
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work({ current: false, overageSubscriptionId: "sub_overage", billingInterval: "annual", periodEnd: null }));
    expect(await handleJob(job(randomUUID(), { subscriptionId: "sub_old", since: switchedAt.toISOString() }), { domain, billing })).toMatchObject({ status: "completed" });
    expect(stripe.state.subscriptions.get("sub_old")?.status).toBe("canceled");
    expect(stripe.state.subscriptions.get("sub_overage")).toMatchObject({ status: "active", cancel_at_period_end: false });
    expect(stripe.requests.map((request) => request.call)).not.toContain("subscriptions.update");
    expect(errors()).toEqual([]);
  });

  it("reports a yearly or past-due subscription, which checkout refuses, and leaves it alone", async () => {
    for (const fields of [{ billingInterval: "annual" }, { subscriptionState: "past_due" }]) {
      const businessId = randomUUID();
      const { client, billing } = polar();
      vi.mocked(loadPlanEndForPackWork).mockResolvedValue(work(fields));
      expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "skipped", entityId: businessId });
      expect(client.getSubscription).not.toHaveBeenCalled();
    }
    expect(errors()).toEqual([
      "A prepaid pack replaced a yearly subscription, which checkout refuses, so Polar isn't asked to end it. Settle with the business what becomes of the plan.",
      "A prepaid pack replaced a past-due subscription, which checkout refuses, so Polar isn't asked to end it. Settle with the business what becomes of the plan.",
    ]);
    expect(claimBillingSubscription).not.toHaveBeenCalled();
  });

  it("does nothing once the account no longer names the subscription as replaced", async () => {
    const businessId = randomUUID();
    const { client, billing } = polar();
    vi.mocked(loadPlanEndForPackWork).mockResolvedValue(null);
    expect(await handleJob(job(businessId), { domain, billing })).toEqual({ status: "skipped", entityId: businessId });
    expect(client.getSubscription).not.toHaveBeenCalled();
    expect(claimBillingSubscription).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);
  });

  it("tells the operator when the worker has no billing provider to end it with, since the business pays twice", async () => {
    vi.stubEnv("BILLING_PROVIDER", "polar");
    expect(await handleJob(job(randomUUID()), { domain })).toMatchObject({ status: "skipped" });
    vi.stubEnv("BILLING_PROVIDER", "stripe");
    expect(await handleJob(job(randomUUID()), { domain })).toMatchObject({ status: "skipped" });
    expect(errors()).toEqual([
      "A subscription a prepaid pack replaced still bills the business, and the worker has no Polar token to end it with. Set POLAR_ACCESS_TOKEN and POLAR_ORGANIZATION_ID on the worker.",
      "A subscription a prepaid pack replaced still bills the business, and the worker has no Stripe key to end it with. Set STRIPE_API_KEY, of the account STRIPE_ACCOUNT_ID names, on the worker.",
    ]);
    expect(loadPlanEndForPackWork).not.toHaveBeenCalled();
  });

  it("skips a job that names no subscription", async () => {
    const { billing } = polar();
    expect(await handleJob(job(randomUUID(), {}), { domain, billing })).toEqual({ status: "skipped" });
    expect(loadPlanEndForPackWork).not.toHaveBeenCalled();
  });
});
