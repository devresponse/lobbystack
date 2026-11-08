import type Stripe from "stripe";

import type { StripeApi } from "../client";
import type { FakeStripeContext } from "./context";
import { invalid, missing } from "./errors";
import { stripeSubscriptionObject } from "./objects";

// Checkout Sessions, which only the checkout flow uses (the Stripe plan's
// step 13), and paying one, as the customer does on Stripe's page.

/** checkout.sessions.create, keeping each session as Stripe would. */
export function fakeCheckout(fake: FakeStripeContext): StripeApi["checkout"] {
  return {
    sessions: {
      async create(params: Stripe.Checkout.SessionCreateParams, options: Stripe.RequestOptions = {}) {
        return await fake.call("checkout.sessions.create", params, options.idempotencyKey ?? null, () => {
          if (params.customer && !fake.state.customers.has(params.customer)) throw missing("customer", params.customer, "customer");
          // Stripe's own answer, seen in a sandbox.
          const managed = (params as { managed_payments?: { enabled?: boolean } }).managed_payments?.enabled === true;
          if (managed && params.adaptive_pricing?.enabled === false) throw invalid("adaptive_pricing[enabled] must be `true` when Managed Payments is enabled.", "adaptive_pricing[enabled]");
          const id = fake.nextId("cs");
          const session = {
            id,
            object: "checkout.session",
            mode: params.mode,
            status: "open",
            customer: params.customer ?? null,
            customer_email: params.customer_email ?? null,
            client_reference_id: params.client_reference_id ?? null,
            metadata: { ...(params.metadata ?? {}) },
            url: `https://checkout.stripe.com/c/pay/${id}`,
            expires_at: params.expires_at ?? fake.clock.now() + 24 * 60 * 60,
            subscription: null,
            line_items: params.line_items,
            discounts: params.discounts ?? [],
            subscription_data: params.subscription_data ?? null,
            managed_payments: { enabled: managed },
            livemode: false,
          } as unknown as Stripe.Checkout.Session;
          fake.state.checkoutSessions.set(id, session);
          return session;
        });
      },
    } as unknown as StripeApi["checkout"]["sessions"],
  };
}

/**
 * Pays a session with a card, as the customer does: the subscription it makes
 * on the first line item's price, with any metered prices after it, the
 * session's coupon and the subscription metadata, and the card as its default
 * payment method, which the API can't change under Managed Payments.
 */
export function completeFakeCheckout(fake: FakeStripeContext, sessionId: string, input: { card?: string } = {}): Stripe.Subscription {
  const session = fake.state.checkoutSessions.get(sessionId) as (Stripe.Checkout.Session & { line_items?: Array<{ price: string }>; discounts?: Array<{ coupon?: string }>; subscription_data?: { metadata?: Record<string, string> }; managed_payments?: { enabled: boolean } }) | undefined;
  if (!session) throw missing("checkout.session", sessionId);
  const price = fake.state.catalog.prices.find((entry) => entry.id === session.line_items?.[0]?.price);
  const id = fake.nextId("sub");
  const subscription = {
    ...stripeSubscriptionObject({ id, customer: typeof session.customer === "string" ? session.customer : "cus_fake", price: session.line_items?.[0]?.price ?? "price_fake", ...(price?.recurring?.interval === "year" ? { interval: "year" as const } : {}), coupon: session.discounts?.[0]?.coupon ?? null, metadata: session.subscription_data?.metadata ?? {}, overagePrices: (session.line_items ?? []).slice(1).map((item) => item.price) }, fake.clock.now()),
    default_payment_method: input.card ?? "pm_card_visa",
  } as unknown as Stripe.Subscription;
  fake.state.subscriptions.set(id, subscription);
  if (session.managed_payments?.enabled) fake.state.managedPayments.add(id);
  fake.state.checkoutSessions.set(sessionId, { ...session, status: "complete", subscription: id } as Stripe.Checkout.Session);
  return subscription;
}
