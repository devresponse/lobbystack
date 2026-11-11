import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hostedCheckoutPlanSlugs } from "./billing";
import { accountBusinessCap, billingProfileForProvider, billingProfileSchema, billingProfileForCatalog, canonicalBillingProfileJson, highestBusinessCap, normalizeBillingProfile, packTermsJson, planBusinessCap, planTermsJson, resolveBillingPacks, resolveBillingPlans, type BillingProfile, type ResolvedBillingPack, type ResolvedBillingPlan } from "./billingProfile";

const fileText = readFileSync(new URL("../../../brands/alloplace/billing.json", import.meta.url), "utf8");
const alloplace = (): Record<string, any> => JSON.parse(fileText);
// The example file of plans and packs: RealInfoBot's file before it moved to listing packs on 2026-11-10,
// with Starter and Pro sold, nine packs, and a display section that copies the built-in words.
const plansAndPacksText = readFileSync(new URL("./brands/testing/plans-and-packs.billing.json", import.meta.url), "utf8");
const plansAndPacks = (): Record<string, any> => JSON.parse(plansAndPacksText);

// The additional plans of the design's examples: a promo with more minutes, a money-off promo and a public plan.
const examples = {
  "pro-launch": {
    tier: "pro",
    access: "code",
    names: { en: "Pro launch offer", fr: "Offre de lancement Pro", es: "Oferta de lanzamiento Pro", sr: "Pro ponuda za lansiranje" },
    sold: true,
    prices: { monthlyCents: 6000 },
    included: { voiceMinutes: 600 },
    months: 6,
    endsWith: "tier",
    offerEndsAt: "2027-03-31T23:59:59-04:00",
  },
  "salons-half-off": {
    tier: "starter",
    access: "code",
    names: { en: "Salon offer", fr: "Offre salons", es: "Oferta para salones", sr: "Ponuda za salone" },
    sold: true,
    prices: { monthlyCents: 3000 },
    discount: { type: "percentage", basisPoints: 5000, duration: "repeating", durationInMonths: 3 },
  },
  "pro-plus": {
    tier: "pro",
    access: "public",
    names: { en: "Pro Plus", fr: "Pro Plus", es: "Pro Plus", sr: "Pro Plus" },
    sold: true,
    prices: { monthlyCents: 15000, annualCents: 144000 },
    included: { voiceMinutes: 1000, alertSmsSegments: 400 },
  },
};

function withPlans(plans: Record<string, unknown>, change: (file: Record<string, any>) => void = () => undefined): Record<string, any> {
  const file = alloplace();
  Object.assign(file.plans, plans);
  change(file);
  return file;
}

function parse(file: unknown): BillingProfile {
  return billingProfileSchema.parse(file);
}

/** Each problem as "path: message". */
function problems(file: unknown): string[] {
  const result = billingProfileSchema.safeParse(file);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function plan(file: unknown, code: string): ResolvedBillingPlan {
  return resolveBillingPlans(parse(file)).find((row) => row.code === code)!;
}

const profileHash = (file: unknown) => createHash("sha256").update(canonicalBillingProfileJson(parse(file))).digest("hex");
const termsHash = (file: unknown, code: string) => createHash("sha256").update(planTermsJson(plan(file, code))).digest("hex");

const name = (text: string) => ({ en: text, fr: text, es: text, sr: text });
const extra = (overrides: Record<string, unknown> = {}) => ({ tier: "pro", access: "code", names: name("Extra"), sold: true, prices: { monthlyCents: 5000 }, ...overrides });

describe("the AlloPlace billing.json", () => {
  // Limits read the catalog, so its numbers may change; the shape of each tier may not.
  it("resolves to the four standard plans, sold, custom and billed past their allowances as their tiers are", () => {
    const rows = resolveBillingPlans(parse(alloplace()));
    expect(rows.map((row) => row.code)).toEqual(["free_cloud", "starter", "pro", "enterprise"]);
    for (const row of rows) {
      const sold = (hostedCheckoutPlanSlugs as readonly string[]).includes(row.code);
      const allowances = [row.voice_sec, row.sms_seg, row.calls_out, row.chat_units, row.kb_bytes, row.numbers];
      expect({
        sold: row.sold,
        custom: row.custom,
        overage: row.overage,
        allowancesSet: allowances.every((value) => value !== null),
        ratesSet: [row.voice_rate, row.sms_rate, row.call_rate].every((value) => value !== null),
        periods: row.prices.map((price) => price.period).sort(),
      }, row.code).toEqual({
        sold,
        custom: row.tier === "enterprise",
        overage: row.tier !== "free_cloud",
        allowancesSet: row.tier !== "enterprise",
        ratesSet: sold,
        periods: sold ? ["annual", "monthly"] : [],
      });
    }
    expect(rows.every((row) => row.prices.every((price) => price.currency === "cad"))).toBe(true);
  });

  it("makes the standard plans' rows from their keys", () => {
    const rows = resolveBillingPlans(parse(alloplace()));
    expect(rows.map(({ code, tier, access, custom, names, sort }) => ({ code, tier, access, custom, names, sort }))).toEqual([
      { code: "free_cloud", tier: "free_cloud", access: "public", custom: false, names: null, sort: 10 },
      { code: "starter", tier: "starter", access: "public", custom: false, names: null, sort: 20 },
      { code: "pro", tier: "pro", access: "public", custom: false, names: null, sort: 30 },
      { code: "enterprise", tier: "enterprise", access: "hidden", custom: true, names: null, sort: 40 },
    ]);
  });

  it("parses the design's three example plans and resolves them", () => {
    const file = withPlans(examples);
    expect(problems(file)).toEqual([]);
    const launch = plan(file, "pro-launch");
    expect(launch).toMatchObject({ tier: "pro", access: "code", sold: true, voice_sec: 36_000, sms_seg: 200, calls_out: 100, chat_units: 200, kb_bytes: 20_971_520, numbers: 1, voice_rate: 18, months: 6, ends: "tier", offer_end: "2027-04-01T03:59:59.000Z", sort: 100, prices: [{ period: "monthly", currency: "cad", cents: 6000 }] });
    expect(plan(file, "salons-half-off").discount).toEqual({ type: "percentage", basis_points: 5000, duration: "repeating", duration_in_months: 3 });
    expect(plan(file, "pro-plus")).toMatchObject({ access: "public", voice_sec: 60_000, sms_seg: 400, calls_out: 100 });
    expect(resolveBillingPlans(parse(file)).map((row) => row.code)).toEqual(["free_cloud", "starter", "pro", "enterprise", "pro-launch", "pro-plus", "salons-half-off"]);
  });
});

describe("billingProfileSchema", () => {
  it("runs each check across fields with the path to fix", () => {
    // C1: a year costs no more than twelve months.
    expect(problems(withPlans({}, (file) => { file.plans.pro.prices.annualCents = 120_001; }))).toEqual([expect.stringMatching(/^plans\.pro\.prices\.annualCents: the annual price is more than 12 monthly prices/)]);
    // C2: a sold plan has a price.
    expect(problems(withPlans({}, (file) => { file.plans.starter.prices = {}; }))).toEqual([expect.stringMatching(/^plans\.starter\.prices: /)]);
    expect(problems(withPlans({ extra: extra({ prices: {} }) }))).toEqual([expect.stringMatching(/^plans\.extra\.prices: /)]);
    // C3: codes follow the pattern, and a file holds at most 50 additional plans.
    expect(problems(withPlans({ "Pro-Launch": extra() }))).toEqual([expect.stringMatching(/^plans\.Pro-Launch: a plan code is/)]);
    expect(problems(withPlans({ ab: extra(), "-x-": extra() }))).toHaveLength(2);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`extra-${String(index).padStart(2, "0")}`, extra()]));
    expect(problems(withPlans(many))).toEqual([expect.stringMatching(/^plans\.extra-50: a file holds at most 50 plans/)]);
    expect(problems(withPlans(Object.fromEntries(Object.entries(many).slice(0, 50))))).toEqual([]);
    // C4: the tier is sold, and so is every period the plan prices.
    expect(problems(withPlans({ extra: extra({ prices: { annualCents: 50_000 } }) }, (file) => { delete file.plans.pro.prices.annualCents; }))).toEqual([expect.stringMatching(/^plans\.extra\.prices\.annualCents: pro has no annual price/)]);
    expect(problems(withPlans({ extra: extra() }, (file) => {
      file.plans.pro = { sold: false, included: file.plans.pro.included, limits: file.plans.pro.limits, overageCents: file.plans.pro.overageCents };
    }))).toEqual([expect.stringMatching(/^plans\.extra\.tier: pro isn't sold/)]);
    // C5: months and endsWith come together.
    expect(problems(withPlans({ extra: extra({ months: 3 }) }))).toEqual([expect.stringMatching(/^plans\.extra\.endsWith: /)]);
    expect(problems(withPlans({ extra: extra({ endsWith: "keep" }) }))).toEqual([expect.stringMatching(/^plans\.extra\.endsWith: /)]);
    // C6: durationInMonths exactly with a repeating discount.
    expect(problems(withPlans({ extra: extra({ discount: { type: "percentage", basisPoints: 1000, duration: "repeating" } }) }))).toEqual([expect.stringMatching(/^plans\.extra\.discount\.durationInMonths: /)]);
    expect(problems(withPlans({ extra: extra({ discount: { type: "percentage", basisPoints: 1000, duration: "once", durationInMonths: 2 } }) }))).toEqual([expect.stringMatching(/^plans\.extra\.discount\.durationInMonths: /)]);
    // C7: a fixed discount is no more than the lowest price.
    expect(problems(withPlans({ extra: extra({ discount: { type: "fixed", amountCents: 5001, duration: "once" } }) }))).toEqual([expect.stringMatching(/^plans\.extra\.discount\.amountCents: the discount is more than the plan's lowest price \(5000\)/)]);
    expect(problems(withPlans({ extra: extra({ discount: { type: "fixed", amountCents: 5000, duration: "once" } }) }))).toEqual([]);
  });

  it("refuses what the shapes don't allow", () => {
    const refused = (file: unknown, path: RegExp) => expect(problems(file).some((problem) => path.test(problem)), `${path} in ${problems(file).join("; ")}`).toBe(true);
    refused(withPlans({}, (file) => { file.colour = "red"; }), /^: Unrecognized key/);
    refused(withPlans({}, (file) => { file.plans.starter.included.minutes = 1; }), /^plans\.starter\.included: Unrecognized key/);
    refused(withPlans({}, (file) => { file.version = 2; }), /^version: /);
    refused(withPlans({}, (file) => { file.currency = "CAD"; }), /^currency: three lowercase letters/);
    // Only sold starter and pro plans can have additional plans.
    refused(withPlans({ extra: extra({ tier: "free_cloud" }) }), /^plans\.extra\.tier: /);
    refused(withPlans({ extra: extra({ tier: "enterprise" }) }), /^plans\.extra\.tier: /);
    refused(withPlans({ extra: extra({ sold: false }) }), /^plans\.extra\.sold: /);
    refused(withPlans({ extra: extra({ names: { en: "Extra", fr: "Extra", es: "Extra" } }) }), /^plans\.extra\.names\.sr: /);
    refused(withPlans({ extra: extra({ names: name(" ") }) }), /^plans\.extra\.names\.en: /);
    refused(withPlans({}, (file) => { file.plans.enterprise.prices = { monthlyCents: 1000 }; }), /^plans\.enterprise: Unrecognized key/);
    refused(withPlans({}, (file) => { delete file.plans.free_cloud; }), /^plans\.free_cloud: /);
    refused(withPlans({ extra: extra({ offerEndsAt: "2027-03-31" }) }), /^plans\.extra\.offerEndsAt: /);
    refused(withPlans({}, (file) => { file.plans.free_cloud.included.voiceMinutes = 1.5; }), /^plans\.free_cloud\.included\.voiceMinutes: /);
    // A business holds one number at most.
    refused(withPlans({}, (file) => { file.plans.pro.limits.businessNumbers = 2; }), /^plans\.pro\.limits\.businessNumbers: /);
    refused(withPlans({ extra: extra({ limits: { businessNumbers: 2 } }) }), /^plans\.extra\.limits\.businessNumbers: /);
  });
});

describe("the file as each provider sells it", () => {
  const brandFile = (brand: string): unknown => JSON.parse(readFileSync(new URL(`../../../brands/${brand}/billing.json`, import.meta.url), "utf8"));

  it.each(["alloplace", "realinfobot"])("still passes the schema for %s, on Polar and on Stripe", (brand) => {
    const file = parse(brandFile(brand));
    expect(problems(billingProfileForProvider(file, "polar"))).toEqual([]);
    expect(problems(billingProfileForProvider(file, "stripe"))).toEqual([]);
  });

  it("still passes the schema once Stripe, with overage on the checkout, drops the yearly prices and the plans with only those", () => {
    const file = parse(withPlans({
      "pro-yearly": extra({ prices: { annualCents: 80000 } }),
      "starter-yearly": extra({ tier: "starter", prices: { annualCents: 30000 } }),
      "starter-launch": extra({ tier: "starter", prices: { monthlyCents: 3000, annualCents: 30000 }, discount: { type: "fixed", amountCents: 2000, duration: "once" } }),
    }, (raw) => {
      raw.plans.pro.prices = { annualCents: 87000 };
      raw.stripe = { ...raw.stripe, overage: "checkout", managedPayments: true };
    }));
    const onStripe = billingProfileForProvider(file, "stripe");
    expect(problems(onStripe)).toEqual([]);
    // Pro has only a yearly price, so it isn't sold, and neither plan with only a yearly price is offered.
    expect(onStripe.plans.pro).toMatchObject({ sold: false });
    expect(Object.keys(onStripe.plans)).not.toContain("pro-yearly");
    expect(Object.keys(onStripe.plans)).not.toContain("starter-yearly");
    expect(onStripe.plans["starter-launch"]).toMatchObject({ prices: { monthlyCents: 3000 } });
    expect(JSON.stringify(onStripe.plans)).not.toContain("annualCents");
    // Polar sells the file as it is.
    expect(billingProfileForProvider(file, "polar")).toBe(file);
  });
});

describe("resolveBillingPlans", () => {
  it("fills an additional plan's missing values from its tier, and keeps the ones it sets", () => {
    const file = withPlans({ extra: extra({ included: { voiceMinutes: 700 }, limits: { businessNumbers: 0 }, overageCents: { voiceMinute: 15 } }) });
    expect(plan(file, "extra")).toMatchObject({
      voice_sec: 42_000,
      sms_seg: 200,
      calls_out: 100,
      chat_units: 200,
      kb_bytes: 20 * 1_048_576,
      numbers: 0,
      voice_rate: 15,
      sms_rate: 2,
      call_rate: 2,
      overage: true,
      custom: false,
      months: null,
      ends: null,
      offer_end: null,
      discount: null,
    });
    // A starter-based plan takes Starter's values.
    expect(plan(withPlans({ extra: extra({ tier: "starter", prices: { monthlyCents: 2000 } }) }), "extra")).toMatchObject({ voice_sec: 9_000, sms_seg: 50, kb_bytes: 5 * 1_048_576, voice_rate: 20 });
  });

  it("trims names and stores a fixed discount in snake case", () => {
    const file = withPlans({ extra: extra({ names: { en: " Spring ", fr: "Printemps", es: "Primavera", sr: "Proleće" }, discount: { type: "fixed", amountCents: 500, duration: "forever" } }) });
    expect(plan(file, "extra")).toMatchObject({ names: { en: "Spring", fr: "Printemps", es: "Primavera", sr: "Proleće" }, discount: { type: "fixed", amount_cents: 500, duration: "forever" } });
  });
});

describe("the profile hash", () => {
  it("ignores key order, whitespace and $schema", () => {
    const base = profileHash(alloplace());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const reordered = alloplace();
    const { plans, ...rest } = reordered;
    expect(profileHash({ plans: Object.fromEntries(Object.entries(plans as Record<string, unknown>).reverse()), ...Object.fromEntries(Object.entries(rest).reverse()) })).toBe(base);
    expect(profileHash(JSON.parse(JSON.stringify(alloplace())))).toBe(base);
    const { $schema: _hint, ...withoutHint } = alloplace();
    expect(profileHash(withoutHint)).toBe(base);
    expect(profileHash({ ...alloplace(), $schema: "https://example.com/other.json" })).toBe(base);
    expect(normalizeBillingProfile(parse(alloplace()))).not.toHaveProperty("$schema");
  });

  it("changes when any value changes", () => {
    const base = profileHash(alloplace());
    const changed = [
      withPlans({}, (file) => { file.currency = "usd"; }),
      withPlans({}, (file) => { file.polar.portalPlanChanges = false; }),
      withPlans({}, (file) => { file.plans.pro.prices.monthlyCents = 10_001; }),
      withPlans({}, (file) => { file.plans.free_cloud.limits.businessNumbers = 1; }),
      withPlans({ extra: extra() }),
    ].map(profileHash);
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
  });
});

describe("receptionists per plan", () => {
  it("reads each standard plan's number from the file, and its tier's built-in number when the file has none", () => {
    expect(["free_cloud", "starter", "pro", "enterprise"].map((code) => plan(alloplace(), code).receptionists)).toEqual([1, 1, 5, null]);
    const older = alloplace();
    for (const code of ["free_cloud", "starter", "pro"]) delete older.plans[code].limits.receptionists;
    expect(["free_cloud", "starter", "pro", "enterprise"].map((code) => plan(older, code).receptionists)).toEqual([1, 1, 5, null]);
    const chain = withPlans({}, (file) => { file.plans.pro.limits.receptionists = 12; });
    expect(plan(chain, "pro").receptionists).toBe(12);
  });

  it("gives an additional plan its tier's number unless it sets its own", () => {
    const file = withPlans({ inherits: extra(), sets: extra({ limits: { receptionists: 20 } }) });
    expect(plan(file, "inherits").receptionists).toBe(5);
    expect(plan(file, "sets").receptionists).toBe(20);
  });

  it("allows 1 to 50 receptionists in a plan", () => {
    expect(problems(withPlans({}, (file) => { file.plans.pro.limits.receptionists = 0; }))).toEqual([expect.stringContaining("plans.pro.limits.receptionists")]);
    expect(problems(withPlans({}, (file) => { file.plans.pro.limits.receptionists = 51; }))).toEqual([expect.stringContaining("plans.pro.limits.receptionists")]);
    expect(problems(withPlans({}, (file) => { file.plans.pro.limits.receptionists = 2.5; }))).toEqual([expect.stringContaining("plans.pro.limits.receptionists")]);
    expect(problems(withPlans({}, (file) => { file.plans.pro.limits.receptionists = 50; }))).toEqual([]);
  });

  it("leaves the number out of the terms hash, so plans with subscribers can change it", () => {
    const base = termsHash(alloplace(), "pro");
    expect(termsHash(withPlans({}, (file) => { file.plans.pro.limits.receptionists = 9; }), "pro")).toBe(base);
    const older = alloplace();
    delete older.plans.pro.limits.receptionists;
    expect(termsHash(older, "pro")).toBe(base);
    expect(planTermsJson(plan(alloplace(), "pro"))).not.toContain("receptionists");
  });
});

describe("the terms hash", () => {
  it("ignores names, access, offerEndsAt and sort", () => {
    const base = termsHash(withPlans({ extra: extra() }), "extra");
    expect(termsHash(withPlans({ extra: extra({ names: name("Renamed") }) }), "extra")).toBe(base);
    expect(termsHash(withPlans({ extra: extra({ access: "public" }) }), "extra")).toBe(base);
    expect(termsHash(withPlans({ extra: extra({ offerEndsAt: "2027-01-01T00:00:00Z" }) }), "extra")).toBe(base);
    const moved: ResolvedBillingPlan = { ...plan(withPlans({ extra: extra() }), "extra"), sort: 5 };
    expect(createHash("sha256").update(planTermsJson(moved)).digest("hex")).toBe(base);
  });

  it("changes with every other field", () => {
    const base = termsHash(withPlans({ extra: extra() }), "extra");
    const changed = [
      extra({ tier: "starter" }),
      extra({ prices: { monthlyCents: 5001 } }),
      extra({ prices: { monthlyCents: 5000, annualCents: 50_000 } }),
      extra({ included: { voiceMinutes: 1 } }),
      extra({ included: { alertSmsSegments: 1 } }),
      extra({ included: { outboundCallAttempts: 1 } }),
      extra({ included: { chatAiUnits: 1 } }),
      extra({ limits: { knowledgeStorageMb: 1 } }),
      extra({ limits: { businessNumbers: 0 } }),
      extra({ overageCents: { voiceMinute: 1 } }),
      extra({ overageCents: { alertSmsSegment: 1 } }),
      extra({ overageCents: { outboundCallAttempt: 1 } }),
      extra({ months: 3, endsWith: "tier" }),
      extra({ months: 3, endsWith: "cancel" }),
      extra({ discount: { type: "percentage", basisPoints: 1000, duration: "once" } }),
    ].map((entry) => termsHash(withPlans({ extra: entry }), "extra"));
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
    expect(termsHash(withPlans({ extra: extra() }, (file) => { file.currency = "usd"; }), "extra")).not.toBe(base);
  });

  it("changes for a plan that inherits a value when its tier's value changes, and not for one that sets its own", () => {
    const before = withPlans({ inherits: extra(), sets: extra({ included: { alertSmsSegments: 400 } }) });
    const after = withPlans({ inherits: extra(), sets: extra({ included: { alertSmsSegments: 400 } }) }, (file) => { file.plans.pro.included.alertSmsSegments = 250; });
    expect(termsHash(after, "inherits")).not.toBe(termsHash(before, "inherits"));
    expect(termsHash(after, "sets")).toBe(termsHash(before, "sets"));
    expect(termsHash(after, "pro")).not.toBe(termsHash(before, "pro"));
  });
});

describe("prepaid packs", () => {
  const packEntry = (overrides: Record<string, unknown> = {}) => ({ names: name("500 minutes"), minutes: 500, days: 180, priceCents: 9900, ...overrides });
  const withPacks = (packs: Record<string, unknown>, change: (file: Record<string, any>) => void = () => undefined) => withPlans({}, (file) => { file.packs = packs; change(file); });
  const pack = (file: unknown, code: string): ResolvedBillingPack => resolveBillingPacks(parse(file)).find((row) => row.code === code)!;
  const packHash = (file: unknown, code: string) => createHash("sha256").update(packTermsJson(pack(file, code))).digest("hex");

  it("sells nine packs in AlloPlace's file and the example file, smallest and shortest first, with Starter's allowances and 20 MB of knowledge", () => {
    for (const file of [alloplace(), plansAndPacks()]) {
      const packs = resolveBillingPacks(parse(file));
      expect(packs.map((row) => row.code)).toEqual(["pack_250_90", "pack_250_180", "pack_250_365", "pack_500_90", "pack_500_180", "pack_500_365", "pack_1000_90", "pack_1000_180", "pack_1000_365"]);
      expect(packs.map((row) => row.sort)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
      expect(packs.find((row) => row.code === "pack_500_180")).toEqual({
        code: "pack_500_180",
        names: { en: "500 minutes, 180 days", fr: "500 minutes, 180 jours", es: "500 minutos, 180 días", sr: "500 minuta, 180 dana" },
        voice_sec: 30_000,
        days: 180,
        sms_seg: 50,
        calls_out: 20,
        chat_units: 50,
        kb_bytes: 20 * 1_048_576,
        numbers: 1,
        receptionists: 1,
        sort: 50,
        price: { currency: "cad", cents: 9900 },
      });
    }
  });

  it("sells RealInfoBot's three listing packs, a receptionist per listing, and no plan but Free", () => {
    const profile = parse(JSON.parse(readFileSync(new URL("../../../brands/realinfobot/billing.json", import.meta.url), "utf8")));
    expect(Object.entries(profile.plans).filter(([, entry]) => entry.sold).map(([code]) => code)).toEqual([]);
    expect(resolveBillingPacks(profile).map((row) => [row.code, row.voice_sec / 60, row.days, row.receptionists, row.numbers, row.price.cents])).toEqual([
      ["listing_1_180", 250, 180, 1, 1, 9900],
      ["listings_3_365", 750, 365, 3, 1, 24900],
      ["listings_6_365", 1500, 365, 6, 1, 44900],
    ]);
    // The plan screens show Free alone, with no comparison, and the packs' box beside it.
    expect(profile.display?.plans?.map((card) => card.plan)).toEqual(["free_cloud"]);
    expect(profile.display?.comparison).toEqual([]);
    expect(profile.display?.packs?.title?.en).toBe("Upgrade with a listing pack");
  });

  it("takes what a pack leaves out from Starter, and keeps what it sets", () => {
    const file = withPacks({ own: packEntry({ included: { alertSmsSegments: 7 }, limits: { knowledgeStorageMb: 3, businessNumbers: 0, receptionists: 2 } }), bare: packEntry({ days: undefined }) });
    expect(pack(file, "own")).toMatchObject({ sms_seg: 7, calls_out: 20, chat_units: 50, kb_bytes: 3 * 1_048_576, numbers: 0, receptionists: 2 });
    expect(pack(file, "bare")).toMatchObject({ days: null, sms_seg: 50, kb_bytes: 5 * 1_048_576, numbers: 1, receptionists: 1 });
    // A pack that never ends sorts after every length of its size.
    expect(resolveBillingPacks(parse(file)).map((row) => row.code)).toEqual(["own", "bare"]);
  });

  it("allows a file without packs, and checks each pack's code, length and price", () => {
    expect(resolveBillingPacks(parse(withPlans({}, (file) => { delete file.packs; })))).toEqual([]);
    expect(problems(withPacks({ "Big-Pack": packEntry() }))).toEqual([expect.stringMatching(/^packs\.Big-Pack: a pack code is/)]);
    expect(problems(withPacks({ starter: packEntry() }))).toEqual([expect.stringMatching(/^packs\.starter: a plan already has this code/)]);
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`pack-${String(index).padStart(2, "0")}`, packEntry()]));
    expect(problems(withPacks(many))).toEqual([expect.stringMatching(/^packs\.pack-30: a file holds at most 30 packs/)]);
    const refused = (file: unknown, path: RegExp) => expect(problems(file).some((problem) => path.test(problem)), `${path} in ${problems(file).join("; ")}`).toBe(true);
    refused(withPacks({ pk1: packEntry({ days: 0 }) }), /^packs\.pk1\.days: /);
    refused(withPacks({ pk1: packEntry({ days: 1_096 }) }), /^packs\.pk1\.days: /);
    refused(withPacks({ pk1: packEntry({ minutes: 0 }) }), /^packs\.pk1\.minutes: /);
    refused(withPacks({ pk1: packEntry({ priceCents: 0 }) }), /^packs\.pk1\.priceCents: /);
    refused(withPacks({ pk1: packEntry({ included: { voiceMinutes: 10 } }) }), /^packs\.pk1\.included: Unrecognized key/);
    refused(withPacks({ pk1: packEntry({ limits: { businessNumbers: 2 } }) }), /^packs\.pk1\.limits\.businessNumbers: /);
    expect(problems(withPacks({ pk1: packEntry({ days: 1_095 }) }))).toEqual([]);
  });

  it("hashes everything a buyer gets and the price, but not the names or the order", () => {
    const base = packHash(withPacks({ pk1: packEntry() }), "pk1");
    expect(packHash(withPacks({ pk1: packEntry({ names: name("Another name") }), pk0: packEntry({ minutes: 100 }) }), "pk1")).toBe(base);
    const changed = [
      packEntry({ minutes: 501 }),
      packEntry({ days: 181 }),
      packEntry({ days: undefined }),
      packEntry({ priceCents: 9901 }),
      packEntry({ included: { alertSmsSegments: 1 } }),
      packEntry({ included: { outboundCallAttempts: 1 } }),
      packEntry({ included: { chatAiUnits: 1 } }),
      packEntry({ limits: { knowledgeStorageMb: 1 } }),
      packEntry({ limits: { businessNumbers: 0 } }),
      packEntry({ limits: { receptionists: 3 } }),
    ].map((entry) => packHash(withPacks({ pk1: entry }), "pk1"));
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
    expect(packHash(withPacks({ pk1: packEntry() }, (file) => { file.currency = "usd"; }), "pk1")).not.toBe(base);
  });

  it("leaves every plan's terms hash as it was", () => {
    const without = withPlans({}, (file) => { delete file.packs; });
    for (const code of ["free_cloud", "starter", "pro", "enterprise"]) expect(termsHash(alloplace(), code)).toBe(termsHash(without, code));
  });
});

describe("the accounts section", () => {
  const withAccounts = (accounts: unknown, plans: Record<string, unknown> = {}) => ({ ...withPlans(plans), accounts });
  const accountProblems = (file: unknown) => problems(file).filter((problem) => problem.startsWith("accounts"));

  it("takes how many businesses one account may own, from 1 to 100, and nothing else", () => {
    for (const maxBusinesses of [1, 3, 10, 100]) expect(accountProblems(withAccounts({ maxBusinesses }))).toEqual([]);
    for (const maxBusinesses of [0, 101, 2.5, "3", null]) expect(accountProblems(withAccounts({ maxBusinesses }))).not.toEqual([]);
    // Both numbers may be left out, which gives every account 10.
    expect(accountProblems(withAccounts({}))).toEqual([]);
    expect(accountProblems(withAccounts({ maxBusinesses: 3, maxFreeBusinesses: 1 }))).not.toEqual([]);
    const { accounts: _accounts, ...without } = alloplace();
    expect(problems(without)).toEqual([]);
  });

  it("takes a number from 1 to 100 for each plan of the file, and for prepaid", () => {
    const caps = { free_cloud: 1, starter: 3, pro: 10, enterprise: 100, prepaid: 2 };
    expect(accountProblems(withAccounts({ maxBusinessesByPlan: caps }))).toEqual([]);
    expect(accountProblems(withAccounts({ maxBusinesses: 5, maxBusinessesByPlan: { "pro-plus": 20 } }, { "pro-plus": examples["pro-plus"] }))).toEqual([]);
    for (const cap of [0, 101, 2.5, "3", null]) expect(accountProblems(withAccounts({ maxBusinessesByPlan: { starter: cap } }))).not.toEqual([]);
    // A code no plan has, such as a misspelling or a pack's code, stops the build.
    expect(accountProblems(withAccounts({ maxBusinessesByPlan: { starterr: 3, pack_250_90: 2, self_host: 4 } }))).toEqual([
      "accounts.maxBusinessesByPlan.pack_250_90: not a plan in this file: use a code under plans, or prepaid for a business with a live pack",
      "accounts.maxBusinessesByPlan.self_host: not a plan in this file: use a code under plans, or prepaid for a business with a live pack",
      "accounts.maxBusinessesByPlan.starterr: not a plan in this file: use a code under plans, or prepaid for a business with a live pack",
    ]);
  });

  it("leaves the section out of the hash, the stored profile and what the billing commands send", () => {
    const { accounts: _accounts, ...without } = alloplace();
    const file = withAccounts({ maxBusinesses: 3 });
    expect(profileHash(file)).toBe(profileHash(without));
    expect(profileHash(withAccounts({ maxBusinesses: 50 }))).toBe(profileHash(file));
    expect(profileHash(withAccounts({ maxBusinesses: 3, maxBusinessesByPlan: { free_cloud: 1, pro: 20 } }))).toBe(profileHash(file));
    expect(normalizeBillingProfile(parse(file))).not.toHaveProperty("accounts");
    expect(billingProfileForCatalog(file)).toEqual(billingProfileForCatalog(without));
    expect(billingProfileForCatalog(file)).not.toHaveProperty("accounts");
  });
});

describe("business caps per plan", () => {
  const accounts = { maxBusinesses: 5, maxBusinessesByPlan: { free_cloud: 1, starter: 3, "starter-launch": 4, prepaid: 2 } };

  it("gives a business's plan its own code's number, then its tier's, then maxBusinesses, then 10", () => {
    expect(planBusinessCap(accounts, { plan: "starter", planCode: "starter-launch" })).toBe(4);
    expect(planBusinessCap(accounts, { plan: "starter", planCode: "starter-yearly" })).toBe(3);
    expect(planBusinessCap(accounts, { plan: "starter", planCode: null })).toBe(3);
    expect(planBusinessCap(accounts, { plan: "free_cloud" })).toBe(1);
    expect(planBusinessCap(accounts, { plan: "prepaid" })).toBe(2);
    expect(planBusinessCap(accounts, { plan: "pro" })).toBe(5);
    // A self-hosted business has no plan the map can name.
    expect(planBusinessCap(accounts, { plan: "self_host" })).toBe(5);
    expect(planBusinessCap({ maxBusinessesByPlan: { free_cloud: 1 } }, { plan: "pro" })).toBe(10);
    expect(planBusinessCap({}, { plan: "toString" })).toBe(10);
    expect(planBusinessCap(undefined, { plan: "free_cloud" })).toBe(10);
  });

  it("lets an account own as many businesses as its best plan allows", () => {
    expect(accountBusinessCap(accounts, [{ plan: "free_cloud" }])).toBe(1);
    expect(accountBusinessCap(accounts, [{ plan: "free_cloud" }, { plan: "starter" }, { plan: "free_cloud" }])).toBe(3);
    expect(accountBusinessCap(accounts, [{ plan: "prepaid" }, { plan: "starter", planCode: "starter-launch" }])).toBe(4);
    expect(accountBusinessCap(accounts, [{ plan: "free_cloud" }, { plan: "pro" }])).toBe(5);
    expect(accountBusinessCap(accounts, [])).toBe(5);
    expect(accountBusinessCap(undefined, [{ plan: "pro" }])).toBe(10);
  });

  it("knows the most any plan allows", () => {
    // Pro and Enterprise aren't in the map, so they allow maxBusinesses.
    expect(highestBusinessCap(accounts)).toBe(5);
    expect(highestBusinessCap({ maxBusinesses: 2, maxBusinessesByPlan: { "pro-plus": 20 } })).toBe(20);
    // With every tier in the map, maxBusinesses counts only for a self-hosted business.
    expect(highestBusinessCap({ maxBusinesses: 50, maxBusinessesByPlan: { free_cloud: 1, starter: 3, pro: 5, enterprise: 8, prepaid: 2 } })).toBe(8);
    expect(highestBusinessCap({ maxBusinesses: 3 })).toBe(3);
    expect(highestBusinessCap(undefined)).toBe(10);
  });
});

describe("the plan screens' display section", () => {
  const words = (text: string) => ({ en: text, fr: text, es: text, sr: text });
  const withDisplay = (display: Record<string, unknown>, change: (file: Record<string, any>) => void = () => undefined) => {
    const file = alloplace();
    file.display = display;
    change(file);
    return file;
  };
  // Only the section's own problems, as a path and its message.
  const displayProblems = (file: unknown) => problems(file).filter((problem) => problem.startsWith("display"));

  it("takes the example file's section, and leaves it out of the hash, the stored profile and what the billing commands send", () => {
    const file = plansAndPacks();
    expect(file.display.plans.map((card: { plan: string }) => card.plan)).toEqual(["free_cloud", "starter", "pro", "enterprise"]);
    expect(problems(file)).toEqual([]);
    const { display: _screens, ...withoutDisplay } = file;
    expect(profileHash(file)).toBe(profileHash(withoutDisplay));
    expect(normalizeBillingProfile(parse(file))).not.toHaveProperty("display");
    expect(billingProfileForCatalog(file)).toEqual(withoutDisplay);
    // Words changed on the screens change nothing sold.
    const edited = plansAndPacks();
    edited.display.plans[2].bullets.push(words("Priority onboarding call"));
    edited.display.defaultInterval = "monthly";
    expect(profileHash(edited)).toBe(profileHash(file));
  });

  it("takes a section with only some of its fields, or an empty comparison", () => {
    expect(problems(withDisplay({ defaultInterval: "monthly" }))).toEqual([]);
    expect(problems(withDisplay({ comparison: [] }))).toEqual([]);
    expect(problems(withDisplay({ plans: [{ plan: "pro", popular: true }, { plan: "starter" }] }))).toEqual([]);
    expect(problems(withDisplay({}))).toEqual([]);
  });

  it("refuses what the screens can't show, with the path to fix", () => {
    // Every text in all four languages, at most 300 characters.
    expect(displayProblems(withDisplay({ comparisonTitle: { en: "Plans" } }))).toEqual([expect.stringMatching(/^display\.comparisonTitle\.fr: /), expect.stringMatching(/^display\.comparisonTitle\.es: /), expect.stringMatching(/^display\.comparisonTitle\.sr: /)]);
    expect(displayProblems(withDisplay({ comparisonTitle: words("x".repeat(301)) }))).toHaveLength(4);
    // Only the allowances it knows, the plans it knows, and no field it doesn't.
    expect(displayProblems(withDisplay({ plans: [{ plan: "pro", bullets: ["minutes"] }] }))).toEqual([expect.stringMatching(/^display\.plans\.0\.bullets\.0: /)]);
    expect(displayProblems(withDisplay({ plans: [{ plan: "premium" }] }))).toEqual([expect.stringMatching(/^display\.plans\.0\.plan: /)]);
    expect(displayProblems(withDisplay({ title: words("Plans") }))).toEqual([expect.stringMatching(/^display: /)]);
    // Each card once, and one popular at most.
    expect(displayProblems(withDisplay({ plans: [{ plan: "pro" }, { plan: "pro" }] }))).toEqual(["display.plans.1.plan: pro already has a card"]);
    expect(displayProblems(withDisplay({ plans: [{ plan: "starter", popular: true }, { plan: "pro", popular: true }] }))).toEqual(["display.plans: only one plan can be popular"]);
    // A Starter or Pro card only for a plan the file sells; Free and Enterprise are never sold, and always may have one.
    const unsold = (file: Record<string, any>) => {
      delete file.packs;
      file.plans.starter = { sold: false, included: file.plans.starter.included, limits: file.plans.starter.limits, overageCents: file.plans.starter.overageCents };
    };
    expect(displayProblems(withDisplay({ plans: [{ plan: "free_cloud" }, { plan: "starter" }, { plan: "enterprise" }] }, unsold))).toEqual(["display.plans.1.plan: starter isn't sold in this file, so it can't have a card"]);
    // Only the values a text can print: a plan's own in its card and cells, any plan's in the page's text.
    expect(displayProblems(withDisplay({ plans: [{ plan: "starter", description: { monthly: words("Includes {{minutes}} minutes."), annual: words("Includes {{voiceMinutes}} minutes, {{voiceMinuteRate}} after, on {{appName}}.") } }] }))).toEqual([
      expect.stringMatching(/^display\.plans\.0\.description\.monthly\.en: \{\{minutes\}\} isn't a value it knows/),
      expect.stringMatching(/^display\.plans\.0\.description\.monthly\.fr: /),
      expect.stringMatching(/^display\.plans\.0\.description\.monthly\.es: /),
      expect.stringMatching(/^display\.plans\.0\.description\.monthly\.sr: /),
    ]);
    expect(displayProblems(withDisplay({ comparisonIntro: words("Test {{voiceMinutes}} minutes on Free.") }))).toHaveLength(4);
    expect(displayProblems(withDisplay({ comparisonIntro: words("Test {{free_cloud.voiceMinutes}} minutes on {{appName}}.") }))).toEqual([]);
    expect(displayProblems(withDisplay({ plans: [{ plan: "pro", bullets: [words("{{pro.voiceMinutes}} minutes")] }] }))).toHaveLength(4);
  });

  it("checks the comparison against the cards: a value only for a plan with a card, and every such plan's in a row of the brand's own", () => {
    const cards = [{ plan: "free_cloud" }, { plan: "pro", popular: true }];
    expect(displayProblems(withDisplay({ plans: cards, comparison: [{ group: words("Booking"), rows: [{ label: words("Booking"), values: { free_cloud: true, pro: true } }, "voiceMinutes", "shortCalls"] }] }))).toEqual([]);
    expect(displayProblems(withDisplay({ plans: cards, comparison: [{ group: words("Booking"), rows: [{ label: words("Booking"), values: { free_cloud: true, starter: true, pro: true } }] }] }))).toEqual(["display.comparison.0.rows.0.values.starter: starter has no card, so its value never shows"]);
    expect(displayProblems(withDisplay({ plans: cards, comparison: [{ group: words("Booking"), rows: [{ label: words("Booking"), values: { free_cloud: true } }] }] }))).toEqual(["display.comparison.0.rows.0.values.pro: a row of your own needs a value for every plan with a card: pro has none"]);
    // Without cards, the comparison's columns are all four plans.
    expect(displayProblems(withDisplay({ comparison: [{ group: words("Booking"), rows: [{ label: words("Booking"), values: { free_cloud: true, pro: true } }] }] }))).toEqual([
      "display.comparison.0.rows.0.values.starter: a row of your own needs a value for every plan with a card: starter has none",
      "display.comparison.0.rows.0.values.enterprise: a row of your own needs a value for every plan with a card: enterprise has none",
    ]);
    // A named row may take its own label and some plans' values; a cell's text prints that plan's values.
    expect(displayProblems(withDisplay({ comparison: [{ group: words("Usage"), rows: [{ row: "alertSmsSegments", label: words("Texts"), values: { free_cloud: false, enterprise: words("{{alertSmsSegmentRate}} each") } }] }] }))).toEqual([]);
    expect(displayProblems(withDisplay({ comparison: [{ group: words("Usage"), rows: [{ row: "alertSmsSegments", values: { enterprise: words("{{enterprise.alertSmsSegments}}") } }] }] }))).toHaveLength(4);
  });
});
