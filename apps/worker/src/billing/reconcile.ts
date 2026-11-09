// Applying stored billing events, and the hourly sweep that queues overdue billing work again.
import type { JobEnvelope } from "@lobbystack/contracts";
import { loadBillingEventSubject, reconcileBillingProviderEvent } from "@lobbystack/domain";
import { sweepBillingWork, type BillingSweepOutcome } from "@lobbystack/domain";
import { getMeter, logEvent, reportError } from "@lobbystack/telemetry/node";
import type { JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";

export const overdueBillingWork = getMeter("lobbystack-worker").createCounter("lobbystack.billing.overdue_work", { unit: "{row}" });
/** One PostHog issue for all overdue billing work; its operation and counts say which. */
export const OVERDUE_BILLING_WORK = "Billing work waited longer than it should.";

/** A live subscription to something the catalog doesn't link, in the words of the deployment's provider. Polar's is the issue PostHog already has. */
const HELD_SUBSCRIPTION: Record<"polar" | "stripe", string> = {
  polar: "A live Polar subscription is for a product no plan maps to, so the business's plan waits. Link the product with pnpm billing apply, or move the subscription in Polar to a product the catalog sells.",
  stripe: "A live Stripe subscription is for a price no plan maps to, so the business's plan waits. Link the price with pnpm billing apply, or move the subscription in Stripe to a price the catalog sells.",
};

/**
 * billing.reconcile: applies a stored billing event to the business's
 * account. A provider that reads back (Stripe) has the event's subscription,
 * and a refund's invoice, read first, outside the account's lock.
 */
export async function reconcileBillingEvent(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const providerEventId = String(job.payload.providerEventId ?? "");
  if (!providerEventId) return { status: "skipped" };
  const businessId = businessIdOrThrow(job);
  const billing = dependencies.billing;
  const readBack: { fresh?: Awaited<ReturnType<NonNullable<typeof billing>["getSubscription"]>>; refundInvoice?: string | null } = {};
  if (billing?.can.readBack) {
    const subject = await loadBillingEventSubject(dependencies.domain, { businessId, providerEventId });
    if (subject?.provider === billing.id) {
      if (subject.subscriptionId) readBack.fresh = await billing.getSubscription(subject.subscriptionId);
      if (subject.kind === "refund" && subject.paymentRef && billing.invoiceOfPayment) readBack.refundInvoice = await billing.invoiceOfPayment(subject.paymentRef);
    }
  }
  const result = await reconcileBillingProviderEvent(dependencies.domain, { businessId, providerEventId, ...readBack });
  // The event waits, and the billing sweep runs it again each hour until someone links the product or price.
  if (result === "held") await reportError(new Error(HELD_SUBSCRIPTION[billing?.id ?? "polar"]), { operation: "job.billing.reconcile", businessId, providerEventId });
  return { status: result === "processed" ? "completed" : "skipped", entityId: providerEventId };
}

/** billing.sweep: queues billing work that waited too long again, and reports it. */
export async function sweepBilling(_job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const outcome = await sweepBillingWork(dependencies.domain);
  await recordBillingSweep(outcome, Boolean(dependencies.billing));
  // The next try sweeps again and finds the rows it couldn't queue; its last one reports the error.
  if (outcome.failed > 0) throw outcome.error;
  const queued = outcome.queued.provider_event + outcome.queued.usage_event + outcome.queued.checkout_request;
  return { status: queued + outcome.overdue.checkout_request > 0 ? "completed" : "skipped", entityId: `${queued}:${outcome.overdue.checkout_request}` };
}

/**
 * Logs what the billing sweep queued again, and reports work that waited
 * longer than it should to PostHog error tracking, once a run: a Polar event
 * that never applied is a business that paid without getting its plan, or
 * kept one it cancelled; usage never sent is usage never billed; and a
 * checkout request that never ran is someone who couldn't pay. A worker
 * without Polar's settings leaves usage unsent without failing a job, so the
 * report says whether it has them.
 */
async function recordBillingSweep(outcome: BillingSweepOutcome, polarConfigured: boolean): Promise<void> {
  const counts = {
    eventsQueued: outcome.queued.provider_event,
    usageQueued: outcome.queued.usage_event,
    checkoutsQueued: outcome.queued.checkout_request,
    eventsOverdue: outcome.overdue.provider_event,
    usageOverdue: outcome.overdue.usage_event,
    checkoutsExpired: outcome.overdue.checkout_request,
    failed: outcome.failed,
  };
  if (Object.values(counts).every((count) => count === 0)) return;
  const overdue = counts.eventsOverdue + counts.usageOverdue + counts.checkoutsExpired;
  logEvent(overdue > 0 || outcome.failed > 0 ? "warn" : "info", "ops.billing.sweep", counts);
  for (const kind of ["provider_event", "usage_event", "checkout_request"] as const) {
    if (outcome.overdue[kind] > 0) overdueBillingWork.add(outcome.overdue[kind], { kind });
  }
  if (overdue > 0) await reportError(new Error(OVERDUE_BILLING_WORK), { operation: "job.billing.sweep", polarConfigured, ...counts });
}
