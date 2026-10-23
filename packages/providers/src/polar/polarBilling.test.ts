import { afterEach, describe, expect, it, vi } from "vitest";

import { PolarBillingProvider, PolarRequestError } from "./polarBilling";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PolarBillingProvider", () => {
  it("ingests named usage events with a stable external ID and no meter-ID configuration", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ inserted: 1, duplicates: 0 }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });
    await provider.recordUsage({ eventName: "billing.voice_minutes", externalCustomerId: "business:1", quantity: 1.5, timestamp: "2026-09-08T00:00:00.000Z", idempotencyKey: "voice:call-1", businessId: "1", usageKind: "voice_seconds" });
    expect(fetchMock).toHaveBeenCalledWith("https://polar.example/v1/events/ingest", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toEqual({ events: [{ name: "billing.voice_minutes", external_customer_id: "business:1", external_id: "voice:call-1", timestamp: "2026-09-08T00:00:00.000Z", metadata: { quantity: 1.5, businessId: "1", usageKind: "voice_seconds" } }] });
  });
  it("creates a checkout with the current Polar product-session payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "checkout-1", url: "https://polar.example/checkout-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    await expect(provider.createCheckout({ productId: "product-1", customerEmail: "owner@example.com", externalCustomerId: "business:1", successUrl: "https://app.example/settings/plan?checkout=success", returnUrl: "https://app.example/settings/plan", idempotencyKey: "billing-checkout:request-1" })).resolves.toEqual({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });

    expect(fetchMock).toHaveBeenCalledWith("https://polar.example/v1/checkouts/", expect.objectContaining({ method: "POST" }));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("idempotency-key")).toBe("billing-checkout:request-1");
    expect(JSON.parse(String(request.body))).toEqual({ products: ["product-1"], customer_email: "owner@example.com", external_customer_id: "business:1", success_url: "https://app.example/settings/plan?checkout=success", return_url: "https://app.example/settings/plan", customer_metadata: { externalCustomerId: "business:1" } });
  });
  it("moves a subscription to another product with only the product and proration in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "sub-1", status: "active", product_id: "product-pro", cancel_at_period_end: false, ended_at: null, pending_update: null }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    await expect(provider.changeSubscriptionProduct({ subscriptionId: "sub-1", productId: "product-pro", prorationBehavior: "invoice" })).resolves.toEqual({ id: "sub-1", status: "active", productId: "product-pro", cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null });

    expect(fetchMock).toHaveBeenCalledWith("https://polar.example/v1/subscriptions/sub-1", expect.objectContaining({ method: "PATCH" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ product_id: "product-pro", proration_behavior: "invoice" });
  });

  it("sells a promo plan with its discount and metadata, and no typed code on top", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "checkout-2", url: "https://polar.example/checkout-2" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });
    const checkout = { productId: "product-promo", customerEmail: "owner@example.com", externalCustomerId: "business:1", successUrl: "https://app.example/settings/plan?checkout=success", returnUrl: "https://app.example/settings/plan" };
    const metadata = { lobbystack_plan: "salons-half-off", lobbystack_checkout: "request-2" };

    await provider.createCheckout({ ...checkout, promo: { discountId: "discount-1", metadata } });
    await provider.createCheckout({ ...checkout, promo: { discountId: null, metadata } });

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ products: ["product-promo"], discount_id: "discount-1", allow_discount_codes: false, metadata });
    const plain = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(plain).toMatchObject({ allow_discount_codes: false, metadata });
    expect(plain).not.toHaveProperty("discount_id");
  });

  it("sends a discount with a product move only when asked, null removing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "sub-1", status: "active", product_id: "product-promo", cancel_at_period_end: false, ended_at: null, pending_update: null }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });
    const metadata = { lobbystack_plan: "salons-half-off", lobbystack_checkout: "request-2" };

    await provider.changeSubscriptionProduct({ subscriptionId: "sub-1", productId: "product-promo", prorationBehavior: "invoice", discountId: "discount-1", metadata });
    await provider.changeSubscriptionProduct({ subscriptionId: "sub-1", productId: "product-pro", prorationBehavior: "next_period", discountId: null });

    const body = (index: number) => JSON.parse(String((fetchMock.mock.calls[index]?.[1] as RequestInit).body)) as unknown;
    expect(body(0)).toEqual({ product_id: "product-promo", proration_behavior: "invoice", discount_id: "discount-1", metadata });
    expect(body(1)).toEqual({ product_id: "product-pro", proration_behavior: "next_period", discount_id: null });
  });

  it("reads a pending change's product, and a subscription Polar doesn't know as null", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "sub-1", status: "active", product_id: "product-pro", cancel_at_period_end: true, ended_at: null, pending_update: { product_id: "product-starter" } }) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "ResourceNotFound", detail: "Not found" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    await expect(provider.getSubscription("sub-1")).resolves.toMatchObject({ productId: "product-pro", cancelAtPeriodEnd: true, pendingProductId: "product-starter" });
    await expect(provider.getSubscription("sub-gone")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith("https://polar.example/v1/subscriptions/sub-gone", expect.anything());
  });

  it("keeps Polar's status and error name on a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "AlreadyCanceledSubscription", detail: "This subscription is already canceled or will be at the end of the period." }) }));
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    const refusal = await provider.changeSubscriptionProduct({ subscriptionId: "sub-1", productId: "product-pro", prorationBehavior: "invoice" }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PolarRequestError);
    expect(refusal).toMatchObject({ status: 403, errorName: "AlreadyCanceledSubscription", message: "Polar request failed with status 403." });
  });
});
