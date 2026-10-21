import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseClient, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { apiBillingCatalogApplySchema, billingProfileHash, canonicalBillingProfileJson, type ApiBillingCatalogRun } from "@lobbystack/shared";

import { applyBillingCatalogForApi, getBillingCatalogForApi, listBillingCatalogRunsForApi, type BillingCatalogDeployment } from "./billingCatalog";
import { PublicApiError } from "./publicApi/errors";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Billing catalog integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

type Row = Record<string, unknown>;
type Role = "lobbystack_app" | "lobbystack_worker" | "lobbystack_readonly" | "lobbystack_dispatcher";

// Every test but the last runs in a transaction it rolls back, after emptying the tables in it.
async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      await tx.execute(sql`reset role`);
      await tx.execute(sql`delete from public.billing_prices`);
      await tx.execute(sql`delete from public.billing_plans`);
      await tx.execute(sql`delete from public.billing_runs`);
      await as(tx, "lobbystack_worker");
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function as(tx: DatabaseTransaction, role: Role | "owner") {
  await tx.execute(sql.raw(role === "owner" ? "reset role" : `set local role ${role}`));
}

/** Runs a statement as the owner, then goes back to the worker. */
async function byHand(tx: DatabaseTransaction, statement: ReturnType<typeof sql>) {
  await as(tx, "owner");
  await tx.execute(statement);
  await as(tx, "lobbystack_worker");
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

const fileText = readFileSync(new URL("../../../../brands/alloplace/billing.json", import.meta.url), "utf8");
const names = (en: string) => ({ en, fr: en, es: en, sr: en });
const examples: Record<string, Record<string, unknown>> = {
  "pro-launch": { tier: "pro", access: "code", names: names("Pro launch offer"), sold: true, prices: { monthlyCents: 6000 }, included: { voiceMinutes: 600 }, months: 6, endsWith: "tier", offerEndsAt: "2027-03-31T23:59:59-04:00" },
  "salons-half-off": { tier: "starter", access: "code", names: names("Salon offer"), sold: true, prices: { monthlyCents: 3000 }, discount: { type: "percentage", basisPoints: 5000, duration: "repeating", durationInMonths: 3 } },
  "pro-plus": { tier: "pro", access: "public", names: names("Pro Plus"), sold: true, prices: { monthlyCents: 15000, annualCents: 144000 }, included: { voiceMinutes: 1000, alertSmsSegments: 400 } },
};

/** The AlloPlace file, changed as a test needs. */
function file(change: (value: Record<string, any>) => void = () => undefined): Record<string, any> {
  const value = JSON.parse(fileText) as Record<string, any>;
  change(value);
  return value;
}

const withExamples = (...codes: string[]) => (value: Record<string, any>) => { for (const code of codes) value.plans[code] = structuredClone(examples[code]); };

const caller = { platformKeyId: randomUUID(), partnerId: "lobbystack" };
// The hash of brands/alloplace/billing.json this build carries.
const deployedHash = billingProfileHash("alloplace")!;
const deployed: BillingCatalogDeployment = { brand: "alloplace" };
const context = (tx: DatabaseTransaction) => ({ db: tx as unknown as Database });

/** Applies a file as the operator key; a changed file goes in with allow_undeployed unless the test says otherwise. */
async function apply(tx: DatabaseTransaction, billingFile: Record<string, any>, options: { key?: string | null; dryRun?: boolean; replacesHash?: string | null; allowUndeployed?: boolean; deployment?: BillingCatalogDeployment; brand?: string } = {}) {
  const changed = JSON.stringify(billingFile) !== JSON.stringify(JSON.parse(fileText));
  const body = apiBillingCatalogApplySchema.parse({
    brand: options.brand ?? "alloplace",
    billing_file: billingFile,
    ...(options.dryRun ? { dry_run: true } : {}),
    ...(options.replacesHash !== undefined ? { replaces_hash: options.replacesHash } : {}),
    ...((options.allowUndeployed ?? changed) ? { allow_undeployed: true } : {}),
  });
  return await applyBillingCatalogForApi(context(tx), { caller, idempotencyKey: options.key === undefined ? randomUUID() : options.key, body, deployment: options.deployment ?? deployed });
}

async function refusal(promise: Promise<unknown>): Promise<PublicApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PublicApiError) return error;
    throw error;
  }
  throw new Error("The apply went through.");
}

const count = async (tx: DatabaseTransaction, table: "billing_runs" | "billing_plans" | "billing_prices") => Number((await rows(tx, sql.raw(`select count(*) as n from public.${table}`)))[0]!.n);
const plan = async (tx: DatabaseTransaction, code: string) => (await rows(tx, sql`select * from public.billing_plans where code = ${code}`))[0]!;
const prices = async (tx: DatabaseTransaction, code: string) => await rows(tx, sql`select * from public.billing_prices where plan = ${code} order by period, retired_at nulls first`);
const actions = (run: ApiBillingCatalogRun) => run.changes.map((change) => `${change.action} ${change.key}`);
const hashOf = (value: Record<string, any>) => createHash("sha256").update(canonicalBillingProfileJson(apiBillingCatalogApplySchema.parse({ brand: "alloplace", billing_file: value }).billing_file)).digest("hex");

describe.skipIf(!testUrl)("billing catalog apply", () => {
  it("seeds an empty deployment, records unchanged for the same file, and applied with no changes for a polar-only edit", async () => {
    await rollbackTest(async (tx) => {
      const first = await apply(tx, file());
      expect(first).toMatchObject({ status: 201, replayed: false, run: { kind: "catalog", status: "applied", brand: "alloplace", ver: 1, prev_hash: null, code_hash: deployedHash, hash: deployedHash, key_id: caller.platformKeyId, partner: "lobbystack" } });
      expect(actions(first.run)).toEqual(["insert enterprise", "insert free_cloud", "insert pro", "insert starter", "insert pro/annual/cad", "insert pro/monthly/cad", "insert starter/annual/cad", "insert starter/monthly/cad"]);
      expect(first.run.ended_at).not.toBeNull();
      expect(Object.fromEntries((await rows(tx, sql`select code, status, src, access from public.billing_plans`)).map((row) => [row.code, `${String(row.status)} ${String(row.src)} ${String(row.access)}`]))).toEqual({ free_cloud: "active file public", starter: "draft file public", pro: "draft file public", enterprise: "active file hidden" });
      expect((await rows(tx, sql`select distinct run_id from public.billing_plans union select distinct run_id from public.billing_prices`)).map((row) => row.run_id)).toEqual([first.run.id]);
      expect((await prices(tx, "starter")).map((row) => [row.period, row.cents, row.per_month])).toEqual([["annual", 28800, 2400], ["monthly", 3000, 3000]]);

      const again = await apply(tx, file());
      expect(again.run).toMatchObject({ status: "unchanged", changes: [], prev_hash: first.run.hash, hash: first.run.hash });
      const polarOnly = await apply(tx, file((value) => { value.polar.portalPlanChanges = false; }));
      expect(polarOnly.run).toMatchObject({ status: "applied", changes: [], prev_hash: first.run.hash });
      expect(polarOnly.run.hash).not.toBe(first.run.hash);
      // Rows nothing changed keep the run that wrote them.
      expect((await rows(tx, sql`select distinct run_id from public.billing_plans`)).map((row) => row.run_id)).toEqual([first.run.id]);
      expect(await count(tx, "billing_runs")).toBe(3);
      // The run keeps the profile it applied, without $schema, as the catalog shows it.
      const catalog = await getBillingCatalogForApi(context(tx), { deployment: deployed });
      expect(catalog).toMatchObject({ brand: "alloplace", hash: polarOnly.run.hash, matches_code: false, currency: "cad", last_run: { id: polarOnly.run.id } });
      expect(catalog.profile).toMatchObject({ polar: { portalPlanChanges: false } });
      expect(catalog.profile).not.toHaveProperty("$schema");
    });
  });

  it("replays the same key and body, refuses the key with another body, needs a key for a real apply but not a dry run", async () => {
    await rollbackTest(async (tx) => {
      const first = await apply(tx, file(), { key: "seed-1" });
      const replay = await apply(tx, file(), { key: "seed-1" });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(await count(tx, "billing_runs")).toBe(1);
      expect(await refusal(apply(tx, file(), { key: "seed-1", replacesHash: first.run.hash }))).toMatchObject({ status: 422, code: "idempotency_key_reused" });
      expect(await refusal(apply(tx, file(), { key: null }))).toMatchObject({ status: 400, code: "invalid_request", details: [{ path: "Idempotency-Key" }] });
      expect(await apply(tx, file(), { key: null, dryRun: true })).toMatchObject({ status: 200, run: { id: null, status: "preview" } });
      expect(await count(tx, "billing_runs")).toBe(1);
    });
  });

  it("changes a price in place, keeping its Polar product", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file());
      const [before] = (await prices(tx, "pro")).filter((row) => row.period === "monthly");
      await byHand(tx, sql`update public.billing_prices set polar_id = 'prod_pro_m' where id = ${before!.id}`);
      const changed = await apply(tx, file((value) => { value.plans.pro.prices.monthlyCents = 11000; }));
      expect(actions(changed.run)).toEqual(["update pro", "update pro/monthly/cad"]);
      expect(changed.run.changes[1]).toMatchObject({ raises_price: true, fields: { cents: { from: 10000, to: 11000 } } });
      const after = (await prices(tx, "pro")).filter((row) => row.period === "monthly");
      expect(after).toEqual([expect.objectContaining({ id: before!.id, cents: 11000, polar_id: "prod_pro_m", run_id: changed.run.id, retired_at: null })]);
    });
  });

  it("retires a period that leaves the file and restores the same row when it comes back", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file());
      const [annual] = await prices(tx, "starter");
      await byHand(tx, sql`update public.billing_prices set polar_id = 'prod_starter_a' where id = ${annual!.id}`);
      const removed = await apply(tx, file((value) => { delete value.plans.starter.prices.annualCents; }));
      expect(actions(removed.run)).toEqual(["update starter", "retire starter/annual/cad"]);
      expect((await prices(tx, "starter")).find((row) => row.id === annual!.id)!.retired_at).not.toBeNull();
      const restored = await apply(tx, file((value) => { value.plans.starter.prices.annualCents = 30000; }));
      expect(actions(restored.run)).toEqual(["update starter", "restore starter/annual/cad"]);
      const rowsNow = (await prices(tx, "starter")).filter((row) => row.period === "annual");
      expect(rowsNow).toEqual([expect.objectContaining({ id: annual!.id, cents: 30000, polar_id: "prod_starter_a", retired_at: null })]);
    });
  });

  it("makes a new sold plan draft and an unsold one active, and sends a sold active plan back to draft when its terms change", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file());
      expect((await plan(tx, "starter")).status).toBe("draft");
      expect((await plan(tx, "free_cloud")).status).toBe("active");
      await byHand(tx, sql`update public.billing_plans set status = 'active' where code = 'pro'`);
      const changed = await apply(tx, file((value) => {
        value.plans.pro.included.chatAiUnits = 250;
        value.plans.free_cloud.included.chatAiUnits = 6;
      }));
      expect(changed.run.changes.find((change) => change.key === "pro")!.fields.status).toEqual({ from: "active", to: "draft" });
      expect((await plan(tx, "pro")).status).toBe("draft");
      expect((await plan(tx, "free_cloud")).status).toBe("active");
    });
  });

  it("reaches every additional plan that inherits a tier's value, and none that sets its own", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file(withExamples("pro-launch", "pro-plus")));
      expect((await plan(tx, "pro-launch")).voice_sec).toBe(36000);
      const raised = await apply(tx, file((value) => { withExamples("pro-launch", "pro-plus")(value); value.plans.pro.included.alertSmsSegments = 250; }));
      expect(actions(raised.run)).toEqual(["update pro", "update pro-launch"]);
      expect((await plan(tx, "pro-launch")).sms_seg).toBe(250);
      expect((await plan(tx, "pro-plus")).sms_seg).toBe(400);
    });
  });

  it("refuses to change a frozen plan's terms, directly or through its tier, but lets its names change and lets it retire", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file(withExamples("pro-launch")));
      await byHand(tx, sql`update public.billing_plans set frozen_at = now(), status = 'active' where code = 'pro-launch'`);
      const runs = await count(tx, "billing_runs");
      const direct = await refusal(apply(tx, file((value) => { withExamples("pro-launch")(value); value.plans["pro-launch"].prices.monthlyCents = 6500; })));
      expect(direct).toMatchObject({ status: 409, code: "conflict", details: [{ code: "plan_frozen", path: "billing_file.plans.pro-launch" }] });
      const inherited = await refusal(apply(tx, file((value) => { withExamples("pro-launch")(value); value.plans.pro.limits.businessNumbers = 2; })));
      expect(inherited.details!.map((detail) => detail.code)).toEqual(["plan_frozen"]);
      expect(await count(tx, "billing_runs")).toBe(runs);
      expect((await plan(tx, "pro")).numbers).toBe(1);

      const renamed = await apply(tx, file((value) => { withExamples("pro-launch")(value); value.plans["pro-launch"].names.en = "Launch"; value.plans["pro-launch"].access = "hidden"; }));
      expect(Object.keys(renamed.run.changes[0]!.fields).sort()).toEqual(["access", "names"]);
      const removed = await apply(tx, file());
      expect(actions(removed.run)).toEqual(["retire pro-launch", "retire pro-launch/monthly/cad"]);
      expect(await plan(tx, "pro-launch")).toMatchObject({ status: "retired", frozen_at: expect.anything() });
      expect((await prices(tx, "pro-launch"))[0]!.retired_at).not.toBeNull();
    });
  });

  it("refuses a currency change while Polar sells a live price, and otherwise retires the old prices and inserts new ones", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file());
      await byHand(tx, sql`update public.billing_prices set polar_id = 'prod_pro_m' where plan = 'pro' and period = 'monthly'`);
      const usd = file((value) => { value.currency = "usd"; });
      expect((await refusal(apply(tx, usd))).details).toEqual([expect.objectContaining({ code: "currency_locked", path: "billing_file.currency" })]);
      await byHand(tx, sql`update public.billing_prices set polar_id = null`);
      const changed = await apply(tx, usd);
      expect(actions(changed.run).filter((action) => action.includes("/"))).toEqual(["retire pro/annual/cad", "insert pro/annual/usd", "retire pro/monthly/cad", "insert pro/monthly/usd", "retire starter/annual/cad", "insert starter/annual/usd", "retire starter/monthly/cad", "insert starter/monthly/usd"]);
      expect((await rows(tx, sql`select currency from public.billing_prices where retired_at is null group by currency`)).map((row) => row.currency)).toEqual(["usd"]);
      expect(await count(tx, "billing_prices")).toBe(8);
    });
  });

  it("never touches a plan made through the API, and refuses a file plan with its code", async () => {
    await rollbackTest(async (tx) => {
      await byHand(tx, sql`insert into public.billing_plans (code, tier, status, access, sold, overage, src, names, voice_sec, sms_seg, calls_out, chat_units, kb_bytes, numbers, voice_rate, sms_rate, call_rate, terms_hash) values ('partner-deal', 'pro', 'active', 'code', true, true, 'api', ${JSON.stringify(names("Partner deal"))}::jsonb, 1, 1, 1, 1, 1, 1, 1, 1, 1, ${"a".repeat(64)})`);
      await byHand(tx, sql`insert into public.billing_prices (plan, period, currency, cents) values ('partner-deal', 'monthly', 'cad', 5000)`);
      const seeded = await apply(tx, file());
      expect(seeded.run.changes.some((change) => change.key.startsWith("partner-deal"))).toBe(false);
      expect(await plan(tx, "partner-deal")).toMatchObject({ status: "active", src: "api", run_id: null });
      expect((await prices(tx, "partner-deal"))[0]).toMatchObject({ retired_at: null, run_id: null });
      const taken = await refusal(apply(tx, file((value) => { value.plans["partner-deal"] = structuredClone(examples["pro-launch"]); })));
      expect(taken.details).toEqual([expect.objectContaining({ code: "code_taken", path: "billing_file.plans.partner-deal" })]);
    });
  });

  it("refuses a wrong brand, an undeployed file and a catalog someone changed, listing every reason and writing nothing", async () => {
    await rollbackTest(async (tx) => {
      const first = await apply(tx, file());
      const changed = file((value) => { value.plans.pro.included.chatAiUnits = 250; });
      const refused = await refusal(apply(tx, changed, { allowUndeployed: false, replacesHash: "b".repeat(64), deployment: { brand: "lobbystack" } }));
      expect(refused).toMatchObject({ status: 409, code: "conflict" });
      expect(refused.details!.map((detail) => [detail.code, detail.path])).toEqual([["brand_mismatch", "brand"], ["file_not_deployed", "billing_file"], ["catalog_changed", "replaces_hash"]]);
      expect(refused.message).toContain("brand_mismatch, file_not_deployed, catalog_changed");
      expect(await count(tx, "billing_runs")).toBe(1);
      expect((await plan(tx, "pro")).chat_units).toBe(200);
      // A brand the code has no file for.
      expect((await refusal(apply(tx, file(), { brand: "cadre", deployment: { brand: "cadre" } }))).details).toEqual([expect.objectContaining({ code: "file_not_deployed", message: expect.stringContaining("no billing.json for cadre") })]);
      // replaces_hash null means only if nothing was applied yet.
      expect((await refusal(apply(tx, file(), { replacesHash: null }))).details!.map((detail) => detail.code)).toEqual(["catalog_changed"]);

      const allowed = await apply(tx, changed, { allowUndeployed: true, replacesHash: first.run.hash });
      expect(allowed.run).toMatchObject({ status: "applied", prev_hash: first.run.hash, code_hash: deployedHash, hash: hashOf(changed) });
      expect(allowed.run.hash).not.toBe(allowed.run.code_hash);
      // With the changed file deployed, it applies without allow_undeployed, and the catalog matches the code.
      const deployedChange = { brand: "alloplace", codeHashes: { alloplace: hashOf(changed) } };
      expect((await apply(tx, changed, { allowUndeployed: false, deployment: deployedChange })).run.status).toBe("unchanged");
      expect(await getBillingCatalogForApi(context(tx), { deployment: deployedChange })).toMatchObject({ matches_code: true, code_hash: hashOf(changed) });
    });
  });

  it("shows in a dry run the changes and refusals an apply would make, writing nothing", async () => {
    await rollbackTest(async (tx) => {
      const empty = await apply(tx, file(), { dryRun: true, key: null });
      expect(empty).toMatchObject({ status: 200, replayed: false, run: { id: null, status: "preview", blocked_by: [], prev_hash: null, key_id: caller.platformKeyId } });
      expect(empty.run.changes).toHaveLength(8);
      expect(await count(tx, "billing_runs") + await count(tx, "billing_plans") + await count(tx, "billing_prices")).toBe(0);
      await apply(tx, file());
      const changed = file((value) => { withExamples("pro-plus")(value); value.plans.pro.included.voiceMinutes = 450; });
      const preview = await apply(tx, changed, { dryRun: true });
      const real = await apply(tx, changed);
      expect(preview.run.changes).toEqual(real.run.changes);
      expect(preview.run.changes.find((change) => change.key === "pro")).toMatchObject({ lowers_allowance: true });
      const blocked = await apply(tx, changed, { dryRun: true, deployment: { brand: "lobbystack" }, allowUndeployed: false });
      expect(blocked.run.blocked_by.map((item) => item.code)).toEqual(["brand_mismatch", "file_not_deployed"]);
      expect(await count(tx, "billing_runs")).toBe(2);
    });
  });

  it("lists runs newest first, a page at a time, of one kind or every kind", async () => {
    await rollbackTest(async (tx) => {
      const made: string[] = [];
      for (const units of [200, 210, 220]) made.push((await apply(tx, file((value) => { value.plans.pro.included.chatAiUnits = units; }))).run.id!);
      const first = await listBillingCatalogRunsForApi(context(tx), { limit: 2 });
      expect(first.data.map((run) => run.id)).toEqual([made[2], made[1]]);
      expect(first.has_more).toBe(true);
      const second = await listBillingCatalogRunsForApi(context(tx), { limit: 2, cursor: first.next_cursor! });
      expect(second).toMatchObject({ data: [{ id: made[0] }], has_more: false, next_cursor: null });
      expect((await listBillingCatalogRunsForApi(context(tx), { kind: "catalog" })).data).toHaveLength(3);
      expect((await listBillingCatalogRunsForApi(context(tx), { kind: "polar" })).data).toEqual([]);
      await expect(listBillingCatalogRunsForApi(context(tx), { kind: "other" })).rejects.toMatchObject({ status: 400, details: [{ path: "kind" }] });
    });
  });
});

describe.skipIf(!testUrl)("billing catalog tables", () => {
  it("keeps the constraints of migration 0108", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file(withExamples("pro-launch")));
      await as(tx, "owner");
      expect((await prices(tx, "pro")).map((row) => [row.period, row.cents, row.per_month])).toEqual([["annual", 96000, 8000], ["monthly", 10000, 10000]]);
      const check = async (statement: ReturnType<typeof sql>, constraint: string) => expect(await failure(tx, statement)).toEqual({ code: "23514", constraint });
      await check(sql`update public.billing_plans set names = ${JSON.stringify(names("Pro"))}::jsonb where code = 'pro'`, "billing_plans_standard");
      await check(sql`update public.billing_plans set access = 'code' where code = 'pro'`, "billing_plans_standard");
      await check(sql`update public.billing_plans set names = null where code = 'pro-launch'`, "billing_plans_standard");
      await check(sql`update public.billing_plans set voice_sec = 1 where code = 'enterprise'`, "billing_plans_custom");
      await check(sql`update public.billing_plans set sold = true where code = 'enterprise'`, "billing_plans_custom");
      await check(sql`update public.billing_plans set voice_rate = 1, sms_rate = 1, call_rate = 1 where code = 'free_cloud'`, "billing_plans_rates");
      await check(sql`update public.billing_plans set ends = null where code = 'pro-launch'`, "billing_plans_ends");
      await check(sql`update public.billing_plans set status = 'retired' where code = 'pro-launch'`, "billing_plans_retired");
      await check(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, key_id, partner, idem_key, req_hash) values ('catalog', 'passed', 'alloplace', 1, ${"a".repeat(64)}, '{}', ${randomUUID()}, 'p', 'k', ${"a".repeat(64)})`, "billing_runs_catalog_status");
      await check(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile) values ('catalog', 'applied', 'alloplace', 1, ${"a".repeat(64)}, '{}')`, "billing_runs_asked");
    });
  });

  it("keeps one live price per plan and period, milliseconds in run times, and one run per key", async () => {
    await rollbackTest(async (tx) => {
      const seeded = await apply(tx, file(), { key: "seed-1" });
      await as(tx, "owner");
      expect(await failure(tx, sql`insert into public.billing_prices (plan, period, currency, cents) values ('starter', 'monthly', 'usd', 2200)`)).toEqual({ code: "23505", constraint: "billing_prices_live_unique" });
      await tx.transaction(async (savepoint) => {
        await savepoint.execute(sql`update public.billing_prices set retired_at = now() where plan = 'starter' and period = 'monthly'`);
        await savepoint.execute(sql`insert into public.billing_prices (plan, period, currency, cents) values ('starter', 'monthly', 'usd', 2200)`);
      });
      expect(await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, key_id, partner, idem_key, req_hash, started_at) values ('catalog', 'applied', 'alloplace', 1, ${"a".repeat(64)}, '{}', ${randomUUID()}, 'p', 'k', ${"a".repeat(64)}, '2026-10-21 08:00:00.123456+00')`)).toMatchObject({ code: "23514" });
      expect(await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, polar_env, polar_org, key_id, partner, idem_key, req_hash) values ('polar', 'applied', 'alloplace', 1, ${"a".repeat(64)}, '{}', 'sandbox', 'org', ${caller.platformKeyId}, 'lobbystack', 'seed-1', ${"b".repeat(64)})`)).toEqual({ code: "23505", constraint: "billing_runs_idem_unique" });
      expect(await rows(tx, sql`select started_at = date_trunc('milliseconds', started_at) as whole from public.billing_runs where id = ${seeded.run.id}`)).toEqual([{ whole: true }]);
    });
  });

  it("lets the app read public plans and their prices only, the worker write only as the worker actor, and no role delete", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file(withExamples("pro-launch", "pro-plus")));
      await as(tx, "lobbystack_app");
      expect((await rows(tx, sql`select code from public.billing_plans order by code`)).map((row) => row.code)).toEqual(["free_cloud", "pro", "pro-plus", "starter"]);
      expect((await rows(tx, sql`select distinct plan from public.billing_prices order by plan`)).map((row) => row.plan)).toEqual(["pro", "pro-plus", "starter"]);
      expect(await failure(tx, sql`select * from public.billing_runs`)).toMatchObject({ code: "42501" });
      expect(await failure(tx, sql`update public.billing_plans set sort = 1 where code = 'pro'`)).toMatchObject({ code: "42501" });
      expect(await failure(tx, sql`insert into public.billing_prices (plan, period, currency, cents) values ('free_cloud', 'monthly', 'cad', 1)`)).toMatchObject({ code: "42501" });

      // The worker as another actor: inserts are refused and updates find nothing.
      await as(tx, "lobbystack_worker");
      await tx.transaction(async (savepoint) => {
        await savepoint.execute(sql`select set_config('app.actor_type', 'operator', true)`);
        expect(await failure(savepoint, sql`insert into public.billing_prices (plan, period, currency, cents) values ('free_cloud', 'monthly', 'cad', 1)`)).toMatchObject({ code: "42501" });
        expect((await savepoint.execute(sql`update public.billing_plans set sort = 1 where code = 'pro'`)).rowCount).toBe(0);
      });
      await as(tx, "lobbystack_readonly");
      expect(await count(tx, "billing_runs")).toBe(1);
      expect(await count(tx, "billing_plans")).toBe(6);
      for (const role of ["lobbystack_app", "lobbystack_worker", "lobbystack_readonly", "lobbystack_dispatcher"] as const) {
        await as(tx, role);
        for (const table of ["billing_prices", "billing_plans", "billing_runs"]) expect(await failure(tx, sql.raw(`delete from public.${table}`)), `${role} ${table}`).toMatchObject({ code: "42501" });
      }
    });
  });

  it("offers through billing_offers the active plans whose offer hasn't ended, as each role may see them", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file(withExamples("pro-launch", "salons-half-off", "pro-plus")));
      await byHand(tx, sql`update public.billing_plans set status = 'active' where code in ('starter', 'pro', 'pro-launch', 'salons-half-off')`);
      const offers = async () => (await rows(tx, sql`select distinct code from public.billing_offers order by code`)).map((row) => row.code);
      await as(tx, "lobbystack_app");
      expect(await offers()).toEqual(["free_cloud", "pro", "starter"]);
      await as(tx, "lobbystack_worker");
      expect(await offers()).toEqual(["enterprise", "free_cloud", "pro", "pro-launch", "salons-half-off", "starter"]);
      // Once its offer ends, a plan leaves the view with no query change.
      await byHand(tx, sql`update public.billing_plans set offer_end = now() - interval '1 second' where code = 'pro-launch'`);
      expect(await offers()).not.toContain("pro-launch");
      expect((await rows(tx, sql`select reloptions from pg_class where oid = 'public.billing_offers'::regclass`))[0]!.reloptions).toContain("security_invoker=true");
    });
  });

  it("answers each query of the design as written, as its role", async () => {
    await rollbackTest(async (tx) => {
      // Nine plans of every kind: public, code and hidden; draft, active, retired, and one whose offer ended.
      const fixture = (value: Record<string, any>) => {
        withExamples("pro-launch", "salons-half-off", "pro-plus")(value);
        value.plans["winter-2025"] = { tier: "starter", access: "code", names: names("Winter"), sold: true, prices: { monthlyCents: 2000 }, offerEndsAt: "2025-12-31T23:59:59-05:00" };
      };
      await apply(tx, file((value) => { fixture(value); value.plans["summer-2026"] = { tier: "starter", access: "code", names: names("Summer"), sold: true, prices: { monthlyCents: 2500 } }; }));
      await byHand(tx, sql`update public.billing_prices set polar_id = case when plan = 'pro-launch' then 'prod_launch_m' when plan = 'summer-2026' then 'prod_summer_m' else 'prod_' || plan || '_' || period end where plan <> 'pro-plus'`);
      await byHand(tx, sql`update public.billing_plans set status = 'active' where code <> 'pro-plus'`);
      const last = await apply(tx, file(fixture), { key: "fixture" });
      expect(actions(last.run)).toEqual(["retire summer-2026", "retire summer-2026/monthly/cad"]);
      await apply(tx, file(fixture), { key: "again" });

      const q1 = sql`SELECT code, tier, names, voice_sec, sms_seg, calls_out, chat_units, kb_bytes, numbers, period, currency, cents, per_month FROM billing_offers ORDER BY sort, code, period`;
      await as(tx, "lobbystack_app");
      expect((await rows(tx, q1)).map((row) => [row.code, row.period, row.cents, row.per_month])).toEqual([["free_cloud", null, null, null], ["starter", "annual", 28800, 2400], ["starter", "monthly", 3000, 3000], ["pro", "annual", 96000, 8000], ["pro", "monthly", 10000, 10000]]);
      const q3 = sql`SELECT polar_id, polar_disc, months, ends FROM billing_offers WHERE code = ${"pro-launch"} AND period = ${"monthly"}`;
      expect(await rows(tx, q3)).toEqual([]);

      await as(tx, "lobbystack_worker");
      expect((await rows(tx, q1)).map((row) => `${String(row.code)} ${String(row.period)}`)).toEqual(["free_cloud null", "starter annual", "starter monthly", "pro annual", "pro monthly", "enterprise null", "pro-launch monthly", "salons-half-off monthly"]);
      expect(await rows(tx, q3)).toEqual([{ polar_id: "prod_launch_m", polar_disc: null, months: 6, ends: "tier" }]);
      const q4 = sql`SELECT r.plan, r.period, p.tier FROM billing_prices r JOIN billing_plans p ON p.code = r.plan WHERE r.polar_id = ${"prod_summer_m"}`;
      expect(await rows(tx, q4)).toEqual([{ plan: "summer-2026", period: "monthly", tier: "starter" }]);
      const q5 = sql`SELECT tier, voice_sec, sms_seg, calls_out, chat_units, kb_bytes, numbers, overage, voice_rate, sms_rate, call_rate FROM billing_plans WHERE code = ${"pro-launch"}`;
      expect(await rows(tx, q5)).toEqual([{ tier: "pro", voice_sec: 36000, sms_seg: 200, calls_out: 100, chat_units: 200, kb_bytes: String(20 * 1024 * 1024), numbers: 1, overage: true, voice_rate: 18, sms_rate: 2, call_rate: 2 }]);
      const q6 = sql`SELECT id, hash, profile FROM billing_runs WHERE kind = 'catalog' ORDER BY started_at DESC, id DESC LIMIT 1`;
      const [latest] = await rows(tx, q6);
      expect(latest).toMatchObject({ hash: last.run.hash });
      expect(latest!.id).not.toBe(last.run.id);
      const q7 = sql`SELECT id, req_hash FROM billing_runs WHERE key_id = ${caller.platformKeyId} AND idem_key = ${"fixture"}`;
      expect((await rows(tx, q7)).map((row) => row.id)).toEqual([last.run.id]);
      const [cursor] = await rows(tx, sql`select started_at from public.billing_runs where id = ${String(latest!.id)}`);
      const q8 = sql`SELECT id, kind, status, hash, changes, started_at, ended_at FROM billing_runs WHERE kind = ${"catalog"} AND (started_at, id) < (${new Date(String(cursor!.started_at)).toISOString()}::timestamptz, ${String(latest!.id)}::uuid) ORDER BY started_at DESC, id DESC LIMIT ${10}`;
      expect((await rows(tx, q8)).map((row) => row.id)).toEqual([last.run.id, expect.any(String)]);
      expect(await rows(tx, sql`SELECT * FROM billing_plans ORDER BY sort, code`)).toHaveLength(9);
      const q9 = await rows(tx, sql`SELECT * FROM billing_prices ORDER BY plan, period, retired_at NULLS FIRST`);
      expect(q9).toHaveLength(10);
      expect(q9.filter((row) => row.retired_at !== null).map((row) => row.plan)).toEqual(["summer-2026"]);
      const q10 = sql`SELECT plan, period FROM billing_prices WHERE retired_at IS NULL AND polar_id IS NULL ORDER BY period`;
      expect(await rows(tx, q10)).toEqual([{ plan: "pro-plus", period: "annual" }, { plan: "pro-plus", period: "monthly" }]);
    });
  });

  it("opens a read-only transaction when asked, so a dry run can write nothing", async () => {
    const error = await withBusinessTransaction(client!.db, { actorType: "worker" }, async (tx) => { await tx.execute(sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile) values ('verify', 'passed', 'x', 1, ${"a".repeat(64)}, '{}')`); }, { accessMode: "read only" }).then(() => null, (failed: unknown) => failed as { code?: string; cause?: { code?: string } });
    expect(error?.cause?.code ?? error?.code).toBe("25006");
  });
});

describe.skipIf(!testUrl)("billing catalog applies at the same time", () => {
  // Committed, so the two can run on two connections; the rows they wrote are removed after.
  it("runs two applies one after the other, the second recording the first's hash", async () => {
    const db = client!.db;
    const before = (await db.execute<Row>(sql`select count(*) as n from public.billing_runs`)).rows[0]!.n;
    if (Number(before) !== 0) throw new Error("This test needs empty billing tables.");
    const runs: string[] = [];
    try {
      const results = await Promise.all([
        applyBillingCatalogForApi({ db }, { caller, idempotencyKey: randomUUID(), body: apiBillingCatalogApplySchema.parse({ brand: "alloplace", billing_file: file() }), deployment: deployed }),
        applyBillingCatalogForApi({ db }, { caller, idempotencyKey: randomUUID(), body: apiBillingCatalogApplySchema.parse({ brand: "alloplace", billing_file: file((value) => { value.polar.portalPlanChanges = false; }), allow_undeployed: true }), deployment: deployed }),
      ]);
      runs.push(...results.map((result) => result.run.id!));
      const [first, second] = [...results].sort((a, b) => (a.run.started_at < b.run.started_at ? -1 : 1)).map((result) => result.run);
      expect(first!.prev_hash).toBeNull();
      expect(first!.changes).toHaveLength(8);
      expect(second).toMatchObject({ prev_hash: first!.hash, status: "applied", changes: [] });
      expect((await listBillingCatalogRunsForApi({ db }, {})).data.map((run) => run.id)).toEqual([second!.id, first!.id]);
      expect((await getBillingCatalogForApi({ db }, { deployment: deployed })).last_run!.id).toBe(second!.id);
    } finally {
      await db.execute(sql`delete from public.billing_prices`);
      await db.execute(sql`delete from public.billing_plans`);
      if (runs.length) await db.execute(sql`delete from public.billing_runs where id = any(${`{${runs.join(",")}}`}::uuid[])`);
    }
  });
});
