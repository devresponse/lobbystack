import { describe, expect, it } from "vitest";
import { builtInBillingPlanLimits } from "@lobbystack/shared";

import { billingPlanLimits, billingPlanList, polarCheckoutConfigured, polarProductLinks, type BillingCatalogSnapshot, type CatalogPrice, type CatalogStandardPlan } from "./billingPlans";

const plan = (code: CatalogStandardPlan["code"], status: CatalogStandardPlan["status"], extra: Partial<CatalogStandardPlan> = {}): CatalogStandardPlan => ({
  code, status, sold: code === "starter" || code === "pro", custom: code === "enterprise", overage: code !== "free_cloud",
  voice_sec: 9_000, sms_seg: 50, calls_out: 20, chat_units: 50, kb_bytes: 5_242_880, numbers: 1, voice_rate: 20, sms_rate: 2, call_rate: 2,
  sort: { free_cloud: 0, starter: 10, pro: 20, enterprise: 30 }[code], ...extra,
});
const price = (planCode: string, period: CatalogPrice["period"], cents: number, polarId: string | null, extra: Partial<CatalogPrice> = {}): CatalogPrice => ({
  plan: planCode, tier: planCode, status: "active", period, currency: "cad", cents, per_month: period === "annual" ? Math.floor(cents / 12) : cents, polar_id: polarId, retired: false, ...extra,
});
const variables = { POLAR_STARTER_MONTHLY_PRODUCT_ID: "var_starter_month", POLAR_STARTER_ANNUAL_PRODUCT_ID: "var_starter_year", POLAR_PRO_MONTHLY_PRODUCT_ID: " var_pro_month ", POLAR_PRO_ANNUAL_PRODUCT_ID: "" };
const empty: BillingCatalogSnapshot = { plans: [], prices: [] };

describe("Polar product links", () => {
  it("sells through the product variables before the catalog has rows", () => {
    const links = polarProductLinks(empty, variables);
    expect(links.productFor("starter", "monthly")).toBe("var_starter_month");
    expect(links.productFor("pro", "monthly")).toBe("var_pro_month");
    expect(links.productFor("pro", "annual")).toBeNull();
    expect(links.planFor("var_starter_year")).toEqual({ plan: "starter", interval: "annual", code: "starter" });
    expect(links.planFor("var_pro_month")).toEqual({ plan: "pro", interval: "monthly", code: "pro" });
    expect(links.planFor("someone_elses")).toBeNull();
    expect(links.planFor(undefined)).toBeNull();
  });

  it("keeps the variables for a plan no link made active, and only its linked live products once one did", () => {
    const catalog: BillingCatalogSnapshot = {
      plans: [plan("free_cloud", "active"), plan("starter", "draft"), plan("pro", "active")],
      prices: [
        price("starter", "monthly", 3000, null),
        price("pro", "monthly", 10_000, "cat_pro_month"),
        price("pro", "annual", 96_000, null),
        price("pro", "annual", 90_000, "cat_pro_year_old", { retired: true }),
      ],
    };
    const links = polarProductLinks(catalog, variables);
    expect(links.productFor("starter", "monthly")).toBe("var_starter_month");
    expect(links.productFor("pro", "monthly")).toBe("cat_pro_month");
    // A live price nobody linked sells nothing, though a retired one had a product and a variable may name one.
    expect(polarProductLinks(catalog, { POLAR_PRO_ANNUAL_PRODUCT_ID: "var_pro_year" }).productFor("pro", "annual")).toBeNull();
    // A subscriber on a retired price's product keeps its plan.
    expect(links.planFor("cat_pro_year_old")).toEqual({ plan: "pro", interval: "annual", code: "pro" });
    expect(links.planFor("cat_pro_month")).toEqual({ plan: "pro", interval: "monthly", code: "pro" });
    expect(links.planFor("var_pro_month")).toEqual({ plan: "pro", interval: "monthly", code: "pro" });
  });

  it("names an additional plan's product by its tier, and none for a tier Polar doesn't sell", () => {
    const catalog: BillingCatalogSnapshot = { plans: [], prices: [price("pro-launch", "monthly", 6000, "cat_launch", { tier: "pro" }), price("free_cloud", "monthly", 100, "cat_free")] };
    const links = polarProductLinks(catalog, { POLAR_STARTER_MONTHLY_PRODUCT_ID: "cat_free" });
    expect(links.planFor("cat_launch")).toEqual({ plan: "pro", interval: "monthly", code: "pro-launch" });
    expect(links.planFor("cat_free")).toBeNull();
  });

  it("needs Polar's token and organization for any checkout", () => {
    expect(polarCheckoutConfigured({ POLAR_ACCESS_TOKEN: "t", POLAR_ORGANIZATION_ID: "o" })).toBe(true);
    expect(polarCheckoutConfigured({ POLAR_ACCESS_TOKEN: "t" })).toBe(false);
    expect(polarCheckoutConfigured({})).toBe(false);
  });
});

describe("plan list", () => {
  it("shows the built-in plans in US dollars before an apply, sold through the variables", () => {
    const list = billingPlanList(empty, { checkout: true, links: polarProductLinks(empty, variables) });
    expect(list).toMatchObject({ currency: "usd", source: "built_in" });
    const starter = list.plans.find((entry) => entry.slug === "starter")!;
    expect(starter.prices.map((entry) => [entry.interval, entry.amountCents, entry.checkoutAvailable])).toEqual([["monthly", 3000, true], ["annual", 28_800, true]]);
    expect(list.plans.find((entry) => entry.slug === "pro")!.prices.map((entry) => entry.checkoutAvailable)).toEqual([true, false]);
    // Without checkout for this caller, nothing is available.
    expect(billingPlanList(empty, { checkout: false, links: polarProductLinks(empty, variables) }).plans.flatMap((entry) => entry.prices).some((entry) => entry.checkoutAvailable)).toBe(false);
    // Only Free's row isn't enough to switch to the catalog.
    expect(billingPlanList({ plans: [plan("free_cloud", "active")], prices: [] }, { checkout: true, links: polarProductLinks(empty, {}) }).source).toBe("built_in");
  });

  it("shows the catalog's allowances, rates and live prices in its currency, in its order", () => {
    const catalog: BillingCatalogSnapshot = {
      plans: [
        plan("free_cloud", "active", { sold: false, voice_sec: 1_800, sms_seg: 10, calls_out: 2, chat_units: 5, kb_bytes: 1_048_576, numbers: 0, voice_rate: null, sms_rate: null, call_rate: null }),
        plan("pro", "active", { voice_sec: 36_000, voice_rate: 15, sort: 5 }),
        plan("starter", "draft"),
      ],
      prices: [
        price("starter", "monthly", 3500, null),
        price("starter", "annual", 33_600, null),
        price("starter", "monthly", 3000, "old", { retired: true }),
        price("pro", "monthly", 11_000, "cat_pro_month"),
        price("pro-launch", "monthly", 6000, "cat_launch", { tier: "pro" }),
      ],
    };
    const list = billingPlanList(catalog, { checkout: true, links: polarProductLinks(catalog, variables) });
    expect(list).toMatchObject({ currency: "cad", source: "catalog" });
    expect(list.plans.map((entry) => entry.slug)).toEqual(["free_cloud", "pro", "starter", "enterprise"]);
    const [free, pro, starter, enterprise] = list.plans;
    expect(free).toMatchObject({ custom: false, overagesBillable: false, prices: [], included: { voiceSeconds: 1_800, businessNumbers: 0 }, overageRates: { voiceMinuteCents: null } });
    expect(pro).toMatchObject({ sortOrder: 5, included: { voiceSeconds: 36_000 }, overageRates: { voiceMinuteCents: 15 } });
    // A promo plan's price never shows on the standard plan of its tier.
    expect(pro!.prices).toEqual([{ interval: "monthly", currency: "cad", amountCents: 11_000, monthlyAmountCents: 11_000, checkoutAvailable: true }]);
    // Starter isn't linked yet, so the variables sell it, at the catalog's price.
    expect(starter!.prices.map((entry) => [entry.interval, entry.amountCents, entry.monthlyAmountCents, entry.checkoutAvailable])).toEqual([["monthly", 3500, 3500, true], ["annual", 33_600, 2800, true]]);
    // Enterprise is hidden from the app's role, so it keeps its built-in custom terms, unpriced.
    expect(enterprise).toMatchObject({ custom: true, prices: [], included: { voiceSeconds: null }, sortOrder: 30 });
  });
});

describe("plan limits", () => {
  it("enforces the built-in limits before an apply, and while only Free's row is visible", () => {
    expect(billingPlanLimits([])).toBe(builtInBillingPlanLimits);
    expect(billingPlanLimits([plan("free_cloud", "active")])).toBe(builtInBillingPlanLimits);
  });

  it("enforces each readable tier's row once the catalog applies, keeping the built-in terms for the rest", () => {
    const limits = billingPlanLimits([
      plan("free_cloud", "active", { overage: false, voice_sec: 600, sms_seg: 5, calls_out: 1, chat_units: 3, kb_bytes: 524_288, numbers: 1, voice_rate: null, sms_rate: null, call_rate: null }),
      plan("starter", "draft", { voice_sec: 12_000, voice_rate: 25 }),
      plan("pro", "active"),
    ]);
    expect(limits.free_cloud).toEqual({ knowledgeStorageBytes: 524_288, voiceSecondsIncluded: 600, alertSmsSegmentsIncluded: 5, outboundCallAttemptsIncluded: 1, chatAiTokensIncluded: 3, includedBusinessNumbers: 1, overagesBillable: false, voiceOverageRatePerMinuteCents: null, alertSmsOverageRatePerSegmentCents: null, outboundCallAttemptOverageRateCents: null });
    // A draft plan's terms apply, as the plan screens already show them.
    expect(limits.starter).toMatchObject({ voiceSecondsIncluded: 12_000, voiceOverageRatePerMinuteCents: 25, overagesBillable: true });
    // Hidden Enterprise, which the app can't read, and self-hosting keep this build's terms.
    expect(limits.enterprise).toBe(builtInBillingPlanLimits.enterprise);
    expect(limits.self_host).toBe(builtInBillingPlanLimits.self_host);
  });
});
