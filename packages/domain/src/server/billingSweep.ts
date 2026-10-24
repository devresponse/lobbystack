import { and, eq, inArray, sql } from "drizzle-orm";

import { billingCheckoutRequests, billingUsageEvents, enqueueOutbox, providerEvents, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";

import { BILLING_CHECKOUT_CLAIM_STALE_MS, expireBillingCheckoutRequest } from "./billing";
import type { DomainContext } from "./context";

// Billing work keeps its row until it is done: a Polar event stays received
// until it applies, final usage stays pending until Polar's meter has it, and a
// checkout request stays pending or processing until Polar answers. Each job
// retries on its own, but a job can run out of tries, or die with its worker,
// and nothing else would run the work again. The sweep, every few minutes,
// queues such work once more, at most once an hour for each row, and the
// worker reports work that has waited an hour. Every job it queues is safe to
// run beside another for the same row: a Polar event applies once, Polar keeps
// one event per usage row, and a checkout job claims its request.

/** A Polar event applies within seconds of its webhook. */
const EVENT_WAIT_MS = 5 * 60_000;
/** Final usage is queued for Polar at once, and a correction queues it again. */
const USAGE_WAIT_MS = 15 * 60_000;
/** How long a Polar event or usage can wait before the sweep counts it as overdue. */
export const BILLING_WORK_OVERDUE_MS = 60 * 60_000;
/** Rows of each kind one sweep takes, oldest first; the rest wait for the next run. */
const SWEEP_LIMIT = 200;

export type BillingSweepKind = "provider_event" | "usage_event" | "checkout_request";

export type BillingSweepOutcome = {
  /** Work queued again, by kind. */
  queued: Record<BillingSweepKind, number>;
  /**
   * Work that waited longer than it should, by kind: Polar events and usage
   * queued again after BILLING_WORK_OVERDUE_MS, and checkout requests failed
   * after BILLING_CHECKOUT_EXPIRES_MS.
   */
  overdue: Record<BillingSweepKind, number>;
  /** Rows the sweep couldn't queue, such as on a database error; the next run tries them again. */
  failed: number;
  /** The first of those errors. */
  error?: unknown;
};

type SweepRow = { kind: BillingSweepKind; business_id: string; entity_id: string; created_at: Date | string; updated_at: Date | string };

const sweepHour = (at: Date) => Math.floor(at.getTime() / 3_600_000);

/**
 * The outbox key that queues a row's work again. It stays the same for the
 * hour, so the row runs again at most once an hour however often it is
 * queued. app.list_billing_sweep_work leaves out a row whose key for the hour
 * exists, so keep the two in step.
 */
export function billingSweepKey(kind: BillingSweepKind, id: string, at: Date): string {
  return `billing-sweep:${kind}:${id}:${sweepHour(at)}`;
}

/**
 * Queues billing work no job finished: Polar events never applied, final
 * usage never sent to Polar, and checkout requests a job claimed and never
 * finished or never claimed. A checkout request older than
 * BILLING_CHECKOUT_EXPIRES_MS fails instead, as its job would fail it.
 */
export async function sweepBillingWork(context: DomainContext, now = new Date()): Promise<BillingSweepOutcome> {
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const rows = await withBusinessTransaction(context.db, { actorType: "worker" }, async (tx) => (await tx.execute<SweepRow>(sql`
    select kind, business_id, entity_id, created_at, updated_at
    from app.list_billing_sweep_work(${before(EVENT_WAIT_MS)}::timestamptz, ${before(USAGE_WAIT_MS)}::timestamptz, ${before(BILLING_CHECKOUT_CLAIM_STALE_MS)}::timestamptz, ${sweepHour(now)}::bigint, ${SWEEP_LIMIT})
  `)).rows, { accessMode: "read only" });
  const outcome: BillingSweepOutcome = { queued: { provider_event: 0, usage_event: 0, checkout_request: 0 }, overdue: { provider_event: 0, usage_event: 0, checkout_request: 0 }, failed: 0 };
  for (const row of rows) {
    try {
      const result = await withBusinessTransaction(context.db, { businessId: row.business_id, actorType: "worker" }, async (tx) => await requeue(tx, row, now));
      if (result === "expired") outcome.overdue.checkout_request += 1;
      if (result !== "queued") continue;
      outcome.queued[row.kind] += 1;
      // An event waits from its webhook, usage from its last change.
      const waitingSince = new Date(row.kind === "provider_event" ? row.created_at : row.updated_at);
      if (row.kind !== "checkout_request" && now.getTime() - waitingSince.getTime() > BILLING_WORK_OVERDUE_MS) outcome.overdue[row.kind] += 1;
    } catch (error) {
      outcome.failed += 1;
      outcome.error ??= error;
    }
  }
  return outcome;
}

/** Queues one row's work again in its business's scope, once it is sure the row still waits. */
async function requeue(tx: DatabaseTransaction, row: SweepRow, now: Date): Promise<"queued" | "expired" | "done"> {
  const businessId = row.business_id;
  const id = row.entity_id;
  const dedupeKey = billingSweepKey(row.kind, id, now);
  switch (row.kind) {
    case "provider_event": {
      const [event] = await tx.select({ id: providerEvents.id }).from(providerEvents).where(and(eq(providerEvents.id, id), eq(providerEvents.businessId, businessId), eq(providerEvents.status, "received"))).limit(1);
      if (!event) return "done";
      await enqueueOutbox(tx, { topic: "billing.reconcile", businessId, aggregateType: "provider_event", aggregateId: id, dedupeKey, payload: { providerEventId: id } });
      return "queued";
    }
    case "usage_event": {
      const [usage] = await tx.select({ id: billingUsageEvents.id }).from(billingUsageEvents).where(and(eq(billingUsageEvents.id, id), eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.syncStatus, "pending"), eq(billingUsageEvents.isFinal, true))).limit(1);
      if (!usage) return "done";
      await enqueueOutbox(tx, { topic: "billing.syncUsage", businessId, aggregateType: "billing_usage_event", aggregateId: id, dedupeKey, payload: { usageEventId: id } });
      return "queued";
    }
    case "checkout_request": {
      if (await expireBillingCheckoutRequest(tx, { businessId, requestId: id, now })) return "expired";
      // The job claims the request, or waits for a run that holds it.
      const [request] = await tx.select({ id: billingCheckoutRequests.id }).from(billingCheckoutRequests).where(and(eq(billingCheckoutRequests.id, id), eq(billingCheckoutRequests.businessId, businessId), inArray(billingCheckoutRequests.status, ["pending", "processing"]))).limit(1);
      if (!request) return "done";
      await enqueueOutbox(tx, { topic: "billing.createCheckout", businessId, aggregateType: "billing_checkout_request", aggregateId: id, dedupeKey, payload: { requestId: id } });
      return "queued";
    }
  }
}
