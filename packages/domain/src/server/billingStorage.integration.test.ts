import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businesses, createDatabaseClient, type DatabaseTransaction } from "@lobbystack/db";

// Migration 0146: billing storage that names its provider (ADR 0010). The
// expand half: new columns beside Polar's, filled from them, and triggers that
// keep each pair equal whichever release writes the row.

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

const migration = readFileSync(new URL("../../../db/migrations/0146_billing_provider.sql", import.meta.url), "utf8");
/** The migration's backfills: the UPDATEs that fill the new columns of rows from before it. */
const backfills = migration.match(/^UPDATE public\.[\s\S]*?;$/gm) ?? [];

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

describe.skipIf(!client)("billing storage that names its provider (migration 0146)", () => {
  it("has a backfill for each table whose Polar column has a twin", () => {
    expect(backfills.map((statement) => statement.match(/^UPDATE (public\.\w+)/)![1])).toEqual(["public.billing_runs", "public.billing_prices", "public.billing_plans", "public.billing_transactions"]);
  });

  it("fills the new columns of rows written before it from the Polar ones, and a second run changes nothing", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const code = planCode();
      const [disc, product, customer, order, liveOrg, sandboxOrg] = ["disc", "prod", "cus", "order", "org", "org"].map(unique);
      // Rows as the release before wrote them: Polar's columns only, with no trigger yet to fill the rest.
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(planInsert(code, { polar_disc: disc! }));
      await tx.execute(sql`insert into public.billing_prices (plan, period, currency, cents, polar_id) values (${code}, 'monthly', 'cad', 5000, ${product})`);
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, polar_env, polar_org) values ('verify', 'passed', 'storage-test', 1, ${hash}, '{}', 'production', ${liveOrg}), ('verify', 'drift', 'storage-test', 1, ${hash}, '{}', 'sandbox', ${sandboxOrg})`);
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, key_id, partner, idem_key, req_hash) values ('catalog', 'applied', 'storage-test', 1, ${hash}, '{}', ${randomUUID()}::uuid, 'test', ${randomUUID()}, ${hash})`);
      await tx.execute(sql`insert into public.billing_transactions (business_id, kind, source_id, status, amount_cents, currency, occurred_at, polar_customer_id) values (${businessId}::uuid, 'order', ${order}, 'paid', 4900, 'cad', now(), ${customer})`);
      await tx.execute(sql`set local session_replication_role = origin`);

      const read = async () => ({
        plan: (await rows(tx, sql`select polar_disc, provider_disc from public.billing_plans where code = ${code}`))[0],
        price: (await rows(tx, sql`select polar_id, provider_ref from public.billing_prices where plan = ${code}`))[0],
        runs: await rows(tx, sql`select kind, polar_env, polar_org, provider, provider_env, provider_account from public.billing_runs where brand = 'storage-test' order by kind, status`),
        transaction: (await rows(tx, sql`select polar_customer_id, provider_customer_id from public.billing_transactions where source_id = ${order}`))[0],
      });
      expect(await read()).toEqual({
        plan: { polar_disc: disc, provider_disc: null },
        price: { polar_id: product, provider_ref: null },
        runs: [
          { kind: "catalog", polar_env: null, polar_org: null, provider: null, provider_env: null, provider_account: null },
          { kind: "verify", polar_env: "sandbox", polar_org: sandboxOrg, provider: null, provider_env: null, provider_account: null },
          { kind: "verify", polar_env: "production", polar_org: liveOrg, provider: null, provider_env: null, provider_account: null },
        ],
        transaction: { polar_customer_id: customer, provider_customer_id: null },
      });

      for (const backfill of backfills) await tx.execute(sql.raw(backfill));
      const filled = {
        plan: { polar_disc: disc, provider_disc: disc },
        price: { polar_id: product, provider_ref: product },
        runs: [
          // A catalog run names no provider.
          { kind: "catalog", polar_env: null, polar_org: null, provider: null, provider_env: null, provider_account: null },
          { kind: "verify", polar_env: "sandbox", polar_org: sandboxOrg, provider: "polar", provider_env: "sandbox", provider_account: sandboxOrg },
          { kind: "verify", polar_env: "production", polar_org: liveOrg, provider: "polar", provider_env: "live", provider_account: liveOrg },
        ],
        transaction: { polar_customer_id: customer, provider_customer_id: customer },
      };
      expect(await read()).toEqual(filled);
      for (const backfill of backfills) await tx.execute(sql.raw(backfill));
      expect(await read()).toEqual(filled);
    });
  });

  it("keeps each new column and its Polar twin equal, whichever release writes the row", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const [oldPlan, newPlan] = [planCode(), planCode()];
      const [oldDisc, newDisc, otherDisc, oldProduct, newProduct, otherProduct, oldCustomer, newCustomer, otherCustomer] = ["disc", "disc", "disc", "prod", "prod", "prod", "cus", "cus", "cus"].map(unique);

      // Plans: the previous release writes polar_disc, this one provider_disc.
      await tx.execute(planInsert(oldPlan, { polar_disc: oldDisc! }));
      await tx.execute(planInsert(newPlan, { provider_disc: newDisc! }));
      const discounts = async () => await rows(tx, sql`select code, polar_disc, provider_disc from public.billing_plans where code in (${oldPlan}, ${newPlan}) order by code = ${oldPlan} desc`);
      expect(await discounts()).toEqual([{ code: oldPlan, polar_disc: oldDisc, provider_disc: oldDisc }, { code: newPlan, polar_disc: newDisc, provider_disc: newDisc }]);
      await tx.execute(sql`update public.billing_plans set provider_disc = ${otherDisc} where code = ${oldPlan}`);
      await tx.execute(sql`update public.billing_plans set polar_disc = null where code = ${newPlan}`);
      expect(await discounts()).toEqual([{ code: oldPlan, polar_disc: otherDisc, provider_disc: otherDisc }, { code: newPlan, polar_disc: null, provider_disc: null }]);
      // An update that touches neither leaves both.
      await tx.execute(sql`update public.billing_plans set sort = 7 where code = ${oldPlan}`);
      expect((await discounts())[0]).toEqual({ code: oldPlan, polar_disc: otherDisc, provider_disc: otherDisc });

      // Prices.
      await tx.execute(sql`insert into public.billing_prices (plan, period, currency, cents, polar_id) values (${oldPlan}, 'monthly', 'cad', 5000, ${oldProduct})`);
      await tx.execute(sql`insert into public.billing_prices (plan, period, currency, cents, provider_ref) values (${newPlan}, 'monthly', 'cad', 5000, ${newProduct})`);
      const products = async () => await rows(tx, sql`select plan, polar_id, provider_ref from public.billing_prices where plan in (${oldPlan}, ${newPlan}) order by plan = ${oldPlan} desc`);
      expect(await products()).toEqual([{ plan: oldPlan, polar_id: oldProduct, provider_ref: oldProduct }, { plan: newPlan, polar_id: newProduct, provider_ref: newProduct }]);
      await tx.execute(sql`update public.billing_prices set polar_id = ${otherProduct} where plan = ${oldPlan}`);
      await tx.execute(sql`update public.billing_prices set provider_ref = null where plan = ${newPlan}`);
      expect(await products()).toEqual([{ plan: oldPlan, polar_id: otherProduct, provider_ref: otherProduct }, { plan: newPlan, polar_id: null, provider_ref: null }]);
      // One product sells one price, by either name.
      expect(await failure(tx, sql`update public.billing_prices set provider_ref = ${otherProduct} where plan = ${newPlan}`)).toMatchObject({ code: "23505" });

      // Transactions.
      const [first, second] = [unique("order"), unique("order")];
      await tx.execute(sql`insert into public.billing_transactions (business_id, kind, source_id, status, amount_cents, currency, occurred_at, polar_customer_id) values (${businessId}::uuid, 'order', ${first}, 'paid', 4900, 'cad', now(), ${oldCustomer})`);
      await tx.execute(sql`insert into public.billing_transactions (business_id, kind, source_id, status, amount_cents, currency, occurred_at, provider_customer_id) values (${businessId}::uuid, 'order', ${second}, 'paid', 4900, 'cad', now(), ${newCustomer})`);
      const customers = async () => await rows(tx, sql`select polar_customer_id, provider_customer_id from public.billing_transactions where source_id in (${first}, ${second}) order by source_id = ${first} desc`);
      expect(await customers()).toEqual([{ polar_customer_id: oldCustomer, provider_customer_id: oldCustomer }, { polar_customer_id: newCustomer, provider_customer_id: newCustomer }]);
      await tx.execute(sql`update public.billing_transactions set provider_customer_id = ${otherCustomer} where source_id = ${first}`);
      expect((await customers())[0]).toEqual({ polar_customer_id: otherCustomer, provider_customer_id: otherCustomer });

      // Runs: Polar's environment names map both ways; a Stripe run has no Polar columns.
      const [oldOrg, newOrg, account] = [unique("org"), unique("org"), unique("acct")];
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, polar_env, polar_org) values ('verify', 'passed', 'storage-test', 1, ${hash}, '{}', 'production', ${oldOrg})`);
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account) values ('verify', 'drift', 'storage-test', 1, ${hash}, '{}', 'polar', 'sandbox', ${newOrg})`);
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account) values ('verify', 'failed', 'storage-test', 1, ${hash}, '{}', 'stripe', 'live', ${account})`);
      expect(await rows(tx, sql`select status, polar_env, polar_org, provider, provider_env, provider_account from public.billing_runs where brand = 'storage-test' order by status`)).toEqual([
        { status: "drift", polar_env: "sandbox", polar_org: newOrg, provider: "polar", provider_env: "sandbox", provider_account: newOrg },
        { status: "failed", polar_env: null, polar_org: null, provider: "stripe", provider_env: "live", provider_account: account },
        { status: "passed", polar_env: "production", polar_org: oldOrg, provider: "polar", provider_env: "live", provider_account: oldOrg },
      ]);
    });
  });

  it("takes the rows the release before inserts, and refuses values no release writes", async () => {
    await rollbackTest(async (tx) => {
      const [polarBusiness, stripeBusiness, badBusiness] = [await business(tx), await business(tx), await business(tx)];
      // The plan a waiting change moves a business to.
      const nextPlan = planCode();
      await tx.execute(planInsert(nextPlan, { provider_disc: unique("disc") }));
      // An account inserted without a source pays through Polar, as before.
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

      // A link may be named link, and a link or verify run names its account one way or the other.
      const keys = sql`${randomUUID()}::uuid, 'test', ${randomUUID()}, ${hash}`;
      await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account, key_id, partner, idem_key, req_hash) values ('link', 'applied', 'storage-test', 1, ${hash}, '{}', 'stripe', 'sandbox', 'acct_test', ${keys})`);
      expect(await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile) values ('verify', 'passed', 'storage-test', 1, ${hash}, '{}')`)).toEqual({ code: "23514", constraint: "billing_runs_provider" });
      expect(await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account) values ('verify', 'passed', 'storage-test', 1, ${hash}, '{}', 'paypal', 'live', 'acct_test')`)).toEqual({ code: "23514", constraint: "billing_runs_provider_values" });
      expect(await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account) values ('verify', 'passed', 'storage-test', 1, ${hash}, '{}', 'stripe', 'prod', 'acct_test')`)).toEqual({ code: "23514", constraint: "billing_runs_provider_values" });
    });
  });

  it("offers each plan with its provider's objects, beside Polar's names", async () => {
    await rollbackTest(async (tx) => {
      const code = planCode();
      const [disc, product] = [unique("disc"), unique("prod")];
      await tx.execute(planInsert(code, { provider_disc: disc }));
      await tx.execute(sql`insert into public.billing_prices (plan, period, currency, cents, provider_ref) values (${code}, 'monthly', 'cad', 5000, ${product})`);
      expect(await rows(tx, sql`select polar_disc, provider_disc, polar_id, provider_ref from public.billing_offers where code = ${code}`)).toEqual([{ polar_disc: disc, provider_disc: disc, polar_id: product, provider_ref: product }]);
      // The promo code reader returns them last, so the release before reads it unchanged.
      const [result] = await rows(tx, sql`select pg_get_function_result('app.billing_code_offers(text)'::regprocedure) as result`);
      expect(String(result!.result)).toMatch(/polar_id text, receptionists smallint, provider_disc text, provider_ref text\)$/);
    });
  });
});
