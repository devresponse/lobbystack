// Moving a paying business's subscription to another plan, and what checkout and promo endings share with it.
import { planChangeDirection, planChangeRefusals, type PlanChangeRefusal } from "@lobbystack/shared";
import { claimBillingSubscription, loadPlanChangeProration, releaseBillingCheckoutRequest, releaseBillingSubscription, type PolarProductLinks, markBillingCheckoutFailed, markBillingPlanChanged } from "@lobbystack/domain";
import { isLiveSubscriptionState } from "@lobbystack/domain";
import { reportWarning } from "@lobbystack/telemetry/node";
import type { JobResult, WorkerDependencies } from "../handlers";
import type { BillingProvider } from "@lobbystack/providers/billing/types";

/** The provider's answer to a plan change as the refusal to tell the business, or undefined when trying again may work. */
export function planChangeRefusalFor(billing: BillingProvider, error: unknown): PlanChangeRefusal | undefined {
  const refusal = billing.refusalFor(error);
  return refusal && refusal !== "retry" && refusal !== "billing_email_taken" && refusal !== "billing_email_invalid" ? refusal : undefined;
}

/** billing.json's words for a plan change, as when it happens and how it charges. */
const planChangeTimings = {
  invoice: { when: "now", proration: "invoice_now" },
  prorate: { when: "now", proration: "next_invoice" },
  next_period: { when: "renewal", proration: "none" },
  reset: { when: "now", proration: "restart" },
} as const;

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
  const billing = dependencies.billing;
  if (!billing) {
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
    const subscription = await billing.getSubscription(input.subscription.id);
    if (!subscription || subscription.endedAt || !isLiveSubscriptionState(subscription.state)) return null;
    // A retry after Polar made the change, or a change already waiting for the next period.
    if (subscription.priceRef === productId || subscription.next?.priceRef === productId) {
      await markBillingPlanChanged(dependencies.domain, { businessId, requestId });
      return { status: "completed", entityId: requestId };
    }
    if (subscription.cancelAt) {
      await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: planChangeRefusals.subscription_ending });
      return { status: "skipped", entityId: requestId };
    }
    // Polar's own product says what the business pays for now; the account can lag a webhook behind it.
    const current = links.planFor(subscription.priceRef) ?? { plan: input.subscription.plan, interval: input.subscription.billingInterval ?? input.billingInterval };
    const direction = planChangeDirection(current, { plan: input.target, interval: input.billingInterval });
    const proration = await loadPlanChangeProration(dependencies.domain);
    // A promo plan brings its discount. Leaving one for a standard plan drops its discount, which no standard product takes.
    const discount = input.promo ? "price" : input.subscription.planCode ? "remove" : "keep";
    const timing = planChangeTimings[direction === "downgrade" ? proration.downgrade : proration.upgrade];
    await billing.changePlan({ subscriptionId: subscription.id, to: { ref: productId, discountRef: input.promo?.discountId ?? null }, discount, ...timing, ...(input.promo ? { metadata: input.promo.metadata } : {}), requestId });
    await markBillingPlanChanged(dependencies.domain, { businessId, requestId });
    return { status: "completed", entityId: requestId };
  } catch (error) {
    const refusal = planChangeRefusalFor(billing, error);
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
