// The checkout job: a checkout page for a new plan, or a paying business's plan change (planChange.ts).
import type { JobEnvelope } from "@lobbystack/contracts";
import { planChangeRefusals } from "@lobbystack/shared";
import { claimBillingCheckoutRequest, loadBillingCheckoutRequest, readPolarProductLinks, type PolarProductLinks, markBillingCheckoutCreated, markBillingCheckoutFailed } from "@lobbystack/domain";
import { PolarRequestError, type PolarCustomer } from "@lobbystack/providers/polar/polarBilling";
import { reportError, reportWarning } from "@lobbystack/telemetry/node";
import type { JobExecution, JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";
import { changeBillingPlan, failBillingCheckoutTry, polarCheckoutProductId } from "./planChange";
import { OVERDUE_BILLING_WORK, overdueBillingWork } from "./reconcile";

/** billing.createCheckout: makes a checkout for a plan, or moves a paying business's subscription. */
export async function createBillingCheckout(job: JobEnvelope, dependencies: WorkerDependencies, execution: JobExecution = {}): Promise<JobResult> {
  const businessId = businessIdOrThrow(job);
  const requestId = String(job.payload.requestId ?? "");
  if (!requestId) return { status: "skipped", entityId: requestId };
  const claim = await claimBillingCheckoutRequest(dependencies.domain, { businessId, requestId });
  if (!claim.claimed) {
    // The job ran too late, so the claim failed the request: someone couldn't pay or change plan.
    if (claim.expired) {
      overdueBillingWork.add(1, { kind: "checkout_request" });
      await reportError(new Error(OVERDUE_BILLING_WORK), { operation: "job.billing.createCheckout", businessId, requestId });
    }
    // Another run holds the request: look again once its claim goes stale, in case its worker died.
    return claim.retryAt ? { status: "deferred", entityId: requestId, retryAt: claim.retryAt } : { status: "skipped", entityId: requestId };
  }
  const retrying = execution.isFinalAttempt === false;
  if (!dependencies.polar?.createCheckout) {
    await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: "Billing checkout provider is not configured." });
    return { status: "skipped", entityId: requestId };
  }
  const request = await loadBillingCheckoutRequest(dependencies.domain, { businessId, requestId });
  if (!request) return { status: "skipped", entityId: requestId };
  let links: PolarProductLinks;
  try {
    links = await readPolarProductLinks(dependencies.domain);
  } catch (error) {
    await failBillingCheckoutTry(dependencies, { businessId, requestId, error: request.subscription ? "Polar plan change failed." : "Polar checkout creation failed.", retrying });
    throw error;
  }
  // A promo plan sells through its own product and discount, while it is on sale.
  const sale = request.planCode ? links.saleFor(request.planCode, request.billingInterval) : null;
  if (request.planCode && !sale) {
    await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: "This promo plan isn't on sale right now." });
    return { status: "skipped", entityId: requestId };
  }
  // The business rides on the subscription, which the webhook checks against the customer's.
  const metadata = { lobbystack_business: businessId };
  const promo = request.planCode && sale ? { ...sale, metadata: { ...metadata, lobbystack_plan: request.planCode, lobbystack_checkout: requestId } } : null;
  // A business that already pays moves its subscription: Polar refuses a second one.
  if (request.subscription) {
    const changed = await changeBillingPlan(dependencies, { businessId, requestId, target: request.target, billingInterval: request.billingInterval, subscription: request.subscription, promo, links, retrying });
    if (changed) return changed;
  }
  try {
    const customer = await checkoutCustomer(dependencies, { businessId, requestId, externalId: request.externalCustomerId, email: request.billingEmail ?? request.customerEmail, name: request.businessName });
    const planUrl = `${(process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")}/${request.onboardingStage === "complete" ? "settings/plan" : "onboarding/plan"}`;
    const checkout = await dependencies.polar.createCheckout({
      productId: promo?.productId ?? polarCheckoutProductId(links, request.target, request.billingInterval),
      customer: customer ? { id: customer.id } : { email: request.billingEmail ?? request.customerEmail, externalId: request.externalCustomerId },
      metadata: promo?.metadata ?? metadata,
      ...(promo?.discountId ? { discountId: promo.discountId } : {}),
      successUrl: `${planUrl}?checkout=success&requestId=${encodeURIComponent(requestId)}`,
      // Polar's back arrow. Someone leaving checkout hasn't paid, so it
      // returns to the plan page without the success marker.
      returnUrl: planUrl,
    });
    await markBillingCheckoutCreated(dependencies.domain, { businessId, requestId, ...checkout });
    return { status: "completed", entityId: requestId };
  } catch (error) {
    const refusal = billingEmailRefusalFor(error);
    if (refusal) {
      // Polar answers the same email the same way, so the person is asked for another.
      await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: planChangeRefusals[refusal] });
      return { status: "skipped", entityId: requestId };
    }
    await failBillingCheckoutTry(dependencies, { businessId, requestId, error: "Polar checkout creation failed.", retrying });
    throw error;
  }
}

/**
 * The Polar customer a checkout is made out to: the business's own, found or
 * made by the account's billing key, which usage and the billing portal name
 * it by. Without one Polar picks a customer by email at payment, so the
 * second business of someone who pays for two would land on the first's
 * customer. A new customer gets the billing email the person gave, else their
 * own. Null when the worker's token can't read or make customers, and the
 * checkout then leaves the customer to Polar, as before.
 */
async function checkoutCustomer(dependencies: WorkerDependencies, input: { businessId: string; requestId: string; externalId: string; email: string; name: string | null }): Promise<PolarCustomer | null> {
  const polar = dependencies.polar;
  if (!polar?.findCustomerByExternalId || !polar.createCustomer) return null;
  try {
    const found = await polar.findCustomerByExternalId(input.externalId);
    if (found) return found;
    try {
      return await polar.createCustomer({ externalId: input.externalId, email: input.email, name: input.name });
    } catch (error) {
      // Another run made it first.
      if (error instanceof PolarRequestError && error.status === 422 && error.fields.includes("external_id")) {
        const made = await polar.findCustomerByExternalId(input.externalId);
        if (made) return made;
      }
      throw error;
    }
  } catch (error) {
    if (!(error instanceof PolarRequestError) || error.errorName !== "insufficient_scope") throw error;
    await reportWarning(new Error("The worker's Polar token can't read or make customers, so Polar picks a checkout's customer by email. Give the worker's POLAR_ACCESS_TOKEN the customers:write scope."), { operation: "job.billing.createCheckout", businessId: input.businessId, requestId: input.requestId });
    return null;
  }
}

/**
 * Polar's refusal of a new customer's email: one another customer has, as
 * Polar keeps one customer per email, or one it doesn't take as an email.
 */
function billingEmailRefusalFor(error: unknown): "billing_email_taken" | "billing_email_invalid" | undefined {
  if (!(error instanceof PolarRequestError) || error.status !== 422 || !error.fields.includes("email")) return undefined;
  // Polar's own check finds the email taken; the request's validation refuses one that isn't an email.
  return error.errorName === "PolarRequestValidationError" ? "billing_email_taken" : "billing_email_invalid";
}
