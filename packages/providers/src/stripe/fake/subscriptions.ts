import type Stripe from "stripe";

import type { StripeApi } from "../client";
import { idOf, type FakeStripeContext } from "./context";
import { invalid, missing } from "./errors";
import { stripeInvoiceObject, stripeSubscriptionObject } from "./objects";
import { updateWithPayment } from "./pendingUpdates";

/** The subscription as Stripe answers a read: the objects named in expand in full, the rest by ID. */
function expanded(fake: FakeStripeContext, subscription: Stripe.Subscription, expand: readonly string[]): Stripe.Subscription {
  const schedule = typeof subscription.schedule === "string" && expand.includes("schedule") ? fake.state.schedules.get(subscription.schedule) ?? subscription.schedule : subscription.schedule;
  const invoice = typeof subscription.latest_invoice === "string" && expand.includes("latest_invoice") ? fake.state.invoices.get(subscription.latest_invoice) ?? subscription.latest_invoice : subscription.latest_invoice;
  const discounts = expand.includes("discounts") ? subscription.discounts : subscription.discounts.map((discount) => idOf(discount)!);
  return { ...subscription, schedule, latest_invoice: invoice, discounts } as Stripe.Subscription;
}

/** subscriptions.retrieve, create, update, list and cancel, on the fake's subscriptions. */
export function fakeSubscriptions(fake: FakeStripeContext): StripeApi["subscriptions"] {
  return {
    /** Items on prices the account sells; a metered price needs its meter. Anchored as billing_cycle_anchor_config says. */
    async create(params: Stripe.SubscriptionCreateParams, options: Stripe.RequestOptions = {}) {
      return await fake.call("subscriptions.create", params, options.idempotencyKey ?? null, () => {
        if (!params.customer || !fake.state.customers.has(params.customer)) throw missing("customer", params.customer ?? "", "customer");
        const prices = (params.items ?? []).map((item) => fake.state.catalog.prices.find((price) => price.id === item.price && price.active));
        if (!prices.length || prices.some((price) => !price)) throw invalid("Each item needs an active price.", "items");
        const metered = prices.filter((price) => price!.recurring?.usage_type === "metered").map((price) => price!.id);
        const licensed = prices.find((price) => price!.recurring?.usage_type !== "metered");
        const now = fake.clock.now();
        // The next 1st at the anchor's time, in UTC.
        const anchor = params.billing_cycle_anchor_config ? (() => { const at = new Date(now * 1000); return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, params.billing_cycle_anchor_config!.day_of_month, params.billing_cycle_anchor_config!.hour ?? 0, params.billing_cycle_anchor_config!.minute ?? 0, params.billing_cycle_anchor_config!.second ?? 0) / 1000; })() : null;
        const id = fake.nextId("sub");
        const made = {
          ...stripeSubscriptionObject({ id, customer: params.customer, ...(licensed ? { price: licensed.id } : {}), overagePrices: metered, periodStart: now, ...(anchor ? { periodEnd: anchor } : {}), metadata: (params.metadata ?? {}) as Record<string, string> }, now),
          ...(licensed ? {} : { items: { object: "list", data: metered.map((price, index) => ({ id: `si_${id}_${index}`, object: "subscription_item", price: { id: price, object: "price", recurring: { interval: "month", interval_count: 1, usage_type: "metered", meter: null }, metadata: {} }, current_period_start: now, current_period_end: anchor ?? now + 30 * 86_400, subscription: id, metadata: {} })), has_more: false } }),
          billing_cycle_anchor: anchor ?? now,
          default_payment_method: params.default_payment_method ?? null,
        } as unknown as Stripe.Subscription;
        fake.state.subscriptions.set(id, made);
        return made;
      });
    },
    /**
     * Its items, discounts and cycle, with a payment when the change invoices
     * now (pendingUpdates.ts), and its end, metadata and default card. One
     * that ended takes none of them, and one a schedule holds takes no end.
     */
    async update(id: string, params: Stripe.SubscriptionUpdateParams = {}, options: Stripe.RequestOptions = {}) {
      return await fake.call("subscriptions.update", { id, ...params }, options.idempotencyKey ?? null, () => {
        const found = fake.state.subscriptions.get(id);
        if (!found) throw missing("subscription", id);
        if (found.status === "canceled") throw invalid("A canceled subscription can only update its cancellation_details and metadata.");
        if (found.schedule && (params.cancel_at_period_end !== undefined || params.cancel_at !== undefined)) throw invalid(`The subscription is managed by the subscription schedule \`${idOf(found.schedule)}\`, and updating any cancelation behavior directly is not allowed. Please update the schedule instead.`);
        const changes = params.items?.length || params.discounts !== undefined || params.billing_cycle_anchor?.type === "now";
        const base = changes ? updateWithPayment(fake, found, params) : { ...found, metadata: { ...found.metadata, ...((params.metadata ?? {}) as Record<string, string>) } } as Stripe.Subscription;
        const updated = {
          ...base,
          ...(params.cancel_at_period_end !== undefined ? { cancel_at_period_end: params.cancel_at_period_end } : {}),
          ...(params.cancel_at !== undefined ? { cancel_at: params.cancel_at === "" ? null : params.cancel_at } : {}),
          ...(params.default_payment_method !== undefined ? { default_payment_method: params.default_payment_method === "" ? null : params.default_payment_method } : {}),
        } as Stripe.Subscription;
        fake.state.subscriptions.set(id, updated);
        return expanded(fake, updated, params.expand ?? []);
      });
    },
    /** A customer's subscriptions; status all includes the ended ones, and expand names data.latest_invoice and the like. */
    async list(params: Stripe.SubscriptionListParams = {}) {
      return await fake.call("subscriptions.list", params, null, () => {
        const expand = (params.expand ?? []).map((path) => path.replace(/^data\./, ""));
        const data = [...fake.state.subscriptions.values()].filter((subscription) => (!params.customer || subscription.customer === params.customer) && (params.status === "all" || subscription.status !== "canceled")).map((subscription) => expanded(fake, subscription, expand));
        return { object: "list", data, has_more: false, url: "/v1/subscriptions" };
      });
    },
    async retrieve(id: string, params: Stripe.SubscriptionRetrieveParams = {}) {
      return await fake.call("subscriptions.retrieve", { id, ...params }, null, () => {
        const found = fake.state.subscriptions.get(id);
        if (!found) throw missing("subscription", id);
        return expanded(fake, found, params.expand ?? []);
      });
    },
    /** Ends it now; with invoice_now, its last invoice is made. One that already ended is refused. */
    async cancel(id: string, params: Stripe.SubscriptionCancelParams = {}, options: Stripe.RequestOptions = {}) {
      return await fake.call("subscriptions.cancel", { id, ...params }, options.idempotencyKey ?? null, () => {
        const found = fake.state.subscriptions.get(id);
        if (!found) throw missing("subscription", id);
        if (found.status === "canceled" || found.status === "incomplete_expired") throw invalid("This subscription has already been canceled.");
        const now = fake.clock.now();
        const ended = { ...found, status: "canceled", canceled_at: now, ended_at: now, cancel_at: null, cancel_at_period_end: false, cancellation_details: { comment: null, feedback: null, reason: "cancellation_requested" } } as Stripe.Subscription;
        fake.state.subscriptions.set(id, ended);
        if (params.invoice_now) {
          const invoice = stripeInvoiceObject({ id: fake.nextId("in"), customer: idOf(found.customer) ?? "", subscription: id, status: "open" });
          fake.state.invoices.set(invoice.id, invoice);
        }
        return ended;
      });
    },
  } as unknown as StripeApi["subscriptions"];
}
