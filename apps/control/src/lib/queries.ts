import type { Queryable } from "./db";

/**
 * Every question the panel asks the database. Each reads only the columns
 * migration 0153 grants lobbystack_control (packages/db/src/control-role.ts);
 * queries.integration.test.ts runs them all as that role. Months are UTC
 * months, as the pages say.
 */

async function all<Row>(db: Queryable, text: string, values: unknown[] = []): Promise<Row[]> {
  return (await db.query(text, values)).rows as Row[];
}

async function one<Row>(db: Queryable, text: string, values: unknown[] = []): Promise<Row | null> {
  return (await all<Row>(db, text, values))[0] ?? null;
}

/** A call's length: what the phone company billed, else from start to end. */
const CALL_SECONDS = "coalesce(c.provider_duration_seconds::float8, greatest(0, extract(epoch from (c.ended_at - c.started_at)))::float8, 0)";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (value: string): boolean => MONTH.test(value);

/** The current UTC month, such as 2026-11. */
export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** The last `count` UTC months up to this one, oldest first, such as ["2025-12", ..., "2026-11"]. */
export function recentMonths(count: number, now = new Date()): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - index), 1)).toISOString().slice(0, 7));
}

/** A search box's text as an ILIKE pattern that matches it anywhere, with its own % and _ taken literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export const PAGE_SIZE = 50;

// ---------------------------------------------------------------- the deployment

export async function deploymentName(db: Queryable): Promise<string | null> {
  const row = await one<{ app_name: string | null }>(db, "select app_name from deployment_branding limit 1");
  return row?.app_name?.trim() || null;
}

export type Overview = {
  businesses: number;
  activeBusinesses: number;
  newBusinesses: number;
  accounts: number;
  newAccounts: number;
  activeAccounts: number;
  phoneNumbers: number;
  receptionists: number;
  activeSubscriptions: number;
  callsThisMonth: number;
  callsSamePeriodLastMonth: number;
  minutesThisMonth: number;
};

export async function overview(db: Queryable): Promise<Overview> {
  const row = await one<Record<string, number>>(db, `
    select
      (select count(*)::int from businesses) as businesses,
      (select count(*)::int from businesses where status = 'active') as active_businesses,
      (select count(*)::int from businesses where created_at >= now() - interval '30 days') as new_businesses,
      (select count(*)::int from users) as accounts,
      (select count(*)::int from users where created_at >= now() - interval '30 days') as new_accounts,
      (select count(distinct user_id)::int from sessions where updated_at >= now() - interval '30 days') as active_accounts,
      (select count(*)::int from phone_numbers where status = 'active') as phone_numbers,
      (select count(*)::int from receptionist_profiles where archived_at is null) as receptionists,
      (select count(*)::int from billing_accounts where subscription_state = 'active') as active_subscriptions,
      (select count(*)::int from calls c where c.started_at >= date_trunc('month', now())) as calls_this_month,
      (select count(*)::int from calls c
        where c.started_at >= date_trunc('month', now()) - interval '1 month' and c.started_at < now() - interval '1 month') as calls_same_period_last_month,
      (select coalesce(sum(${CALL_SECONDS}), 0)::float8 / 60 from calls c where c.started_at >= date_trunc('month', now())) as minutes_this_month
  `);
  const value = (key: string) => Number(row?.[key] ?? 0);
  return {
    businesses: value("businesses"),
    activeBusinesses: value("active_businesses"),
    newBusinesses: value("new_businesses"),
    accounts: value("accounts"),
    newAccounts: value("new_accounts"),
    activeAccounts: value("active_accounts"),
    phoneNumbers: value("phone_numbers"),
    receptionists: value("receptionists"),
    activeSubscriptions: value("active_subscriptions"),
    callsThisMonth: value("calls_this_month"),
    callsSamePeriodLastMonth: value("calls_same_period_last_month"),
    minutesThisMonth: value("minutes_this_month"),
  };
}

export type MonthActivity = {
  month: string;
  newBusinesses: number;
  newAccounts: number;
  calls: number;
  minutes: number;
  texts: number;
  chats: number;
  bookings: number;
};

/**
 * What happened each month, oldest first, for the last `months` months up to
 * this one: across the deployment, or for one business. Texts are SMS messages
 * either way; chats are website chat conversations started; bookings are
 * appointments made.
 */
export async function monthlyActivity(db: Queryable, { months = 12, businessId = null }: { months?: number; businessId?: string | null } = {}): Promise<MonthActivity[]> {
  const rows = await all<{ month: string; new_businesses: number; new_accounts: number; calls: number; minutes: number; texts: number; chats: number; bookings: number }>(db, `
    with since as (select date_trunc('month', now()) - make_interval(months => $1::int - 1) as at),
    months as (
      select to_char(m, 'YYYY-MM') as month
      from since, generate_series(since.at, date_trunc('month', now()), interval '1 month') as m
    ),
    b as (
      select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*)::int as n
      from businesses, since where created_at >= since.at and ($2::uuid is null or id = $2::uuid) group by 1
    ),
    u as (
      select to_char(date_trunc('month', u.created_at), 'YYYY-MM') as month, count(*)::int as n
      from users u, since where u.created_at >= since.at
        and ($2::uuid is null or exists (select 1 from business_memberships m where m.user_id = u.id and m.business_id = $2::uuid))
      group by 1
    ),
    c as (
      select to_char(date_trunc('month', c.started_at), 'YYYY-MM') as month, count(*)::int as n, (sum(${CALL_SECONDS}) / 60)::float8 as minutes
      from calls c, since where c.started_at >= since.at and ($2::uuid is null or c.business_id = $2::uuid) group by 1
    ),
    t as (
      select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*)::int as n
      from messages, since where channel = 'sms' and created_at >= since.at and ($2::uuid is null or business_id = $2::uuid) group by 1
    ),
    w as (
      select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*)::int as n
      from conversations, since where channel = 'web_chat' and created_at >= since.at and ($2::uuid is null or business_id = $2::uuid) group by 1
    ),
    a as (
      select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*)::int as n
      from appointments, since where created_at >= since.at and ($2::uuid is null or business_id = $2::uuid) group by 1
    )
    select months.month, coalesce(b.n, 0) as new_businesses, coalesce(u.n, 0) as new_accounts, coalesce(c.n, 0) as calls,
      coalesce(c.minutes, 0) as minutes, coalesce(t.n, 0) as texts, coalesce(w.n, 0) as chats, coalesce(a.n, 0) as bookings
    from months
    left join b using (month) left join u using (month) left join c using (month)
    left join t using (month) left join w using (month) left join a using (month)
    order by months.month
  `, [months, businessId]);
  return rows.map((row) => ({
    month: row.month,
    newBusinesses: row.new_businesses,
    newAccounts: row.new_accounts,
    calls: row.calls,
    minutes: Number(row.minutes),
    texts: row.texts,
    chats: row.chats,
    bookings: row.bookings,
  }));
}

export type RecentSignup = { id: string; name: string | null; email: string; created_at: Date; businesses: string | null };

export async function recentAccounts(db: Queryable, limit = 8): Promise<RecentSignup[]> {
  return await all<RecentSignup>(db, `
    select u.id, u.name, u.email, u.created_at,
      (select string_agg(b.name, ', ' order by m.created_at) from business_memberships m join businesses b on b.id = m.business_id
        where m.user_id = u.id and m.status = 'active') as businesses
    from users u order by u.created_at desc, u.id limit $1
  `, [limit]);
}

// ---------------------------------------------------------------- businesses

export type BusinessRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  deployment_mode: string;
  business_type: string;
  created_at: Date;
  plan: string | null;
  subscription_state: string | null;
  billing_source: string | null;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  members: number;
  phone_numbers: number;
  calls_this_month: number;
  minutes_this_month: number;
  last_call_at: Date | null;
  total: number;
};

/** How many businesses are in each status, most first, for the list's filter. */
export async function businessStatusCounts(db: Queryable): Promise<Array<{ status: string; businesses: number }>> {
  return await all<{ status: string; businesses: number }>(db, "select status, count(*)::int as businesses from businesses group by status order by businesses desc, status");
}

export async function businessList(db: Queryable, { search = "", status = "", page = 1 }: { search?: string; status?: string; page?: number }): Promise<BusinessRow[]> {
  const text = search.trim();
  return await all<BusinessRow>(db, `
    select b.id, b.name, b.slug, b.status, b.deployment_mode, b.business_type, b.created_at,
      coalesce(ba.plan_code, ba.plan) as plan, ba.subscription_state, ba.source as billing_source,
      owner.name as owner_name, owner.email as owner_email, owner.phone as owner_phone,
      (select count(*)::int from business_memberships m where m.business_id = b.id and m.status = 'active') as members,
      (select count(*)::int from phone_numbers p where p.business_id = b.id and p.status = 'active') as phone_numbers,
      coalesce(month.calls, 0) as calls_this_month, coalesce(month.minutes, 0) as minutes_this_month,
      (select max(c.started_at) from calls c where c.business_id = b.id) as last_call_at,
      (count(*) over ())::int as total
    from businesses b
    left join billing_accounts ba on ba.business_id = b.id
    left join lateral (
      select u.name, u.email, u.phone from business_memberships m join users u on u.id = m.user_id
      where m.business_id = b.id and m.role = 'business_owner' and m.status = 'active'
      order by m.created_at limit 1
    ) owner on true
    left join lateral (
      select count(*)::int as calls, (coalesce(sum(${CALL_SECONDS}), 0) / 60)::float8 as minutes
      from calls c where c.business_id = b.id and c.started_at >= date_trunc('month', now())
    ) month on true
    where ($1 = '' or b.name ilike $2 or b.slug ilike $2 or b.id::text = lower($1)
        or exists (
          select 1 from business_memberships m join users u on u.id = m.user_id
          where m.business_id = b.id and (u.email ilike $2 or u.name ilike $2 or u.phone ilike $2)
        ))
      and ($3 = '' or b.status = $3)
    order by b.created_at desc, b.id
    limit $4 offset $5
  `, [text, containsPattern(text), status, PAGE_SIZE, (Math.max(1, page) - 1) * PAGE_SIZE]);
}

export type BusinessDetail = {
  id: string;
  slug: string;
  name: string;
  legal_name: string | null;
  timezone: string;
  default_locale: string;
  business_type: string;
  deployment_mode: string;
  status: string;
  website_url: string | null;
  onboarding_stage: string;
  onboarding_attribution: string | null;
  canceled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  published: boolean | null;
  category: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  public_email: string | null;
  billing_source: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  plan: string | null;
  plan_name: string | null;
  billing_interval: string | null;
  subscription_state: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  overage_spending_cap_cents: number | null;
  plan_ends: Date | null;
  cancel_at: Date | null;
  next_plan_code: string | null;
  next_interval: string | null;
  next_change_at: Date | null;
};

export async function businessDetail(db: Queryable, id: string): Promise<BusinessDetail | null> {
  if (!isUuid(id)) return null;
  return await one<BusinessDetail>(db, `
    select b.id, b.slug, b.name, b.legal_name, b.timezone, b.default_locale, b.business_type, b.deployment_mode, b.status,
      b.website_url, b.onboarding_stage, b.onboarding_attribution, b.canceled_at, b.created_at, b.updated_at,
      pp.published, pp.category, pp.address_line1, pp.address_line2, pp.city, pp.region, pp.postal_code, pp.country_code, pp.public_email,
      ba.source as billing_source, ba.customer_id, ba.subscription_id, coalesce(ba.plan_code, ba.plan) as plan, bp.names ->> 'en' as plan_name,
      ba.billing_interval, ba.subscription_state, ba.current_period_start, ba.current_period_end, ba.overage_spending_cap_cents,
      ba.plan_ends, ba.cancel_at, ba.next_plan_code, ba.next_interval, ba.next_change_at
    from businesses b
    left join business_public_profiles pp on pp.business_id = b.id
    left join billing_accounts ba on ba.business_id = b.id
    left join billing_plans bp on bp.code = coalesce(ba.plan_code, ba.plan)
    where b.id = $1::uuid
  `, [id]);
}

export type MemberRow = {
  user_id: string;
  name: string | null;
  email: string;
  email_verified: boolean;
  phone: string | null;
  phone_verified_at: Date | null;
  role: string;
  status: string;
  joined_at: Date;
  last_seen_at: Date | null;
};

export async function businessMembers(db: Queryable, businessId: string): Promise<MemberRow[]> {
  return await all<MemberRow>(db, `
    select u.id as user_id, u.name, u.email, u.email_verified, u.phone, u.phone_verified_at, m.role, m.status, m.created_at as joined_at,
      (select max(s.updated_at) from sessions s where s.user_id = u.id) as last_seen_at
    from business_memberships m join users u on u.id = m.user_id
    where m.business_id = $1::uuid
    order by case m.role when 'business_owner' then 0 when 'business_admin' then 1 else 2 end, m.created_at
  `, [businessId]);
}

export type InvitationRow = { id: string; email: string; role: string; expires_at: Date; transfers_ownership: boolean; created_at: Date };

export async function pendingInvitations(db: Queryable, businessId: string): Promise<InvitationRow[]> {
  return await all<InvitationRow>(db, `
    select id, email, role, expires_at, transfers_ownership, created_at from business_invitations
    where business_id = $1::uuid and status = 'pending' and expires_at > now()
    order by created_at desc limit 20
  `, [businessId]);
}

export type PhoneNumberRow = {
  id: string;
  e164: string;
  status: string;
  voice_enabled: boolean;
  sms_enabled: boolean;
  voice_webhook_status: string | null;
  sms_webhook_status: string | null;
  reclaim_scheduled_at: Date | null;
  receptionist: string | null;
  created_at: Date;
};

export async function businessPhoneNumbers(db: Queryable, businessId: string): Promise<PhoneNumberRow[]> {
  return await all<PhoneNumberRow>(db, `
    select p.id, p.e164, p.status, p.voice_enabled, p.sms_enabled, p.voice_webhook_status, p.sms_webhook_status, p.reclaim_scheduled_at,
      r.name as receptionist, p.created_at
    from phone_numbers p left join receptionist_profiles r on r.id = p.receptionist_id
    where p.business_id = $1::uuid
    order by p.status = 'active' desc, p.created_at
  `, [businessId]);
}

export type ReceptionistRow = {
  id: string;
  name: string;
  handle: string | null;
  is_default: boolean;
  status: string;
  locale: string | null;
  listed: boolean;
  booking_mode: string;
  transfer_mode: string;
  archived_at: Date | null;
  created_at: Date;
};

export async function businessReceptionists(db: Queryable, businessId: string): Promise<ReceptionistRow[]> {
  return await all<ReceptionistRow>(db, `
    select id, name, handle, is_default, status, locale, listed, booking_mode, transfer_mode, archived_at, created_at
    from receptionist_profiles where business_id = $1::uuid
    order by archived_at is not null, is_default desc, created_at
  `, [businessId]);
}

export type UsageMonthRow = {
  period_key: string;
  plan_at_snapshot: string | null;
  voice_seconds_used: number;
  alert_sms_segments_used: number;
  outbound_call_attempts_used: number;
  chat_ai_tokens_used: number;
  blocked: string | null;
  overage_spend_cents: number;
};

/** The business's metered usage as billing counts it, newest month first. */
export async function businessUsageMonths(db: Queryable, businessId: string): Promise<UsageMonthRow[]> {
  return await all<UsageMonthRow>(db, `
    select period_key, plan_at_snapshot, voice_seconds_used, alert_sms_segments_used, outbound_call_attempts_used, chat_ai_tokens_used,
      nullif(concat_ws(', ',
        case when voice_blocked then 'calls' end,
        case when alert_sms_blocked then 'texts' end,
        case when outbound_call_attempts_blocked then 'transfers' end,
        case when chat_ai_tokens_blocked then 'chat' end), '') as blocked,
      overage_spend_cents
    from billing_usage_months where business_id = $1::uuid
    order by period_key desc limit 12
  `, [businessId]);
}

export type CostMonthRow = { month_key: string; total_cost_usd: number; voice_cost_usd: number; sms_cost_usd: number; ai_cost_usd: number; infra_cost_usd: number };

/** What serving the business cost each month, as the worker's hourly rollup counts it, newest first. */
export async function businessCosts(db: Queryable, businessId: string): Promise<CostMonthRow[]> {
  return await all<CostMonthRow>(db, `
    select month_key, total_cost_usd, voice_cost_usd, (sms_cost_usd + alert_sms_cost_usd)::float8 as sms_cost_usd, ai_cost_usd, infra_cost_usd
    from unit_economics_rollups where business_id = $1::uuid
    order by month_key desc limit 12
  `, [businessId]);
}

export type CallRow = {
  id: string;
  started_at: Date;
  transport: string;
  status: string;
  disposition: string | null;
  session_purpose: string | null;
  billing_excluded: boolean;
  seconds: number;
  provider_cost_usd: number | null;
  receptionist: string | null;
};

export async function recentCalls(db: Queryable, businessId: string, limit = 25): Promise<CallRow[]> {
  return await all<CallRow>(db, `
    select c.id, c.started_at, c.transport, c.status, c.disposition, c.session_purpose, c.billing_excluded, ${CALL_SECONDS} as seconds,
      c.provider_cost_usd, r.name as receptionist
    from calls c left join receptionist_profiles r on r.id = c.receptionist_id
    where c.business_id = $1::uuid
    order by c.started_at desc limit $2
  `, [businessId, limit]);
}

export type TransactionRow = {
  id: string;
  business_id: string;
  business_name: string;
  kind: string;
  status: string;
  amount_cents: number;
  refunded_amount_cents: number;
  currency: string;
  description: string | null;
  occurred_at: Date;
};

export async function transactions(db: Queryable, { businessId = null, limit = 50 }: { businessId?: string | null; limit?: number } = {}): Promise<TransactionRow[]> {
  return await all<TransactionRow>(db, `
    select t.id, t.business_id, b.name as business_name, t.kind, t.status, t.amount_cents, t.refunded_amount_cents, t.currency, t.description, t.occurred_at
    from billing_transactions t join businesses b on b.id = t.business_id
    where ($1::uuid is null or t.business_id = $1::uuid)
    order by t.occurred_at desc limit $2
  `, [businessId, limit]);
}

export type PackRow = {
  id: string;
  business_id: string;
  business_name: string;
  pack: string;
  provider: string;
  status: string;
  amount_cents: number;
  refunded_cents: number;
  currency: string;
  seconds_total: number;
  seconds_used: number;
  paid_at: Date;
  ends_at: Date | null;
};

export async function packs(db: Queryable, { businessId = null, limit = 20 }: { businessId?: string | null; limit?: number } = {}): Promise<PackRow[]> {
  return await all<PackRow>(db, `
    select p.id, p.business_id, b.name as business_name, p.pack, p.provider, p.status, p.amount_cents, p.refunded_cents, p.currency,
      p.seconds_total, p.seconds_used, p.paid_at, p.ends_at
    from billing_packs p join businesses b on b.id = p.business_id
    where ($1::uuid is null or p.business_id = $1::uuid)
    order by p.paid_at desc limit $2
  `, [businessId, limit]);
}

// ---------------------------------------------------------------- accounts

export type AccountRow = {
  id: string;
  name: string | null;
  email: string;
  email_verified: boolean;
  phone: string | null;
  phone_verified_at: Date | null;
  platform_role: string;
  created_at: Date;
  businesses: number;
  owns: string | null;
  last_seen_at: Date | null;
  sign_in_methods: string | null;
  total: number;
};

export async function accountList(db: Queryable, { search = "", page = 1 }: { search?: string; page?: number }): Promise<AccountRow[]> {
  const text = search.trim();
  return await all<AccountRow>(db, `
    select u.id, u.name, u.email, u.email_verified, u.phone, u.phone_verified_at, u.platform_role, u.created_at,
      (select count(*)::int from business_memberships m where m.user_id = u.id and m.status = 'active') as businesses,
      (select string_agg(b.name, ', ' order by m.created_at) from business_memberships m join businesses b on b.id = m.business_id
        where m.user_id = u.id and m.role = 'business_owner' and m.status = 'active') as owns,
      (select max(s.updated_at) from sessions s where s.user_id = u.id) as last_seen_at,
      (select string_agg(distinct a.provider_id, ', ') from accounts a where a.user_id = u.id) as sign_in_methods,
      (count(*) over ())::int as total
    from users u
    where ($1 = '' or u.email ilike $2 or u.name ilike $2 or u.phone ilike $2 or u.id::text = lower($1))
    order by u.created_at desc, u.id
    limit $3 offset $4
  `, [text, containsPattern(text), PAGE_SIZE, (Math.max(1, page) - 1) * PAGE_SIZE]);
}

export type AccountDetail = {
  id: string;
  name: string | null;
  email: string;
  email_verified: boolean;
  phone: string | null;
  phone_verified_at: Date | null;
  platform_role: string;
  preferred_locale: string;
  created_by_partner_id: string | null;
  created_at: Date;
  updated_at: Date;
  open_sessions: number;
  first_sign_in: Date | null;
  last_sign_in: Date | null;
  last_seen_at: Date | null;
  sign_in_methods: string | null;
};

export async function accountDetail(db: Queryable, id: string): Promise<AccountDetail | null> {
  if (!isUuid(id)) return null;
  return await one<AccountDetail>(db, `
    select u.id, u.name, u.email, u.email_verified, u.phone, u.phone_verified_at, u.platform_role, u.preferred_locale,
      u.created_by_partner_id, u.created_at, u.updated_at,
      s.open_sessions, s.first_sign_in, s.last_sign_in, s.last_seen_at,
      (select string_agg(a.provider_id, ', ' order by a.created_at) from accounts a where a.user_id = u.id) as sign_in_methods
    from users u
    cross join lateral (
      select count(*) filter (where expires_at > now())::int as open_sessions, min(created_at) as first_sign_in,
        max(created_at) as last_sign_in, max(updated_at) as last_seen_at
      from sessions where user_id = u.id
    ) s
    where u.id = $1::uuid
  `, [id]);
}

export type MembershipRow = {
  business_id: string;
  name: string;
  status: string;
  role: string;
  membership_status: string;
  joined_at: Date;
  plan: string | null;
  subscription_state: string | null;
};

export async function accountMemberships(db: Queryable, userId: string): Promise<MembershipRow[]> {
  return await all<MembershipRow>(db, `
    select b.id as business_id, b.name, b.status, m.role, m.status as membership_status, m.created_at as joined_at,
      coalesce(ba.plan_code, ba.plan) as plan, ba.subscription_state
    from business_memberships m
    join businesses b on b.id = m.business_id
    left join billing_accounts ba on ba.business_id = b.id
    where m.user_id = $1::uuid
    order by m.created_at
  `, [userId]);
}

// ---------------------------------------------------------------- usage

export type BusinessUsageRow = {
  id: string;
  name: string;
  status: string;
  calls: number;
  minutes: number;
  texts: number;
  chats: number;
  bookings: number;
  voice_seconds_used: number | null;
  alert_sms_segments_used: number | null;
  outbound_call_attempts_used: number | null;
  chat_ai_tokens_used: number | null;
  overage_spend_cents: number | null;
  blocked: boolean;
};

/** Each business's activity in one UTC month, busiest first: what happened, and what billing counted. */
export async function usageByBusiness(db: Queryable, month: string, limit = 100): Promise<BusinessUsageRow[]> {
  if (!isMonth(month)) return [];
  return await all<BusinessUsageRow>(db, `
    with bounds as (select ($1 || '-01T00:00:00Z')::timestamptz as start, ($1 || '-01T00:00:00Z')::timestamptz + interval '1 month' as stop),
    c as (
      select c.business_id, count(*)::int as calls, (sum(${CALL_SECONDS}) / 60)::float8 as minutes
      from calls c, bounds where c.started_at >= bounds.start and c.started_at < bounds.stop group by 1
    ),
    t as (select business_id, count(*)::int as n from messages, bounds where channel = 'sms' and created_at >= bounds.start and created_at < bounds.stop group by 1),
    w as (select business_id, count(*)::int as n from conversations, bounds where channel = 'web_chat' and created_at >= bounds.start and created_at < bounds.stop group by 1),
    a as (select business_id, count(*)::int as n from appointments, bounds where created_at >= bounds.start and created_at < bounds.stop group by 1),
    um as (
      select business_id, voice_seconds_used, alert_sms_segments_used, outbound_call_attempts_used, chat_ai_tokens_used, overage_spend_cents,
        (voice_blocked or alert_sms_blocked or outbound_call_attempts_blocked or chat_ai_tokens_blocked) as blocked
      from billing_usage_months where period_key = $1
    )
    select b.id, b.name, b.status, coalesce(c.calls, 0) as calls, coalesce(c.minutes, 0) as minutes, coalesce(t.n, 0) as texts,
      coalesce(w.n, 0) as chats, coalesce(a.n, 0) as bookings, um.voice_seconds_used, um.alert_sms_segments_used,
      um.outbound_call_attempts_used, um.chat_ai_tokens_used, um.overage_spend_cents, coalesce(um.blocked, false) as blocked
    from businesses b
    left join c on c.business_id = b.id
    left join t on t.business_id = b.id
    left join w on w.business_id = b.id
    left join a on a.business_id = b.id
    left join um on um.business_id = b.id
    where c.business_id is not null or t.business_id is not null or w.business_id is not null or a.business_id is not null or um.business_id is not null
    order by minutes desc, calls desc, coalesce(t.n, 0) + coalesce(w.n, 0) desc, b.name
    limit $2
  `, [month, limit]);
}

// ---------------------------------------------------------------- billing

export type PlanCountRow = { plan: string | null; subscription_state: string | null; source: string; billing_interval: string | null; businesses: number };

/** How many businesses are on each plan, in each state, through each provider. A business with no billing account is left out. */
export async function planCounts(db: Queryable): Promise<PlanCountRow[]> {
  return await all<PlanCountRow>(db, `
    select coalesce(plan_code, plan) as plan, subscription_state, source, billing_interval, count(*)::int as businesses
    from billing_accounts group by 1, 2, 3, 4
    order by businesses desc, plan nulls last
  `);
}

export async function businessesWithoutBilling(db: Queryable): Promise<number> {
  const row = await one<{ n: number }>(db, "select count(*)::int as n from businesses b where not exists (select 1 from billing_accounts ba where ba.business_id = b.id)");
  return row?.n ?? 0;
}

export type RevenueMonthRow = { month: string; currency: string; payments: number; gross_cents: number; refunded_cents: number };

/** Payments taken each month, by currency, newest first: orders paid, less what was refunded. */
export async function revenueByMonth(db: Queryable, months = 12): Promise<RevenueMonthRow[]> {
  return await all<RevenueMonthRow>(db, `
    select to_char(date_trunc('month', occurred_at), 'YYYY-MM') as month, upper(currency) as currency, count(*)::int as payments,
      coalesce(sum(amount_cents), 0)::float8 as gross_cents, coalesce(sum(refunded_amount_cents), 0)::float8 as refunded_cents
    from billing_transactions
    where status in ('paid', 'partially_refunded', 'refunded')
      and occurred_at >= date_trunc('month', now()) - make_interval(months => $1::int - 1)
    group by 1, 2 order by 1 desc, 2
  `, [months]);
}

export type CostByMonthRow = { month: string; total_cost_usd: number; voice_cost_usd: number; sms_cost_usd: number; ai_cost_usd: number; infra_cost_usd: number; overage_cents: number; blocked_businesses: number };

/** What the deployment's businesses cost to serve each month, and what billing counted past their plans, newest first. */
export async function costByMonth(db: Queryable, months = 12): Promise<CostByMonthRow[]> {
  return await all<CostByMonthRow>(db, `
    with since as (select to_char(date_trunc('month', now()) - make_interval(months => $1::int - 1), 'YYYY-MM') as month),
    costs as (
      select month_key as month, sum(total_cost_usd)::float8 as total_cost_usd, sum(voice_cost_usd)::float8 as voice_cost_usd,
        sum(sms_cost_usd + alert_sms_cost_usd)::float8 as sms_cost_usd, sum(ai_cost_usd)::float8 as ai_cost_usd, sum(infra_cost_usd)::float8 as infra_cost_usd
      from unit_economics_rollups, since where month_key >= since.month group by 1
    ),
    usage as (
      select period_key as month, sum(overage_spend_cents)::float8 as overage_cents,
        count(*) filter (where voice_blocked or alert_sms_blocked or outbound_call_attempts_blocked or chat_ai_tokens_blocked)::int as blocked_businesses
      from billing_usage_months, since where period_key >= since.month group by 1
    )
    select coalesce(costs.month, usage.month) as month, coalesce(total_cost_usd, 0) as total_cost_usd, coalesce(voice_cost_usd, 0) as voice_cost_usd,
      coalesce(sms_cost_usd, 0) as sms_cost_usd, coalesce(ai_cost_usd, 0) as ai_cost_usd, coalesce(infra_cost_usd, 0) as infra_cost_usd,
      coalesce(overage_cents, 0) as overage_cents, coalesce(blocked_businesses, 0) as blocked_businesses
    from costs full outer join usage on usage.month = costs.month
    order by 1 desc
  `, [months]);
}

export type EndingRow = { business_id: string; name: string; plan: string | null; subscription_state: string | null; ends_at: Date; why: string };

/** Subscriptions and plans that end in the next 30 days, soonest first. */
export async function endingSoon(db: Queryable): Promise<EndingRow[]> {
  return await all<EndingRow>(db, `
    select b.id as business_id, b.name, coalesce(ba.plan_code, ba.plan) as plan, ba.subscription_state,
      least(ba.cancel_at, ba.plan_ends) as ends_at,
      case when ba.cancel_at is not null and (ba.plan_ends is null or ba.cancel_at <= ba.plan_ends) then 'canceled' else 'plan ends' end as why
    from billing_accounts ba join businesses b on b.id = ba.business_id
    where least(ba.cancel_at, ba.plan_ends) between now() and now() + interval '30 days'
    order by ends_at
  `);
}

// ---------------------------------------------------------------- system health

export type DatabaseRoleConnections = { role: string; connections: number };

export type DatabaseHealth = {
  sizeBytes: number;
  /** Every client connection to the server, from every service, the panel's own included. */
  connections: number;
  maxConnections: number;
  /** Kept for superusers: the services can open maxConnections minus these. */
  reservedConnections: number;
  byRole: DatabaseRoleConnections[];
  /** When PostgreSQL last started, which a restart moves. */
  startedAt: Date | null;
  version: string;
  /** Since the counters were last reset, or since PostgreSQL started. */
  commits: number;
  rollbacks: number;
  blocksHit: number;
  blocksRead: number;
  deadlocks: number;
  tempBytes: number;
  countedSince: Date | null;
};

/**
 * PostgreSQL's own numbers for this database. They come from views every role
 * may read, not from the app's tables: other roles' sessions show only whose
 * they are, so connections are counted by role and nothing about what they run.
 */
export async function databaseHealth(db: Queryable): Promise<DatabaseHealth> {
  const [row, byRole] = await Promise.all([
    one<Record<string, unknown>>(db, `
      select pg_database_size(current_database())::float8 as size_bytes,
        (select count(*)::int from pg_stat_activity where usename is not null) as connections,
        current_setting('max_connections')::int as max_connections,
        current_setting('superuser_reserved_connections')::int as reserved_connections,
        pg_postmaster_start_time() as started_at,
        current_setting('server_version') as version,
        d.xact_commit::float8 as commits, d.xact_rollback::float8 as rollbacks,
        d.blks_hit::float8 as blocks_hit, d.blks_read::float8 as blocks_read,
        d.deadlocks::float8 as deadlocks, d.temp_bytes::float8 as temp_bytes,
        coalesce(d.stats_reset, pg_postmaster_start_time()) as counted_since
      from pg_stat_database d
      where d.datname = current_database()
    `),
    all<DatabaseRoleConnections>(db, `
      select usename::text as role, count(*)::int as connections
      from pg_stat_activity
      where usename is not null
      group by usename
      order by count(*) desc, usename
    `),
  ]);
  const value = (key: string) => Number(row?.[key] ?? 0);
  const when = (key: string) => {
    const value = row?.[key];
    return value instanceof Date ? value : null;
  };
  return {
    sizeBytes: value("size_bytes"),
    connections: value("connections"),
    maxConnections: value("max_connections"),
    reservedConnections: value("reserved_connections"),
    byRole,
    startedAt: when("started_at"),
    version: typeof row?.version === "string" ? row.version : "",
    commits: value("commits"),
    rollbacks: value("rollbacks"),
    blocksHit: value("blocks_hit"),
    blocksRead: value("blocks_read"),
    deadlocks: value("deadlocks"),
    tempBytes: value("temp_bytes"),
    countedSince: when("counted_since"),
  };
}

/** How long an open call or an unsent text waits before the health page calls it stuck. */
export const STUCK_CALL_MINUTES = 120;
export const STUCK_TEXT_MINUTES = 15;

export type RecentActivity = {
  /** Calls started in the last 24 hours, and how many of them failed. */
  calls: number;
  failedCalls: number;
  /** Calls still open: started in the last two hours, and started earlier (in the last 7 days) and never closed. */
  openCalls: number;
  stuckCalls: number;
  /** Texts the receptionist or a team member sent in the last 24 hours, and how many failed or weren't delivered. */
  texts: number;
  failedTexts: number;
  /** Texts still waiting to go out after 15 minutes (in the last 7 days). */
  stuckTexts: number;
  /** Website chats started in the last 24 hours. */
  chats: number;
};

/** What the services did lately, and what didn't go through: calls, texts and website chats. */
export async function recentActivity(db: Queryable): Promise<RecentActivity> {
  const row = await one<Record<string, number>>(db, `
    select
      (select count(*)::int from calls where started_at >= now() - interval '24 hours') as calls,
      (select count(*)::int from calls where started_at >= now() - interval '24 hours' and status = 'failed') as failed_calls,
      (select count(*)::int from calls
        where status = 'started' and ended_at is null and started_at >= now() - make_interval(mins => $1)) as open_calls,
      (select count(*)::int from calls
        where status = 'started' and ended_at is null and started_at < now() - make_interval(mins => $1)
          and started_at >= now() - interval '7 days') as stuck_calls,
      (select count(*)::int from messages
        where direction = 'outbound' and channel = 'sms' and created_at >= now() - interval '24 hours') as texts,
      (select count(*)::int from messages
        where direction = 'outbound' and channel = 'sms' and created_at >= now() - interval '24 hours' and status in ('failed', 'undelivered')) as failed_texts,
      (select count(*)::int from messages
        where direction = 'outbound' and channel = 'sms' and status in ('queued', 'sending')
          and created_at < now() - make_interval(mins => $2) and created_at >= now() - interval '7 days') as stuck_texts,
      (select count(*)::int from conversations where channel = 'web_chat' and created_at >= now() - interval '24 hours') as chats
  `, [STUCK_CALL_MINUTES, STUCK_TEXT_MINUTES]);
  const value = (key: string) => Number(row?.[key] ?? 0);
  return {
    calls: value("calls"),
    failedCalls: value("failed_calls"),
    openCalls: value("open_calls"),
    stuckCalls: value("stuck_calls"),
    texts: value("texts"),
    failedTexts: value("failed_texts"),
    stuckTexts: value("stuck_texts"),
    chats: value("chats"),
  };
}
