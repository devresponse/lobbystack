import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { stripeInvoiceObject, stripeScheduleObject, stripeSubscriptionObject } from "./fake";
import { providerSubscriptionFromStripe, stripePlanItem } from "./subscriptions";

const now = Date.UTC(2026, 10, 1) / 1000;
const readAt = new Date(now * 1000);
const at = (seconds: number) => new Date(seconds * 1000);
const subscription = (input: Partial<Parameters<typeof stripeSubscriptionObject>[0]> = {}) => stripeSubscriptionObject({ id: "sub_1", customer: "cus_1", price: "price_pro_monthly", periodStart: now, periodEnd: now + 30 * 86_400, ...input }, now);

describe("reading a Stripe subscription", () => {
  it.each([
    ["incomplete", "incomplete"],
    ["incomplete_expired", "ended"],
    ["trialing", "trialing"],
    ["active", "active"],
    ["past_due", "past_due"],
    ["unpaid", "unpaid"],
    ["paused", "paused"],
    ["canceled", "canceled"],
    ["some_new_status", "ended"],
  ])("reads the status %s as %s", (status, state) => {
    expect(providerSubscriptionFromStripe(subscription({ status: status as Stripe.Subscription.Status }), readAt).state).toBe(state);
  });

  it("takes the price, interval and period from the plan's item, never an overage price", () => {
    const read = providerSubscriptionFromStripe(subscription({ price: "price_starter_annual", interval: "year", periodEnd: now + 365 * 86_400, overagePrices: ["price_voice_overage", "price_sms_overage"] }), readAt);
    expect(read).toMatchObject({ id: "sub_1", customerId: "cus_1", priceRef: "price_starter_annual", interval: "annual", periodStart: at(now), periodEnd: at(now + 365 * 86_400) });
    // An overage subscription's items are all metered: it has no plan item.
    const overage = stripeSubscriptionObject({ id: "sub_overage", price: "price_x", overagePrices: ["price_voice_overage"] }, now);
    overage.items.data = overage.items.data.filter((item) => item.price.recurring?.usage_type === "metered");
    expect(stripePlanItem(overage)).toBeNull();
    expect(providerSubscriptionFromStripe(overage, readAt)).toMatchObject({ priceRef: null, interval: null, periodEnd: null });
  });

  it("names a customer that came back expanded, and the first discount's coupon", () => {
    const expanded = { ...subscription({ coupon: "coupon_half_off" }), customer: { id: "cus_9", object: "customer" } } as unknown as Stripe.Subscription;
    expect(providerSubscriptionFromStripe(expanded, readAt)).toMatchObject({ customerId: "cus_9", discountRef: "coupon_half_off" });
    // An unexpanded discount names no coupon.
    expect(providerSubscriptionFromStripe({ ...subscription({ coupon: "coupon_half_off" }), discounts: ["di_1"] } as Stripe.Subscription, readAt).discountRef).toBeNull();
  });

  it("ends at cancel_at, or at the period's end when set to cancel then, and says when it ended", () => {
    expect(providerSubscriptionFromStripe(subscription({ cancelAt: now + 86_400 }), readAt).cancelAt).toEqual(at(now + 86_400));
    expect(providerSubscriptionFromStripe(subscription({ cancelAtPeriodEnd: true }), readAt).cancelAt).toEqual(at(now + 30 * 86_400));
    expect(providerSubscriptionFromStripe(subscription(), readAt)).toMatchObject({ cancelAt: null, endedAt: null });
    expect(providerSubscriptionFromStripe(subscription({ status: "canceled", endedAt: now }), readAt).endedAt).toEqual(at(now));
  });

  it("names the schedule's next phase when it moves to another price, and no change when it keeps the price", () => {
    const scheduled = { ...subscription(), schedule: stripeScheduleObject({ id: "sub_sched_1", subscription: "sub_1", phases: [{ start: now - 86_400, end: now + 30 * 86_400, price: "price_pro_monthly" }, { start: now + 30 * 86_400, end: null, price: "price_starter_monthly" }] }) } as Stripe.Subscription;
    expect(providerSubscriptionFromStripe(scheduled, readAt).next).toEqual({ priceRef: "price_starter_monthly", at: at(now + 30 * 86_400) });
    const same = { ...subscription(), schedule: stripeScheduleObject({ id: "sub_sched_2", subscription: "sub_1", phases: [{ start: now + 30 * 86_400, end: null, price: "price_pro_monthly" }] }) } as Stripe.Subscription;
    expect(providerSubscriptionFromStripe(same, readAt).next).toBeNull();
    // A schedule that came back as its ID can't say.
    expect(providerSubscriptionFromStripe(subscription({ schedule: "sub_sched_3" }), readAt).next).toBeNull();
  });

  it("names an upgrade waiting for its payment, with the invoice's page", () => {
    const waiting = { ...subscription({ pendingUpdateExpiresAt: now + 82_800 }), latest_invoice: stripeInvoiceObject({ id: "in_1", customer: "cus_1", subscription: "sub_1", hostedInvoiceUrl: "https://invoice.stripe.com/i/in_1" }) } as Stripe.Subscription;
    expect(providerSubscriptionFromStripe(waiting, readAt).pendingPayment).toEqual({ url: "https://invoice.stripe.com/i/in_1", expiresAt: at(now + 82_800) });
    expect(providerSubscriptionFromStripe(subscription({ pendingUpdateExpiresAt: now + 82_800, latestInvoice: "in_1" }), readAt).pendingPayment).toEqual({ url: null, expiresAt: at(now + 82_800) });
    expect(providerSubscriptionFromStripe(subscription(), readAt).pendingPayment).toBeNull();
  });

  it("keeps the metadata, which names the business and the checkout, and the time of the read", () => {
    const read = providerSubscriptionFromStripe(subscription({ metadata: { lobbystack_business: "b1", lobbystack_checkout: "r1" } }), readAt);
    expect(read).toMatchObject({ metadata: { lobbystack_business: "b1", lobbystack_checkout: "r1" }, readAt });
  });
});
