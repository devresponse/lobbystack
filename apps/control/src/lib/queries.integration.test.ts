import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkRole, CONTROL_ROLE, controlDatabaseUrl, type Queryable } from "./db";
import * as queries from "./queries";

// Explicit opt-in only, as the other integration suites: a local database whose name says test.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("The control panel's integration tests need a dedicated local test database.");
  }
}
// Set when db bootstrap gave lobbystack_control a login, as CI's database job does.
const controlPassword = process.env.LOBBYSTACK_CONTROL_PASSWORD;

type Fixture = Awaited<ReturnType<typeof seed>>;

/** Two businesses with a little of everything the panel shows, written as the superuser. */
async function seed(db: pg.Client) {
  const id = () => randomUUID();
  const tag = id().slice(0, 8);
  const phone = () => `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
  const [alder, birch, owner, member, plumber, chat] = [id(), id(), id(), id(), id(), id()];
  const run = (text: string, values: unknown[]) => db.query(text, values);
  await run("insert into businesses (id, slug, name, timezone, business_type) values ($1, $2, $3, 'UTC', 'dental'), ($4, $5, $6, 'UTC', 'plumbing')",
    [alder, `alder-${tag}`, `Alder Dental ${tag}`, birch, `birch-${tag}`, `Birch Plumbing ${tag}`]);
  await run(`insert into users (id, email, normalized_email, name, phone, phone_verified_at, password_hash) values
    ($1, $2, $2, 'Ada Owner', $3, now(), 'never-shown'), ($4, $5, $5, 'Mo Member', null, null, null), ($6, $7, $7, 'Pat Plumber', $8, null, null)`,
    [owner, `owner-${tag}@example.com`, phone(), member, `member-${tag}@example.com`, plumber, `plumber-${tag}@example.com`, phone()]);
  await run("insert into accounts (user_id, provider_id, account_id, password) values ($1, 'credential', $2, 'never-shown')", [owner, owner]);
  await run(`insert into sessions (token, user_id, expires_at, ip_address, user_agent) values
    ($1, $2, now() + interval '30 days', '203.0.113.9', 'never-shown'), ($3, $2, now() - interval '1 day', null, null)`, [`token-${id()}`, owner, `token-${id()}`]);
  await run(`insert into business_memberships (business_id, user_id, role) values ($1, $2, 'business_owner'), ($1, $3, 'viewer'), ($4, $5, 'business_owner')`,
    [alder, owner, member, birch, plumber]);
  await run(`insert into business_invitations (business_id, invited_by_user_id, email, normalized_email, role, token_hash, expires_at)
    values ($1, $2, $3, $3, 'viewer', $4, now() + interval '7 days')`, [alder, owner, `invited-${tag}@example.com`, `hash-${id()}`]);
  await run("insert into business_public_profiles (business_id, published, city, country_code, public_email) values ($1, true, 'Springfield', 'US', $2)",
    [alder, `front-${tag}@example.com`]);
  // Each business gets its default receptionist from a trigger; calls, chats and numbers fill it in themselves.
  await run("update receptionist_profiles set name = 'Front desk' where business_id in ($1, $2) and is_default", [alder, birch]);
  await run("insert into phone_numbers (business_id, e164, voice_enabled, sms_enabled) values ($1, $2, true, true)", [alder, phone()]);
  const plan = `control-test-${tag}`;
  await run(`insert into billing_plans (code, tier, status, names, voice_sec, sms_seg, calls_out, chat_units, kb_bytes, numbers, terms_hash)
    values ($1, 'pro', 'active', $2, 6000, 100, 50, 1000, 1000000, 1, $3)`,
    [plan, JSON.stringify({ en: "Control test", fr: "Control test", es: "Control test", sr: "Control test" }), "a".repeat(64)]);
  await run(`insert into billing_accounts (business_id, billing_key, source, plan, plan_code, billing_interval, subscription_state, cancel_at)
    values ($1, $2, 'stripe', 'pro', $3, 'monthly', 'active', now() + interval '10 days')`, [alder, `business:${alder}`, plan]);
  await run(`insert into billing_usage_months (business_id, period_key, voice_seconds_used, voice_blocked, overage_spend_cents)
    values ($1, to_char(now(), 'YYYY-MM'), 600, true, 250)`, [alder]);
  await run(`insert into billing_transactions (business_id, kind, source_id, status, amount_cents, refunded_amount_cents, currency, occurred_at)
    values ($1, 'order', $2, 'partially_refunded', 4900, 900, 'usd', now())`, [alder, `order-${id()}`]);
  // A prepaid pack needs a pack plan from billing.json, so the packs query runs here with none of the fixture's.
  await run(`insert into unit_economics_rollups (business_id, month_key, total_cost_usd, voice_cost_usd, sms_cost_usd, alert_sms_cost_usd, ai_cost_usd, infra_cost_usd)
    values ($1, to_char(now(), 'YYYY-MM'), 3.5, 2, 0.25, 0.25, 0.5, 0.5)`, [alder]);
  await run(`insert into calls (business_id, provider_call_id, transport, status, started_at, ended_at, provider_duration_seconds) values
    ($1, $2, 'pstn', 'completed', now(), now() + interval '2 minutes', 120),
    ($1, $3, 'web_voice', 'completed', now(), now() + interval '2 minutes', null),
    ($4, $5, 'pstn', 'completed', now(), now() + interval '1 minute', 60)`,
    [alder, `CA${id()}`, `web-${id()}`, birch, `CA${id()}`]);
  await run("insert into conversations (id, business_id, channel) values ($1, $2, 'web_chat')", [chat, alder]);
  await run("insert into messages (business_id, conversation_id, direction, channel, body) values ($1, $2, 'outbound', 'sms', 'never shown')", [alder, chat]);
  return { tag, plan, alder, birch, owner, member, plumber };
}

describe.skipIf(!testUrl)("the panel's questions, asked as lobbystack_control", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: testUrl, options: "-c TimeZone=UTC" });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  /** Seeds, becomes the panel's role, runs the check, and leaves nothing behind. */
  async function asControl(check: (db: Queryable, fixture: Fixture) => Promise<void>) {
    await client.query("begin");
    try {
      const fixture = await seed(client);
      await client.query(`set local role ${CONTROL_ROLE}`);
      await check(client, fixture);
    } finally {
      await client.query("rollback");
    }
  }

  /** The SQLSTATE a statement fails with, undone so the transaction carries on. */
  async function refusal(sql: string, values: unknown[] = []): Promise<string | undefined> {
    await client.query("savepoint refusal");
    try {
      await client.query(sql, values);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      await client.query("rollback to savepoint refusal");
    }
  }

  it("sees every business, across tenants, on the overview, usage and billing pages", async () => {
    await asControl(async (db, { alder, birch, tag, plan }) => {
      const month = queries.currentMonth();
      const totals = await queries.overview(db);
      expect(totals.businesses).toBeGreaterThanOrEqual(2);
      expect(totals.callsThisMonth).toBeGreaterThanOrEqual(3);
      expect(await queries.monthlyActivity(db)).toHaveLength(12);
      expect((await queries.monthlyActivity(db, { businessId: alder })).at(-1)).toEqual({ month, newBusinesses: 1, newAccounts: 2, calls: 2, minutes: 4, texts: 1, chats: 1, bookings: 0 });
      expect(await queries.recentAccounts(db, 100)).toEqual(expect.arrayContaining([expect.objectContaining({ email: `owner-${tag}@example.com`, businesses: `Alder Dental ${tag}` })]));

      const usage = await queries.usageByBusiness(db, month, 10_000);
      expect(usage.find((row) => row.id === alder)).toMatchObject({ calls: 2, minutes: 4, texts: 1, chats: 1, voice_seconds_used: 600, overage_spend_cents: 250, blocked: true });
      expect(usage.find((row) => row.id === birch)).toMatchObject({ calls: 1, minutes: 1, voice_seconds_used: null, blocked: false });
      expect(await queries.usageByBusiness(db, "2026-13")).toEqual([]);

      expect(await queries.planCounts(db)).toEqual(expect.arrayContaining([expect.objectContaining({ plan, source: "stripe", subscription_state: "active", businesses: 1 })]));
      expect(await queries.businessesWithoutBilling(db)).toBeGreaterThanOrEqual(1);
      expect((await queries.revenueByMonth(db)).find((row) => row.month === month && row.currency === "USD")?.gross_cents).toBeGreaterThanOrEqual(4900);
      expect((await queries.costByMonth(db)).find((row) => row.month === month)).toMatchObject({ total_cost_usd: expect.any(Number) as number, blocked_businesses: expect.any(Number) as number });
      expect(await queries.endingSoon(db)).toEqual(expect.arrayContaining([expect.objectContaining({ business_id: alder, why: "canceled", plan })]));
      expect(await queries.transactions(db)).toEqual(expect.arrayContaining([expect.objectContaining({ business_id: alder, amount_cents: 4900, refunded_amount_cents: 900 })]));
      expect(Array.isArray(await queries.packs(db))).toBe(true);
      await queries.deploymentName(db);
    });
  });

  it("finds businesses and shows one in full", async () => {
    await asControl(async (db, { alder, birch, owner, tag, plan }) => {
      const [found, ...more] = await queries.businessList(db, { search: `alder-${tag}` });
      expect(more).toEqual([]);
      expect(found).toMatchObject({ id: alder, owner_email: `owner-${tag}@example.com`, members: 2, phone_numbers: 1, calls_this_month: 2, minutes_this_month: 4, plan, total: 1 });
      expect((await queries.businessList(db, { search: `PLUMBER-${tag}@example.com` })).map((row) => row.id)).toEqual([birch]);
      expect((await queries.businessList(db, { search: alder })).map((row) => row.id)).toEqual([alder]);
      expect((await queries.businessList(db, { search: `${tag}%` })).map((row) => row.id)).toEqual([]);
      expect((await queries.businessList(db, { search: tag, status: "canceled" }))).toEqual([]);
      expect(await queries.businessStatusCounts(db)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "active" })]));

      expect(await queries.businessDetail(db, alder)).toMatchObject({ name: `Alder Dental ${tag}`, city: "Springfield", public_email: `front-${tag}@example.com`, billing_source: "stripe", plan, plan_name: "Control test" });
      expect(await queries.businessDetail(db, "not-an-id")).toBeNull();
      expect(await queries.businessDetail(db, randomUUID())).toBeNull();
      const members = await queries.businessMembers(db, alder);
      expect(members.map((row) => [row.user_id, row.role])).toEqual([[owner, "business_owner"], [expect.any(String), "viewer"]]);
      expect(members[0]?.last_seen_at).toBeInstanceOf(Date);
      expect(await queries.pendingInvitations(db, alder)).toEqual([expect.objectContaining({ email: `invited-${tag}@example.com`, role: "viewer" })]);
      expect(await queries.businessPhoneNumbers(db, alder)).toEqual([expect.objectContaining({ receptionist: "Front desk", voice_enabled: true })]);
      expect(await queries.businessReceptionists(db, alder)).toHaveLength(1);
      expect(await queries.businessUsageMonths(db, alder)).toEqual([expect.objectContaining({ voice_seconds_used: 600, blocked: "calls" })]);
      expect(await queries.businessCosts(db, alder)).toEqual([expect.objectContaining({ total_cost_usd: 3.5, sms_cost_usd: 0.5 })]);
      const calls = await queries.recentCalls(db, alder);
      expect(calls.map((call) => call.seconds).sort()).toEqual([120, 120]);
      expect(await queries.transactions(db, { businessId: birch })).toEqual([]);
      expect(await queries.packs(db, { businessId: alder })).toEqual([]);
    });
  });

  it("finds accounts and shows one in full", async () => {
    await asControl(async (db, { alder, owner, tag, plan }) => {
      const [found, ...more] = await queries.accountList(db, { search: `owner-${tag}` });
      expect(more).toEqual([]);
      expect(found).toMatchObject({ id: owner, name: "Ada Owner", businesses: 1, owns: `Alder Dental ${tag}`, sign_in_methods: "credential", total: 1 });
      expect(await queries.accountDetail(db, owner)).toMatchObject({ email: `owner-${tag}@example.com`, open_sessions: 1, sign_in_methods: "credential" });
      expect(await queries.accountDetail(db, "1 or 1=1")).toBeNull();
      expect(await queries.accountMemberships(db, owner)).toEqual([expect.objectContaining({ business_id: alder, role: "business_owner", plan })]);
    });
  });

  it("can't read a secret, run the app's functions, or write anything", async () => {
    await asControl(async (_db, { alder }) => {
      for (const statement of ["select password_hash from users", "select password from accounts", "select token from sessions", "select ip_address from sessions",
        "select body from messages", "select billing_key from billing_accounts", "select token_hash from business_invitations", "select * from transcripts limit 1",
        "select * from contacts limit 1", "select * from api_keys limit 1"]) {
        expect(await refusal(statement), statement).toBe("42501");
      }
      expect(await refusal("select app.current_business_id()")).toBe("42501");
      expect(await refusal("update businesses set name = 'Taken over' where id = $1", [alder])).toBe("42501");
      expect(await refusal("delete from calls where business_id = $1", [alder])).toBe("42501");
      expect(await refusal("insert into users (email, normalized_email) values ('x@example.com', 'x@example.com')")).toBe("42501");
    });
  });

  it.skipIf(!controlPassword)("signs in read-only, with time limits, as lobbystack_control", async () => {
    const control = new pg.Client({ connectionString: controlDatabaseUrl({ DATABASE_URL: testUrl, LOBBYSTACK_CONTROL_PASSWORD: controlPassword }) });
    await control.connect();
    try {
      await checkRole(control);
      const setting = async (name: string) => ((await control.query<{ value: string }>(`select current_setting('${name}') as value`)).rows[0]?.value);
      expect(await setting("default_transaction_read_only")).toBe("on");
      expect(await setting("statement_timeout")).toBe("15s");
      expect(await setting("lock_timeout")).toBe("2s");
      expect(await setting("idle_in_transaction_session_timeout")).toBe("1min");
      await expect(control.query("create temporary table scratch (id int)")).rejects.toMatchObject({ code: "25006" });
      await expect(control.query("select password_hash from users limit 1")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await control.end();
    }
  });
});
