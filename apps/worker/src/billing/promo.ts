// A promo plan's end at its renewal, and dropping its discount.
import type { JobEnvelope } from "@lobbystack/contracts";
import { billingProviderNames, planChangeRefusalSentence } from "@lobbystack/shared";
import { claimBillingSubscription, readPolarProductLinks } from "@lobbystack/domain";
import { isLiveSubscriptionState, loadPromoEndWork, recordPromoEnd } from "@lobbystack/domain";
import { reportWarning } from "@lobbystack/telemetry/node";
import type { JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";
import { handBackBillingSubscription, planChangeRefusalFor } from "./planChange";

/** billing.endPromoPlan: ends a promo plan at its renewal, or drops its discount. */
export async function endBillingPromoPlan(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const businessId = businessIdOrThrow(job);
  const dropDiscount = typeof job.payload.dropDiscount === "string" ? job.payload.dropDiscount : undefined;
  const subscriptionId = typeof job.payload.subscriptionId === "string" ? job.payload.subscriptionId : undefined;
  if (dropDiscount && subscriptionId) return await dropPromoDiscount(dependencies, { businessId, subscriptionId, discountId: dropDiscount });
  return await endPromoPlan(dependencies, { businessId });
}

/**
 * Tells Polar how a promo plan that is due to end ends, at the renewal that
 * ends it: the subscription moves to its tier's standard product without the
 * plan's discount, or cancels. A change the business already scheduled for
 * that renewal, or a cancellation, stands. Then the owners get their email,
 * unless the business chose another promo plan for that renewal, whose own
 * terms it saw then. Polar's webhook moves the account off the plan once the
 * renewal happens.
 */
async function endPromoPlan(dependencies: WorkerDependencies, input: { businessId: string }): Promise<JobResult> {
  const { businessId } = input;
  const billing = dependencies.billing;
  if (!billing) return { status: "skipped", entityId: businessId };
  const work = await loadPromoEndWork(dependencies.domain, { businessId });
  if (!work) return { status: "skipped", entityId: businessId };
  // Nothing to tell Polar and the owners heard: a day of the last week.
  if (!work.set && !work.notify) return { status: "completed", entityId: `${businessId}:${work.planCode}:0` };
  // What the owners' email says the renewal does, once Polar's view of the subscription is known.
  let { ending, endsAt, tier, interval } = work;
  let chosePromoPlan = false;
  if (work.set) {
    // A plan change or a discount's removal is changing the subscription: this waits for it.
    const hold = await claimBillingSubscription(dependencies.domain, { businessId });
    if ("retryAt" in hold) return { status: "deferred", entityId: businessId, retryAt: hold.retryAt };
    if (work.overdue) await reportWarning(new Error("A promo plan is still in force after the renewal that should have ended it, so Polar is told again."), { operation: "job.billing.endPromoPlan", businessId, plan: work.planCode });
    try {
      const subscription = await billing.getSubscription(work.subscriptionId);
      // An ended subscription takes the plan with it, and its webhook tells the account.
      if (!subscription || subscription.endedAt || !isLiveSubscriptionState(subscription.state)) return { status: "skipped", entityId: businessId };
      const links = await readPolarProductLinks(dependencies.domain);
      const current = links.planFor(subscription.priceRef);
      // The subscription left the promo plan, as with an upgrade whose webhook the account hasn't had yet: that webhook moves the account off the plan.
      if (current?.code !== work.planCode) return { status: "skipped", entityId: businessId };
      const periodEnd = subscription.periodEnd;
      if (periodEnd && periodEnd.getTime() > Date.now()) endsAt = periodEnd;
      const pending = links.planFor(subscription.next?.priceRef ?? null);
      interval = current.interval;
      if (subscription.cancelAt) {
        ending = "cancel";
      } else if (pending) {
        // The business already chose a plan for the next period: a standard one, or another promo plan.
        ({ plan: tier, interval } = pending);
        ending = "tier";
        chosePromoPlan = pending.code !== pending.plan;
      } else if (ending === "cancel") {
        await billing.endAtRenewal({ subscriptionId: subscription.id, then: "cancel", requestId: `promo-end:${businessId}:${work.planCode}` });
      } else {
        const productId = links.productFor(tier, interval);
        if (!productId) {
          await reportWarning(new Error(`No Polar product sells ${work.tier} ${interval}, so a promo plan can't move to it. Link the catalog with pnpm billing apply.`), { operation: "job.billing.endPromoPlan", businessId, plan: work.planCode });
          return { status: "skipped", entityId: businessId };
        }
        if (subscription.priceRef !== productId) await billing.endAtRenewal({ subscriptionId: subscription.id, then: { ref: productId, discountRef: null }, requestId: `promo-end:${businessId}:${work.planCode}` });
      }
    } catch (error) {
      const refusal = planChangeRefusalFor(billing, error);
      if (!refusal) throw error;
      // The next daily run tries again; these two are the operator's to fix.
      if (refusal === "token_scope" || refusal === "product_unavailable") await reportWarning(new Error(`${billingProviderNames[billing.id]} refused to end a promo plan: ${planChangeRefusalSentence(billing.id, refusal)}`), { operation: "job.billing.endPromoPlan", businessId, plan: work.planCode });
      return { status: "skipped", entityId: businessId };
    } finally {
      await handBackBillingSubscription(dependencies, { businessId, claimId: hold.claimId });
    }
  }
  const appUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const emails = await recordPromoEnd(dependencies.domain, { businessId, planCode: work.planCode, planEnds: work.planEnds, set: work.set, notice: work.notify ? { ending, endsAt, tier, interval, quiet: chosePromoPlan } : null, appUrl });
  return { status: "completed", entityId: `${businessId}:${work.planCode}:${emails}` };
}

/**
 * Removes a promo plan's discount from a subscription on a standard product,
 * which a switch in Polar's billing portal leaves behind. Polar stops it from
 * the next billing cycle. A subscription waiting to move to a promo plan at
 * its renewal keeps it: that plan's change brought it. Polar's 409 is tried
 * again, as the outbox won't queue the same removal twice.
 */
async function dropPromoDiscount(dependencies: WorkerDependencies, input: { businessId: string; subscriptionId: string; discountId: string }): Promise<JobResult> {
  const { businessId } = input;
  const billing = dependencies.billing;
  if (!billing) return { status: "skipped", entityId: businessId };
  // A plan change or a promo plan's ending is changing the subscription: this waits for it.
  const hold = await claimBillingSubscription(dependencies.domain, { businessId });
  if ("retryAt" in hold) return { status: "deferred", entityId: businessId, retryAt: hold.retryAt };
  try {
    const subscription = await billing.getSubscription(input.subscriptionId);
    if (!subscription || subscription.endedAt || subscription.discountRef !== input.discountId) return { status: "skipped", entityId: businessId };
    const links = await readPolarProductLinks(dependencies.domain);
    const product = links.planFor(subscription.priceRef);
    const pending = links.planFor(subscription.next?.priceRef ?? null);
    // A promo product keeps its own discount, so only a standard product loses it.
    if (!product || product.code !== product.plan || (pending && pending.code !== pending.plan)) return { status: "skipped", entityId: businessId };
    await billing.removeDiscount({ subscriptionId: subscription.id, requestId: `drop-discount:${input.discountId}` });
    return { status: "completed", entityId: `${businessId}:${input.discountId}` };
  } catch (error) {
    const refusal = planChangeRefusalFor(billing, error);
    if (!refusal || refusal === "change_pending") throw error;
    if (refusal === "token_scope") await reportWarning(new Error(`${billingProviderNames[billing.id]} refused to remove a promo plan's discount: ${planChangeRefusalSentence(billing.id, refusal)}`), { operation: "job.billing.endPromoPlan", businessId });
    return { status: "skipped", entityId: businessId };
  } finally {
    await handBackBillingSubscription(dependencies, { businessId, claimId: hold.claimId });
  }
}
