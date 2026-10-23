import type { PolarDiscount, PolarMeter, PolarMetadata, PolarOrganization, PolarPrice, PolarProduct, PolarWebhookEndpoint } from "@lobbystack/providers";

// A stand-in for Polar's API in tests: the calls pnpm billing and the daily
// check make, with the rules Polar's server enforces (section 10.4 of the
// step 2 design). Not used outside tests.

type StoredProduct = Omit<PolarProduct, "benefits"> & { benefitIds: string[] };
type StoredMeter = PolarMeter & { counted?: boolean };
/** A benefit: Credits (meter_credit), as polar-setup.mjs made, or another kind. */
export type StoredBenefit = { id: string; type: string; description: string; properties?: { units: number; rollover: boolean; meter_id: string }; metadata: PolarMetadata };

export type FakePolarState = {
  organization: PolarOrganization;
  meters: StoredMeter[];
  benefits: StoredBenefit[];
  products: StoredProduct[];
  discounts: PolarDiscount[];
  webhooks: PolarWebhookEndpoint[];
};

export type FakePolar = {
  state: FakePolarState;
  fetch: typeof fetch;
  /** Every write Polar accepted, in order. */
  writes: Array<{ method: string; path: string; body: unknown }>;
  /** When set, the write with this number (counting from 1) lands and then the connection drops. */
  dropAfterWrite?: number;
  /** Set to answer every request 401, as Polar does for another server's token. */
  rejectToken?: boolean;
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (message: string, field = "body") => json(422, { detail: [{ loc: ["body", field], msg: message }] });

export function createFakePolar(options: { currency?: string; organization?: Partial<PolarOrganization> } = {}): FakePolar {
  let next = 0;
  const id = (prefix: string) => `${prefix}_${String(++next).padStart(4, "0")}`;
  const state: FakePolarState = {
    organization: { id: "org_test", name: "Test organization", default_presentment_currency: options.currency ?? "cad", subscription_settings: { allow_multiple_subscriptions: true, allow_customer_updates: true, proration_behavior: "prorate" }, customer_portal_settings: { usage: { show: true }, subscription: { update_seats: true, update_plan: false } }, ...options.organization },
    meters: [],
    benefits: [],
    products: [],
    discounts: [],
    webhooks: [],
  };
  const fake: FakePolar = { state, writes: [], fetch: undefined as unknown as typeof fetch };
  const liveProductsUsing = (meterId: string) => state.products.filter((product) => !product.is_archived && product.prices.some((price) => !price.is_archived && price.meter_id === meterId));
  const hasPriceIn = (product: StoredProduct, currency: string) => product.prices.some((price) => !price.is_archived && price.price_currency === currency);
  const makePrices = (bodies: Array<Record<string, unknown>>, currency: string): PolarPrice[] => bodies.map((body) => ({
    id: id("price"),
    amount_type: String(body.amount_type),
    is_archived: false,
    price_currency: String(body.price_currency ?? currency),
    source: "catalog",
    ...(body.amount_type === "fixed" ? { price_amount: Number(body.price_amount) } : {}),
    ...(body.amount_type === "metered_unit" ? { unit_amount: String(body.unit_amount), meter_id: String(body.meter_id) } : {}),
  }));
  const productView = (product: StoredProduct): PolarProduct => {
    const { benefitIds, ...rest } = product;
    return { ...rest, benefits: benefitIds.map((benefitId) => state.benefits.find((benefit) => benefit.id === benefitId)).filter((benefit): benefit is StoredBenefit => benefit !== undefined).map((benefit) => ({ id: benefit.id, type: benefit.type, description: benefit.description })) };
  };

  function route(method: string, path: string, body: Record<string, unknown>): Response {
    const [, , resource, objectId, sub] = path.split("/");
    if (method === "GET") {
      const items = resource === "organizations" ? [state.organization]
        : resource === "meters" ? state.meters.map(({ counted: _counted, ...meter }) => meter)
        : resource === "products" ? state.products.map(productView)
        : resource === "discounts" ? state.discounts
        : resource === "webhooks" ? state.webhooks
        : null;
      return items ? json(200, { items: structuredClone(items), pagination: { total_count: items.length, max_page: 1 } }) : json(404, { detail: "Not found" });
    }
    if (resource === "organizations") {
      if (body.default_presentment_currency !== undefined) {
        const currency = String(body.default_presentment_currency);
        if (state.products.some((product) => !product.is_archived && !hasPriceIn(product, currency))) return refuse("Every active product needs a price in the new default currency.", "default_presentment_currency");
        state.organization.default_presentment_currency = currency;
      }
      if (body.subscription_settings) state.organization.subscription_settings = body.subscription_settings as Record<string, unknown>;
      if (body.customer_portal_settings) state.organization.customer_portal_settings = body.customer_portal_settings as Record<string, unknown>;
      return json(200, state.organization);
    }
    if (resource === "meters") {
      if (method === "POST") {
        const meter: StoredMeter = { id: id("meter"), name: String(body.name), filter: body.filter, aggregation: body.aggregation, metadata: (body.metadata ?? {}) as PolarMetadata, archived_at: null };
        state.meters.push(meter);
        return json(201, meter);
      }
      const meter = state.meters.find((entry) => entry.id === objectId);
      if (!meter) return json(404, { detail: "Not found" });
      if (meter.counted && (body.filter !== undefined || body.aggregation !== undefined)) return refuse("This meter already counted events, so its filter and aggregation can't change.", "filter");
      if (body.is_archived === true && liveProductsUsing(meter.id).length) return refuse("An active product price uses this meter.", "is_archived");
      if (body.name !== undefined) meter.name = String(body.name);
      if (body.filter !== undefined) meter.filter = body.filter;
      if (body.aggregation !== undefined) meter.aggregation = body.aggregation;
      if (body.metadata !== undefined) meter.metadata = body.metadata as PolarMetadata;
      if (body.is_archived !== undefined) meter.archived_at = body.is_archived ? new Date().toISOString() : null;
      return json(200, meter);
    }
    if (resource === "benefits" && method === "POST") {
      // Only polar-setup.mjs's Credits: LobbyStack makes no benefits.
      const properties = body.properties as StoredBenefit["properties"];
      if (!properties || !(properties.units > 0)) return refuse("Input should be greater than 0", "properties.units");
      if (!state.meters.some((meter) => meter.id === properties.meter_id)) return refuse("Meter not found.", "properties.meter_id");
      const benefit: StoredBenefit = { id: id("benefit"), type: String(body.type), description: String(body.description), properties, metadata: (body.metadata ?? {}) as PolarMetadata };
      state.benefits.push(benefit);
      return json(201, benefit);
    }
    if (resource === "products") {
      const currency = String(state.organization.default_presentment_currency);
      if (method === "POST" && !objectId) {
        const prices = makePrices(body.prices as Array<Record<string, unknown>>, currency);
        if (!prices.some((price) => price.price_currency === currency)) return refuse("A product needs a price in the default currency.", "prices");
        const product: StoredProduct = { id: id("product"), name: String(body.name), recurring_interval: String(body.recurring_interval), recurring_interval_count: Number(body.recurring_interval_count ?? 1), visibility: String(body.visibility ?? "public"), is_archived: false, metadata: (body.metadata ?? {}) as PolarMetadata, prices, benefitIds: [], created_at: new Date().toISOString(), modified_at: null };
        state.products.push(product);
        return json(201, productView(product));
      }
      const product = state.products.find((entry) => entry.id === objectId);
      if (!product) return json(404, { detail: "Not found" });
      if (sub === "benefits") {
        // The whole list: a benefit left out is taken off the product.
        if ((body.benefits as string[]).some((benefitId) => !state.benefits.some((benefit) => benefit.id === benefitId))) return refuse("Benefit not found.", "benefits");
        product.benefitIds = (body.benefits as string[]).slice();
        return json(200, productView(product));
      }
      if (body.recurring_interval !== undefined || body.recurring_interval_count !== undefined) return refuse("The recurring interval can't be changed.", "recurring_interval");
      if (body.prices !== undefined) {
        // Prices left out are archived; a price's amount never changes.
        const sent = body.prices as Array<Record<string, unknown>>;
        const keep = new Set(sent.filter((price) => typeof price.id === "string").map((price) => price.id as string));
        for (const price of product.prices) if (!keep.has(price.id)) price.is_archived = true;
        product.prices.push(...makePrices(sent.filter((price) => typeof price.id !== "string"), currency));
      }
      if (body.name !== undefined) product.name = String(body.name);
      if (body.visibility !== undefined) product.visibility = String(body.visibility);
      if (body.is_archived !== undefined) product.is_archived = Boolean(body.is_archived);
      if (body.metadata !== undefined) product.metadata = body.metadata as PolarMetadata;
      product.modified_at = new Date().toISOString();
      return json(200, productView(product));
    }
    if (resource === "discounts") {
      if (method === "POST") {
        const discount: PolarDiscount = { id: id("discount"), name: String(body.name), type: body.type as PolarDiscount["type"], ...(body.basis_points !== undefined ? { basis_points: Number(body.basis_points) } : {}), ...(body.amounts !== undefined ? { amounts: body.amounts as Record<string, number> } : {}), duration: body.duration as PolarDiscount["duration"], duration_in_months: (body.duration_in_months ?? null) as number | null, code: (body.code ?? null) as string | null, ends_at: null, redemptions_count: 0, products: ((body.products ?? []) as string[]).map((productId) => ({ id: productId })), metadata: (body.metadata ?? {}) as PolarMetadata };
        state.discounts.push(discount);
        return json(201, discount);
      }
      const discount = state.discounts.find((entry) => entry.id === objectId);
      if (!discount) return json(404, { detail: "Not found" });
      if (body.type !== undefined && body.type !== discount.type) return refuse("Type cannot be changed.", "type");
      if (body.duration !== undefined && body.duration !== discount.duration) return refuse("Duration cannot be changed.", "duration");
      if (discount.redemptions_count > 0 && ["basis_points", "amounts", "duration_in_months"].some((field) => body[field] !== undefined && JSON.stringify(body[field]) !== JSON.stringify(discount[field as keyof PolarDiscount]))) return refuse("This field can't be changed once the discount was redeemed.", "amounts");
      if (body.basis_points !== undefined) discount.basis_points = Number(body.basis_points);
      if (body.amounts !== undefined) discount.amounts = body.amounts as Record<string, number>;
      if (body.duration_in_months !== undefined) discount.duration_in_months = body.duration_in_months as number;
      if (body.products !== undefined) discount.products = (body.products as string[]).map((productId) => ({ id: productId }));
      if ("code" in body) discount.code = body.code as string | null;
      if (body.ends_at !== undefined) discount.ends_at = String(body.ends_at);
      if (body.name !== undefined) discount.name = String(body.name);
      if (body.metadata !== undefined) discount.metadata = body.metadata as PolarMetadata;
      return json(200, discount);
    }
    if (resource === "webhooks") {
      if (method === "POST") {
        const endpoint: PolarWebhookEndpoint = { id: id("webhook"), url: String(body.url), format: String(body.format), events: (body.events as string[]).slice(), enabled: true, secret: `polar_whs_secret_${next}` };
        state.webhooks.push(endpoint);
        return json(201, endpoint);
      }
      const endpoint = state.webhooks.find((entry) => entry.id === sub);
      if (!endpoint) return json(404, { detail: "Not found" });
      if (body.format !== undefined) endpoint.format = String(body.format);
      if (body.events !== undefined) endpoint.events = (body.events as string[]).slice();
      if (body.enabled !== undefined) endpoint.enabled = Boolean(body.enabled);
      return json(200, endpoint);
    }
    return json(404, { detail: "Not found" });
  }

  fake.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (fake.rejectToken) return json(401, { detail: "Invalid token" });
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const response = route(method, url.pathname.replace(/\/$/, ""), body);
    if (method !== "GET" && response.ok) {
      fake.writes.push({ method, path: url.pathname, body });
      if (fake.dropAfterWrite === fake.writes.length) throw new TypeError("fetch failed: the connection dropped after the write landed");
    }
    return response;
  }) as typeof fetch;
  return fake;
}

const setupPlans = [
  { label: "Starter", monthly: 3000, annual: 28800, included: [150, 50, 20], rates: [20, 2, 2] },
  { label: "Pro", monthly: 10000, annual: 96000, included: [500, 200, 100], rates: [18, 2, 2] },
];
const setupMeters = [
  { name: "Voice minutes", event: "billing.voice_minutes", noun: "voice minutes" },
  { name: "Alert SMS segments", event: "billing.alert_sms_segments", noun: "alert SMS segments" },
  { name: "Call transfers", event: "billing.outbound_call_attempts", noun: "call transfers" },
];

/** What polar-setup.mjs made in a CAD organization on 2026-10-19: three meters, four products, Credits on the two monthly ones, and the webhook, none of them tagged. */
export async function seedPolarSetup(fake: FakePolar, webhookUrl = "https://demo.alloplace.com/api/webhooks/polar"): Promise<void> {
  const call = async (method: string, path: string, body: unknown) => (await (await fake.fetch(`https://sandbox-api.polar.sh${path}`, { method, body: JSON.stringify(body) })).json()) as { id: string };
  const meterIds: string[] = [];
  for (const meter of setupMeters) meterIds.push((await call("POST", "/v1/meters/", { name: meter.name, filter: { conjunction: "and", clauses: [{ property: "name", operator: "eq", value: meter.event }] }, aggregation: { func: "sum", property: "quantity" } })).id);
  for (const plan of setupPlans) {
    const credits: string[] = [];
    for (const [index, meter] of setupMeters.entries()) credits.push((await call("POST", "/v1/benefits/", { type: "meter_credit", description: `${plan.included[index]} ${meter.noun} a month`, properties: { units: plan.included[index], rollover: false, meter_id: meterIds[index] } })).id);
    for (const [period, interval, cents] of [["monthly", "month", plan.monthly], ["annual", "year", plan.annual]] as const) {
      const product = await call("POST", "/v1/products/", { name: `${plan.label} ${period}`, recurring_interval: interval, prices: [{ amount_type: "fixed", price_amount: cents, price_currency: "cad" }, ...meterIds.map((meterId, index) => ({ amount_type: "metered_unit", meter_id: meterId, unit_amount: String(plan.rates[index]), price_currency: "cad" }))] });
      if (period === "monthly") await call("POST", `/v1/products/${product.id}/benefits`, { benefits: credits });
    }
  }
  await call("POST", "/v1/webhooks/endpoints", { url: webhookUrl, name: "LobbyStack", format: "raw", events: ["subscription.created", "subscription.active", "subscription.updated", "subscription.canceled", "subscription.uncanceled", "subscription.revoked", "subscription.past_due", "subscription.cycled", "subscription.paused", "subscription.resumed", "subscription.migrated", "order.created", "order.updated", "order.paid", "order.refunded"] });
  await call("PATCH", `/v1/organizations/${fake.state.organization.id}`, { subscription_settings: { ...fake.state.organization.subscription_settings, allow_multiple_subscriptions: false }, customer_portal_settings: { usage: { show: true }, subscription: { update_seats: true, update_plan: true } } });
  fake.writes.length = 0;
}
