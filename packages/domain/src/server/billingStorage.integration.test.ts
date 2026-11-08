import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businesses, createDatabaseClient, type DatabaseTransaction } from "@lobbystack/db";

// Billing storage that names its provider (ADR 0010): migration 0146 added
// provider-neutral columns beside Polar's, and 0147, the contract, dropped
// Polar's. The database here is at 0147; the contract's own test rebuilds the
// state 0146 left inside a transaction it rolls back.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Reliability integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

type Row = Record<string, unknown>;

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      // The catalog's lock, so the catalog tests that empty these tables wait for this one.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('lobbystack.billing_catalog'))`);
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function rows(tx: DatabaseTransaction, query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await tx.execute<Row>(query)).rows;
}

/** The statement's error, run in a savepoint so the test's transaction carries on. */
async function failure(tx: DatabaseTransaction, statement: ReturnType<typeof sql>): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await tx.transaction(async (savepoint) => { await savepoint.execute(statement); });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause ?? (error as { code?: string; constraint?: string });
    return { code: cause.code, constraint: cause.constraint };
  }
  throw new Error("The statement went through.");
}

const migrationText = (name: string) => readFileSync(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8");
const expand = migrationText("0146_billing_provider.sql");
const contract = migrationText("0147_billing_provider_contract.sql");

/**
 * The schema as 0146 left it, inside the test's transaction: the Polar
 * columns and indexes back, without the view and the function that 0147 made
 * again, then 0146 itself, which makes its triggers, checks, view and function.
 */
async function as0146Left(tx: DatabaseTransaction): Promise<void> {
  await tx.execute(sql.raw(`
    DROP FUNCTION app.billing_code_offers(text);
    DROP VIEW public.billing_offers;
    ALTER TABLE public.billing_runs ADD COLUMN polar_env varchar(10) CHECK (polar_env IN ('sandbox', 'production')), ADD COLUMN polar_org text;
    ALTER TABLE public.billing_prices ADD COLUMN polar_id text;
    CREATE UNIQUE INDEX billing_prices_polar_unique ON public.billing_prices (polar_id) WHERE polar_id IS NOT NULL;
    ALTER TABLE public.billing_plans ADD COLUMN polar_disc text;
    CREATE UNIQUE INDEX billing_plans_polar_disc_unique ON public.billing_plans (polar_disc) WHERE polar_disc IS NOT NULL;
    ALTER TABLE public.billing_transactions ADD COLUMN polar_customer_id text;
    CREATE INDEX provider_events_polar_received_idx ON public.provider_events (created_at) WHERE status = 'received' AND provider = 'polar';
    ALTER TABLE public.billing_accounts DROP CONSTRAINT billing_accounts_source_check;
    ALTER TABLE public.billing_usage_events DROP CONSTRAINT billing_usage_events_rate_cents_check;
  `));
  await tx.execute(sql.raw(expand));
}

const hash = "a".repeat(64);
const names = JSON.stringify({ en: "Storage test", fr: "Storage test", es: "Storage test", sr: "Storage test" });
const unique = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

async function business(tx: DatabaseTransaction): Promise<string> {
  const id = randomUUID();
  await tx.insert(businesses).values({ id, slug: id, name: "Billing storage test", timezone: "UTC", businessType: "test", telemetryEnabled: false });
  return id;
}

/** A sold promo plan with a discount, as an API plan is stored; the Polar or provider discount as given. */
function planInsert(code: string, discount: { polar_disc?: string; provider_disc?: string }) {
  const column = discount.provider_disc === undefined ? sql.raw("polar_disc") : sql.raw("provider_disc");
  const value = discount.provider_disc ?? discount.polar_disc ?? null;
  return sql`insert into public.billing_plans (code, tier, status, access, sold, overage, src, names, voice_sec, sms_seg, calls_out, chat_units, kb_bytes, numbers, voice_rate, sms_rate, call_rate, terms_hash, discount, ${column})
    values (${code}, 'pro', 'active', 'code', true, true, 'api', ${names}::jsonb, 1, 1, 1, 1, 1, 1, 1, 1, 1, ${hash}, '{"type": "percentage", "basis_points": 5000}'::jsonb, ${value})`;
}

const planCode = () => `storage-${randomUUID().slice(0, 8)}`;
const keys = () => sql`${randomUUID()}::uuid, 'test', ${randomUUID()}, ${hash}`;

describe.skipIf(!client)("billing storage that names its provider (migrations 0146 and 0147)", () => {
  it("drops the Polar columns of a database at 0146 that holds rows of both providers, and keeps what their twins hold", async () => {
    await rollbackTest(async (tx) => {
      await as0146Left(tx);
      const businessId = await business(tx);
      const [polarPlan, stripePlan] = [planCode(), planCode()];
      const [disc, coupon, product, price, customer, stripeCustomer, org, account] = ["disc", "coupon", "prod", "price", "cus", "cus", "org", "acct"].map(unique);
      // Polar's rows as the release before 0146 wrote them, which 0146's triggers fill the twins of; Stripe's as the code writes them now.
      await tx.execute(planInsert(polarPlan, { polar_disc: disc! }));
      await tx.execute(planInsert(stripePlan, { provider_disc: coupon! }));
      await tx.execute(sql`insert into public.billing_prices (plan, period, currency, cents, polar_id) values (${polarPlan}, 'monthly', 'cad', 5000, ${product})`);
      await tx.execute(sql`insert into public.billing_prices (plan, period, currency, cents, provider_ref) values (${stripePlan}, 'monthly', 'cad', 5000, ${price})`);
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, polar_env, polar_org, key_id, partner, idem_key, req_hash) values ('polar', 'applied', 'storage-test', 1, ${hash}, '{}', 'production', ${org}, ${keys()})`);
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, polar_env, polar_org) values ('verify', 'passed', 'storage-test', 1, ${hash}, '{}', 'sandbox', ${org})`);
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account, key_id, partner, idem_key, req_hash) values ('link', 'applied', 'storage-test', 1, ${hash}, '{}', 'stripe', 'sandbox', ${account}, ${keys()})`);
      await tx.execute(sql`insert into public.billing_transactions (business_id, kind, source_id, status, amount_cents, currency, occurred_at, polar_customer_id) values (${businessId}::uuid, 'order', ${unique("order")}, 'paid', 4900, 'cad', now(), ${customer})`);
      await tx.execute(sql`insert into public.billing_transactions (business_id, kind, source_id, status, amount_cents, currency, occurred_at, provider_customer_id) values (${businessId}::uuid, 'order', ${unique("in")}, 'paid', 4900, 'cad', now(), ${stripeCustomer})`);

      await tx.execute(sql.raw(contract));

      // Only the provider-neutral columns are left, holding what both providers' rows had.
      const polarColumns = await rows(tx, sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and column_name in ('polar_env', 'polar_org', 'polar_id', 'polar_disc', 'polar_customer_id') order by table_name, column_name`);
      expect(polarColumns).toEqual([]);
      expect(await rows(tx, sql`select code, provider_disc from public.billing_plans where code in (${polarPlan}, ${stripePlan}) order by code = ${polarPlan} desc`)).toEqual([{ code: polarPlan, provider_disc: disc }, { code: stripePlan, provider_disc: coupon }]);
      expect(await rows(tx, sql`select plan, provider_ref from public.billing_prices where plan in (${polarPlan}, ${stripePlan}) order by plan = ${polarPlan} desc`)).toEqual([{ plan: polarPlan, provider_ref: product }, { plan: stripePlan, provider_ref: price }]);
      expect(await rows(tx, sql`select provider_customer_id from public.billing_transactions where business_id = ${businessId}::uuid order by provider_customer_id = ${customer} desc`)).toEqual([{ provider_customer_id: customer }, { provider_customer_id: stripeCustomer }]);
      // Polar's link is a link run now, and every run keeps its provider.
      expect(await rows(tx, sql`select kind, provider, provider_env, provider_account from public.billing_runs where brand = 'storage-test' order by kind, provider`)).toEqual([
        { kind: "link", provider: "polar", provider_env: "live", provider_account: org },
        { kind: "link", provider: "stripe", provider_env: "sandbox", provider_account: account },
        { kind: "verify", provider: "polar", provider_env: "sandbox", provider_account: org },
      ]);
      // The triggers, their functions and the Polar indexes are gone, and the checks 0146 left unchecked are checked.
      expect(await rows(tx, sql`select tgname from pg_trigger where tgname like 'billing_%_sync'`)).toEqual([]);
      expect(await rows(tx, sql`select proname from pg_proc where proname like 'billing_%_sync'`)).toEqual([]);
      expect(await rows(tx, sql`select indexname from pg_indexes where indexname in ('billing_prices_polar_unique', 'billing_plans_polar_disc_unique', 'provider_events_polar_received_idx')`)).toEqual([]);
      expect(await rows(tx, sql`select conname, convalidated from pg_constraint where conname in ('billing_accounts_source_check', 'billing_usage_events_rate_cents_check') order by conname`)).toEqual([
        { conname: "billing_accounts_source_check", convalidated: true },
        { conname: "billing_usage_events_rate_cents_check", convalidated: true },
      ]);
      expect(await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account, key_id, partner, idem_key, req_hash) values ('polar', 'applied', 'storage-test', 1, ${hash}, '{}', 'polar', 'sandbox', ${org}, ${keys()})`)).toEqual({ code: "23514", constraint: "billing_runs_kind_check" });
    });
  });

  it("refuses the values no release writes", async () => {
    await rollbackTest(async (tx) => {
      const [polarBusiness, stripeBusiness, badBusiness] = [await business(tx), await business(tx), await business(tx)];
      // The plan a waiting change moves a business to.
      const nextPlan = planCode();
      await tx.execute(planInsert(nextPlan, { provider_disc: unique("disc") }));
      // An account inserted without a source pays through Polar: reconcile's upsert leaves it out for one that exists.
      await tx.execute(sql`insert into public.billing_accounts (business_id, billing_key) values (${polarBusiness}::uuid, ${`business:${polarBusiness}`})`);
      await tx.execute(sql`insert into public.billing_accounts (business_id, billing_key, source, overage_subscription_id) values (${stripeBusiness}::uuid, ${`business:${stripeBusiness}`}, 'stripe', 'sub_overage')`);
      expect(await rows(tx, sql`select source from public.billing_accounts where business_id in (${polarBusiness}::uuid, ${stripeBusiness}::uuid) order by source`)).toEqual([{ source: "polar" }, { source: "stripe" }]);
      const account = (columns: string, values: ReturnType<typeof sql>) => sql`insert into public.billing_accounts (business_id, billing_key, ${sql.raw(columns)}) values (${badBusiness}::uuid, ${`business:${badBusiness}`}, ${values})`;
      expect(await failure(tx, account("source", sql`'paypal'`))).toEqual({ code: "23514", constraint: "billing_accounts_source_check" });
      expect(await failure(tx, account("next_plan_code, next_interval", sql`${nextPlan}, 'monthly'`))).toEqual({ code: "23514", constraint: "billing_accounts_next_change" });
      expect(await failure(tx, account("next_plan_code, next_interval, next_change_at", sql`${nextPlan}, 'weekly', now()`))).toEqual({ code: "23514", constraint: "billing_accounts_next_change" });
      expect(await failure(tx, account("overage_subscription_id", sql`'sub_overage'`))).toEqual({ code: "23505", constraint: "billing_accounts_overage_subscription_unique" });
      await tx.execute(account("next_plan_code, next_interval, next_change_at", sql`${nextPlan}, 'annual', now()`));

      // Usage priced as money never goes below zero.
      expect(await failure(tx, sql`insert into public.billing_usage_events (business_id, period_key, source_key, usage_kind, quantity, rate_cents) values (${polarBusiness}::uuid, '2001-03', ${unique("voice")}, 'voice_seconds', 60, -1)`)).toEqual({ code: "23514", constraint: "billing_usage_events_rate_cents_check" });

      // A link or verify run names its provider, environment and account.
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account, key_id, partner, idem_key, req_hash) values ('link', 'applied', 'storage-test', 1, ${hash}, '{}', 'stripe', 'sandbox', 'acct_test', ${keys()})`);
      expect(await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile) values ('verify', 'passed', 'storage-test', 1, ${hash}, '{}')`)).toEqual({ code: "23514", constraint: "billing_runs_provider" });
      expect(await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account) values ('verify', 'passed', 'storage-test', 1, ${hash}, '{}', 'paypal', 'live', 'acct_test')`)).toEqual({ code: "23514", constraint: "billing_runs_provider_values" });
      expect(await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account) values ('verify', 'passed', 'storage-test', 1, ${hash}, '{}', 'stripe', 'prod', 'acct_test')`)).toEqual({ code: "23514", constraint: "billing_runs_provider_values" });
    });
  });

  it("offers each plan with its provider's objects", async () => {
    await rollbackTest(async (tx) => {
      const code = planCode();
      const [disc, product] = [unique("disc"), unique("prod")];
      await tx.execute(planInsert(code, { provider_disc: disc }));
      await tx.execute(sql`insert into public.billing_prices (plan, period, currency, cents, provider_ref) values (${code}, 'monthly', 'cad', 5000, ${product})`);
      expect(await rows(tx, sql`select provider_disc, provider_ref from public.billing_offers where code = ${code}`)).toEqual([{ provider_disc: disc, provider_ref: product }]);
      const [result] = await rows(tx, sql`select pg_get_function_result('app.billing_code_offers(text)'::regprocedure) as result`);
      expect(String(result!.result)).toMatch(/per_month integer, receptionists smallint, provider_disc text, provider_ref text\)$/);
      expect(String(result!.result)).not.toMatch(/polar/);
    });
  });
});
