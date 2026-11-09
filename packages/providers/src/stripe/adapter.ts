import type Stripe from "stripe";

import { isUuid } from "@lobbystack/shared";

import { BillingProviderError } from "../billing/errors";
import type { BillingEnv, BillingProvider, BillingRefusal, CustomerRef, OverageKind, PlanChangeProration, PlanChangeResult, PriceRef, ProviderSubscription } from "../billing/types";
import { cancelStripePlan, keepStripePlan, resumeStripePlan } from "./cancel";
import { createStripeCheckout } from "./checkout";
import { stripeLocale, type StripeApi } from "./client";
import { isStripeAlreadyCanceled, isStripeMissing, stripeRefusalFor } from "./errors";
import { endStripeOverage, ensureStripeOverage } from "./overage";
import { changeStripePlan, endStripePlanAtRenewal, removeStripeDiscount } from "./planChange";
import { providerSubscriptionFromStripe } from "./subscriptions";
import { creditStripeBalance, reportStripeUsage, stripeUsageCredits, stripeUsageTotals } from "./usage";

// Stripe behind the billing provider interface (ADR 0010). Step 9 of the
// Stripe plan brings the core: the customer, reading a subscription, the
// billing portal, ending a subscription and refusals. The other methods hand
// over to a module per flow, which answers not_supported until its step.

/** The business's customer with the business's own ID in its metadata; a customer naming another business isn't its. */
function ownCustomer(customer: Stripe.Customer | Stripe.DeletedCustomer, businessId: string): customer is Stripe.Customer {
  return !("deleted" in customer && customer.deleted) && customer.metadata?.lobbystack_business === businessId;
}

export class StripeBilling implements BillingProvider {
  readonly id = "stripe" as const;
  readonly env: BillingEnv;
  readonly account: string;
  // Stripe directly with a separate overage subscription: decisions 1 and 3 of the Stripe plan, as recommended.
  readonly can = { uniqueCustomerEmail: false, meterMoney: true, separateOverage: true, readBack: true, inAppCancel: true };
  private readonly portalConfiguration: string | null;
  private readonly deployment: string | null;

  /**
   * accountId is STRIPE_ACCOUNT_ID; portalConfiguration the billing portal's
   * configuration the catalog's link recorded, else Stripe's default one; and
   * deployment the name new customers' metadata carries, such as its address.
   */
  constructor(private readonly api: StripeApi, options: { accountId: string; env: BillingEnv; portalConfiguration?: string | null; deployment?: string | null }) {
    this.env = options.env;
    this.account = options.accountId;
    this.portalConfiguration = options.portalConfiguration ?? null;
    this.deployment = options.deployment ?? null;
  }

  /**
   * The business's own customer, by the ID the account holds, or a new one.
   * A deleted customer, or one whose metadata names another business, gets a
   * new one. Stripe keeps no customer per email, so emails may repeat and no
   * billing email refusal comes back. The idempotency key makes a retried job
   * get the same new customer.
   */
  async findOrCreateCustomer(input: { customer: CustomerRef; businessId: string; email: string; name: string | null; locale: string | null; requestId: string }): Promise<{ id: string; created: boolean }> {
    if (input.customer.id) {
      try {
        const found = await this.api.customers.retrieve(input.customer.id);
        if (ownCustomer(found, input.businessId)) return { id: found.id, created: false };
      } catch (error) {
        if (!isStripeMissing(error)) throw error;
      }
      return { id: (await this.createCustomer(input, ":2")).id, created: true };
    }
    return { id: (await this.createCustomer(input, "")).id, created: true };
  }

  private async createCustomer(input: { customer: CustomerRef; businessId: string; email: string; name: string | null; locale: string | null }, attempt: string): Promise<Stripe.Customer> {
    const locale = stripeLocale(input.locale);
    return await this.api.customers.create({
      email: input.email,
      ...(input.name ? { name: input.name } : {}),
      ...(locale ? { preferred_locales: [locale] } : {}),
      metadata: { lobbystack_business: input.businessId, lobbystack_billing_key: input.customer.billingKey, ...(this.deployment ? { lobbystack_deployment: this.deployment } : {}) },
    }, { idempotencyKey: `customer:${input.businessId}${attempt}` });
  }

  async createCheckout(input: Parameters<BillingProvider["createCheckout"]>[0]): Promise<{ id: string; url: string; expiresAt: Date | null }> {
    return await createStripeCheckout(this.api, input);
  }

  /** The subscription with its schedule, discounts and latest invoice, or null when Stripe has none by that ID. */
  async getSubscription(id: string): Promise<ProviderSubscription | null> {
    try {
      return providerSubscriptionFromStripe(await this.api.subscriptions.retrieve(id, { expand: ["schedule", "discounts", "latest_invoice"] }));
    } catch (error) {
      if (isStripeMissing(error)) return null;
      throw error;
    }
  }

  async changePlan(input: { subscriptionId: string; to: PriceRef; discount: "price" | "remove" | "keep"; when: "now" | "renewal"; proration: PlanChangeProration; metadata?: Record<string, string>; requestId: string }): Promise<PlanChangeResult> {
    return await changeStripePlan(this.api, input);
  }

  async cancel(input: { subscriptionId: string; when: "renewal" | "now"; requestId: string }): Promise<ProviderSubscription | null> {
    return await cancelStripePlan(this.api, input);
  }

  async resume(input: { subscriptionId: string; requestId: string }): Promise<ProviderSubscription> {
    return await resumeStripePlan(this.api, input);
  }

  async keepPlan(input: { subscriptionId: string; requestId: string }): Promise<ProviderSubscription> {
    return await keepStripePlan(this.api, input);
  }

  async endAtRenewal(input: { subscriptionId: string; then: PriceRef | "cancel"; requestId: string }): Promise<ProviderSubscription> {
    return await endStripePlanAtRenewal(this.api, input);
  }

  async removeDiscount(input: { subscriptionId: string; requestId: string }): Promise<ProviderSubscription> {
    return await removeStripeDiscount(this.api, input);
  }

  /**
   * Ends the subscription now, invoicing what it owes with no proration, as
   * for a business being deleted. One Stripe no longer has, or that already
   * ended, counts as ended.
   */
  async revoke(input: { subscriptionId: string; requestId: string }): Promise<"ended" | "already_ended"> {
    try {
      await this.api.subscriptions.cancel(input.subscriptionId, { invoice_now: true, prorate: false }, { idempotencyKey: `revoke:${input.subscriptionId}` });
      return "ended";
    } catch (error) {
      if (isStripeMissing(error) || isStripeAlreadyCanceled(error)) return "already_ended";
      throw error;
    }
  }

  /**
   * The key's own account, which must be STRIPE_ACCOUNT_ID: another
   * account's key would bill or look for the wrong customers. The factory
   * took only a key of the deployment's mode.
   */
  async checkAccount(): Promise<{ expected: string; found: string } | null> {
    const found = (await this.api.accounts.retrieveCurrent()).id;
    return found === this.account ? null : { expected: this.account, found };
  }

  async ensureOverage(input: Parameters<NonNullable<BillingProvider["ensureOverage"]>>[0]): Promise<{ subscriptionId: string } | { unpaidSubscriptionId: string }> {
    return await ensureStripeOverage(this.api, input);
  }

  async endOverage(input: { subscriptionId: string; when: "period_end" | "now" }): Promise<void> {
    await endStripeOverage(this.api, input);
  }

  async reportUsage(input: { customer: CustomerRef; businessId: string; kind: OverageKind; units: number; amountCents: number | null; occurredAt: Date; identifier: string }): Promise<"sent" | "duplicate"> {
    return await reportStripeUsage(this.api, input);
  }

  async usageTotals(input: { customerId: string; from: Date; to: Date }): Promise<Record<OverageKind, number>> {
    return await stripeUsageTotals(this.api, input);
  }

  async usageCredits(input: { customerId: string }): Promise<Record<OverageKind, number>> {
    return await stripeUsageCredits(this.api, input);
  }

  async creditBalance(input: { customerId: string; kind: OverageKind; cents: number; currency: string; identifier: string }): Promise<void> {
    await creditStripeBalance(this.api, input);
  }

  /**
   * The customer's currency, which Stripe sets from its first subscription:
   * under merchant of record, Adaptive Pricing bills a customer abroad in
   * their own, and a balance credit in another currency never reaches their
   * invoices. Null for a customer that's gone or not billed yet.
   */
  async customerCurrency(customerId: string): Promise<string | null> {
    const customer = await this.api.customers.retrieve(customerId);
    if ("deleted" in customer && customer.deleted) return null;
    return (customer as Stripe.Customer).currency ?? null;
  }

  /** Stripe's billing portal for the business's customer, with the deployment's configuration once a link recorded one, in the business's language when Stripe has it. */
  async createPortalSession(input: { customer: CustomerRef; returnUrl: string; locale: string | null }): Promise<{ url: string }> {
    if (!input.customer.id) throw new BillingProviderError("stripe", "not_found", "The business has no Stripe customer yet, so there's no billing portal to open.");
    const locale = stripeLocale(input.locale);
    const session = await this.api.billingPortal.sessions.create({
      customer: input.customer.id,
      return_url: input.returnUrl,
      ...(this.portalConfiguration ? { configuration: this.portalConfiguration } : {}),
      ...(locale ? { locale } : {}),
    });
    return { url: session.url };
  }

  /** The business the customer's metadata names, as findOrCreateCustomer writes it; null for a customer Stripe no longer has. */
  async businessOfCustomer(customerId: string): Promise<string | null> {
    try {
      const customer = await this.api.customers.retrieve(customerId);
      if ("deleted" in customer && customer.deleted) return null;
      const business = customer.metadata?.lobbystack_business;
      return business && isUuid(business) ? business : null;
    } catch (error) {
      if (isStripeMissing(error)) return null;
      throw error;
    }
  }

  /** The invoice a payment intent paid, through its invoice payment. */
  async invoiceOfPayment(paymentRef: string): Promise<string | null> {
    if (!paymentRef.startsWith("pi_")) return null;
    const page = await this.api.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: paymentRef }, limit: 1 });
    const invoice = page.data[0]?.invoice;
    return (typeof invoice === "string" ? invoice : invoice?.id) ?? null;
  }

  refusalFor(error: unknown): BillingRefusal | undefined {
    if (error instanceof BillingProviderError) return error.refusal;
    return stripeRefusalFor(error);
  }
}
