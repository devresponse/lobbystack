import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, providerEvents, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { apiBillingCatalogApplySchema, apiBillingCatalogLinkSchema, apiBillingCodeCreateSchema, billingProfileSchema } from "@lobbystack/shared";

import { PolarCatalogClient } from "../../../providers/src/polar/polarCatalog";
import { createBillingCheckoutRequest, loadBillingCheckoutRequest, reconcileBillingProviderEvent } from "./billing";
import { applyBillingCatalogForApi, billingDeploymentPolar, desiredBillingPlans, linkBillingCatalogForApi } from "./billingCatalog";
import { createBillingCodeForApi, findBillingCodeOffer, listBillingCodesForApi, loadBusinessPromoPlan, revokeBillingCodeForApi } from "./billingCodes";
import { readPolarProductLinks } from "./billingPlans";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans, runPolarSteps } from "./billingPolar";
import { createFakePolar } from "./billingPolar.testing";
import { createCheckoutForApi } from "./publicApi/operations";
import { createBusiness } from "./tenancy";

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

/** Applies the promo file, sets a Polar stand-in up from it as pnpm billing apply does, and links the two. */
async function promoCatalog(tx: DatabaseTransaction): Promise<void> {
  const value = promoFile();
  const applied = await applyBillingCatalogForApi(context(tx), { caller, idempotencyKey: randomUUID(), body: apiBillingCatalogApplySchema.parse({ brand: "alloplace", billing_file: value, allow_undeployed: true }), deployment: { brand: "alloplace" } });
  const fake = createFakePolar();
  const polar = new PolarCatalogClient({ token: "polar_oat_test", baseUrl: polarEnv.POLAR_API_BASE_URL, fetch: fake.fetch, sleep: async () => undefined });
  const profile = billingProfileSchema.parse(value);
  const plans = desiredBillingPlans(profile);
  const catalog = desiredPolarCatalog({ brand: "alloplace", profile, plans, webhookUrl: `${polarEnv.APP_BASE_URL}/api/webhooks/polar` });
  await runPolarSteps(polar, planPolarChanges({ catalog, snapshot: await polar.readSnapshot(), options: { adopt: false, allowReplace: false, allowArchive: false, allowLess: false } }).steps);
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
      expect(await read((scoped) => loadBusinessPromoPlan(scoped, businessId))).toEqual({ plan: "pro-launch", tier: "pro", names: names("Pro launch offer"), discount: null, currency: "cad", ends: "2027-05-01T00:00:00.000Z", prices: [{ interval: "monthly", cents: 6000, perMonth: 6000 }] });
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

  it("sells a code's plan through the API to a claimed business, and answers a code that doesn't work on promo_code", async () => {
    await rollbackTest(async (tx) => {
      await promoCatalog(tx);
      const { businessId } = await ownedBusiness(tx, "api");
      await issue(tx, { plan: "salons-half-off", code: "SALON50", max_uses: 5, expires_at: inAWeek() });
      const apiCaller = { businessId, platformKeyId: caller.platformKeyId, partnerId: caller.partnerId, actingUserId: randomUUID(), actor: "platform_key" as const };
      const checkout = await createCheckoutForApi(context(tx), apiCaller, { plan: "promo", interval: "monthly", promo_code: "salon50" }, { available: true });
      expect(checkout).toMatchObject({ plan: "starter", interval: "monthly", promo_plan: "salons-half-off", status: "pending", paid: false });
      expect(await thrown(createCheckoutForApi(context(tx), apiCaller, { plan: "promo", interval: "monthly", promo_code: "SALON51" }, { available: true }))).toMatchObject({ status: 400, details: [{ path: "promo_code" }] });
      expect(await thrown(createCheckoutForApi(context(tx), apiCaller, { plan: "promo", interval: "annual", promo_code: "SALON50" }, { available: true }))).toMatchObject({ status: 409 });
      expect(await thrown(createCheckoutForApi(context(tx), apiCaller, { plan: "promo", interval: "monthly", promo_code: "SALON50" }, { available: false }))).toMatchObject({ status: 409 });
      await as(tx, "owner");
      const [audit] = await rows(tx, sql`select payload from public.audit_logs where business_id = ${businessId}::uuid and event_type = 'api.billing.checkout_started'`);
      expect(audit!.payload).toMatchObject({ plan: "starter", promoPlan: "salons-half-off", interval: "monthly" });
    });
  });
});
