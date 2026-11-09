// Ending, at the provider, a subscription a prepaid pack replaced.
//
// Decision 6, subscription to pack: when a subscriber's pack payment arrives,
// reconcile adds the pack, marks the monthly Starter or Pro subscription
// replaced (LobbyStack treats it as ended from then on) and queues this job.
// The daily pack expiry job queues it again while the account still shows
// the subscription live, so every step is safe to run again. The job:
//
// 1. waits, up to the longest call and two minutes, for calls that began on
//    the old plan to end, unless the plan would renew first;
// 2. sends the Starter and Pro usage still pending, since usage sent after the
//    end reaches the provider's meters but is never invoiced;
// 3. ends the subscription as each provider allows (BillingProvider.endForPack):
//    Stripe now, its usage invoiced and nothing credited; Polar at a period
//    end moved a few minutes ahead, whose final order bills the usage;
// 4. looks again until the provider shows it ended, for up to an hour after
//    the end; past that it tells the operator and stops.
//
// It never writes the account: the provider's own webhook does, through
// reconcile, which never reads the replaced subscription's events as a start.
import type { JobEnvelope } from "@lobbystack/contracts";
import { claimBillingSubscription, isLiveSubscriptionState, loadPlanEndForPackWork } from "@lobbystack/domain";
import type { ProviderSubscription } from "@lobbystack/providers/billing/types";
import { billingProviderNames, billingProviderOf, MAX_PHONE_CALL_MS } from "@lobbystack/shared";
import { reportError } from "@lobbystack/telemetry/node";
import type { JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";
import { handBackBillingSubscription, planChangeRefusalFor } from "./planChange";
import { sendBillingUsageEvent } from "./usage";

/** How long after the switch calls that began on the old plan get to end: the longest call, and two minutes for its usage to turn final. */
const SETTLE_MS = MAX_PHONE_CALL_MS + 2 * 60_000;
/** How far ahead Polar's moved period end goes, so the cancel and the move land before it. */
const END_DELAY_MS = 5 * 60_000;
/** How often the job looks again while it waits. */
const LOOK_AGAIN_MS = 60_000;
/** Still live this long after its end, the subscription needs the operator, and the daily pack job queues the job again. */
const STUCK_MS = 60 * 60_000;

const operation = "job.billing.endPlanForPack";

/** billing.endPlanForPack: ends at the provider a subscription a prepaid pack replaced (decision 6). */
export async function endBillingPlanForPack(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const subscriptionId = typeof job.payload.subscriptionId === "string" ? job.payload.subscriptionId : "";
  if (!subscriptionId) return { status: "skipped" };
  const since = typeof job.payload.since === "string" ? job.payload.since : null;
  return await endReplacedPlan(dependencies, { businessId: businessIdOrThrow(job), subscriptionId, since });
}

async function endReplacedPlan(dependencies: WorkerDependencies, input: { businessId: string; subscriptionId: string; since: string | null }): Promise<JobResult> {
  const { businessId, subscriptionId } = input;
  const billing = dependencies.billing;
  if (!billing) {
    // An error, not a warning: the business pays for its pack and the plan it replaced.
    const credentials = billingProviderOf(process.env) === "stripe" ? "Stripe key to end it with. Set STRIPE_API_KEY, of the account STRIPE_ACCOUNT_ID names," : "Polar token to end it with. Set POLAR_ACCESS_TOKEN and POLAR_ORGANIZATION_ID";
    await reportError(new Error(`A subscription a prepaid pack replaced still bills the business, and the worker has no ${credentials} on the worker.`), { operation, businessId });
    return { status: "skipped", entityId: businessId };
  }
  const now = new Date();
  const work = await loadPlanEndForPackWork(dependencies.domain, { businessId, subscriptionId, since: input.since, now });
  // The account no longer names the subscription as replaced.
  if (!work) return { status: "skipped", entityId: businessId };
  // Reconcile never replaces these; checkout refuses a pack beside them (decisions 6a and 6b).
  if (work.current && (work.billingInterval === "annual" || work.subscriptionState === "past_due")) {
    const kind = work.billingInterval === "annual" ? "a yearly" : "a past-due";
    await reportError(new Error(`A prepaid pack replaced ${kind} subscription, which checkout refuses, so ${billingProviderNames[billing.id]} isn't asked to end it. Settle with the business what becomes of the plan.`), { operation, businessId });
    return { status: "skipped", entityId: businessId };
  }
  const settledBy = (work.switchedAt ?? now).getTime() + SETTLE_MS;
  // A plan that renews before the wait is over would charge another period.
  const renewsFirst = work.periodEnd !== null && work.periodEnd.getTime() <= settledBy + END_DELAY_MS;
  if (work.unsettled > 0 && now.getTime() < settledBy && !renewsFirst) return { status: "deferred", entityId: businessId, retryAt: new Date(Math.min(now.getTime() + LOOK_AGAIN_MS, settledBy)) };
  // Before the claim, which lasts minutes, while each send can take seconds and retries.
  for (const usageEventId of work.pendingUsage) await sendBillingUsageEvent(dependencies, { businessId, usageEventId });
  // A plan change or a promo plan's ending is changing the subscription: this waits for it.
  const hold = await claimBillingSubscription(dependencies.domain, { businessId });
  if ("retryAt" in hold) return { status: "deferred", entityId: businessId, retryAt: hold.retryAt };
  const endsAt = new Date(Date.now() + END_DELAY_MS);
  let after: ProviderSubscription | null;
  try {
    // The account's overage subscription belongs to a newer subscription once the business subscribed again.
    after = await billing.endForPack({ subscriptionId, overageSubscriptionId: work.current ? work.overageSubscriptionId : null, endsAt, requestId: `pack-end:${subscriptionId}` });
  } catch (error) {
    const refusal = planChangeRefusalFor(billing, error);
    // Every try would be refused the same way; the operator's to fix.
    if (refusal === "token_scope") {
      const access = billing.id === "stripe" ? "STRIPE_API_KEY needs write access to subscriptions" : "POLAR_ACCESS_TOKEN needs subscriptions:write";
      await reportError(new Error(`${billingProviderNames[billing.id]} refused to end the subscription a prepaid pack replaced: the worker's ${access}.`), { operation, businessId });
      return { status: "skipped", entityId: businessId };
    }
    // Polar refuses changes to a subscription that isn't active, such as one past due.
    if (billing.id === "polar" && refusal === "subscription_unavailable") {
      await reportError(new Error("Polar refused to end the subscription a prepaid pack replaced, as it does for one that isn't active. Settle with the business what becomes of the plan."), { operation, businessId });
      return { status: "skipped", entityId: businessId };
    }
    throw error;
  } finally {
    await handBackBillingSubscription(dependencies, { businessId, claimId: hold.claimId });
  }
  // Polar bills the period's usage only once the period really ends, so a set end isn't enough.
  if (after && !after.endedAt && isLiveSubscriptionState(after.state)) {
    const end = (after.cancelAt ?? endsAt).getTime();
    if (Date.now() <= end + STUCK_MS) return { status: "deferred", entityId: businessId, retryAt: new Date(Math.max(Date.now(), end) + LOOK_AGAIN_MS) };
    // The daily pack job queues it again; looking on here too would pile up a job a day.
    await reportError(new Error(`${billingProviderNames[billing.id]} still shows the subscription a prepaid pack replaced live an hour after it should have ended.`), { operation, businessId });
    return { status: "skipped", entityId: businessId };
  }
  return { status: "completed", entityId: businessId };
}
