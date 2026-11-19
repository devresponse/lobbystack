import { sql } from "drizzle-orm";

import type { Database } from "./client";

/**
 * The control panel's database role (apps/control, docs/features/control-panel.md).
 * It reads every business and account on the deployment and writes nothing.
 */
export const CONTROL_ROLE = "lobbystack_control";

/**
 * Every column lobbystack_control may read, by table, and nothing else: migration
 * 0153 grants SELECT on exactly these. `db verify-rls` compares the database with
 * this list, so a grant that widens the role fails there until it is added here
 * too, in the same pull request that explains why.
 */
export const CONTROL_READABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  businesses: ["id", "slug", "name", "legal_name", "timezone", "default_locale", "business_type", "deployment_mode", "status",
    "website_url", "onboarding_stage", "onboarding_attribution", "canceled_at", "created_at", "updated_at"],
  business_public_profiles: ["business_id", "published", "published_at", "category", "address_line1", "address_line2", "city",
    "region", "postal_code", "country_code", "public_email", "updated_at"],
  users: ["id", "name", "email", "email_verified", "phone", "phone_verified_at", "platform_role", "preferred_locale",
    "created_by_partner_id", "created_at", "updated_at"],
  accounts: ["id", "user_id", "provider_id", "created_at"],
  sessions: ["id", "user_id", "expires_at", "created_at", "updated_at"],
  business_memberships: ["id", "business_id", "user_id", "role", "status", "created_at"],
  business_invitations: ["id", "business_id", "email", "role", "status", "expires_at", "transfers_ownership", "created_at"],
  phone_numbers: ["id", "business_id", "e164", "voice_enabled", "sms_enabled", "status", "reclaim_scheduled_at",
    "voice_webhook_status", "sms_webhook_status", "receptionist_id", "created_at"],
  receptionist_profiles: ["id", "business_id", "name", "handle", "is_default", "status", "locale", "listed", "booking_mode",
    "transfer_mode", "archived_at", "created_at"],
  billing_accounts: ["business_id", "source", "customer_id", "subscription_id", "plan", "plan_code", "billing_interval",
    "subscription_state", "current_period_start", "current_period_end", "overage_spending_cap_cents", "plan_ends", "cancel_at",
    "next_plan_code", "next_interval", "next_change_at", "created_at", "updated_at"],
  billing_plans: ["code", "tier", "status", "access", "names", "sold", "custom", "overage", "voice_sec", "sms_seg", "calls_out",
    "chat_units", "numbers", "receptionists", "months", "sort"],
  billing_usage_months: ["business_id", "period_key", "plan_at_snapshot", "voice_seconds_used", "alert_sms_segments_used",
    "outbound_call_attempts_used", "chat_ai_tokens_used", "voice_blocked", "alert_sms_blocked", "outbound_call_attempts_blocked",
    "chat_ai_tokens_blocked", "overage_spend_cents", "last_recorded_at"],
  billing_transactions: ["id", "business_id", "kind", "status", "amount_cents", "refunded_amount_cents", "currency", "description",
    "occurred_at"],
  billing_packs: ["id", "business_id", "pack", "days", "provider", "amount_cents", "currency", "seconds_total", "seconds_used",
    "sms_seg", "sms_used", "calls_out", "calls_used", "chat_units", "chat_used", "paid_at", "ends_at", "status", "refunded_cents",
    "ended_at"],
  unit_economics_rollups: ["business_id", "month_key", "total_cost_usd", "provider_cost_usd", "ai_cost_usd", "infra_cost_usd",
    "voice_cost_usd", "sms_cost_usd", "alert_sms_cost_usd", "voice_call_count", "voice_minutes", "outbound_sms_count",
    "sms_thread_count", "active_user_count", "recomputed_at"],
  calls: ["id", "business_id", "transport", "provider", "status", "disposition", "session_purpose", "billing_excluded", "started_at",
    "ended_at", "provider_duration_seconds", "provider_cost_usd", "receptionist_id", "archived_at"],
  conversations: ["id", "business_id", "channel", "status", "created_at"],
  messages: ["id", "business_id", "direction", "channel", "status", "sender_role", "ai_generated", "provider_cost_usd",
    "provider_num_segments", "created_at"],
  appointments: ["id", "business_id", "status", "source_channel", "starts_at", "created_at"],
  deployment_branding: ["app_name"],
};

/** The role's session defaults (migration 0153): read-only, and short time limits. */
export const CONTROL_ROLE_SETTINGS = [
  "default_transaction_read_only=on",
  "statement_timeout=15s",
  "lock_timeout=2s",
  "idle_in_transaction_session_timeout=60s",
] as const;

/**
 * What is wrong with lobbystack_control, or nothing: run by `db verify-rls` on
 * every migrate. It must be unprivileged, read exactly CONTROL_READABLE_COLUMNS
 * with a policy on each of their tables, write nothing anywhere, reach no
 * SECURITY DEFINER function, and start its sessions with CONTROL_ROLE_SETTINGS.
 */
export async function controlRoleFailures(db: Pick<Database, "execute">): Promise<string[]> {
  const role = (await db.execute<{ privileged: boolean; settings: string[] | null }>(sql`
    select (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication) as privileged,
      (select s.setconfig from pg_db_role_setting s where s.setrole = r.oid and s.setdatabase = 0) as settings
    from pg_roles r where r.rolname = ${CONTROL_ROLE}
  `)).rows[0];
  if (!role) return [`${CONTROL_ROLE}:missing`];
  const failures: string[] = [];
  if (role.privileged) failures.push(`${CONTROL_ROLE}:privileged`);
  for (const setting of CONTROL_ROLE_SETTINGS) {
    if (!role.settings?.includes(setting)) failures.push(`${CONTROL_ROLE}:setting:${setting}`);
  }
  const readable = (await db.execute<{ table_name: string; column_name: string }>(sql`
    select c.relname as table_name, a.attname as column_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f')
      and has_column_privilege(${CONTROL_ROLE}, c.oid, a.attnum, 'SELECT')
  `)).rows;
  const expected = new Set(Object.entries(CONTROL_READABLE_COLUMNS).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`)));
  const actual = new Set(readable.map((row) => `${row.table_name}.${row.column_name}`));
  for (const column of actual) if (!expected.has(column)) failures.push(`${CONTROL_ROLE}:reads:${column}`);
  for (const column of expected) if (!actual.has(column)) failures.push(`${CONTROL_ROLE}:cannot-read:${column}`);
  const unprotected = (await db.execute<{ table_name: string }>(sql`
    select t.table_name
    from unnest(array[${sql.join(Object.keys(CONTROL_READABLE_COLUMNS).map((table) => sql`${table}`), sql`, `)}]::text[]) as t(table_name)
    where not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t.table_name and p.cmd = 'SELECT' and ${CONTROL_ROLE} = any(p.roles)
    )
  `)).rows;
  for (const row of unprotected) failures.push(`${CONTROL_ROLE}:no-policy:${row.table_name}`);
  const reach = (await db.execute<{ failure: string }>(sql`
    select 'writes:' || n.nspname || '.' || c.relname as failure
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and c.relkind in ('r', 'v', 'm', 'p', 'f')
      and (has_table_privilege(${CONTROL_ROLE}, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        or has_any_column_privilege(${CONTROL_ROLE}, c.oid, 'INSERT, UPDATE, REFERENCES'))
    union all
    select 'sequence:' || n.nspname || '.' || c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind = 'S'
      -- PostgreSQL may test the privilege before the kind, and it refuses to on anything but a sequence.
      and case when c.relkind = 'S' then has_sequence_privilege(${CONTROL_ROLE}, c.oid, 'USAGE, UPDATE') else false end
    union all
    select 'executes:' || p.oid::regprocedure::text
    from pg_proc p
    where p.prosecdef
      and has_schema_privilege(${CONTROL_ROLE}, p.pronamespace, 'USAGE')
      and has_function_privilege(${CONTROL_ROLE}, p.oid, 'EXECUTE')
    union all
    select 'schema:' || n.nspname
    from pg_namespace n
    where n.nspname in ('app', 'drizzle') and has_schema_privilege(${CONTROL_ROLE}, n.oid, 'USAGE, CREATE')
    union all
    select 'creates:database'
    where has_database_privilege(${CONTROL_ROLE}, current_database(), 'CREATE')
  `)).rows;
  for (const row of reach) failures.push(`${CONTROL_ROLE}:${row.failure}`);
  return failures;
}
