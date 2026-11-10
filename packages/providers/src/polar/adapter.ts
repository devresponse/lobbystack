import { getPolarMeteredUsagePayload, type PlanChangeRefusal } from "@lobbystack/shared";
import { reportWarning } from "@lobbystack/telemetry/node";
import { BillingProviderError } from "../billing/errors";
import type { BillingEnv, BillingProvider, BillingRefusal, CustomerRef, PlanChangeProration, PlanChangeResult, PriceRef, ProviderSubscription } from "../billing/types";
import { usageKindOf } from "../billing/usage";
import { PolarRequestError, type PolarBillingProvider, type PolarProrationBehavior, type PolarSubscription } from "./polarBilling";

// Polar behind the billing provider interface (ADR 0010): the same requests the
// worker made before the seam, which the worker's recorded-requests test keeps.

/** The Polar client calls the adapter makes. A test passes only the ones its flow needs. */
export type PolarBillingClient = Pick<PolarBillingProvider, "recordUsage"> & Partial<Pick<PolarBillingProvider, "createCheckout" | "findCustomerByExternalId" | "createCustomer" | "getSubscription" | "changeSubscriptionProduct" | "cancelSubscriptionAtPeriodEnd" | "moveSubscriptionPeriodEnd" | "removeSubscriptionDiscount" | "revokeSubscription" | "createCustomerPortalSession">>;

const polarStates: Record<string, ProviderSubscription["state"]> = {
  incomplete: "incomplete",
  incomplete_expired: "ended",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  canceled: "canceled",
};

/** A Polar subscription as the interface shows one. Polar's reads name no customer, interval or start of period. */
export function providerSubscriptionFromPolar(subscription: PolarSubscription, readAt = new Date()): ProviderSubscription {
  const periodEnd = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  return {
    id: subscription.id,
    customerId: null,
    state: polarStates[subscription.status] ?? "ended",
    priceRef: subscription.productId,
    interval: null,
    discountRef: subscription.discountId,
    periodStart: null,
    periodEnd,
    // Polar ends a subscription set to cancel at its period's end.
    cancelAt: subscription.cancelAtPeriodEnd ? periodEnd ?? readAt : null,
    endedAt: subscription.endedAt ? new Date(subscription.endedAt) : null,
    next: subscription.pendingProductId ? { priceRef: subscription.pendingProductId, at: periodEnd ?? readAt } : null,
    pendingPayment: null,
    metadata: {},
    readAt,
  };
}

/** billing.json's words for a plan change, Polar's own: invoice, prorate, next_period and reset. */
export function polarProrationBehavior(input: { when: "now" | "renewal"; proration: PlanChangeProration }): PolarProrationBehavior {
  if (input.when === "renewal") return "next_period";
  if (input.proration === "invoice_now") return "invoice";
  if (input.proration === "next_invoice") return "prorate";
  if (input.proration === "restart") return "reset";
  throw new BillingProviderError("polar", "not_supported", "Polar can't change a plan now without charging for it.");
}

/** Polar's answer to a plan change as the refusal to tell the business, or undefined when trying again may work. */
function planChangeRefusalFor(error: unknown): PlanChangeRefusal | undefined {
  if (!(error instanceof PolarRequestError)) return undefined;
  if (error.status === 401 || error.errorName === "insufficient_scope" || error.errorName === "invalid_token") return "token_scope";
  if (error.status === 402) return "payment_failed";
  if (error.status === 403 && error.errorName === "AlreadyCanceledSubscription") return "subscription_ending";
  if (error.status === 403 || error.status === 404) return "subscription_unavailable";
  if (error.status === 409) return "change_pending";
  if (error.status === 422) return "product_unavailable";
  return undefined;
}

/**
 * Polar's refusal of a new customer's email: one another customer has, as
 * Polar keeps one customer per email, or one it doesn't take as an email.
 */
function billingEmailRefusalFor(error: unknown): "billing_email_taken" | "billing_email_invalid" | undefined {
  if (!(error instanceof PolarRequestError) || error.status !== 422 || !error.fields.includes("email")) return undefined;
  // Polar's own check finds the email taken; the request's validation refuses one that isn't an email.
  return error.errorName === "PolarRequestValidationError" ? "billing_email_taken" : "billing_email_invalid";
}

export class PolarBilling implements BillingProvider {
  readonly id = "polar" as const;
  readonly env: BillingEnv;
  readonly account: string;
  readonly can = { uniqueCustomerEmail: true, meterMoney: false, separateOverage: false, readBack: false, inAppCancel: false };

  constructor(private readonly client: PolarBillingClient, options: { organizationId: string; env: BillingEnv }) {
    this.env = options.env;
    this.account = options.organizationId;
  }

  private unsupported(what: string): BillingProviderError {
    return new BillingProviderError("polar", "not_supported", `Polar billing can't ${what}.`);
  }

  /**
   * The business's own Polar customer, found or made by its billing key,
   * which usage and the billing portal name it by. Without one Polar picks a
   * customer by email at payment, so the second business of someone who pays
   * for two would land on the first's customer. A new customer gets the
   * billing email the person gave, else their own. Null when the worker's
   * token can't read or make customers, and the checkout then leaves the
   * customer to Polar, as before.
   */
  async findOrCreateCustomer(input: { customer: CustomerRef; businessId: string; email: string; name: string | null; locale: string | null; requestId: string }): Promise<{ id: string; created: boolean } | null> {
    if (!this.client.findCustomerByExternalId || !this.client.createCustomer) return null;
    const externalId = input.customer.billingKey;
    try {
      const found = await this.client.findCustomerByExternalId(externalId);
      if (found) return { id: found.id, created: false };
      try {
        return { id: (await this.client.createCustomer({ externalId, email: input.email, name: input.name })).id, created: true };
      } catch (error) {
        // Another run made it first.
        if (error instanceof PolarRequestError && error.status === 422 && error.fields.includes("external_id")) {
          const made = await this.client.findCustomerByExternalId(externalId);
          if (made) return { id: made.id, created: false };
        }
        throw error;
      }
    } catch (error) {
      if (!(error instanceof PolarRequestError) || error.errorName !== "insufficient_scope") throw error;
      await reportWarning(new Error("The worker's Polar token can't read or make customers, so Polar picks a checkout's customer by email. Give the worker's POLAR_ACCESS_TOKEN the customers:write scope."), { operation: "job.billing.createCheckout", businessId: input.businessId, requestId: input.requestId });
      return null;
    }
  }

  async createCheckout(input: { customer: CustomerRef; email: string; price: PriceRef; businessId: string; requestId: string; metadata: Record<string, string>; successUrl: string; cancelUrl: string; locale: string | null }): Promise<{ id: string; url: string; expiresAt: Date | null }> {
    if (!this.client.createCheckout) throw this.unsupported("make a checkout");
    const checkout = await this.client.createCheckout({
      productId: input.price.ref,
      customer: input.customer.id ? { id: input.customer.id } : { email: input.email, externalId: input.customer.billingKey },
      metadata: input.metadata,
      ...(input.price.discountRef ? { discountId: input.price.discountRef } : {}),
      successUrl: input.successUrl,
      // Polar's back arrow. Someone leaving checkout hasn't paid, so it
      // returns to the plan page without the success marker.
      returnUrl: input.cancelUrl,
    });
    return { id: checkout.checkoutId, url: checkout.checkoutUrl, expiresAt: null };
  }

  /**
   * The plan checkout's request for the pack's one-time product, with
   * metadata naming the business, the pack checkout and the role pack.
   * Polar's answer doesn't say when its page expires.
   */
  async createPackCheckout(input: Parameters<BillingProvider["createPackCheckout"]>[0]): Promise<{ id: string; url: string; expiresAt: Date | null }> {
    if (!this.client.createCheckout) throw this.unsupported("make a checkout");
    const checkout = await this.client.createCheckout({
      productId: input.price.ref,
      customer: input.customer.id ? { id: input.customer.id } : { email: input.email, externalId: input.customer.billingKey },
      metadata: { ...input.metadata, lobbystack_business: input.businessId, lobbystack_pack_checkout: input.checkoutId, lobbystack_role: "pack" },
      successUrl: input.successUrl,
      // Someone leaving checkout hasn't paid, so it returns to the plan page without the success marker.
      returnUrl: input.cancelUrl,
    });
    return { id: checkout.checkoutId, url: checkout.checkoutUrl, expiresAt: null };
  }

  async getSubscription(id: string): Promise<ProviderSubscription | null> {
    if (!this.client.getSubscription) return null;
    const subscription = await this.client.getSubscription(id);
    return subscription ? providerSubscriptionFromPolar(subscription) : null;
  }

  /** Polar's PATCH with the product and its proration word; discount_id only when the discount changes. */
  async changePlan(input: { subscriptionId: string; to: PriceRef; discount: "price" | "remove" | "keep"; when: "now" | "renewal"; proration: PlanChangeProration; metadata?: Record<string, string>; requestId: string }): Promise<PlanChangeResult> {
    if (!this.client.changeSubscriptionProduct) throw this.unsupported("change a plan");
    const discount = input.discount === "price" ? { discountId: input.to.discountRef } : input.discount === "remove" ? { discountId: null } : {};
    const subscription = await this.client.changeSubscriptionProduct({ subscriptionId: input.subscriptionId, productId: input.to.ref, prorationBehavior: polarProrationBehavior(input), ...discount, ...(input.metadata ? { metadata: input.metadata } : {}) });
    return { status: input.when === "renewal" ? "scheduled" : "changed", subscription: providerSubscriptionFromPolar(subscription) };
  }

  async cancel(input: { subscriptionId: string; when: "renewal" | "now"; requestId: string }): Promise<ProviderSubscription | null> {
    if (input.when === "now") {
      await this.revoke(input);
      return null;
    }
    if (!this.client.cancelSubscriptionAtPeriodEnd) throw this.unsupported("cancel a plan");
    return providerSubscriptionFromPolar(await this.client.cancelSubscriptionAtPeriodEnd(input.subscriptionId));
  }

  /** Polar's billing portal resumes a subscription, so the app doesn't. */
  async resume(): Promise<ProviderSubscription> {
    throw this.unsupported("resume a plan from the app; its billing portal does");
  }

  /** Polar's billing portal handles a change waiting for the renewal. */
  async keepPlan(): Promise<ProviderSubscription> {
    throw this.unsupported("drop a waiting change from the app; its billing portal does");
  }

  async endAtRenewal(input: { subscriptionId: string; then: PriceRef | "cancel"; requestId: string }): Promise<ProviderSubscription> {
    if (input.then === "cancel") return (await this.cancel({ subscriptionId: input.subscriptionId, when: "renewal", requestId: input.requestId }))!;
    if (!this.client.changeSubscriptionProduct) throw this.unsupported("change a plan");
    return providerSubscriptionFromPolar(await this.client.changeSubscriptionProduct({ subscriptionId: input.subscriptionId, productId: input.then.ref, prorationBehavior: "next_period", discountId: input.then.discountRef }));
  }

  async removeDiscount(input: { subscriptionId: string; requestId: string }): Promise<ProviderSubscription> {
    if (!this.client.removeSubscriptionDiscount) throw this.unsupported("remove a discount");
    return providerSubscriptionFromPolar(await this.client.removeSubscriptionDiscount(input.subscriptionId));
  }

  /** Polar's DELETE. One Polar no longer has, or that has already ended, counts as ended, as the client says. */
  async revoke(input: { subscriptionId: string; requestId: string }): Promise<"ended" | "already_ended"> {
    if (!this.client.revokeSubscription) throw this.unsupported("end a plan");
    await this.client.revokeSubscription(input.subscriptionId);
    return "ended";
  }

  /**
   * Polar settles a monthly plan's usage at a revoke only for plans with a
   * meter cycle, so a revoke would most likely drop the month's overage.
   * Instead the subscription is set to cancel at its period's end, and that
   * end moves to endsAt: the final order bills the period's usage and refunds
   * nothing. A retry finds both done, or gets AlreadyCanceledSubscription for
   * the cancel, and moves the end only while it is later than endsAt. Never a
   * revoke after the cancel: Polar refuses it with that same error, which
   * revokeSubscription takes as ended.
   */
  async endForPack(input: { subscriptionId: string; overageSubscriptionId: string | null; endsAt: Date; requestId: string }): Promise<ProviderSubscription | null> {
    if (!this.client.getSubscription || !this.client.cancelSubscriptionAtPeriodEnd || !this.client.moveSubscriptionPeriodEnd) throw this.unsupported("end a plan a prepaid pack replaced");
    let subscription = await this.client.getSubscription(input.subscriptionId);
    if (!subscription) return null;
    const read = providerSubscriptionFromPolar(subscription);
    if (read.endedAt || read.state === "canceled" || read.state === "ended") return null;
    if (!subscription.cancelAtPeriodEnd) {
      try {
        subscription = await this.client.cancelSubscriptionAtPeriodEnd(input.subscriptionId);
      } catch (error) {
        if (!(error instanceof PolarRequestError && error.status === 403 && error.errorName === "AlreadyCanceledSubscription")) throw error;
      }
    }
    const periodEnd = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
    if (periodEnd && periodEnd.getTime() > input.endsAt.getTime()) {
      try {
        subscription = await this.client.moveSubscriptionPeriodEnd(input.subscriptionId, input.endsAt);
      } catch (error) {
        // Polar's validation, such as an end no longer in the future; the next try asks with a later one.
        if (error instanceof PolarRequestError && error.status === 422) throw new BillingProviderError("polar", "refused", "Polar refused to move the end of the replaced subscription's period.", "retry");
        throw error;
      }
    }
    return providerSubscriptionFromPolar(subscription);
  }

  /** One event per send, named by its meter, in units (a call's seconds over 60). Polar prices it, so amountCents goes unused. */
  async reportUsage(input: { customer: CustomerRef; businessId: string; kind: "voice" | "alert_sms" | "transfer"; units: number; amountCents: number | null; occurredAt: Date; identifier: string }): Promise<"sent" | "duplicate"> {
    const usageKind = usageKindOf(input.kind);
    const metered = getPolarMeteredUsagePayload(usageKind, input.units);
    await this.client.recordUsage({ eventName: metered.eventName, externalCustomerId: input.customer.billingKey, quantity: metered.quantity, timestamp: input.occurredAt.toISOString(), idempotencyKey: input.identifier, businessId: input.businessId, usageKind });
    return "sent";
  }

  async createPortalSession(input: { customer: CustomerRef; returnUrl: string; locale: string | null }): Promise<{ url: string }> {
    if (!this.client.createCustomerPortalSession) throw this.unsupported("open the billing portal");
    return await this.client.createCustomerPortalSession({ externalCustomerId: input.customer.billingKey, returnUrl: input.returnUrl });
  }

  refusalFor(error: unknown): BillingRefusal | undefined {
    if (error instanceof BillingProviderError) return error.refusal;
    return billingEmailRefusalFor(error) ?? planChangeRefusalFor(error);
  }
}
