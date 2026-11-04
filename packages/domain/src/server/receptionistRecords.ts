import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { receptionistProfiles, withBusinessTransaction } from "@lobbystack/db";

import type { DomainContext } from "./context";

// Calls, chats and follow-ups always name the receptionist that answered them
// (migration 0143): an insert that names none gets the business's default
// receptionist from the database. A ?receptionist= filter is plain equality
// on that column, which the (business, receptionist, time) indexes of 0138
// and 0139 serve.

/**
 * Joins a record to the receptionist that answered it, archived or not, so a
 * list shows its name.
 */
export function recordReceptionistJoin(businessColumn: AnyPgColumn, receptionistColumn: AnyPgColumn): SQL {
  return sql`${receptionistProfiles.businessId} = ${businessColumn} and ${receptionistProfiles.id} = ${receptionistColumn}`;
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
