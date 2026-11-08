import type { BillingCatalogClient } from "../billing/types";
import { stripeNotYet } from "./errors";

// A Stripe account's catalog as pnpm billing and the daily check read it, and
// the calls a catalog plan makes (the Stripe plan's steps 10 and 11). The
// domain's planner (packages/domain/src/server/billingStripe.ts) decides from
// a StripeSnapshot; StripeCatalogClient reads one and runs the steps, which
// step 11 adds. Each object keeps only the fields the planner and verify read,
// under Stripe's own names.

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
  tax_behavior: "exclusive" | "inclusive" | "unspecified" | null;
  recurring: { interval: "day" | "week" | "month" | "year"; interval_count: number; usage_type: "licensed" | "metered"; meter: string | null } | null;
  metadata: StripeMetadata;
  created: number;
};

/** A billing meter. Meters carry no metadata: LobbyStack's are found by their event names. */
export type StripeCatalogMeter = {
  id: string;
  display_name: string;
  event_name: string;
  status: "active" | "inactive";
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
  duration: "once" | "repeating" | "forever";
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
  event_payload: "snapshot" | "thin";
  enabled_events: string[];
  status: "enabled" | "disabled";
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

export class StripeCatalogClient implements BillingCatalogClient<StripeSnapshot, StripeCatalogStep> {
  readonly provider = "stripe" as const;

  async readSnapshot(): Promise<StripeSnapshot> {
    throw stripeNotYet("read the catalog", 11);
  }

  async run(): Promise<{ webhookSecret: string | null }> {
    throw stripeNotYet("set the catalog up", 11);
  }
}
