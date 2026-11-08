import type Stripe from "stripe";

import type { StripeApi } from "../client";
import { idOf, type FakeStripeContext } from "./context";
import { invalid, missing } from "./errors";
import { stripeInvoiceObject } from "./objects";

/** The subscription as Stripe answers a read: the objects named in expand in full, the rest by ID. */
function expanded(fake: FakeStripeContext, subscription: Stripe.Subscription, expand: readonly string[]): Stripe.Subscription {
  const schedule = typeof subscription.schedule === "string" && expand.includes("schedule") ? fake.state.schedules.get(subscription.schedule) ?? subscription.schedule : subscription.schedule;
  const invoice = typeof subscription.latest_invoice === "string" && expand.includes("latest_invoice") ? fake.state.invoices.get(subscription.latest_invoice) ?? subscription.latest_invoice : subscription.latest_invoice;
  const discounts = expand.includes("discounts") ? subscription.discounts : subscription.discounts.map((discount) => idOf(discount)!);
  return { ...subscription, schedule, latest_invoice: invoice, discounts } as Stripe.Subscription;
}

/** subscriptions.retrieve and subscriptions.cancel, on the fake's subscriptions. */
export function fakeSubscriptions(fake: FakeStripeContext): StripeApi["subscriptions"] {
  return {
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
        const ended = { ...found, status: "canceled", canceled_at: now, ended_at: now, cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
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
