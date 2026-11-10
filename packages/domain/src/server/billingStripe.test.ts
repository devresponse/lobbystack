import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { StripeSnapshot } from "@lobbystack/providers/stripe/catalog";
import { billingProfileForProvider, billingProfileSchema, perMonthCents, STRIPE_API_VERSION, type ApiBillingCatalog, type ApiBillingCatalogRun, type BillingProfile } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { desiredBillingPacks, desiredBillingPlans } from "./billingCatalog";
import { desiredStripeCatalog, planStripeChanges, stripeLinkBody, stripePackLookupKey, stripePlanner, verifyStripeCatalog, type StripeStep, type StripeVerifyInput } from "./billingStripe";
import { emptyStripeSnapshot, runStripeSteps } from "./billingStripe.testing";
import type { CatalogPlanOptions } from "./billingProvider";

// The Stripe plan on a stand-in that keeps Stripe's rules: what a file needs,
// what an account gets, that running the plan leaves nothing to do, and what
// verify finds when the account drifts.

const brands = ["realinfobot", "alloplace"] as const;
type Brand = (typeof brands)[number];
// RealInfoBot's own file sells listing packs and no plan since 2026-11-10, so its slug takes the example
// file of plans and packs: its file as it was before, which sells the plans AlloPlace's file sells.
const files: Record<Brand, URL> = {
  realinfobot: new URL("../../../shared/src/brands/testing/plans-and-packs.billing.json", import.meta.url),
  alloplace: new URL("../../../../brands/alloplace/billing.json", import.meta.url),
};
const fileText = (brand: Brand) => readFileSync(files[brand], "utf8");
const webhookUrl = (brand: Brand) => `https://dev1.${brand}.com/api/webhooks/stripe`;
const links = { termsUrl: "https://example.com/legal/terms", privacyUrl: "https://example.com/legal/privacy" };
const strict: CatalogPlanOptions = { adopt: false, allowReplace: false, allowArchive: false };
const stripeBlock = { upgrade: "invoice", downgrade: "next_period", portalPlanChanges: true, portalCancel: false, tax: { behavior: "exclusive", code: "txcd_10103001" }, usageGraceHours: 1, overage: "separate", managedPayments: false };

function profile(brand: Brand = "realinfobot", change: (file: Record<string, any>) => void = () => undefined): BillingProfile {
  const file = JSON.parse(fileText(brand)) as Record<string, any>;
  file.stripe = structuredClone(stripeBlock);
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

function catalogFor(file: BillingProfile, brand: Brand = "realinfobot", url: string | null = webhookUrl(brand)) {
  return desiredStripeCatalog({ brand, profile: file, plans: desiredBillingPlans(file), webhookUrl: url, links });
}

function plan(snapshot: StripeSnapshot, file: BillingProfile, options: Partial<CatalogPlanOptions> = {}, brand: Brand = "realinfobot") {
  return planStripeChanges({ catalog: catalogFor(file, brand), snapshot, options: { ...strict, ...options } });
}

/** Plans and runs every call, then plans again: an applied file leaves nothing to do. */
function apply(snapshot: StripeSnapshot, file: BillingProfile, options: Partial<CatalogPlanOptions> = {}, brand: Brand = "realinfobot") {
  const first = plan(snapshot, file, options, brand);
  expect(first.refusals).toEqual([]);
  const result = runStripeSteps(snapshot, first.steps);
  const again = plan(result.snapshot, file, {}, brand);
  expect(again.steps).toEqual([]);
  expect(again.refusals).toEqual([]);
  return { first, ...result };
}

const summary = (steps: readonly StripeStep[]) => steps.map((step) => `${step.action} ${step.object}`);

/** RealInfoBot's catalog with the file's packs, as apply and verify build it. catalogFor leaves them out. */
function catalogWithPacks(file: BillingProfile) {
  return desiredStripeCatalog({ brand: "realinfobot", profile: file, plans: desiredBillingPlans(file), packs: desiredBillingPacks(file), webhookUrl: webhookUrl("realinfobot"), links });
}

function planWithPacks(snapshot: StripeSnapshot, file: BillingProfile, options: Partial<CatalogPlanOptions> = {}) {
  return planStripeChanges({ catalog: catalogWithPacks(file), snapshot, options: { ...strict, ...options } });
}

/** apply, with the file's packs. */
function applyWithPacks(snapshot: StripeSnapshot, file: BillingProfile, options: Partial<CatalogPlanOptions> = {}) {
  const first = planWithPacks(snapshot, file, options);
  expect(first.refusals).toEqual([]);
  const result = runStripeSteps(snapshot, first.steps);
  expect(planWithPacks(result.snapshot, file)).toEqual({ steps: [], refusals: [] });
  return { first, ...result };
}

// The events of an endpoint made before packs, and the three a file with packs adds.
const eventsBeforePacks = [
  "checkout.session.completed", "checkout.session.expired",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed", "customer.subscription.pending_update_applied", "customer.subscription.pending_update_expired",
  "invoice.paid", "invoice.payment_failed", "invoice.finalized", "invoice.voided", "invoice.marked_uncollectible",
  "charge.refunded", "charge.dispute.created",
];
const packEvents = ["checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "charge.dispute.closed"];

const livePackPrice = (snapshot: StripeSnapshot, pack: string) => snapshot.prices.find((price) => price.metadata.lobbystack_pack === pack && price.active)!;
const packProduct = (snapshot: StripeSnapshot, pack: string) => snapshot.products.find((product) => product.metadata.lobbystack_pack === pack)!;

describe("desiredStripeCatalog", () => {
  it.each(brands)("maps %s's file to its plans' products and prices, the overage meters, products and prices, the portal, the webhook and the meter error destination", (brand) => {
    const file = profile(brand);
    const catalog = catalogFor(file, brand);
    const terms = Object.fromEntries(desiredBillingPlans(file).map((entry) => [entry.code, entry.terms_hash.slice(0, 8)]));
    expect(catalog.products).toEqual([{ plan: "starter", name: "Starter" }, { plan: "pro", name: "Pro" }]);
    expect(catalog.prices.map((price) => [price.lookupKey, price.cents, price.currency, price.interval])).toEqual([
      [`ls_${brand}_starter_annual_cad_${terms.starter}`, 37000, "cad", "year"],
      [`ls_${brand}_starter_monthly_cad_${terms.starter}`, 3700, "cad", "month"],
      [`ls_${brand}_pro_annual_cad_${terms.pro}`, 87000, "cad", "year"],
      [`ls_${brand}_pro_monthly_cad_${terms.pro}`, 8700, "cad", "month"],
    ]);
    expect(catalog.overage.map((overage) => [overage.kind, overage.event, overage.lookupKey, overage.productName])).toEqual([
      ["voice", "ls_overage_voice", "ls_overage_voice_cad", "Voice minutes past the allowance"],
      ["alert_sms", "ls_overage_sms", "ls_overage_sms_cad", "Alert SMS past the allowance"],
      ["transfer", "ls_overage_transfers", "ls_overage_transfers_cad", "Call transfers past the allowance"],
    ]);
    expect(catalog.coupons).toEqual([]);
    expect(catalog.portal).toEqual({ returnUrl: `https://dev1.${brand}.com/settings/plan`, ...links, planChanges: true, cancel: false, upgrade: "invoice", downgrade: "next_period", plans: ["starter", "pro"] });
    // Without packs, the events the endpoint had before them.
    expect(catalog.webhook).toEqual({ url: webhookUrl(brand), events: eventsBeforePacks });
    expect(catalog.meterErrors).toEqual({ url: `${webhookUrl(brand)}/meter-errors`, events: ["v1.billing.meter.error_report_triggered", "v1.billing.meter.no_meter_found"] });
    expect(catalog).toMatchObject({ currency: "cad", taxCode: "txcd_10103001", managedPayments: false, overageMode: "separate", usageGraceHours: 1 });
  });

  it("gives a promo plan a product of its own, its price, and a coupon for that product, and keeps it out of the portal", () => {
    const file = profile("realinfobot", (value) => {
      value.plans["pro-launch"] = proLaunch;
    });
    const catalog = catalogFor(file);
    const launch = desiredBillingPlans(file).find((entry) => entry.code === "pro-launch")!;
    expect(catalog.products).toContainEqual({ plan: "pro-launch", name: "Pro launch" });
    expect(catalog.prices.filter((price) => price.plan === "pro-launch").map((price) => price.lookupKey)).toEqual([`ls_realinfobot_pro-launch_monthly_cad_${launch.terms_hash.slice(0, 8)}`]);
    expect(catalog.coupons).toEqual([{ plan: "pro-launch", id: `ls-realinfobot-pro-launch-${launch.terms_hash.slice(0, 8)}`, name: "Pro launch discount", terms: launch.terms_hash, currency: "cad", discount: { type: "percentage", basis_points: 2500, duration: "repeating", duration_in_months: 3 } }]);
    expect(catalog.portal.plans).toEqual(["starter", "pro"]);
  });

  it("needs a stripe block, and checks one in the file", () => {
    const { stripe: _block, ...raw } = JSON.parse(fileText("realinfobot"));
    const withoutBlock = billingProfileSchema.parse(raw);
    expect(() => catalogFor(withoutBlock)).toThrow("has no stripe block, which a Stripe deployment needs");
    const managed = billingProfileSchema.safeParse({ ...JSON.parse(fileText("realinfobot")), stripe: { ...stripeBlock, managedPayments: true } });
    expect(managed.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([["stripe.overage", "with managedPayments, overage is checkout: Managed Payments sells only through Checkout"]]);
    // With overage on the checkout, the file keeps its yearly prices for Polar; a yearly-only plan just isn't sold on Stripe.
    const yearlyOnly = JSON.parse(fileText("realinfobot"));
    yearlyOnly.plans["starter-yearly"] = { tier: "starter", access: "code", names: { en: "Starter yearly", fr: "Starter annuel", es: "Starter anual", sr: "Starter godišnji" }, sold: true, prices: { annualCents: 30000 } };
    const checkout = billingProfileSchema.parse({ ...yearlyOnly, stripe: { ...stripeBlock, overage: "checkout", managedPayments: true } });
    const soldOn = (provider: "polar" | "stripe") => desiredBillingPlans(billingProfileForProvider(checkout, provider)).find((plan) => plan.code === "starter-yearly")?.sold;
    expect([soldOn("polar"), soldOn("stripe")]).toEqual([true, undefined]);
    expect(billingProfileSchema.safeParse({ ...JSON.parse(fileText("realinfobot")), stripe: { ...stripeBlock, tax: { behavior: "exclusive", code: "saas" } } }).success).toBe(false);
  });

  it("sells no yearly price on Stripe with overage on the checkout, as merchant of record needs, while Polar sells the file as it is", () => {
    const file = profile("realinfobot", (raw) => Object.assign(raw.stripe, { overage: "checkout", managedPayments: true }));
    const periods = (plans: ReturnType<typeof desiredBillingPlans>) => [...new Set(plans.flatMap((plan) => plan.prices.map((price) => price.period)))].sort();
    expect(periods(desiredBillingPlans(billingProfileForProvider(file, "stripe")))).toEqual(["monthly"]);
    expect(periods(desiredBillingPlans(billingProfileForProvider(file, "polar")))).toEqual(["annual", "monthly"]);
    // With overage on a subscription of its own, Stripe sells the yearly prices too.
    expect(periods(desiredBillingPlans(billingProfileForProvider(profile(), "stripe")))).toEqual(["annual", "monthly"]);
    const catalog = desiredStripeCatalog({ brand: "realinfobot", profile: file, plans: desiredBillingPlans(billingProfileForProvider(file, "stripe")), webhookUrl: webhookUrl("realinfobot"), links });
    expect(catalog.prices.map((price) => price.interval)).not.toContain("year");
    expect([catalog.managedPayments, catalog.overageMode]).toEqual([true, "checkout"]);
  });
  it("leaves the webhook, the meter error destination and the portal's return address unchecked without the instance's address", () => {
    const catalog = catalogFor(profile(), "realinfobot", null);
    expect(catalog.webhook).toBeNull();
    expect(catalog.meterErrors).toBeNull();
    expect(catalog.portal.returnUrl).toBeNull();
  });
});

describe("planStripeChanges", () => {
  it("makes everything on an empty account, in order, and nothing on a second run", () => {
    const { first, snapshot, secrets } = apply(emptyStripeSnapshot(), profile());
    expect(summary(first.steps)).toEqual([
      ...Array(3).fill("create meter"),
      "create overage", "create overage", "create overage", "create overage", "create overage", "create overage",
      "create product", "create product",
      ...Array(4).fill("create price"),
      "create portal", "create webhook", "create meter_errors",
    ]);
    expect(first.steps.filter((step) => step.call === "prices.create" && step.object === "overage").map((step) => step.params)).toEqual([
      expect.objectContaining({ unit_amount: 100, currency: "cad", lookup_key: "ls_overage_voice_cad", tax_behavior: "exclusive", recurring: { interval: "month", usage_type: "metered", meter: { $ref: "meter:voice" } } }),
      expect.objectContaining({ lookup_key: "ls_overage_sms_cad", recurring: { interval: "month", usage_type: "metered", meter: { $ref: "meter:alert_sms" } } }),
      expect.objectContaining({ lookup_key: "ls_overage_transfers_cad", recurring: { interval: "month", usage_type: "metered", meter: { $ref: "meter:transfer" } } }),
    ]);
    expect(first.steps.find((step) => step.call === "webhookEndpoints.create")).toMatchObject({ params: { url: webhookUrl("realinfobot"), api_version: STRIPE_API_VERSION, metadata: { lobbystack_brand: "realinfobot" } }, idempotencyKey: `catalog:realinfobot:webhook:${webhookUrl("realinfobot")}` });
    expect(first.steps.find((step) => step.call === "v2.core.eventDestinations.create")).toMatchObject({ params: { event_payload: "thin", webhook_endpoint: { url: `${webhookUrl("realinfobot")}/meter-errors` } } });
    // The portal switches between Starter's and Pro's live prices, a downgrade at the period's end.
    const portal = snapshot.portalConfigurations[0]!;
    const starter = snapshot.products.find((product) => product.metadata.lobbystack_plan === "starter")!;
    expect(portal).toMatchObject({ default_return_url: "https://dev1.realinfobot.com/settings/plan", business_profile: { terms_of_service_url: links.termsUrl, privacy_policy_url: links.privacyUrl }, metadata: { lobbystack_brand: "realinfobot" } });
    expect(portal.features.subscription_update).toMatchObject({ enabled: true, proration_behavior: "always_invoice", schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }, { type: "shortening_interval" }] } });
    expect(portal.features.subscription_update.products).toContainEqual({ product: starter.id, prices: snapshot.prices.filter((price) => price.product === starter.id).map((price) => price.id) });
    expect(portal.features.subscription_cancel.enabled).toBe(false);
    expect(snapshot.products.every((product) => product.tax_code === "txcd_10103001")).toBe(true);
    expect(snapshot.prices.every((price) => price.tax_behavior === "exclusive")).toBe(true);
    expect(secrets).toHaveLength(2);
  });

  it("finishes a run cut off halfway without making anything twice", () => {
    const file = profile();
    const first = plan(emptyStripeSnapshot(), file);
    const half = runStripeSteps(emptyStripeSnapshot(), first.steps, { stopAfter: 8 });
    const rest = plan(half.snapshot, file);
    expect(rest.refusals).toEqual([]);
    expect(rest.steps.map((step) => step.subject)).toEqual(first.steps.slice(8).map((step) => step.subject));
    const { snapshot } = apply(half.snapshot, file);
    expect(snapshot.meters).toHaveLength(3);
    expect(snapshot.products).toHaveLength(5);
    expect(snapshot.prices).toHaveLength(7);
  });

  it("makes a new price for new terms, and archives the old one only with --allow-archive", () => {
    const { snapshot } = apply(emptyStripeSnapshot(), profile());
    const raised = profile("realinfobot", (value) => {
      value.plans.pro.prices.monthlyCents = 9700;
    });
    const refused = plan(snapshot, raised);
    expect(summary(refused.steps)).toEqual(["create price", "create price", "update portal"]);
    expect(refused.refusals.map((refusal) => refusal.message)).toEqual([
      expect.stringMatching(/^It sells pro annual at 870\.00 CAD on terms the file no longer has\. Run with --allow-archive/),
      expect.stringMatching(/^It sells pro monthly at 87\.00 CAD on terms the file no longer has\./),
    ]);
    const { first, snapshot: after } = apply(snapshot, raised, { allowArchive: true });
    expect(summary(first.steps)).toEqual(["create price", "create price", "update portal", "archive price", "archive price"]);
    expect(first.steps.filter((step) => step.action === "archive").every((step) => step.leftover)).toBe(true);
    const pro = after.products.find((product) => product.metadata.lobbystack_plan === "pro")!;
    expect(after.prices.filter((price) => price.product === pro.id && price.active).map((price) => price.unit_amount).sort()).toEqual([87000, 9700]);
  });

  it("leaves another brand's objects alone in a shared account, sharing the overage objects", () => {
    const { snapshot: shared } = apply(emptyStripeSnapshot(), profile("alloplace"), {}, "alloplace");
    const { first, snapshot } = apply(shared, profile("realinfobot"));
    expect(summary(first.steps)).toEqual(["create product", "create product", ...Array(4).fill("create price"), "create portal", "create webhook", "create meter_errors"]);
    // Nothing of AlloPlace's changes, so its own plan still has nothing to do.
    expect(plan(snapshot, profile("alloplace"), {}, "alloplace")).toEqual({ steps: [], refusals: [] });
    expect(snapshot.portalConfigurations.map((configuration) => configuration.metadata.lobbystack_brand)).toEqual(["alloplace", "realinfobot"]);
  });

  it("refuses a price of another brand under its lookup key, even with --allow-replace", () => {
    const { snapshot } = apply(emptyStripeSnapshot(), profile());
    const taken = structuredClone(snapshot);
    const price = taken.prices.find((entry) => entry.metadata.lobbystack_plan === "starter")!;
    price.metadata.lobbystack_brand = "alloplace";
    const result = plan(taken, profile(), { allowReplace: true, allowArchive: true });
    expect(result.refusals).toEqual([{ object: "price", subject: `Price ${price.lookup_key}`, message: `${price.id}, tagged for alloplace, holds this lookup key. Use a Stripe account of realinfobot's own.` }]);
  });

  it("renames a meter in place, and brings back an archived product and price", () => {
    const { snapshot } = apply(emptyStripeSnapshot(), profile());
    const drifted = structuredClone(snapshot);
    drifted.meters[0]!.display_name = "Voice";
    const starter = drifted.products.find((product) => product.metadata.lobbystack_plan === "starter")!;
    starter.active = false;
    const monthly = drifted.prices.find((price) => price.product === starter.id && price.recurring?.interval === "month")!;
    monthly.active = false;
    const result = plan(drifted, profile());
    expect(result.refusals).toEqual([]);
    expect(result.steps.map((step) => [step.action, step.subject, step.changes])).toEqual([
      ["update", 'Meter "Voice overage in dollars"', ['named "Voice", the code says "Voice overage in dollars"']],
      ["restore", 'Product "Starter"', ["bring it back: the file sells it again"]],
      ["restore", `Price ${monthly.lookup_key}`, ["bring it back: the file sells it again"]],
    ]);
    apply(drifted, profile());
  });

  it("replaces a price Stripe can't change only with --allow-replace, moving its lookup key", () => {
    const { snapshot } = apply(emptyStripeSnapshot(), profile());
    const drifted = structuredClone(snapshot);
    const voice = drifted.prices.find((price) => price.lookup_key === "ls_overage_voice_cad")!;
    voice.unit_amount = 50;
    expect(plan(drifted, profile()).refusals).toEqual([{ object: "overage", subject: "Price ls_overage_voice_cad", message: `${voice.id} costs 0.50 CAD, and Stripe never changes a price. Run with --allow-replace to make a new price that takes over the lookup key; its subscribers keep the old one.` }]);
    const { first, snapshot: after } = apply(drifted, profile(), { allowReplace: true });
    expect(first.steps.map((step) => [step.action, step.call, step.params.transfer_lookup_key ?? null])).toEqual([
      ["create", "prices.create", true],
      // The portal keeps its plans' prices; the archive comes last.
      ["archive", "prices.update", null],
    ]);
    expect(after.prices.find((price) => price.id === voice.id)).toMatchObject({ active: false, lookup_key: null });
    expect(after.prices.find((price) => price.lookup_key === "ls_overage_voice_cad")).toMatchObject({ active: true, unit_amount: 100 });
  });

  it("refuses a meter that doesn't sum dollars by customer, which Stripe never changes", () => {
    const { snapshot } = apply(emptyStripeSnapshot(), profile());
    const drifted = structuredClone(snapshot);
    drifted.meters[1]!.default_aggregation.formula = "count";
    expect(plan(drifted, profile(), { allowReplace: true }).refusals).toEqual([{ object: "meter", subject: 'Meter "Alert SMS overage in dollars"', message: expect.stringContaining("Deactivate it in Stripe's Dashboard and run again") }]);
  });

  it("gives a promo plan its coupon, and refuses to change one that was made, deleting a leftover only with --allow-archive", () => {
    const withLaunch = profile("realinfobot", (value) => {
      value.plans["pro-launch"] = proLaunch;
    });
    const { first, snapshot } = apply(emptyStripeSnapshot(), withLaunch);
    const coupon = first.steps.find((step) => step.call === "coupons.create")!;
    expect(coupon.params).toMatchObject({ percent_off: 25, duration: "repeating", duration_in_months: 3, applies_to: { products: [{ $ref: "product:pro-launch" }] }, metadata: { lobbystack_brand: "realinfobot", lobbystack_plan: "pro-launch" } });
    expect(snapshot.coupons[0]!.applies_to!.products).toEqual([snapshot.products.find((product) => product.metadata.lobbystack_plan === "pro-launch")!.id]);
    const drifted = structuredClone(snapshot);
    drifted.coupons[0]!.percent_off = 20;
    expect(plan(drifted, withLaunch, { allowReplace: true }).refusals.map((refusal) => refusal.message)).toEqual([expect.stringMatching(/takes 20% off, and Stripe never changes a coupon\. Delete it in Stripe's Dashboard/)]);
    const withoutLaunch = profile();
    expect(plan(snapshot, withoutLaunch).refusals.map((refusal) => refusal.object).sort()).toEqual(["coupon", "price", "product"]);
    const { first: removal } = apply(snapshot, withoutLaunch, { allowArchive: true });
    // The portal never sold it, so it stays as it is.
    expect(summary(removal.steps)).toEqual(["archive price", "archive product", "delete coupon"]);
  });

  it("turns the portal's plan changes off and cancelling on as the file says", () => {
    const { snapshot } = apply(emptyStripeSnapshot(), profile());
    const changed = profile("realinfobot", (value) => {
      value.stripe.portalPlanChanges = false;
      value.stripe.portalCancel = true;
    });
    const result = plan(snapshot, changed);
    expect(result.steps.map((step) => [step.action, step.object, step.changes])).toEqual([["update", "portal", ["cancelling is off, the file turns it on", "plan changes are on, the file turns them off"]]]);
    const { snapshot: after } = apply(snapshot, changed);
    expect(after.portalConfigurations[0]!.features).toMatchObject({ subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none" }, subscription_update: { enabled: false } });
  });

  it("starts a new cycle on an upgrade the file resets, and lets a downgrade take effect at once unless it waits for next_period", () => {
    const { snapshot } = apply(emptyStripeSnapshot(), profile());
    const reset = profile("realinfobot", (value) => {
      value.stripe.upgrade = "reset";
      value.stripe.downgrade = "prorate";
    });
    expect(plan(snapshot, reset).steps.map((step) => step.changes)).toEqual([["an upgrade charges as upgrade reset says", "a downgrade takes effect at once"]]);
    const { snapshot: after } = apply(snapshot, reset);
    expect(after.portalConfigurations[0]!.features.subscription_update).toMatchObject({ proration_behavior: "always_invoice", billing_cycle_anchor: "now", schedule_at_period_end: { conditions: [] } });
  });

  it("turns a disabled webhook back on and adds missing events, and replaces one in another API version only with --allow-replace", () => {
    const { snapshot } = apply(emptyStripeSnapshot(), profile());
    const drifted = structuredClone(snapshot);
    drifted.webhooks[0]!.status = "disabled";
    drifted.webhooks[0]!.enabled_events = drifted.webhooks[0]!.enabled_events.filter((event) => event !== "invoice.paid");
    drifted.eventDestinations[0]!.status = "disabled";
    expect(plan(drifted, profile()).steps.map((step) => [step.object, step.changes])).toEqual([["webhook", ["turned off", "add invoice.paid"]], ["meter_errors", ["turned off"]]]);
    apply(drifted, profile());
    const older = structuredClone(snapshot);
    older.webhooks[0]!.api_version = "2025-09-30.clover";
    const endpoint = older.webhooks[0]!.id;
    expect(plan(older, profile()).refusals.map((refusal) => refusal.message)).toEqual([expect.stringContaining("Stripe never changes an endpoint's version. Run with --allow-replace")]);
    const { first, snapshot: after, secrets } = apply(older, profile(), { allowReplace: true });
    expect(summary(first.steps)).toEqual(["create webhook", "delete webhook"]);
    expect(after.webhooks.map((entry) => entry.id)).not.toContain(endpoint);
    expect(secrets).toHaveLength(1);
  });
});

describe("stripeLinkBody", () => {
  it("names what has no single object before an apply, and every price, coupon and deployment-wide object after", () => {
    const file = profile("realinfobot", (value) => {
      value.plans["pro-launch"] = proLaunch;
    });
    const plans = desiredBillingPlans(file);
    const catalog = catalogFor(file);
    const before = stripeLinkBody({ catalog, plans, snapshot: emptyStripeSnapshot() });
    // 5 prices, the coupon, 3 meters, 3 overage prices, the portal, the endpoint and the destination.
    expect(before.missing).toHaveLength(15);
    const { snapshot } = apply(emptyStripeSnapshot(), file);
    const after = stripeLinkBody({ catalog, plans, snapshot });
    expect(after.missing).toEqual([]);
    const priceOf = (lookupKey: string) => snapshot.prices.find((price) => price.lookup_key === lookupKey)!.id;
    const launch = plans.find((entry) => entry.code === "pro-launch")!;
    expect(after.plans).toEqual(plans.filter((entry) => entry.sold && entry.prices.length).map((entry) => ({
      code: entry.code,
      terms_hash: entry.terms_hash,
      provider_disc: entry.code === "pro-launch" ? `ls-realinfobot-pro-launch-${launch.terms_hash.slice(0, 8)}` : null,
      prices: entry.prices.map((price) => ({ period: price.period, currency: "cad", provider_ref: priceOf(`ls_realinfobot_${entry.code}_${price.period}_cad_${entry.terms_hash.slice(0, 8)}`) })),
    })));
    expect(after.objects).toEqual({
      meters: Object.fromEntries(snapshot.meters.map((meter) => [{ ls_overage_voice: "voice", ls_overage_sms: "alert_sms", ls_overage_transfers: "transfer" }[meter.event_name], meter.id])),
      overage_prices: { voice: priceOf("ls_overage_voice_cad"), alert_sms: priceOf("ls_overage_sms_cad"), transfer: priceOf("ls_overage_transfers_cad") },
      portal_configuration: snapshot.portalConfigurations[0]!.id,
      webhook_endpoint: snapshot.webhooks[0]!.id,
      meter_error_destination: snapshot.eventDestinations[0]!.id,
    });
    expect(stripePlanner.linkBody({ desired: catalog, snapshot, plans })).toEqual(after);
  });
});

describe("Stripe packs", () => {
  it("gives each pack a product and a one-time price under an lsp_ lookup key, adds the packs' webhook events, and leaves the rest as a file without packs has it", () => {
    const file = profile();
    const catalog = catalogWithPacks(file);
    const packs = desiredBillingPacks(file);
    expect(catalog.packs.map((pack) => [pack.pack, pack.name, pack.lookupKey, pack.cents, pack.currency, pack.terms])).toEqual(packs.map((pack) => [pack.code, pack.names.en, `lsp_realinfobot_${pack.code}_cad_${pack.terms_hash.slice(0, 8)}`, pack.price.cents, "cad", pack.terms_hash]));
    expect(catalog.packs.slice(0, 2).map((pack) => [pack.name, pack.cents])).toEqual([["250 minutes, 90 days", 5500], ["250 minutes, 180 days", 5900]]);
    expect(stripePackLookupKey("realinfobot", "pack_250_90", "cad", packs[0]!.terms_hash)).toBe(catalog.packs[0]!.lookupKey);
    expect(catalog.webhook).toEqual({ url: webhookUrl("realinfobot"), events: [...eventsBeforePacks, ...packEvents] });
    expect({ ...catalog, packs: [], webhook: { ...catalog.webhook!, events: eventsBeforePacks } }).toEqual(catalogFor(file));
  });

  it("makes the packs' products and one-time prices after every call a file without packs gets, keeps them out of the portal, and makes nothing on a second run", () => {
    const file = profile();
    const plain = plan(emptyStripeSnapshot(), file);
    const { first, snapshot } = applyWithPacks(emptyStripeSnapshot(), file);
    // The same calls, but for the webhook endpoint, which a file with packs makes with their events too.
    const endpoint = (steps: readonly StripeStep[]) => steps.find((step) => step.call === "webhookEndpoints.create")!;
    expect(first.steps.slice(0, plain.steps.length).map((step) => (step.object === "webhook" ? null : step))).toEqual(plain.steps.map((step) => (step.object === "webhook" ? null : step)));
    expect(endpoint(first.steps)).toEqual({ ...endpoint(plain.steps), changes: [`19 events, API version ${STRIPE_API_VERSION}`], params: { ...endpoint(plain.steps).params, enabled_events: [...eventsBeforePacks, ...packEvents] } });
    expect(snapshot.webhooks[0]!.enabled_events).toEqual([...eventsBeforePacks, ...packEvents]);
    const packSteps = first.steps.slice(plain.steps.length);
    expect(summary(packSteps)).toEqual(Array(9).fill(["create product", "create price"]).flat());
    const smallest = catalogWithPacks(file).packs[0]!;
    expect(packSteps[0]).toEqual({ object: "product", action: "create", subject: 'Product "250 minutes, 90 days"', changes: ["tax code txcd_10103001"], call: "products.create", params: { name: "250 minutes, 90 days", tax_code: "txcd_10103001", metadata: { lobbystack_brand: "realinfobot", lobbystack_pack: "pack_250_90" } }, idempotencyKey: "catalog:realinfobot:product:pack:pack_250_90", produces: "pack-product:pack_250_90" });
    // A one-time price: no recurring, before tax, tagged with the pack and its terms.
    expect(packSteps[1]).toEqual({ object: "price", action: "create", subject: `Price ${smallest.lookupKey}`, changes: ["55.00 CAD once, before tax"], call: "prices.create", params: { product: { $ref: "pack-product:pack_250_90" }, currency: "cad", unit_amount: 5500, lookup_key: smallest.lookupKey, tax_behavior: "exclusive", metadata: { lobbystack_brand: "realinfobot", lobbystack_pack: "pack_250_90", lobbystack_terms: smallest.terms } }, idempotencyKey: `catalog:realinfobot:price:${smallest.lookupKey}`, produces: "pack-price:pack_250_90" });
    const packPrices = snapshot.prices.filter((price) => price.metadata.lobbystack_pack !== undefined);
    expect(packPrices.map((price) => [price.recurring, price.tax_behavior, price.currency])).toEqual(Array(9).fill([null, "exclusive", "cad"]));
    const packProducts = new Set(snapshot.products.filter((product) => product.metadata.lobbystack_pack !== undefined).map((product) => product.id));
    expect(packProducts.size).toBe(9);
    expect((snapshot.portalConfigurations[0]!.features.subscription_update.products ?? []).filter((entry) => packProducts.has(entry.product))).toEqual([]);
  });

  it("adds only the packs and their three webhook events to an account that already sells the file's plans", () => {
    const file = profile();
    const { snapshot } = apply(emptyStripeSnapshot(), file);
    const { first } = applyWithPacks(snapshot, file);
    expect(summary(first.steps)).toEqual(["update webhook", ...Array(9).fill(["create product", "create price"]).flat()]);
    expect(first.steps[0]).toMatchObject({ changes: [`add ${packEvents.join(", ")}`], call: "webhookEndpoints.update", target: snapshot.webhooks[0]!.id, params: { enabled_events: [...eventsBeforePacks, ...packEvents] } });
  });

  it("leaves an endpoint made before packs alone for a file without packs, and never takes the packs' events off one", () => {
    const file = profile();
    const { snapshot } = apply(emptyStripeSnapshot(), file);
    const before = structuredClone(snapshot);
    before.webhooks[0]!.enabled_events = [...eventsBeforePacks];
    expect(plan(before, file)).toEqual({ steps: [], refusals: [] });
    // An apply only adds events, so a file that drops its packs leaves theirs on the endpoint.
    const { snapshot: after } = applyWithPacks(before, file);
    expect(after.webhooks[0]!.enabled_events).toEqual([...eventsBeforePacks, ...packEvents]);
    const dropped = plan(after, file, { allowArchive: true });
    expect([...dropped.steps, ...dropped.refusals].filter((entry) => entry.object === "webhook")).toEqual([]);
  });

  it("makes a new one-time price on the pack's product for new terms, and archives the old one only with --allow-archive", () => {
    const { snapshot } = applyWithPacks(emptyStripeSnapshot(), profile());
    const old = livePackPrice(snapshot, "pack_250_90");
    const raised = profile("realinfobot", (value) => {
      value.packs.pack_250_90.priceCents = 6000;
    });
    const lookupKey = catalogWithPacks(raised).packs.find((pack) => pack.pack === "pack_250_90")!.lookupKey;
    expect(lookupKey).not.toBe(old.lookup_key);
    const refused = planWithPacks(snapshot, raised);
    expect(refused.steps.map((step) => [step.action, step.subject, step.changes])).toEqual([["create", `Price ${lookupKey}`, ["60.00 CAD once, before tax"]]]);
    expect(refused.refusals).toEqual([{ object: "price", subject: `Price ${old.lookup_key}`, message: "It sells pack pack_250_90 at 55.00 CAD on terms the file no longer has. Run with --allow-archive to archive it; packs bought through it keep their minutes." }]);
    const { first, snapshot: after } = applyWithPacks(snapshot, raised, { allowArchive: true });
    expect(first.steps.map((step) => [step.action, step.object, step.target ?? null, step.leftover ?? false])).toEqual([["create", "price", null, false], ["archive", "price", old.id, true]]);
    expect(first.steps[1]!.changes).toEqual(["the file no longer sells it; packs bought through it keep their minutes"]);
    const product = packProduct(after, "pack_250_90");
    expect(after.prices.filter((price) => price.product === product.id).map((price) => [price.unit_amount, price.active])).toEqual([[5500, false], [6000, true]]);
  });

  it("refuses to archive a pack's price and product the file no longer has without --allow-archive, archives them with it, and leaves the plans' objects alone", () => {
    const { snapshot } = applyWithPacks(emptyStripeSnapshot(), profile());
    const price = livePackPrice(snapshot, "pack_250_90");
    const product = packProduct(snapshot, "pack_250_90");
    const fewer = profile("realinfobot", (value) => {
      delete value.packs.pack_250_90;
    });
    expect(planWithPacks(snapshot, fewer)).toEqual({
      steps: [],
      refusals: [
        { object: "price", subject: `Price ${price.lookup_key}`, message: "It sells pack pack_250_90 at 55.00 CAD on terms the file no longer has. Run with --allow-archive to archive it; packs bought through it keep their minutes." },
        { object: "product", subject: 'Product "250 minutes, 90 days"', message: "It sells pack pack_250_90, which the file no longer has. Run with --allow-archive to archive it; packs bought through it keep their minutes." },
      ],
    });
    const { first, snapshot: after } = applyWithPacks(snapshot, fewer, { allowArchive: true });
    expect(first.steps.map((step) => [step.action, step.object, step.target, step.leftover])).toEqual([["archive", "price", price.id, true], ["archive", "product", product.id, true]]);
    expect([after.prices.filter((entry) => !entry.active).map((entry) => entry.id), after.products.filter((entry) => !entry.active).map((entry) => entry.id)]).toEqual([[price.id], [product.id]]);
    // A file without packs at all would archive every pack's objects, and still none of the plans'.
    const none = plan(snapshot, profile("realinfobot", (value) => {
      delete value.packs;
    }));
    expect(none.steps).toEqual([]);
    expect(none.refusals.map((refusal) => [refusal.object, refusal.message.match(/^It sells pack (pack_\d+_\d+)/)?.[1]])).toEqual([
      ...catalogWithPacks(profile()).packs.map((pack) => ["price", pack.pack]),
      ...catalogWithPacks(profile()).packs.map((pack) => ["product", pack.pack]),
    ]);
  });

  it("replaces a recurring price under a pack's lookup key only with --allow-replace, as a pack is paid once", () => {
    const file = profile();
    const { snapshot } = applyWithPacks(emptyStripeSnapshot(), file);
    const drifted = structuredClone(snapshot);
    const price = livePackPrice(drifted, "pack_250_90");
    price.recurring = { interval: "month", interval_count: 1, usage_type: "licensed", meter: null };
    expect(planWithPacks(drifted, file).refusals).toEqual([{ object: "price", subject: `Price ${price.lookup_key}`, message: `${price.id} bills every 1 month, while a pack is paid once, and Stripe never changes a price. Run with --allow-replace to make a new price that takes over the lookup key; packs bought through the old one keep their minutes.` }]);
    const { first, snapshot: after } = applyWithPacks(drifted, file, { allowReplace: true });
    expect(first.steps.map((step) => [step.action, step.call, step.params.transfer_lookup_key ?? null, step.changes])).toEqual([
      ["create", "prices.create", true, [`replaces ${price.id}, which bills every 1 month, while a pack is paid once: 55.00 CAD once, before tax`]],
      ["archive", "prices.update", null, [`replaced under ${price.lookup_key}; packs bought through it keep their minutes`]],
    ]);
    expect(after.prices.find((entry) => entry.id === price.id)).toMatchObject({ active: false, lookup_key: null });
    expect(after.prices.find((entry) => entry.lookup_key === price.lookup_key)).toMatchObject({ active: true, recurring: null, unit_amount: 5500 });
  });

  it("links each pack to its live one-time price, names a pack without one, and links the plans and objects as a file without packs does", () => {
    const file = profile();
    const plans = desiredBillingPlans(file);
    const catalog = catalogWithPacks(file);
    const before = stripeLinkBody({ catalog, plans, snapshot: emptyStripeSnapshot() });
    expect(before.missing).toHaveLength(stripeLinkBody({ catalog: catalogFor(file), plans, snapshot: emptyStripeSnapshot() }).missing.length + 9);
    expect(before.missing).toContain(`pack pack_250_90: no live price under ${catalog.packs[0]!.lookupKey}`);
    const { snapshot } = applyWithPacks(emptyStripeSnapshot(), file);
    const after = stripeLinkBody({ catalog, plans, snapshot });
    expect(after.missing).toEqual([]);
    expect(after.packs).toEqual(catalog.packs.map((pack) => ({ code: pack.pack, terms_hash: pack.terms, currency: "cad", provider_ref: snapshot.prices.find((price) => price.lookup_key === pack.lookupKey)!.id })));
    const plain = stripeLinkBody({ catalog: catalogFor(file), plans, snapshot });
    expect(plain.packs).toEqual([]);
    expect({ ...after, packs: [] }).toEqual(plain);
  });
});

describe("verifyStripeCatalog", () => {
  const fileHash = "b".repeat(64);
  const earlier = "2026-11-08T08:00:00.000Z";
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  function run(kind: ApiBillingCatalogRun["kind"], account: string | null, env: "sandbox" | "live" = "sandbox"): ApiBillingCatalogRun {
    return { id: "0b9d4a52-5d0b-4c4e-9a7e-9f0f3d1f0a02", kind, status: "applied", brand: "realinfobot", ver: 1, hash: fileHash, prev_hash: null, code_hash: fileHash, changes: [], problems: [], blocked_by: [], polar_env: null, polar_org: null, provider: account ? "stripe" : null, provider_env: account ? env : null, provider_account: account, key_id: null, partner: null, started_at: earlier, ended_at: earlier };
  }

  /** Applies the file to an empty account, links it, and returns what verify reads on such an instance. */
  function syncedInstance(file = profile(), withPacks = false) {
    const plans = desiredBillingPlans(file);
    const packs = withPacks ? desiredBillingPacks(file) : undefined;
    const catalog = withPacks ? catalogWithPacks(file) : catalogFor(file);
    const { snapshot, secrets } = (withPacks ? applyWithPacks : apply)(emptyStripeSnapshot({ account: "acct_dev1" }), file);
    const body = stripeLinkBody({ catalog, plans, snapshot });
    const linkOf = (code: string, period: string) => body.plans.find((entry) => entry.code === code)?.prices.find((price) => price.period === period)?.provider_ref ?? null;
    const rows: ApiBillingCatalog["plans"] = plans.map(({ prices, ...entry }) => ({
      ...entry,
      status: "active",
      src: "file",
      polar_disc: null,
      provider_disc: body.plans.find((linked) => linked.code === entry.code)?.provider_disc ?? null,
      frozen_at: null,
      retired_at: null,
      created_at: earlier,
      updated_at: earlier,
      discount: entry.discount as Record<string, unknown> | null,
      prices: prices.map((price) => ({ id: `${entry.code}-${price.period}`, period: price.period, currency: price.currency, cents: price.cents, per_month: perMonthCents(price.period, price.cents), polar_id: null, provider_ref: entry.sold ? linkOf(entry.code, price.period) : null, retired_at: null, created_at: earlier, updated_at: earlier })),
    }));
    // Linked packs are active, each with its one live price.
    const packRows: ApiBillingCatalog["packs"] = (packs ?? []).map(({ price, ...entry }) => ({
      ...entry,
      status: "active",
      frozen_at: null,
      retired_at: null,
      created_at: earlier,
      updated_at: earlier,
      prices: [{ id: `${entry.code}-${price.currency}`, currency: price.currency, cents: price.cents, provider_ref: body.packs.find((linked) => linked.code === entry.code)!.provider_ref, retired_at: null, created_at: earlier, updated_at: earlier }],
    }));
    const secret = secrets[0]!;
    const instance: ApiBillingCatalog = {
      brand: "realinfobot",
      code_hash: fileHash,
      hash: fileHash,
      matches_code: true,
      last_run: run("catalog", null),
      profile: file as unknown as Record<string, unknown>,
      currency: "cad",
      plans: rows,
      packs: packRows,
      polar: null,
      provider: { id: "stripe", env: "sandbox", account: "acct_dev1", secret_sha256: sha256(secret), objects: { ...body.objects, webhook_secret_sha256: sha256(secret) }, product_vars: null, last_link: run("link", "acct_dev1") },
    };
    return { file, plans, packs, snapshot, catalog: instance };
  }

  function verify(instance: ReturnType<typeof syncedInstance>, change: Partial<StripeVerifyInput> = {}) {
    return verifyStripeCatalog({
      file: { brand: "realinfobot", hash: fileHash, profile: instance.file, plans: instance.plans, ...(instance.packs ? { packs: instance.packs } : {}) },
      catalog: instance.catalog,
      stripe: { env: "sandbox", snapshot: instance.snapshot },
      webhookUrl: webhookUrl("realinfobot"),
      links,
      checkWebhookSecret: true,
      ...change,
    });
  }

  const problems = (result: ReturnType<typeof verifyStripeCatalog>) => result.checks.filter((check) => check.level !== "ok").map((check) => `${check.pair} ${check.code} ${check.level}: ${check.message}`);

  it("passes an instance whose file, rows and Stripe account agree, with every check", () => {
    const instance = syncedInstance();
    const result = verify(instance);
    expect(problems(result)).toEqual([]);
    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => `${check.pair} ${check.code}`)).toEqual([
      "file_postgres catalog_hash", "file_postgres code_hash", "file_postgres plan_rows", "file_postgres not_linked",
      "file_provider meter", "file_provider overage", "file_provider product", "file_provider price", "file_provider discount", "file_provider portal", "file_provider webhook", "file_provider leftover", "file_provider tax",
      "postgres_provider linked_id", "postgres_provider account", "postgres_provider mode", "postgres_provider overage", "postgres_provider portal", "postgres_provider webhook_secret",
    ]);
    expect(stripePlanner.verify({ file: { brand: "realinfobot", hash: fileHash, profile: instance.file, plans: instance.plans }, catalog: instance.catalog, stripe: { env: "sandbox", snapshot: instance.snapshot }, webhookUrl: webhookUrl("realinfobot"), links, checkWebhookSecret: true })).toEqual(result);
  });

  it("names the side that moved: a price archived in Stripe, an unlinked row, another account, the other mode and a changed secret", () => {
    const instance = syncedInstance();
    const snapshot = structuredClone(instance.snapshot);
    const pro = snapshot.prices.find((price) => price.metadata.lobbystack_plan === "pro" && price.recurring?.interval === "month")!;
    pro.active = false;
    const catalog = structuredClone(instance.catalog);
    catalog.plans.find((entry) => entry.code === "starter")!.prices.find((price) => price.period === "annual")!.provider_ref = null;
    catalog.provider.account = "acct_other";
    catalog.provider.env = "live";
    catalog.provider.secret_sha256 = sha256("whsec_other");
    expect(problems(verify({ ...instance, snapshot, catalog }))).toEqual([
      "file_postgres not_linked drift: starter annual has no Stripe price. Run pnpm billing apply.",
      `file_provider price drift: Price ${pro.lookup_key}: bring it back: the file sells it again.`,
      `postgres_provider linked_id drift: pro/monthly is linked to price ${pro.id}, which is archived.`,
      "postgres_provider account drift: the instance uses Stripe account acct_other and the key reaches acct_dev1.",
      "postgres_provider mode drift: The key is a test key, but the instance bills live.",
      "postgres_provider webhook_secret drift: The instance's STRIPE_WEBHOOK_SECRET isn't the one the endpoint was made with, so it refuses every Stripe event. Set the secret from the Railway file pnpm billing wrote.",
    ]);
  });

  it("checks Stripe Tax: drift on a live account, a warning in a sandbox, nothing to check with Managed Payments", () => {
    const instance = syncedInstance();
    const pending = { ...structuredClone(instance.snapshot), tax: { status: "pending" as const, headOffice: false, registrations: 0 } };
    const message = "Stripe Tax isn't active; it has no origin address; it has no tax registration, so it collects no tax. Set it up in Stripe's Dashboard (Tax).";
    expect(problems(verify({ ...instance, snapshot: pending }))).toEqual([`file_provider tax warn: ${message}`]);
    const live = { ...pending, mode: "live" as const };
    expect(problems(verify({ ...instance, snapshot: live }, { stripe: { env: "live", snapshot: live } }))).toContain(`file_provider tax drift: ${message}`);
    expect(problems(verify({ ...instance, snapshot: { ...pending, tax: null } }))).toEqual(["file_provider tax warn: The key can't read Stripe Tax's settings, so they weren't checked."]);
  });

  it("finds a link that records stale overage prices, and fails when Stripe can't be read", () => {
    const instance = syncedInstance();
    const catalog = structuredClone(instance.catalog);
    catalog.provider.objects = { ...catalog.provider.objects, overage_prices: { voice: "price_old", alert_sms: "price_old2", transfer: "price_old3" }, portal_configuration: "bpc_old" };
    expect(problems(verify({ ...instance, catalog }))).toEqual([
      expect.stringMatching(/^postgres_provider overage drift: The latest link recorded voice overage price price_old, Stripe's is price_\d+; alert_sms/),
      expect.stringMatching(/^postgres_provider portal drift: The latest link recorded billing portal bpc_old, Stripe's is bpc_\d+\. Run pnpm billing apply\.$/),
    ]);
    const unreadable = verify(instance, { stripe: { env: "sandbox", error: "Stripe answered 401: Invalid API Key provided." } });
    expect(unreadable.status).toBe("failed");
    expect(problems(unreadable)).toEqual(["file_provider unreadable drift: Stripe answered 401: Invalid API Key provided."]);
  });

  it("finds no webhook drift for a file without packs whose endpoint has the packs' events too", () => {
    const instance = syncedInstance();
    expect(instance.snapshot.webhooks[0]!.enabled_events).toEqual(eventsBeforePacks);
    const snapshot = structuredClone(instance.snapshot);
    snapshot.webhooks[0]!.enabled_events.push(...packEvents);
    const result = verify({ ...instance, snapshot });
    expect(problems(result)).toEqual([]);
    expect(result.checks.find((check) => check.code === "webhook")).toMatchObject({ level: "ok", message: `webhook ${webhookUrl("realinfobot")}, 16 events, API version ${STRIPE_API_VERSION}, and the meter error destination` });
  });

  it("leaves the webhook and its secret out without the instance's address, as the worker's daily check does", () => {
    const instance = syncedInstance();
    const result = verify(instance, { webhookUrl: null, checkWebhookSecret: false });
    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => check.code)).not.toContain("webhook");
    expect(result.checks.map((check) => check.code)).not.toContain("webhook_secret");
  });

  it("passes an instance whose packs are linked to their live one-time prices, and names packs in what passes only when the file has some", () => {
    const instance = syncedInstance(profile(), true);
    const result = verify(instance);
    expect(problems(result)).toEqual([]);
    expect(result.status).toBe("passed");
    const message = (key: string) => result.checks.find((check) => `${check.pair} ${check.code}` === key)!.message;
    expect(["file_postgres plan_rows", "file_postgres not_linked", "file_provider product", "file_provider price", "postgres_provider linked_id"].map(message)).toEqual([
      "4 plans, 4 live prices, 9 packs, 9 live pack prices",
      "2 sold plans and 9 packs active and linked",
      "2 products and 9 pack products, tagged and taxed as txcd_10103001",
      "4 prices and 9 one-time pack prices before tax, each under its lookup key",
      "4 prices and 9 pack prices linked, all live and priced as the rows say",
    ]);
    // The same checks, in the same order, as for a file without packs, whose lines don't mention packs.
    const plain = verify(syncedInstance());
    expect(result.checks.map((check) => `${check.pair} ${check.code}`)).toEqual(plain.checks.map((check) => `${check.pair} ${check.code}`));
    expect(plain.checks.filter((check) => check.message.includes("pack"))).toEqual([]);
  });

  it("names a pack linked to a price that's archived, recurring or another pack's, and a pack that isn't active yet", () => {
    const instance = syncedInstance(profile(), true);
    const snapshot = structuredClone(instance.snapshot);
    const archived = livePackPrice(snapshot, "pack_250_90");
    const recurring = livePackPrice(snapshot, "pack_250_180");
    const other = livePackPrice(snapshot, "pack_500_180");
    archived.active = false;
    recurring.recurring = { interval: "month", interval_count: 1, usage_type: "licensed", meter: null };
    const catalog = structuredClone(instance.catalog);
    const row = (code: string) => catalog.packs.find((entry) => entry.code === code)!;
    row("pack_500_90").prices[0]!.provider_ref = other.id;
    row("pack_1000_90").status = "draft";
    expect(problems(verify({ ...instance, snapshot, catalog }))).toEqual([
      "file_postgres not_linked drift: Pack pack_1000_90 is draft, so Stripe doesn't sell it as the file says yet. Run pnpm billing apply.",
      `file_provider price drift: Price ${archived.lookup_key}: bring it back: the file sells it again.`,
      `file_provider price drift: Price ${recurring.lookup_key}: replaces ${recurring.id}, which bills every 1 month, while a pack is paid once: 59.00 CAD once, before tax.`,
      `file_provider price drift: Price ${recurring.id}: replaced under ${recurring.lookup_key}; packs bought through it keep their minutes.`,
      `postgres_provider linked_id drift: Pack pack_250_90/cad is linked to price ${archived.id}, which is archived.`,
      `postgres_provider linked_id drift: Pack pack_250_180/cad is linked to price ${recurring.id}, which bills every 1 month, while a pack is paid once.`,
      `postgres_provider linked_id drift: Pack pack_500_90/cad is linked to price ${other.id}, which belongs to product ${other.product}, which isn't tagged realinfobot pack pack_500_90.`,
    ]);
  });
});
