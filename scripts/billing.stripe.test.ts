import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { billingCatalogPacks, billingCatalogPlans, billingCatalogWriteOrder, desiredBillingPacks, desiredBillingPlans, diffBillingCatalog, diffBillingLinks, diffBillingPackCatalog, diffBillingPackLinks, type StoredBillingPack, type StoredBillingPackPrice, type StoredBillingPlan, type StoredBillingPrice } from "../packages/domain/src/server/billingCatalog";
import { createFakeStripe, type FakeStripe } from "../packages/providers/src/stripe/fake";
import { apiBillingCatalogLinkSchema, billingCatalogLinkRequest, billingProfileForProvider, billingProfileSchema, canonicalBillingProfileJson, perMonthCents, type ApiBillingCatalog, type ApiBillingCatalogRun, type BillingProfile } from "../packages/shared/src/index";
import { runBilling } from "./billing";

// pnpm billing --stripe end to end (the Stripe plan's step 11), against the
// in-memory Stripe and a stand-in instance that bills through Stripe and
// keeps its tables in memory with the API's own diff and link rules.

const instanceUrl = "https://dev1.realinfobot.com";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const hashOf = (profile: BillingProfile) => sha256(canonicalBillingProfileJson(profile));
const stripeBlock = { upgrade: "invoice", downgrade: "next_period", portalPlanChanges: true, portalCancel: false, tax: { behavior: "exclusive", code: "txcd_10103001" }, usageGraceHours: 1, overage: "separate", managedPayments: false };

type LinkRun = ApiBillingCatalogRun & { objects: Record<string, unknown> | null };

type Instance = {
  plans: StoredBillingPlan[];
  prices: StoredBillingPrice[];
  packs: StoredBillingPack[];
  packPrices: StoredBillingPackPrice[];
  catalogRuns: ApiBillingCatalogRun[];
  linkRuns: LinkRun[];
  codeHash: string;
  /** The instance's provider and its Stripe variables: STRIPE_API_KEY's mode, STRIPE_ACCOUNT_ID and STRIPE_WEBHOOK_SECRET. */
  provider: "stripe" | "polar";
  stripe: { env: "sandbox" | "live"; account: string | null; secret: string | null };
  requests: Array<{ path: string; body: any }>;
};

function run(kind: ApiBillingCatalogRun["kind"], fields: Partial<ApiBillingCatalogRun>): ApiBillingCatalogRun {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), kind, status: "applied", brand: "realinfobot", ver: 1, hash: "0".repeat(64), prev_hash: null, code_hash: null, changes: [], problems: [], blocked_by: [], polar_env: null, polar_org: null, provider: null, provider_env: null, provider_account: null, key_id: "key", partner: "lobbystack", started_at: now, ended_at: now, ...fields };
}

/** Writes an apply's or a link's rows as Postgres would. */
function write(instance: Instance, writes: ReturnType<typeof diffBillingCatalog>["writes"]) {
  const now = new Date().toISOString();
  for (const entry of billingCatalogWriteOrder(writes)) {
    if (entry.change.table === "billing_pack_plans") {
      if (entry.change.action === "insert") instance.packs.push({ frozen_at: null, run_id: null, retired_at: null, created_at: now, updated_at: now, ...entry.set } as StoredBillingPack);
      else Object.assign(instance.packs.find((pack) => pack.code === entry.change.key)!, entry.set, { updated_at: now });
    } else if (entry.change.table === "billing_pack_prices") {
      if (entry.change.action === "insert") instance.packPrices.push({ id: crypto.randomUUID(), provider_ref: null, run_id: null, retired_at: null, created_at: now, updated_at: now, ...entry.set } as StoredBillingPackPrice);
      else Object.assign(instance.packPrices.find((price) => price.id === entry.id)!, entry.set, { updated_at: now });
    } else if (entry.change.table === "billing_plans") {
      if (entry.change.action === "insert") instance.plans.push({ provider_disc: null, frozen_at: null, run_id: null, retired_at: null, created_at: now, updated_at: now, ...entry.set } as StoredBillingPlan);
      else Object.assign(instance.plans.find((plan) => plan.code === entry.change.key)!, entry.set, { updated_at: now });
    } else if (entry.change.action === "insert") {
      const set = entry.set as { period: "monthly" | "annual"; cents: number };
      instance.prices.push({ id: crypto.randomUUID(), provider_ref: null, run_id: null, retired_at: null, created_at: now, updated_at: now, per_month: perMonthCents(set.period, set.cents), ...entry.set } as StoredBillingPrice);
    } else {
      Object.assign(instance.prices.find((price) => price.id === entry.id)!, entry.set, { updated_at: now });
    }
  }
}

/** What an apply writes for a file as the deployment's provider sells it, its plans' rows and then its packs', as the API diffs them. */
function applyDiff(instance: Instance, profile: BillingProfile, now: string) {
  const sells = billingProfileForProvider(profile, instance.provider);
  const diff = diffBillingCatalog({ plans: desiredBillingPlans(sells), currency: profile.currency, current: instance, now });
  const packDiff = diffBillingPackCatalog({ packs: desiredBillingPacks(sells), currency: profile.currency, current: instance, now });
  return { writes: [...diff.writes, ...packDiff.writes], refusals: [...diff.refusals, ...packDiff.refusals] };
}

function catalogOf(instance: Instance): ApiBillingCatalog {
  const latest = instance.catalogRuns.at(-1) ?? null;
  const lastLink = instance.linkRuns.at(-1) ?? null;
  const { objects = null, ...shownLink } = lastLink ?? {};
  // By sort then code, as the API reads them.
  const packs = [...instance.packs].sort((a, b) => a.sort - b.sort || (a.code < b.code ? -1 : 1));
  return {
    brand: "realinfobot",
    code_hash: instance.codeHash,
    hash: latest?.hash ?? null,
    matches_code: latest?.hash === instance.codeHash,
    last_run: latest,
    profile: null,
    currency: instance.prices.find((price) => price.retired_at === null)?.currency ?? null,
    plans: billingCatalogPlans(instance, instance.provider),
    packs: billingCatalogPacks({ packs, packPrices: instance.packPrices }),
    polar: instance.provider === "polar" ? { env: "sandbox", org: "org_test", secret_sha256: null, product_vars: {}, last_link: null } : null,
    provider: { id: instance.provider, env: instance.stripe.env, account: instance.stripe.account, secret_sha256: instance.stripe.secret ? sha256(instance.stripe.secret) : null, objects, product_vars: null, last_link: lastLink ? (shownLink as ApiBillingCatalogRun) : null },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const conflict = (refusals: Array<{ code: string; path: string; message: string }>) => json(409, { error: { code: "conflict", message: `Refused: ${refusals.map((refusal) => refusal.code).join(", ")}.`, details: refusals } });

/** The three billing catalog operations pnpm billing calls, on rows in memory. */
async function instanceFetch(instance: Instance, url: URL, init: RequestInit): Promise<Response> {
  const body = init.body ? JSON.parse(String(init.body)) as Record<string, any> : undefined;
  instance.requests.push({ path: `${init.method ?? "GET"} ${url.pathname}`, body });
  const now = new Date().toISOString();
  const latestHash = instance.catalogRuns.at(-1)?.hash ?? null;
  if (url.pathname === "/api/v1/billing/catalog") return json(200, { data: catalogOf(instance) });
  if (url.pathname === "/api/v1/billing/catalog/runs" && init.method === "POST") {
    const profile = billingProfileSchema.parse(body!.billing_file);
    const hash = hashOf(profile);
    // As the admin applies it: the file as the deployment's provider sells it.
    const diff = applyDiff(instance, profile, now);
    const refusals = [...diff.refusals];
    if (body!.replaces_hash !== undefined && body!.replaces_hash !== latestHash) refusals.push({ code: "catalog_changed", path: "replaces_hash", message: "Someone applied in between." });
    if (!profile.stripe && instance.provider === "stripe") refusals.push({ code: "provider_block_missing", path: "billing_file.stripe", message: "No stripe block." });
    const changes = diff.writes.map((entry) => entry.change);
    if (body!.dry_run) return json(200, { data: run("catalog", { id: null, status: "preview", hash, changes, blocked_by: refusals }) });
    if (refusals.length) return conflict(refusals);
    write(instance, diff.writes);
    const stored = run("catalog", { status: changes.length ? "applied" : "unchanged", hash, prev_hash: latestHash, code_hash: instance.codeHash, changes });
    instance.catalogRuns.push(stored);
    return json(201, { data: stored });
  }
  if (url.pathname === "/api/v1/billing/catalog/links") {
    const link = billingCatalogLinkRequest(apiBillingCatalogLinkSchema.parse(body));
    const diff = diffBillingLinks({ body: link, current: instance, now });
    const packDiff = diffBillingPackLinks({ body: link, current: instance, now });
    const refusals = [...diff.refusals, ...packDiff.refusals];
    const first = instance.linkRuns[0];
    if (link.hash !== latestHash) refusals.push({ code: "catalog_changed", path: "hash", message: "Another file." });
    if (link.provider !== instance.provider) refusals.push({ code: "provider_mismatch", path: "provider", message: "Another provider." });
    else if (link.provider_env !== instance.stripe.env || link.provider_account !== instance.stripe.account) refusals.push({ code: "billing_account_mismatch", path: "provider_account", message: "Another account." });
    if (first && first.provider_account !== link.provider_account) refusals.push({ code: "billing_account_changed", path: "provider_account", message: "Linked to another account first." });
    if (refusals.length) return conflict(refusals);
    const writes = [...diff.writes, ...packDiff.writes];
    write(instance, writes);
    const changes = writes.map((entry) => entry.change);
    const stored: LinkRun = { ...run("link", { status: changes.length ? "applied" : "unchanged", hash: link.hash, prev_hash: instance.linkRuns.at(-1)?.hash ?? null, changes, provider: "stripe", provider_env: link.provider_env, provider_account: link.provider_account }), objects: link.objects };
    instance.linkRuns.push(stored);
    const { objects: _objects, ...shown } = stored;
    return json(201, { data: shown });
  }
  return json(404, { error: { code: "not_found", message: `No ${url.pathname}.` } });
}

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/**
 * A checkout with the example file of plans and packs in RealInfoBot's folder and a stripe block, an
 * instance on Stripe whose code was built with it, and an empty Stripe sandbox. The example file is
 * RealInfoBot's file before it moved to listing packs, so these runs still sell Starter and Pro.
 */
async function setUp(options: { change?: (file: Record<string, any>) => void; provider?: "stripe" | "polar"; account?: string; block?: Partial<typeof stripeBlock> } = {}) {
  root = await mkdtemp(join(tmpdir(), "billing-stripe-"));
  const file = JSON.parse(await readFile(new URL("../packages/shared/src/brands/testing/plans-and-packs.billing.json", import.meta.url), "utf8")) as Record<string, any>;
  file.stripe = { ...structuredClone(stripeBlock), ...options.block };
  const deployed = billingProfileSchema.parse(structuredClone(file));
  options.change?.(file);
  await mkdir(join(root, "brands", "realinfobot"), { recursive: true });
  await writeFile(join(root, "brands", "realinfobot", "billing.json"), JSON.stringify(file, null, 2));
  const stripe = createFakeStripe({ accountId: "acct_dev1" });
  const instance: Instance = { plans: [], prices: [], packs: [], packPrices: [], catalogRuns: [], linkRuns: [], codeHash: hashOf(deployed), provider: options.provider ?? "stripe", stripe: { env: "sandbox", account: options.account ?? "acct_dev1", secret: null }, requests: [] };
  // The deployed file was applied when the instance was set up.
  const seeded = applyDiff(instance, deployed, new Date().toISOString());
  write(instance, seeded.writes);
  instance.catalogRuns.push(run("catalog", { hash: instance.codeHash, code_hash: instance.codeHash, changes: seeded.writes.map((entry) => entry.change) }));
  return { stripe, instance };
}

async function billing(argv: string[], context: { stripe: FakeStripe; instance: Instance }, extra: { env?: Record<string, string>; answer?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const keys: string[] = [];
  const code = await runBilling(argv, {
    env: { LOBBYSTACK_URL: instanceUrl, LOBBYSTACK_API_KEY: "lsp_00000000_test", XDG_CONFIG_HOME: root, STRIPE_SETUP_KEY: "rk_test_setup123", ...extra.env },
    root,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => await instanceFetch(context.instance, new URL(String(input)), init)) as typeof fetch,
    stripeApi: (key) => {
      keys.push(key);
      return context.stripe;
    },
    ...(extra.answer !== undefined ? { ask: async (question: string) => { asked.push(question); return extra.answer!; } } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), asked, keys };
}

const sandbox = ["--brand", "realinfobot", "--stripe", "sandbox"];
const writes = (stripe: FakeStripe) => stripe.requests.filter((request) => !request.call.endsWith(".list") && !request.call.endsWith(".retrieve") && request.call !== "accounts.retrieveCurrent");

describe("pnpm billing --stripe", () => {
  it("refuses two providers, another mode, --adopt and a key of the other mode, before changing anything", async () => {
    const context = await setUp();
    expect((await billing(["plan", ...sandbox, "--polar", "sandbox"], context)).err).toContain("Name one provider: --polar or --stripe.");
    expect((await billing(["plan", "--brand", "realinfobot", "--stripe", "prod"], context)).err).toContain("--stripe is sandbox or live.");
    expect((await billing(["plan", ...sandbox, "--adopt"], context)).err).toContain("--adopt is Polar's");
    const live = await billing(["plan", ...sandbox], context, { env: { STRIPE_SETUP_KEY: "rk_live_setup123" } });
    expect(live).toMatchObject({ code: 2, err: "The Stripe read key is a live key, and --stripe sandbox needs a test one." });
    expect((await billing(["apply", ...sandbox, "--yes"], context, { env: { STRIPE_SETUP_KEY: "" } })).err).toBe("Set STRIPE_SETUP_KEY to a Stripe sandbox setup key.");
    // Without a key it asks, with typing hidden, and never prints it.
    const asked = await billing(["plan", ...sandbox], context, { env: { STRIPE_SETUP_KEY: "" }, answer: "rk_test_typed123" });
    expect(asked.asked).toEqual(["Stripe sandbox read key (typing is hidden): "]);
    expect(asked.keys).toEqual(["rk_test_typed123"]);
    expect(asked.out + asked.err).not.toContain("rk_test_typed123");
    expect(writes(context.stripe)).toEqual([]);
    expect(context.instance.requests.filter((request) => request.path.startsWith("POST") && !request.body?.dry_run)).toEqual([]);
  });

  it("sets an empty sandbox up, links it, saves the secrets Stripe shows once, and has nothing left to do on a second run", async () => {
    const context = await setUp();
    const plan = await billing(["plan", ...sandbox], context);
    expect(plan.err).toBe("");
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("to https://dev1.realinfobot.com and Stripe sandbox account acct_dev1\n");
    // 18 for the plans and the deployment, then a product and a one-time price for each of the 9 packs.
    expect(plan.out).toContain("Stripe: 36 calls");
    expect(plan.out).toContain("create Price lsp_realinfobot_pack_250_90_cad_");
    expect(plan.out).toContain('create Meter "Voice overage in dollars"');
    expect(plan.out).toContain("create Price ls_realinfobot_pro_monthly_cad_");
    expect(plan.out).toContain("Set in Stripe's Dashboard, which its API can't:");
    expect(plan.out).toContain("A grace period of 1 hour before an invoice with usage is finalized");
    expect(writes(context.stripe)).toEqual([]);

    const railwayFile = join(root, "railway.txt");
    const applied = await billing(["apply", ...sandbox, "--yes", "--railway-file", railwayFile], context);
    expect(applied.err).toBe("");
    const catalog = context.stripe.state.catalog;
    // 5 products and 7 prices for the plans and overage, and one each for the 9 packs.
    expect([catalog.meters.length, catalog.products.length, catalog.prices.length, catalog.portalConfigurations.length, catalog.webhooks.length, catalog.eventDestinations.length]).toEqual([3, 14, 16, 1, 1, 1]);
    // The secrets Stripe showed once, saved for Railway and never printed.
    const railway = await readFile(railwayFile, "utf8");
    expect(railway).toContain("[admin, worker]\nSTRIPE_ACCOUNT_ID=acct_dev1\n");
    expect(railway).toContain(`[admin]\nSTRIPE_WEBHOOK_SECRET=${catalog.webhooks[0]!.secret}\nSTRIPE_METER_WEBHOOK_SECRET=${catalog.eventDestinations[0]!.secret}\n`);
    expect(applied.out).not.toContain("whsec_");
    // The link names Stripe, its objects and the endpoint secret's hash.
    const linked = context.instance.requests.find((request) => request.path === "POST /api/v1/billing/catalog/links")!.body;
    expect(linked).toMatchObject({ provider: "stripe", provider_env: "sandbox", provider_account: "acct_dev1", objects: { portal_configuration: catalog.portalConfigurations[0]!.id, webhook_endpoint: catalog.webhooks[0]!.id, meter_error_destination: catalog.eventDestinations[0]!.id, webhook_secret_sha256: sha256(catalog.webhooks[0]!.secret) } });
    expect(context.instance.prices.map((price) => price.provider_ref).sort()).toEqual(catalog.prices.filter((price) => price.lookup_key?.startsWith("ls_realinfobot_")).map((price) => price.id).sort());
    // Each pack is linked to its one-time price.
    const packPrices = catalog.prices.filter((price) => price.lookup_key?.startsWith("lsp_realinfobot_"));
    expect(packPrices.every((price) => price.recurring === null)).toBe(true);
    expect(context.instance.packPrices.map((price) => price.provider_ref).sort()).toEqual(packPrices.map((price) => price.id).sort());
    expect(applied.out).toContain("Links: recorded");
    // The instance doesn't have the new endpoint's secret yet.
    expect(applied.out).toContain("DRIFT  webhook_secret: STRIPE_WEBHOOK_SECRET isn't set on the instance");
    expect(applied.code).toBe(1);

    context.instance.stripe.secret = catalog.webhooks[0]!.secret;
    const verified = await billing(["verify", ...sandbox], context);
    expect(verified.out).toContain("File and Stripe");
    expect(verified.out).toContain("Result: in sync (exit 0).");
    expect(verified.code).toBe(0);

    const before = writes(context.stripe).length;
    const again = await billing(["apply", ...sandbox, "--yes"], context);
    expect(again.out).toContain("Postgres: the file is applied");
    expect(again.out).toContain("Stripe: sells what the file says");
    expect(again.out).toContain("Links: already recorded");
    expect(again.code).toBe(0);
    expect(writes(context.stripe)).toHaveLength(before);
  });

  it("sells monthly prices only with Stripe as the merchant of record, and links every price the instance holds", async () => {
    const context = await setUp({ block: { overage: "checkout", managedPayments: true } });
    // The instance applied the file as a Stripe deployment sells it: no yearly prices.
    expect([...new Set(context.instance.prices.map((price) => price.period))]).toEqual(["monthly"]);
    const applied = await billing(["apply", ...sandbox, "--yes"], context);
    expect(applied.err).toBe("");
    expect(applied.out).toContain("Links: recorded");
    const sold = context.stripe.state.catalog.prices.filter((price) => price.lookup_key?.startsWith("ls_realinfobot_"));
    expect(sold.map((price) => price.recurring?.interval)).not.toContain("year");
    expect(context.instance.prices.map((price) => price.provider_ref).sort()).toEqual(sold.map((price) => price.id).sort());
  });
  it("finishes a run cut off halfway on the next run, making nothing twice", async () => {
    const context = await setUp();
    context.stripe.cutAfterWrites(6);
    const cut = await billing(["apply", ...sandbox, "--yes"], context);
    expect(cut.code).toBe(2);
    expect(cut.err).toContain("An error occurred with our connection to Stripe.");
    expect(context.instance.linkRuns).toEqual([]);
    context.stripe.cutAfterWrites(null);
    const plan = await billing(["plan", ...sandbox], context);
    // The 12 calls left for the plans and the deployment, then the 18 for the packs.
    expect(plan.out).toContain("Stripe: 30 calls");
    const finished = await billing(["apply", ...sandbox, "--yes"], context);
    expect(finished.out).toContain("Links: recorded");
    const catalog = context.stripe.state.catalog;
    expect([catalog.meters.length, catalog.products.length, catalog.prices.length]).toEqual([3, 14, 16]);
  });

  it("refuses an instance that bills through Polar, or uses another Stripe account", async () => {
    const polar = await setUp({ provider: "polar" });
    const onPolar = await billing(["plan", ...sandbox], polar);
    expect(onPolar.code).toBe(1);
    expect(onPolar.err).toContain("The instance bills through Polar, not Stripe, so pnpm billing --stripe can't set it up.");
    const other = await setUp({ account: "acct_other" });
    const refused = await billing(["plan", ...sandbox], other);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("The instance uses Stripe account acct_other, and the key reaches acct_dev1. Use a key of the instance's account.");
    expect(writes(other.stripe)).toEqual([]);
  });

  it("verifies against what Stripe holds, and names what moved", async () => {
    const context = await setUp();
    await billing(["apply", ...sandbox, "--yes"], context);
    context.instance.stripe.secret = context.stripe.state.catalog.webhooks[0]!.secret;
    const price = context.stripe.state.catalog.prices.find((entry) => entry.lookup_key?.startsWith("ls_realinfobot_pro_monthly"))!;
    price.active = false;
    const drift = await billing(["verify", ...sandbox], context);
    expect(drift.code).toBe(1);
    expect(drift.out).toContain(`DRIFT  price: Price ${price.lookup_key}: bring it back: the file sells it again.`);
    expect(drift.out).toContain(`DRIFT  linked_id: pro/monthly is linked to price ${price.id}, which is archived.`);
    const json = await billing(["verify", ...sandbox, "--json"], context);
    expect(JSON.parse(json.out)).toMatchObject({ status: "drift" });
  });
});
