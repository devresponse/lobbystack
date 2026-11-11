import { readFileSync } from "node:fs";

import { billingProfileSchema, perMonthCents, type BillingProfile } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { billingCatalogPacks, billingCatalogWriteOrder, desiredBillingPacks, desiredBillingPlans, diffBillingCatalog, diffBillingLinks, diffBillingPackCatalog, diffBillingPackLinks, type DesiredBillingPack, type DesiredBillingPlan, type StoredBillingPack, type StoredBillingPackPrice, type StoredBillingPlan, type StoredBillingPrice } from "./billingCatalog";

// The diff on plain rows, no database: what an apply would write and in what order.

const fileText = readFileSync(new URL("../../../../brands/alloplace/billing.json", import.meta.url), "utf8");
const now = "2026-10-21T08:00:00.000Z";
const earlier = "2026-10-20T08:00:00.000Z";

function profile(change: (file: Record<string, any>) => void = () => undefined): BillingProfile {
  const file = JSON.parse(fileText) as Record<string, any>;
  change(file);
  return billingProfileSchema.parse(file);
}

const proLaunch = {
  tier: "pro",
  access: "code",
  names: { en: "Pro launch offer", fr: "Offre de lancement Pro", es: "Oferta de lanzamiento Pro", sr: "Pro ponuda za lansiranje" },
  sold: true,
  prices: { monthlyCents: 6000 },
  included: { voiceMinutes: 600 },
};

/** The rows Postgres would hold after applying a file, every plan as status says. */
function stored(plans: DesiredBillingPlan[], status: (plan: DesiredBillingPlan) => StoredBillingPlan["status"] = (plan) => (plan.sold ? "draft" : "active")): { plans: StoredBillingPlan[]; prices: StoredBillingPrice[] } {
  return {
    plans: plans.map(({ prices: _prices, ...plan }) => ({ ...plan, status: status(plan as DesiredBillingPlan), src: "file", provider_disc: null, frozen_at: null, run_id: null, retired_at: null, created_at: earlier, updated_at: earlier })),
    prices: plans.flatMap((plan) => plan.prices.map((price) => ({ id: `${plan.code}-${price.period}-${price.currency}`, plan: plan.code, period: price.period, currency: price.currency, cents: price.cents, per_month: perMonthCents(price.period, price.cents), provider_ref: null, run_id: null, retired_at: null, created_at: earlier, updated_at: earlier }))),
  };
}

function diff(file: BillingProfile, current: { plans: StoredBillingPlan[]; prices: StoredBillingPrice[] }) {
  return diffBillingCatalog({ plans: desiredBillingPlans(file), currency: file.currency, current, now });
}

const summary = (writes: ReturnType<typeof diff>["writes"]) => writes.map((write) => `${write.change.action} ${write.change.table} ${write.change.key}`);

describe("billing catalog diff", () => {
  it("seeds an empty deployment with eight inserts, sold plans as draft, in table then key order", () => {
    const { writes, refusals } = diff(profile(), { plans: [], prices: [] });
    expect(refusals).toEqual([]);
    expect(summary(writes)).toEqual([
      "insert billing_plans enterprise",
      "insert billing_plans free_cloud",
      "insert billing_plans pro",
      "insert billing_plans starter",
      "insert billing_prices pro/annual/cad",
      "insert billing_prices pro/monthly/cad",
      "insert billing_prices starter/annual/cad",
      "insert billing_prices starter/monthly/cad",
    ]);
    const status = Object.fromEntries(writes.filter((write) => write.change.table === "billing_plans").map((write) => [write.change.key, write.set.status]));
    expect(status).toEqual({ enterprise: "active", free_cloud: "active", pro: "draft", starter: "draft" });
    expect(writes.every((write) => Object.keys(write.change.fields).length === 0 && !write.change.lowers_allowance && !write.change.raises_price)).toBe(true);
    expect(writes.find((write) => write.change.key === "starter/monthly/cad")!.set).toEqual({ plan: "starter", period: "monthly", currency: "cad", cents: 3700 });
  });

  it("writes nothing when the tables already match the file", () => {
    const file = profile();
    expect(diff(file, stored(desiredBillingPlans(file)))).toEqual({ writes: [], refusals: [] });
  });

  it("flags a lowered allowance and a higher price or rate, and nothing else", () => {
    const before = profile();
    const after = profile((file) => {
      file.plans.pro.included.voiceMinutes = 400;
      file.plans.pro.included.alertSmsSegments = 250;
      file.plans.pro.overageCents.voiceMinute = 20;
      file.plans.pro.prices.monthlyCents = 11000;
      file.plans.starter.prices.monthlyCents = 3500;
    });
    const { writes } = diff(after, stored(desiredBillingPlans(before)));
    const byKey = Object.fromEntries(writes.map((write) => [write.change.key, write.change]));
    expect(Object.keys(byKey)).toEqual(["pro", "starter", "pro/monthly/cad", "starter/monthly/cad"]);
    expect(byKey.pro).toMatchObject({ action: "update", lowers_allowance: true, raises_price: true, fields: { voice_sec: { from: 30000, to: 24000 }, sms_seg: { from: 200, to: 250 }, voice_rate: { from: 18, to: 20 } } });
    // A price is part of the terms, so the plan's terms_hash moves with it.
    expect(byKey.starter).toMatchObject({ action: "update", lowers_allowance: false, raises_price: false });
    expect(Object.keys(byKey.starter!.fields)).toEqual(["terms_hash"]);
    expect(byKey["pro/monthly/cad"]).toMatchObject({ action: "update", raises_price: true, lowers_allowance: false, fields: { cents: { from: 8700, to: 11000 } } });
    expect(byKey["starter/monthly/cad"]).toMatchObject({ raises_price: false, fields: { cents: { from: 3700, to: 3500 } } });
    // A price update keeps its row.
    expect(writes.find((write) => write.change.key === "pro/monthly/cad")!.id).toBe("pro-monthly-cad");
  });

  it("runs plans before prices and, in each table, retirements before updates, restores and inserts", () => {
    const before = profile((file) => { file.plans["pro-launch"] = proLaunch; });
    const current = stored(desiredBillingPlans(before));
    // pro-launch leaves; a new plan arrives; starter's annual price leaves; pro's monthly price changes.
    const after = profile((file) => {
      file.plans["pro-plus"] = { ...proLaunch, access: "public", names: { en: "Pro Plus", fr: "Pro Plus", es: "Pro Plus", sr: "Pro Plus" }, prices: { monthlyCents: 15000 } };
      delete file.plans.starter.prices.annualCents;
      file.plans.pro.prices.monthlyCents = 11000;
    });
    const { writes } = diff(after, current);
    expect(summary(writes)).toEqual([
      "update billing_plans pro",
      "retire billing_plans pro-launch",
      "insert billing_plans pro-plus",
      "update billing_plans starter",
      "retire billing_prices pro-launch/monthly/cad",
      "insert billing_prices pro-plus/monthly/cad",
      "update billing_prices pro/monthly/cad",
      "retire billing_prices starter/annual/cad",
    ]);
    expect(summary(billingCatalogWriteOrder(writes))).toEqual([
      "retire billing_plans pro-launch",
      "update billing_plans pro",
      "update billing_plans starter",
      "insert billing_plans pro-plus",
      "retire billing_prices pro-launch/monthly/cad",
      "retire billing_prices starter/annual/cad",
      "update billing_prices pro/monthly/cad",
      "insert billing_prices pro-plus/monthly/cad",
    ]);
    expect(writes.find((write) => write.change.key === "pro-launch")!.set).toEqual({ status: "retired", retired_at: now });
  });

  it("changes only the shown fields of a plan whose terms stay, keeping its status", () => {
    const before = profile((file) => { file.plans["pro-launch"] = proLaunch; });
    const after = profile((file) => { file.plans["pro-launch"] = { ...proLaunch, access: "hidden", names: { ...proLaunch.names, en: "Launch offer" }, offerEndsAt: "2027-03-31T23:59:59-04:00" }; });
    const { writes } = diff(after, stored(desiredBillingPlans(before), () => "active"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.change.action).toBe("update");
    expect(Object.keys(writes[0]!.change.fields).sort()).toEqual(["access", "names", "offer_end"]);
    expect(writes[0]!.set.offer_end).toBe("2027-04-01T03:59:59.000Z");
  });

  it("sends a sold active plan back to draft when its terms change, and keeps an unsold one active", () => {
    const before = profile();
    const after = profile((file) => {
      file.plans.pro.included.chatAiUnits = 250;
      file.plans.free_cloud.included.chatAiUnits = 6;
    });
    const { writes } = diff(after, stored(desiredBillingPlans(before), () => "active"));
    const pro = writes.find((write) => write.change.key === "pro")!;
    expect(pro.change.fields.status).toEqual({ from: "active", to: "draft" });
    expect(pro.set.status).toBe("draft");
    const free = writes.find((write) => write.change.key === "free_cloud")!;
    expect(free.change.fields.status).toBeUndefined();
    expect(free.set.status).toBeUndefined();
    // A draft plan stays draft.
    expect(diff(after, stored(desiredBillingPlans(before))).writes.find((write) => write.change.key === "pro")!.change.fields.status).toBeUndefined();
  });

  it("reaches every additional plan that inherits a tier's value, and none that sets its own", () => {
    const own = { ...proLaunch, included: { voiceMinutes: 600, alertSmsSegments: 400 } };
    const before = profile((file) => { file.plans["pro-launch"] = proLaunch; file.plans["pro-own"] = own; });
    const after = profile((file) => { file.plans["pro-launch"] = proLaunch; file.plans["pro-own"] = own; file.plans.pro.included.alertSmsSegments = 250; });
    expect(summary(diff(after, stored(desiredBillingPlans(before))).writes)).toEqual(["update billing_plans pro", "update billing_plans pro-launch"]);
  });

  it("refuses to change a frozen plan's terms, directly or through its tier, but lets its names change and lets it retire", () => {
    const before = profile((file) => { file.plans["pro-launch"] = proLaunch; });
    const frozen = () => {
      const current = stored(desiredBillingPlans(before), () => "active");
      current.plans.find((plan) => plan.code === "pro-launch")!.frozen_at = earlier;
      return current;
    };
    const direct = diff(profile((file) => { file.plans["pro-launch"] = { ...proLaunch, prices: { monthlyCents: 6500 } }; }), frozen());
    expect(direct.refusals).toEqual([expect.objectContaining({ code: "plan_frozen", path: "billing_file.plans.pro-launch" })]);
    const inherited = diff(profile((file) => { file.plans["pro-launch"] = proLaunch; file.plans.pro.limits.businessNumbers = 0; }), frozen());
    expect(inherited.refusals.map((refusal) => refusal.code)).toEqual(["plan_frozen"]);
    const renamed = diff(profile((file) => { file.plans["pro-launch"] = { ...proLaunch, access: "public", names: { ...proLaunch.names, en: "Launch" } }; }), frozen());
    expect(renamed.refusals).toEqual([]);
    expect(Object.keys(renamed.writes[0]!.change.fields).sort()).toEqual(["access", "names"]);
    const removed = diff(profile(), frozen());
    expect(removed.refusals).toEqual([]);
    expect(summary(removed.writes)).toEqual(["retire billing_plans pro-launch", "retire billing_prices pro-launch/monthly/cad"]);
  });

  it("changes a standard plan's receptionists without touching its terms, flagging fewer", () => {
    // Standard plans never freeze (migration 0108's billing_plans_standard), so Pro's number may go down.
    const current = stored(desiredBillingPlans(profile()), () => "active");
    const fewer = diff(profile((file) => { file.plans.pro.limits.receptionists = 3; }), current);
    expect(fewer.refusals).toEqual([]);
    expect(summary(fewer.writes)).toEqual(["update billing_plans pro"]);
    expect(fewer.writes[0]!.change).toMatchObject({ lowers_allowance: true, raises_price: false, fields: { receptionists: { from: 5, to: 3 } } });
    // Polar never sees the number: the plan stays active and its terms hash stays.
    expect(Object.keys(fewer.writes[0]!.change.fields)).toEqual(["receptionists"]);
    expect(fewer.writes[0]!.set).toEqual({ receptionists: 3 });
    const more = diff(profile((file) => { file.plans.starter.limits.receptionists = 2; }), current);
    expect(more.writes[0]!.change).toMatchObject({ key: "starter", lowers_allowance: false, fields: { receptionists: { from: 1, to: 2 } } });
  });

  it("keeps a frozen plan's receptionists from going down, directly or through its tier, and lets them go up", () => {
    const launch = (receptionists?: number) => (receptionists === undefined ? proLaunch : { ...proLaunch, limits: { receptionists } });
    const frozen = (before: BillingProfile) => {
      const current = stored(desiredBillingPlans(before), () => "active");
      current.plans.find((plan) => plan.code === "pro-launch")!.frozen_at = earlier;
      return current;
    };
    const inheriting = frozen(profile((file) => { file.plans["pro-launch"] = launch(); }));
    // Pro may go down, but pro-launch inherits its number.
    const inherited = diff(profile((file) => { file.plans["pro-launch"] = launch(); file.plans.pro.limits.receptionists = 3; }), inheriting);
    expect(inherited.refusals).toEqual([{ code: "plan_frozen", path: "billing_file.plans.pro-launch", message: `pro-launch has had subscribers since ${earlier}, so its receptionists can't go down, directly or through its tier, from 5 to 3: the businesses on it keep what it gave them. Write 5 into its entry, or put the lower number under a new code.` }]);
    // Its number written into its entry keeps it, and Pro's goes down alone.
    const kept = diff(profile((file) => { file.plans["pro-launch"] = launch(5); file.plans.pro.limits.receptionists = 3; }), inheriting);
    expect(kept.refusals).toEqual([]);
    expect(summary(kept.writes)).toEqual(["update billing_plans pro"]);

    const own = frozen(profile((file) => { file.plans["pro-launch"] = launch(4); }));
    expect(diff(profile((file) => { file.plans["pro-launch"] = launch(2); }), own).refusals.map((refusal) => refusal.message)).toEqual([expect.stringContaining("from 4 to 2")]);
    // New terms and fewer receptionists: one refusal for each.
    const both = diff(profile((file) => { file.plans["pro-launch"] = { ...launch(2), prices: { monthlyCents: 6500 } }; }), own);
    expect(both.refusals.map((refusal) => [refusal.code, refusal.path])).toEqual([["plan_frozen", "billing_file.plans.pro-launch"], ["plan_frozen", "billing_file.plans.pro-launch"]]);
    expect(both.refusals[1]!.message).toContain("its receptionists can't go down");
    const more = diff(profile((file) => { file.plans["pro-launch"] = launch(8); }), own);
    expect(more.refusals).toEqual([]);
    expect(more.writes.map((write) => write.change)).toEqual([expect.objectContaining({ key: "pro-launch", action: "update", lowers_allowance: false, fields: { receptionists: { from: 4, to: 8 } } })]);

    // Businesses may still be on a retired plan, so bringing it back with fewer is refused too.
    const retired = frozen(profile((file) => { file.plans["pro-launch"] = launch(4); }));
    Object.assign(retired.plans.find((plan) => plan.code === "pro-launch")!, { status: "retired", retired_at: earlier });
    expect(diff(profile((file) => { file.plans["pro-launch"] = launch(2); }), retired).refusals.map((refusal) => refusal.code)).toEqual(["plan_frozen"]);
    expect(diff(profile((file) => { file.plans["pro-launch"] = launch(4); }), retired).refusals).toEqual([]);
  });

  it("fills receptionists on rows applied before the column, from the file or the tier", () => {
    const file = profile();
    const current = stored(desiredBillingPlans(file), () => "active");
    for (const plan of current.plans) plan.receptionists = null;
    const { writes, refusals } = diff(file, current);
    expect(refusals).toEqual([]);
    expect(writes.map((write) => [write.change.key, write.set])).toEqual([["free_cloud", { receptionists: 1 }], ["pro", { receptionists: 5 }], ["starter", { receptionists: 1 }]]);
    expect(writes.every((write) => !write.change.lowers_allowance)).toBe(true);
    // A row without a number gives its tier's, so a lower one in the file goes down.
    const fewer = diff(profile((value) => { value.plans.pro.limits.receptionists = 3; }), current);
    expect(fewer.refusals).toEqual([]);
    expect(fewer.writes.find((write) => write.change.key === "pro")!.change).toMatchObject({ lowers_allowance: true, fields: { receptionists: { from: null, to: 3 } } });
    // On a plan that has had subscribers, that is refused.
    const launch = profile((value) => { value.plans["pro-launch"] = proLaunch; });
    const unfilled = stored(desiredBillingPlans(launch), () => "active");
    Object.assign(unfilled.plans.find((plan) => plan.code === "pro-launch")!, { receptionists: null, frozen_at: earlier });
    expect(diff(profile((value) => { value.plans["pro-launch"] = { ...proLaunch, limits: { receptionists: 3 } }; }), unfilled).refusals).toEqual([expect.objectContaining({ code: "plan_frozen", message: expect.stringContaining("from 5 to 3") })]);
    expect(diff(launch, unfilled).refusals).toEqual([]);
  });

  it("never matches, changes or retires a plan made through the API, and refuses a file plan with its code", () => {
    const current = stored(desiredBillingPlans(profile((file) => { file.plans["pro-launch"] = proLaunch; })));
    current.plans.find((plan) => plan.code === "pro-launch")!.src = "api";
    expect(diff(profile(), current)).toEqual({ writes: [], refusals: [] });
    const taken = diff(profile((file) => { file.plans["pro-launch"] = { ...proLaunch, prices: { monthlyCents: 7000 } }; }), current);
    expect(taken.refusals).toEqual([expect.objectContaining({ code: "code_taken", path: "billing_file.plans.pro-launch" })]);
    expect(taken.writes).toEqual([]);
  });

  it("restores a retired plan as an insert would set it, and the latest retired row of a price", () => {
    const file = profile((change) => { change.plans["pro-launch"] = proLaunch; });
    const current = stored(desiredBillingPlans(file));
    const plan = current.plans.find((row) => row.code === "pro-launch")!;
    Object.assign(plan, { status: "retired", retired_at: earlier });
    const live = current.prices.find((row) => row.plan === "pro-launch")!;
    Object.assign(live, { retired_at: earlier, provider_ref: "price_new", cents: 6500 });
    current.prices.push({ ...live, id: "older", retired_at: "2026-10-01T00:00:00.000Z", provider_ref: "price_old" });
    const { writes, refusals } = diff(file, current);
    expect(refusals).toEqual([]);
    expect(summary(writes)).toEqual(["restore billing_plans pro-launch", "restore billing_prices pro-launch/monthly/cad"]);
    expect(writes[0]!.set).toEqual({ status: "draft", retired_at: null });
    expect(writes[0]!.change.fields).toEqual({ status: { from: "retired", to: "draft" }, retired_at: { from: earlier, to: null } });
    expect(writes[1]).toMatchObject({ id: live.id, set: { cents: 6000, retired_at: null }, change: { fields: { cents: { from: 6500, to: 6000 } } } });
  });

  it("changes currency by retiring and inserting, unless Polar sells a live price in the old one", () => {
    const before = profile();
    const after = profile((file) => { file.currency = "usd"; });
    const free = diff(after, stored(desiredBillingPlans(before)));
    expect(free.refusals).toEqual([]);
    expect(summary(free.writes)).toEqual([
      "update billing_plans pro",
      "update billing_plans starter",
      "retire billing_prices pro/annual/cad",
      "insert billing_prices pro/annual/usd",
      "retire billing_prices pro/monthly/cad",
      "insert billing_prices pro/monthly/usd",
      "retire billing_prices starter/annual/cad",
      "insert billing_prices starter/annual/usd",
      "retire billing_prices starter/monthly/cad",
      "insert billing_prices starter/monthly/usd",
    ]);
    const linked = stored(desiredBillingPlans(before));
    linked.prices[0]!.provider_ref = "price_1";
    expect(diff(after, linked).refusals).toEqual([expect.objectContaining({ code: "currency_locked", path: "billing_file.currency" })]);
  });
});

describe("billing link diff", () => {
  const launchFile = profile((file) => {
    file.plans["pro-launch"] = { ...proLaunch, discount: { type: "percentage", basisPoints: 2500, duration: "repeating", durationInMonths: 3 } };
  });
  type LinkPlans = Parameters<typeof diffBillingLinks>[0]["body"]["plans"];

  /** A link naming product prod_<plan>_<period> for every live price of every sold plan, and disc_<plan> for each discount. */
  function linkFor(current: { plans: StoredBillingPlan[]; prices: StoredBillingPrice[] }): LinkPlans {
    return current.plans.filter((plan) => plan.sold && plan.status !== "retired").map((plan) => ({
      code: plan.code,
      terms_hash: plan.terms_hash,
      provider_disc: plan.discount ? `disc_${plan.code}` : null,
      prices: current.prices.filter((price) => price.plan === plan.code && price.retired_at === null).map((price) => ({ period: price.period, currency: price.currency, provider_ref: `prod_${plan.code}_${price.period}` })),
    }));
  }

  function link(current: { plans: StoredBillingPlan[]; prices: StoredBillingPrice[] }, plans: LinkPlans, replaceIds = false) {
    return diffBillingLinks({ body: { plans, replace_ids: replaceIds, provider: "polar", names: "polar" }, current, now });
  }

  /** The rows after a link went through. */
  function linked(current: { plans: StoredBillingPlan[]; prices: StoredBillingPrice[] }) {
    const plans = linkFor(current);
    for (const plan of current.plans) {
      const sent = plans.find((entry) => entry.code === plan.code);
      if (!sent) continue;
      plan.status = "active";
      plan.provider_disc = sent.provider_disc;
    }
    for (const price of current.prices) price.provider_ref = plans.find((entry) => entry.code === price.plan)?.prices.find((entry) => entry.period === price.period)?.provider_ref ?? null;
    return current;
  }

  it("links every live price of every sold plan, and makes each sold plan active with its discount", () => {
    const current = stored(desiredBillingPlans(launchFile));
    const { writes, refusals } = link(current, linkFor(current));
    expect(refusals).toEqual([]);
    expect(writes.map((write) => `${write.change.action} ${write.change.table} ${write.change.key}`)).toEqual([
      "update billing_plans pro",
      "update billing_plans pro-launch",
      "update billing_plans starter",
      "update billing_prices pro-launch/monthly/cad",
      "update billing_prices pro/annual/cad",
      "update billing_prices pro/monthly/cad",
      "update billing_prices starter/annual/cad",
      "update billing_prices starter/monthly/cad",
    ]);
    expect(writes[1]).toMatchObject({ set: { provider_disc: "disc_pro-launch", status: "active" }, change: { fields: { polar_disc: { from: null, to: "disc_pro-launch" }, status: { from: "draft", to: "active" } } } });
    expect(writes[0]!.set).toEqual({ status: "active" });
    expect(writes[4]).toMatchObject({ id: "pro-annual-cad", set: { provider_ref: "prod_pro_annual" }, change: { fields: { polar_id: { from: null, to: "prod_pro_annual" } } } });
  });

  it("writes nothing when the same products are linked again", () => {
    const current = linked(stored(desiredBillingPlans(launchFile)));
    expect(link(current, linkFor(current))).toEqual({ writes: [], refusals: [] });
  });

  it("refuses a link that leaves a sold plan or a live price out", () => {
    const current = stored(desiredBillingPlans(launchFile));
    const plans = linkFor(current).filter((plan) => plan.code !== "starter");
    plans.find((plan) => plan.code === "pro")!.prices.pop();
    expect(link(current, plans).refusals).toEqual([
      { code: "links_incomplete", path: "plans", message: "starter is sold and isn't in the link. Name every live price of every sold plan." },
      { code: "links_incomplete", path: "plans.pro", message: "pro/monthly/cad is a live price of pro and has no product in the link." },
    ]);
  });

  it("refuses plans and prices that nothing sells: unknown, retired, unsold, named twice or in another period or currency", () => {
    const current = stored(desiredBillingPlans(launchFile));
    current.plans.find((plan) => plan.code === "pro-launch")!.status = "retired";
    const plans = linkFor(current);
    plans.push({ code: "gold", terms_hash: "0".repeat(64), provider_disc: null, prices: [{ period: "monthly", currency: "cad", provider_ref: "prod_gold" }] });
    plans.push({ code: "pro-launch", terms_hash: "0".repeat(64), provider_disc: "disc_x", prices: [{ period: "monthly", currency: "cad", provider_ref: "prod_x" }] });
    plans.push({ code: "enterprise", terms_hash: "0".repeat(64), provider_disc: null, prices: [{ period: "monthly", currency: "cad", provider_ref: "prod_y" }] });
    plans.push({ code: "pro", terms_hash: "0".repeat(64), provider_disc: null, prices: [] });
    const starter = plans.find((plan) => plan.code === "starter")!;
    starter.prices = [{ period: "monthly", currency: "usd", provider_ref: "prod_usd" }, ...starter.prices];
    const pro = plans.find((plan) => plan.code === "pro")!;
    pro.prices = [pro.prices[0]!, { ...pro.prices[0]!, provider_ref: "prod_again" }];
    expect(link(current, plans).refusals.map((refusal) => `${refusal.code} ${refusal.path}: ${refusal.message}`)).toEqual([
      "links_incomplete plans.pro: pro/monthly/cad is a live price of pro and has no product in the link.",
      "unknown_price plans[0].prices[0]: starter has no live monthly price in usd.",
      "unknown_price plans[1].prices[1]: pro annual is named twice.",
      "unknown_price plans[2].code: There's no plan gold.",
      "unknown_price plans[3].code: pro-launch is retired, so nothing sells it.",
      "unknown_price plans[4].code: enterprise isn't sold through Polar.",
      "unknown_price plans[5].code: pro is named twice.",
    ]);
  });

  it("refuses terms that changed since Polar was set up, and a discount the plan doesn't have or lacks", () => {
    const current = stored(desiredBillingPlans(launchFile));
    const plans = linkFor(current);
    plans.find((plan) => plan.code === "pro")!.terms_hash = "f".repeat(64);
    plans.find((plan) => plan.code === "starter")!.provider_disc = "disc_starter";
    plans.find((plan) => plan.code === "pro-launch")!.provider_disc = null;
    expect(link(current, plans).refusals.map((refusal) => `${refusal.code} ${refusal.path}`)).toEqual([
      "discount_mismatch plans[0].polar_disc",
      "terms_changed plans[1].terms_hash",
      "discount_mismatch plans[2].polar_disc",
    ]);
  });

  it("refuses a product or discount linked to another price or plan, or named twice", () => {
    const current = linked(stored(desiredBillingPlans(launchFile)));
    current.prices.push({ ...current.prices.find((price) => price.plan === "starter" && price.period === "annual")!, id: "starter-annual-old", provider_ref: "prod_old", retired_at: earlier });
    current.plans.push({ ...current.plans.find((plan) => plan.code === "pro-launch")!, code: "pro-launch-2025", status: "retired", provider_disc: "disc_other", retired_at: earlier });
    const plans = linkFor(current);
    plans.find((plan) => plan.code === "pro")!.prices[0]!.provider_ref = "prod_starter_monthly";
    plans.find((plan) => plan.code === "starter")!.prices[0]!.provider_ref = "prod_old";
    plans.find((plan) => plan.code === "pro-launch")!.provider_disc = "disc_other";
    const twice = link(current, plans, true).refusals.map((refusal) => refusal.message);
    expect(twice).toEqual([
      "Product prod_old is already linked to starter/annual/cad, a retired price. One product sells one price.",
      // Starter monthly keeps its product, which the link also names for Pro annual.
      "Product prod_starter_monthly is named for more than one price. One product sells one price.",
      "Product prod_starter_monthly is already linked to starter/monthly/cad. One product sells one price.",
      "Discount disc_other is already linked to pro-launch-2025. One discount belongs to one plan.",
    ]);
    const fresh = stored(desiredBillingPlans(launchFile));
    const same = linkFor(fresh);
    same.find((plan) => plan.code === "pro")!.prices[1]!.provider_ref = "prod_pro_annual";
    expect(link(fresh, same).refusals.map((refusal) => `${refusal.code} ${refusal.path}`)).toEqual(["id_taken plans[1].prices[0].polar_id", "id_taken plans[1].prices[1].polar_id"]);
  });

  it("keeps a linked price's product unless replace_ids retires its row and links the new product to a new row at the same price", () => {
    const current = linked(stored(desiredBillingPlans(launchFile)));
    const plans = linkFor(current);
    plans.find((plan) => plan.code === "pro")!.prices.find((price) => price.period === "monthly")!.provider_ref = "prod_pro_monthly_2";
    plans.find((plan) => plan.code === "pro-launch")!.provider_disc = "disc_pro-launch_2";
    expect(link(current, plans).refusals).toEqual([
      { code: "id_changed", path: "plans[1].prices[1].polar_id", message: "pro/monthly/cad is sold by product prod_pro_monthly. Send replace_ids to retire that row with its product and link prod_pro_monthly_2 to a new one." },
      { code: "id_changed", path: "plans[2].polar_disc", message: "pro-launch has discount disc_pro-launch. Send replace_ids to link disc_pro-launch_2 instead." },
    ]);
    const replaced = link(current, plans, true);
    expect(replaced.refusals).toEqual([]);
    expect(replaced.writes.map((write) => [write.change.action, write.change.key, write.set])).toEqual([
      ["update", "pro-launch", { provider_disc: "disc_pro-launch_2" }],
      ["retire", "pro/monthly/cad", { retired_at: now }],
      ["insert", "pro/monthly/cad", { plan: "pro", period: "monthly", currency: "cad", cents: 8700, provider_ref: "prod_pro_monthly_2" }],
    ]);
    expect(replaced.writes[1]!.id).toBe("pro-monthly-cad");
  });

  it("forgets the Polar discount of a plan whose discount the file dropped", () => {
    const current = linked(stored(desiredBillingPlans(launchFile)));
    const dropped = desiredBillingPlans(profile((file) => {
      file.plans["pro-launch"] = proLaunch;
    })).find((plan) => plan.code === "pro-launch")!;
    // The apply wrote the plan's new terms and sent it back to draft.
    Object.assign(current.plans.find((plan) => plan.code === "pro-launch")!, { discount: null, terms_hash: dropped.terms_hash, status: "draft" });
    const { writes, refusals } = link(current, linkFor(current));
    expect(refusals).toEqual([]);
    expect(writes.map((write) => [write.change.action, write.change.key, write.set])).toEqual([
      ["update", "pro-launch", { provider_disc: null, status: "active" }],
    ]);
    expect(writes[0]!.change.fields.polar_disc).toEqual({ from: "disc_pro-launch", to: null });
  });
});

type PackRows = { packs: StoredBillingPack[]; packPrices: StoredBillingPackPrice[] };

/** The pack rows Postgres would hold after applying a file, every pack with status and its one live price. */
function storedPacks(packs: DesiredBillingPack[], status: StoredBillingPack["status"] = "draft"): PackRows {
  return {
    packs: packs.map(({ price: _price, ...pack }) => ({ ...pack, status, frozen_at: null, run_id: null, retired_at: null, created_at: earlier, updated_at: earlier })),
    packPrices: packs.map((pack) => ({ id: `${pack.code}-${pack.price.currency}`, pack: pack.code, currency: pack.price.currency, cents: pack.price.cents, provider_ref: null, run_id: null, retired_at: null, created_at: earlier, updated_at: earlier })),
  };
}

function packDiff(file: BillingProfile, current: PackRows, plans: Array<Pick<StoredBillingPlan, "code">> = []) {
  return diffBillingPackCatalog({ packs: desiredBillingPacks(file), currency: file.currency, current: { plans, ...current }, now });
}

const withoutPacks = (file: Record<string, any>) => { delete file.packs; };
// The brand file's nine packs, in the order a diff lists them: by code.
const packCodes = desiredBillingPacks(profile()).map((pack) => pack.code).sort();

describe("billing pack diff", () => {
  it("gives every plan the same row and terms hash whether or not the file has packs", () => {
    expect(desiredBillingPlans(profile())).toEqual(desiredBillingPlans(profile(withoutPacks)));
    expect(diff(profile(), { plans: [], prices: [] })).toEqual(diff(profile(withoutPacks), { plans: [], prices: [] }));
  });

  it("resolves each pack to a complete row, what it leaves out taken from Starter, smallest and shortest first", () => {
    const packs = desiredBillingPacks(profile());
    expect(packs.map((pack) => [pack.code, pack.voice_sec, pack.days, pack.sort, pack.price.cents])).toEqual([
      ["pack_250_90", 15000, 90, 10, 5500],
      ["pack_250_180", 15000, 180, 20, 5900],
      ["pack_250_365", 15000, 365, 30, 6500],
      ["pack_500_90", 30000, 90, 40, 9500],
      ["pack_500_180", 30000, 180, 50, 9900],
      ["pack_500_365", 30000, 365, 60, 10900],
      ["pack_1000_90", 60000, 90, 70, 17900],
      ["pack_1000_180", 60000, 180, 80, 18900],
      ["pack_1000_365", 60000, 365, 90, 19900],
    ]);
    // Starter's texts, transfers, chats, number and receptionist, and the pack's own storage.
    expect(packs[0]).toMatchObject({ sms_seg: 50, calls_out: 20, chat_units: 50, kb_bytes: 20 * 1_048_576, numbers: 1, receptionists: 1, price: { currency: "cad", cents: 5500 } });
    expect(new Set(packs.map((pack) => pack.terms_hash)).size).toBe(9);
    expect(desiredBillingPacks(profile(withoutPacks))).toEqual([]);
  });

  it("seeds a file's packs as drafts, each with one price, in table then key order", () => {
    const { writes, refusals } = packDiff(profile(), { packs: [], packPrices: [] });
    expect(refusals).toEqual([]);
    expect(summary(writes)).toEqual([...packCodes.map((code) => `insert billing_pack_plans ${code}`), ...packCodes.map((code) => `insert billing_pack_prices ${code}/cad`)]);
    const pack = desiredBillingPacks(profile())[0]!;
    expect(writes.find((write) => write.change.key === "pack_250_90")!.set).toEqual({ code: "pack_250_90", names: pack.names, voice_sec: 15000, days: 90, sms_seg: 50, calls_out: 20, chat_units: 50, kb_bytes: 20 * 1_048_576, numbers: 1, receptionists: 1, terms_hash: pack.terms_hash, sort: 10, status: "draft" });
    expect(writes.find((write) => write.change.key === "pack_250_90/cad")!.set).toEqual({ pack: "pack_250_90", currency: "cad", cents: 5500 });
    expect(writes.every((write) => Object.keys(write.change.fields).length === 0 && !write.change.lowers_allowance && !write.change.raises_price)).toBe(true);
  });

  it("writes nothing for a file without packs, and nothing when the pack tables already match the file", () => {
    expect(packDiff(profile(withoutPacks), { packs: [], packPrices: [] })).toEqual({ writes: [], refusals: [] });
    const file = profile();
    expect(packDiff(file, storedPacks(desiredBillingPacks(file), "active"))).toEqual({ writes: [], refusals: [] });
  });

  it("retires every pack the file drops with its price, never deleting one", () => {
    const current = storedPacks(desiredBillingPacks(profile()), "active");
    const { writes, refusals } = packDiff(profile((file) => { delete file.packs.pack_250_90; }), current);
    expect(refusals).toEqual([]);
    // The packs after it move up a place, which changes no terms.
    expect(writes.filter((write) => write.change.action !== "update" || !("sort" in write.change.fields)).map((write) => [write.change.action, write.change.key, write.set])).toEqual([
      ["retire", "pack_250_90", { status: "retired", retired_at: now }],
      ["retire", "pack_250_90/cad", { retired_at: now }],
    ]);
    expect(writes.filter((write) => write.change.action === "update").every((write) => Object.keys(write.set).join() === "sort")).toBe(true);
    expect(summary(packDiff(profile(withoutPacks), current).writes)).toEqual([...packCodes.map((code) => `retire billing_pack_plans ${code}`), ...packCodes.map((code) => `retire billing_pack_prices ${code}/cad`)]);
  });

  it("flags fewer minutes, a shorter length and a higher price, and sends an active pack back to draft when its terms change", () => {
    const current = storedPacks(desiredBillingPacks(profile()), "active");
    const { writes, refusals } = packDiff(profile((file) => {
      file.packs.pack_250_90.minutes = 200;
      file.packs.pack_500_180.days = 120;
      delete file.packs.pack_1000_365.days;
      file.packs.pack_1000_90.priceCents = 18900;
      file.packs.pack_500_90.names.en = "500 minutes for 3 months";
    }), current);
    expect(refusals).toEqual([]);
    const byKey = Object.fromEntries(writes.map((write) => [write.change.key, write]));
    expect(byKey.pack_250_90!.change).toMatchObject({ action: "update", lowers_allowance: true, fields: { voice_sec: { from: 15000, to: 12000 }, status: { from: "active", to: "draft" } } });
    expect(byKey.pack_500_180!.change).toMatchObject({ lowers_allowance: true, fields: { days: { from: 180, to: 120 } } });
    // A pack that never ends is longer than any length.
    expect(byKey.pack_1000_365!.change).toMatchObject({ lowers_allowance: false, fields: { days: { from: 365, to: null } } });
    expect(byKey["pack_1000_90/cad"]!).toMatchObject({ id: "pack_1000_90-cad", set: { cents: 18900 }, change: { action: "update", raises_price: true, fields: { cents: { from: 17900, to: 18900 } } } });
    // The price is in the terms; the names aren't.
    expect(byKey.pack_1000_90!.change.fields.status).toEqual({ from: "active", to: "draft" });
    expect(byKey.pack_500_90!.change.fields).toEqual({ names: { from: current.packs.find((pack) => pack.code === "pack_500_90")!.names, to: expect.objectContaining({ en: "500 minutes for 3 months" }) } });
  });

  it("refuses to change a bought pack's minutes or length, and lets its names, price and allowances change", () => {
    const current = storedPacks(desiredBillingPacks(profile()), "active");
    current.packs.find((pack) => pack.code === "pack_250_90")!.frozen_at = earlier;
    const minutes = packDiff(profile((file) => { file.packs.pack_250_90.minutes = 300; }), current);
    expect(minutes.refusals).toEqual([{ code: "plan_frozen", path: "billing_file.packs.pack_250_90", message: `pack_250_90 has been bought since ${earlier}, so its minutes and length can't change. Put new minutes or a new length under a new code.` }]);
    expect(packDiff(profile((file) => { delete file.packs.pack_250_90.days; }), current).refusals.map((refusal) => refusal.code)).toEqual(["plan_frozen"]);
    const allowed = packDiff(profile((file) => {
      file.packs.pack_250_90.priceCents = 6000;
      file.packs.pack_250_90.names.fr = "250 minutes pendant 90 jours";
      file.packs.pack_250_90.included = { alertSmsSegments: 80 };
    }), current);
    expect(allowed.refusals).toEqual([]);
    expect(allowed.writes.map((write) => write.change.key)).toEqual(["pack_250_90", "pack_250_90/cad"]);
  });

  it("brings a pack back with its latest price row, and refuses a currency change while a provider sells a live pack price", () => {
    const current = storedPacks(desiredBillingPacks(profile()), "active");
    const pack = current.packs.find((entry) => entry.code === "pack_500_365")!;
    Object.assign(pack, { status: "retired", retired_at: earlier });
    const price = current.packPrices.find((entry) => entry.pack === "pack_500_365")!;
    Object.assign(price, { retired_at: earlier, provider_ref: "prod_old" });
    current.packPrices.push({ ...price, id: "pack_500_365-cad-older", retired_at: "2026-10-01T08:00:00.000Z", provider_ref: "prod_older" });
    const restored = packDiff(profile(), current);
    expect(restored.refusals).toEqual([]);
    expect(restored.writes.map((write) => [write.change.action, write.change.key, write.id ?? null, write.set])).toEqual([
      ["restore", "pack_500_365", null, { status: "draft", retired_at: null }],
      ["restore", "pack_500_365/cad", "pack_500_365-cad", { cents: 10900, retired_at: null }],
    ]);

    const live = storedPacks(desiredBillingPacks(profile()), "active");
    live.packPrices[0]!.provider_ref = "price_1";
    const usd = profile((file) => { file.currency = "usd"; });
    expect(packDiff(usd, live).refusals).toEqual([{ code: "currency_locked", path: "billing_file.currency", message: "The billing provider already sells packs in cad, so the currency can't change to usd while those prices are live." }]);
    live.packPrices[0]!.provider_ref = null;
    const moved = packDiff(usd, live);
    expect(moved.refusals).toEqual([]);
    expect(summary(moved.writes.filter((write) => write.change.table === "billing_pack_prices"))).toEqual(packCodes.flatMap((code) => [`retire billing_pack_prices ${code}/cad`, `insert billing_pack_prices ${code}/usd`]));
  });

  it("refuses a pack whose code a plan already has, made through the API or retired", () => {
    const { writes, refusals } = packDiff(profile(), { packs: [], packPrices: [] }, [{ code: "pack_250_90" }]);
    expect(refusals).toEqual([{ code: "code_taken", path: "billing_file.packs.pack_250_90", message: "A plan already has the code pack_250_90, so a pack can't use it. Pick another code." }]);
    expect(writes.some((write) => write.change.key.startsWith("pack_250_90"))).toBe(false);
  });

  it("writes plans before their prices and packs before theirs, retirements first in each table", () => {
    const current = storedPacks(desiredBillingPacks(profile()), "active");
    const usd = profile((file) => { file.currency = "usd"; });
    const ordered = billingCatalogWriteOrder([...diff(usd, stored(desiredBillingPlans(profile()))).writes, ...packDiff(usd, current).writes]);
    const tables = [...new Set(ordered.map((write) => write.change.table))];
    expect(tables).toEqual(["billing_pack_plans", "billing_pack_prices", "billing_plans", "billing_prices"]);
    const packPrices = ordered.filter((write) => write.change.table === "billing_pack_prices").map((write) => write.change.action);
    expect(packPrices).toEqual([...Array.from({ length: 9 }, () => "retire"), ...Array.from({ length: 9 }, () => "insert")]);
  });

  it("shows each pack with its live price first, then its retired ones, latest first", () => {
    const current = storedPacks(desiredBillingPacks(profile()), "active");
    const price = current.packPrices.find((entry) => entry.pack === "pack_250_90")!;
    current.packPrices.push({ ...price, id: "older", cents: 5000, retired_at: "2026-10-01T08:00:00.000Z" }, { ...price, id: "old", cents: 5200, retired_at: earlier });
    const [first] = billingCatalogPacks(current);
    expect(first).toMatchObject({ code: "pack_250_90", status: "active", voice_sec: 15000 });
    expect(first).not.toHaveProperty("run_id");
    expect(first!.prices.map((entry) => [entry.id, entry.cents, entry.retired_at])).toEqual([["pack_250_90-cad", 5500, null], ["old", 5200, earlier], ["older", 5000, "2026-10-01T08:00:00.000Z"]]);
    expect(first!.prices[0]).not.toHaveProperty("pack");
  });
});

describe("billing pack link diff", () => {
  type LinkPacks = Parameters<typeof diffBillingPackLinks>[0]["body"]["packs"];
  type Rows = PackRows & { prices: StoredBillingPrice[] };

  const fresh = (): Rows => ({ ...storedPacks(desiredBillingPacks(profile())), prices: [] });

  /** A link naming object prod_<pack> for the live price of every pack that isn't retired. */
  function linkFor(current: Rows): LinkPacks {
    return current.packs.filter((pack) => pack.status !== "retired").map((pack) => {
      const price = current.packPrices.find((entry) => entry.pack === pack.code && entry.retired_at === null)!;
      return { code: pack.code, terms_hash: pack.terms_hash, currency: price.currency, provider_ref: `prod_${pack.code}` };
    });
  }

  function link(current: Rows, packs: LinkPacks, options: { replaceIds?: boolean; provider?: "polar" | "stripe"; plans?: Parameters<typeof diffBillingPackLinks>[0]["body"]["plans"] } = {}) {
    return diffBillingPackLinks({ body: { plans: options.plans ?? [], packs, replace_ids: options.replaceIds ?? false, provider: options.provider ?? "polar" }, current, now });
  }

  /** The rows after a link went through. */
  function linked(current: Rows): Rows {
    for (const pack of current.packs) if (pack.status === "draft") pack.status = "active";
    for (const price of current.packPrices) if (price.retired_at === null) price.provider_ref = `prod_${price.pack}`;
    return current;
  }

  it("links the live price of every pack that isn't retired, and makes each draft pack active", () => {
    const current = fresh();
    const { writes, refusals } = link(current, linkFor(current));
    expect(refusals).toEqual([]);
    expect(summary(writes)).toEqual([...packCodes.map((code) => `update billing_pack_plans ${code}`), ...packCodes.map((code) => `update billing_pack_prices ${code}/cad`)]);
    expect(writes.find((write) => write.change.key === "pack_250_90")).toMatchObject({ set: { status: "active" }, change: { fields: { status: { from: "draft", to: "active" } } } });
    expect(writes.find((write) => write.change.key === "pack_250_90/cad")).toMatchObject({ id: "pack_250_90-cad", set: { provider_ref: "prod_pack_250_90" }, change: { fields: { provider_ref: { from: null, to: "prod_pack_250_90" } } } });
  });

  it("writes nothing when the same objects are linked again", () => {
    const current = linked(fresh());
    expect(link(current, linkFor(current))).toEqual({ writes: [], refusals: [] });
  });

  it("refuses a link that leaves a pack out, or names one twice, unknown, retired, in another currency or on other terms", () => {
    const current = fresh();
    current.packs.find((pack) => pack.code === "pack_1000_365")!.status = "retired";
    const packs = linkFor(current).filter((pack) => pack.code !== "pack_250_180");
    packs[0] = { ...packs[0]!, currency: "usd" };
    packs[1] = { ...packs[1]!, terms_hash: "f".repeat(64) };
    packs.push({ code: "pack_gold", terms_hash: "0".repeat(64), currency: "cad", provider_ref: "prod_gold" });
    packs.push({ code: "pack_1000_365", terms_hash: "0".repeat(64), currency: "cad", provider_ref: "prod_retired" });
    packs.push({ ...packs[2]!, provider_ref: "prod_again" });
    const terms = current.packs.find((pack) => pack.code === "pack_250_365")!.terms_hash;
    expect(link(current, packs).refusals.map((refusal) => `${refusal.code} ${refusal.path}: ${refusal.message}`)).toEqual([
      "links_incomplete packs: Pack pack_250_180 isn't retired and isn't in the link. Name every pack that isn't retired, with the product that sells its live price.",
      "unknown_price packs[0].currency: Pack pack_250_90 has no live price in usd.",
      `terms_changed packs[1].terms_hash: Pack pack_250_365's terms are ${terms.slice(0, 12)} now, not ffffffffffff: its Polar product was made from other terms. Set Polar up from the latest file again.`,
      "unknown_price packs[7].code: There's no pack pack_gold.",
      "unknown_price packs[8].code: Pack pack_1000_365 is retired, so nothing sells it.",
      "unknown_price packs[9].code: Pack pack_500_90 is named twice.",
    ]);
  });

  it("refuses an object already linked to a plan's price or another pack's, or named for two prices, across both tables", () => {
    const current = linked(fresh());
    current.prices.push({ id: "pro-monthly-cad", plan: "pro", period: "monthly", currency: "cad", cents: 8700, per_month: 8700, provider_ref: "prod_pro_monthly", run_id: null, retired_at: null, created_at: earlier, updated_at: earlier });
    const packs = linkFor(current);
    packs[0] = { ...packs[0]!, provider_ref: "prod_pro_monthly" };
    packs[1] = { ...packs[1]!, provider_ref: "prod_pack_500_90" };
    expect(link(current, packs, { replaceIds: true }).refusals.map((refusal) => `${refusal.code} ${refusal.path}: ${refusal.message}`)).toEqual([
      "id_taken packs[0].provider_ref: Product prod_pro_monthly is already linked to pro/monthly/cad. One product sells one price.",
      "id_taken packs[1].provider_ref: Product prod_pack_500_90 is already linked to pack_500_90/cad. One product sells one price.",
      // pack_500_90 keeps its product, which the link also names for pack_250_180.
      "id_taken packs[3].provider_ref: Product prod_pack_500_90 is named for more than one price. One product sells one price.",
    ]);
    // A plan's price and a pack named with the same object, on Stripe.
    const both = fresh();
    const plans = [{ code: "pro", terms_hash: "0".repeat(64), provider_disc: null, prices: [{ period: "monthly" as const, currency: "cad", provider_ref: "price_shared" }] }];
    const named = linkFor(both).map((pack, index) => (index === 0 ? { ...pack, provider_ref: "price_shared" } : pack));
    expect(link(both, named, { provider: "stripe", plans }).refusals.map((refusal) => refusal.message)).toEqual(["Stripe price price_shared is named for more than one price. One Stripe price sells one price."]);
    // And the plans' side finds an object a pack's price has.
    const planRows = stored(desiredBillingPlans(profile()));
    const planLinks = planRows.plans.filter((plan) => plan.sold).map((plan) => ({ code: plan.code, terms_hash: plan.terms_hash, provider_disc: null, prices: planRows.prices.filter((price) => price.plan === plan.code).map((price) => ({ period: price.period, currency: price.currency, provider_ref: `prod_${plan.code}_${price.period}` })) }));
    planLinks[0]!.prices[0]!.provider_ref = "prod_pack_250_90";
    const planSide = diffBillingLinks({ body: { plans: planLinks, replace_ids: false, provider: "polar", names: "polar" }, current: { ...planRows, packPrices: current.packPrices }, now });
    expect(planSide.refusals.map((refusal) => refusal.message)).toEqual(["Product prod_pack_250_90 is already linked to pack_250_90/cad. One product sells one price."]);
  });

  it("keeps a linked pack's object unless replace_ids retires its row and links the new object to a new row at the same price", () => {
    const current = linked(fresh());
    const packs = linkFor(current).map((pack) => (pack.code === "pack_500_180" ? { ...pack, provider_ref: "prod_pack_500_180_2" } : pack));
    expect(link(current, packs).refusals).toEqual([{ code: "id_changed", path: "packs[4].provider_ref", message: "pack_500_180/cad is sold by product prod_pack_500_180. Send replace_ids to retire that row with its product and link prod_pack_500_180_2 to a new one." }]);
    const replaced = link(current, packs, { replaceIds: true });
    expect(replaced.refusals).toEqual([]);
    expect(replaced.writes.map((write) => [write.change.action, write.change.key, write.id ?? null, write.set])).toEqual([
      ["retire", "pack_500_180/cad", "pack_500_180-cad", { retired_at: now }],
      ["insert", "pack_500_180/cad", null, { pack: "pack_500_180", currency: "cad", cents: 9900, provider_ref: "prod_pack_500_180_2" }],
    ]);
    expect(replaced.writes[1]!.change.fields).toEqual({ provider_ref: { from: "prod_pack_500_180", to: "prod_pack_500_180_2" } });
    // The old object stays with its retired row.
    current.packPrices.find((price) => price.pack === "pack_500_180")!.retired_at = now;
    current.packPrices.push({ ...current.packPrices.find((price) => price.pack === "pack_500_180")!, id: "pack_500_180-cad-2", provider_ref: "prod_pack_500_180_2", retired_at: null });
    expect(link(current, linkFor(current).map((pack) => (pack.code === "pack_500_180" ? { ...pack, provider_ref: "prod_pack_500_180" } : pack)), { replaceIds: true }).refusals.map((refusal) => refusal.message)).toEqual(["Product prod_pack_500_180 is already linked to pack_500_180/cad, a retired price. One product sells one price."]);
  });
});
