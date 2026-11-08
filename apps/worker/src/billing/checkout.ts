// The checkout job: a checkout page for a new plan, or a paying business's plan change (planChange.ts).
import type { JobEnvelope } from "@lobbystack/contracts";
import { billingProviderNames, planChangeRefusalSentence } from "@lobbystack/shared";
import { claimBillingCheckoutRequest, loadBillingCheckoutRequest, loadStripeSelling, readPolarProductLinks, type PolarProductLinks, markBillingCheckoutCreated, markBillingCheckoutFailed } from "@lobbystack/domain";
import { reportError } from "@lobbystack/telemetry/node";
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
  const billing = dependencies.billing;
  if (!billing) {
    await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: "Billing checkout provider is not configured." });
    return { status: "skipped", entityId: requestId };
  }
  const request = await loadBillingCheckoutRequest(dependencies.domain, { businessId, requestId });
  if (!request) return { status: "skipped", entityId: requestId };
  let links: PolarProductLinks;
  try {
    links = await readPolarProductLinks(dependencies.domain);
  } catch (error) {
    await failBillingCheckoutTry(dependencies, { businessId, requestId, error: `${billingProviderNames[billing.id]} ${request.subscription ? "plan change" : "checkout creation"} failed.`, retrying });
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
    // The business's own customer, made out to its billing email, else the person's own.
    const email = request.billingEmail ?? request.customerEmail;
    // The account's own customer, when it has one: Polar finds it by the billing key, Stripe by its ID.
    const customer = await billing.findOrCreateCustomer({ customer: { id: request.customerId, billingKey: request.externalCustomerId }, businessId, email, name: request.businessName, locale: null, requestId });
    const planUrl = `${(process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")}/${request.onboardingStage === "complete" ? "settings/plan" : "onboarding/plan"}`;
    // On Stripe, the brand's file says whether overage sells on the plan's checkout, and whether Stripe is the merchant of record.
    const selling = billing.id === "stripe" ? await loadStripeSelling(dependencies.domain) : null;
    const checkout = await billing.createCheckout({
      customer: { id: customer?.id ?? null, billingKey: request.externalCustomerId },
      email,
      price: promo ? { ref: promo.productId, discountRef: promo.discountId } : { ref: polarCheckoutProductId(links, request.target, request.billingInterval), discountRef: null },
      businessId,
      requestId,
      metadata: promo?.metadata ?? metadata,
      successUrl: `${planUrl}?checkout=success&requestId=${encodeURIComponent(requestId)}`,
      // Someone leaving checkout hasn't paid, so it returns to the plan page without the success marker.
      cancelUrl: planUrl,
      locale: null,
      ...(selling?.overage === "checkout" && selling.currency ? { overageOnCheckout: { currency: selling.currency } } : {}),
      ...(selling?.managedPayments ? { merchantOfRecord: true } : {}),
    });
    await markBillingCheckoutCreated(dependencies.domain, { businessId, requestId, checkoutUrl: checkout.url, checkoutId: checkout.id });
    return { status: "completed", entityId: requestId };
  } catch (error) {
    const refusal = billing.refusalFor(error);
    if (refusal === "billing_email_taken" || refusal === "billing_email_invalid") {
      // Polar answers the same email the same way, so the person is asked for another.
      await markBillingCheckoutFailed(dependencies.domain, { businessId, requestId, error: planChangeRefusalSentence(billing.id, refusal) });
      return { status: "skipped", entityId: requestId };
    }
    await failBillingCheckoutTry(dependencies, { businessId, requestId, error: `${billingProviderNames[billing.id]} checkout creation failed.`, retrying });
    throw error;
  }
}
