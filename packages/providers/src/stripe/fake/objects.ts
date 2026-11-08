import type Stripe from "stripe";

// Stripe objects as the API sends them, made for tests: only the fields the
// adapter reads are filled, the rest left out, so each builder casts.

const DAY = 24 * 60 * 60;

/** A plan or overage price: a licensed plan price, or a metered overage price with lobbystack_role overage. */
export function stripePriceObject(input: { id: string; interval?: "month" | "year"; overage?: boolean; product?: string }): Stripe.Price {
  return {
    id: input.id,
    object: "price",
    active: true,
    product: input.product ?? `prod_${input.id}`,
    recurring: { interval: input.interval ?? "month", interval_count: 1, usage_type: input.overage ? "metered" : "licensed", meter: null, trial_period_days: null },
    metadata: input.overage ? { lobbystack_role: "overage" } : { lobbystack_role: "plan" },
  } as unknown as Stripe.Price;
}

export type FakeSubscriptionInput = {
  id: string;
  customer?: string;
  status?: Stripe.Subscription.Status;
  /** The plan item's price. */
  price?: string;
  interval?: "month" | "year";
  /** The plan item's current period, in unix seconds. */
  periodStart?: number;
  periodEnd?: number;
  /** Metered overage prices on items of their own, as an overage subscription has them. */
  overagePrices?: string[];
  cancelAt?: number | null;
  cancelAtPeriodEnd?: boolean;
  endedAt?: number | null;
  /** A discount from this coupon. */
  coupon?: string | null;
  schedule?: string | null;
  /** An upgrade waiting for its payment until this time. */
  pendingUpdateExpiresAt?: number | null;
  latestInvoice?: string | null;
  metadata?: Record<string, string>;
};

/** A subscription with its items, discounts and the IDs of the objects it names. */
export function stripeSubscriptionObject(input: FakeSubscriptionInput, now: number): Stripe.Subscription {
  const periodStart = input.periodStart ?? now;
  const periodEnd = input.periodEnd ?? periodStart + (input.interval === "year" ? 365 : 30) * DAY;
  const item = (price: Stripe.Price, index: number) => ({ id: `si_${input.id}_${index}`, object: "subscription_item", price, quantity: price.recurring?.usage_type === "metered" ? undefined : 1, current_period_start: periodStart, current_period_end: periodEnd, subscription: input.id, metadata: {} });
  const prices = [
    stripePriceObject({ id: input.price ?? "price_starter_monthly", ...(input.interval ? { interval: input.interval } : {}) }),
    ...(input.overagePrices ?? []).map((id) => stripePriceObject({ id, overage: true })),
  ];
  return {
    id: input.id,
    object: "subscription",
    customer: input.customer ?? "cus_fake",
    status: input.status ?? "active",
    items: { object: "list", data: prices.map(item), has_more: false, url: `/v1/subscription_items?subscription=${input.id}` },
    cancel_at: input.cancelAt ?? null,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    canceled_at: null,
    ended_at: input.endedAt ?? null,
    discounts: input.coupon ? [{ id: `di_${input.id}`, object: "discount", source: { coupon: input.coupon, type: "coupon" }, subscription: input.id, start: periodStart, end: null }] : [],
    schedule: input.schedule ?? null,
    pending_update: input.pendingUpdateExpiresAt ? { billing_cycle_anchor: null, expires_at: input.pendingUpdateExpiresAt, subscription_items: null, trial_end: null, trial_from_plan: null } : null,
    latest_invoice: input.latestInvoice ?? null,
    metadata: { ...(input.metadata ?? {}) },
    livemode: false,
    created: periodStart,
  } as unknown as Stripe.Subscription;
}

/** A schedule whose phases move the subscription from one price to the next at each phase's start. */
export function stripeScheduleObject(input: { id: string; subscription: string; phases: Array<{ start: number; end: number | null; price: string }> }): Stripe.SubscriptionSchedule {
  return {
    id: input.id,
    object: "subscription_schedule",
    subscription: input.subscription,
    status: "active",
    end_behavior: "release",
    phases: input.phases.map((phase) => ({ start_date: phase.start, end_date: phase.end, items: [{ price: phase.price, quantity: 1 }] })),
  } as unknown as Stripe.SubscriptionSchedule;
}

/** An invoice, with its hosted page. */
export function stripeInvoiceObject(input: { id: string; customer: string; subscription: string | null; status?: Stripe.Invoice.Status; amountDue?: number; hostedInvoiceUrl?: string | null }): Stripe.Invoice {
  return {
    id: input.id,
    object: "invoice",
    customer: input.customer,
    parent: input.subscription ? { type: "subscription_details", subscription_details: { subscription: input.subscription, metadata: {} } } : null,
    status: input.status ?? "open",
    amount_due: input.amountDue ?? 0,
    hosted_invoice_url: input.hostedInvoiceUrl === undefined ? `https://invoice.stripe.com/i/${input.id}` : input.hostedInvoiceUrl,
    lines: { object: "list", data: [], has_more: false, url: `/v1/invoices/${input.id}/lines` },
    livemode: false,
  } as unknown as Stripe.Invoice;
}
