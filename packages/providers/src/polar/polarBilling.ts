import { assertCertificationBillingSandbox, assertCertificationRecipient } from "@lobbystack/shared";

export type PolarBillingConfig = {
  accessToken: string;
  organizationId: string;
  baseUrl?: string;
};

/** How Polar charges a plan change: invoice now, on the next invoice, from the next period, or a new period from today. */
export type PolarProrationBehavior = "invoice" | "prorate" | "next_period" | "reset";

/** A subscription as a plan change needs it. pendingProductId is the product a change waiting for the next period moves it to. */
export type PolarSubscription = { id: string; status: string; productId: string; cancelAtPeriodEnd: boolean; endedAt: string | null; pendingProductId: string | null; discountId: string | null; currentPeriodEnd: string | null };

/** A request Polar answered with an error: its status, and the error name in its body (such as AlreadyCanceledSubscription or insufficient_scope) when it gave one. */
export class PolarRequestError extends Error {
  constructor(readonly status: number, readonly errorName: string | null) {
    super(`Polar request failed with status ${status}.`);
    this.name = "PolarRequestError";
  }
}

type PolarSubscriptionBody = { id: string; status: string; product_id: string; cancel_at_period_end?: boolean; ended_at?: string | null; pending_update?: { product_id?: string | null } | null; discount_id?: string | null; current_period_end?: string | null };

function subscriptionFrom(body: PolarSubscriptionBody): PolarSubscription {
  return { id: body.id, status: body.status, productId: body.product_id, cancelAtPeriodEnd: body.cancel_at_period_end === true, endedAt: body.ended_at ?? null, pendingProductId: body.pending_update?.product_id ?? null, discountId: body.discount_id ?? null, currentPeriodEnd: body.current_period_end ?? null };
}

async function errorName(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

export class PolarBillingProvider {
  constructor(private readonly config: PolarBillingConfig) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    assertCertificationBillingSandbox(this.config.baseUrl ?? "https://api.polar.sh");
    const response = await fetch(`${this.config.baseUrl ?? "https://api.polar.sh"}${path}`, { ...init, signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${this.config.accessToken}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    if (!response.ok) {
      throw new PolarRequestError(response.status, await errorName(response));
    }
    return (await response.json()) as T;
  }

  /** The subscription, or null when Polar doesn't know it. Needs subscriptions:read or subscriptions:write. */
  async getSubscription(subscriptionId: string): Promise<PolarSubscription | null> {
    try {
      return subscriptionFrom(await this.request<PolarSubscriptionBody>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`));
    } catch (error) {
      if (error instanceof PolarRequestError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Moves a live subscription to another product, so a paying customer changes
   * plan without a second subscription. Polar charges it as prorationBehavior
   * says. Needs subscriptions:write.
   */
  async changeSubscriptionProduct(input: { subscriptionId: string; productId: string; prorationBehavior: PolarProrationBehavior; discountId?: string | null; metadata?: Record<string, string> }): Promise<PolarSubscription> {
    // discount_id only when asked: sent, even as null, it changes the discount too (from the next billing cycle).
    const body = { product_id: input.productId, proration_behavior: input.prorationBehavior, ...(input.discountId !== undefined ? { discount_id: input.discountId } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) };
    return subscriptionFrom(await this.request<PolarSubscriptionBody>(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, { method: "PATCH", body: JSON.stringify(body) }));
  }

  /** Cancels a subscription when its period ends, as when a promo plan ends with it. Needs subscriptions:write. */
  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<PolarSubscription> {
    return subscriptionFrom(await this.request<PolarSubscriptionBody>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "PATCH", body: JSON.stringify({ cancel_at_period_end: true }) }));
  }

  /** Removes a subscription's discount from its next billing cycle on. Needs subscriptions:write. */
  async removeSubscriptionDiscount(subscriptionId: string): Promise<PolarSubscription> {
    return subscriptionFrom(await this.request<PolarSubscriptionBody>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "PATCH", body: JSON.stringify({ discount_id: null }) }));
  }

  /**
   * A checkout page for one product. Discount codes typed into Polar's page
   * are off: a discount comes only with a promo plan, which the deployment's
   * own codes sell. A promo checkout names its plan's discount, and its
   * metadata is copied onto the subscription.
   */
  async createCheckout(input: { productId: string; customerEmail: string; externalCustomerId: string; successUrl: string; returnUrl: string; idempotencyKey?: string; promo?: { discountId: string | null; metadata: Record<string, string> } }): Promise<{ checkoutUrl: string; checkoutId: string }> {
    assertCertificationRecipient("email", input.customerEmail);
    const promo = input.promo ? { ...(input.promo.discountId ? { discount_id: input.promo.discountId } : {}), metadata: input.promo.metadata } : {};
    const result = await this.request<{ url: string; id: string }>(`/v1/checkouts/`, { method: "POST", ...(input.idempotencyKey ? { headers: { "idempotency-key": input.idempotencyKey } } : {}), body: JSON.stringify({ products: [input.productId], customer_email: input.customerEmail, external_customer_id: input.externalCustomerId, success_url: input.successUrl, return_url: input.returnUrl, customer_metadata: { externalCustomerId: input.externalCustomerId }, allow_discount_codes: false, ...promo }) });
    return { checkoutUrl: result.url, checkoutId: result.id };
  }

  async recordUsage(input: { eventName: string; externalCustomerId: string; quantity: number; timestamp: string; idempotencyKey: string; businessId: string; usageKind: string }): Promise<void> {
    await this.request("/v1/events/ingest", { method: "POST", body: JSON.stringify({ events: [{ name: input.eventName, external_customer_id: input.externalCustomerId, external_id: input.idempotencyKey, timestamp: input.timestamp, metadata: { quantity: input.quantity, businessId: input.businessId, usageKind: input.usageKind } }] }) });
  }

  async createCustomerPortalSession(input: { externalCustomerId: string; returnUrl: string }): Promise<{ url: string }> {
    const result = await this.request<{ customer_portal_url: string }>("/v1/customer-sessions/", { method: "POST", body: JSON.stringify({ external_customer_id: input.externalCustomerId, return_url: input.returnUrl }) });
    return { url: result.customer_portal_url };
  }
}
