import { randomUUID } from "node:crypto";

import type { JobEnvelope } from "@lobbystack/contracts";
import { claimBillingCheckoutRequest, loadBillingCheckoutRequest, loadPlanChangeProration, markBillingCheckoutCreated, markBillingCheckoutFailed, markBillingPlanChanged } from "@lobbystack/domain";
import { StripeBilling } from "@lobbystack/providers/stripe/adapter";
import { createFakeStripe, FakeClock, type FakeCard } from "@lobbystack/providers/stripe/fake";
import { planChangeRefusalSentence } from "@lobbystack/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));

import { handleJob } from "../handlers";

// A paying business's plan change on Stripe (the Stripe plan's step 14), on
// the in-memory Stripe: paid at once, declined, or waiting for the bank.

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/** A Starter business paying with the card given asks for Pro: the checkout job changes its subscription. */
async function upgrade(card: FakeCard) {
  const stripe = createFakeStripe({ accountId: "acct_1", clock: new FakeClock(Math.floor(Date.now() / 1000)) });
  stripe.addCustomer({ id: "cus_1", businessId: "b1" });
  await stripe.customers.update("cus_1", { invoice_settings: { default_payment_method: card } });
  stripe.addSubscription({ id: "sub_1", customer: "cus_1", price: "price_starter_month" });
  // The plans' Stripe prices, as the catalog's links name them.
  vi.stubEnv("POLAR_STARTER_MONTHLY_PRODUCT_ID", "price_starter_month");
  vi.stubEnv("POLAR_PRO_MONTHLY_PRODUCT_ID", "price_pro_month");
  const businessId = randomUUID();
  const requestId = randomUUID();
  const domain = { db: undefined as never };
  vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
  vi.mocked(loadPlanChangeProration).mockResolvedValue({ upgrade: "invoice", downgrade: "next_period" });
  vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: "pro", billingInterval: "monthly", status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", customerId: "cus_1", externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: null, subscription: { id: "sub_1", plan: "starter", billingInterval: "monthly", planCode: null } });
  const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
  const result = await handleJob(job, { domain, billing: new StripeBilling(stripe, { accountId: "acct_1", env: "sandbox" }) });
  return { stripe, businessId, requestId, domain, result };
}

describe("billing jobs: a plan change on Stripe", () => {
  it("changes the plan when the upgrade's invoice is paid at once, charged as the stripe block says", async () => {
    const { stripe, businessId, requestId, domain, result } = await upgrade("pm_card_visa");
    expect(result).toEqual({ status: "completed", entityId: requestId });
    expect(loadPlanChangeProration).toHaveBeenCalledWith(domain, "stripe");
    expect(markBillingPlanChanged).toHaveBeenCalledWith(domain, { businessId, requestId });
    expect(stripe.state.subscriptions.get("sub_1")!.items.data[0]!.price.id).toBe("price_pro_month");
  });

  it("sends a payment the bank wants confirmed to the invoice's page, as a checkout's own", async () => {
    const { stripe, businessId, requestId, domain, result } = await upgrade("pm_card_authenticationRequired");
    const [invoice] = [...stripe.state.invoices.values()];
    expect(result).toEqual({ status: "completed", entityId: requestId });
    // The request names the subscription, so the event that applies the upgrade, or lets it expire, finds it.
    expect(markBillingCheckoutCreated).toHaveBeenCalledWith(domain, { businessId, requestId, checkoutId: "sub_1", checkoutUrl: invoice!.hosted_invoice_url });
    expect(markBillingPlanChanged).not.toHaveBeenCalled();
  });

  it("tells the business a declined upgrade couldn't be charged, leaving the plan as it was", async () => {
    const { stripe, businessId, requestId, domain, result } = await upgrade("pm_card_chargeDeclined");
    expect(result).toEqual({ status: "skipped", entityId: requestId });
    expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, requestId, error: planChangeRefusalSentence("stripe", "payment_failed") });
    expect(stripe.state.subscriptions.get("sub_1")).toMatchObject({ pending_update: null });
    expect(stripe.state.subscriptions.get("sub_1")!.items.data[0]!.price.id).toBe("price_starter_month");
  });
});
