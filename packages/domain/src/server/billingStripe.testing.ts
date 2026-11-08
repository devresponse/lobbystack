import type { StripeCatalogPrice, StripeEventDestination, StripePortalConfiguration, StripeRef, StripeSnapshot, StripeTaxState } from "@lobbystack/providers/stripe/catalog";

import type { StripeStep } from "./billingStripe";

// A stand-in for a Stripe account in tests of the catalog planner: a
// snapshot, and what a plan's calls do to it, with the rules Stripe's server
// keeps: one price per lookup key unless the key is transferred, prices,
// coupons and meters that never change what they charge or count, one
// active meter per event name, and an endpoint's API version fixed. Not used
// outside tests.

export function emptyStripeSnapshot(options: { account?: string; mode?: "sandbox" | "live"; tax?: StripeTaxState | null } = {}): StripeSnapshot {
  return {
    account: { id: options.account ?? "acct_test", name: "LobbyStack test" },
    mode: options.mode ?? "sandbox",
    products: [],
    prices: [],
    meters: [],
    coupons: [],
    portalConfigurations: [],
    webhooks: [],
    eventDestinations: [],
    tax: options.tax === undefined ? { status: "active", headOffice: true, registrations: 1 } : options.tax,
  };
}

export type StripeRunResult = {
  snapshot: StripeSnapshot;
  /** How many steps ran. */
  ran: number;
  /** The secrets of endpoints and destinations made, shown once as Stripe does. */
  secrets: string[];
};

const isRef = (value: unknown): value is StripeRef => Boolean(value && typeof value === "object" && "$ref" in value);

function resolve(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (isRef(value)) {
    const id = ids.get(value.$ref);
    if (!id) throw new Error(`No Stripe ID for ${value.$ref}: the call that makes it didn't run.`);
    return id;
  }
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry, ids)]));
  return value;
}

function only(params: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const other = Object.keys(params).filter((key) => !allowed.includes(key));
  if (other.length) throw new Error(`Stripe never changes a ${what}'s ${other.join(", ")}.`);
}

/**
 * Runs a plan's steps on a copy of the snapshot, as Stripe would answer them,
 * stopping after stopAfter steps when given, as a run cut off halfway.
 */
export function runStripeSteps(snapshot: StripeSnapshot, steps: readonly StripeStep[], options: { stopAfter?: number } = {}): StripeRunResult {
  const state = structuredClone(snapshot);
  const ids = new Map<string, string>();
  const secrets: string[] = [];
  let next = state.products.length + state.prices.length + state.meters.length + state.portalConfigurations.length + state.webhooks.length + state.eventDestinations.length;
  const id = (prefix: string) => `${prefix}_${String(++next).padStart(4, "0")}`;
  const clock = () => 1_800_000_000 + next;
  const find = <T extends { id: string }>(items: T[], target: unknown, what: string): T => {
    const found = items.find((item) => item.id === target);
    if (!found) throw new Error(`No such ${what}: ${String(target)}`);
    return found;
  };
  let ran = 0;
  for (const step of steps) {
    if (options.stopAfter !== undefined && ran >= options.stopAfter) break;
    const params = resolve(step.params, ids) as Record<string, any>;
    const target = step.target === undefined ? undefined : resolve(step.target, ids);
    let made: string | null = null;
    switch (step.call) {
      case "products.create": {
        made = id("prod");
        state.products.push({ id: made, name: params.name, active: params.active ?? true, metadata: { ...params.metadata }, tax_code: params.tax_code ?? null, created: clock() });
        break;
      }
      case "products.update": {
        only(params, ["name", "active", "metadata", "tax_code"], "product");
        const product = find(state.products, target, "product");
        Object.assign(product, { ...params, metadata: { ...product.metadata, ...params.metadata } });
        break;
      }
      case "prices.create": {
        const product = find(state.products, params.product, "product");
        if (!product.active) throw new Error(`The product ${product.id} is archived, so it can't get a new price.`);
        const holder = state.prices.find((price) => price.lookup_key === params.lookup_key);
        if (holder && !params.transfer_lookup_key) throw new Error(`A price (${holder.id}) already uses the lookup key ${params.lookup_key}.`);
        if (holder) holder.lookup_key = null;
        const recurring = params.recurring ?? null;
        if (recurring?.usage_type === "metered" && !state.meters.some((meter) => meter.id === recurring.meter && meter.status === "active")) throw new Error(`No active meter ${String(recurring.meter)}.`);
        made = id("price");
        const price: StripeCatalogPrice = {
          id: made,
          active: true,
          product: product.id,
          currency: params.currency,
          unit_amount: params.unit_amount,
          lookup_key: params.lookup_key ?? null,
          tax_behavior: params.tax_behavior ?? "unspecified",
          recurring: recurring ? { interval: recurring.interval, interval_count: recurring.interval_count ?? 1, usage_type: recurring.usage_type ?? "licensed", meter: recurring.meter ?? null } : null,
          metadata: { ...params.metadata },
          created: clock(),
        };
        state.prices.push(price);
        break;
      }
      case "prices.update": {
        only(params, ["active", "metadata", "lookup_key", "tax_behavior"], "price");
        const price = find(state.prices, target, "price");
        if (params.tax_behavior !== undefined && price.tax_behavior !== "unspecified" && price.tax_behavior !== null) throw new Error("A price's tax behavior can't change once set.");
        Object.assign(price, { ...params, metadata: { ...price.metadata, ...params.metadata } });
        break;
      }
      case "billing.meters.create": {
        if (state.meters.some((meter) => meter.status === "active" && meter.event_name === params.event_name)) throw new Error(`An active meter already counts ${params.event_name}.`);
        made = id("mtr");
        state.meters.push({ id: made, display_name: params.display_name, event_name: params.event_name, status: "active", default_aggregation: { ...params.default_aggregation }, customer_mapping: { ...params.customer_mapping }, value_settings: { ...params.value_settings } });
        break;
      }
      case "billing.meters.update": {
        only(params, ["display_name"], "meter");
        Object.assign(find(state.meters, target, "meter"), params);
        break;
      }
      case "billing.meters.reactivate": {
        const meter = find(state.meters, target, "meter");
        if (state.meters.some((other) => other.status === "active" && other.event_name === meter.event_name)) throw new Error(`An active meter already counts ${meter.event_name}.`);
        meter.status = "active";
        break;
      }
      case "coupons.create": {
        if (state.coupons.some((coupon) => coupon.id === params.id)) throw new Error(`Coupon already exists: ${params.id}`);
        state.coupons.push({ id: params.id, name: params.name ?? null, percent_off: params.percent_off ?? null, amount_off: params.amount_off ?? null, currency: params.currency ?? null, duration: params.duration, duration_in_months: params.duration_in_months ?? null, applies_to: params.applies_to ? { products: [...params.applies_to.products] } : null, metadata: { ...params.metadata }, valid: true, times_redeemed: 0 });
        break;
      }
      case "coupons.update": {
        only(params, ["name", "metadata"], "coupon");
        const coupon = find(state.coupons, target, "coupon");
        Object.assign(coupon, { ...params, metadata: { ...coupon.metadata, ...params.metadata } });
        break;
      }
      case "coupons.del": {
        find(state.coupons, target, "coupon");
        state.coupons = state.coupons.filter((coupon) => coupon.id !== target);
        break;
      }
      case "billingPortal.configurations.create": {
        made = id("bpc");
        state.portalConfigurations.push(portalConfiguration(made, params));
        break;
      }
      case "billingPortal.configurations.update": {
        only(params, ["active", "business_profile", "default_return_url", "features", "metadata", "name"], "portal configuration");
        const configuration = find(state.portalConfigurations, target, "portal configuration");
        const updated = portalConfiguration(configuration.id, { ...configuration, ...params, business_profile: { ...configuration.business_profile, ...params.business_profile }, features: { ...configuration.features, ...params.features }, metadata: { ...configuration.metadata, ...params.metadata } });
        Object.assign(configuration, updated, { active: params.active ?? configuration.active, is_default: configuration.is_default });
        break;
      }
      case "webhookEndpoints.create": {
        made = id("we");
        state.webhooks.push({ id: made, url: params.url, enabled_events: [...params.enabled_events], api_version: params.api_version ?? null, status: "enabled", metadata: { ...params.metadata }, description: params.description ?? null });
        secrets.push(`whsec_${made}`);
        break;
      }
      case "webhookEndpoints.update": {
        only(params, ["url", "enabled_events", "disabled", "metadata", "description"], "webhook endpoint");
        const endpoint = find(state.webhooks, target, "webhook endpoint");
        if (params.disabled !== undefined) endpoint.status = params.disabled ? "disabled" : "enabled";
        if (params.enabled_events) endpoint.enabled_events = [...params.enabled_events];
        if (params.url) endpoint.url = params.url;
        if (params.metadata) endpoint.metadata = { ...endpoint.metadata, ...params.metadata };
        break;
      }
      case "webhookEndpoints.del": {
        find(state.webhooks, target, "webhook endpoint");
        state.webhooks = state.webhooks.filter((endpoint) => endpoint.id !== target);
        break;
      }
      case "v2.core.eventDestinations.create": {
        made = id("ed");
        const destination: StripeEventDestination = { id: made, name: params.name, type: params.type, event_payload: params.event_payload, enabled_events: [...params.enabled_events], status: "enabled", url: params.webhook_endpoint?.url ?? null, metadata: { ...params.metadata } };
        state.eventDestinations.push(destination);
        secrets.push(`whsec_${made}`);
        break;
      }
      case "v2.core.eventDestinations.update": {
        only(params, ["name", "description", "enabled_events", "metadata", "webhook_endpoint", "include"], "event destination");
        const destination = find(state.eventDestinations, target, "event destination");
        if (params.enabled_events) destination.enabled_events = [...params.enabled_events];
        if (params.webhook_endpoint?.url) destination.url = params.webhook_endpoint.url;
        break;
      }
      case "v2.core.eventDestinations.enable": {
        find(state.eventDestinations, target, "event destination").status = "enabled";
        break;
      }
      case "v2.core.eventDestinations.del": {
        find(state.eventDestinations, target, "event destination");
        state.eventDestinations = state.eventDestinations.filter((destination) => destination.id !== target);
        break;
      }
    }
    if (step.produces) {
      if (!made) throw new Error(`${step.call} made nothing for ${step.produces}.`);
      ids.set(step.produces, made);
    }
    ran += 1;
  }
  return { snapshot: state, ran, secrets };
}

/** A portal configuration as Stripe answers one made or changed with these parameters. */
function portalConfiguration(id: string, params: Record<string, any>): StripePortalConfiguration {
  const features = params.features ?? {};
  const update = features.subscription_update ?? { enabled: false };
  const cancel = features.subscription_cancel ?? { enabled: false };
  return {
    id,
    active: params.active ?? true,
    is_default: false,
    name: params.name ?? null,
    metadata: { ...params.metadata },
    default_return_url: params.default_return_url ?? null,
    business_profile: { headline: params.business_profile?.headline ?? null, privacy_policy_url: params.business_profile?.privacy_policy_url ?? null, terms_of_service_url: params.business_profile?.terms_of_service_url ?? null },
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
        schedule_at_period_end: { conditions: [...(update.schedule_at_period_end?.conditions ?? [])] },
      },
    },
  };
}
