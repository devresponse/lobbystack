// Sending usage to Polar, and the monthly unit economics.
import type { JobEnvelope } from "@lobbystack/contracts";
import { claimBillingUsageSync, confirmBillingUsageSync, loadBillingUsageEvent, recordProductEvent } from "@lobbystack/domain";
import { refreshUnitEconomicsMonth } from "@lobbystack/domain";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";
import type { JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";
import { isMeteredUsageKind, overageKindOf } from "@lobbystack/providers/billing/usage";

/** billing.syncUsage: sends a usage row's next event to Polar. */
export async function syncBillingUsage(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  if (!dependencies.billing) {
    return { status: "skipped", entityId: String(job.payload.usageEventId ?? "") };
  }
  const usageEventId = String(job.payload.usageEventId ?? "");
  if (!usageEventId) return { status: "skipped" };
  const event = await loadBillingUsageEvent(dependencies.domain, { businessId: businessIdOrThrow(job), usageEventId });
  if (!event) return { status: "skipped", entityId: usageEventId };
  if (event.syncStatus === "synced" || event.syncStatus === "succeeded") return { status: "completed", entityId: event.id };
  if (event.syncStatus === "skipped" || !event.customerId || !event.isFinal) return { status: "skipped", entityId: event.id };
  if (event.plan !== "starter" && event.plan !== "pro") return { status: "skipped", entityId: event.id };
  const usageKind = isMeteredUsageKind(event.usageKind) ? event.usageKind : undefined;
  if (!usageKind) return { status: "skipped", entityId: event.id };
  // The row's next Polar event: its billable quantity first, then each correction's difference.
  const send = await claimBillingUsageSync(dependencies.domain, { businessId: event.businessId, usageEventId: event.id });
  if (!send) return { status: "completed", entityId: event.id };
  try {
    await dependencies.billing.reportUsage({
      customer: { id: event.customerId, billingKey: event.billingKey },
      businessId: event.businessId,
      kind: overageKindOf(usageKind),
      units: send.quantity,
      // Polar prices usage itself; a provider metering money gets the row's price (Stripe plan, step 16).
      amountCents: null,
      occurredAt: event.createdAt,
      identifier: send.externalId,
    });
  } catch (error) {
    // `ops.billing.usage_sync_recovered` is intentionally not emitted here.
    // `billing_usage_events.sync_status` only models pending/skipped/synced
    // (plus a legacy "succeeded" read), and `confirmBillingUsageSync`
    // transitions only from "pending", so there is no durable failure state
    // to recover from. Emitting a recovery event would require a persisted
    // failed marker (schema/state change), which is out of scope for this
    // phase and must not be fabricated.
    await recordBillingUsageSyncFailed(dependencies, { businessId: event.businessId });
    throw error;
  }
  await confirmBillingUsageSync(dependencies.domain, { businessId: event.businessId, usageEventId: event.id, seq: send.seq });
  return { status: "completed", entityId: event.id };
}

/** billing.refreshUnitEconomics: rebuilds a business's month of unit economics. */
export async function refreshBillingUnitEconomics(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const businessId = businessIdOrThrow(job);
  const monthKey = typeof job.payload.monthKey === "string" ? job.payload.monthKey : undefined;
  const rollupId = await refreshUnitEconomicsMonth(dependencies.domain, { businessId, ...(monthKey ? { monthKey } : {}) });
  return { status: "completed", entityId: rollupId };
}

async function recordBillingUsageSyncFailed(
  dependencies: WorkerDependencies,
  input: { businessId: string },
): Promise<void> {
  try {
    await recordProductEvent(dependencies.domain, {
      name: "ops.billing.usage_sync_failed",
      businessId: input.businessId,
      distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
      actorType: "worker",
      properties: { provider: dependencies.billing?.id ?? "polar" },
    });
  } catch {
    // Billing sync telemetry is best-effort and must not mask the provider error.
  }
}
