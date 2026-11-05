import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { receptionistProfiles } from "@lobbystack/db";

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
