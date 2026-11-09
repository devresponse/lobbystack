// The pack checkout job: a one-time payment page for a prepaid pack, as the plan checkout job (checkout.ts) makes a plan's.
import type { JobEnvelope } from "@lobbystack/contracts";
import { billingProviderNames, planChangeRefusalSentence } from "@lobbystack/shared";
import { claimPackCheckout, loadPackCheckoutRequest, loadStripeSelling, markPackCheckoutFailed, markPackCheckoutReady, PACK_NOT_ON_SALE, releasePackCheckout } from "@lobbystack/domain";
import { reportError } from "@lobbystack/telemetry/node";
import type { JobExecution, JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";
import { OVERDUE_BILLING_WORK, overdueBillingWork } from "./reconcile";

/**
 * A try that failed in a way the next try may not: while the job tries again
 * the checkout goes back to pending and its page keeps waiting; the last try
 * fails it, and the failure stands.
 */
async function failPackCheckoutTry(dependencies: WorkerDependencies, input: { businessId: string; checkoutId: string; error: string; retrying: boolean }): Promise<void> {
  const { businessId, checkoutId } = input;
  if (input.retrying) await releasePackCheckout(dependencies.domain, { businessId, checkoutId });
  else await markPackCheckoutFailed(dependencies.domain, { businessId, checkoutId, error: input.error });
}

/**
 * billing.createPackCheckout: asks the deployment's provider for the page
 * where the business pays for a pack, on its own customer, and records it.
 * There is no promo code and no plan change: a pack is a one-time payment, and
 * billing.reconcile adds it once the payment arrives.
 */
export async function createPackCheckout(job: JobEnvelope, dependencies: WorkerDependencies, execution: JobExecution = {}): Promise<JobResult> {
  const businessId = businessIdOrThrow(job);
  const checkoutId = String(job.payload.checkoutId ?? "");
  if (!checkoutId) return { status: "skipped", entityId: checkoutId };
  const claim = await claimPackCheckout(dependencies.domain, { businessId, checkoutId });
  if (!claim.claimed) {
    // The job ran too late, so the claim expired the checkout: someone couldn't pay for a pack.
    if (claim.expired) {
      overdueBillingWork.add(1, { kind: "pack_checkout" });
      await reportError(new Error(OVERDUE_BILLING_WORK), { operation: "job.billing.createPackCheckout", businessId, checkoutId });
    }
    // Another run holds the checkout: look again once its claim goes stale, in case its worker died.
    return claim.retryAt ? { status: "deferred", entityId: checkoutId, retryAt: claim.retryAt } : { status: "skipped", entityId: checkoutId };
  }
  const retrying = execution.isFinalAttempt === false;
  const billing = dependencies.billing;
  if (!billing) {
    await markPackCheckoutFailed(dependencies.domain, { businessId, checkoutId, error: "Billing checkout provider is not configured." });
    return { status: "skipped", entityId: checkoutId };
  }
  const request = await loadPackCheckoutRequest(dependencies.domain, { businessId, checkoutId });
  if (!request) return { status: "skipped", entityId: checkoutId };
  // The price the business saw when it asked, while the provider still sells the pack at it.
  if (!request.priceRef) {
    await markPackCheckoutFailed(dependencies.domain, { businessId, checkoutId, error: PACK_NOT_ON_SALE });
    return { status: "skipped", entityId: checkoutId };
  }
  try {
    // The business's own customer, made out to its billing email, else the person's own.
    const email = request.billingEmail ?? request.customerEmail;
    const customer = await billing.findOrCreateCustomer({ customer: { id: request.customerId, billingKey: request.externalCustomerId }, businessId, email, name: request.businessName, locale: null, requestId: checkoutId });
    const planUrl = `${(process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")}/${request.onboardingStage === "complete" ? "settings/plan" : "onboarding/plan"}`;
    // On Stripe, the brand's file says whether Stripe is the merchant of record.
    const selling = billing.id === "stripe" ? await loadStripeSelling(dependencies.domain) : null;
    const checkout = await billing.createPackCheckout({
      customer: { id: customer?.id ?? null, billingKey: request.externalCustomerId },
      email,
      price: { ref: request.priceRef },
      businessId,
      checkoutId,
      // The pack and its price ride on the payment, so the payment's events find the pack without reading the checkout's lines.
      metadata: { lobbystack_business: businessId, lobbystack_pack: request.pack, lobbystack_pack_price: request.priceId },
      // Its own marker: the plan screens read checkout=success as a plan's request.
      successUrl: `${planUrl}?pack=success&packCheckoutId=${encodeURIComponent(checkoutId)}`,
      // Someone leaving checkout hasn't paid, so it returns to the plan page without the success marker.
      cancelUrl: planUrl,
      locale: null,
      ...(selling?.managedPayments ? { merchantOfRecord: true } : {}),
    });
    await markPackCheckoutReady(dependencies.domain, { businessId, checkoutId, providerCheckoutId: checkout.id, checkoutUrl: checkout.url, expiresAt: checkout.expiresAt });
    return { status: "completed", entityId: checkoutId };
  } catch (error) {
    const refusal = billing.refusalFor(error);
    if (refusal === "billing_email_taken" || refusal === "billing_email_invalid") {
      // The provider answers the same email the same way, so the person is asked for another.
      await markPackCheckoutFailed(dependencies.domain, { businessId, checkoutId, error: planChangeRefusalSentence(billing.id, refusal) });
      return { status: "skipped", entityId: checkoutId };
    }
    await failPackCheckoutTry(dependencies, { businessId, checkoutId, error: `${billingProviderNames[billing.id]} checkout creation failed.`, retrying });
    throw error;
  }
}

/**
 * billing.closePackCheckout: asks the provider to close a pack's payment page
 * that a plan's start closed (decision 6), so nobody pays for a pack that
 * would end at once. A provider with no such call (Polar), or a worker
 * without billing, leaves the page to its own expiry: a pack paid on it
 * anyway gives way to the plan, and ops.billing.pack_gave_way names the
 * payment to refund.
 */
export async function closePackCheckout(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  businessIdOrThrow(job);
  const checkoutId = String(job.payload.checkoutId ?? "");
  const providerCheckoutId = String(job.payload.providerCheckoutId ?? "");
  if (!providerCheckoutId || !dependencies.billing?.closePackCheckout) return { status: "skipped", entityId: checkoutId };
  const closed = await dependencies.billing.closePackCheckout({ checkoutId: providerCheckoutId });
  return { status: closed === "closed" ? "completed" : "skipped", entityId: checkoutId };
}
