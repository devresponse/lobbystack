import { polarBaseUrls } from "@lobbystack/shared";
import { PolarBilling } from "../polar/adapter";
import { PolarWebhook } from "../polar/events";
import { PolarBillingProvider } from "../polar/polarBilling";
import { PolarCatalogClient } from "../polar/polarCatalog";
import type { BillingEnv, BillingProvider, BillingProviderId, BillingWebhook } from "./types";

// Builds the deployment's billing provider from its variables. Apart from the
// scripts in devops/ and scripts/, the only code that reads POLAR_* variables.

type Env = Record<string, string | undefined>;

/** The deployment's billing provider: BILLING_PROVIDER, Polar when unset. Anything else stops the service at startup. */
export function readBillingProviderId(env: Env): BillingProviderId {
  const value = env.BILLING_PROVIDER?.trim().toLowerCase() ?? "";
  if (value === "" || value === "polar") return "polar";
  if (value === "stripe") throw new Error("BILLING_PROVIDER=stripe isn't available yet: Stripe billing is still being built. Leave it unset for Polar.");
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
  readBillingProviderId(env);
  const accessToken = env.POLAR_ACCESS_TOKEN;
  const organizationId = env.POLAR_ORGANIZATION_ID;
  if (!accessToken || !organizationId) return undefined;
  const client = new PolarBillingProvider({ accessToken, organizationId, ...(env.POLAR_API_BASE_URL ? { baseUrl: env.POLAR_API_BASE_URL } : {}) });
  return new PolarBilling(client, { organizationId, env: polarEnv(env.POLAR_API_BASE_URL) });
}

/** The deployment's webhook: its signature check with POLAR_WEBHOOK_SECRET, and its events in LobbyStack's terms. */
export function createBillingWebhook(env: Env): BillingWebhook {
  readBillingProviderId(env);
  return new PolarWebhook(env.POLAR_WEBHOOK_SECRET);
}

/**
 * The catalog client the daily billing check reads with: the given token, or
 * else the worker's own POLAR_ACCESS_TOKEN with POLAR_ORGANIZATION_ID set.
 * Undefined without them.
 */
export function createBillingCatalogClient(env: Env, token?: string): PolarCatalogClient | undefined {
  readBillingProviderId(env);
  const key = token?.trim() || (env.POLAR_ORGANIZATION_ID?.trim() ? env.POLAR_ACCESS_TOKEN?.trim() : undefined);
  if (!key) return undefined;
  return new PolarCatalogClient({ token: key, baseUrl: env.POLAR_API_BASE_URL?.trim() || polarBaseUrls.production });
}
