import Stripe from "stripe";

import type { StripeCatalogApi, StripeCatalogCoupon, StripeCatalogMeter, StripeCatalogPrice, StripeCatalogProduct, StripeCatalogWebhook, StripeEventDestination, StripePortalConfiguration, StripeSnapshot, StripeTaxState } from "../catalog";
import type { FakeStripeContext } from "./context";
import { invalid, missing } from "./errors";

// The catalog objects pnpm billing makes (the Stripe plan's step 11), with
// the rules Stripe's server keeps: one price per lookup key unless the key is
// transferred, prices and coupons that never change what they charge, one
// active meter per event name, and an endpoint's API version fixed. The
// objects are kept in the snapshot's shape, which uses Stripe's own names, and
// answered as the SDK's objects.

/** The catalog objects the fake holds, and what its writes do. */
export type FakeCatalogState = {
  products: StripeCatalogProduct[];
  prices: StripeCatalogPrice[];
  meters: StripeCatalogMeter[];
  coupons: StripeCatalogCoupon[];
  portalConfigurations: StripePortalConfiguration[];
  webhooks: Array<StripeCatalogWebhook & { secret: string }>;
  eventDestinations: Array<StripeEventDestination & { secret: string }>;
  /** Null makes reading Stripe Tax a permission error, as for a key without it. */
  tax: StripeTaxState | null;
  /** When set, the writes left before the connection drops, as for a run cut off halfway. */
  writesLeft: number | null;
};

export function emptyFakeCatalog(): FakeCatalogState {
  return { products: [], prices: [], meters: [], coupons: [], portalConfigurations: [], webhooks: [], eventDestinations: [], tax: { status: "active", headOffice: true, registrations: 1 }, writesLeft: null };
}

/** Puts a snapshot's objects into the fake, as an account that already has them. */
export function loadFakeCatalog(state: FakeCatalogState, snapshot: Partial<Pick<StripeSnapshot, "products" | "prices" | "meters" | "coupons" | "portalConfigurations" | "webhooks" | "eventDestinations" | "tax">>): void {
  const copy = structuredClone(snapshot);
  state.products.push(...(copy.products ?? []));
  state.prices.push(...(copy.prices ?? []));
  state.meters.push(...(copy.meters ?? []));
  state.coupons.push(...(copy.coupons ?? []));
  state.portalConfigurations.push(...(copy.portalConfigurations ?? []));
  state.webhooks.push(...(copy.webhooks ?? []).map((endpoint) => ({ ...endpoint, secret: `whsec_loaded_${endpoint.id}` })));
  state.eventDestinations.push(...(copy.eventDestinations ?? []).map((destination) => ({ ...destination, secret: `whsec_loaded_${destination.id}` })));
  if (copy.tax !== undefined) state.tax = copy.tax;
}

type Params = Record<string, any>;

/** Every object of a list at once, as autoPagingToArray answers. */
function listOf<T>(fake: FakeStripeContext, name: string, params: unknown, items: () => T[]) {
  return { autoPagingToArray: async () => await fake.call(name, params, null, items) };
}

function only(params: Params, allowed: readonly string[]): void {
  const other = Object.keys(params).find((key) => !allowed.includes(key));
  if (other) throw invalid(`Received unknown parameter: ${other}`, other);
}

/** Stripe merges metadata on update, and an empty value removes a key. */
function mergedMetadata(existing: Record<string, string>, update: Params | undefined): Record<string, string> {
  const merged = { ...existing, ...(update ?? {}) };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== "" && value !== null && value !== undefined)) as Record<string, string>;
}

function find<T extends { id: string }>(items: T[], id: string, kind: string): T {
  const found = items.find((item) => item.id === id);
  if (!found) throw missing(kind, id);
  return found;
}

/** A portal configuration as Stripe answers one made or changed with these parameters. */
function portalConfiguration(id: string, params: Params, before?: StripePortalConfiguration): StripePortalConfiguration {
  const features = { ...(before?.features ?? {}), ...(params.features ?? {}) } as Params;
  const update = features.subscription_update ?? { enabled: false };
  const cancel = features.subscription_cancel ?? { enabled: false };
  return {
    id,
    active: params.active ?? before?.active ?? true,
    is_default: before?.is_default ?? false,
    name: params.name ?? before?.name ?? null,
    metadata: mergedMetadata(before?.metadata ?? {}, params.metadata),
    default_return_url: params.default_return_url ?? before?.default_return_url ?? null,
    business_profile: { headline: params.business_profile?.headline ?? before?.business_profile.headline ?? null, privacy_policy_url: params.business_profile?.privacy_policy_url ?? before?.business_profile.privacy_policy_url ?? null, terms_of_service_url: params.business_profile?.terms_of_service_url ?? before?.business_profile.terms_of_service_url ?? null },
    features: {
      customer_update: { enabled: features.customer_update?.enabled ?? false, allowed_updates: [...(features.customer_update?.allowed_updates ?? [])] },
      invoice_history: { enabled: features.invoice_history?.enabled ?? false },
      payment_method_update: { enabled: features.payment_method_update?.enabled ?? false },
      subscription_cancel: { enabled: cancel.enabled, mode: cancel.mode ?? "at_period_end", proration_behavior: cancel.proration_behavior ?? "none" },
      subscription_update: {
        enabled: update.enabled,
        default_allowed_updates: [...(update.default_allowed_updates ?? [])],
        products: update.products ? update.products.map((entry: { product: string; prices: string[] }) => ({ product: entry.product, prices: [...entry.prices] })) : null,
        proration_behavior: update.proration_behavior ?? "none",
        billing_cycle_anchor: update.billing_cycle_anchor ?? null,
        schedule_at_period_end: { conditions: (update.schedule_at_period_end?.conditions ?? []).map((condition: { type: string }) => ({ type: condition.type })) },
      },
    },
  };
}

/** The catalog calls of StripeCatalogApi, on the fake's catalog. */
export function fakeCatalog(fake: FakeStripeContext, state: FakeCatalogState): Omit<StripeCatalogApi, "accounts"> {
  /** A write: counted against writesLeft, and recorded with its idempotency key. */
  const write = async <T>(name: string, params: unknown, options: Stripe.RequestOptions | undefined, run: () => T): Promise<T> => {
    if (state.writesLeft !== null) {
      if (state.writesLeft <= 0) throw new Stripe.errors.StripeConnectionError({ type: "api_error", message: "An error occurred with our connection to Stripe." });
      state.writesLeft -= 1;
    }
    return await fake.call(name, params, options?.idempotencyKey ?? null, run);
  };
  const created = () => fake.clock.now();

  const products = {
    list: (params: Params) => listOf(fake, "products.list", params, () => state.products),
    create: (params: Params, options?: Stripe.RequestOptions) => write("products.create", params, options, () => {
      only(params, ["name", "active", "metadata", "tax_code", "description"]);
      const product: StripeCatalogProduct = { id: fake.nextId("prod"), name: params.name, active: params.active ?? true, metadata: mergedMetadata({}, params.metadata), tax_code: params.tax_code ?? null, created: created() };
      state.products.push(product);
      return product;
    }),
    update: (id: string, params: Params) => write("products.update", { id, ...params }, undefined, () => {
      only(params, ["name", "active", "metadata", "tax_code", "description"]);
      const product = find(state.products, id, "product");
      Object.assign(product, { ...params, metadata: mergedMetadata(product.metadata, params.metadata) });
      return product;
    }),
  };

  const prices = {
    list: (params: Params) => {
      // As autoPagingToArray for the catalog client, and as a page for the adapter's lookups.
      const items = () => state.prices.filter((price) => (!params?.lookup_keys || params.lookup_keys.includes(price.lookup_key)) && (params?.active === undefined || price.active === params.active));
      let pending: Promise<{ object: string; data: StripeCatalogPrice[]; has_more: boolean }> | undefined;
      const page = () => (pending ??= fake.call("prices.list", params, null, () => ({ object: "list", data: items(), has_more: false })));
      return { then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => page().then(resolve, reject), autoPagingToArray: async () => (await page()).data };
    },
    create: (params: Params, options?: Stripe.RequestOptions) => write("prices.create", params, options, () => {
      only(params, ["product", "currency", "unit_amount", "recurring", "lookup_key", "transfer_lookup_key", "tax_behavior", "metadata", "nickname"]);
      const product = find(state.products, params.product, "product");
      if (!product.active) throw invalid(`The product ${product.id} is archived, so it can't get a new price.`, "product");
      const holder = params.lookup_key ? state.prices.find((price) => price.lookup_key === params.lookup_key) : undefined;
      if (holder && !params.transfer_lookup_key) throw invalid(`A price (${holder.id}) already uses that lookup key.`, "lookup_key");
      if (holder) holder.lookup_key = null;
      const recurring = params.recurring as Params | undefined;
      if (recurring?.usage_type === "metered" && !state.meters.some((meter) => meter.id === recurring.meter && meter.status === "active")) throw missing("billing.meter", String(recurring.meter), "recurring[meter]");
      const price: StripeCatalogPrice = {
        id: fake.nextId("price"),
        active: true,
        product: product.id,
        currency: params.currency,
        unit_amount: params.unit_amount ?? null,
        lookup_key: params.lookup_key ?? null,
        tax_behavior: params.tax_behavior ?? "unspecified",
        recurring: recurring ? { interval: recurring.interval, interval_count: recurring.interval_count ?? 1, usage_type: recurring.usage_type ?? "licensed", meter: recurring.meter ?? null } : null,
        metadata: mergedMetadata({}, params.metadata),
        created: created(),
      };
      state.prices.push(price);
      return price;
    }),
    update: (id: string, params: Params) => write("prices.update", { id, ...params }, undefined, () => {
      only(params, ["active", "metadata", "lookup_key", "transfer_lookup_key", "tax_behavior", "nickname"]);
      const price = find(state.prices, id, "price");
      if (params.tax_behavior !== undefined && price.tax_behavior !== "unspecified" && price.tax_behavior !== null) throw invalid("A price's tax behavior can't be changed once it's set.", "tax_behavior");
      Object.assign(price, { ...params, metadata: mergedMetadata(price.metadata, params.metadata) });
      return price;
    }),
  };

  const meters = {
    list: (params: Params) => listOf(fake, "billing.meters.list", params, () => state.meters),
    create: (params: Params, options?: Stripe.RequestOptions) => write("billing.meters.create", params, options, () => {
      if (state.meters.some((meter) => meter.status === "active" && meter.event_name === params.event_name)) throw invalid(`An active meter with the event name ${params.event_name} already exists.`, "event_name");
      const meter: StripeCatalogMeter = { id: fake.nextId("mtr"), display_name: params.display_name, event_name: params.event_name, status: "active", default_aggregation: { formula: params.default_aggregation.formula }, customer_mapping: { type: params.customer_mapping?.type ?? "by_id", event_payload_key: params.customer_mapping?.event_payload_key ?? "stripe_customer_id" }, value_settings: { event_payload_key: params.value_settings?.event_payload_key ?? "value" } };
      state.meters.push(meter);
      return meter;
    }),
    update: (id: string, params: Params) => write("billing.meters.update", { id, ...params }, undefined, () => {
      only(params, ["display_name"]);
      return Object.assign(find(state.meters, id, "billing.meter"), params);
    }),
    reactivate: (id: string) => write("billing.meters.reactivate", { id }, undefined, () => {
      const meter = find(state.meters, id, "billing.meter");
      if (state.meters.some((other) => other.status === "active" && other.event_name === meter.event_name)) throw invalid(`An active meter with the event name ${meter.event_name} already exists.`, "event_name");
      meter.status = "active";
      return meter;
    }),
  };

  const coupons = {
    list: (params: Params) => listOf(fake, "coupons.list", params, () => state.coupons),
    create: (params: Params, options?: Stripe.RequestOptions) => write("coupons.create", params, options, () => {
      only(params, ["id", "name", "percent_off", "amount_off", "currency", "duration", "duration_in_months", "applies_to", "metadata"]);
      const id = params.id ?? fake.nextId("coupon");
      if (state.coupons.some((coupon) => coupon.id === id)) throw invalid("Coupon already exists.", "id");
      const coupon: StripeCatalogCoupon = { id, name: params.name ?? null, percent_off: params.percent_off ?? null, amount_off: params.amount_off ?? null, currency: params.currency ?? null, duration: params.duration, duration_in_months: params.duration_in_months ?? null, applies_to: params.applies_to ? { products: [...params.applies_to.products] } : null, metadata: mergedMetadata({}, params.metadata), valid: true, times_redeemed: 0 };
      state.coupons.push(coupon);
      return coupon;
    }),
    update: (id: string, params: Params) => write("coupons.update", { id, ...params }, undefined, () => {
      only(params, ["name", "metadata"]);
      const coupon = find(state.coupons, id, "coupon");
      Object.assign(coupon, { ...params, metadata: mergedMetadata(coupon.metadata, params.metadata) });
      return coupon;
    }),
    del: (id: string) => write("coupons.del", { id }, undefined, () => {
      find(state.coupons, id, "coupon");
      state.coupons = state.coupons.filter((coupon) => coupon.id !== id);
      return { id, object: "coupon", deleted: true };
    }),
  };

  const configurations = {
    list: (params: Params) => listOf(fake, "billingPortal.configurations.list", params, () => state.portalConfigurations),
    create: (params: Params, options?: Stripe.RequestOptions) => write("billingPortal.configurations.create", params, options, () => {
      only(params, ["name", "business_profile", "default_return_url", "features", "metadata", "login_page"]);
      const configuration = portalConfiguration(fake.nextId("bpc"), params);
      state.portalConfigurations.push(configuration);
      return configuration;
    }),
    update: (id: string, params: Params) => write("billingPortal.configurations.update", { id, ...params }, undefined, () => {
      only(params, ["active", "name", "business_profile", "default_return_url", "features", "metadata", "login_page"]);
      const before = find(state.portalConfigurations, id, "billing portal configuration");
      return Object.assign(before, portalConfiguration(id, params, before));
    }),
  };

  const webhookEndpoints = {
    list: (params: Params) => listOf(fake, "webhookEndpoints.list", params, () => state.webhooks.map(({ secret: _secret, ...endpoint }) => endpoint)),
    create: (params: Params, options?: Stripe.RequestOptions) => write("webhookEndpoints.create", params, options, () => {
      only(params, ["url", "enabled_events", "api_version", "description", "metadata", "connect"]);
      const id = fake.nextId("we");
      const endpoint = { id, url: params.url, enabled_events: [...params.enabled_events], api_version: params.api_version ?? null, status: "enabled" as const, metadata: mergedMetadata({}, params.metadata), description: params.description ?? null, secret: `whsec_fake_${id}` };
      state.webhooks.push(endpoint);
      return endpoint;
    }),
    update: (id: string, params: Params) => write("webhookEndpoints.update", { id, ...params }, undefined, () => {
      only(params, ["url", "enabled_events", "disabled", "description", "metadata"]);
      const endpoint = find(state.webhooks, id, "webhook endpoint");
      if (params.url !== undefined) endpoint.url = params.url;
      if (params.enabled_events !== undefined) endpoint.enabled_events = [...params.enabled_events];
      if (params.disabled !== undefined) endpoint.status = params.disabled ? "disabled" : "enabled";
      if (params.description !== undefined) endpoint.description = params.description;
      endpoint.metadata = mergedMetadata(endpoint.metadata, params.metadata);
      const { secret: _secret, ...shown } = endpoint;
      return shown;
    }),
    del: (id: string) => write("webhookEndpoints.del", { id }, undefined, () => {
      find(state.webhooks, id, "webhook endpoint");
      state.webhooks = state.webhooks.filter((endpoint) => endpoint.id !== id);
      return { id, object: "webhook_endpoint", deleted: true };
    }),
  };

  /** An event destination as the API answers it: its address only when included. */
  const destinationOf = (destination: StripeEventDestination & { secret: string }, include: readonly string[] = []) => {
    const { url, secret, ...rest } = destination;
    return { ...rest, webhook_endpoint: { ...(include.includes("webhook_endpoint.url") ? { url } : {}), ...(include.includes("webhook_endpoint.signing_secret") ? { signing_secret: secret } : {}) } };
  };
  const eventDestinations = {
    list: (params: Params = {}) => listOf(fake, "v2.core.eventDestinations.list", params, () => state.eventDestinations.map((destination) => destinationOf(destination, params.include ?? []))),
    create: (params: Params, options?: Stripe.RequestOptions) => write("v2.core.eventDestinations.create", params, options, () => {
      only(params, ["name", "description", "type", "event_payload", "enabled_events", "webhook_endpoint", "include", "metadata", "events_from", "snapshot_api_version"]);
      const id = fake.nextId("ed");
      const destination = { id, name: params.name, type: params.type, event_payload: params.event_payload, enabled_events: [...params.enabled_events], status: "enabled" as const, url: params.webhook_endpoint?.url ?? null, metadata: mergedMetadata({}, params.metadata), secret: `whsec_fake_${id}` };
      state.eventDestinations.push(destination);
      return destinationOf(destination, params.include ?? []);
    }),
    update: (id: string, params: Params) => write("v2.core.eventDestinations.update", { id, ...params }, undefined, () => {
      only(params, ["name", "description", "enabled_events", "metadata", "webhook_endpoint", "include"]);
      const destination = find(state.eventDestinations, id, "event destination");
      if (params.enabled_events !== undefined) destination.enabled_events = [...params.enabled_events];
      if (params.webhook_endpoint?.url !== undefined) destination.url = params.webhook_endpoint.url;
      if (params.name !== undefined) destination.name = params.name;
      destination.metadata = mergedMetadata(destination.metadata, params.metadata);
      return destinationOf(destination, params.include ?? []);
    }),
    enable: (id: string) => write("v2.core.eventDestinations.enable", { id }, undefined, () => {
      const destination = find(state.eventDestinations, id, "event destination");
      destination.status = "enabled";
      return destinationOf(destination);
    }),
    del: (id: string) => write("v2.core.eventDestinations.del", { id }, undefined, () => {
      find(state.eventDestinations, id, "event destination");
      state.eventDestinations = state.eventDestinations.filter((destination) => destination.id !== id);
      return { id, object: "v2.core.event_destination", deleted: true };
    }),
  };

  const permissionError = () => new Stripe.errors.StripePermissionError({ type: "invalid_request_error", message: "The provided key does not have the required permissions for this endpoint." });
  const tax = {
    settings: {
      retrieve: async () => await fake.call("tax.settings.retrieve", {}, null, () => {
        if (!state.tax) throw permissionError();
        return { object: "tax.settings", status: state.tax.status, head_office: state.tax.headOffice ? { address: { country: "CA" } } : null };
      }),
    },
    registrations: {
      list: (params: Params) => listOf(fake, "tax.registrations.list", params, () => {
        if (!state.tax) throw permissionError();
        return Array.from({ length: state.tax.registrations }, (_entry, index) => ({ id: `taxreg_fake${index + 1}`, object: "tax.registration", status: "active", country: "CA" }));
      }),
    },
  };

  return {
    products,
    prices,
    billing: { meters },
    coupons,
    billingPortal: { configurations },
    webhookEndpoints,
    v2: { core: { eventDestinations } },
    tax,
  } as unknown as Omit<StripeCatalogApi, "accounts">;
}
