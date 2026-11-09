import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { billingAccounts, billingPlans } from "@lobbystack/db";

// GET /api/billing with its reads stubbed: what it answers about prepaid packs,
// and the plan's end and waiting change once a pack replaced the subscription.

type Row = Record<string, unknown>;
const fixture = vi.hoisted(() => ({
  account: null as Row | null,
  nextPlan: null as Row | null,
  plan: "free_cloud",
  admin: true,
  packsConfigured: true,
  offers: [] as Row[],
  packs: [] as Row[],
  eligibility: { refusal: null, endsSubscription: null } as Row,
  reads: [] as unknown[],
  loadPackOffers: vi.fn(),
  loadBusinessPacks: vi.fn(),
  packCheckoutEligibility: vi.fn(),
}));

/** A transaction whose selects answer from the fixture by table, recording which tables were read. */
function fakeTransaction(tables: { billingAccounts: unknown; billingPlans: unknown }) {
  const rowsOf = (table: unknown): Row[] => table === tables.billingAccounts ? (fixture.account ? [fixture.account] : []) : table === tables.billingPlans ? (fixture.nextPlan ? [fixture.nextPlan] : []) : [];
  const query = (rows: Row[]) => {
    const chain = { where: () => chain, orderBy: () => chain, limit: async () => rows };
    return chain;
  };
  return { select: () => ({ from: (table: unknown) => { fixture.reads.push(table); return query(rowsOf(table)); } }) };
}

vi.mock("@/lib/api-helpers", async () => {
  const db = await import("@lobbystack/db");
  return {
    asApiResponse: (error: { status?: number; message?: string }) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
    jsonError: (message: string, status: number) => Response.json({ error: message }, { status }),
    readJson: async (request: Request) => await request.json() as unknown,
    requireOperatorBusiness: vi.fn(),
    withOperatorTransaction: async (_request: Request, callback: (input: { session: { user: { id: string } }; businessId: string; tx: unknown }) => Promise<unknown>) => await callback({ session: { user: { id: "user" } }, businessId: "business", tx: fakeTransaction(db) }),
  };
});
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({}) }));
vi.mock("@lobbystack/domain", () => ({
  billingAccess: () => ({ hasBillingManagementAccess: fixture.admin, hasCustomerPortalAccess: false, hasCheckoutAccess: fixture.admin }),
  billingPlanList: () => ({ currency: "usd", plans: [] }),
  deploymentBrandCatalog: () => null,
  getKnowledgeStorageUsageBytes: async () => 0,
  isLiveSubscriptionState: (state: string | null | undefined) => ["active", "trialing", "past_due"].includes(state ?? ""),
  isReplacedSubscription: (account: { subscriptionId: string | null; replacedSubscriptionId?: string | null } | null | undefined) => Boolean(account?.replacedSubscriptionId) && account?.replacedSubscriptionId === account?.subscriptionId,
  loadBillingCatalog: async () => ({ catalog: {}, links: {} }),
  loadBusinessPacks: fixture.loadBusinessPacks,
  loadBusinessPlanLimits: async () => ({ plan: fixture.plan, limits: {} }),
  loadBusinessPromoPlan: async () => null,
  loadPackOffers: fixture.loadPackOffers,
  loadPlanChangePayment: async () => null,
  packCheckoutConfigured: () => fixture.packsConfigured,
  packCheckoutEligibility: fixture.packCheckoutEligibility,
  polarCheckoutConfigured: () => true,
  readUsageStatusInTransaction: async () => null,
  requireBusinessMembership: async () => ({ role: fixture.admin ? "business_owner" : "viewer" }),
  setOverageSpendingCap: vi.fn(),
}));

import { GET } from "./route";

const get = async () => await (await GET(new Request("http://localhost:3000/api/billing?businessId=business"))).json() as Row;
const offer = (code: string, checkoutAvailable = true) => ({ code, names: { en: code }, minutes: 500, voiceSeconds: 30_000, days: 180, amountCents: 9_900, currency: "cad", smsSegments: 50, outboundCalls: 20, chatUnits: 50, knowledgeStorageBytes: 20_971_520, numbers: 1, receptionists: 1, checkoutAvailable });
const subscription = { source: "stripe", customerId: "cus_1", subscriptionId: "sub_1", plan: "starter", billingKey: "business:business", billingInterval: "monthly", subscriptionState: "active", currentPeriodStart: null, currentPeriodEnd: null, overageSpendingCapCents: null, cancelAt: new Date("2026-12-01T00:00:00.000Z"), nextPlanCode: "pro", nextInterval: "monthly", nextChangeAt: new Date("2026-12-01T00:00:00.000Z"), planCode: null, replacedSubscriptionId: null };

beforeEach(() => {
  Object.assign(fixture, { account: null, nextPlan: null, plan: "free_cloud", admin: true, packsConfigured: true, offers: [], packs: [], eligibility: { refusal: null, endsSubscription: null }, reads: [] });
  fixture.loadPackOffers.mockImplementation(async (_tx: unknown, input: { checkout: boolean }) => fixture.offers.map((row) => ({ ...row, checkoutAvailable: input.checkout && row.checkoutAvailable === true })));
  fixture.loadBusinessPacks.mockImplementation(async () => fixture.packs);
  fixture.packCheckoutEligibility.mockImplementation(async () => fixture.eligibility);
});
afterEach(() => { vi.clearAllMocks(); });

describe("the billing summary's prepaid packs", () => {
  it("answers no packs and nothing on sale for a deployment that sells none, without reading whether the business may buy one", async () => {
    const billing = await get();
    expect(billing).toMatchObject({ packOffers: [], packs: [], packCheckout: { refusal: null, endsSubscription: null } });
    expect(fixture.loadPackOffers).toHaveBeenCalledOnce();
    expect(fixture.loadBusinessPacks).toHaveBeenCalledExactlyOnceWith(expect.anything(), "business");
    expect(fixture.packCheckoutEligibility).not.toHaveBeenCalled();
  });

  it("sells the packs a link recorded to those who manage billing, when the provider is set up and nothing refuses", async () => {
    fixture.account = { ...subscription, planCode: "starter-promo" };
    fixture.plan = "starter";
    fixture.offers = [offer("pack-500-180"), offer("pack-500-365", false)];
    fixture.eligibility = { refusal: null, endsSubscription: { plan: "starter", promo: true, periodEnd: new Date("2026-12-01T00:00:00.000Z") } };
    const billing = await get();
    expect((billing.packOffers as Row[]).map((row) => [row.code, row.checkoutAvailable])).toEqual([["pack-500-180", true], ["pack-500-365", false]]);
    expect(billing.packCheckout).toEqual({ refusal: null, endsSubscription: { plan: "starter", promo: true, periodEnd: "2026-12-01T00:00:00.000Z" } });
    // It reads the eligibility from the plan in force and the account row already read.
    expect(fixture.packCheckoutEligibility).toHaveBeenCalledExactlyOnceWith(expect.anything(), { businessId: "business", plan: "starter", account: fixture.account });
    expect(fixture.reads.filter((table) => table === billingAccounts)).toHaveLength(1);
  });

  it("shows the packs on sale but sells none when the business may not buy one, a member asks, or the provider isn't set up", async () => {
    fixture.offers = [offer("pack-500-180")];
    fixture.eligibility = { refusal: "pack_yearly_plan", endsSubscription: null };
    expect(await get()).toMatchObject({ packOffers: [{ code: "pack-500-180", checkoutAvailable: false }], packCheckout: { refusal: "pack_yearly_plan" } });
    fixture.eligibility = { refusal: null, endsSubscription: null };
    fixture.admin = false;
    expect(await get()).toMatchObject({ packOffers: [{ checkoutAvailable: false }] });
    fixture.admin = true;
    fixture.packsConfigured = false;
    expect(await get()).toMatchObject({ packOffers: [{ checkoutAvailable: false }] });
    fixture.packsConfigured = true;
    expect(await get()).toMatchObject({ packOffers: [{ checkoutAvailable: true }] });
  });

  it("reads whether a business holding packs may buy more, even with nothing on sale", async () => {
    fixture.plan = "prepaid";
    fixture.packs = [{ id: "pack", code: "pack-500-180", names: { en: "500 minutes" }, status: "active", secondsTotal: 30_000, secondsLeft: 12_000, paidAt: new Date("2026-10-01T00:00:00.000Z"), endsAt: new Date("2027-03-30T00:00:00.000Z") }];
    const billing = await get();
    expect(billing.packs).toEqual([{ id: "pack", code: "pack-500-180", names: { en: "500 minutes" }, status: "active", secondsTotal: 30_000, secondsLeft: 12_000, paidAt: "2026-10-01T00:00:00.000Z", endsAt: "2027-03-30T00:00:00.000Z" }]);
    expect(fixture.packCheckoutEligibility).toHaveBeenCalledExactlyOnceWith(expect.anything(), { businessId: "business", plan: "prepaid", account: null });
  });

  it("answers no plan end and no waiting change once a pack replaced the subscription, and both while it hasn't", async () => {
    fixture.account = { ...subscription, replacedSubscriptionId: "sub_1" };
    fixture.nextPlan = { tier: "pro", names: null };
    expect(await get()).toMatchObject({ cancelsAt: null, nextChange: null });
    expect(fixture.reads).not.toContain(billingPlans);
    // A pack that replaced an earlier subscription leaves a newer one's dates as they are.
    fixture.account = { ...subscription, replacedSubscriptionId: "sub_0" };
    expect(await get()).toMatchObject({ cancelsAt: "2026-12-01T00:00:00.000Z", nextChange: { plan: "pro", tier: "pro", names: null, interval: "monthly", at: "2026-12-01T00:00:00.000Z" } });
    fixture.account = subscription;
    expect(await get()).toMatchObject({ cancelsAt: "2026-12-01T00:00:00.000Z", nextChange: { plan: "pro" } });
  });

  it("keeps the promo code and the replaced subscription out of the account it answers", async () => {
    fixture.account = { ...subscription, planCode: "starter-promo", replacedSubscriptionId: "sub_1" };
    const account = (await get()).account as Row;
    expect(account).toMatchObject({ subscriptionId: "sub_1", plan: "starter", billingInterval: "monthly" });
    expect(account).not.toHaveProperty("planCode");
    expect(account).not.toHaveProperty("replacedSubscriptionId");
    fixture.account = null;
    expect((await get()).account).toBeNull();
  });
});
