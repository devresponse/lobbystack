// Moving a paying business's Polar subscription to another plan, and what checkout and promo endings share with it.
import { planChangeDirection, planChangeRefusals, type PlanChangeRefusal } from "@lobbystack/shared";
import { claimBillingSubscription, loadPlanChangeProration, releaseBillingCheckoutRequest, releaseBillingSubscription, type PolarProductLinks, markBillingCheckoutFailed, markBillingPlanChanged } from "@lobbystack/domain";
import { isLiveSubscriptionState } from "@lobbystack/domain";
import { PolarRequestError } from "@lobbystack/providers/polar/polarBilling";
import { reportWarning } from "@lobbystack/telemetry/node";
import type { JobResult, WorkerDependencies } from "../handlers";

/** Polar's answer to a plan change as the refusal to tell the business, or undefined when trying again may work. */
export function planChangeRefusalFor(error: unknown): PlanChangeRefusal | undefined {
  if (!(error instanceof PolarRequestError)) return undefined;
  if (error.status === 401 || error.errorName === "insufficient_scope" || error.errorName === "invalid_token") return "token_scope";
  if (error.status === 402) return "payment_failed";
  if (error.status === 403 && error.errorName === "AlreadyCanceledSubscription") return "subscription_ending";
  if (error.status === 403 || error.status === 404) return "subscription_unavailable";
  if (error.status === 409) return "change_pending";
  if (error.status === 422) return "product_unavailable";
  return undefined;
}

/**
 * Moves a paying business's Polar subscription to the plan it asked for. A
 * downgrade is charged as billing.json's polar.downgradeProration says, and
 * any other change, an upgrade or a move between a promo plan and its tier's
 * standard plan, as upgradeProration. Null when Polar's subscription has
 * ended or isn't live, so the business needs a new checkout after all.
 */
export async function changeBillingPlan(
  dependencies: WorkerDependencies,
  input: {
    businessId: string;
    requestId: string;
    target: "starter" | "pro";
    billingInterval: "monthly" | "annual";
    subscription: { id: string; plan: "starter" | "pro"; billingInterval: "monthly" | "annual" | null; planCode: string | null };
    /** A promo plan's product and discount, which replace the target's standard product. */
    promo: { productId: string; discountId: string | null; metadata: Record<string, string> } | null;
    /** The products the catalog sells, as the checkout read them. */
    links: PolarProductLinks;
    /** The job tries again if this try fails. */
    retrying: boolean;
  },
): Promise<JobResult | null> {
  const { businessId, requestId } = input;
  const polar = dependencies.polar;
  if (!polar?.getSubscription || !polar.changeSubscriptionProduct) {
    await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: "Billing plan changes are not configured." });
    return { status: "skipped", entityId: requestId };
  }
  // A promo plan's ending or a discount's removal is changing the subscription: the request waits for it.
  const hold = await claimBillingSubscription(dependencies.domain, { businessId });
  if ("retryAt" in hold) {
    await releaseBillingCheckoutRequest(dependencies.domain, { businessId, requestId });
    return { status: "deferred", entityId: requestId, retryAt: hold.retryAt };
  }
  try {
    const { links } = input;
    const productId = input.promo?.productId ?? polarCheckoutProductId(links, input.target, input.billingInterval);
    const subscription = await polar.getSubscription(input.subscription.id);
    if (!subscription || subscription.endedAt || !isLiveSubscriptionState(subscription.status)) return null;
    // A retry after Polar made the change, or a change already waiting for the next period.
    if (subscription.productId === productId || subscription.pendingProductId === productId) {
      await markBillingPlanChanged(dependencies.domain, { businessId, requestId });
      return { status: "completed", entityId: requestId };
    }
    if (subscription.cancelAtPeriodEnd) {
      await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: planChangeRefusals.subscription_ending });
      return { status: "skipped", entityId: requestId };
    }
    // Polar's own product says what the business pays for now; the account can lag a webhook behind it.
    const current = links.planFor(subscription.productId) ?? { plan: input.subscription.plan, interval: input.subscription.billingInterval ?? input.billingInterval };
    const direction = planChangeDirection(current, { plan: input.target, interval: input.billingInterval });
    const proration = await loadPlanChangeProration(dependencies.domain);
    // A promo plan brings its discount. Leaving one for a standard plan drops its discount, which no standard product takes.
    const discount = input.promo ? { discountId: input.promo.discountId, metadata: input.promo.metadata } : input.subscription.planCode ? { discountId: null } : {};
    await polar.changeSubscriptionProduct({ subscriptionId: subscription.id, productId, prorationBehavior: direction === "downgrade" ? proration.downgrade : proration.upgrade, ...discount });
    await markBillingPlanChanged(dependencies.domain, { businessId, requestId });
    return { status: "completed", entityId: requestId };
  } catch (error) {
    const refusal = planChangeRefusalFor(error);
    if (refusal) {
      // Asking again gets the same answer, so the business hears why instead of a retry.
      await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: planChangeRefusals[refusal] });
      // These two are the operator's to fix, not the business's.
      if (refusal === "token_scope" || refusal === "product_unavailable") await reportWarning(new Error(`Polar refused a plan change: ${planChangeRefusals[refusal]}`), { operation: "job.billing.createCheckout", businessId, requestId });
      return { status: "skipped", entityId: requestId };
    }
    await failBillingCheckoutTry(dependencies, { businessId, requestId, error: "Polar plan change failed.", retrying: input.retrying });
    throw error;
  } finally {
    await handBackBillingSubscription(dependencies, { businessId, claimId: hold.claimId });
  }
}

/** Ends a run's claim on the subscription. */
export async function handBackBillingSubscription(dependencies: WorkerDependencies, input: { businessId: string; claimId: string }): Promise<void> {
  try {
    await releaseBillingSubscription(dependencies.domain, input);
  } catch {
    // The claim runs out on its own, and the run's own outcome matters more.
  }
}

/**
 * A checkout job's try failed in a way the next try may not. While the job
 * tries again, the request goes back to pending and the page keeps waiting,
 * instead of showing a failure the next try may undo; the last try fails it,
 * and the failure stands.
 */
export async function failBillingCheckoutTry(dependencies: WorkerDependencies, input: { businessId: string; requestId: string; error: string; retrying: boolean }): Promise<void> {
  const { businessId, requestId } = input;
  if (input.retrying) await releaseBillingCheckoutRequest(dependencies.domain, { businessId, requestId });
  else await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: input.error });
}

/** The Polar product that sells a plan and interval: the catalog's link, or before one the plan's variable. */
export function polarCheckoutProductId(links: PolarProductLinks, target: "starter" | "pro", billingInterval: "monthly" | "annual"): string {
  const productId = links.productFor(target, billingInterval);
  if (!productId) throw new Error(`No Polar product sells ${target} ${billingInterval}. Link the catalog with pnpm billing apply.`);
  return productId;
}
