// The overage subscription of a business paying through Stripe (the Stripe plan's step 13).
import type { JobEnvelope } from "@lobbystack/contracts";
import { isLiveSubscriptionState, loadOverageWork, recordOverageSubscription, recordProductEvent } from "@lobbystack/domain";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";
import { logEvent } from "@lobbystack/telemetry/node";
import type { JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";

/** A plan live this long without its overage subscription is reported: usage past its allowance waits meanwhile. */
export const OVERAGE_MISSING_AFTER_MS = 60 * 60_000;

/**
 * billing.ensureOverage: a live plan gets its overage subscription, made
 * once, and keeps it while the plan is set to end. Once the plan has ended,
 * the overage subscription ends with its month, which is still invoiced, so a
 * plan ending in a later month, such as a yearly one, keeps its overage until
 * then. One Stripe ended after failed payments isn't replaced while its
 * invoice is open: usage stays at the allowance, as reconcile reported.
 * Reconcile queues the job with the plan's events.
 */
export async function ensureBillingOverage(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const businessId = businessIdOrThrow(job);
  const billing = dependencies.billing;
  if (!billing?.can.separateOverage || !billing.ensureOverage || !billing.endOverage) return { status: "skipped", entityId: businessId };
  const work = await loadOverageWork(dependencies.domain, { businessId });
  if (!work?.subscriptionId || work.source !== billing.id) return { status: "skipped", entityId: businessId };
  if (!isLiveSubscriptionState(work.subscriptionState)) {
    if (!work.overageSubscriptionId) return { status: "skipped", entityId: businessId };
    await billing.endOverage({ subscriptionId: work.overageSubscriptionId, when: "period_end" });
    return { status: "completed", entityId: work.overageSubscriptionId };
  }
  try {
    if (!work.customerId || !work.currency) throw new Error("The billing account has no Stripe customer, or billing.json no live price, to make the overage subscription with.");
    const overage = await billing.ensureOverage({ customerId: work.customerId, planSubscriptionId: work.subscriptionId, businessId, currency: work.currency });
    if ("unpaidSubscriptionId" in overage) return { status: "skipped", entityId: overage.unpaidSubscriptionId };
    await recordOverageSubscription(dependencies.domain, { businessId, planSubscriptionId: work.subscriptionId, overageSubscriptionId: overage.subscriptionId });
    return { status: "completed", entityId: overage.subscriptionId };
  } catch (error) {
    if (!work.overageSubscriptionId && work.periodStart && Date.now() - work.periodStart.getTime() > OVERAGE_MISSING_AFTER_MS) {
      await reportOverageMissing(dependencies, { businessId, provider: billing.id, planSubscriptionId: work.subscriptionId });
    }
    throw error;
  }
}

/** ops.billing.overage_missing: in the logs, and to PostHog where it's set up, for the operator's alert. */
async function reportOverageMissing(dependencies: WorkerDependencies, input: { businessId: string; provider: string; planSubscriptionId: string }): Promise<void> {
  logEvent("warn", "ops.billing.overage_missing", input);
  try {
    await recordProductEvent(dependencies.domain, {
      name: "ops.billing.overage_missing",
      businessId: input.businessId,
      distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
      actorType: "worker",
      properties: { provider: input.provider, planSubscriptionId: input.planSubscriptionId },
    });
  } catch {
    // The report is best-effort and must not mask the provider's error.
  }
}
