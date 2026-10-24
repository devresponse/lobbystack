import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { billingProfileSchema, type ApiBillingCatalog, type ApiBillingCatalogRun, type BillingProfile } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { PolarCatalogClient } from "../../../providers/src/polar/polarCatalog";
import { desiredBillingPlans } from "./billingCatalog";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans, runPolarSteps } from "./billingPolar";
import { createFakePolar, type FakePolar } from "./billingPolar.testing";
import { billingProblems, billingVerifyReport, verifyBillingCatalog, type BillingVerifyInput } from "./billingVerify";

// Verify on plain values: an instance whose file, rows and Polar organization
// agree passes, and each kind of drift names its own check and side.

const fileText = readFileSync(new URL("../../../../brands/alloplace/billing.json", import.meta.url), "utf8");
const webhookUrl = "https://demo.alloplace.com/api/webhooks/polar";
const now = "2026-10-21T20:00:00.000Z";
const earlier = "2026-10-21T08:00:00.000Z";
const fileHash = "a".repeat(64);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function profile(change: (file: Record<string, any>) => void = () => undefined): BillingProfile {
  const file = JSON.parse(fileText) as Record<string, any>;
  change(file);
  return billingProfileSchema.parse(file);
}

function client(fake: FakePolar) {
  return new PolarCatalogClient({ token: "polar_oat_test", baseUrl: "https://sandbox-api.polar.sh", fetch: fake.fetch, sleep: async () => undefined });
}

function run(kind: ApiBillingCatalogRun["kind"], polarOrg: string | null): ApiBillingCatalogRun {
  return { id: "0b9d4a52-5d0b-4c4e-9a7e-9f0f3d1f0a01", kind, status: "applied", brand: "alloplace", ver: 1, hash: fileHash, prev_hash: null, code_hash: fileHash, changes: [], problems: [], blocked_by: [], polar_env: polarOrg ? "sandbox" : null, polar_org: polarOrg, key_id: null, partner: null, started_at: earlier, ended_at: earlier };
}

/** Applies the file to a fresh Polar stand-in, links it, and returns what verify reads on such an instance. */
async function syncedInstance(file = profile()) {
  const fake = createFakePolar();
  const plans = desiredBillingPlans(file);
  const catalog = desiredPolarCatalog({ brand: "alloplace", profile: file, plans, webhookUrl });
  const first = planPolarChanges({ catalog, snapshot: await client(fake).readSnapshot(), options: { adopt: false, allowReplace: false, allowArchive: false }, now });
  const { webhookSecret } = await runPolarSteps(client(fake), first.steps);
  const links = polarLinkPlans({ catalog, plans, snapshot: await client(fake).readSnapshot(), now });
  const linkOf = (code: string, period: string) => links.plans.find((entry) => entry.code === code)?.prices.find((price) => price.period === period)?.polar_id ?? null;
  const rows: ApiBillingCatalog["plans"] = plans.map(({ prices, ...plan }) => ({
    ...plan,
    status: "active",
    src: "file",
    polar_disc: links.plans.find((entry) => entry.code === plan.code)?.polar_disc ?? null,
    frozen_at: null,
    retired_at: null,
    created_at: earlier,
    updated_at: earlier,
    discount: plan.discount as Record<string, unknown> | null,
    prices: prices.map((price) => ({ id: `${plan.code}-${price.period}`, period: price.period, currency: price.currency, cents: price.cents, per_month: price.period === "annual" ? Math.floor(price.cents / 12) : price.cents, polar_id: plan.sold ? linkOf(plan.code, price.period) : null, retired_at: null, created_at: earlier, updated_at: earlier })),
  }));
  // The product ID variables are optional, and an instance set up since the catalog has none.
  const productVars: Record<string, string | null> = { "starter/monthly": null, "starter/annual": null, "pro/monthly": null, "pro/annual": null };
  const instance: ApiBillingCatalog = {
    brand: "alloplace",
    code_hash: fileHash,
    hash: fileHash,
    matches_code: true,
    last_run: run("catalog", null),
    profile: file as unknown as Record<string, unknown>,
    currency: "cad",
    plans: rows,
    polar: { env: "sandbox", org: fake.state.organization.id, secret_sha256: sha256(webhookSecret!), product_vars: productVars, last_link: run("polar", fake.state.organization.id) },
  };
  return { fake, file, plans, catalog: instance };
}

async function verify(instance: Awaited<ReturnType<typeof syncedInstance>>, change: Partial<BillingVerifyInput> = {}) {
  return verifyBillingCatalog({
    file: { brand: "alloplace", hash: fileHash, profile: instance.file, plans: instance.plans },
    catalog: instance.catalog,
    polar: { env: "sandbox", snapshot: await client(instance.fake).readSnapshot() },
    webhookUrl,
    checkWebhookSecret: true,
    now,
    ...change,
  });
}

const notOk = (result: Awaited<ReturnType<typeof verify>>) => result.checks.filter((check) => check.level !== "ok").map((check) => `${check.level} ${check.pair} ${check.code} ${check.subject}`);

describe("verifyBillingCatalog", () => {
  it("passes an instance whose file, rows and Polar organization agree, with one ok line per check", async () => {
    const result = await verify(await syncedInstance());
    expect(notOk(result)).toEqual([]);
    expect(result.status).toBe("passed");
    expect(result.checks.filter((check) => check.code === "product" || check.code === "webhook").map((check) => check.message)).toEqual([
      "4 products, tagged and priced as the file says, annual ones invoicing overage each month",
      `webhook ${webhookUrl}, Raw, on, API version 2026-10`,
    ]);
    expect(result.checks.map((check) => `${check.pair} ${check.code}`)).toEqual([
      "file_postgres catalog_hash",
      "file_postgres code_hash",
      "file_postgres plan_rows",
      "file_postgres not_linked",
      "file_polar org_settings",
      "file_polar meter",
      "file_polar credits",
      "file_polar product",
      "file_polar discount",
      "file_polar webhook",
      "file_polar leftover",
      "postgres_polar linked_id",
      "postgres_polar polar_org",
      "postgres_polar webhook_secret",
      "postgres_polar product_vars",
    ]);
    expect(billingProblems(result.checks)).toEqual([]);
  });

  it("finds a file that wasn't applied, and only warns about code built with another file", async () => {
    const instance = await syncedInstance();
    instance.catalog.code_hash = "b".repeat(64);
    const warned = await verify(instance);
    expect(notOk(warned)).toEqual(["warn file_postgres code_hash code"]);
    expect(warned.status).toBe("passed");
    instance.catalog.hash = "c".repeat(64);
    expect(notOk(await verify(instance))).toEqual(["drift file_postgres catalog_hash catalog", "warn file_postgres code_hash code"]);
  });

  it("names the rows an apply would still change, and the sold plans and prices that aren't linked", async () => {
    const instance = await syncedInstance();
    const pro = instance.catalog.plans.find((plan) => plan.code === "pro")!;
    pro.voice_sec = 24_000;
    const starter = instance.catalog.plans.find((plan) => plan.code === "starter")!;
    starter.status = "draft";
    starter.prices.find((price) => price.period === "annual")!.polar_id = null;
    const result = await verify(instance);
    expect(notOk(result)).toEqual([
      "drift file_postgres plan_rows pro",
      "drift file_postgres not_linked starter",
      "drift file_postgres not_linked starter/annual",
    ]);
    expect(result.checks.find((check) => check.code === "plan_rows")!.message).toBe("billing_plans pro would be updated (voice_sec) by an apply.");
    expect(result.status).toBe("drift");
  });

  it("finds each edit made in Polar's dashboard under its own check", async () => {
    const instance = await syncedInstance();
    const { state } = instance.fake;
    state.organization.subscription_settings = { ...state.organization.subscription_settings, allow_multiple_subscriptions: true };
    state.organization.customer_portal_settings = { usage: { show: true }, subscription: { update_seats: true, update_plan: false } };
    state.meters[0]!.name = "Minutes";
    const proMonthly = state.products.find((product) => product.name === "Pro monthly")!;
    proMonthly.prices.find((price) => price.amount_type === "fixed")!.price_amount = 12000;
    state.benefits.push({ id: "benefit_credits", type: "meter_credit", description: "450 voice minutes a month", properties: { units: 450, rollover: false, meter_id: state.meters[0]!.id }, metadata: {} });
    proMonthly.benefitIds = ["benefit_credits"];
    state.webhooks[0]!.enabled = false;
    const result = await verify(instance);
    expect(notOk(result)).toEqual([
      "drift file_polar org_settings Test organization",
      'drift file_polar meter Meter "Voice minutes"',
      'drift file_polar product Product "Pro monthly"',
      'drift file_polar credits Product "Pro monthly"',
      `drift file_polar webhook Webhook ${webhookUrl}`,
      // The link points at the product the rows sell, which no longer sells their price.
      "drift postgres_polar linked_id pro/monthly",
    ]);
    expect(result.checks.find((check) => check.code === "product" && check.level === "drift")!.message).toContain("120.00");
  });

  it("finds an annual product that invoices its overage once a year, and a webhook on another API version", async () => {
    const instance = await syncedInstance();
    const { state } = instance.fake;
    // As a product made before annual products had a meter cycle.
    const proAnnual = state.products.find((product) => product.name === "Pro annual")!;
    proAnnual.meter_interval = null;
    proAnnual.meter_interval_count = null;
    state.webhooks[0]!.api_version = "2027-01";
    const result = await verify(instance);
    expect(notOk(result)).toEqual([
      'drift file_polar product Product "Pro annual"',
      `drift file_polar webhook Webhook ${webhookUrl}`,
      'drift file_polar product Product "Pro annual"',
    ]);
    expect(result.checks.filter((check) => check.level === "drift").map((check) => check.message)).toEqual([
      'Product "Pro annual": 960.00 CAD a year, Voice minutes at 0.18 CAD each, Alert SMS segments at 0.02 CAD each, Call transfers at 0.02 CAD each; overage invoiced each month.',
      `Webhook ${webhookUrl}: API version 2027-01, LobbyStack reads 2026-10.`,
      'Product "Pro annual": replaced by a product that invoices its overage each month; its subscribers keep it.',
    ]);
  });

  it("finds a product tagged for the brand that the file no longer sells", async () => {
    const instance = await syncedInstance();
    const copy = structuredClone(instance.fake.state.products.find((product) => product.name === "Pro annual")!);
    instance.fake.state.products.push({ ...copy, id: "product_stray", name: "Pro biennial", metadata: { ...copy.metadata, lobbystack_interval: "biennial" } });
    expect(notOk(await verify(instance))).toEqual(['drift file_polar leftover Product "Pro biennial"']);
  });

  it("finds links to a missing, archived, retagged or repriced product, and only notes a retired price's product that left Polar", async () => {
    const instance = await syncedInstance();
    const { state } = instance.fake;
    const linked = (code: string, period: string) => instance.catalog.plans.find((plan) => plan.code === code)!.prices.find((price) => price.period === period)!;
    linked("starter", "monthly").polar_id = "product_gone";
    const proAnnual = state.products.find((product) => product.id === linked("pro", "annual").polar_id)!;
    // A row pointing at the Pro annual product as Starter annual's.
    const starterAnnual = linked("starter", "annual");
    const starterAnnualId = starterAnnual.polar_id;
    starterAnnual.polar_id = proAnnual.id;
    const starterPlan = instance.catalog.plans.find((plan) => plan.code === "starter")!;
    starterPlan.prices.push({ ...starterAnnual, id: "starter-annual-old", polar_id: "product_retired", retired_at: earlier });
    const result = await verify(instance);
    expect(notOk(result)).toEqual([
      "drift postgres_polar linked_id starter/annual",
      "drift postgres_polar linked_id starter/monthly",
      "info postgres_polar retired_id starter/annual",
    ]);
    const message = (subject: string) => result.checks.find((check) => check.code === "linked_id" && check.subject === subject)!.message;
    expect(message("starter/monthly")).toBe("starter/monthly is linked to product product_gone, which isn't in this Polar organization.");
    expect(message("starter/annual")).toContain(`is tagged alloplace pro annual ("Pro annual")`);
    expect(starterAnnualId).not.toBe(proAnnual.id);

    proAnnual.is_archived = true;
    expect(notOk(await verify(instance))).toContain("drift postgres_polar linked_id pro/annual");
  });

  it("finds an instance on another organization, one linked elsewhere, and one without POLAR_ORGANIZATION_ID", async () => {
    const instance = await syncedInstance();
    instance.catalog.polar.org = "org_live";
    instance.catalog.polar.env = "production";
    const other = await verify(instance);
    expect(other.checks.find((check) => check.code === "polar_org")).toMatchObject({ level: "drift", message: "the instance uses Polar production org_live and the token reaches sandbox org_test." });
    instance.catalog.polar.org = null;
    instance.catalog.polar.last_link = { ...instance.catalog.polar.last_link!, polar_org: "org_old" };
    expect((await verify(instance)).checks.find((check) => check.code === "polar_org")!.message).toBe("POLAR_ORGANIZATION_ID isn't set on the instance; the last link went to Polar sandbox org_old.");
  });

  it("compares the webhook secret by its hash only when asked", async () => {
    const instance = await syncedInstance();
    instance.catalog.polar.secret_sha256 = sha256("polar_whs_other");
    expect(notOk(await verify(instance))).toEqual(["drift postgres_polar webhook_secret webhook"]);
    instance.catalog.polar.secret_sha256 = null;
    expect((await verify(instance)).checks.find((check) => check.code === "webhook_secret")!.message).toContain("POLAR_WEBHOOK_SECRET isn't set");
    delete instance.fake.state.webhooks[0]!.secret;
    instance.catalog.polar.secret_sha256 = sha256("x");
    expect((await verify(instance)).checks.find((check) => check.code === "webhook_secret")!.message).toContain("webhooks:read");
    const worker = await verify(instance, { checkWebhookSecret: false });
    expect(worker.checks.some((check) => check.code === "webhook_secret")).toBe(false);
    expect((await verify(instance, { webhookUrl: null })).checks.some((check) => check.code === "webhook" || check.code === "webhook_secret")).toBe(false);
  });

  it("never needs the product ID variables, and notes the ones a linked plan no longer reads", async () => {
    const instance = await syncedInstance();
    const linkOf = (code: string, period: string) => instance.catalog.plans.find((plan) => plan.code === code)!.prices.find((price) => price.period === period)!.polar_id!;
    instance.catalog.polar.product_vars["starter/monthly"] = linkOf("starter", "monthly");
    instance.catalog.polar.product_vars["pro/annual"] = linkOf("pro", "annual");
    instance.catalog.polar.product_vars["pro/monthly"] = "product_old";
    const result = await verify(instance);
    expect(result.status).toBe("passed");
    expect(notOk(result)).toEqual(["warn postgres_polar product_vars POLAR_PRO_MONTHLY_PRODUCT_ID", "info postgres_polar product_vars variables"]);
    const message = (subject: string) => result.checks.find((check) => check.code === "product_vars" && check.subject === subject)!.message;
    expect(message("POLAR_PRO_MONTHLY_PRODUCT_ID")).toBe(`POLAR_PRO_MONTHLY_PRODUCT_ID is product_old, not the linked product ${linkOf("pro", "monthly")}. Checkout sells the linked product and ignores the variable, so remove it from the instance.`);
    expect(message("variables")).toBe("POLAR_STARTER_MONTHLY_PRODUCT_ID, POLAR_PRO_ANNUAL_PRODUCT_ID match their links and aren't needed any more; remove them from the instance when convenient.");
    // Before a link makes a plan active, its variable is what sells it.
    instance.catalog.plans.find((plan) => plan.code === "pro")!.status = "draft";
    expect(notOk(await verify(instance)).filter((line) => line.includes("product_vars"))).toEqual(["info postgres_polar product_vars variables"]);
  });

  it("fails when Polar can't be read, after the checks that need only the file and the rows", async () => {
    const instance = await syncedInstance();
    const result = await verify(instance, { polar: { env: "sandbox", error: "Polar answered 401 to GET /v1/organizations/" } });
    expect(result.status).toBe("failed");
    expect(result.checks.map((check) => check.code)).toEqual(["catalog_hash", "code_hash", "plan_rows", "not_linked", "unreadable"]);
    expect(billingProblems(result.checks)).toEqual([{ code: "unreadable", pair: "file_polar", level: "drift", subject: "Polar", message: "Polar answered 401 to GET /v1/organizations/" }]);
  });
});

describe("billingVerifyReport", () => {
  it("prints each check under its pair and ends with the exit code", async () => {
    const instance = await syncedInstance();
    const passed = billingVerifyReport(await verify(instance), "Verify alloplace against Polar sandbox org_test");
    expect(passed.split("\n").slice(0, 4)).toEqual(["Verify alloplace against Polar sandbox org_test", "", "File and Postgres", `  ok     catalog ${fileHash.slice(0, 12)} applied`]);
    expect(passed).toContain("\nFile and Polar\n");
    expect(passed).toContain("\nPostgres and Polar\n");
    expect(passed.endsWith("Result: in sync (exit 0).")).toBe(true);

    instance.catalog.polar.secret_sha256 = sha256("polar_whs_other");
    const drift = billingVerifyReport(await verify(instance), "Verify");
    expect(drift).toContain("  DRIFT  webhook_secret: ");
    expect(drift.endsWith("Result: drift (exit 1). Run pnpm billing apply, or change billing.json in a pull request.")).toBe(true);

    const failed = billingVerifyReport(await verify(instance, { polar: { env: "sandbox", error: "timeout" } }), "Verify");
    expect(failed).not.toContain("Postgres and Polar");
    expect(failed.endsWith("Result: failed (exit 2). Polar couldn't be read: check the token's scopes and run again.")).toBe(true);
  });
});
