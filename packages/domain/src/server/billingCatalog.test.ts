import { readFileSync } from "node:fs";

import { billingProfileSchema, type BillingProfile } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { billingCatalogWriteOrder, desiredBillingPlans, diffBillingCatalog, type DesiredBillingPlan, type StoredBillingPlan, type StoredBillingPrice } from "./billingCatalog";

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
    plans: plans.map(({ prices: _prices, ...plan }) => ({ ...plan, status: status(plan as DesiredBillingPlan), src: "file", polar_disc: null, frozen_at: null, run_id: null, retired_at: null, created_at: earlier, updated_at: earlier })),
    prices: plans.flatMap((plan) => plan.prices.map((price) => ({ id: `${plan.code}-${price.period}-${price.currency}`, plan: plan.code, period: price.period, currency: price.currency, cents: price.cents, per_month: price.period === "annual" ? Math.floor(price.cents / 12) : price.cents, polar_id: null, run_id: null, retired_at: null, created_at: earlier, updated_at: earlier }))),
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
    expect(writes.find((write) => write.change.key === "starter/monthly/cad")!.set).toEqual({ plan: "starter", period: "monthly", currency: "cad", cents: 3000 });
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
      file.plans.starter.prices.monthlyCents = 2500;
    });
    const { writes } = diff(after, stored(desiredBillingPlans(before)));
    const byKey = Object.fromEntries(writes.map((write) => [write.change.key, write.change]));
    expect(Object.keys(byKey)).toEqual(["pro", "starter", "pro/monthly/cad", "starter/monthly/cad"]);
    expect(byKey.pro).toMatchObject({ action: "update", lowers_allowance: true, raises_price: true, fields: { voice_sec: { from: 30000, to: 24000 }, sms_seg: { from: 200, to: 250 }, voice_rate: { from: 18, to: 20 } } });
    // A price is part of the terms, so the plan's terms_hash moves with it.
    expect(byKey.starter).toMatchObject({ action: "update", lowers_allowance: false, raises_price: false });
    expect(Object.keys(byKey.starter!.fields)).toEqual(["terms_hash"]);
    expect(byKey["pro/monthly/cad"]).toMatchObject({ action: "update", raises_price: true, lowers_allowance: false, fields: { cents: { from: 10000, to: 11000 } } });
    expect(byKey["starter/monthly/cad"]).toMatchObject({ raises_price: false, fields: { cents: { from: 3000, to: 2500 } } });
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
    const inherited = diff(profile((file) => { file.plans["pro-launch"] = proLaunch; file.plans.pro.limits.businessNumbers = 2; }), frozen());
    expect(inherited.refusals.map((refusal) => refusal.code)).toEqual(["plan_frozen"]);
    const renamed = diff(profile((file) => { file.plans["pro-launch"] = { ...proLaunch, access: "public", names: { ...proLaunch.names, en: "Launch" } }; }), frozen());
    expect(renamed.refusals).toEqual([]);
    expect(Object.keys(renamed.writes[0]!.change.fields).sort()).toEqual(["access", "names"]);
    const removed = diff(profile(), frozen());
    expect(removed.refusals).toEqual([]);
    expect(summary(removed.writes)).toEqual(["retire billing_plans pro-launch", "retire billing_prices pro-launch/monthly/cad"]);
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
    Object.assign(live, { retired_at: earlier, polar_id: "price_new", cents: 6500 });
    current.prices.push({ ...live, id: "older", retired_at: "2026-10-01T00:00:00.000Z", polar_id: "price_old" });
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
    linked.prices[0]!.polar_id = "price_1";
    expect(diff(after, linked).refusals).toEqual([expect.objectContaining({ code: "currency_locked", path: "billing_file.currency" })]);
  });
});
