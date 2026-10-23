import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingAccounts, billingUsageEvents, businesses, createDatabaseClient, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { apiBillingCatalogApplySchema, apiBillingCatalogLinkSchema, billingProfileHash, billingProfileSchema, builtInBillingPlanLimits, canonicalBillingProfileJson, type ApiBillingCatalogRun } from "@lobbystack/shared";

import { PolarCatalogClient } from "../../../providers/src/polar/polarCatalog";
import { getBillingUsageStatus, getWebVoiceBillingAllowance } from "./billing";
import { applyBillingCatalogForApi, billingDeploymentPolar, desiredBillingPlans, getBillingCatalogForApi, linkBillingCatalogForApi, listBillingCatalogRunsForApi, loadPlanChangeProration, recordBillingVerifyRun, type BillingCatalogDeployment } from "./billingCatalog";
import { billingPlanList, listBillingPlansForApi, loadBillingCatalog, readBillingPlanLimits, readPolarProductLinks } from "./billingPlans";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans, runPolarSteps } from "./billingPolar";
import { createFakePolar, type FakePolar } from "./billingPolar.testing";
import { runDailyBillingVerify } from "./billingVerify";
import { NumberSelectionError, numberMarketInTransaction } from "./phoneNumbers";
import { PublicApiError } from "./publicApi/errors";
import { loadBusinessPlanLimits, periodKeyFor } from "./usage";

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
      // Before any apply, a plan change charges as the shipped files say.
      expect(await loadPlanChangeProration(context(tx))).toEqual({ upgrade: "invoice", downgrade: "next_period" });
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
      // After one, as the latest file says.
      await apply(tx, file((value) => { value.polar.upgradeProration = "prorate"; }));
      expect(await loadPlanChangeProration(context(tx))).toEqual({ upgrade: "prorate", downgrade: "next_period" });
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

// Polar's side for the link tests: a stand-in organization the file was applied to.
const polarEnv = { APP_BASE_URL: "https://demo.alloplace.com", POLAR_API_BASE_URL: "https://sandbox-api.polar.sh", POLAR_ORGANIZATION_ID: "org_test" };
const polarClient = (fake: FakePolar) => new PolarCatalogClient({ token: "polar_oat_test", baseUrl: "https://sandbox-api.polar.sh", fetch: fake.fetch, sleep: async () => undefined });

/** Sets a fresh Polar stand-in up from a file, as pnpm billing apply does, and returns it with the link it would send. */
async function seededPolar(billingFile: Record<string, any>) {
  const fake = createFakePolar();
  const profile = billingProfileSchema.parse(billingFile);
  const plans = desiredBillingPlans(profile);
  const catalog = desiredPolarCatalog({ brand: "alloplace", profile, plans, webhookUrl: `${polarEnv.APP_BASE_URL}/api/webhooks/polar` });
  const planned = planPolarChanges({ catalog, snapshot: await polarClient(fake).readSnapshot(), options: { adopt: false, allowReplace: false, allowArchive: false, allowLess: false } });
  await runPolarSteps(polarClient(fake), planned.steps);
  const links = polarLinkPlans({ catalog, plans, snapshot: await polarClient(fake).readSnapshot() });
  return { fake, plans: links.plans };
}

/** The deployment with Polar settings: the stand-in's organization and the product variables a link sets. */
function polarDeployment(extra: Record<string, string> = {}): BillingCatalogDeployment {
  return { brand: "alloplace", polar: billingDeploymentPolar({ ...polarEnv, ...extra }) };
}

async function link(tx: DatabaseTransaction, body: Record<string, unknown>, options: { key?: string | null; deployment?: BillingCatalogDeployment } = {}) {
  const parsed = apiBillingCatalogLinkSchema.parse({ brand: "alloplace", polar_env: "sandbox", polar_org: "org_test", ...body });
  return await linkBillingCatalogForApi(context(tx), { caller, idempotencyKey: options.key === undefined ? randomUUID() : options.key, body: parsed, deployment: options.deployment ?? polarDeployment() });
}

describe.skipIf(!testUrl)("billing catalog Polar links", () => {
  it("refuses a link before an apply, for another brand, file or organization, or without POLAR_ORGANIZATION_ID, listing every reason and writing nothing", async () => {
    await rollbackTest(async (tx) => {
      const { plans } = await seededPolar(file());
      const early = await refusal(link(tx, { hash: deployedHash, plans }));
      expect(early).toMatchObject({ status: 409, code: "conflict" });
      expect(early.details!.map((detail) => `${detail.code} ${detail.message}`)).toEqual(["catalog_changed Nothing was applied yet. Apply the file before linking Polar to it.", "unknown_price There's no plan starter.", "unknown_price There's no plan pro."]);

      await apply(tx, file());
      const wrong = await refusal(link(tx, { brand: "cadre", hash: "b".repeat(64), polar_org: "org_other", plans }));
      expect(wrong.details!.map((detail) => `${detail.code} ${detail.path}`)).toEqual(["brand_mismatch brand", "catalog_changed hash", "polar_org_mismatch polar_org"]);
      const unset = await refusal(link(tx, { hash: deployedHash, plans }, { deployment: { brand: "alloplace", polar: billingDeploymentPolar({}) } }));
      expect(unset.details!.map((detail) => detail.code)).toEqual(["polar_org_mismatch"]);
      expect(unset.details![0]!.message).toContain("POLAR_ORGANIZATION_ID isn't set");
      const production = await refusal(link(tx, { hash: deployedHash, plans, polar_env: "production" }));
      expect(production.details!.map((detail) => `${detail.code} ${detail.path}`)).toEqual(["polar_org_mismatch polar_env"]);

      const preview = await link(tx, { hash: deployedHash, plans, polar_org: "org_other", dry_run: true }, { key: null });
      expect(preview).toMatchObject({ status: 200, run: { id: null, status: "preview", kind: "polar" } });
      expect(preview.run.blocked_by.map((item) => item.code)).toEqual(["polar_org_mismatch"]);
      expect(preview.run.changes).toHaveLength(6);
      expect(await count(tx, "billing_runs")).toBe(1);
      expect((await rows(tx, sql`select count(*) as n from public.billing_prices where polar_id is not null`))[0]!.n).toBe("0");
    });
  });

  it("links every sold price, makes the sold plans active, and records unchanged for the same products, with key replays", async () => {
    await rollbackTest(async (tx) => {
      const applied = await apply(tx, file());
      const { plans } = await seededPolar(file());
      const first = await link(tx, { hash: deployedHash, plans }, { key: "link-1" });
      expect(first).toMatchObject({ status: 201, replayed: false, run: { kind: "polar", status: "applied", hash: deployedHash, prev_hash: null, polar_env: "sandbox", polar_org: "org_test", key_id: caller.platformKeyId, problems: [] } });
      expect(actions(first.run)).toEqual(["update pro", "update starter", "update pro/annual/cad", "update pro/monthly/cad", "update starter/annual/cad", "update starter/monthly/cad"]);
      expect(Object.fromEntries((await rows(tx, sql`select code, status from public.billing_plans`)).map((row) => [row.code, row.status]))).toEqual({ free_cloud: "active", starter: "active", pro: "active", enterprise: "active" });
      const linkedIds = (await rows(tx, sql`select polar_id from public.billing_prices order by polar_id`)).map((row) => row.polar_id);
      expect(linkedIds).toEqual(plans.flatMap((plan) => plan.prices.map((price) => price.polar_id)).sort());
      // The rows a link changes carry its run; the rest keep the apply's.
      expect((await rows(tx, sql`select distinct run_id from public.billing_prices`)).map((row) => row.run_id)).toEqual([first.run.id]);
      expect((await plan(tx, "free_cloud")).run_id).toBe(applied.run.id);

      expect(await link(tx, { hash: deployedHash, plans }, { key: "link-1" })).toEqual({ ...first, replayed: true });
      expect(await refusal(link(tx, { hash: deployedHash, plans, replace_ids: true }, { key: "link-1" }))).toMatchObject({ status: 422, code: "idempotency_key_reused" });
      expect(await refusal(link(tx, { hash: deployedHash, plans }, { key: null }))).toMatchObject({ status: 400, details: [{ path: "Idempotency-Key" }] });
      const again = await link(tx, { hash: deployedHash, plans });
      expect(again.run).toMatchObject({ status: "unchanged", changes: [], prev_hash: deployedHash });

      const catalog = await getBillingCatalogForApi(context(tx), { deployment: polarDeployment({ POLAR_WEBHOOK_SECRET: "polar_whs_x" }) });
      expect(catalog.polar).toMatchObject({ env: "sandbox", org: "org_test", secret_sha256: createHash("sha256").update("polar_whs_x").digest("hex"), last_link: { id: again.run.id } });
      expect(catalog.plans.find((entry) => entry.code === "pro")!.prices.every((price) => price.polar_id !== null)).toBe(true);
      expect((await listBillingCatalogRunsForApi(context(tx), { kind: "polar" })).data.map((run) => run.id)).toEqual([again.run.id, first.run.id]);
    });
  });

  it("refuses a new product for a linked price unless replace_ids, which retires the row with its product and keeps the cents", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file());
      const { plans } = await seededPolar(file());
      await link(tx, { hash: deployedHash, plans });
      const [before] = (await prices(tx, "pro")).filter((row) => row.period === "monthly");
      const swapped = structuredClone(plans);
      swapped.find((entry) => entry.code === "pro")!.prices.find((price) => price.period === "monthly")!.polar_id = "product_new";
      expect((await refusal(link(tx, { hash: deployedHash, plans: swapped }))).details).toEqual([expect.objectContaining({ code: "id_changed" })]);
      const replaced = await link(tx, { hash: deployedHash, plans: swapped, replace_ids: true });
      expect(actions(replaced.run)).toEqual(["retire pro/monthly/cad", "insert pro/monthly/cad"]);
      const after = (await prices(tx, "pro")).filter((row) => row.period === "monthly");
      expect(after.map((row) => [row.cents, row.polar_id, row.retired_at === null])).toEqual([[10000, "product_new", true], [10000, before!.polar_id, false]]);
      expect(after[1]!.id).toBe(before!.id);
      // The old product can't be linked again: it stays with its retired row.
      expect((await refusal(link(tx, { hash: deployedHash, plans, replace_ids: true }))).details).toEqual([expect.objectContaining({ code: "id_taken", message: expect.stringContaining("a retired price") })]);
    });
  });

  it("keeps a deployment with the Polar organization it was first linked to", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file());
      const { plans } = await seededPolar(file());
      await link(tx, { hash: deployedHash, plans });
      const moved = polarDeployment({ POLAR_ORGANIZATION_ID: "org_live", POLAR_API_BASE_URL: "https://api.polar.sh" });
      const error = await refusal(link(tx, { hash: deployedHash, plans, polar_env: "production", polar_org: "org_live" }, { deployment: moved }));
      expect(error.details!.map((detail) => detail.code)).toEqual(["polar_org_changed"]);
      expect(error.details![0]!.message).toContain("Live payments get a deployment of their own.");
    });
  });
});

describe.skipIf(!testUrl)("billing catalog at run time", () => {
  const sells = { POLAR_ACCESS_TOKEN: "polar_oat_x", POLAR_ORGANIZATION_ID: "org_test", POLAR_PRO_MONTHLY_PRODUCT_ID: "var_pro_month" };

  it("shows the built-in plans and sells through the variables until an apply, then the file's plans in its currency, linked products once linked", async () => {
    await rollbackTest(async (tx) => {
      const before = await listBillingPlansForApi(context(tx), sells);
      expect(before).toMatchObject({ currency: "usd", source: "built_in" });
      expect(before.plans.find((plan) => plan.slug === "pro")!.prices.map((price) => [price.interval, price.amount_cents, price.checkout_available])).toEqual([["monthly", 10_000, true], ["annual", 96_000, false]]);
      expect((await readPolarProductLinks(context(tx), sells)).planFor("var_pro_month")).toEqual({ plan: "pro", interval: "monthly", code: "pro" });

      await apply(tx, file());
      // Applied, not linked: the file's numbers in CAD, still sold through the variables.
      const applied = await listBillingPlansForApi(context(tx), sells);
      expect(applied).toMatchObject({ currency: "cad", source: "catalog" });
      expect(applied.plans.map((plan) => plan.slug)).toEqual(["free_cloud", "starter", "pro", "enterprise"]);
      const pro = applied.plans.find((plan) => plan.slug === "pro")!;
      expect(pro).toMatchObject({ custom: false, overage_billable: true, included: { voice_seconds: 30_000, alert_sms_segments: 200, business_numbers: 1, knowledge_storage_bytes: 20 * 1024 * 1024 }, overage_rates: { voice_minute_cents: 18 } });
      expect(pro.prices.map((price) => [price.interval, price.currency, price.amount_cents, price.monthly_amount_cents, price.checkout_available])).toEqual([["monthly", "cad", 10_000, 10_000, true], ["annual", "cad", 96_000, 8_000, false]]);
      expect(applied.plans.find((plan) => plan.slug === "enterprise")).toMatchObject({ custom: true, prices: [] });

      const { plans } = await seededPolar(file());
      await link(tx, { hash: deployedHash, plans });
      const linked = new Map(plans.flatMap((plan) => plan.prices.map((price) => [`${plan.code}/${price.period}`, price.polar_id])));
      const links = await readPolarProductLinks(context(tx), sells);
      expect(links.productFor("pro", "annual")).toBe(linked.get("pro/annual"));
      expect(links.productFor("pro", "monthly")).toBe(linked.get("pro/monthly"));
      expect(links.planFor(linked.get("starter/annual"))).toEqual({ plan: "starter", interval: "annual", code: "starter" });
      expect((await listBillingPlansForApi(context(tx), sells)).plans.flatMap((plan) => plan.prices.map((price) => price.checkout_available))).toEqual([true, true, true, true]);
      // Without Polar's token nothing sells, linked or not.
      expect((await listBillingPlansForApi(context(tx), { POLAR_ORGANIZATION_ID: "org_test" })).plans.flatMap((plan) => plan.prices.map((price) => price.checkout_available))).toEqual([false, false, false, false]);
    });
  });

  it("lets the app read the public standard plans and their links, with hidden Enterprise kept to its built-in terms", async () => {
    await rollbackTest(async (tx) => {
      await apply(tx, file());
      const { plans } = await seededPolar(file());
      await link(tx, { hash: deployedHash, plans });
      await as(tx, "lobbystack_app");
      const { catalog, links } = await loadBillingCatalog(tx, {});
      expect(catalog.plans.map((plan) => plan.code)).toEqual(["free_cloud", "starter", "pro"]);
      const list = billingPlanList(catalog, { checkout: true, links });
      expect(list).toMatchObject({ currency: "cad", source: "catalog" });
      expect(list.plans.find((plan) => plan.slug === "enterprise")).toMatchObject({ custom: true, prices: [], sortOrder: 30 });
      expect(list.plans.find((plan) => plan.slug === "starter")!.prices.every((price) => price.checkoutAvailable)).toBe(true);
    });
  });
});

describe.skipIf(!testUrl)("billing catalog limits", () => {
  // The business's limits and number gate, read as the worker in the business's scope.
  const inBusiness = <T>(tx: DatabaseTransaction, businessId: string, run: (scoped: DatabaseTransaction) => Promise<T>) => withBusinessTransaction(tx as unknown as Database, { businessId, actorType: "worker" }, run);
  const numberRefusal = async (tx: DatabaseTransaction, businessId: string) => {
    try {
      await inBusiness(tx, businessId, (scoped) => numberMarketInTransaction(scoped, { businessId, purpose: "onboarding", selection: { countryCode: "CA" }, enforceStage: false }));
      return null;
    } catch (error) {
      if (error instanceof NumberSelectionError) return error.reason;
      throw error;
    }
  };

  it("enforces an applied file's allowances, rates, storage limit and numbers, as the worker and as the app", async () => {
    await rollbackTest(async (tx) => {
      const businessId = randomUUID();
      await as(tx, "owner");
      await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Catalog limits test", timezone: "UTC", businessType: "test" });
      // Twenty of the free plan's thirty minutes are used.
      await tx.insert(billingUsageEvents).values({ businessId, periodKey: periodKeyFor(), sourceKey: `voice:${randomUUID()}`, usageKind: "voice_seconds", quantity: 1_200, planAtRecordTime: "free_cloud", syncStatus: "skipped" });
      await as(tx, "lobbystack_worker");

      // Before an apply, this build's limits.
      expect(await readBillingPlanLimits(tx)).toBe(builtInBillingPlanLimits);
      expect(await getWebVoiceBillingAllowance(context(tx), { businessId })).toMatchObject({ allowed: true, maxDurationMs: 600_000 });
      expect(await numberRefusal(tx, businessId)).toBe("paid_plan_required");

      await apply(tx, file((value) => {
        value.plans.free_cloud.included.voiceMinutes = 20;
        value.plans.free_cloud.limits = { knowledgeStorageMb: 2, businessNumbers: 1 };
        value.plans.starter.overageCents.voiceMinute = 30;
      }));
      const worker = await readBillingPlanLimits(tx);
      expect(worker.free_cloud).toMatchObject({ voiceSecondsIncluded: 1_200, knowledgeStorageBytes: 2 * 1_048_576, includedBusinessNumbers: 1, overagesBillable: false });
      expect(worker.starter).toMatchObject({ voiceSecondsIncluded: 9_000, voiceOverageRatePerMinuteCents: 30 });
      // Enterprise's custom row means what this build's Enterprise does, which the app keeps.
      expect(worker.enterprise).toEqual(builtInBillingPlanLimits.enterprise);
      // The free plan's twenty minutes are used up, so the website call is refused.
      expect(await getWebVoiceBillingAllowance(context(tx), { businessId })).toEqual({ allowed: false, errorCode: "voice_limit_reached", maxDurationMs: 0, plan: "free_cloud" });
      expect(await getBillingUsageStatus(context(tx), { businessId })).toMatchObject({ voiceSecondsIncluded: 1_200, voiceBlocked: true, overagesBillable: false });
      // The free plan now includes a number and twice the storage.
      expect(await numberRefusal(tx, businessId)).toBeNull();
      expect((await inBusiness(tx, businessId, (scoped) => loadBusinessPlanLimits(scoped, businessId))).limits.knowledgeStorageBytes).toBe(2 * 1_048_576);

      await as(tx, "lobbystack_app");
      expect(await readBillingPlanLimits(tx)).toEqual(worker);
    });
  });
  it("lets the number claims count the numbers a plan includes, as the limits do, instead of its name", async () => {
    await rollbackTest(async (tx) => {
      const businessId = randomUUID();
      await as(tx, "owner");
      await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Number allowance test", timezone: "UTC", businessType: "test" });
      // What the claim functions ask, beside what the dashboard's limits say.
      const included = async () => {
        await as(tx, "owner");
        const [row] = await rows(tx, sql`select app.business_included_numbers(${businessId}::uuid) as n`);
        await as(tx, "lobbystack_worker");
        const limits = (await inBusiness(tx, businessId, (scoped) => loadBusinessPlanLimits(scoped, businessId))).limits.includedBusinessNumbers;
        expect(row!.n).toBe(limits);
        return row!.n;
      };
      const account = async (values: Partial<typeof billingAccounts.$inferInsert>) => {
        await as(tx, "owner");
        await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "free_cloud", ...values }).onConflictDoUpdate({ target: billingAccounts.businessId, set: values });
        await as(tx, "lobbystack_worker");
      };

      // Before an apply, this build's plans: none on Free, one on a live Starter, no limit on Enterprise.
      expect(await included()).toBe(0);
      await account({ plan: "starter", subscriptionState: "active" });
      expect(await included()).toBe(1);
      await account({ subscriptionState: "canceled" });
      expect(await included()).toBe(0);
      await account({ plan: "enterprise", subscriptionState: "active" });
      expect(await included()).toBeNull();

      await apply(tx, file((value) => {
        withExamples("salons-half-off")(value);
        value.plans.free_cloud.limits = { knowledgeStorageMb: 1, businessNumbers: 1 };
        value.plans["salons-half-off"].limits = { businessNumbers: 0 };
      }));
      // The catalog's numbers, whatever the plan is called.
      await account({ plan: "free_cloud", subscriptionState: null });
      expect(await included()).toBe(1);
      await account({ plan: "starter", subscriptionState: "active" });
      expect(await included()).toBe(1);
      // A promo plan's own row while its subscription is live; a lapsed one is Free.
      await account({ planCode: "salons-half-off" });
      expect(await included()).toBe(0);
      await account({ subscriptionState: "canceled" });
      expect(await included()).toBe(1);

      // The three claim functions all ask it.
      await as(tx, "owner");
      const callers = await rows(tx, sql`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.prosrc like '%business_included_numbers%' order by p.proname`);
      expect(callers.map((row) => row.proname)).toEqual(["reserve_api_number_claim", "reserve_onboarding_number_claim", "reserve_replacement_number_claim"]);
    });
  });
});

describe.skipIf(!testUrl)("billing catalog daily check", () => {
  it("skips until the deployment has a Polar organization and a link, then stores a verify run without a key", async () => {
    await rollbackTest(async (tx) => {
      const unused = async () => { throw new Error("Polar wasn't to be read."); };
      expect(await runDailyBillingVerify(context(tx), { brand: "alloplace", env: {}, readPolar: unused })).toEqual({ status: "skipped", reason: "POLAR_ORGANIZATION_ID isn't set" });
      await apply(tx, file());
      expect(await runDailyBillingVerify(context(tx), { brand: "alloplace", env: polarEnv, readPolar: unused })).toEqual({ status: "skipped", reason: "nothing was linked yet" });

      const { fake, plans } = await seededPolar(file());
      await link(tx, { hash: deployedHash, plans });
      // No product ID variables: a linked deployment doesn't need them.
      const env = polarEnv;
      const readPolar = () => polarClient(fake).readSnapshot();
      const passed = await runDailyBillingVerify(context(tx), { brand: "alloplace", env, readPolar });
      expect(passed).toMatchObject({ status: "passed", previousStatus: null, problems: [], polarEnv: "sandbox" });
      const [stored] = await rows(tx, sql`select * from public.billing_runs where id = ${passed.status === "skipped" ? null : passed.runId}::uuid`);
      expect(stored).toMatchObject({ kind: "verify", status: "passed", hash: deployedHash, code_hash: deployedHash, key_id: null, idem_key: null, partner: null, polar_env: "sandbox", polar_org: "org_test", profile: {} });

      fake.state.products.find((product) => product.name === "Pro monthly")!.prices.find((price) => price.amount_type === "fixed")!.price_amount = 12000;
      const drift = await runDailyBillingVerify(context(tx), { brand: "alloplace", env, readPolar });
      expect(drift).toMatchObject({ status: "drift", previousStatus: "passed" });
      expect(drift.status !== "skipped" && drift.problems.map((problem) => `${problem.pair} ${problem.code}`)).toEqual(["file_polar product", "postgres_polar linked_id"]);

      const failed = await runDailyBillingVerify(context(tx), { brand: "alloplace", env, readPolar: async () => { throw new Error("Polar answered 401 to GET /v1/organizations/"); } });
      expect(failed).toMatchObject({ status: "failed", previousStatus: "drift", problems: [{ code: "unreadable", message: "Polar answered 401 to GET /v1/organizations/" }] });
      const verifies = (await listBillingCatalogRunsForApi(context(tx), { kind: "verify" })).data;
      expect(verifies.map((run) => run.status)).toEqual(["failed", "drift", "passed"]);
      expect(verifies[1]!.problems).toHaveLength(2);
      expect(verifies[0]!.prev_hash).toBe(deployedHash);
    });
  });

  it("records a verify run as the worker with no key, and returns the status before it", async () => {
    await rollbackTest(async (tx) => {
      const first = await recordBillingVerifyRun(context(tx), { catalog: { brand: "alloplace", ver: 1, hash: deployedHash }, codeHash: null, status: "drift", problems: [{ code: "catalog_hash", pair: "file_postgres", level: "drift", subject: "catalog", message: "x" }], polarEnv: "sandbox", polarOrg: "org_test" });
      expect(first).toMatchObject({ previousStatus: null, run: { kind: "verify", status: "drift", key_id: null, prev_hash: null, problems: [{ code: "catalog_hash" }] } });
      const second = await recordBillingVerifyRun(context(tx), { catalog: { brand: "alloplace", ver: 1, hash: deployedHash }, codeHash: null, status: "passed", problems: [], polarEnv: "sandbox", polarOrg: "org_test" });
      expect(second.previousStatus).toBe("drift");
      expect(second.run.started_at > first.run.started_at).toBe(true);
      await as(tx, "lobbystack_app");
      expect((await failure(tx, sql`insert into public.billing_runs (kind, status, brand, ver, hash, profile, polar_env, polar_org) values ('verify', 'passed', 'alloplace', 1, ${deployedHash}, '{}', 'sandbox', 'org_test')`)).code).toBe("42501");
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
