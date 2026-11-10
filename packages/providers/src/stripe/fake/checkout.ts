import type Stripe from "stripe";

import type { StripeApi } from "../client";
import type { FakeStripeContext } from "./context";
import { invalid, missing } from "./errors";
import { stripeInvoiceObject, stripeSubscriptionObject } from "./objects";

// Checkout Sessions, which only the checkout flows use (the Stripe plan's
// step 13, and a prepaid pack's checkout in payment mode), and paying one, as
// the customer does on Stripe's page.

/** A session as the fake keeps it: Stripe's object with the parameters the payment needs. */
type FakeSession = Stripe.Checkout.Session & {
  line_items?: Array<{ price: string; quantity?: number }>;
  discounts?: Array<{ coupon?: string }>;
  subscription_data?: { metadata?: Record<string, string> };
  managed_payments?: { enabled: boolean };
  payment_intent_data?: { metadata?: Record<string, string> } | null;
  invoice_creation?: { enabled: boolean; invoice_data?: { metadata?: Record<string, string> } } | null;
};

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
          // Each mode's own parameters, which Stripe refuses in the other.
          const payment = params.mode === "payment";
          if (payment && params.subscription_data) throw invalid("subscription_data can only be used in subscription mode.", "subscription_data");
          if (!payment && params.payment_intent_data) throw invalid("payment_intent_data can only be used in payment mode.", "payment_intent_data");
          if (!payment && params.invoice_creation) throw invalid("invoice_creation can only be used in payment mode.", "invoice_creation");
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
            // A payment's own fields: its PaymentIntent, and the invoice invoice_creation makes once it's paid.
            ...(payment ? { payment_status: "unpaid", payment_intent: null, invoice: null, payment_intent_data: params.payment_intent_data ?? null, invoice_creation: params.invoice_creation ?? null } : {}),
            livemode: false,
          } as unknown as Stripe.Checkout.Session;
          fake.state.checkoutSessions.set(id, session);
          return session;
        });
      },
      async retrieve(id: string) {
        return await fake.call("checkout.sessions.retrieve", { id }, null, () => {
          const session = fake.state.checkoutSessions.get(id);
          if (!session) throw missing("checkout.session", id);
          return session;
        });
      },
      /** Stripe expires only an open session; its refusal of any other, seen in a sandbox. */
      async expire(id: string) {
        return await fake.call("checkout.sessions.expire", { id }, null, () => {
          const session = fake.state.checkoutSessions.get(id);
          if (!session) throw missing("checkout.session", id);
          if (session.status !== "open") throw invalid(`Only Checkout Sessions with a status in ["open"] can be expired.`);
          const expired = { ...session, status: "expired", url: null } as Stripe.Checkout.Session;
          fake.state.checkoutSessions.set(id, expired);
          return expired;
        });
      },
    } as unknown as StripeApi["checkout"]["sessions"],
  };
}

/**
 * Pays a session with a card, as the customer does: the subscription it makes
 * on the first line item's price, with any metered prices after it, the
 * session's coupon and the subscription metadata, and the card as its default
 * payment method, which the API can't change under Managed Payments. A
 * payment-mode session makes no subscription: completeFakePaymentCheckout
 * pays it.
 */
export function completeFakeCheckout(fake: FakeStripeContext, sessionId: string, input: { card?: string } = {}): Stripe.Subscription {
  const session = fake.state.checkoutSessions.get(sessionId) as FakeSession | undefined;
  if (!session) throw missing("checkout.session", sessionId);
  if (session.mode === "payment") throw new Error(`${sessionId} is a payment-mode session, which makes no subscription. Pay it with completePaymentCheckout.`);
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

/**
 * Pays a payment-mode session with a card, as the customer does on Stripe's
 * page: a succeeded PaymentIntent for the line item's price, carrying the
 * session's payment_intent_data metadata, and, when the session asked for
 * one, the paid invoice invoice_creation makes, which the payment paid. The
 * session completes, paid, naming both.
 */
export function completeFakePaymentCheckout(fake: FakeStripeContext, sessionId: string, input: { card?: string } = {}): Stripe.PaymentIntent {
  const session = fake.state.checkoutSessions.get(sessionId) as FakeSession | undefined;
  if (!session) throw missing("checkout.session", sessionId);
  if (session.mode !== "payment") throw new Error(`${sessionId} is a ${session.mode}-mode session. Pay it with completeCheckout.`);
  const item = session.line_items?.[0];
  const price = fake.state.catalog.prices.find((entry) => entry.id === item?.price);
  const amount = (price?.unit_amount ?? 0) * (item?.quantity ?? 1);
  const currency = price?.currency ?? "cad";
  const customer = typeof session.customer === "string" ? session.customer : null;
  const id = fake.nextId("pi");
  const paymentIntent = {
    id,
    object: "payment_intent",
    amount,
    amount_received: amount,
    currency,
    customer,
    status: "succeeded",
    payment_method: input.card ?? "pm_card_visa",
    latest_charge: fake.nextId("ch"),
    metadata: { ...(session.payment_intent_data?.metadata ?? {}) },
    created: fake.clock.now(),
    livemode: false,
  } as unknown as Stripe.PaymentIntent;
  fake.state.paymentIntents.set(id, paymentIntent);
  let invoice: string | null = null;
  if (session.invoice_creation?.enabled) {
    invoice = fake.nextId("in");
    fake.state.invoices.set(invoice, { ...stripeInvoiceObject({ id: invoice, customer: customer ?? "cus_fake", subscription: null, status: "paid" }), amount_paid: amount, currency, metadata: { ...(session.invoice_creation.invoice_data?.metadata ?? {}) } } as unknown as Stripe.Invoice);
    fake.state.invoicePayments.push({ invoice, paymentIntent: id, status: "succeeded" });
  }
  fake.state.checkoutSessions.set(sessionId, { ...session, status: "complete", payment_status: "paid", payment_intent: id, invoice, amount_total: amount, currency } as Stripe.Checkout.Session);
  return paymentIntent;
}
