import { describe, expect, it } from "vitest";

import { StripeCatalogClient, stripeRef, type StripeCatalogStep } from "./catalog";
import { createFakeStripe } from "./fake";

// The catalog client on the fake: what it reads from an account, and the
// calls of a plan made in order, with refs, idempotency keys and the secrets
// Stripe shows once.

const key = "rk_test_setup123";

/** A product, its price, a meter, a webhook endpoint and a meter error destination, as a plan makes them. */
const steps: StripeCatalogStep[] = [
  { object: "meter", action: "create", call: "billing.meters.create", params: { display_name: "Voice overage in dollars", event_name: "ls_overage_voice", default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } }, idempotencyKey: "catalog:realinfobot:meter:ls_overage_voice", produces: "meter:voice" },
  { object: "product", action: "create", call: "products.create", params: { name: "Starter", tax_code: "txcd_10103001", metadata: { lobbystack_brand: "realinfobot", lobbystack_plan: "starter" } }, idempotencyKey: "catalog:realinfobot:product:starter", produces: "product:starter" },
  { object: "price", action: "create", call: "prices.create", params: { product: stripeRef("product:starter"), currency: "cad", unit_amount: 3700, recurring: { interval: "month" }, lookup_key: "ls_realinfobot_starter_monthly_cad_ec44c083", tax_behavior: "exclusive", metadata: { lobbystack_brand: "realinfobot" } }, idempotencyKey: "catalog:realinfobot:price:ls_realinfobot_starter_monthly_cad_ec44c083", produces: "price:starter/monthly" },
  { object: "webhook", action: "create", call: "webhookEndpoints.create", params: { url: "https://dev1.realinfobot.com/api/webhooks/stripe", enabled_events: ["invoice.paid"], api_version: "2026-10-28.endive", metadata: { lobbystack_brand: "realinfobot" } }, idempotencyKey: "catalog:realinfobot:webhook:https://dev1.realinfobot.com/api/webhooks/stripe" },
  { object: "meter_errors", action: "create", call: "v2.core.eventDestinations.create", params: { name: "LobbyStack meter errors realinfobot", type: "webhook_endpoint", event_payload: "thin", enabled_events: ["v1.billing.meter.no_meter_found"], webhook_endpoint: { url: "https://dev1.realinfobot.com/api/webhooks/stripe/meter-errors" }, include: ["webhook_endpoint.signing_secret"], metadata: { lobbystack_brand: "realinfobot" } }, idempotencyKey: "catalog:realinfobot:meter-errors:https://dev1.realinfobot.com/api/webhooks/stripe/meter-errors" },
];

describe("StripeCatalogClient", () => {
  it("takes a secret or restricted key only, and reads its mode from it", () => {
    expect(() => new StripeCatalogClient(createFakeStripe(), { key: "pk_test_abc123" })).toThrow("secret or restricted key");
  });

  it("makes each call in order, filling in the IDs made before, and hands over the secrets Stripe shows once", async () => {
    const stripe = createFakeStripe({ accountId: "acct_dev1" });
    const heard: Array<[string, string | null]> = [];
    const secrets = await new StripeCatalogClient(stripe, { key }).run(steps, (step, secret) => heard.push([step.call, secret]));
    const catalog = stripe.state.catalog;
    expect(secrets).toEqual({ webhookSecret: catalog.webhooks[0]!.secret, meterWebhookSecret: catalog.eventDestinations[0]!.secret });
    expect(heard).toEqual([["billing.meters.create", null], ["products.create", null], ["prices.create", null], ["webhookEndpoints.create", catalog.webhooks[0]!.secret], ["v2.core.eventDestinations.create", catalog.eventDestinations[0]!.secret]]);
    expect(catalog.prices[0]).toMatchObject({ product: catalog.products[0]!.id, lookup_key: "ls_realinfobot_starter_monthly_cad_ec44c083" });
    // Each create carries its key and a hash of what it sent.
    expect(stripe.requests.map((request) => request.idempotencyKey)).toEqual(steps.map((step) => expect.stringMatching(new RegExp(`^${step.idempotencyKey!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[0-9a-f]{16}$`))));
  });

  it("stops at the first call that fails, so a run cut off halfway is finished by planning again", async () => {
    const stripe = createFakeStripe();
    stripe.cutAfterWrites(2);
    const heard: string[] = [];
    await expect(new StripeCatalogClient(stripe, { key }).run(steps, (step) => heard.push(step.call))).rejects.toThrow("An error occurred with our connection to Stripe.");
    expect(heard).toEqual(["billing.meters.create", "products.create"]);
    expect(stripe.state.catalog.prices).toEqual([]);
  });

  it("reads the account's objects in the snapshot's shape, with the key's mode, and leaves the endpoints out when asked", async () => {
    const stripe = createFakeStripe({ accountId: "acct_dev1" });
    await new StripeCatalogClient(stripe, { key }).run(steps);
    stripe.state.catalog.coupons.push({ id: "ls-realinfobot-launch-12345678", name: "Launch discount", percent_off: 25, amount_off: null, currency: null, duration: "repeating", duration_in_months: 3, applies_to: { products: [stripe.state.catalog.products[0]!.id] }, metadata: { lobbystack_brand: "realinfobot" }, valid: true, times_redeemed: 0 });
    const snapshot = await new StripeCatalogClient(stripe, { key: "rk_live_read123" }).readSnapshot();
    expect(snapshot).toMatchObject({ account: { id: "acct_dev1" }, mode: "live", tax: { status: "active", headOffice: true, registrations: 1 } });
    expect(snapshot.products).toEqual([{ id: stripe.state.catalog.products[0]!.id, name: "Starter", active: true, metadata: { lobbystack_brand: "realinfobot", lobbystack_plan: "starter" }, tax_code: "txcd_10103001", created: expect.any(Number) }]);
    expect(snapshot.prices[0]).toMatchObject({ unit_amount: 3700, currency: "cad", tax_behavior: "exclusive", recurring: { interval: "month", interval_count: 1, usage_type: "licensed", meter: null } });
    expect(snapshot.meters[0]).toMatchObject({ event_name: "ls_overage_voice", status: "active", default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } });
    expect(snapshot.coupons[0]).toMatchObject({ percent_off: 25, applies_to: { products: [stripe.state.catalog.products[0]!.id] } });
    expect(snapshot.webhooks).toEqual([{ id: expect.stringMatching(/^we_/), url: "https://dev1.realinfobot.com/api/webhooks/stripe", enabled_events: ["invoice.paid"], api_version: "2026-10-28.endive", status: "enabled", metadata: { lobbystack_brand: "realinfobot" }, description: null }]);
    expect(snapshot.eventDestinations).toEqual([expect.objectContaining({ event_payload: "thin", url: "https://dev1.realinfobot.com/api/webhooks/stripe/meter-errors", status: "enabled" })]);
    // Stripe never lists a webhook's secret.
    expect(JSON.stringify(snapshot)).not.toContain("whsec_");
    const daily = await new StripeCatalogClient(stripe, { key }).readSnapshot({ webhooks: false });
    expect(daily).toMatchObject({ webhooks: [], eventDestinations: [], mode: "sandbox" });
    expect(stripe.requests.filter((request) => request.call === "webhookEndpoints.list")).toHaveLength(1);
    stripe.loadCatalog({ tax: null });
    expect((await new StripeCatalogClient(stripe, { key }).readSnapshot()).tax).toBeNull();
  });

  it("answers a create sent again with the same key and parameters with the same object", async () => {
    const stripe = createFakeStripe();
    const client = new StripeCatalogClient(stripe, { key });
    await client.run(steps.slice(1, 2));
    await client.run(steps.slice(1, 2));
    expect(stripe.state.catalog.products).toHaveLength(1);
  });
});
