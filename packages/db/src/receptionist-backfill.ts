import { sql } from "drizzle-orm";

import type { DatabaseTransaction } from "./client";

// Records from before migration 0137 name no receptionist. Every reader takes
// an empty receptionist_id as the business's default receptionist, so they
// show correctly meanwhile; the worker's backfill (receptionists.backfillRecords)
// writes the default into them in small batches, and the clean-up deploy then
// requires the column. New rows never need it: a trigger fills them.

/** The records that name the receptionist that answered them. */
export const receptionistRecordTables = ["calls", "conversations", "inbox_items"] as const;
export type ReceptionistRecordTable = (typeof receptionistRecordTables)[number];

/**
 * Gives up to `limit` of the business's records in `table` that name no
 * receptionist its default receptionist, and returns how many it changed.
 * Rows another transaction holds, such as a call in progress, are skipped for
 * a later batch, so nothing waits on the backfill. A business without a
 * default receptionist changes nothing. Runs in the business's transaction.
 */
export async function fillDefaultReceptionistBatch(
  tx: DatabaseTransaction,
  input: { table: ReceptionistRecordTable; businessId: string; limit: number },
): Promise<number> {
  if (!receptionistRecordTables.includes(input.table)) throw new Error(`Unknown record table: ${String(input.table)}`);
  const table = sql.identifier(input.table);
  const limit = Math.max(1, Math.trunc(input.limit));
  const result = await tx.execute(sql`
    with batch as (
      select record.id from public.${table} as record
      where record.business_id = ${input.businessId}::uuid and record.receptionist_id is null
      limit ${limit}
      for update skip locked
    )
    update public.${table} as target
    set receptionist_id = profile.id
    from batch, public.receptionist_profiles as profile
    where target.id = batch.id
      and target.business_id = ${input.businessId}::uuid
      and profile.business_id = ${input.businessId}::uuid
      and profile.is_default
  `);
  return result.rowCount ?? 0;
}
