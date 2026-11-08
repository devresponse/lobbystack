import { createHash } from "node:crypto";

import Stripe from "stripe";

import { canonicalJson, stripeKeyMode } from "@lobbystack/shared";

import type { BillingCatalogClient, BillingEnv } from "../billing/types";
import { createStripeClient } from "./client";

// A Stripe account's catalog as pnpm billing and the daily check read it, and
// the calls a catalog plan makes (the Stripe plan's steps 10 and 11). The
// domain's planner (packages/domain/src/server/billingStripe.ts) decides from
// a StripeSnapshot; StripeCatalogClient reads one and runs the steps. Each
// object keeps only the fields the planner and verify read, under Stripe's
// own names.

export type StripeMetadata = Record<string, string>;

export type StripeCatalogProduct = {
  id: string;
  name: string;
  active: boolean;
  metadata: StripeMetadata;
  /** The tax code's ID, such as txcd_10103001. */
  tax_code: string | null;
  /** Seconds since the epoch. */
  created: number;
};

export type StripeCatalogPrice = {
  id: string;
  active: boolean;
  /** The product's ID. */
  product: string;
  currency: string;
  unit_amount: number | null;
  lookup_key: string | null;
  /** exclusive, inclusive or unspecified; Stripe may add others, as for each of the snapshot's words. */
  tax_behavior: string | null;
  /** interval is day, week, month or year; usage_type licensed or metered. */
  recurring: { interval: string; interval_count: number; usage_type: string; meter: string | null } | null;
  metadata: StripeMetadata;
  created: number;
};

/** A billing meter. Meters carry no metadata: LobbyStack's are found by their event names. */
export type StripeCatalogMeter = {
  id: string;
  display_name: string;
  event_name: string;
  /** active or inactive. */
  status: string;
  default_aggregation: { formula: string };
  customer_mapping: { type: string; event_payload_key: string };
  value_settings: { event_payload_key: string };
};

export type StripeCatalogCoupon = {
  id: string;
  name: string | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  /** once, repeating or forever. */
  duration: string;
  duration_in_months: number | null;
  /** The products it applies to, read with expand applies_to; null when it applies to any. */
  applies_to: { products: string[] } | null;
  metadata: StripeMetadata;
  valid: boolean;
  times_redeemed: number;
};

export type StripePortalConfiguration = {
  id: string;
  active: boolean;
  is_default: boolean;
  name: string | null;
  metadata: StripeMetadata;
  default_return_url: string | null;
  business_profile: { headline: string | null; privacy_policy_url: string | null; terms_of_service_url: string | null };
  features: {
    customer_update: { enabled: boolean; allowed_updates: string[] };
    invoice_history: { enabled: boolean };
    payment_method_update: { enabled: boolean };
    subscription_cancel: { enabled: boolean; mode: string; proration_behavior: string };
    subscription_update: {
      enabled: boolean;
      default_allowed_updates: string[];
      products: Array<{ product: string; prices: string[] }> | null;
      proration_behavior: string;
      billing_cycle_anchor: string | null;
      schedule_at_period_end: { conditions: Array<{ type: string }> };
    };
  };
};

export type StripeCatalogWebhook = {
  id: string;
  url: string;
  enabled_events: string[];
  api_version: string | null;
  status: "enabled" | "disabled";
  metadata: StripeMetadata;
  description: string | null;
};

/** A v2 event destination, listed with include webhook_endpoint.url. */
export type StripeEventDestination = {
  id: string;
  name: string;
  type: string;
  /** snapshot or thin. */
  event_payload: string;
  enabled_events: string[];
  /** enabled or disabled. */
  status: string;
  /** The webhook endpoint's address; null for another type of destination. */
  url: string | null;
  metadata: StripeMetadata;
};

/** Stripe Tax as the account has it: its status, whether it has an origin address, and how many active registrations. */
export type StripeTaxState = { status: "active" | "pending"; headOffice: boolean; registrations: number };

/** What pnpm billing and the daily check read from a Stripe account. */
export type StripeSnapshot = {
  account: { id: string; name: string | null };
  /** The key's mode: sandbox for a test key, live for a live one. */
  mode: "sandbox" | "live";
  products: StripeCatalogProduct[];
  prices: StripeCatalogPrice[];
  meters: StripeCatalogMeter[];
  coupons: StripeCatalogCoupon[];
  portalConfigurations: StripePortalConfiguration[];
  webhooks: StripeCatalogWebhook[];
  eventDestinations: StripeEventDestination[];
  /** Null when the key may not read Stripe Tax's settings. */
  tax: StripeTaxState | null;
};

/** The SDK calls a catalog plan makes, as the SDK names them. */
export const stripeCatalogCalls = [
  "products.create",
  "products.update",
  "prices.create",
  "prices.update",
  "billing.meters.create",
  "billing.meters.update",
  "billing.meters.reactivate",
  "coupons.create",
  "coupons.update",
  "coupons.del",
  "billingPortal.configurations.create",
  "billingPortal.configurations.update",
  "webhookEndpoints.create",
  "webhookEndpoints.update",
  "webhookEndpoints.del",
  "v2.core.eventDestinations.create",
  "v2.core.eventDestinations.update",
  "v2.core.eventDestinations.enable",
  "v2.core.eventDestinations.del",
] as const;
export type StripeCatalogCall = (typeof stripeCatalogCalls)[number];

/** An object made earlier in the same run, named until Stripe gives it an ID. */
export type StripeRef = { $ref: string };

export const stripeRef = (name: string): StripeRef => ({ $ref: name });
export const isStripeRef = (value: unknown): value is StripeRef => Boolean(value && typeof value === "object" && "$ref" in value);

/** One Stripe call of a catalog plan, as the runner needs it: the domain's StripeStep adds what people read. */
export type StripeCatalogStep = {
  object: string;
  action: string;
  call: StripeCatalogCall;
  /** The object an update, archive or delete acts on: its ID, or a ref to one made earlier in the run. */
  target?: string | StripeRef;
  /** The call's parameters. A ref in them is an object made earlier in the run. */
  params: Record<string, unknown>;
  /** catalog:BRAND:OBJECT:KEY on a create; the runner adds a hash of the resolved parameters, so a run cut off halfway and run again gets the same object. */
  idempotencyKey?: string;
  /** The ref the created object's ID answers to. */
  produces?: string;
};

/** The calls pnpm billing's keys and the worker's daily check make, as the SDK names them. */
export type StripeCatalogApi = {
  accounts: Pick<Stripe["accounts"], "retrieveCurrent">;
  products: Pick<Stripe["products"], "list" | "create" | "update">;
  prices: Pick<Stripe["prices"], "list" | "create" | "update">;
  billing: { meters: Pick<Stripe["billing"]["meters"], "list" | "create" | "update" | "reactivate"> };
  coupons: Pick<Stripe["coupons"], "list" | "create" | "update" | "del">;
  billingPortal: { configurations: Pick<Stripe["billingPortal"]["configurations"], "list" | "create" | "update"> };
  webhookEndpoints: Pick<Stripe["webhookEndpoints"], "list" | "create" | "update" | "del">;
  v2: { core: { eventDestinations: Pick<Stripe["v2"]["core"]["eventDestinations"], "list" | "create" | "update" | "enable" | "del"> } };
  tax: { settings: Pick<Stripe["tax"]["settings"], "retrieve">; registrations: Pick<Stripe["tax"]["registrations"], "list"> };
};

/** What a run made that Stripe shows once: the webhook endpoint's secret and the meter error destination's. */
export type StripeCatalogSecrets = { webhookSecret: string | null; meterWebhookSecret: string | null };

type Resolved = { target: string | undefined; params: Record<string, any>; options: Stripe.RequestOptions };
type Made = { id?: unknown; secret?: unknown; webhook_endpoint?: { signing_secret?: unknown } | null };

/** Each call of a catalog step on the SDK. */
const catalogCalls: Record<StripeCatalogCall, (api: StripeCatalogApi, call: Resolved) => Promise<unknown>> = {
  "products.create": (api, call) => api.products.create(call.params as Stripe.ProductCreateParams, call.options),
  "products.update": (api, call) => api.products.update(call.target!, call.params),
  "prices.create": (api, call) => api.prices.create(call.params as Stripe.PriceCreateParams, call.options),
  "prices.update": (api, call) => api.prices.update(call.target!, call.params),
  "billing.meters.create": (api, call) => api.billing.meters.create(call.params as Stripe.Billing.MeterCreateParams, call.options),
  "billing.meters.update": (api, call) => api.billing.meters.update(call.target!, call.params),
  "billing.meters.reactivate": (api, call) => api.billing.meters.reactivate(call.target!),
  "coupons.create": (api, call) => api.coupons.create(call.params, call.options),
  "coupons.update": (api, call) => api.coupons.update(call.target!, call.params),
  "coupons.del": (api, call) => api.coupons.del(call.target!),
  "billingPortal.configurations.create": (api, call) => api.billingPortal.configurations.create(call.params as Stripe.BillingPortal.ConfigurationCreateParams, call.options),
  "billingPortal.configurations.update": (api, call) => api.billingPortal.configurations.update(call.target!, call.params),
  "webhookEndpoints.create": (api, call) => api.webhookEndpoints.create(call.params as Stripe.WebhookEndpointCreateParams, call.options),
  "webhookEndpoints.update": (api, call) => api.webhookEndpoints.update(call.target!, call.params),
  "webhookEndpoints.del": (api, call) => api.webhookEndpoints.del(call.target!),
  "v2.core.eventDestinations.create": (api, call) => api.v2.core.eventDestinations.create(call.params as Stripe.V2.Core.EventDestinationCreateParams, call.options),
  "v2.core.eventDestinations.update": (api, call) => api.v2.core.eventDestinations.update(call.target!, call.params),
  "v2.core.eventDestinations.enable": (api, call) => api.v2.core.eventDestinations.enable(call.target!),
  "v2.core.eventDestinations.del": (api, call) => api.v2.core.eventDestinations.del(call.target!),
};

function resolveRefs(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (isStripeRef(value)) {
    const id = ids.get(value.$ref);
    if (!id) throw new Error(`No Stripe ID for ${value.$ref}: the call that makes it didn't run.`);
    return id;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry, ids)]));
  return value;
}

const metadataOf = (value: Stripe.Metadata | null | undefined): StripeMetadata => ({ ...(value ?? {}) });
const idOf = (value: string | { id: string } | null | undefined): string | null => (typeof value === "string" ? value : value?.id ?? null);
const seconds = (value: number | string) => (typeof value === "number" ? value : Math.floor(new Date(value).getTime() / 1000));

/** Every object of a list, page after page. */
async function all<T>(list: { autoPagingToArray(options: { limit: number }): Promise<T[]> }): Promise<T[]> {
  return await list.autoPagingToArray({ limit: 10_000 });
}

/**
 * Reads a Stripe account's catalog objects and runs a catalog plan's calls
 * (ADR 0010, the Stripe plan's step 11), with pnpm billing's setup or read
 * key, or the worker's key for the daily check.
 */
export class StripeCatalogClient implements BillingCatalogClient<StripeSnapshot, StripeCatalogStep> {
  readonly provider = "stripe" as const;
  private readonly mode: BillingEnv;

  constructor(private readonly api: StripeCatalogApi, options: { key: string }) {
    const mode = stripeKeyMode(options.key);
    if (!mode) throw new Error("A Stripe catalog key is a secret or restricted key (sk_ or rk_).");
    this.mode = mode;
  }

  /**
   * The account's products, prices, meters, coupons, billing portal
   * configurations, Stripe Tax settings and, unless webhooks is false, its
   * webhook endpoints and event destinations, which the daily check leaves
   * out. A key that may not read Stripe Tax gets tax null.
   */
  async readSnapshot(options: { webhooks?: boolean } = {}): Promise<StripeSnapshot> {
    const withWebhooks = options.webhooks !== false;
    const account = await this.api.accounts.retrieveCurrent();
    const [products, prices, meters, coupons, configurations, webhooks, destinations, tax] = await Promise.all([
      all(this.api.products.list({ limit: 100 })),
      all(this.api.prices.list({ limit: 100 })),
      all(this.api.billing.meters.list({ limit: 100 })),
      all(this.api.coupons.list({ limit: 100, expand: ["data.applies_to"] })),
      all(this.api.billingPortal.configurations.list({ limit: 100 })),
      withWebhooks ? all(this.api.webhookEndpoints.list({ limit: 100 })) : Promise.resolve([]),
      withWebhooks ? all(this.api.v2.core.eventDestinations.list({ include: ["webhook_endpoint.url"] })) : Promise.resolve([]),
      this.readTax(),
    ]);
    return {
      account: { id: account.id, name: account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? null },
      mode: this.mode,
      products: products.map((product) => ({ id: product.id, name: product.name, active: product.active, metadata: metadataOf(product.metadata), tax_code: idOf(product.tax_code), created: product.created })),
      prices: prices.map((price) => ({
        id: price.id,
        active: price.active,
        product: idOf(price.product) ?? "",
        currency: price.currency,
        unit_amount: price.unit_amount,
        lookup_key: price.lookup_key,
        tax_behavior: price.tax_behavior,
        recurring: price.recurring ? { interval: price.recurring.interval, interval_count: price.recurring.interval_count, usage_type: price.recurring.usage_type, meter: price.recurring.meter } : null,
        metadata: metadataOf(price.metadata),
        created: price.created,
      })),
      meters: meters.map((meter) => ({ id: meter.id, display_name: meter.display_name, event_name: meter.event_name, status: meter.status, default_aggregation: { formula: meter.default_aggregation.formula }, customer_mapping: { type: meter.customer_mapping.type, event_payload_key: meter.customer_mapping.event_payload_key }, value_settings: { event_payload_key: meter.value_settings.event_payload_key } })),
      coupons: coupons.map((coupon) => ({ id: coupon.id, name: coupon.name, percent_off: coupon.percent_off, amount_off: coupon.amount_off, currency: coupon.currency, duration: coupon.duration, duration_in_months: coupon.duration_in_months, applies_to: coupon.applies_to ? { products: [...coupon.applies_to.products] } : null, metadata: metadataOf(coupon.metadata), valid: coupon.valid, times_redeemed: coupon.times_redeemed })),
      portalConfigurations: configurations.map((configuration) => portalConfigurationOf(configuration)),
      webhooks: webhooks.map((endpoint) => ({ id: endpoint.id, url: endpoint.url, enabled_events: [...endpoint.enabled_events], api_version: endpoint.api_version, status: endpoint.status === "disabled" ? "disabled" : "enabled", metadata: metadataOf(endpoint.metadata), description: endpoint.description })),
      eventDestinations: destinations.map((destination) => ({ id: destination.id, name: destination.name, type: destination.type, event_payload: destination.event_payload, enabled_events: [...destination.enabled_events], status: destination.status, url: destination.webhook_endpoint?.url ?? null, metadata: metadataOf(destination.metadata) })),
      tax,
    };
  }

  private async readTax(): Promise<StripeTaxState | null> {
    try {
      const settings = await this.api.tax.settings.retrieve();
      const registrations = await all(this.api.tax.registrations.list({ status: "active", limit: 100 }));
      return { status: settings.status === "active" ? "active" : "pending", headOffice: settings.head_office !== null, registrations: registrations.length };
    } catch (error) {
      // A key without Stripe Tax's read permission.
      if (error instanceof Stripe.errors.StripePermissionError) return null;
      throw error;
    }
  }

  /**
   * Makes each call in order, putting the IDs of objects made earlier into the
   * ones after. A create carries its idempotency key and a hash of what it
   * sends, so a call retried with the same parameters gets the same object.
   * Stops at the first failure: what landed is found again on the next run.
   * Returns the secrets of an endpoint and a destination this run made, which
   * Stripe never shows again; onStep hears each with the call that made it,
   * so a caller keeps it even when a later call fails.
   */
  async run<Step extends StripeCatalogStep>(steps: readonly Step[], onStep?: (step: Step, secret: string | null) => void): Promise<StripeCatalogSecrets> {
    const ids = new Map<string, string>();
    const secrets: StripeCatalogSecrets = { webhookSecret: null, meterWebhookSecret: null };
    for (const step of steps) {
      const params = resolveRefs(step.params, ids) as Record<string, any>;
      const target = step.target === undefined ? undefined : (resolveRefs(step.target, ids) as string);
      const options: Stripe.RequestOptions = step.idempotencyKey ? { idempotencyKey: `${step.idempotencyKey}:${createHash("sha256").update(canonicalJson(params)).digest("hex").slice(0, 16)}` } : {};
      const result = (await catalogCalls[step.call](this.api, { target, params, options })) as Made | null;
      if (step.produces) {
        if (typeof result?.id !== "string") throw new Error(`Stripe made ${(step as { subject?: string }).subject ?? step.object} but sent no ID back. Run again: it is found by its tags.`);
        ids.set(step.produces, result.id);
      }
      const secret = step.call === "webhookEndpoints.create" && typeof result?.secret === "string" ? result.secret
        : step.call === "v2.core.eventDestinations.create" && typeof result?.webhook_endpoint?.signing_secret === "string" ? result.webhook_endpoint.signing_secret
        : null;
      if (secret && step.call === "webhookEndpoints.create") secrets.webhookSecret = secret;
      if (secret && step.call === "v2.core.eventDestinations.create") secrets.meterWebhookSecret = secret;
      onStep?.(step, secret);
    }
    return secrets;
  }
}

/** A portal configuration as the snapshot keeps it. */
function portalConfigurationOf(configuration: Stripe.BillingPortal.Configuration): StripePortalConfiguration {
  const features = configuration.features;
  const update = features.subscription_update;
  return {
    id: configuration.id,
    active: configuration.active,
    is_default: configuration.is_default,
    name: configuration.name ?? null,
    metadata: metadataOf(configuration.metadata),
    default_return_url: configuration.default_return_url,
    business_profile: { headline: configuration.business_profile.headline, privacy_policy_url: configuration.business_profile.privacy_policy_url ?? null, terms_of_service_url: configuration.business_profile.terms_of_service_url ?? null },
    features: {
      customer_update: { enabled: features.customer_update.enabled, allowed_updates: [...features.customer_update.allowed_updates] },
      invoice_history: { enabled: features.invoice_history.enabled },
      payment_method_update: { enabled: features.payment_method_update.enabled },
      subscription_cancel: { enabled: features.subscription_cancel.enabled, mode: features.subscription_cancel.mode, proration_behavior: features.subscription_cancel.proration_behavior },
      subscription_update: {
        enabled: update.enabled,
        default_allowed_updates: [...update.default_allowed_updates],
        products: update.products ? update.products.map((entry) => ({ product: entry.product, prices: [...entry.prices] })) : null,
        proration_behavior: update.proration_behavior,
        billing_cycle_anchor: update.billing_cycle_anchor ?? null,
        schedule_at_period_end: { conditions: (update.schedule_at_period_end?.conditions ?? []).map((condition) => ({ type: condition.type })) },
      },
    },
  };
}

/** The catalog client on a key: pnpm billing's setup or read key, or the worker's. */
export function createStripeCatalogClient(key: string): StripeCatalogClient {
  return new StripeCatalogClient(createStripeClient(key), { key });
}
