import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { fillDefaultReceptionistBatch, receptionistProfiles, receptionistRecordTables, withBusinessTransaction, type ReceptionistRecordTable } from "@lobbystack/db";

import type { DomainContext } from "./context";

// Calls, chats and follow-ups name the receptionist that answered them
// (migration 0137). Rows from before then name none until the backfill below
// reaches them, and every reader takes none as the business's default
// receptionist: the filters and names here say so once.

/**
 * Records some receptionist answered, for a ?receptionist= filter: the ones
 * naming it, and, when it is the default receptionist, the ones naming none.
 */
export function answeredByReceptionist(column: AnyPgColumn, businessId: string, receptionistId: string): SQL {
  return sql`(${column} = ${receptionistId}::uuid or (${column} is null and exists (
    select 1 from public.receptionist_profiles default_profile
    where default_profile.business_id = ${businessId}::uuid and default_profile.id = ${receptionistId}::uuid and default_profile.is_default
  )))`;
}

/**
 * Joins a record to the receptionist that answered it, archived or not, so a
 * list shows its name; a record naming none joins the default receptionist.
 */
export function recordReceptionistJoin(businessColumn: AnyPgColumn, receptionistColumn: AnyPgColumn): SQL {
  return sql`${receptionistProfiles.businessId} = ${businessColumn} and (${receptionistProfiles.id} = ${receptionistColumn} or (${receptionistColumn} is null and ${receptionistProfiles.isDefault}))`;
}

/** Rows per transaction. Small enough that no batch holds its rows for long. */
export const RECEPTIONIST_BACKFILL_BATCH_SIZE = 5_000;
/** The pause between batches, so the backfill leaves room for the business's live writes. */
export const RECEPTIONIST_BACKFILL_PAUSE_MS = 200;
// A business's records shrink by up to a batch per table each pass; this
// bounds one job, and the next scheduled run carries on from where it stopped.
const MAX_PASSES_PER_RUN = 200;

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Writes the business's default receptionist into its calls, conversations
 * and inbox items that name none, a batch per table per transaction with a
 * short pause between, until a pass over the three changes nothing. Safe to
 * stop and run again: each batch only takes rows still empty, and skips rows
 * a live call holds. Returns how many rows of each table it filled. Runs as
 * the worker.
 */
export async function backfillReceptionistRecords(
  context: DomainContext,
  input: { businessId: string; batchSize?: number; pauseMs?: number; maxPasses?: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ filled: Record<ReceptionistRecordTable, number>; passes: number; finished: boolean }> {
  const batchSize = input.batchSize ?? RECEPTIONIST_BACKFILL_BATCH_SIZE;
  const pauseMs = input.pauseMs ?? RECEPTIONIST_BACKFILL_PAUSE_MS;
  const maxPasses = input.maxPasses ?? MAX_PASSES_PER_RUN;
  const sleep = input.sleep ?? sleepFor;
  const filled = Object.fromEntries(receptionistRecordTables.map((table) => [table, 0])) as Record<ReceptionistRecordTable, number>;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    let changed = 0;
    for (const table of receptionistRecordTables) {
      const count = await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => await fillDefaultReceptionistBatch(tx, { table, businessId: input.businessId, limit: batchSize }));
      filled[table] += count;
      changed += count;
    }
    if (changed === 0) return { filled, passes: pass, finished: true };
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return { filled, passes: maxPasses, finished: false };
}

/**
 * The receptionists that answer the business's phone calls: for each active
 * number that takes calls, its own receptionist while it may answer, else the
 * default one (app.effective_receptionist). Each only once. Runs as the
 * worker.
 */
export async function listPhoneReceptionists(context: DomainContext, input: { businessId: string }): Promise<string[]> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const result = await tx.execute<{ receptionist_id: string | null }>(sql`
      select distinct app.effective_receptionist(number.business_id, number.receptionist_id) as receptionist_id
      from public.phone_numbers as number
      where number.business_id = ${input.businessId}::uuid and number.status = 'active' and number.voice_enabled`);
    return result.rows.flatMap((row) => (row.receptionist_id ? [row.receptionist_id] : []));
  });
}
