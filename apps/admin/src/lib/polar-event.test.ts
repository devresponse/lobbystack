import { describe, expect, it } from "vitest";
import { polarProductLinks, type BillingCatalogSnapshot } from "@lobbystack/domain";
import { normalizePolarEvent } from "./polar-event";

const variables = (env: Record<string, string>) => polarProductLinks({ plans: [], prices: [] }, env);

const businessId = "11111111-1111-4111-8111-111111111111";
describe("Polar payload normalization", () => {
  it("maps real subscription payloads to local billing fields", () => {
    const result = normalizePolarEvent("subscription.active", { id: "sub_1", status: "active", product_id: "pro_month", modified_at: "2026-09-01T12:00:00+00:00", customer: { id: "cust_1", external_id: `business:${businessId}` } }, variables({ POLAR_PRO_MONTHLY_PRODUCT_ID: "pro_month" }));
    expect(result.businessId).toBe(businessId);
    expect(result.businessReference).toBe(businessId);
    expect(result.payload).toMatchObject({ billingKey: `business:${businessId}`, customerId: "cust_1", subscriptionId: "sub_1", productId: "pro_month", subscriptionState: "active", plan: "pro", billingInterval: "monthly", subscriptionModifiedAt: "2026-09-01T12:00:00.000Z" });
  });
  it("preserves prefixed legacy references without treating them as UUIDs", () => {
    const result = normalizePolarEvent("subscription.active", { customer: { external_id: "business:legacy-customer" } });
    expect(result.businessId).toBeUndefined();
    expect(result.businessReference).toBe("legacy-customer");
  });
  it("resolves a migrated customer from its metadata rather than its stale external id", () => {
    // Polar reuses a customer by email, so a subscription bought after the
    // Postgres migration still arrives under the Convex id the customer was
    // created with. The current id is in the customer's metadata.
    const result = normalizePolarEvent("subscription.active", {
      id: "sub_1",
      status: "active",
      product_id: "starter_month",
      customer: {
        id: "cust_1",
        external_id: "business:kh797h57jgpq83314s4fj8ptmn866hbk",
        metadata: {
          businessId: "kh797h57jgpq83314s4fj8ptmn866hbk",
          externalCustomerId: `business:${businessId}`,
        },
      },
    }, variables({ POLAR_STARTER_MONTHLY_PRODUCT_ID: "starter_month" }));

    expect(result.businessId).toBe(businessId);
    expect(result.payload).toMatchObject({ plan: "starter", billingInterval: "monthly" });
  });

  it("gives a subscription to the business its checkout named, and names a customer that belongs to another", () => {
    // Before each business had its own customer, Polar matched a second
    // business's checkout to the first's customer by email.
    const buyer = "22222222-2222-4222-8222-222222222222";
    const subscription = normalizePolarEvent("subscription.active", { id: "sub_1", status: "active", product_id: "pro_month", metadata: { lobbystack_business: buyer }, customer: { id: "cust_1", external_id: `business:${businessId}` } }, variables({ POLAR_PRO_MONTHLY_PRODUCT_ID: "pro_month" }));
    expect(subscription).toMatchObject({ businessId: buyer, customerBusinessId: businessId });
    expect(subscription.payload).toMatchObject({ subscriptionId: "sub_1", plan: "pro" });

    const order = normalizePolarEvent("order.paid", { id: "order_1", status: "paid", customer: { external_id: `business:${businessId}` }, subscription: { id: "sub_1", status: "active", product_id: "pro_month", metadata: { lobbystack_business: buyer } } });
    expect(order).toMatchObject({ businessId: buyer, customerBusinessId: businessId });
  });

  it("names no other business when the checkout's and the customer's agree, and skips metadata that isn't an ID", () => {
    const agreeing = normalizePolarEvent("subscription.active", { id: "sub_1", status: "active", metadata: { lobbystack_business: businessId }, customer: { external_id: `business:${businessId}` } });
    expect(agreeing.businessId).toBe(businessId);
    expect(agreeing).not.toHaveProperty("customerBusinessId");

    const garbled = normalizePolarEvent("subscription.active", { id: "sub_1", status: "active", metadata: { lobbystack_business: "not-an-id" }, customer: { external_id: `business:${businessId}` } });
    expect(garbled.businessId).toBe(businessId);
    expect(garbled).not.toHaveProperty("customerBusinessId");
  });

  it("still reports a legacy reference when no field carries a usable id", () => {
    const result = normalizePolarEvent("subscription.active", {
      customer: {
        external_id: "business:kh797h57jgpq83314s4fj8ptmn866hbk",
        metadata: { businessId: "kh797h57jgpq83314s4fj8ptmn866hbk" },
      },
    });

    expect(result.businessId).toBeUndefined();
    expect(result.businessReference).toBe("kh797h57jgpq83314s4fj8ptmn866hbk");
  });

  it("uses subscription status rather than a paid order's status", () => {
    const result = normalizePolarEvent("order.paid", { id: "order_1", status: "paid", customer: { external_id: `business:${businessId}` }, subscription: { id: "sub_1", status: "active", product_id: "starter_year" } }, variables({ POLAR_STARTER_ANNUAL_PRODUCT_ID: "starter_year" }));
    expect(result.payload).toMatchObject({ subscriptionId: "sub_1", productId: "starter_year", subscriptionState: "active", plan: "starter", billingInterval: "annual" });
  });

  it("names the plan of a product the catalog links, a retired price's too, before the product variables", () => {
    const price = (plan: string, tier: string, period: "monthly" | "annual", polarId: string, retired = false) => ({ plan, tier, status: "active", period, currency: "cad", cents: 1, per_month: 1, polar_id: polarId, retired });
    const catalog: BillingCatalogSnapshot = { plans: [], prices: [price("pro", "pro", "annual", "prod_pro_year"), price("starter", "starter", "monthly", "prod_old", true), price("free_cloud", "free_cloud", "monthly", "prod_free")] };
    const links = polarProductLinks(catalog, { POLAR_STARTER_MONTHLY_PRODUCT_ID: "prod_pro_year", POLAR_PRO_MONTHLY_PRODUCT_ID: "prod_var" });
    const event = (productId: string) => normalizePolarEvent("subscription.updated", { id: "sub_1", status: "active", product_id: productId, customer: { external_id: `business:${businessId}` } }, links).payload;
    expect(event("prod_pro_year")).toMatchObject({ plan: "pro", billingInterval: "annual" });
    expect(event("prod_old")).toMatchObject({ plan: "starter", billingInterval: "monthly" });
    expect(event("prod_var")).toMatchObject({ plan: "pro", billingInterval: "monthly" });
    // A product of a tier Polar doesn't sell, or one nobody knows, names no plan, and reconcile holds its live subscription.
    expect(event("prod_free")).not.toHaveProperty("plan");
    expect(event("prod_unknown")).not.toHaveProperty("plan");
    expect(event("prod_unknown")).toMatchObject({ productId: "prod_unknown" });
  });

  it("names a promo plan's own code beside the tier it behaves as", () => {
    const price = (plan: string, tier: string, polarId: string) => ({ plan, tier, status: "active", period: "monthly" as const, currency: "cad", cents: 1, per_month: 1, polar_id: polarId, retired: false });
    const links = polarProductLinks({ plans: [], prices: [price("salons-half-off", "starter", "prod_promo"), price("starter", "starter", "prod_starter")] }, {});
    const event = (productId: string) => normalizePolarEvent("subscription.updated", { id: "sub_1", status: "active", product_id: productId, customer: { external_id: `business:${businessId}` } }, links).payload;
    expect(event("prod_promo")).toMatchObject({ plan: "starter", planCode: "salons-half-off", billingInterval: "monthly" });
    expect(event("prod_starter")).toMatchObject({ plan: "starter", planCode: "starter" });
  });

  it("names the subscription's discount, from a subscription or an order's", () => {
    const customer = { external_id: `business:${businessId}` };
    expect(normalizePolarEvent("subscription.updated", { id: "sub_1", status: "active", discount_id: "disc_1", customer }).payload).toMatchObject({ discountId: "disc_1" });
    expect(normalizePolarEvent("order.paid", { id: "ord_1", customer, subscription: { id: "sub_1", status: "active", discount_id: "disc_2" } }).payload).toMatchObject({ discountId: "disc_2" });
    expect(normalizePolarEvent("subscription.updated", { id: "sub_1", status: "active", discount_id: null, customer }).payload).not.toHaveProperty("discountId");
  });
});
