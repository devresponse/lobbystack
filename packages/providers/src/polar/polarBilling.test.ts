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

    await expect(provider.createCheckout({ productId: "product-1", customer: { id: "customer-1" }, metadata: { lobbystack_business: "1" }, successUrl: "https://app.example/settings/plan?checkout=success", returnUrl: "https://app.example/settings/plan", idempotencyKey: "billing-checkout:request-1" })).resolves.toEqual({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });

    expect(fetchMock).toHaveBeenCalledWith("https://polar.example/v1/checkouts/", expect.objectContaining({ method: "POST" }));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("idempotency-key")).toBe("billing-checkout:request-1");
    expect(JSON.parse(String(request.body))).toEqual({ products: ["product-1"], customer_id: "customer-1", success_url: "https://app.example/settings/plan?checkout=success", return_url: "https://app.example/settings/plan", allow_discount_codes: false, metadata: { lobbystack_business: "1" } });
  });
  it("asks for Polar API version 2026-10 on every call, so a new Polar version changes nothing until this one moves", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "subscription-1", status: "active", product_id: "product-1", url: "https://polar.example/checkout-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    await provider.getSubscription("subscription-1");
    await provider.createCheckout({ productId: "product-1", customer: { id: "customer-1" }, metadata: { lobbystack_business: "1" }, successUrl: "https://app.example/settings/plan?checkout=success", returnUrl: "https://app.example/settings/plan", idempotencyKey: "billing-checkout:request-1" });
    await provider.recordUsage({ eventName: "billing.voice_minutes", externalCustomerId: "business:1", quantity: 1, timestamp: "2026-09-08T00:00:00.000Z", idempotencyKey: "voice:call-1", businessId: "1", usageKind: "voice_seconds" });

    expect(fetchMock.mock.calls.map(([, init]) => new Headers((init as RequestInit).headers).get("polar-version"))).toEqual(["2026-10", "2026-10", "2026-10"]);
  });
  it("makes a checkout out to an email and external ID when it has no customer, with nothing put on the customer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "checkout-1", url: "https://polar.example/checkout-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    await provider.createCheckout({ productId: "product-1", customer: { email: "owner@example.com", externalId: "business:1" }, metadata: { lobbystack_business: "1" }, successUrl: "https://app.example/settings/plan?checkout=success", returnUrl: "https://app.example/settings/plan" });

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ products: ["product-1"], customer_email: "owner@example.com", external_customer_id: "business:1", success_url: "https://app.example/settings/plan?checkout=success", return_url: "https://app.example/settings/plan", allow_discount_codes: false, metadata: { lobbystack_business: "1" } });
  });
  it("finds a customer by its external ID, and one Polar doesn't have as null", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "customer-1", external_id: "business:1", email: "owner@example.com" }) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "ResourceNotFound", detail: "Not found" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    await expect(provider.findCustomerByExternalId("business:1")).resolves.toEqual({ id: "customer-1", externalId: "business:1" });
    await expect(provider.findCustomerByExternalId("business:2")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://polar.example/v1/customers/external/business%3A1", expect.not.objectContaining({ method: expect.anything() }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://polar.example/v1/customers/external/business%3A2", expect.anything());
  });
  it("makes a customer with its external ID, email and a name Polar accepts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "customer-1", external_id: "business:1", email: "owner@example.com" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    await expect(provider.createCustomer({ externalId: "business:1", email: "owner@example.com", name: "x".repeat(300) })).resolves.toEqual({ id: "customer-1", externalId: "business:1" });
    await provider.createCustomer({ externalId: "business:2", email: "billing@example.com", name: null });

    expect(fetchMock).toHaveBeenCalledWith("https://polar.example/v1/customers/", expect.objectContaining({ method: "POST" }));
    const body = (index: number) => JSON.parse(String((fetchMock.mock.calls[index]?.[1] as RequestInit).body)) as unknown;
    expect(body(0)).toEqual({ external_id: "business:1", email: "owner@example.com", name: "x".repeat(256) });
    expect(body(1)).toEqual({ external_id: "business:2", email: "billing@example.com" });
  });
  it("names the fields a refused body points at", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ error: "PolarRequestValidationError", detail: [{ type: "value_error", loc: ["body", "email"], msg: "A customer with this email address already exists.", input: "owner@example.com" }, { type: "value_error", loc: ["body", "external_id"], msg: "A customer with this external ID already exists.", input: "business:1" }] }) })
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ error: "RequestValidationError", detail: [{ type: "value_error", loc: ["body", "individual", "email"], msg: "value is not a valid email address" }] }) }));
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });
    const create = async () => await provider.createCustomer({ externalId: "business:1", email: "owner@example.com", name: null }).catch((error: unknown) => error);

    await expect(create()).resolves.toMatchObject({ status: 422, errorName: "PolarRequestValidationError", fields: ["email", "external_id"] });
    await expect(create()).resolves.toMatchObject({ status: 422, errorName: "RequestValidationError", fields: ["email"] });
  });
  it("moves a subscription to another product with only the product and proration in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "sub-1", status: "active", product_id: "product-pro", cancel_at_period_end: false, ended_at: null, pending_update: null }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    await expect(provider.changeSubscriptionProduct({ subscriptionId: "sub-1", productId: "product-pro", prorationBehavior: "invoice" })).resolves.toEqual({ id: "sub-1", status: "active", productId: "product-pro", cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null, discountId: null, currentPeriodEnd: null });

    expect(fetchMock).toHaveBeenCalledWith("https://polar.example/v1/subscriptions/sub-1", expect.objectContaining({ method: "PATCH" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ product_id: "product-pro", proration_behavior: "invoice" });
  });

  it("sells a promo plan with its discount and metadata, and no typed code on top", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "checkout-2", url: "https://polar.example/checkout-2" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });
    const checkout = { productId: "product-promo", customer: { id: "customer-1" }, successUrl: "https://app.example/settings/plan?checkout=success", returnUrl: "https://app.example/settings/plan" };
    const metadata = { lobbystack_business: "1", lobbystack_plan: "salons-half-off", lobbystack_checkout: "request-2" };

    await provider.createCheckout({ ...checkout, discountId: "discount-1", metadata });
    await provider.createCheckout({ ...checkout, discountId: null, metadata });

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

  it("cancels at the period's end and removes a discount, each with its own body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "sub-1", status: "active", product_id: "product-starter", cancel_at_period_end: true, ended_at: null, pending_update: null, discount_id: "discount-1", current_period_end: "2026-11-01T00:00:00Z" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PolarBillingProvider({ accessToken: "token", organizationId: "organization", baseUrl: "https://polar.example" });

    await expect(provider.cancelSubscriptionAtPeriodEnd("sub-1")).resolves.toMatchObject({ cancelAtPeriodEnd: true, discountId: "discount-1", currentPeriodEnd: "2026-11-01T00:00:00Z" });
    await provider.removeSubscriptionDiscount("sub-1");

    expect(fetchMock).toHaveBeenCalledWith("https://polar.example/v1/subscriptions/sub-1", expect.objectContaining({ method: "PATCH" }));
    const body = (index: number) => JSON.parse(String((fetchMock.mock.calls[index]?.[1] as RequestInit).body)) as unknown;
    expect(body(0)).toEqual({ cancel_at_period_end: true });
    expect(body(1)).toEqual({ discount_id: null });
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
