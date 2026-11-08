import type Stripe from "stripe";

import type { BillingProvider } from "../billing/types";
import { stripeLocale, type StripeApi } from "./client";
import { stripeOveragePrices } from "./overage";

// Checkout Sessions for the plan subscription (the Stripe plan's step 13):
// one price with the plan's coupon, the checkout request named on the session
// and on the subscription it makes, an hour to pay, and Stripe Tax with the
// address and tax ID it needs. Promotion codes stay off: codes are
// LobbyStack's own, sold through a plan's coupon. Sold with Stripe as the
// merchant of record, overage is on the plan's own checkout: its three metered
// prices go beside the plan's, and Managed Payments is on.

/** How long a checkout page stays open. */
export const STRIPE_CHECKOUT_TTL_SECONDS = 60 * 60;

/**
 * A checkout page for the plan, on the business's customer when it has one.
 * Its expiry is to the minute, and part of the idempotency key: a job retried
 * within the minute gets the same page, and a later retry a new one, which
 * the request then shows instead.
 */
export async function createStripeCheckout(api: StripeApi, input: Parameters<BillingProvider["createCheckout"]>[0], now = new Date()): ReturnType<BillingProvider["createCheckout"]> {
  const metadata = { ...input.metadata, lobbystack_business: input.businessId, lobbystack_checkout: input.requestId, lobbystack_role: "plan" };
  const locale = stripeLocale(input.locale);
  const expiresAt = (Math.floor(now.getTime() / 60_000) + 1) * 60 + STRIPE_CHECKOUT_TTL_SECONDS;
  // Metered prices take no quantity: the meters count the usage.
  const overage = input.overageOnCheckout ? await stripeOveragePrices(api, input.overageOnCheckout.currency) : [];
  // The SDK's types don't name managed_payments yet; the API takes it.
  const params: Stripe.Checkout.SessionCreateParams & { managed_payments?: { enabled: boolean } } = {
    mode: "subscription",
    line_items: [{ price: input.price.ref, quantity: 1 }, ...overage.map((price) => ({ price }))],
    ...(input.price.discountRef ? { discounts: [{ coupon: input.price.discountRef }] } : {}),
    // The customer's address goes on the customer, where Stripe Tax reads it for every invoice after.
    ...(input.customer.id ? { customer: input.customer.id, customer_update: { address: "auto", name: "auto" } } : { customer_email: input.email }),
    client_reference_id: input.requestId,
    metadata,
    subscription_data: { metadata },
    expires_at: expiresAt,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    ...(locale ? { locale: locale as Stripe.Checkout.SessionCreateParams.Locale } : {}),
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    // Stripe as the merchant of record: it computes and files the tax, and the customer buys from Link.
    ...(input.merchantOfRecord ? { managed_payments: { enabled: true } } : {}),
  };
  const session = await api.checkout.sessions.create(params, { idempotencyKey: `checkout:${input.requestId}:${expiresAt}` });
  if (!session.url) throw new Error("Stripe made the checkout without a page to pay on.");
  return { id: session.id, url: session.url, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null };
}
