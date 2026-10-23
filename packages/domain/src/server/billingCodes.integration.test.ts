import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, providerEvents, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { apiBillingCatalogApplySchema, apiBillingCatalogLinkSchema, apiBillingCodeCreateSchema, billingProfileSchema } from "@lobbystack/shared";

import { PolarCatalogClient } from "../../../providers/src/polar/polarCatalog";
import { createBillingCheckoutRequest, loadBillingCheckoutRequest, reconcileBillingProviderEvent } from "./billing";
import { applyBillingCatalogForApi, billingDeploymentPolar, desiredBillingPlans, linkBillingCatalogForApi } from "./billingCatalog";
import { billingCodeView, createBillingCodeForApi, findBillingCodeOffer, listBillingCodesForApi, loadBusinessPromoPlan, revokeBillingCodeForApi } from "./billingCodes";
import { readBillingPlanLimitBook, readPolarProductLinks } from "./billingPlans";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans, runPolarSteps } from "./billingPolar";
import { createFakePolar } from "./billingPolar.testing";
import { loadPromoEndWork, recordPromoEnd } from "./billingPromoEnd";
import { createCheckoutForApi, endPromoPlanForApi, getBillingForApi, getOnboardingForApi } from "./publicApi/operations";
import { createBusiness } from "./tenancy";
import { getUsageStatusInTransaction, loadBusinessPlanLimits, readUsageStatusInTransaction, reserveUsageInTransaction } from "./usage";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Promo code integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

type Row = Record<string, unknown>;
type Role = "lobbystack_app" | "lobbystack_worker" | "owner";

// Each test runs in a transaction it rolls back, after emptying the catalog in it.
async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      await tx.execute(sql`reset role`);
      // The lock every catalog apply and link takes: the catalog test that commits its
      // applies can't add or delete rows while this one reads the tables.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('lobbystack.billing_catalog'))`);
      await tx.execute(sql`delete from public.billing_codes`);
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

async function as(tx: DatabaseTransaction, role: Role) {
  await tx.execute(sql.raw(role === "owner" ? "reset role" : `set local role ${role}`));
}

async function rows(tx: DatabaseTransaction, query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await tx.execute<Row>(query)).rows;
}

/** What a call threw. */
async function thrown(promise: Promise<unknown>): Promise<Error & { status?: number; code?: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("The call went through.");
}

/** The statement's error code, run in a savepoint so the test's transaction carries on. */
async function failure(tx: DatabaseTransaction, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await tx.transaction(async (savepoint) => { await savepoint.execute(statement); });
  } catch (error) {
    return ((error as { cause?: { code?: string } }).cause ?? (error as { code?: string })).code;
  }
  throw new Error("The statement went through.");
}

const names = (en: string) => ({ en, fr: en, es: en, sr: en });
const caller = { platformKeyId: randomUUID(), partnerId: "lobbystack" };
const context = (tx: DatabaseTransaction) => ({ db: tx as unknown as Database });
const baseUrl = "https://demo.alloplace.com/";
const polarEnv = { APP_BASE_URL: "https://demo.alloplace.com", POLAR_API_BASE_URL: "https://sandbox-api.polar.sh", POLAR_ORGANIZATION_ID: "org_test" };

/** The AlloPlace file with two promo plans: half off Starter for three months, and a six-month Pro launch plan. */
function promoFile(): Record<string, any> {
  const value = JSON.parse(readFileSync(new URL("../../../../brands/alloplace/billing.json", import.meta.url), "utf8")) as Record<string, any>;
  value.plans["salons-half-off"] = { tier: "starter", access: "code", names: names("Salon offer"), sold: true, prices: { monthlyCents: 3000 }, discount: { type: "percentage", basisPoints: 5000, duration: "repeating", durationInMonths: 3 } };
  value.plans["pro-launch"] = { tier: "pro", access: "code", names: names("Pro launch offer"), sold: true, prices: { monthlyCents: 6000 }, months: 6, endsWith: "tier" };
  return value;
}

/** The promo file and a Starter plan with its own allowances: 300 minutes, 10 MB and 25 cents a minute over. */
function allowanceFile(): Record<string, any> {
  const value = promoFile();
  value.plans["salons-plus"] = { tier: "starter", access: "code", names: names("Salons Plus"), sold: true, prices: { monthlyCents: 3000 }, included: { voiceMinutes: 300 }, limits: { knowledgeStorageMb: 10 }, overageCents: { voiceMinute: 25 } };
  return value;
}

/** Applies the promo file, sets a Polar stand-in up from it as pnpm billing apply does, and links the two. */
async function promoCatalog(tx: DatabaseTransaction, value = promoFile()): Promise<void> {
  const applied = await applyBillingCatalogForApi(context(tx), { caller, idempotencyKey: randomUUID(), body: apiBillingCatalogApplySchema.parse({ brand: "alloplace", billing_file: value, allow_undeployed: true }), deployment: { brand: "alloplace" } });
  const fake = createFakePolar();
  const polar = new PolarCatalogClient({ token: "polar_oat_test", baseUrl: polarEnv.POLAR_API_BASE_URL, fetch: fake.fetch, sleep: async () => undefined });
  const profile = billingProfileSchema.parse(value);
  const plans = desiredBillingPlans(profile);
  const catalog = desiredPolarCatalog({ brand: "alloplace", profile, plans, webhookUrl: `${polarEnv.APP_BASE_URL}/api/webhooks/polar` });
  await runPolarSteps(polar, planPolarChanges({ catalog, snapshot: await polar.readSnapshot(), options: { adopt: false, allowReplace: false, allowArchive: false } }).steps);
  const links = polarLinkPlans({ catalog, plans, snapshot: await polar.readSnapshot() });
  const body = apiBillingCatalogLinkSchema.parse({ brand: "alloplace", polar_env: "sandbox", polar_org: "org_test", hash: applied.run.hash, plans: links.plans });
  await linkBillingCatalogForApi(context(tx), { caller, idempotencyKey: randomUUID(), body, deployment: { brand: "alloplace", polar: billingDeploymentPolar(polarEnv) } });
}

/** A business and its owner's account, made as the dashboard makes them. Returns to the worker. */
async function ownedBusiness(tx: DatabaseTransaction, label: string): Promise<{ userId: string; businessId: string }> {
  await as(tx, "owner");
  const userId = randomUUID();
  const email = `promo-${label}-${userId}@example.invalid`;
  await tx.insert(users).values({ id: userId, email, normalizedEmail: email, name: label });
  await as(tx, "lobbystack_app");
  const { businessId } = await createBusiness(context(tx), { userId, name: `Promo ${label}`, timezone: "UTC", businessType: "test" });
  await as(tx, "lobbystack_worker");
  return { userId, businessId };
}

const issue = (tx: DatabaseTransaction, body: Record<string, unknown>, key: string | null = null) =>
  createBillingCodeForApi(context(tx), { caller, idempotencyKey: key, body: apiBillingCodeCreateSchema.parse(body), brandName: "AlloPlace", baseUrl });

/** The offer a code unlocks, looked up in one business's scope as whichever role the transaction has. */
const offerFor = (tx: DatabaseTransaction, businessId: string, code: string) =>
  withBusinessTransaction(tx as unknown as Database, { businessId, actorType: "operator" }, (scoped) => findBillingCodeOffer(scoped, code));

const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

describe.skipIf(!testUrl)("billing promo codes", () => {
  it("issues made-up and chosen codes with key replays, lists them a page at a time, and revokes one", async () => {
    await rollbackTest(async (tx) => {
      await promoCatalog(tx);
      const ends = inAWeek();
      const made = await issue(tx, { plan: "salons-half-off", max_uses: 2, expires_at: ends, note: "Salon fair" }, "code-1");
      expect(made.replayed).toBe(false);
      expect(made.code).toMatchObject({ plan: "salons-half-off", business_id: null, max_uses: 2, uses: 0, status: "active", note: "Salon fair", key_id: caller.platformKeyId, partner: "lobbystack", revoked_at: null });
      expect(made.code.code).toMatch(/^ALLO-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
      expect(made.code.link).toBe(`https://demo.alloplace.com/signup?promo=${made.code.code}`);
      expect(await issue(tx, { plan: "salons-half-off", max_uses: 2, expires_at: ends, note: "Salon fair" }, "code-1")).toEqual({ ...made, replayed: true });
      expect(await thrown(issue(tx, { plan: "salons-half-off", max_uses: 3, expires_at: ends }, "code-1"))).toMatchObject({ status: 422, code: "idempotency_key_reused" });

      const { businessId } = await ownedBusiness(tx, "bound");
      // A bound code is single use and needs no end.
      const chosen = await issue(tx, { plan: "pro-launch", code: "launch 2026", business_id: businessId });
      expect(chosen.code).toMatchObject({ code: "LAUNCH2026", business_id: businessId, max_uses: 1, expires_at: null, status: "active" });
      expect(await thrown(issue(tx, { plan: "pro-launch", code: "Launch2026", business_id: businessId }))).toMatchObject({ status: 409 });
      expect(await thrown(issue(tx, { plan: "pro-launch", code: "no--good", business_id: businessId }))).toMatchObject({ status: 400 });
      expect(await thrown(issue(tx, { plan: "pro", max_uses: 1, expires_at: ends }))).toMatchObject({ status: 409 });
      expect(await thrown(issue(tx, { plan: "nope", max_uses: 1, expires_at: ends }))).toMatchObject({ status: 400 });
      expect(await thrown(issue(tx, { plan: "pro-launch", business_id: randomUUID() }))).toMatchObject({ status: 404 });
      expect(await thrown(issue(tx, { plan: "pro-launch", max_uses: 1, expires_at: new Date(Date.now() - 60_000).toISOString() }))).toMatchObject({ status: 400 });

      const all = await listBillingCodesForApi(context(tx), { baseUrl });
      expect(all.data.map((code) => code.id).sort()).toEqual([made.code.id, chosen.code.id].sort());
      const first = await listBillingCodesForApi(context(tx), { limit: 1, baseUrl });
      expect(first.has_more).toBe(true);
      const second = await listBillingCodesForApi(context(tx), { limit: 1, cursor: first.next_cursor!, baseUrl });
      expect([...first.data, ...second.data].map((code) => code.id)).toEqual(all.data.map((code) => code.id));
      expect((await listBillingCodesForApi(context(tx), { plan: "salons-half-off", baseUrl })).data.map((code) => code.id)).toEqual([made.code.id]);
      expect((await listBillingCodesForApi(context(tx), { businessId, baseUrl })).data.map((code) => code.id)).toEqual([chosen.code.id]);

      const revoked = await revokeBillingCodeForApi(context(tx), { codeId: made.code.id, baseUrl });
      expect(revoked).toMatchObject({ id: made.code.id, status: "revoked", revoked_at: expect.any(String) });
      expect(await revokeBillingCodeForApi(context(tx), { codeId: made.code.id, baseUrl })).toEqual(revoked);
      expect(await thrown(revokeBillingCodeForApi(context(tx), { codeId: randomUUID(), baseUrl }))).toMatchObject({ status: 404 });
    });
  });

  it("finds a code's offer only for a business it serves while its plan is on sale, and keeps codes from the app", async () => {
    await rollbackTest(async (tx) => {
      await promoCatalog(tx);
      const a = await ownedBusiness(tx, "a");
      const b = await ownedBusiness(tx, "b");
      const ends = inAWeek();
      const shared = await issue(tx, { plan: "salons-half-off", code: "SALON50", max_uses: 2, expires_at: ends });
      await issue(tx, { plan: "pro-launch", code: "LAUNCH-A", business_id: a.businessId });
      await issue(tx, { plan: "salons-half-off", code: "OLD-CODE", max_uses: 5, expires_at: ends });
      await issue(tx, { plan: "salons-half-off", code: "FULL-CODE", max_uses: 1, expires_at: ends });
      const gone = await issue(tx, { plan: "salons-half-off", code: "GONE-CODE", max_uses: 5, expires_at: ends });
      await revokeBillingCodeForApi(context(tx), { codeId: gone.code.id, baseUrl });
      await as(tx, "owner");
      await tx.execute(sql`update public.billing_codes set expires_at = now() - interval '1 minute' where code = 'OLD-CODE'`);
      await tx.execute(sql`update public.billing_codes set uses = 1 where code = 'FULL-CODE'`);

      await as(tx, "lobbystack_app");
      const offer = await offerFor(tx, a.businessId, " salon50\n");
      expect(offer).toMatchObject({ codeId: shared.code.id, code: "SALON50", plan: "salons-half-off", tier: "starter", names: names("Salon offer"), discount: { type: "percentage", basis_points: 5000, duration: "repeating", duration_in_months: 3 }, currency: "cad" });
      expect(offer!.polarDiscountId).toEqual(expect.any(String));
      expect(offer!.prices).toEqual([{ interval: "monthly", cents: 3000, perMonth: 3000, polarId: expect.any(String) }]);
      expect(await offerFor(tx, a.businessId, "launch-a")).toMatchObject({ plan: "pro-launch", tier: "pro", discount: null });
      expect(await offerFor(tx, b.businessId, "LAUNCH-A")).toBeNull();
      for (const code of ["OLD-CODE", "FULL-CODE", "GONE-CODE", "SALON", "SALON5", "NOPE-NOPE", "S"]) expect(await offerFor(tx, a.businessId, code), code).toBeNull();
      expect(await failure(tx, sql`select * from public.billing_codes`)).toBe("42501");

      // A plan that isn't on sale finds nothing.
      await as(tx, "owner");
      await tx.execute(sql`update public.billing_plans set status = 'draft' where code = 'salons-half-off'`);
      await as(tx, "lobbystack_app");
      expect(await offerFor(tx, a.businessId, "SALON50")).toBeNull();
    });
  });

  it("sells a code's plan from the dashboard and puts the business on it once Polar's webhook lands, counting the use once", async () => {
    await rollbackTest(async (tx) => {
      await promoCatalog(tx);
      const { userId, businessId } = await ownedBusiness(tx, "buyer");
      const launch = await issue(tx, { plan: "pro-launch", code: "LAUNCH50", max_uses: 1, expires_at: inAWeek() });
      const checkPromoCode = vi.fn(async () => {});
      const dashboard = (promoCode: string, billingInterval: "monthly" | "annual" = "monthly", user = userId) => createBillingCheckoutRequest(context(tx), { userId: user, businessId, target: "starter", billingInterval, promoCode, checkPromoCode });
      const stranger = await ownedBusiness(tx, "stranger");

      await as(tx, "lobbystack_app");
      expect(await thrown(dashboard("WRONG-CODE"))).toMatchObject({ status: 400, code: "promo_invalid" });
      expect(await thrown(dashboard("LAUNCH50", "annual"))).toMatchObject({ status: 409, code: "promo_interval" });
      // Someone who doesn't manage the business is refused before a try is counted against it.
      expect(await thrown(dashboard("LAUNCH50", "monthly", stranger.userId))).toBeDefined();
      expect(checkPromoCode).toHaveBeenCalledTimes(2);
      // The code sells its plan at the plan's tier, whatever the target.
      const requestId = await dashboard("launch50");
      await as(tx, "lobbystack_worker");
      expect(await loadBillingCheckoutRequest(context(tx), { businessId, requestId })).toMatchObject({ target: "pro", billingInterval: "monthly", planCode: "pro-launch", subscription: null });
      const links = await readPolarProductLinks(context(tx), {});
      const sale = links.saleFor("pro-launch", "monthly");
      expect(sale).toEqual({ productId: expect.any(String), discountId: null });
      expect(links.saleFor("salons-half-off", "monthly")).toEqual({ productId: expect.any(String), discountId: expect.any(String) });
      expect(links.saleFor("pro-launch", "annual")).toBeNull();
      expect(links.planFor(sale!.productId)).toEqual({ plan: "pro", interval: "monthly", code: "pro-launch" });

      // Polar sends the subscription and its first order; either can come first, and each is counted once.
      await as(tx, "owner");
      const event = async (eventType: string, payload: Record<string, unknown>) => (await tx.insert(providerEvents).values({ provider: "polar", providerEventId: `evt-${randomUUID()}`, eventType, businessId, payload: { billingKey: `business:${businessId}`, ...payload } }).returning({ id: providerEvents.id }))[0]!.id;
      const active = await event("subscription.active", { plan: "pro", planCode: "pro-launch", status: "active", billingInterval: "monthly", subscriptionId: "sub_launch", currentPeriodStart: "2026-11-01T00:00:00.000Z", currentPeriodEnd: "2026-12-01T00:00:00.000Z" });
      const paid = await event("order.paid", { plan: "pro", planCode: "pro-launch", billingInterval: "monthly", subscriptionId: "sub_launch" });
      await as(tx, "lobbystack_worker");
      await reconcileBillingProviderEvent(context(tx), { businessId, providerEventId: active });
      await reconcileBillingProviderEvent(context(tx), { businessId, providerEventId: paid });

      await as(tx, "owner");
      const [account] = await rows(tx, sql`select plan, plan_code, plan_ends, code_id, subscription_state from public.billing_accounts where business_id = ${businessId}::uuid`);
      expect(account).toMatchObject({ plan: "pro", plan_code: "pro-launch", code_id: launch.code.id, subscription_state: "active" });
      // Six months from the first charge.
      expect(new Date(String(account!.plan_ends)).toISOString()).toBe("2027-05-01T00:00:00.000Z");
      expect(await rows(tx, sql`select uses from public.billing_codes where id = ${launch.code.id}::uuid`)).toEqual([{ uses: 1 }]);
      expect(await rows(tx, sql`select entity_id, payload from public.audit_logs where business_id = ${businessId}::uuid and event_type = 'billing.promo_code_redeemed'`)).toEqual([{ entity_id: launch.code.id, payload: { plan: "pro-launch" } }]);
      expect((await rows(tx, sql`select frozen_at from public.billing_plans where code = 'pro-launch'`))[0]!.frozen_at).not.toBeNull();

      // The business reads the plan it is on, and no other promo plan.
      await as(tx, "lobbystack_app");
      const read = (run: (scoped: DatabaseTransaction) => Promise<unknown>) => withBusinessTransaction(tx as unknown as Database, { businessId, userId, actorType: "operator" }, run);
      expect(await read((scoped) => loadBusinessPromoPlan(scoped, businessId))).toEqual({ plan: "pro-launch", tier: "pro", names: names("Pro launch offer"), discount: null, currency: "cad", ends: "2027-05-01T00:00:00.000Z", endsWith: "tier", prices: [{ interval: "monthly", cents: 6000, perMonth: 6000 }] });
      expect(await read(async (scoped) => (await scoped.execute<Row>(sql`select code from public.billing_plans where access = 'code'`)).rows)).toEqual([{ code: "pro-launch" }]);
      // The code is used up, and a code for the plan the business already pays for has nothing to sell.
      expect(await thrown(dashboard("LAUNCH50"))).toMatchObject({ code: "promo_invalid" });
      await as(tx, "lobbystack_worker");
      await issue(tx, { plan: "pro-launch", code: "LAUNCH-AGAIN", business_id: businessId });
      await as(tx, "lobbystack_app");
      expect(await thrown(dashboard("LAUNCH-AGAIN"))).toMatchObject({ status: 409, code: "promo_current" });

      // Moving to standard Pro clears the promo plan.
      await as(tx, "owner");
      const standard = await event("subscription.updated", { plan: "pro", planCode: "pro", status: "active", billingInterval: "monthly", subscriptionId: "sub_launch" });
      await as(tx, "lobbystack_worker");
      await reconcileBillingProviderEvent(context(tx), { businessId, providerEventId: standard });
      await as(tx, "owner");
      expect(await rows(tx, sql`select plan, plan_code, plan_ends, code_id from public.billing_accounts where business_id = ${businessId}::uuid`)).toEqual([{ plan: "pro", plan_code: null, plan_ends: null, code_id: null }]);
    });
  });

  it("starts a plan's months at the renewal after a move within a period, counts the code the paid request carried, and enters once across a lapse", async () => {
    await rollbackTest(async (tx) => {
      await promoCatalog(tx);
      const { userId, businessId } = await ownedBusiness(tx, "mover");
      const bound = await issue(tx, { plan: "pro-launch", code: "MOVER-BOUND", business_id: businessId });
      const shared = await issue(tx, { plan: "pro-launch", code: "MOVER-SHARED", max_uses: 5, expires_at: inAWeek() });
      const event = async (owner: string, eventType: string, payload: Record<string, unknown>) => {
        await as(tx, "owner");
        const [stored] = await tx.insert(providerEvents).values({ provider: "polar", providerEventId: `evt-${randomUUID()}`, eventType, businessId: owner, payload: { billingKey: `business:${owner}`, ...payload } }).returning({ id: providerEvents.id });
        await as(tx, "lobbystack_worker");
        await reconcileBillingProviderEvent(context(tx), { businessId: owner, providerEventId: stored!.id });
      };
      const account = async (owner = businessId) => {
        await as(tx, "owner");
        const [row] = await rows(tx, sql`select plan_code, code_id, plan_ends, end_with, subscription_state from public.billing_accounts where business_id = ${owner}::uuid`);
        return { ...row, plan_ends: row!.plan_ends === null ? null : new Date(String(row!.plan_ends)).toISOString() };
      };
      const uses = async () => {
        await as(tx, "owner");
        return await rows(tx, sql`select code, uses from public.billing_codes where id in (${bound.code.id}::uuid, ${shared.code.id}::uuid) order by code`);
      };
      const subscription = { plan: "pro", planCode: "pro-launch", billingInterval: "monthly", subscriptionId: "sub_mover", currentPeriodStart: "2026-10-01T00:00:00.000Z", currentPeriodEnd: "2026-11-01T00:00:00.000Z" };

      await event(businessId, "subscription.active", { ...subscription, plan: "starter", planCode: "starter", status: "active" });
      await as(tx, "lobbystack_app");
      const checkPromoCode = async () => {};
      const first = await createBillingCheckoutRequest(context(tx), { userId, businessId, target: "pro", billingInterval: "monthly", promoCode: "MOVER-BOUND", checkPromoCode });
      await createBillingCheckoutRequest(context(tx), { userId, businessId, target: "pro", billingInterval: "monthly", promoCode: "MOVER-SHARED", checkPromoCode });
      // Polar moves the paying subscription for the first request, keeping its period: the plan's discount starts at the November renewal.
      await event(businessId, "subscription.updated", { ...subscription, status: "active", metadata: { lobbystack_plan: "pro-launch", lobbystack_checkout: first } });
      expect(await account()).toEqual({ plan_code: "pro-launch", code_id: bound.code.id, plan_ends: "2027-05-01T00:00:00.000Z", end_with: null, subscription_state: "active" });
      expect(await uses()).toEqual([{ code: "MOVER-BOUND", uses: 1 }, { code: "MOVER-SHARED", uses: 0 }]);

      // An operator's end, then a payment that fails and goes through: the business never left the plan.
      await tx.execute(sql`update public.billing_accounts set end_with = 'tier', end_set_at = now() where business_id = ${businessId}::uuid`);
      await event(businessId, "subscription.updated", { ...subscription, status: "unpaid" });
      await event(businessId, "subscription.updated", { ...subscription, status: "active" });
      expect(await account()).toEqual({ plan_code: "pro-launch", code_id: bound.code.id, plan_ends: "2027-05-01T00:00:00.000Z", end_with: "tier", subscription_state: "active" });
      expect(await uses()).toEqual([{ code: "MOVER-BOUND", uses: 1 }, { code: "MOVER-SHARED", uses: 0 }]);
      expect(await rows(tx, sql`select count(*)::int as redeemed from public.audit_logs where business_id = ${businessId}::uuid and event_type = 'billing.promo_code_redeemed'`)).toEqual([{ redeemed: 1 }]);

      // A checkout's months count from its first charge, to the same day or the month's last.
      const late = await ownedBusiness(tx, "late");
      await event(late.businessId, "subscription.active", { ...subscription, status: "active", subscriptionId: "sub_late", currentPeriodStart: "2026-08-31T00:00:00.000Z", currentPeriodEnd: "2026-09-30T00:00:00.000Z" });
      expect((await account(late.businessId)).plan_ends).toBe("2027-02-28T00:00:00.000Z");
    });
  });

  it("sells a paying business only Pro from Starter without a code, from the dashboard as through the API", async () => {
    await rollbackTest(async (tx) => {
      await promoCatalog(tx);
      const { userId, businessId } = await ownedBusiness(tx, "payer");
      const subscribe = async (plan: string) => {
        await as(tx, "owner");
        const [stored] = await tx.insert(providerEvents).values({ provider: "polar", providerEventId: `evt-${randomUUID()}`, eventType: "subscription.updated", businessId, payload: { billingKey: `business:${businessId}`, plan, planCode: plan, status: "active", billingInterval: "monthly", subscriptionId: "sub_payer" } }).returning({ id: providerEvents.id });
        await as(tx, "lobbystack_worker");
        await reconcileBillingProviderEvent(context(tx), { businessId, providerEventId: stored!.id });
        await as(tx, "lobbystack_app");
      };
      const dashboard = (target: "starter" | "pro", billingInterval: "monthly" | "annual" = "monthly") => createBillingCheckoutRequest(context(tx), { userId, businessId, target, billingInterval });
      await subscribe("pro");
      expect(await thrown(dashboard("starter"))).toMatchObject({ status: 409, message: "This business already pays for a plan. Change it in the billing portal." });
      expect(await thrown(dashboard("pro", "annual"))).toMatchObject({ status: 409 });
      await subscribe("starter");
      expect(await dashboard("pro", "annual")).toEqual(expect.any(String));
      expect(await thrown(dashboard("starter", "annual"))).toMatchObject({ status: 409 });
    });
  });

  it("sells a code's plan through the API to a claimed business, and answers a code that doesn't work on promo_code", async () => {
    await rollbackTest(async (tx) => {
      await promoCatalog(tx);
      const { userId, businessId } = await ownedBusiness(tx, "api");
      await issue(tx, { plan: "salons-half-off", code: "SALON50", max_uses: 5, expires_at: inAWeek() });
      const apiCaller = { businessId, platformKeyId: caller.platformKeyId, partnerId: caller.partnerId, actingUserId: randomUUID(), actor: "platform_key" as const };
      const checkPromoCode = vi.fn(async () => {});
      const checkout = await createCheckoutForApi(context(tx), apiCaller, { plan: "promo", interval: "monthly", promo_code: "salon50" }, { available: true, checkPromoCode });
      expect(checkout).toMatchObject({ plan: "starter", interval: "monthly", promo_plan: "salons-half-off", status: "pending", paid: false });
      expect(checkPromoCode).toHaveBeenCalledTimes(1);
      // A key with no owner to pay, as on a business nobody claimed, spends none of the business's tries.
      expect(await thrown(createCheckoutForApi(context(tx), { ...apiCaller, actingUserId: userId }, { plan: "promo", interval: "monthly", promo_code: "SALON50" }, { available: true, checkPromoCode }))).toMatchObject({ status: 409 });
      expect(checkPromoCode).toHaveBeenCalledTimes(1);
      expect(await thrown(createCheckoutForApi(context(tx), apiCaller, { plan: "promo", interval: "monthly", promo_code: "SALON51" }, { available: true }))).toMatchObject({ status: 400, details: [{ path: "promo_code" }] });
      expect(await thrown(createCheckoutForApi(context(tx), apiCaller, { plan: "promo", interval: "annual", promo_code: "SALON50" }, { available: true }))).toMatchObject({ status: 409 });
      expect(await thrown(createCheckoutForApi(context(tx), apiCaller, { plan: "promo", interval: "monthly", promo_code: "SALON50" }, { available: false }))).toMatchObject({ status: 409 });
      await as(tx, "owner");
      const [audit] = await rows(tx, sql`select payload from public.audit_logs where business_id = ${businessId}::uuid and event_type = 'api.billing.checkout_started'`);
      expect(audit!.payload).toMatchObject({ plan: "starter", promoPlan: "salons-half-off", interval: "monthly" });
    });
  });
  it("leaves out the number step for a promo plan that includes no number", async () => {
    await rollbackTest(async (tx) => {
      const file = allowanceFile();
      file.plans["salons-plus"].limits.businessNumbers = 0;
      await promoCatalog(tx, file);
      const { businessId } = await ownedBusiness(tx, "chat-only");
      await as(tx, "owner");
      await tx.execute(sql`update public.businesses set onboarding_stage = 'phone_number' where id = ${businessId}::uuid`);
      const [subscribed] = await tx.insert(providerEvents).values({ provider: "polar", providerEventId: `evt-${randomUUID()}`, eventType: "subscription.active", businessId, payload: { billingKey: `business:${businessId}`, plan: "starter", planCode: "salons-plus", status: "active", billingInterval: "monthly", subscriptionId: "sub_chat_only" } }).returning({ id: providerEvents.id });
      await as(tx, "lobbystack_worker");
      await reconcileBillingProviderEvent(context(tx), { businessId, providerEventId: subscribed!.id });
      // Starter itself includes a number, but this plan's claims would all be refused, so the API asks for none and sends the business back to its plan.
      const apiCaller = { businessId, platformKeyId: caller.platformKeyId, partnerId: caller.partnerId, actingUserId: randomUUID(), actor: "platform_key" as const };
      const onboarding = await getOnboardingForApi(context(tx), apiCaller);
      expect(onboarding.stage).toBe("plan");
      expect(onboarding.checklist).toContainEqual({ id: "phone_number", status: "missing", required: false });
    });
  });

  it("gives a business on a promo plan the plan's own allowances, and prices its usage by the plan it was used under", async () => {
    await rollbackTest(async (tx) => {
      await promoCatalog(tx, allowanceFile());
      const { userId, businessId } = await ownedBusiness(tx, "plus");
      const other = await ownedBusiness(tx, "other");
      // Polar's webhook puts the business on the plan.
      await as(tx, "owner");
      const [subscribed] = await tx.insert(providerEvents).values({ provider: "polar", providerEventId: `evt-${randomUUID()}`, eventType: "subscription.active", businessId, payload: { billingKey: `business:${businessId}`, plan: "starter", planCode: "salons-plus", status: "active", billingInterval: "monthly", subscriptionId: "sub_plus", currentPeriodStart: "2026-11-01T00:00:00.000Z", currentPeriodEnd: "2026-12-01T00:00:00.000Z" } }).returning({ id: providerEvents.id });
      await as(tx, "lobbystack_worker");
      await reconcileBillingProviderEvent(context(tx), { businessId, providerEventId: subscribed!.id });
      const period = "2026-11";
      const at = new Date("2026-11-03T12:00:00.000Z");
      const asWorker = (run: (scoped: DatabaseTransaction) => Promise<unknown>) => withBusinessTransaction(tx as unknown as Database, { businessId, actorType: "worker" }, run);
      const asApp = <T>(id: string, user: string, run: (scoped: DatabaseTransaction) => Promise<T>) => withBusinessTransaction(tx as unknown as Database, { businessId: id, userId: user, actorType: "operator" }, run);

      // The dashboard's role finds the plan's own limits, which the storage and number checks read.
      await as(tx, "lobbystack_app");
      const own = await asApp(businessId, userId, (scoped) => loadBusinessPlanLimits(scoped, businessId));
      expect(own).toMatchObject({ plan: "starter", planCode: "salons-plus", limits: { voiceSecondsIncluded: 18_000, knowledgeStorageBytes: 10 * 1_048_576, includedBusinessNumbers: 1, voiceOverageRatePerMinuteCents: 25, alertSmsSegmentsIncluded: 50 } });

      // 250 minutes are within the plan's 300, though over Starter's 150; 360 cost 60 minutes at its own rate.
      await as(tx, "lobbystack_worker");
      await asWorker((scoped) => reserveUsageInTransaction(scoped, { businessId, usageKind: "voice_seconds", sourceKey: "voice:plus-1", quantity: 15_000, recordedAt: at }));
      await as(tx, "lobbystack_app");
      expect(await asApp(businessId, userId, (scoped) => readUsageStatusInTransaction(scoped, { businessId, periodKey: period }))).toMatchObject({ plan: "starter", voiceSecondsUsed: 15_000, voiceSecondsIncluded: 18_000, overageSpendCents: 0, voiceOverageRatePerMinuteCents: 25 });
      await as(tx, "lobbystack_worker");
      await asWorker((scoped) => reserveUsageInTransaction(scoped, { businessId, usageKind: "voice_seconds", sourceKey: "voice:plus-2", quantity: 6_600, recordedAt: at }));
      await as(tx, "owner");
      expect(await rows(tx, sql`select source_key, plan_at_record_time, plan_code_at_record_time from public.billing_usage_events where business_id = ${businessId}::uuid order by source_key`)).toEqual([
        { source_key: "voice:plus-1", plan_at_record_time: "starter", plan_code_at_record_time: "salons-plus" },
        { source_key: "voice:plus-2", plan_at_record_time: "starter", plan_code_at_record_time: "salons-plus" },
      ]);
      await as(tx, "lobbystack_app");
      expect(await asApp(businessId, userId, (scoped) => getUsageStatusInTransaction(scoped, { businessId, periodKey: period }))).toMatchObject({ voiceSecondsUsed: 21_600, overageSpendCents: 60 * 25 });

      // The API names the plan.
      await as(tx, "lobbystack_worker");
      const apiCaller = { businessId, platformKeyId: caller.platformKeyId, partnerId: caller.partnerId, actingUserId: randomUUID(), actor: "platform_key" as const };
      expect(await getBillingForApi(context(tx), apiCaller)).toMatchObject({ plan: "starter", promo_plan: "salons-plus", plan_ends: null });

      // After moving to standard Starter, new usage counts at Starter's terms, and the month's earlier usage
      // keeps the plan's, as the dashboard's role reads it too.
      await as(tx, "owner");
      await tx.execute(sql`update public.billing_accounts set plan_code = null where business_id = ${businessId}::uuid`);
      await as(tx, "lobbystack_worker");
      // Recorded after the plan's usage: events from the same moment replay in no fixed order.
      await asWorker((scoped) => reserveUsageInTransaction(scoped, { businessId, usageKind: "voice_seconds", sourceKey: "voice:starter-1", quantity: 600, recordedAt: new Date("2026-11-10T12:00:00.000Z") }));
      expect((await asWorker((scoped) => readUsageStatusInTransaction(scoped, { businessId, periodKey: period })) as { overageSpendCents: number }).overageSpendCents).toBe(60 * 25 + 10 * 20);
      expect(await getBillingForApi(context(tx), apiCaller)).toMatchObject({ promo_plan: null });
      await as(tx, "lobbystack_app");
      expect(await asApp(businessId, userId, (scoped) => readUsageStatusInTransaction(scoped, { businessId, periodKey: period }))).toMatchObject({ voiceSecondsUsed: 22_200, voiceSecondsIncluded: 9_000, overageSpendCents: 60 * 25 + 10 * 20 });
      expect(await asApp(businessId, userId, async (scoped) => Object.keys((await readBillingPlanLimitBook(scoped)).plans))).toEqual(["salons-plus"]);
      // Another business reads no promo plan, and a code for the plan shows what it includes.
      expect(await asApp(other.businessId, other.userId, async (scoped) => Object.keys((await readBillingPlanLimitBook(scoped)).plans))).toEqual([]);
      await as(tx, "lobbystack_worker");
      await issue(tx, { plan: "salons-plus", code: "PLUS-2026", business_id: other.businessId });
      await as(tx, "lobbystack_app");
      const view = await asApp(other.businessId, other.userId, (scoped) => billingCodeView(scoped, { businessId: other.businessId, code: "plus-2026", checkout: true }));
      expect(view).toMatchObject({ plan: "salons-plus", tier: "starter", included: { voiceSeconds: 18_000, alertSmsSegments: 50, outboundCallAttempts: 20, chatAiUnits: 50, knowledgeStorageBytes: 10 * 1_048_576, businessNumbers: 1 }, moreThanTier: ["voiceSeconds", "knowledgeStorageBytes"] });
      // The worker reads every plan.
      await as(tx, "lobbystack_worker");
      expect(Object.keys((await readBillingPlanLimitBook(tx)).plans).sort()).toEqual(["pro-launch", "salons-half-off", "salons-plus"]);
    });
  });

  describe("promo endings", () => {
    /** Polar's webhook for the business's subscription, reconciled by the worker. */
    async function polarEvent(tx: DatabaseTransaction, businessId: string, eventType: string, payload: Record<string, unknown>) {
      await as(tx, "owner");
      const [event] = await tx.insert(providerEvents).values({ provider: "polar", providerEventId: `evt-${randomUUID()}`, eventType, businessId, payload: { billingKey: `business:${businessId}`, status: "active", billingInterval: "monthly", subscriptionId: "sub_promo", ...payload } }).returning({ id: providerEvents.id });
      await as(tx, "lobbystack_worker");
      await reconcileBillingProviderEvent(context(tx), { businessId, providerEventId: event!.id });
    }
    const account = async (tx: DatabaseTransaction, businessId: string) => {
      await as(tx, "owner");
      const [row] = await rows(tx, sql`select plan, plan_code, plan_ends, end_with, end_notice_at, end_set_at from public.billing_accounts where business_id = ${businessId}::uuid`);
      await as(tx, "lobbystack_worker");
      return row!;
    };
    const outbox = async (tx: DatabaseTransaction, businessId: string, topic: string) => {
      await as(tx, "owner");
      const found = await rows(tx, sql`select payload from public.outbox_messages where business_id = ${businessId}::uuid and topic = ${topic} order by created_at`);
      await as(tx, "lobbystack_worker");
      return found.map((row) => row.payload as Record<string, unknown>);
    };
    const audits = async (tx: DatabaseTransaction, businessId: string, eventType: string) => {
      await as(tx, "owner");
      const found = await rows(tx, sql`select payload from public.audit_logs where business_id = ${businessId}::uuid and event_type = ${eventType}`);
      await as(tx, "lobbystack_worker");
      return found.map((row) => row.payload);
    };
    // The owners' email resolver trusts only the worker's login identity.
    async function recordAsWorker(tx: DatabaseTransaction, input: Parameters<typeof recordPromoEnd>[1]) {
      await tx.execute(sql`set local session authorization lobbystack_worker`);
      try {
        return await recordPromoEnd(context(tx), input);
      } finally {
        await tx.execute(sql`reset session authorization`);
        await as(tx, "lobbystack_worker");
      }
    }

    it("ends a plan at the renewal that reaches its end: a week ahead it tells Polar and emails the owners once", async () => {
      await rollbackTest(async (tx) => {
        await promoCatalog(tx);
        const { businessId } = await ownedBusiness(tx, "ending");
        // Six months of Pro launch that run out in five days.
        const start = new Date();
        start.setUTCMonth(start.getUTCMonth() - 6);
        start.setTime(start.getTime() + 5 * 86_400_000);
        const firstEnd = new Date(start);
        firstEnd.setUTCMonth(firstEnd.getUTCMonth() + 1);
        await polarEvent(tx, businessId, "subscription.active", { plan: "pro", planCode: "pro-launch", currentPeriodStart: start.toISOString(), currentPeriodEnd: firstEnd.toISOString() });
        const planEnds = new Date(String((await account(tx, businessId)).plan_ends));
        expect(await account(tx, businessId)).toMatchObject({ plan_code: "pro-launch", end_with: null, end_notice_at: null, end_set_at: null });
        // While the renewal that ends it isn't the current period's end, nothing is due.
        expect(await loadPromoEndWork(context(tx), { businessId })).toBeNull();
        await polarEvent(tx, businessId, "subscription.updated", { plan: "pro", planCode: "pro-launch", currentPeriodStart: new Date(planEnds.getTime() - 30 * 86_400_000).toISOString(), currentPeriodEnd: planEnds.toISOString() });
        expect(await loadPromoEndWork(context(tx), { businessId, now: new Date(planEnds.getTime() - 8 * 86_400_000) })).toBeNull();
        const work = await loadPromoEndWork(context(tx), { businessId });
        expect(work).toEqual({ planCode: "pro-launch", planEnds, tier: "pro", interval: "monthly", subscriptionId: "sub_promo", ending: "tier", endsAt: planEnds, set: true, notify: true, overdue: false });

        const notice = { ending: work!.ending, endsAt: work!.endsAt, tier: work!.tier, interval: work!.interval };
        expect(await recordAsWorker(tx, { businessId, planCode: "pro-launch", planEnds, set: true, notice, appUrl: "https://demo.alloplace.com/" })).toBe(1);
        const [email] = await outbox(tx, businessId, "email.send");
        expect(email).toMatchObject({ template: "promo_ending", to: expect.stringMatching(/^promo-ending-/), variables: { locale: "en", businessName: "Promo ending", planName: "Pro launch offer", tier: "Pro", ending: "tier", date: planEnds.toISOString(), timeZone: "UTC", interval: "monthly", priceCents: expect.stringMatching(/^\d+$/), currency: "cad", url: "https://demo.alloplace.com/settings/plan" } });
        expect(await account(tx, businessId)).toMatchObject({ end_notice_at: expect.anything(), end_set_at: expect.anything() });
        expect(await audits(tx, businessId, "billing.promo_end_set")).toEqual([{ plan: "pro-launch", ending: "tier" }]);
        // The next day's check has nothing left to do, and a second email never goes.
        expect(await loadPromoEndWork(context(tx), { businessId, now: new Date(Date.now() + 86_400_000) })).toMatchObject({ set: false, notify: false });
        expect(await recordAsWorker(tx, { businessId, planCode: "pro-launch", planEnds, set: false, notice, appUrl: "https://demo.alloplace.com" })).toBe(0);
        expect(await outbox(tx, businessId, "email.send")).toHaveLength(1);

        // The renewal moves the subscription to standard Pro, which ends the plan.
        await polarEvent(tx, businessId, "subscription.updated", { plan: "pro", planCode: "pro", currentPeriodStart: planEnds.toISOString(), currentPeriodEnd: new Date(planEnds.getTime() + 30 * 86_400_000).toISOString() });
        expect(await account(tx, businessId)).toEqual({ plan: "pro", plan_code: null, plan_ends: null, end_with: null, end_notice_at: null, end_set_at: null });
        expect(await audits(tx, businessId, "billing.promo_ended")).toEqual([{ plan: "pro-launch", to: "pro", reason: "ended" }]);
      });
    });

    it("lets an operator end a plan at its next renewal, moving one that would keep going to its tier", async () => {
      await rollbackTest(async (tx) => {
        await promoCatalog(tx);
        const { businessId } = await ownedBusiness(tx, "early");
        const apiCaller = { businessId, platformKeyId: caller.platformKeyId, partnerId: caller.partnerId, actingUserId: randomUUID(), actor: "platform_key" as const };
        expect(await thrown(endPromoPlanForApi(context(tx), apiCaller))).toMatchObject({ status: 404 });
        const periodEnd = new Date(Date.now() + 20 * 86_400_000).toISOString();
        await polarEvent(tx, businessId, "subscription.active", { plan: "starter", planCode: "salons-half-off", currentPeriodStart: new Date(Date.now() - 10 * 86_400_000).toISOString(), currentPeriodEnd: periodEnd });
        // The plan has no months, so it never ends by itself.
        expect(await getBillingForApi(context(tx), apiCaller)).toMatchObject({ promo_plan: "salons-half-off", plan_ends: null, plan_ends_with: null });
        expect(await loadPromoEndWork(context(tx), { businessId })).toBeNull();

        const ended = await endPromoPlanForApi(context(tx), apiCaller);
        expect(ended).toMatchObject({ plan: "starter", promo_plan: "salons-half-off", plan_ends: expect.any(String), plan_ends_with: "tier" });
        expect(await account(tx, businessId)).toMatchObject({ end_with: "tier", end_notice_at: null, end_set_at: null });
        expect(await outbox(tx, businessId, "billing.endPromoPlan")).toEqual([{}]);
        expect(await audits(tx, businessId, "api.billing.promo_plan_ended")).toEqual([expect.objectContaining({ plan: "salons-half-off", endsWith: "tier" })]);
        // It is due at once, and ends at the renewal the business already paid up to.
        expect(await loadPromoEndWork(context(tx), { businessId })).toMatchObject({ ending: "tier", endsAt: new Date(periodEnd), set: true, notify: true });
        // Asking again changes nothing.
        const before = await account(tx, businessId);
        await endPromoPlanForApi(context(tx), apiCaller);
        expect(await account(tx, businessId)).toEqual(before);
        // Settings > Plan shows when, and what comes next.
        expect(await withBusinessTransaction(tx as unknown as Database, { businessId, actorType: "worker" }, (scoped) => loadBusinessPromoPlan(scoped, businessId))).toMatchObject({ plan: "salons-half-off", ends: periodEnd, endsWith: "tier" });
      });
    });

    it("sends no second email when an operator ends a plan in the week its owners heard it ends", async () => {
      await rollbackTest(async (tx) => {
        await promoCatalog(tx);
        const { businessId } = await ownedBusiness(tx, "told");
        const apiCaller = { businessId, platformKeyId: caller.platformKeyId, partnerId: caller.partnerId, actingUserId: randomUUID(), actor: "platform_key" as const };
        // Pro launch's last month, which ends in five days.
        const start = new Date();
        start.setUTCMonth(start.getUTCMonth() - 6);
        start.setTime(start.getTime() + 5 * 86_400_000);
        const firstEnd = new Date(start);
        firstEnd.setUTCMonth(firstEnd.getUTCMonth() + 1);
        await polarEvent(tx, businessId, "subscription.active", { plan: "pro", planCode: "pro-launch", currentPeriodStart: start.toISOString(), currentPeriodEnd: firstEnd.toISOString() });
        const planEnds = new Date(String((await account(tx, businessId)).plan_ends));
        await polarEvent(tx, businessId, "subscription.updated", { plan: "pro", planCode: "pro-launch", currentPeriodStart: new Date(planEnds.getTime() - 30 * 86_400_000).toISOString(), currentPeriodEnd: planEnds.toISOString() });
        const work = await loadPromoEndWork(context(tx), { businessId });
        const notice = { ending: work!.ending, endsAt: work!.endsAt, tier: work!.tier, interval: work!.interval };
        expect(await recordAsWorker(tx, { businessId, planCode: "pro-launch", planEnds, set: true, notice, appUrl: "https://demo.alloplace.com" })).toBe(1);

        // The same renewal ends it the same way, so Polar and the owners already know.
        const before = await account(tx, businessId);
        expect(await endPromoPlanForApi(context(tx), apiCaller)).toMatchObject({ promo_plan: "pro-launch", plan_ends_with: "tier" });
        expect(await account(tx, businessId)).toEqual({ ...before, end_with: "tier" });
        expect(await loadPromoEndWork(context(tx), { businessId })).toMatchObject({ set: false, notify: false });
        expect(await recordAsWorker(tx, { businessId, planCode: "pro-launch", planEnds, set: false, notice, appUrl: "https://demo.alloplace.com" })).toBe(0);
        expect(await outbox(tx, businessId, "email.send")).toHaveLength(1);
      });
    });

    it("removes a promo plan's discount that a switch in Polar's billing portal left on a standard product", async () => {
      await rollbackTest(async (tx) => {
        await promoCatalog(tx);
        const { businessId } = await ownedBusiness(tx, "portal");
        await polarEvent(tx, businessId, "subscription.active", { plan: "starter", planCode: "salons-half-off", currentPeriodStart: "2026-11-01T00:00:00.000Z", currentPeriodEnd: "2026-12-01T00:00:00.000Z" });
        await as(tx, "owner");
        const [plan] = await rows(tx, sql`select polar_disc from public.billing_plans where code = 'salons-half-off'`);
        const discountId = String(plan!.polar_disc);
        // A discount nobody's promo plan owns stays.
        await polarEvent(tx, businessId, "subscription.updated", { plan: "starter", planCode: "salons-half-off", discountId });
        await polarEvent(tx, businessId, "subscription.updated", { plan: "pro", planCode: "pro", discountId: "disc_dashboard" });
        expect(await outbox(tx, businessId, "billing.endPromoPlan")).toEqual([]);
        expect(await audits(tx, businessId, "billing.promo_ended")).toEqual([{ plan: "salons-half-off", to: "pro", reason: "switched" }]);
        await polarEvent(tx, businessId, "subscription.updated", { plan: "starter", planCode: "starter", discountId });
        await polarEvent(tx, businessId, "subscription.updated", { plan: "starter", planCode: "starter", discountId });
        expect(await outbox(tx, businessId, "billing.endPromoPlan")).toEqual([{ dropDiscount: discountId, subscriptionId: "sub_promo" }]);
      });
    });
  });
});
