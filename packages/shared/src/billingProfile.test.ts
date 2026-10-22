import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hostedCheckoutPlanSlugs } from "./billing";
import { billingProfileSchema, canonicalBillingProfileJson, normalizeBillingProfile, planTermsJson, resolveBillingPlans, type BillingProfile, type ResolvedBillingPlan } from "./billingProfile";

const fileText = readFileSync(new URL("../../../brands/alloplace/billing.json", import.meta.url), "utf8");
const alloplace = (): Record<string, any> => JSON.parse(fileText);

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
  });
});

describe("resolveBillingPlans", () => {
  it("fills an additional plan's missing values from its tier, and keeps the ones it sets", () => {
    const file = withPlans({ extra: extra({ included: { voiceMinutes: 700 }, limits: { businessNumbers: 3 }, overageCents: { voiceMinute: 15 } }) });
    expect(plan(file, "extra")).toMatchObject({
      voice_sec: 42_000,
      sms_seg: 200,
      calls_out: 100,
      chat_units: 200,
      kb_bytes: 20 * 1_048_576,
      numbers: 3,
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
      extra({ limits: { businessNumbers: 2 } }),
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
