// Ending a deleted business's plan.
import type { JobEnvelope } from "@lobbystack/contracts";
import { claimBillingSubscription } from "@lobbystack/domain";
import { isLiveSubscriptionState } from "@lobbystack/domain";
import { recordDeletedBusinessPlanEnded } from "@lobbystack/domain";
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
 * Ends a business's Polar subscription at once, for an owner deleting the
 * business, and records it, so the delete can go ahead; the delete asks again
 * every 10 minutes while the plan is live. A canceled business's plan ends
 * the same way, asked once when the owner confirms. A subscription Polar still shows
 * live afterwards fails the try. One Polar set to end with its period counts
 * as ended: it stays until then, but nothing renews it.
 */
async function revokeDeletedBusinessPlan(dependencies: WorkerDependencies, input: { businessId: string; subscriptionId: string }): Promise<JobResult> {
  const { businessId, subscriptionId } = input;
  const billing = dependencies.billing;
  if (!billing) {
    await reportWarning(new Error("A business being deleted or canceled still pays for a plan, and the worker has no Polar token to end it with. Set POLAR_ACCESS_TOKEN and POLAR_ORGANIZATION_ID on the worker."), { operation: "job.billing.revokeSubscription", businessId });
    return { status: "skipped", entityId: businessId };
  }
  // A plan change or a promo plan's ending is changing the subscription: this waits for it.
  const hold = await claimBillingSubscription(dependencies.domain, { businessId });
  if ("retryAt" in hold) return { status: "deferred", entityId: businessId, retryAt: hold.retryAt };
  try {
    await billing.revoke({ subscriptionId, requestId: `revoke:${subscriptionId}` });
    const subscription = await billing.getSubscription(subscriptionId);
    if (subscription && !subscription.endedAt && isLiveSubscriptionState(subscription.state) && !subscription.cancelAt) throw new Error("Polar still shows the subscription live after ending it.");
  } catch (error) {
    if (planChangeRefusalFor(billing, error) !== "token_scope") throw error;
    // Every try would be refused the same way; the operator's to fix, and the delete says the plan couldn't be canceled.
    await reportWarning(new Error("Polar refused to end the plan of a business being deleted or canceled: the worker's POLAR_ACCESS_TOKEN needs subscriptions:write."), { operation: "job.billing.revokeSubscription", businessId });
    return { status: "skipped", entityId: businessId };
  } finally {
    await handBackBillingSubscription(dependencies, { businessId, claimId: hold.claimId });
  }
  await recordDeletedBusinessPlanEnded(dependencies.domain, { businessId, subscriptionId });
  return { status: "completed", entityId: businessId };
}
