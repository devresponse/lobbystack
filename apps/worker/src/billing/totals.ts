// The daily totals check of a business billed through Stripe's money meters (the Stripe plan's step 16).
import type { JobEnvelope } from "@lobbystack/contracts";
import { loadStripeSelling, loadUsageTotalsWork, recordProductEvent, recordUsageTotalsCheck, USAGE_TOTALS_QUIET_MS, type UsageTotalsKind } from "@lobbystack/domain";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";
import { logEvent } from "@lobbystack/telemetry/node";
import type { JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";

/** A gap under half a cent is rounding. */
export const USAGE_GAP_CENTS = 0.5;

const kinds: UsageTotalsKind[] = ["voice", "alert_sms", "transfer"];
const round = (cents: number) => Math.round(cents * 10_000) / 10_000;

/**
 * billing.checkUsageTotals: compares what LobbyStack confirmed sending with
 * what Stripe's meters hold, less what earlier checks credited, over the
 * business's whole usage, and corrects a gap in the open period: an event
 * Stripe never had, or one it counted twice. The open period is the month,
 * or the plan's since its renewal when overage bills on the plan
 * subscription. A correction that would take the open period below zero,
 * which Stripe bills as nothing, goes to the customer's balance for the rest. Corrections are keyed by the open month's
 * fix number, so a retried check sends each once. While an event is in
 * flight, or one went out within the hour, the check waits an hour.
 */
export async function checkBillingUsageTotals(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const businessId = businessIdOrThrow(job);
  const billing = dependencies.billing;
  if (!billing?.can.meterMoney || !billing.usageTotals || !billing.usageCredits || !billing.creditBalance) return { status: "skipped", entityId: businessId };
  const now = new Date();
  const overageOnPlan = (await loadStripeSelling(dependencies.domain)).overage === "checkout";
  const work = await loadUsageTotalsWork(dependencies.domain, { businessId, now, ...(overageOnPlan ? { overageOnPlan } : {}) });
  if ("wait" in work) return work.wait === "nothing" ? { status: "skipped", entityId: businessId } : { status: "deferred", entityId: businessId, retryAt: new Date(now.getTime() + USAGE_TOTALS_QUIET_MS) };
  const held = await billing.usageTotals({ customerId: work.customerId, from: work.since, to: now });
  const openMonth = await billing.usageTotals({ customerId: work.customerId, from: work.openSince, to: now });
  const credits = await billing.usageCredits({ customerId: work.customerId });
  let fixSeq = work.fixSeq;
  let openHeld = 0;
  for (const kind of kinds) {
    // A credit stands for usage taken back.
    const gap = round(work.confirmed[kind] - (held[kind] - credits[kind]));
    let open = openMonth[kind];
    if (Math.abs(gap) >= USAGE_GAP_CENTS) {
      const meterFix = gap < 0 && open + gap < 0 ? -Math.max(open, 0) : gap;
      const credit = round(meterFix - gap);
      if (Math.abs(meterFix) >= USAGE_GAP_CENTS) await billing.reportUsage({ customer: { id: work.customerId, billingKey: `business:${businessId}` }, businessId, kind, units: 0, amountCents: meterFix, occurredAt: now, identifier: `fix:${businessId}:${work.periodKey}:${kind}:${fixSeq}` });
      if (credit >= USAGE_GAP_CENTS) {
        if (!work.currency) throw new Error("The billing catalog has no live price, so a usage credit has no currency.");
        await billing.creditBalance({ customerId: work.customerId, kind, cents: credit, currency: work.currency, identifier: `credit:${businessId}:${work.periodKey}:${kind}:${fixSeq}` });
      }
      fixSeq += 1;
      open = round(open + meterFix);
      await reportUsageTotalsMismatch(dependencies, { businessId, provider: billing.id, kind, gapCents: gap, periodKey: work.periodKey });
    }
    openHeld = round(openHeld + open);
  }
  await recordUsageTotalsCheck(dependencies.domain, { businessId, periodKey: work.periodKey, providerOverageCents: openHeld, fixSeq, checkedAt: now });
  return { status: "completed", entityId: businessId };
}

/** ops.billing.usage_totals_mismatch: in the logs, and to PostHog where it's set up, for the operator's alert. */
async function reportUsageTotalsMismatch(dependencies: WorkerDependencies, input: { businessId: string; provider: string; kind: UsageTotalsKind; gapCents: number; periodKey: string }): Promise<void> {
  logEvent("warn", "ops.billing.usage_totals_mismatch", input);
  try {
    await recordProductEvent(dependencies.domain, {
      name: "ops.billing.usage_totals_mismatch",
      businessId: input.businessId,
      distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
      actorType: "worker",
      properties: { provider: input.provider, kind: input.kind, gapCents: input.gapCents, periodKey: input.periodKey },
    });
  } catch {
    // The correction went out either way.
  }
}
