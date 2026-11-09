import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingAccounts, billingCheckoutRequests, billingPackPlans, billingPackPrices, billingPacks, businesses, createDatabaseClient, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { loadBusinessPacks, loadPackOffers, packCheckoutEligibility, type PackEligibilityAccount } from "./billingPackView";
import { loadBusinessPlanLimits } from "./usage";

// What the plan screens read about prepaid packs, against PostgreSQL and read
// as the dashboard reads it: the app role, for a member of the business. Each
// test runs in a transaction that is rolled back, with pack codes of its own,
// since the catalog belongs to the whole database.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Prepaid pack view integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const DAY = 86_400_000;
const names = { en: "500 minutes", fr: "500 minutes", es: "500 minutos", sr: "500 minuta" };

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

type Member = { businessId: string; userId: string };

/** Runs a read as GET /api/billing does: the app role, as a member of the business. */
async function asMember<T>(tx: DatabaseTransaction, member: Member, run: (scoped: DatabaseTransaction) => Promise<T>): Promise<T> {
  await tx.execute(sql`set local role lobbystack_app`);
  try {
    return await withBusinessTransaction(tx as unknown as Database, { userId: member.userId, businessId: member.businessId, actorType: "operator" }, run);
  } finally {
    await tx.execute(sql`reset role`);
  }
}

/** A business, its owner, and a billing account with the fields given, or none when account is null. */
async function business(tx: DatabaseTransaction, input: { deploymentMode?: string; account?: Partial<typeof billingAccounts.$inferInsert> | null } = {}): Promise<Member> {
  const businessId = randomUUID();
  const userId = randomUUID();
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Pack view test", timezone: "UTC", businessType: "test", telemetryEnabled: false, deploymentMode: input.deploymentMode ?? "cloud" });
  await tx.insert(users).values({ id: userId, email: `pack-view-${userId}@example.invalid`, normalizedEmail: `pack-view-${userId}@example.invalid`, name: "Pack view owner" });
  await tx.execute(sql`insert into public.business_memberships (business_id, user_id, role, status) values (${businessId}::uuid, ${userId}::uuid, 'business_owner', 'active')`);
  if (input.account !== null) await tx.insert(billingAccounts).values({ businessId, billingKey: `test:${businessId}`, plan: "free_cloud", ...input.account });
  return { businessId, userId };
}

/** A pack in the catalog, with a price unless price is false. */
async function catalogPack(tx: DatabaseTransaction, input: { code: string; status?: "draft" | "active" | "retired"; sort?: number; voiceSec?: number; days?: number | null; cents?: number; providerRef?: string | null; price?: boolean; priceRetired?: boolean }) {
  const status = input.status ?? "active";
  await tx.insert(billingPackPlans).values({ code: input.code, status, names, voiceSec: input.voiceSec ?? 30_000, days: input.days === undefined ? 180 : input.days, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, termsHash: "0".repeat(64), sort: input.sort ?? 100, retiredAt: status === "retired" ? new Date() : null });
  if (input.price === false) return;
  await tx.insert(billingPackPrices).values({ pack: input.code, currency: "cad", cents: input.cents ?? 9_900, providerRef: input.providerRef === undefined ? `price_${randomUUID()}` : input.providerRef, retiredAt: input.priceRetired ? new Date() : null });
}

/** A pack the business bought `paidDaysAgo` days ago, lasting `days`, null for one that never ends. */
async function heldPack(tx: DatabaseTransaction, businessId: string, input: { code: string; seconds: number; used?: number; days?: number | null; paidDaysAgo?: number; amountCents?: number; refundedCents?: number; status?: "active" | "frozen" | "expired" | "replaced" | "refunded" }) {
  const days = input.days === undefined ? 90 : input.days;
  const paidAt = new Date(Date.now() - (input.paidDaysAgo ?? 1) * DAY);
  const status = input.status ?? "active";
  const ended = status === "expired" || status === "replaced" || status === "refunded";
  const [row] = await tx.insert(billingPacks).values({ businessId, pack: input.code, days, provider: "stripe", providerRef: `pi_${randomUUID()}`, amountCents: input.amountCents ?? 9_900, refundedCents: input.refundedCents ?? 0, currency: "cad", secondsTotal: input.seconds, secondsUsed: input.used ?? 0, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, paidAt, endsAt: days === null ? null : new Date(paidAt.getTime() + days * DAY), status, endedAt: ended ? new Date() : null, unusedSeconds: ended ? 0 : null }).returning({ id: billingPacks.id });
  return row!.id;
}

/** A promo plan of a tier, as a code unlocks it. */
async function promoPlan(tx: DatabaseTransaction, code: string, tier: "starter" | "pro") {
  await tx.execute(sql`insert into public.billing_plans (code, tier, status, access, names, voice_sec, sms_seg, calls_out, chat_units, kb_bytes, numbers, terms_hash)
    values (${code}, ${tier}, 'active', 'code', ${JSON.stringify(names)}::jsonb, 18000, 50, 20, 50, 5242880, 1, ${"0".repeat(64)})`);
}

const suffix = () => randomUUID().slice(0, 8);
type Subscription = { plan: string; planCode?: string | null; subscriptionState: string; billingInterval: string; subscriptionId: string; currentPeriodEnd: Date | null };
/** A live monthly Starter subscription, with the fields given instead. */
const subscription = (input: Partial<Subscription> = {}): Subscription => ({ plan: "starter", subscriptionState: "active", billingInterval: "monthly", subscriptionId: `sub_${randomUUID()}`, currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"), ...input });

describe.skipIf(!testUrl)("what the plan screens read about prepaid packs", () => {
  it("lists only the packs on sale, each active with a live price, by sort and then code, and sells only those a link recorded when the caller may buy", async () => {
    await rollbackTest(async (tx) => {
      const tag = suffix();
      await catalogPack(tx, { code: `view-b-${tag}`, sort: 10, voiceSec: 15_000, days: 90, cents: 4_900 });
      await catalogPack(tx, { code: `view-c-${tag}`, sort: 10, days: null, providerRef: null });
      await catalogPack(tx, { code: `view-a-${tag}`, sort: 20 });
      await catalogPack(tx, { code: `view-draft-${tag}`, status: "draft" });
      await catalogPack(tx, { code: `view-retired-${tag}`, status: "retired", priceRetired: true });
      await catalogPack(tx, { code: `view-old-price-${tag}`, priceRetired: true });
      await catalogPack(tx, { code: `view-unpriced-${tag}`, price: false });
      const member = await business(tx);
      const mine = <T extends { code: string }>(offers: T[]) => offers.filter((offer) => offer.code.endsWith(tag));

      const offers = mine(await asMember(tx, member, (scoped) => loadPackOffers(scoped, { checkout: true })));
      expect(offers.map((offer) => offer.code)).toEqual([`view-b-${tag}`, `view-c-${tag}`, `view-a-${tag}`]);
      expect(offers[0]).toEqual({ code: `view-b-${tag}`, names, minutes: 250, voiceSeconds: 15_000, days: 90, amountCents: 4_900, currency: "cad", smsSegments: 50, outboundCalls: 20, chatUnits: 50, knowledgeStorageBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, checkoutAvailable: true });
      // A pack that never ends, which no link recorded at the provider yet, shows but can't be bought.
      expect(offers[1]).toMatchObject({ days: null, minutes: 500, checkoutAvailable: false });
      // Nothing is for sale to a caller who may not buy.
      const shown = mine(await asMember(tx, member, (scoped) => loadPackOffers(scoped, { checkout: false })));
      expect(shown.map((offer) => offer.checkoutAvailable)).toEqual([false, false, false]);
    });
  });

  it("lists the business's live and frozen packs with time left, the one that ends first first and one that never ends last, with the seconds each holds after refunds", async () => {
    await rollbackTest(async (tx) => {
      const code = `view-held-${suffix()}`;
      await catalogPack(tx, { code });
      const member = await business(tx);
      const later = await heldPack(tx, member.businessId, { code, seconds: 30_000, used: 6_000, days: 60 });
      const never = await heldPack(tx, member.businessId, { code, seconds: 15_000, days: null });
      // Half refunded: it holds half its seconds, less what calls drew.
      const soon = await heldPack(tx, member.businessId, { code, seconds: 3_000, used: 1_000, days: 10, amountCents: 10_000, refundedCents: 5_000 });
      const frozen = await heldPack(tx, member.businessId, { code, seconds: 6_000, days: 30, status: "frozen" });
      for (const status of ["expired", "replaced", "refunded"] as const) await heldPack(tx, member.businessId, { code, seconds: 6_000, status });
      // Its end came, but the daily job hasn't ended it yet.
      await heldPack(tx, member.businessId, { code, seconds: 6_000, days: 10, paidDaysAgo: 11 });
      const other = await business(tx);
      await heldPack(tx, other.businessId, { code, seconds: 6_000 });

      const packs = await asMember(tx, member, (scoped) => loadBusinessPacks(scoped, member.businessId));
      expect(packs.map((pack) => pack.id)).toEqual([soon, frozen, later, never]);
      expect(packs[0]).toEqual({ id: soon, code, names, status: "active", secondsTotal: 1_500, secondsLeft: 500, paidAt: expect.any(Date), endsAt: expect.any(Date) });
      expect(packs[1]).toMatchObject({ status: "frozen", secondsTotal: 6_000, secondsLeft: 6_000 });
      expect(packs[2]).toMatchObject({ secondsTotal: 30_000, secondsLeft: 24_000 });
      expect(packs[3]).toMatchObject({ secondsTotal: 15_000, secondsLeft: 15_000, endsAt: null });
      // A member of another business reads none of them.
      expect(await asMember(tx, other, (scoped) => loadBusinessPacks(scoped, member.businessId))).toEqual([]);
      expect(await asMember(tx, await business(tx), (scoped) => loadBusinessPacks(scoped, other.businessId))).toEqual([]);
    });
  });

  it("refuses a pack in the checkout's order: a managed plan, then a self-hosted deployment or Enterprise, then a yearly, past-due or waiting subscription", async () => {
    await rollbackTest(async (tx) => {
      const eligibility = async (member: Member) => await asMember(tx, member, (scoped) => packCheckoutEligibility(scoped, { businessId: member.businessId }));
      // A managed plan is refused first, even with a yearly subscription beside it.
      expect(await eligibility(await business(tx, { account: { source: "managed", plan: "enterprise", subscriptionState: "active", billingInterval: "annual" } }))).toEqual({ refusal: "managed_plan", endsSubscription: null });
      expect(await eligibility(await business(tx, { deploymentMode: "self_host" }))).toEqual({ refusal: "pack_not_sold_on_plan", endsSubscription: null });
      expect(await eligibility(await business(tx, { account: subscription({ plan: "enterprise", billingInterval: "annual" }) }))).toEqual({ refusal: "pack_not_sold_on_plan", endsSubscription: null });
      for (const billingInterval of ["annual", "year"]) {
        expect(await eligibility(await business(tx, { account: subscription({ plan: "pro", billingInterval, subscriptionState: "past_due" }) }))).toEqual({ refusal: "pack_yearly_plan", endsSubscription: null });
      }
      expect(await eligibility(await business(tx, { account: subscription({ subscriptionState: "past_due" }) }))).toEqual({ refusal: "pack_past_due", endsSubscription: null });
      // An upgrade waiting on its payment page, as the plan card's Complete payment shows it.
      const account = subscription();
      const waiting = await business(tx, { account });
      await tx.insert(billingCheckoutRequests).values({ businessId: waiting.businessId, requestedByUserId: waiting.userId, target: "pro", billingInterval: "monthly", status: "ready", checkoutId: account.subscriptionId, checkoutUrl: "https://invoice.stripe.com/i/in_test" });
      expect(await eligibility(waiting)).toEqual({ refusal: "plan_change_payment_waiting", endsSubscription: null });
    });
  });

  it("says which monthly subscription a pack would end, whether it is a promo plan, and when its paid period ends", async () => {
    await rollbackTest(async (tx) => {
      const eligibility = async (member: Member) => await asMember(tx, member, (scoped) => packCheckoutEligibility(scoped, { businessId: member.businessId }));
      expect(await eligibility(await business(tx, { account: subscription() }))).toEqual({ refusal: null, endsSubscription: { plan: "starter", promo: false, periodEnd: new Date("2026-12-01T00:00:00.000Z") } });
      const promo = `pro-view-${suffix()}`;
      await promoPlan(tx, promo, "pro");
      expect(await eligibility(await business(tx, { account: subscription({ plan: "pro", planCode: promo, subscriptionState: "trialing", currentPeriodEnd: null }) }))).toEqual({ refusal: null, endsSubscription: { plan: "pro", promo: true, periodEnd: null } });
      // Free, a lapsed plan and a business with no billing account yet end nothing.
      expect(await eligibility(await business(tx))).toEqual({ refusal: null, endsSubscription: null });
      expect(await eligibility(await business(tx, { account: subscription({ subscriptionState: "canceled" }) }))).toEqual({ refusal: null, endsSubscription: null });
      expect(await eligibility(await business(tx, { account: null }))).toEqual({ refusal: null, endsSubscription: null });
    });
  });

  it("counts a subscription a pack replaced as ended, so a business on a pack may buy another whatever that subscription was", async () => {
    await rollbackTest(async (tx) => {
      const code = `view-replaced-${suffix()}`;
      await catalogPack(tx, { code });
      const eligibility = async (member: Member) => await asMember(tx, member, (scoped) => packCheckoutEligibility(scoped, { businessId: member.businessId }));
      const yearly = subscription({ plan: "pro", billingInterval: "annual", subscriptionState: "past_due" });
      const replaced = await business(tx, { account: { ...yearly, replacedSubscriptionId: yearly.subscriptionId } });
      await heldPack(tx, replaced.businessId, { code, seconds: 30_000 });
      expect(await eligibility(replaced)).toEqual({ refusal: null, endsSubscription: null });
      // The replaced subscription doesn't hold the business on its plan: the pack's tier is in force.
      expect((await asMember(tx, replaced, (scoped) => loadBusinessPlanLimits(scoped, replaced.businessId))).plan).toBe("prepaid");
      // A newer subscription than the one a pack replaced is live again.
      const newer = subscription();
      expect(await eligibility(await business(tx, { account: { ...newer, replacedSubscriptionId: `sub_${randomUUID()}` } }))).toEqual({ refusal: null, endsSubscription: { plan: "starter", promo: false, periodEnd: newer.currentPeriodEnd } });
    });
  });

  it("answers the same from the plan and the billing account its caller already read", async () => {
    await rollbackTest(async (tx) => {
      const account = subscription({ plan: "pro" });
      const member = await business(tx, { account });
      const row: PackEligibilityAccount = { source: null, plan: account.plan, planCode: null, subscriptionId: account.subscriptionId, subscriptionState: account.subscriptionState, replacedSubscriptionId: null, billingInterval: account.billingInterval, currentPeriodEnd: account.currentPeriodEnd };
      const read = await asMember(tx, member, (scoped) => packCheckoutEligibility(scoped, { businessId: member.businessId }));
      const given = await asMember(tx, member, (scoped) => packCheckoutEligibility(scoped, { businessId: member.businessId, plan: "pro", account: row }));
      expect(given).toEqual(read);
      expect(given.endsSubscription).toEqual({ plan: "pro", promo: false, periodEnd: account.currentPeriodEnd });
      // A caller that read no account row passes null, which reads nothing more.
      expect(await asMember(tx, member, (scoped) => packCheckoutEligibility(scoped, { businessId: member.businessId, plan: "free_cloud", account: null }))).toEqual({ refusal: null, endsSubscription: null });
    });
  });
});
