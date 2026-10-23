import { readFileSync } from "node:fs";

import { billingProfileSchema, type BillingProfile } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { PolarCatalogClient } from "../../../providers/src/polar/polarCatalog";
import { desiredBillingPlans } from "./billingCatalog";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans, runPolarSteps, type PolarPlanOptions } from "./billingPolar";
import { createFakePolar, seedPolarSetup, type FakePolar } from "./billingPolar.testing";

// The Polar plan on a stand-in that keeps Polar's rules: what a file needs,
// what an organization gets, and that running the plan leaves nothing to do.

const fileText = readFileSync(new URL("../../../../brands/alloplace/billing.json", import.meta.url), "utf8");
const webhookUrl = "https://demo.alloplace.com/api/webhooks/polar";
const now = "2026-10-21T20:00:00.000Z";
const strict: PolarPlanOptions = { adopt: false, allowReplace: false, allowArchive: false };

function profile(change: (file: Record<string, any>) => void = () => undefined): BillingProfile {
  const file = JSON.parse(fileText) as Record<string, any>;
  change(file);
  return billingProfileSchema.parse(file);
}

const proLaunch = {
  tier: "pro",
  access: "code",
  names: { en: "Pro launch", fr: "Lancement Pro", es: "Lanzamiento Pro", sr: "Pro lansiranje" },
  sold: true,
  prices: { monthlyCents: 6000 },
  discount: { type: "percentage", basisPoints: 2500, duration: "repeating", durationInMonths: 3 },
};

function catalogFor(file: BillingProfile, brand = "alloplace") {
  return desiredPolarCatalog({ brand, profile: file, plans: desiredBillingPlans(file), webhookUrl });
}

function client(fake: FakePolar) {
  return new PolarCatalogClient({ token: "polar_oat_test", baseUrl: "https://sandbox-api.polar.sh", fetch: fake.fetch, sleep: async () => undefined });
}

async function plan(fake: FakePolar, file: BillingProfile, options: Partial<PolarPlanOptions> = {}) {
  return planPolarChanges({ catalog: catalogFor(file), snapshot: await client(fake).readSnapshot(), options: { ...strict, ...options }, now });
}

/** Plans and runs every call, then plans again: an applied file leaves nothing to do. */
async function apply(fake: FakePolar, file: BillingProfile, options: Partial<PolarPlanOptions> = {}) {
  const first = await plan(fake, file, options);
  expect(first.refusals).toEqual([]);
  const result = await runPolarSteps(client(fake), first.steps);
  const again = await plan(fake, file);
  expect(again.steps).toEqual([]);
  expect(again.refusals).toEqual([]);
  return { first, result };
}

const summary = (steps: ReadonlyArray<{ object: string; action: string }>) => steps.map((step) => `${step.action} ${step.object}`);

describe("desiredPolarCatalog", () => {
  it("maps AlloPlace's file to 3 meters, 4 products with 4 fixed and 12 metered prices, no discount and the webhook", () => {
    const catalog = catalogFor(profile());
    expect(catalog.meters.map((meter) => [meter.key, meter.name, meter.event])).toEqual([
      ["voice_minutes", "Voice minutes", "billing.voice_minutes"],
      ["alert_sms_segments", "Alert SMS segments", "billing.alert_sms_segments"],
      ["outbound_call_attempts", "Call transfers", "billing.outbound_call_attempts"],
    ]);
    expect(catalog.products.map((product) => [product.name, product.interval, product.cents, product.currency, product.rates, product.visibility])).toEqual([
      ["Starter annual", "year", 28800, "cad", { voice_minutes: 20, alert_sms_segments: 2, outbound_call_attempts: 2 }, "public"],
      ["Starter monthly", "month", 3000, "cad", { voice_minutes: 20, alert_sms_segments: 2, outbound_call_attempts: 2 }, "public"],
      ["Pro annual", "year", 96000, "cad", { voice_minutes: 18, alert_sms_segments: 2, outbound_call_attempts: 2 }, "public"],
      ["Pro monthly", "month", 10000, "cad", { voice_minutes: 18, alert_sms_segments: 2, outbound_call_attempts: 2 }, "public"],
    ]);
    expect(catalog.discounts).toEqual([]);
    expect(catalog.webhook).toEqual({ url: webhookUrl, events: expect.arrayContaining(["subscription.created", "order.refunded"]) });
    expect(catalog.webhook!.events).toHaveLength(15);
    expect(catalog.settings).toEqual({ allowMultipleSubscriptions: false, portalPlanChanges: true });
  });

  it("makes a code plan's products private, with the plan's discount", () => {
    const catalog = catalogFor(profile((file) => {
      file.plans["pro-launch"] = proLaunch;
    }));
    expect(catalog.products.find((product) => product.plan === "pro-launch")).toMatchObject({ name: "Pro launch monthly", visibility: "private", cents: 6000 });
    expect(catalog.discounts).toEqual([expect.objectContaining({ plan: "pro-launch", name: "Pro launch discount", products: ["pro-launch/monthly"] })]);
  });

  it("names a plan by its own code's label", () => {
    const catalog = catalogFor(profile((file) => {
      file.plans.constructor = { ...proLaunch, names: { en: "Builders", fr: "Builders", es: "Builders", sr: "Builders" }, prices: { annualCents: 60_000 }, discount: undefined };
    }));
    expect(catalog.products.filter((product) => product.plan === "constructor").map((product) => [product.name, product.interval])).toEqual([["Builders annual", "year"]]);
  });
});

describe("planPolarChanges", () => {
  it("sets up an empty organization with creates only, and a second run makes no call", async () => {
    const fake = createFakePolar();
    const { first } = await apply(fake, profile());
    expect(summary(first.steps)).toEqual([
      "update organization",
      ...Array(3).fill("create meter"),
      ...Array(4).fill("create product"),
      "create webhook",
    ]);
    expect(fake.state.organization).toMatchObject({ subscription_settings: { allow_multiple_subscriptions: false, allow_customer_updates: true }, customer_portal_settings: { usage: { show: true }, subscription: { update_plan: true, update_seats: true } } });
    const monthly = fake.state.products.find((product) => product.name === "Pro monthly")!;
    expect(monthly.metadata).toEqual({ lobbystack_brand: "alloplace", lobbystack_plan: "pro", lobbystack_interval: "monthly", lobbystack_terms: desiredBillingPlans(profile()).find((entry) => entry.code === "pro")!.terms_hash });
    expect(fake.state.products.every((product) => product.benefitIds.length === 0)).toBe(true);
    expect(fake.state.benefits).toEqual([]);
    expect(fake.state.meters.map((meter) => meter.metadata)).toEqual([{ lobbystack_meter: "voice_minutes" }, { lobbystack_meter: "alert_sms_segments" }, { lobbystack_meter: "outbound_call_attempts" }]);
  });

  it("adopts what polar-setup.mjs made by tagging it, so product ids stay and every link is found, and takes its Credits off", async () => {
    const fake = createFakePolar();
    await seedPolarSetup(fake);
    const ids = fake.state.products.map((product) => product.id);
    const { first } = await apply(fake, profile(), { adopt: true });
    expect(summary(first.steps)).toEqual([...Array(3).fill("tag meter"), ...Array(4).fill("tag product"), "detach product", "detach product"]);
    expect(first.steps.filter((step) => step.action === "tag").every((step) => step.changes.includes("tag it as LobbyStack's"))).toBe(true);
    expect(first.steps.filter((step) => step.action === "detach").map((step) => [step.subject, step.changes])).toEqual([
      ['Product "Starter monthly"', ['detach "150 voice minutes a month", "50 alert SMS segments a month", "20 call transfers a month": the worker reports only each month\'s overage']],
      ['Product "Pro monthly"', ['detach "500 voice minutes a month", "200 alert SMS segments a month", "100 call transfers a month": the worker reports only each month\'s overage']],
    ]);
    // The Credits stay in Polar, on no product.
    expect(fake.state.products.every((product) => product.benefitIds.length === 0)).toBe(true);
    expect(fake.state.benefits).toHaveLength(6);
    expect(fake.state.products.map((product) => product.id)).toEqual(ids);
    expect(fake.state.products.every((product) => product.prices.every((price) => !price.is_archived))).toBe(true);
    const links = polarLinkPlans({ catalog: catalogFor(profile()), plans: desiredBillingPlans(profile()), snapshot: await client(fake).readSnapshot(), now });
    expect(links.missing).toEqual([]);
    expect(links.plans.flatMap((entry) => entry.prices.map((price) => price.polar_id)).sort()).toEqual([...ids].sort());
  });

  it("refuses each untagged lookalike without --adopt, so a forgotten flag makes no duplicate", async () => {
    const fake = createFakePolar();
    await seedPolarSetup(fake);
    const result = await plan(fake, profile());
    expect(result.refusals.map((refusal) => refusal.subject)).toEqual([
      'Meter "Voice minutes"', 'Meter "Alert SMS segments"', 'Meter "Call transfers"',
      'Product "Starter annual"', 'Product "Starter monthly"', 'Product "Pro annual"', 'Product "Pro monthly"',
    ]);
    expect(result.refusals[0]!.message).toContain("Run with --adopt");
  });

  it("changes a price on the same product, sending the prices it keeps by id, so subscribers keep theirs", async () => {
    const fake = createFakePolar();
    await apply(fake, profile());
    const before = fake.state.products.find((product) => product.name === "Pro monthly")!;
    const kept = before.prices.filter((price) => price.amount_type === "metered_unit").map((price) => price.id);
    const { first } = await apply(fake, profile((file) => {
      file.plans.pro.prices.monthlyCents = 12000;
    }));
    const step = first.steps.find((entry) => entry.subject === 'Product "Pro monthly"')!;
    expect(step.changes).toEqual(["add 120.00 CAD a month", "drop 100.00 CAD fixed", expect.stringMatching(/^made from older terms/)]);
    expect((step.body as { prices: unknown[] }).prices).toEqual([...kept.map((id) => ({ id })), { amount_type: "fixed", price_amount: 12000, price_currency: "cad" }]);
    const after = fake.state.products.find((product) => product.id === before.id)!;
    expect(after.prices.filter((price) => !price.is_archived && price.amount_type === "fixed").map((price) => price.price_amount)).toEqual([12000]);
    expect(after.prices.find((price) => price.price_amount === 10000)!.is_archived).toBe(true);
    expect(fake.state.products.filter((product) => product.metadata.lobbystack_plan === "pro")).toHaveLength(2);
  });

  it("changes an allowance with no Polar call, as no product carries Credits", async () => {
    const fake = createFakePolar();
    await apply(fake, profile());
    const fewer = await apply(fake, profile((file) => {
      file.plans.pro.included.voiceMinutes = 400;
    }));
    // Only the terms tag on Pro's products moves.
    expect(fewer.first.steps.map((step) => [step.subject, step.changes])).toEqual([
      ['Product "Pro annual"', [expect.stringMatching(/^made from older terms/)]],
      ['Product "Pro monthly"', [expect.stringMatching(/^made from older terms/)]],
    ]);
  });

  it("takes Credits off every product of the brand, one it archives included, and keeps other benefits", async () => {
    const fake = createFakePolar();
    await apply(fake, profile());
    const meterId = fake.state.meters[0]!.id;
    fake.state.benefits.push(
      { id: "benefit_credits", type: "meter_credit", description: "500 voice minutes a month", properties: { units: 500, rollover: false, meter_id: meterId }, metadata: {} },
      { id: "benefit_onboarding", type: "custom", description: "Onboarding call", metadata: {} },
    );
    const proMonthly = fake.state.products.find((product) => product.name === "Pro monthly")!;
    const starterAnnual = fake.state.products.find((product) => product.name === "Starter annual")!;
    proMonthly.benefitIds = ["benefit_onboarding", "benefit_credits"];
    starterAnnual.benefitIds = ["benefit_credits"];
    const withoutAnnual = profile((file) => {
      delete file.plans.starter.prices.annualCents;
    });
    const { first } = await apply(fake, withoutAnnual, { allowArchive: true });
    // Starter's terms changed with its prices, so its monthly product is retagged first.
    expect(summary(first.steps)).toEqual(["update product", "detach product", "detach product", "archive product"]);
    const [proDetach, annualDetach] = first.steps.filter((step) => step.action === "detach");
    expect(proDetach).toMatchObject({ subject: 'Product "Pro monthly"', path: `/v1/products/${proMonthly.id}/benefits`, body: { benefits: ["benefit_onboarding"] } });
    expect(annualDetach).toMatchObject({ subject: 'Product "Starter annual"', body: { benefits: [] } });
    expect([proMonthly.benefitIds, starterAnnual.benefitIds, starterAnnual.is_archived]).toEqual([["benefit_onboarding"], [], true]);
  });

  it("turns access into visibility, archives a period that left the file only with --allow-archive, and brings it back later", async () => {
    const fake = createFakePolar();
    await apply(fake, profile((file) => {
      file.plans["pro-launch"] = { ...proLaunch, discount: undefined, prices: { monthlyCents: 6000 } };
    }));
    expect(fake.state.products.find((product) => product.name === "Pro launch monthly")!.visibility).toBe("private");
    await apply(fake, profile((file) => {
      file.plans["pro-launch"] = { ...proLaunch, discount: undefined, access: "public" };
    }));
    expect(fake.state.products.find((product) => product.name === "Pro launch monthly")!.visibility).toBe("public");

    const withoutAnnual = profile((file) => {
      file.plans["pro-launch"] = { ...proLaunch, discount: undefined, access: "public" };
      delete file.plans.starter.prices.annualCents;
    });
    expect((await plan(fake, withoutAnnual)).refusals).toEqual([expect.objectContaining({ subject: 'Product "Starter annual"', message: expect.stringContaining("--allow-archive") })]);
    const annual = fake.state.products.find((product) => product.name === "Starter annual")!;
    const archived = await apply(fake, withoutAnnual, { allowArchive: true });
    expect(archived.first.steps.filter((step) => step.action === "archive")).toEqual([expect.objectContaining({ leftover: true, path: `/v1/products/${annual.id}` })]);
    expect(annual.is_archived).toBe(true);

    const back = await apply(fake, profile((file) => {
      file.plans["pro-launch"] = { ...proLaunch, discount: undefined, access: "public" };
    }));
    expect(back.first.steps.find((step) => step.subject === 'Product "Starter annual"')).toMatchObject({ action: "update", body: expect.objectContaining({ is_archived: false }) });
    expect(fake.state.products.filter((product) => product.name === "Starter annual")).toHaveLength(1);
  });

  it("never reads another brand's objects as candidates, and refuses a lookalike tagged for another brand", async () => {
    const fake = createFakePolar();
    await apply(fake, profile());
    const other = desiredPolarCatalog({ brand: "cadre", profile: profile(), plans: desiredBillingPlans(profile()), webhookUrl: "https://cadre.example/api/webhooks/polar" });
    const otherPlan = planPolarChanges({ catalog: other, snapshot: await client(fake).readSnapshot(), options: { ...strict, allowArchive: true }, now });
    expect(otherPlan.steps.filter((step) => step.action === "archive")).toEqual([]);
    expect(otherPlan.refusals.filter((refusal) => refusal.object === "product").map((refusal) => refusal.message)).toEqual(Array(4).fill(expect.stringContaining("is tagged for alloplace")));
  });

  it("refuses two tagged products for one price, and a currency switch while a live product has no price in it", async () => {
    const fake = createFakePolar();
    await apply(fake, profile());
    const copy = structuredClone(fake.state.products.find((product) => product.name === "Pro annual")!);
    fake.state.products.push({ ...copy, id: "product_copy", name: "Pro annual copy" });
    expect((await plan(fake, profile())).refusals).toEqual([expect.objectContaining({ subject: 'Product "Pro annual"', message: expect.stringContaining("2 live products are tagged alloplace pro annual") })]);
    fake.state.products.pop();
    const usd = await plan(fake, profile((file) => {
      file.currency = "usd";
    }));
    expect(usd.refusals).toEqual([expect.objectContaining({ object: "organization", message: expect.stringContaining("Polar won't make USD the default currency") })]);
  });

  it("refuses a billing cycle Polar can't change, and replaces the product with --allow-replace", async () => {
    const fake = createFakePolar();
    await seedPolarSetup(fake);
    await apply(fake, profile(), { adopt: true });
    const monthly = fake.state.products.find((product) => product.name === "Starter monthly")!;
    monthly.recurring_interval = "year";
    monthly.benefitIds = fake.state.benefits.slice(0, 1).map((benefit) => benefit.id);
    expect((await plan(fake, profile())).refusals).toEqual([expect.objectContaining({ message: expect.stringContaining("never changes a product's billing cycle") })]);
    const { first } = await apply(fake, profile(), { allowReplace: true });
    // The old product's subscribers keep it, so its Credits come off before it is archived.
    expect(summary(first.steps)).toEqual(["create product", "detach product", "archive product"]);
    expect([monthly.benefitIds, monthly.is_archived]).toEqual([[], true]);
  });

  it("replaces a meter Polar locked only after the products that used it, so one --allow-replace run finishes", async () => {
    const fake = createFakePolar();
    await seedPolarSetup(fake);
    const voice = fake.state.meters.find((meter) => meter.name === "Voice minutes")!;
    voice.aggregation = { func: "count" };
    voice.counted = true;
    const annual = fake.state.products.find((product) => product.name === "Starter annual")!;
    annual.recurring_interval = "month";
    expect((await plan(fake, profile(), { adopt: true })).refusals.map((refusal) => refusal.object)).toEqual(["meter", "product"]);
    const { first } = await apply(fake, profile(), { adopt: true, allowReplace: true });
    expect(summary(first.steps).slice(-2)).toEqual(["archive product", "archive meter"]);
    expect([annual.is_archived, voice.archived_at !== null]).toEqual([true, true]);
  });

  it("makes a discount without a code, updates it in place before anyone redeems it, and replaces it after only with --allow-replace", async () => {
    const fake = createFakePolar();
    const withLaunch = (basisPoints: number) => profile((file) => {
      file.plans["pro-launch"] = { ...proLaunch, discount: { ...proLaunch.discount, basisPoints } };
    });
    await apply(fake, withLaunch(2500));
    const [discount] = fake.state.discounts;
    expect(discount).toMatchObject({ code: null, type: "percentage", basis_points: 2500, duration: "repeating", duration_in_months: 3, products: [{ id: fake.state.products.find((product) => product.name === "Pro launch monthly")!.id }] });
    await apply(fake, withLaunch(3000));
    expect(fake.state.discounts).toEqual([expect.objectContaining({ id: discount!.id, basis_points: 3000 })]);
    discount!.redemptions_count = 2;
    expect((await plan(fake, withLaunch(3500))).refusals).toEqual([expect.objectContaining({ object: "discount", message: expect.stringContaining("redeemed 2 times") })]);
    await apply(fake, withLaunch(3500), { allowReplace: true });
    expect(fake.state.discounts.map((entry) => [entry.basis_points, entry.ends_at])).toEqual([[3000, now], [3500, null]]);
  });

  it("keeps metadata keys it didn't write when it tags", async () => {
    const fake = createFakePolar();
    await seedPolarSetup(fake);
    fake.state.products[0]!.metadata = { owner: "finance" };
    await apply(fake, profile(), { adopt: true });
    expect(fake.state.products[0]!.metadata).toMatchObject({ owner: "finance", lobbystack_brand: "alloplace" });
  });

  it("takes Credits added in Polar's dashboard off again and puts back a dashboard rename", async () => {
    const fake = createFakePolar();
    await seedPolarSetup(fake);
    await apply(fake, profile(), { adopt: true });
    const annual = fake.state.products.find((product) => product.name === "Pro annual")!;
    annual.benefitIds = [fake.state.benefits.find((benefit) => benefit.description === "500 voice minutes a month")!.id];
    annual.name = "Pro yearly";
    const { first } = await apply(fake, profile());
    expect(first.steps.map((step) => step.changes).flat()).toEqual(['named "Pro yearly", the file says "Pro annual"', 'detach "500 voice minutes a month": the worker reports only each month\'s overage']);
    expect(annual.benefitIds).toEqual([]);
  });

  it("finishes on a rerun after a run cut off after any write, with no duplicates", async () => {
    const total = (await plan(createFakePolar(), profile())).steps.length;
    for (let cut = 1; cut <= total; cut++) {
      const fake = createFakePolar();
      fake.dropAfterWrite = cut;
      const first = await plan(fake, profile());
      await expect(runPolarSteps(client(fake), first.steps)).rejects.toThrow(/may have landed/);
      delete fake.dropAfterWrite;
      await apply(fake, profile());
      expect([fake.state.meters.length, fake.state.products.length, fake.state.webhooks.length]).toEqual([3, 4, 1]);
    }
  });

  it("returns the new webhook's secret, and none when the webhook already existed", async () => {
    const fake = createFakePolar();
    const { result } = await apply(fake, profile());
    expect(result.webhookSecret).toBe(fake.state.webhooks[0]!.secret);
    const again = await runPolarSteps(client(fake), (await plan(fake, profile())).steps);
    expect(again.webhookSecret).toBeNull();
  });
});
