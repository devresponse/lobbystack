import { sql } from "drizzle-orm";

import type { Database, DatabaseTransaction } from "./client";
import { receptionistRecordTables, type ReceptionistRecordTable } from "./receptionist-backfill";

/** What `pnpm db:verify-rls` finds in the receptionists' data after a deploy. */
export type ReceptionistDataReport = {
  /** Businesses whose shared settings differ between the business and its default receptionist. The deploy fails. */
  mismatchedSharedSettings: string[];
  /**
   * Businesses with no default receptionist yet: only one made outside sign-up,
   * such as the seed or a test, can be one. Every reader takes it as having
   * the default settings, and its first save creates the row, so this only warns.
   */
  withoutDefault: string[];
  /** Records the backfill hasn't reached yet. The clean-up deploy waits for each to be 0. */
  unfilled: Record<ReceptionistRecordTable, number>;
};

// A list shows this many ids, then the count.
const SHOWN_IDS = 20;

/**
 * Checks the receptionists' data as the migrate service's last step, until the
 * clean-up deploy: the settings every receptionist shares (the summary, the AI
 * and recording notice and the appointment change rules) must match on the
 * business and on its default receptionist, which keeps a copy for the code of
 * the release before. Runs as the migrator, which sees every business.
 */
export async function checkReceptionistData(db: Database | DatabaseTransaction): Promise<ReceptionistDataReport> {
  const mismatched = await db.execute<{ id: string }>(sql`
    select business.id from public.businesses as business
    join public.receptionist_profiles as profile on profile.business_id = business.id and profile.is_default
    where business.summary is distinct from profile.summary
      or business.summary_source is distinct from profile.summary_source
      or business.summary_fingerprint is distinct from profile.summary_fingerprint
      or business.summary_generated_at is distinct from profile.summary_generated_at
      or business.recording_notice is distinct from profile.recording_notice
      or business.appointment_change_policy is distinct from profile.appointment_change_policy
    order by business.id
  `);
  const withoutDefault = await db.execute<{ id: string }>(sql`
    select business.id from public.businesses as business
    where not exists (select 1 from public.receptionist_profiles as profile where profile.business_id = business.id and profile.is_default)
    order by business.id
  `);
  const unfilled = Object.fromEntries(receptionistRecordTables.map((table) => [table, 0])) as Record<ReceptionistRecordTable, number>;
  const counts = await db.execute<{ table_name: ReceptionistRecordTable; count: string }>(sql.join(
    receptionistRecordTables.map((table) => sql`select ${table}::text as table_name, count(*)::text as count from public.${sql.identifier(table)} where receptionist_id is null`),
    sql` union all `,
  ));
  for (const row of counts.rows) unfilled[row.table_name] = Number(row.count);
  return { mismatchedSharedSettings: mismatched.rows.map((row) => row.id), withoutDefault: withoutDefault.rows.map((row) => row.id), unfilled };
}

/** One line per finding, for the migrate service's log. */
export function describeReceptionistData(report: ReceptionistDataReport): { failures: string[]; warnings: string[]; info: string } {
  const ids = (list: string[]) => `${list.slice(0, SHOWN_IDS).join(", ")}${list.length > SHOWN_IDS ? ` and ${list.length - SHOWN_IDS} more` : ""}`;
  return {
    failures: report.mismatchedSharedSettings.length
      ? [`The shared receptionist settings differ between the business and its default receptionist for ${report.mismatchedSharedSettings.length} business(es): ${ids(report.mismatchedSharedSettings)}`]
      : [],
    warnings: report.withoutDefault.length
      ? [`${report.withoutDefault.length} business(es) have no default receptionist yet; their first settings save creates it: ${ids(report.withoutDefault)}`]
      : [],
    info: `Records naming no receptionist yet, which the worker's backfill fills: ${receptionistRecordTables.map((table) => `${table} ${report.unfilled[table]}`).join(", ")}.`,
  };
}
