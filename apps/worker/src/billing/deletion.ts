// Ending a deleted business's plan.
import type { JobEnvelope } from "@lobbystack/contracts";
import { claimBillingSubscription, isLiveSubscriptionState, loadOverageWork, recordDeletedBusinessPlanEnded } from "@lobbystack/domain";
import { billingProviderNames, billingProviderOf } from "@lobbystack/shared";
import { reportWarning } from "@lobbystack/telemetry/node";
import type { JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";
import { handBackBillingSubscription, planChangeRefusalFor } from "./planChange";

/** billing.revokeSubscription: ends a deleted business's plan. */
export async function revokeBillingSubscription(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const subscriptionId = typeof job.payload.subscriptionId === "string" ? job.payload.subscriptionId : "";
  if (!subscriptionId) return { status: "skipped", entityId: subscriptionId };
  return await revokeDeletedBusinessPlan(dependencies, { businessId: businessIdOrThrow(job), subscriptionId });
}

/**
 * Ends a business's subscription at once, for an owner deleting the
 * business, and records it, so the delete can go ahead; the delete asks again
 * every 10 minutes while the plan is live. A canceled business's plan ends
 * the same way, asked once when the owner confirms. A subscription the provider
 * still shows live afterwards fails the try. One Polar set to end with its
 * period counts as ended: it stays until then, but nothing renews it. On
 * Stripe, the overage subscription ends with it.
 */
async function revokeDeletedBusinessPlan(dependencies: WorkerDependencies, input: { businessId: string; subscriptionId: string }): Promise<JobResult> {
  const { businessId, subscriptionId } = input;
  const billing = dependencies.billing;
  if (!billing) {
    const credentials = billingProviderOf(process.env) === "stripe" ? "Stripe key to end it with. Set STRIPE_API_KEY, of the account STRIPE_ACCOUNT_ID names," : "Polar token to end it with. Set POLAR_ACCESS_TOKEN and POLAR_ORGANIZATION_ID";
    await reportWarning(new Error(`A business being deleted or canceled still pays for a plan, and the worker has no ${credentials} on the worker.`), { operation: "job.billing.revokeSubscription", businessId });
    return { status: "skipped", entityId: businessId };
  }
  // A plan change or a promo plan's ending is changing the subscription: this waits for it.
  const hold = await claimBillingSubscription(dependencies.domain, { businessId });
  if ("retryAt" in hold) return { status: "deferred", entityId: businessId, retryAt: hold.retryAt };
  try {
    await billing.revoke({ subscriptionId, requestId: `revoke:${subscriptionId}` });
    // On Stripe the overage subscription ends with it, invoicing the month's usage so far.
    const overage = billing.endOverage ? (await loadOverageWork(dependencies.domain, { businessId }))?.overageSubscriptionId : null;
    if (overage) await billing.endOverage!({ subscriptionId: overage, when: "now" });
    const subscription = await billing.getSubscription(subscriptionId);
    if (subscription && !subscription.endedAt && isLiveSubscriptionState(subscription.state) && !subscription.cancelAt) throw new Error(`${billingProviderNames[billing.id]} still shows the subscription live after ending it.`);
  } catch (error) {
    if (planChangeRefusalFor(billing, error) !== "token_scope") throw error;
    // Every try would be refused the same way; the operator's to fix, and the delete says the plan couldn't be canceled.
    const access = billing.id === "stripe" ? "STRIPE_API_KEY needs write access to subscriptions" : "POLAR_ACCESS_TOKEN needs subscriptions:write";
    await reportWarning(new Error(`${billingProviderNames[billing.id]} refused to end the plan of a business being deleted or canceled: the worker's ${access}.`), { operation: "job.billing.revokeSubscription", businessId });
    return { status: "skipped", entityId: businessId };
  } finally {
    await handBackBillingSubscription(dependencies, { businessId, claimId: hold.claimId });
  }
  await recordDeletedBusinessPlanEnded(dependencies.domain, { businessId, subscriptionId });
  return { status: "completed", entityId: businessId };
}
