import { describe, expect, it } from "vitest";

import { FakeClock, type FakeCard } from "../../stripe/fake";
import { BillingProviderError } from "../errors";
import type { PlanChangeResult } from "../types";
import { stripeHarness } from "./harness";

// Plan changes on Stripe (the Stripe plan's step 14): an upgrade paid at
// once, declined, or needing 3-D Secure; a downgrade at the renewal; a promo
// plan's two endings; and a discount removed. The fake runs on today's clock,
// as the read-back compares a schedule's phases with the time it's read.

const starter = { ref: "price_starter_month", discountRef: null };
const pro = { ref: "price_pro_month", discountRef: null };
const proLaunch = { ref: "price_pro_launch_month", discountRef: "ls-alloplace-pro-launch-12345678" };

/** A business on Starter, paying with the card given. */
async function onStarter(card: FakeCard = "pm_card_visa") {
  const harness = stripeHarness({ clock: new FakeClock(Math.floor(Date.now() / 1000)) });
  const { stripe } = harness;
  stripe.addCustomer({ id: "cus_1", businessId: "b1" });
  await stripe.customers.update("cus_1", { invoice_settings: { default_payment_method: card } });
  const now = stripe.clock.now();
  stripe.addSubscription({ id: "sub_1", customer: "cus_1", price: starter.ref, periodStart: now, periodEnd: now + 30 * 86_400 });
  stripe.requests.length = 0;
  return { ...harness, periodEnd: new Date((now + 30 * 86_400) * 1000) };
}

const refusalOf = async (billing: Awaited<ReturnType<typeof onStarter>>["billing"], change: Promise<PlanChangeResult>) => {
  try {
    await change;
  } catch (error) {
    expect(error).toBeInstanceOf(BillingProviderError);
    return billing.refusalFor(error);
  }
  throw new Error("The change went through.");
};

describe("the billing provider contract: a plan change on Stripe", () => {
  it("moves the plan's item now when its invoice is paid at once, with billing.json's proration", async () => {
    const { billing, stripe } = await onStarter();
    const changed = await billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "keep", when: "now", proration: "invoice_now", requestId: "r1" });
    expect(changed).toMatchObject({ status: "changed", subscription: { priceRef: pro.ref, pendingPayment: null } });
    expect(stripe.requests.find((request) => request.call === "subscriptions.update")).toEqual({
      call: "subscriptions.update",
      params: { id: "sub_1", items: [{ id: "si_sub_1_0", price: pro.ref }], proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete", expand: ["latest_invoice"] },
      idempotencyKey: "plan-change:r1",
    });
    expect([...stripe.state.invoices.values()].map((invoice) => invoice.status)).toEqual(["paid"]);
    // Prorated onto the next invoice, nothing is charged now; a restart starts a new period from today.
    await billing.changePlan({ subscriptionId: "sub_1", to: starter, discount: "keep", when: "now", proration: "next_invoice", requestId: "r2" });
    await billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "keep", when: "now", proration: "restart", requestId: "r3" });
    const updates = stripe.requests.filter((request) => request.call === "subscriptions.update").map((request) => request.params);
    expect(updates[1]).toMatchObject({ proration_behavior: "create_prorations" });
    expect(updates[2]).toMatchObject({ proration_behavior: "create_prorations", billing_cycle_anchor: { type: "now" } });
    expect(stripe.state.invoices.size).toBe(2);
  });

  it("moves onto a promo price with its coupon and metadata in the same call, and off one without it", async () => {
    const { billing, stripe } = await onStarter();
    const onto = await billing.changePlan({ subscriptionId: "sub_1", to: proLaunch, discount: "price", when: "now", proration: "invoice_now", metadata: { lobbystack_plan: "pro-launch" }, requestId: "r1" });
    expect(onto.subscription).toMatchObject({ priceRef: proLaunch.ref, discountRef: proLaunch.discountRef, metadata: { lobbystack_plan: "pro-launch" } });
    const off = await billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "remove", when: "now", proration: "invoice_now", requestId: "r2" });
    expect(off.subscription).toMatchObject({ priceRef: pro.ref, discountRef: null });
    expect(stripe.requests.filter((request) => request.call === "subscriptions.update").map((request) => (request.params as { discounts?: unknown }).discounts)).toEqual([[{ coupon: proLaunch.discountRef }], ""]);
  });

  it("drops a declined upgrade by voiding its invoice, and refuses it as payment_failed", async () => {
    const { billing, stripe } = await onStarter("pm_card_chargeCustomerFail");
    expect(await refusalOf(billing, billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "keep", when: "now", proration: "invoice_now", requestId: "r1" }))).toBe("payment_failed");
    const [invoice] = [...stripe.state.invoices.values()];
    expect(invoice?.status).toBe("void");
    expect(stripe.requests.find((request) => request.call === "invoices.voidInvoice")).toMatchObject({ params: { id: invoice!.id }, idempotencyKey: "plan-change-void:r1" });
    await expect(billing.getSubscription("sub_1")).resolves.toMatchObject({ priceRef: starter.ref, pendingPayment: null });
  });

  it("sends a 3-D Secure upgrade to the invoice's page, the same page for a retried job, and applies it once paid", async () => {
    const { billing, stripe } = await onStarter("pm_card_authenticationRequired");
    const waiting = await billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "keep", when: "now", proration: "invoice_now", requestId: "r1" });
    const [invoice] = [...stripe.state.invoices.values()];
    expect(waiting).toEqual({ status: "needs_action", url: invoice!.hosted_invoice_url, subscription: expect.objectContaining({ priceRef: starter.ref, pendingPayment: { url: invoice!.hosted_invoice_url, expiresAt: expect.any(Date) } }) });
    // The same request again, as after a job that died: the same page, and no second invoice.
    await expect(billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "keep", when: "now", proration: "invoice_now", requestId: "r1" })).resolves.toMatchObject({ status: "needs_action", url: invoice!.hosted_invoice_url });
    expect(stripe.state.invoices.size).toBe(1);
    // The customer confirms with the bank on that page: Stripe applies the update.
    stripe.payInvoice(invoice!.id);
    await expect(billing.getSubscription("sub_1")).resolves.toMatchObject({ priceRef: pro.ref, pendingPayment: null });
  });

  it("lets an unpaid 3-D Secure upgrade expire, leaving the plan as it was, and holds a change at the renewal meanwhile", async () => {
    const { billing, stripe } = await onStarter("pm_card_authenticationRequired");
    await billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "keep", when: "now", proration: "invoice_now", requestId: "r1" });
    expect(await refusalOf(billing, billing.changePlan({ subscriptionId: "sub_1", to: starter, discount: "keep", when: "renewal", proration: "none", requestId: "r2" }))).toBe("change_pending");
    stripe.expirePendingUpdate("sub_1");
    await expect(billing.getSubscription("sub_1")).resolves.toMatchObject({ priceRef: starter.ref, pendingPayment: null });
    expect([...stripe.state.invoices.values()].map((invoice) => invoice.status)).toEqual(["void"]);
  });

  it("schedules a downgrade for the renewal as a second phase, which a change now replaces", async () => {
    const { billing, stripe, periodEnd } = await onStarter();
    await billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "keep", when: "now", proration: "invoice_now", requestId: "r0" });
    stripe.requests.length = 0;
    const scheduled = await billing.changePlan({ subscriptionId: "sub_1", to: starter, discount: "remove", when: "renewal", proration: "none", requestId: "r1" });
    expect(scheduled).toMatchObject({ status: "scheduled", subscription: { priceRef: pro.ref, next: { priceRef: starter.ref, at: periodEnd } } });
    expect(stripe.requests.filter((request) => request.call.startsWith("subscriptionSchedules")).map(({ call, idempotencyKey }) => ({ call, idempotencyKey }))).toEqual([
      { call: "subscriptionSchedules.create", idempotencyKey: "schedule:r1:schedule" },
      { call: "subscriptionSchedules.update", idempotencyKey: "schedule:r1:phases" },
    ]);
    expect(stripe.requests.find((request) => request.call === "subscriptionSchedules.update")?.params).toMatchObject({ end_behavior: "release", phases: [{ items: [{ price: pro.ref, quantity: 1 }], end_date: periodEnd.getTime() / 1000 }, { items: [{ price: starter.ref, quantity: 1 }], discounts: "" }] });
    // At the renewal the subscription takes the phase, and the schedule lets it go.
    expect(stripe.enterSchedulePhase("sub_1")).toMatchObject({ schedule: null });
    await expect(billing.getSubscription("sub_1")).resolves.toMatchObject({ priceRef: starter.ref, next: null });

    // A downgrade scheduled again, then an upgrade now: the schedule is released first.
    await billing.changePlan({ subscriptionId: "sub_1", to: proLaunch, discount: "price", when: "renewal", proration: "none", requestId: "r2" });
    await expect(billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "keep", when: "now", proration: "invoice_now", requestId: "r3" })).resolves.toMatchObject({ status: "changed", subscription: { priceRef: pro.ref, next: null } });
    expect(stripe.requests.map((request) => request.call)).toContain("subscriptionSchedules.release");
  });

  it("ends a promo plan at the renewal: on its tier's price without the coupon, or cancelled after releasing a schedule", async () => {
    const { billing, stripe, periodEnd } = await onStarter();
    await billing.changePlan({ subscriptionId: "sub_1", to: proLaunch, discount: "price", when: "now", proration: "invoice_now", requestId: "r0" });
    const tier = await billing.endAtRenewal({ subscriptionId: "sub_1", then: pro, requestId: "promo-end:b1:pro-launch" });
    expect(tier).toMatchObject({ priceRef: proLaunch.ref, discountRef: proLaunch.discountRef, next: { priceRef: pro.ref, at: periodEnd } });
    expect(stripe.requests.find((request) => request.call === "subscriptionSchedules.update")).toMatchObject({ params: { phases: [{ discounts: [{ coupon: proLaunch.discountRef }] }, { items: [{ price: pro.ref, quantity: 1 }], discounts: "" }] }, idempotencyKey: "promo-end:b1:pro-launch:phases" });
    const cancelled = await billing.endAtRenewal({ subscriptionId: "sub_1", then: "cancel", requestId: "promo-end:b1:pro-launch-2" });
    expect(cancelled).toMatchObject({ priceRef: proLaunch.ref, cancelAt: periodEnd, next: null });
    expect(stripe.requests.slice(-3).map((request) => request.call)).toEqual(["subscriptionSchedules.release", "subscriptions.update", "subscriptions.retrieve"]);
  });

  it("removes the discounts, keyed by the request", async () => {
    const { billing, stripe } = await onStarter();
    await billing.changePlan({ subscriptionId: "sub_1", to: proLaunch, discount: "price", when: "now", proration: "invoice_now", requestId: "r0" });
    await expect(billing.removeDiscount({ subscriptionId: "sub_1", requestId: "drop-discount:sub_1:coupon_1" })).resolves.toMatchObject({ priceRef: proLaunch.ref, discountRef: null });
    expect(stripe.requests.filter((request) => request.call === "subscriptions.update").at(-1)).toEqual({ call: "subscriptions.update", params: { id: "sub_1", discounts: "" }, idempotencyKey: "drop-discount:sub_1:coupon_1" });
  });
});

describe("the billing provider contract: cancelling, resuming and keeping a plan on Stripe", () => {
  it("cancels at the renewal and resumes before it, once each for a retried job", async () => {
    const { billing, stripe, periodEnd } = await onStarter();
    await expect(billing.cancel({ subscriptionId: "sub_1", when: "renewal", requestId: "r1" })).resolves.toMatchObject({ priceRef: starter.ref, cancelAt: periodEnd });
    await billing.cancel({ subscriptionId: "sub_1", when: "renewal", requestId: "r1" });
    expect(stripe.requests.filter((request) => request.call === "subscriptions.update")).toEqual([{ call: "subscriptions.update", params: { id: "sub_1", cancel_at_period_end: true }, idempotencyKey: "cancel:r1" }]);
    await expect(billing.resume({ subscriptionId: "sub_1", requestId: "r2" })).resolves.toMatchObject({ cancelAt: null });
    expect(stripe.requests.filter((request) => request.call === "subscriptions.update").at(-1)).toEqual({ call: "subscriptions.update", params: { id: "sub_1", cancel_at_period_end: false }, idempotencyKey: "resume:r2" });
    // Nothing to resume: no call.
    const updates = stripe.requests.length;
    await expect(billing.resume({ subscriptionId: "sub_1", requestId: "r3" })).resolves.toMatchObject({ cancelAt: null });
    expect(stripe.requests.slice(updates).map((request) => request.call)).toEqual(["subscriptions.retrieve", "subscriptions.retrieve"]);
  });

  it("cancels a plan with a downgrade waiting by releasing its schedule first, and keeps the plan by releasing it alone", async () => {
    const { billing, stripe, periodEnd } = await onStarter();
    await billing.changePlan({ subscriptionId: "sub_1", to: pro, discount: "keep", when: "now", proration: "invoice_now", requestId: "r0" });
    await billing.changePlan({ subscriptionId: "sub_1", to: starter, discount: "keep", when: "renewal", proration: "none", requestId: "r1" });
    await expect(billing.keepPlan({ subscriptionId: "sub_1", requestId: "r2" })).resolves.toMatchObject({ priceRef: pro.ref, next: null, cancelAt: null });
    expect(stripe.requests.filter((request) => request.call === "subscriptionSchedules.release")).toMatchObject([{ idempotencyKey: "keep:r2" }]);
    // Keeping a plan with nothing waiting asks nothing.
    await expect(billing.keepPlan({ subscriptionId: "sub_1", requestId: "r3" })).resolves.toMatchObject({ next: null });
    expect(stripe.requests.filter((request) => request.call === "subscriptionSchedules.release")).toHaveLength(1);
    await billing.changePlan({ subscriptionId: "sub_1", to: starter, discount: "keep", when: "renewal", proration: "none", requestId: "r4" });
    await expect(billing.cancel({ subscriptionId: "sub_1", when: "renewal", requestId: "r5" })).resolves.toMatchObject({ priceRef: pro.ref, next: null, cancelAt: periodEnd });
    expect(stripe.requests.slice(-4).map((request) => request.call)).toEqual(["subscriptions.retrieve", "subscriptionSchedules.release", "subscriptions.update", "subscriptions.retrieve"]);
  });

  it("ends one now, and counts one that already ended as ended", async () => {
    const { billing, stripe } = await onStarter();
    await expect(billing.cancel({ subscriptionId: "sub_1", when: "now", requestId: "r1" })).resolves.toBeNull();
    expect(stripe.state.subscriptions.get("sub_1")?.status).toBe("canceled");
    await expect(billing.cancel({ subscriptionId: "sub_1", when: "now", requestId: "r2" })).resolves.toBeNull();
  });
});
