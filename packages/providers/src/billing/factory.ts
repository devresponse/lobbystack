import { polarBaseUrls } from "@lobbystack/shared";
import { PolarBilling } from "../polar/adapter";
import { PolarWebhook } from "../polar/events";
import { PolarBillingProvider } from "../polar/polarBilling";
import { PolarCatalogClient } from "../polar/polarCatalog";
import { StripeBilling } from "../stripe/adapter";
import { createStripeCatalogClient, type StripeCatalogClient } from "../stripe/catalog";
import { createStripeClient, stripeKeyEnv } from "../stripe/client";
import type { BillingEnv, BillingProvider, BillingProviderId, BillingWebhook } from "./types";

// Builds the deployment's billing provider from its variables. Apart from the
// scripts in devops/ and scripts/, the only code that reads POLAR_* and
// STRIPE_* variables.

type Env = Record<string, string | undefined>;

/**
 * The deployment's billing provider: BILLING_PROVIDER, Polar when unset.
 * Until step 18 of the Stripe plan switches it on, Stripe also needs
 * BILLING_STRIPE_PREVIEW=true, and takes test keys only. Anything else stops
 * the service at startup.
 */
export function readBillingProviderId(env: Env): BillingProviderId {
  const value = env.BILLING_PROVIDER?.trim().toLowerCase() ?? "";
  if (value === "" || value === "polar") return "polar";
  if (value === "stripe") {
    if (env.BILLING_STRIPE_PREVIEW?.trim().toLowerCase() !== "true") throw new Error("BILLING_PROVIDER=stripe isn't available yet: Stripe billing is still being built. Set BILLING_STRIPE_PREVIEW=true, with Stripe test keys, to try it, or leave BILLING_PROVIDER unset for Polar.");
    return "stripe";
  }
  throw new Error(`BILLING_PROVIDER must be polar or stripe, not "${env.BILLING_PROVIDER}".`);
}

/** Polar's sandbox or production, as POLAR_API_BASE_URL says; unset means production. */
function polarEnv(baseUrl: string | undefined): BillingEnv {
  return baseUrl?.trim().replace(/\/$/, "") === polarBaseUrls.sandbox ? "sandbox" : "live";
}

/**
 * The provider the worker and the admin call, or undefined when the deployment
 * has no billing credentials: POLAR_ACCESS_TOKEN and POLAR_ORGANIZATION_ID.
 */
export function createBillingProvider(env: Env): BillingProvider | undefined {
  if (readBillingProviderId(env) === "stripe") return createStripeBilling(env);
  const accessToken = env.POLAR_ACCESS_TOKEN;
  const organizationId = env.POLAR_ORGANIZATION_ID;
  if (!accessToken || !organizationId) return undefined;
  const client = new PolarBillingProvider({ accessToken, organizationId, ...(env.POLAR_API_BASE_URL ? { baseUrl: env.POLAR_API_BASE_URL } : {}) });
  return new PolarBilling(client, { organizationId, env: polarEnv(env.POLAR_API_BASE_URL) });
}

/**
 * Stripe's adapter from the worker's or the admin's STRIPE_API_KEY and
 * STRIPE_ACCOUNT_ID, or undefined without them. In the preview the key must
 * be a test one. checkStripeAccount, the check of the key's own account, runs
 * at the worker's startup once the worker bills on Stripe (step 13).
 */
function createStripeBilling(env: Env): StripeBilling | undefined {
  const key = env.STRIPE_API_KEY?.trim();
  const accountId = env.STRIPE_ACCOUNT_ID?.trim();
  if (!key || !accountId) return undefined;
  const keyEnv = stripeKeyEnv(key);
  if (keyEnv === null) throw new Error("STRIPE_API_KEY must be a Stripe secret or restricted key (sk_ or rk_).");
  if (keyEnv !== "sandbox") throw new Error("BILLING_STRIPE_PREVIEW takes Stripe test keys only (sk_test_ or rk_test_): live Stripe billing comes with step 18 of the Stripe plan.");
  return new StripeBilling(createStripeClient(key), { accountId, env: keyEnv, deployment: env.APP_BASE_URL?.trim() || null });
}

/** The deployment's webhook: its signature check with POLAR_WEBHOOK_SECRET, and its events in LobbyStack's terms. */
export function createBillingWebhook(env: Env): BillingWebhook {
  if (readBillingProviderId(env) === "stripe") throw new Error("Stripe's webhook isn't available yet: step 12 of the Stripe plan adds it.");
  return new PolarWebhook(env.POLAR_WEBHOOK_SECRET);
}

/**
 * The catalog client the daily billing check reads with: the given token or
 * key, or else the worker's own, POLAR_ACCESS_TOKEN with POLAR_ORGANIZATION_ID
 * set, or STRIPE_API_KEY with STRIPE_ACCOUNT_ID set. Undefined without them.
 */
export function createBillingCatalogClient(env: Env, token?: string): PolarCatalogClient | StripeCatalogClient | undefined {
  if (readBillingProviderId(env) === "stripe") {
    const key = token?.trim() || (env.STRIPE_ACCOUNT_ID?.trim() ? env.STRIPE_API_KEY?.trim() : undefined);
    if (!key) return undefined;
    const keyEnv = stripeKeyEnv(key);
    if (keyEnv === null) throw new Error("STRIPE_API_KEY must be a Stripe secret or restricted key (sk_ or rk_).");
    if (keyEnv !== "sandbox") throw new Error("BILLING_STRIPE_PREVIEW takes Stripe test keys only (sk_test_ or rk_test_): live Stripe billing comes with step 18 of the Stripe plan.");
    return createStripeCatalogClient(key);
  }
  const key = token?.trim() || (env.POLAR_ORGANIZATION_ID?.trim() ? env.POLAR_ACCESS_TOKEN?.trim() : undefined);
  if (!key) return undefined;
  return new PolarCatalogClient({ token: key, baseUrl: env.POLAR_API_BASE_URL?.trim() || polarBaseUrls.production });
}
