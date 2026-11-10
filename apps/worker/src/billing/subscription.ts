// Cancelling a plan at its renewal, resuming it, and keeping it (the Stripe plan's step 15).
import type { JobEnvelope } from "@lobbystack/contracts";
import { billingProviderNames, planChangeRefusalSentence } from "@lobbystack/shared";
import { claimBillingCheckoutRequest, claimBillingSubscription, isLiveSubscriptionState, loadBillingSubscriptionRequest, markBillingCheckoutFailed, markBillingPlanChanged, releaseBillingCheckoutRequest } from "@lobbystack/domain";
import { reportWarning } from "@lobbystack/telemetry/node";
import type { JobExecution, JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";
import { failBillingCheckoutTry, handBackBillingSubscription, planChangeRefusalFor } from "./planChange";

/**
 * billing.changeSubscription: ends the plan at its renewal, undoes that, or
 * drops a change waiting for the renewal, as Settings > Plan or the API
 * asked. The request ends changed, and the provider's webhook then shows the
 * change on the account; or in error, with the refusal the business hears.
 */
export async function changeBillingSubscription(job: JobEnvelope, dependencies: WorkerDependencies, execution: JobExecution = {}): Promise<JobResult> {
  const businessId = businessIdOrThrow(job);
  const requestId = String(job.payload.requestId ?? "");
  if (!requestId) return { status: "skipped", entityId: requestId };
  const claim = await claimBillingCheckoutRequest(dependencies.domain, { businessId, requestId });
  if (!claim.claimed) return claim.retryAt ? { status: "deferred", entityId: requestId, retryAt: claim.retryAt } : { status: "skipped", entityId: requestId };
  const retrying = execution.isFinalAttempt === false;
  const work = await loadBillingSubscriptionRequest(dependencies.domain, { businessId, requestId });
  if (!work) return { status: "skipped", entityId: requestId };
  const billing = dependencies.billing;
  if (!billing?.can.inAppCancel) {
    await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: "Plans can't be cancelled or kept from the app on this deployment." });
    return { status: "skipped", entityId: requestId };
  }
  const unavailable = async () => {
    await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: planChangeRefusalSentence(billing.id, "subscription_unavailable") });
    return { status: "skipped", entityId: requestId } as const;
  };
  if (!work.subscriptionId || work.source !== billing.id) return await unavailable();
  // A plan change or a promo plan's ending is changing the subscription: this waits for it.
  const hold = await claimBillingSubscription(dependencies.domain, { businessId });
  if ("retryAt" in hold) {
    await releaseBillingCheckoutRequest(dependencies.domain, { businessId, requestId });
    return { status: "deferred", entityId: requestId, retryAt: hold.retryAt };
  }
  try {
    const subscription = await billing.getSubscription(work.subscriptionId);
    if (!subscription || subscription.endedAt || !isLiveSubscriptionState(subscription.state)) return await unavailable();
    if (work.action === "cancel") await billing.cancel({ subscriptionId: subscription.id, when: "renewal", requestId });
    else if (work.action === "resume") await billing.resume({ subscriptionId: subscription.id, requestId });
    else await billing.keepPlan({ subscriptionId: subscription.id, requestId });
    await markBillingPlanChanged(dependencies.domain, { businessId, requestId });
    return { status: "completed", entityId: requestId };
  } catch (error) {
    const refusal = planChangeRefusalFor(billing, error);
    if (refusal) {
      // Asking again gets the same answer, so the business hears why instead of a retry.
      await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: planChangeRefusalSentence(billing.id, refusal) });
      if (refusal === "token_scope") await reportWarning(new Error(`${billingProviderNames[billing.id]} refused a ${work.action} of a plan: ${planChangeRefusalSentence(billing.id, refusal)}`), { operation: "job.billing.changeSubscription", businessId, requestId });
      return { status: "skipped", entityId: requestId };
    }
    await failBillingCheckoutTry(dependencies, { businessId, requestId, error: `${billingProviderNames[billing.id]} couldn't change the subscription.`, retrying });
    throw error;
  } finally {
    await handBackBillingSubscription(dependencies, { businessId, claimId: hold.claimId });
  }
}
