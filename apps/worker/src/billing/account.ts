// The worker's startup check of the billing provider's account (the Stripe plan's step 13).
import type { BillingProvider } from "@lobbystack/providers/billing/types";
import { logEvent } from "@lobbystack/telemetry/node";
import type { WorkerDependencies } from "../handlers";

/**
 * The deployment's billing, once its credentials prove to be the
 * deployment's own account: a Stripe key of another account would bill or
 * look for the wrong customers. On a mismatch the worker runs without billing,
 * as without a key, so billing jobs wait, and ops.billing.provider_mismatch
 * tells the operator. When the provider can't be reached, it bills on.
 */
export async function checkedBilling(billing: BillingProvider | undefined, productAnalytics: WorkerDependencies["productAnalytics"]): Promise<BillingProvider | undefined> {
  if (!billing?.checkAccount) return billing;
  let mismatch: Awaited<ReturnType<NonNullable<BillingProvider["checkAccount"]>>>;
  try {
    mismatch = await billing.checkAccount();
  } catch (error) {
    logEvent("warn", "ops.billing.account_unchecked", { provider: billing.id, error });
    return billing;
  }
  if (!mismatch) return billing;
  // The event belongs to the deployment, not a business, so it goes straight to PostHog, as the daily check's do.
  const properties = { provider: billing.id, providerEnv: billing.env, expectedAccount: mismatch.expected, foundAccount: mismatch.found };
  logEvent("error", "ops.billing.provider_mismatch", properties);
  try {
    await productAnalytics?.capture([{ event: "ops.billing.provider_mismatch", distinctId: "system:deployment", properties, timestamp: new Date().toISOString() }]);
  } catch {
    // The log line stands either way.
  }
  return undefined;
}
