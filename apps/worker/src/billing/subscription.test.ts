import { randomUUID } from "node:crypto";

import type { JobEnvelope } from "@lobbystack/contracts";
import { claimBillingCheckoutRequest, claimBillingSubscription, loadBillingSubscriptionRequest, markBillingCheckoutFailed, markBillingPlanChanged, releaseBillingCheckoutRequest, type BillingSubscriptionWork } from "@lobbystack/domain";
import { StripeBilling } from "@lobbystack/providers/stripe/adapter";
import { createFakeStripe, FakeClock } from "@lobbystack/providers/stripe/fake";
import { planChangeRefusalSentence } from "@lobbystack/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => ({
  ...(await (await import("./testing")).mockDomain(importOriginal)),
  loadBillingSubscriptionRequest: vi.fn(),
}));

import { handleJob } from "../handlers";
import { polarFake } from "./polarFake";

// Cancel plan, Resume and Keep my plan (the Stripe plan's step 15): the
// billing.changeSubscription job on the in-memory Stripe.

afterEach(() => {
  vi.clearAllMocks();
});

const domain = { db: undefined as never };

/** A Pro business on Stripe, its plan as the test leaves it. */
function onPro() {
  const stripe = createFakeStripe({ accountId: "acct_1", clock: new FakeClock(Math.floor(Date.now() / 1000)) });
  stripe.addCustomer({ id: "cus_1", businessId: "b1" });
  const now = stripe.clock.now();
  stripe.addSubscription({ id: "sub_1", customer: "cus_1", price: "price_pro_month", periodStart: now, periodEnd: now + 30 * 86_400 });
  return { stripe, billing: new StripeBilling(stripe, { accountId: "acct_1", env: "sandbox" }) };
}

async function run(billing: Parameters<typeof handleJob>[1]["billing"], work: Partial<BillingSubscriptionWork>) {
  const businessId = randomUUID();
  const requestId = randomUUID();
  vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
  vi.mocked(loadBillingSubscriptionRequest).mockResolvedValue({ action: "cancel", status: "processing", subscriptionId: "sub_1", source: "stripe", ...work });
  const job: JobEnvelope = { jobId: randomUUID(), type: "billing.changeSubscription", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
  const result = await handleJob(job, { domain, ...(billing ? { billing } : {}) });
  return { businessId, requestId, result };
}

describe("billing.changeSubscription", () => {
  it("cancels at the renewal, then resumes, marking each request changed", async () => {
    const { stripe, billing } = onPro();
    const cancelled = await run(billing, { action: "cancel" });
    expect(cancelled.result).toEqual({ status: "completed", entityId: cancelled.requestId });
    expect(markBillingPlanChanged).toHaveBeenCalledWith(domain, { businessId: cancelled.businessId, requestId: cancelled.requestId });
    expect(stripe.state.subscriptions.get("sub_1")!.cancel_at_period_end).toBe(true);
    // The request's own ID keys Stripe's call, so a retried job asks once.
    expect(stripe.requests.find((request) => request.call === "subscriptions.update")?.idempotencyKey).toBe(`cancel:${cancelled.requestId}`);
    const resumed = await run(billing, { action: "resume" });
    expect(resumed.result).toMatchObject({ status: "completed" });
    expect(stripe.state.subscriptions.get("sub_1")!.cancel_at_period_end).toBe(false);
  });

  it("keeps the plan by dropping a downgrade waiting for the renewal", async () => {
    const { stripe, billing } = onPro();
    await billing.changePlan({ subscriptionId: "sub_1", to: { ref: "price_starter_month", discountRef: null }, discount: "keep", when: "renewal", proration: "none", requestId: "downgrade" });
    expect((await billing.getSubscription("sub_1"))?.next).toMatchObject({ priceRef: "price_starter_month" });
    await run(billing, { action: "keep" });
    await expect(billing.getSubscription("sub_1")).resolves.toMatchObject({ priceRef: "price_pro_month", next: null });
    expect(stripe.state.subscriptions.get("sub_1")!.schedule).toBeNull();
  });

  it("waits for another change of the subscription, and tells the business when there's none to change", async () => {
    const { billing, stripe } = onPro();
    const retryAt = new Date(Date.now() + 60_000);
    vi.mocked(claimBillingSubscription).mockResolvedValueOnce({ retryAt });
    const held = await run(billing, { action: "cancel" });
    expect(held.result).toEqual({ status: "deferred", entityId: held.requestId, retryAt });
    expect(releaseBillingCheckoutRequest).toHaveBeenCalledWith(domain, { businessId: held.businessId, requestId: held.requestId });
    stripe.state.subscriptions.set("sub_1", { ...stripe.state.subscriptions.get("sub_1")!, status: "canceled", ended_at: 1 });
    const ended = await run(billing, { action: "resume" });
    expect(ended.result).toMatchObject({ status: "skipped" });
    expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId: ended.businessId, requestId: ended.requestId, error: planChangeRefusalSentence("stripe", "subscription_unavailable") });
  });

  it("refuses on Polar, whose billing portal does these, and without billing", async () => {
    const polar = await run(polarFake({}), { action: "cancel", source: "polar" });
    expect(polar.result).toMatchObject({ status: "skipped" });
    expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, expect.objectContaining({ requestId: polar.requestId, error: expect.stringContaining("can't be cancelled") }));
    const none = await run(undefined, { action: "keep" });
    expect(none.result).toMatchObject({ status: "skipped" });
  });
});
