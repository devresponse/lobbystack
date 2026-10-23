import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { billingCatalogWriteOrder, desiredBillingPlans, diffBillingCatalog, diffBillingLinks, type StoredBillingPlan, type StoredBillingPrice } from "../packages/domain/src/server/billingCatalog";
import { createFakePolar, seedPolarSetup, type FakePolar } from "../packages/domain/src/server/billingPolar.testing";
import { billingProfileSchema, canonicalBillingProfileJson, type ApiBillingCatalog, type ApiBillingCatalogRun, type BillingProfile } from "../packages/shared/src/index";
import { runBilling } from "./billing";

// pnpm billing end to end, against the Polar stand-in and a stand-in instance
// that keeps its tables in memory with the API's own diff and link rules.

const repositoryFile = new URL("../brands/alloplace/billing.json", import.meta.url);
const instanceUrl = "https://demo.alloplace.com";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const hashOf = (profile: BillingProfile) => sha256(canonicalBillingProfileJson(profile));

type Instance = {
  plans: StoredBillingPlan[];
  prices: StoredBillingPrice[];
  catalogRuns: ApiBillingCatalogRun[];
  linkRuns: ApiBillingCatalogRun[];
  /** What the instance's environment holds: its code's file hash and its Polar variables. */
  codeHash: string;
  polar: { env: "sandbox" | "production"; org: string | null; secret: string | null; productVars: Record<string, string | null> };
  requests: Array<{ path: string; body: unknown }>;
};

function run(kind: ApiBillingCatalogRun["kind"], fields: Partial<ApiBillingCatalogRun>): ApiBillingCatalogRun {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), kind, status: "applied", brand: "alloplace", ver: 1, hash: "0".repeat(64), prev_hash: null, code_hash: null, changes: [], problems: [], blocked_by: [], polar_env: null, polar_org: null, key_id: "key", partner: "lobbystack", started_at: now, ended_at: now, ...fields };
}

/** Writes an apply's or a link's rows as Postgres would. */
function write(instance: Instance, writes: ReturnType<typeof diffBillingCatalog>["writes"]) {
  const now = new Date().toISOString();
  for (const entry of billingCatalogWriteOrder(writes)) {
    if (entry.change.table === "billing_plans") {
      if (entry.change.action === "insert") instance.plans.push({ polar_disc: null, frozen_at: null, run_id: null, retired_at: null, created_at: now, updated_at: now, ...entry.set } as StoredBillingPlan);
      else Object.assign(instance.plans.find((plan) => plan.code === entry.change.key)!, entry.set, { updated_at: now });
    } else if (entry.change.action === "insert") {
      const set = entry.set as { period: string; cents: number };
      instance.prices.push({ id: crypto.randomUUID(), polar_id: null, run_id: null, retired_at: null, created_at: now, updated_at: now, per_month: set.period === "annual" ? Math.floor(set.cents / 12) : set.cents, ...entry.set } as StoredBillingPrice);
    } else {
      Object.assign(instance.prices.find((price) => price.id === entry.id)!, entry.set, { updated_at: now });
    }
  }
}

function catalogOf(instance: Instance): ApiBillingCatalog {
  const latest = instance.catalogRuns.at(-1) ?? null;
  return {
    brand: "alloplace",
    code_hash: instance.codeHash,
    hash: latest?.hash ?? null,
    matches_code: latest?.hash === instance.codeHash,
    last_run: latest,
    profile: null,
    currency: instance.prices.find((price) => price.retired_at === null)?.currency ?? null,
    plans: instance.plans.map(({ run_id: _runId, ...plan }) => ({ ...plan, discount: plan.discount as Record<string, unknown> | null, prices: instance.prices.filter((price) => price.plan === plan.code).map(({ plan: _plan, run_id: _run, ...price }) => price) })),
    polar: { env: instance.polar.env, org: instance.polar.org, secret_sha256: instance.polar.secret ? sha256(instance.polar.secret) : null, product_vars: instance.polar.productVars, last_link: instance.linkRuns.at(-1) ?? null },
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
    const diff = diffBillingCatalog({ plans: desiredBillingPlans(profile), currency: profile.currency, current: instance, now });
    const refusals = [...diff.refusals];
    if (body!.replaces_hash !== undefined && body!.replaces_hash !== latestHash) refusals.push({ code: "catalog_changed", path: "replaces_hash", message: "Someone applied in between." });
    if (!body!.allow_undeployed && hash !== instance.codeHash) refusals.push({ code: "file_not_deployed", path: "billing_file", message: "Not deployed." });
    const changes = diff.writes.map((entry) => entry.change);
    if (body!.dry_run) return json(200, { data: run("catalog", { id: null, status: "preview", hash, changes, blocked_by: refusals }) });
    if (refusals.length) return conflict(refusals);
    write(instance, diff.writes);
    const stored = run("catalog", { status: changes.length ? "applied" : "unchanged", hash, prev_hash: latestHash, code_hash: instance.codeHash, changes });
    instance.catalogRuns.push(stored);
    return json(201, { data: stored });
  }
  if (url.pathname === "/api/v1/billing/catalog/polar-links") {
    const diff = diffBillingLinks({ body: body as never, current: instance, now });
    const refusals = [...diff.refusals];
    if (body!.hash !== latestHash) refusals.push({ code: "catalog_changed", path: "hash", message: "Another file." });
    if (body!.polar_env !== instance.polar.env || body!.polar_org !== instance.polar.org) refusals.push({ code: "polar_org_mismatch", path: "polar_org", message: "Another organization." });
    if (refusals.length) return conflict(refusals);
    write(instance, diff.writes);
    const changes = diff.writes.map((entry) => entry.change);
    const stored = run("polar", { status: changes.length ? "applied" : "unchanged", hash: body!.hash, prev_hash: instance.linkRuns.at(-1)?.hash ?? null, changes, polar_env: body!.polar_env, polar_org: body!.polar_org });
    instance.linkRuns.push(stored);
    return json(201, { data: stored });
  }
  return json(404, { error: { code: "not_found", message: `No ${url.pathname}.` } });
}

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** A checkout with the brand's file, changed as a test needs, and an instance whose code was built with the repository's file. */
async function setUp(options: { change?: (file: Record<string, any>) => void; seeded?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), "billing-"));
  const text = await readFile(repositoryFile, "utf8");
  const file = JSON.parse(text) as Record<string, any>;
  options.change?.(file);
  await mkdir(join(root, "brands", "alloplace"), { recursive: true });
  await writeFile(join(root, "brands", "alloplace", "billing.json"), JSON.stringify(file, null, 2));
  const deployed = billingProfileSchema.parse(JSON.parse(text));
  const fake = createFakePolar();
  if (options.seeded !== false) await seedPolarSetup(fake);
  const productId = (name: string) => fake.state.products.find((product) => product.name === name)?.id ?? null;
  const instance: Instance = {
    plans: [],
    prices: [],
    catalogRuns: [],
    linkRuns: [],
    codeHash: hashOf(deployed),
    polar: {
      env: "sandbox",
      org: fake.state.organization.id,
      secret: fake.state.webhooks[0]?.secret ?? null,
      // As polar-setup.mjs left them on Railway.
      productVars: { "starter/monthly": productId("Starter monthly"), "starter/annual": productId("Starter annual"), "pro/monthly": productId("Pro monthly"), "pro/annual": productId("Pro annual") },
    },
    requests: [],
  };
  // Step 1's catalog apply already ran on the deployed file.
  const seeded = diffBillingCatalog({ plans: desiredBillingPlans(deployed), currency: deployed.currency, current: instance, now: new Date().toISOString() });
  write(instance, seeded.writes);
  instance.catalogRuns.push(run("catalog", { hash: instance.codeHash, code_hash: instance.codeHash, changes: seeded.writes.map((entry) => entry.change) }));
  instance.requests.length = 0;
  return { fake, instance };
}

async function billing(argv: string[], context: { fake: FakePolar; instance: Instance }, extra: { env?: Record<string, string>; answer?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const code = await runBilling(argv, {
    env: { LOBBYSTACK_URL: instanceUrl, LOBBYSTACK_API_KEY: "lsp_00000000_test", XDG_CONFIG_HOME: root, POLAR_SETUP_TOKEN: "polar_oat_setup", ...extra.env },
    root,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      return url.origin === instanceUrl ? await instanceFetch(context.instance, url, init) : await context.fake.fetch(input, init);
    }) as typeof fetch,
    ...(extra.answer !== undefined ? { ask: async (question: string) => { asked.push(question); return extra.answer!; } } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), asked };
}

const sandbox = ["--brand", "alloplace", "--polar", "sandbox"];

describe("pnpm billing", () => {
  it("refuses a wrong command or flag with its usage, before reading anything", async () => {
    const context = await setUp();
    expect(await billing([], context)).toMatchObject({ code: 2, err: expect.stringContaining("Name a command: plan, apply or verify.") });
    expect((await billing(["apply", "--brand", "alloplace", "--polar", "prod"], context)).err).toContain("--polar is sandbox or live.");
    expect((await billing(["plan", ...sandbox, "--yes"], context)).err).toContain("--yes only goes with apply.");
    expect((await billing(["verify", ...sandbox, "--adopt"], context)).err).toContain("--adopt only goes with plan and apply.");
    await writeFile(join(root, "taken.txt"), "");
    expect((await billing(["apply", ...sandbox, "--railway-file", join(root, "taken.txt")], context)).err).toContain("already exists");
    expect((await billing(["plan", "--brand", "cadre", "--polar", "sandbox"], context))).toMatchObject({ code: 2, err: "There's no brands/cadre/billing.json in this checkout." });
    expect(context.instance.requests).toEqual([]);
    expect(context.fake.writes).toEqual([]);
  });

  it("takes over polar-setup.mjs's objects with --adopt, keeping their IDs, links them and passes verify", async () => {
    const context = await setUp();
    const ids = context.fake.state.products.map((product) => product.id);

    const refused = await billing(["plan", ...sandbox], context);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Refused, so nothing changed:");
    expect(refused.err).toContain('Product "Pro monthly"');
    expect(refused.err).toContain("--adopt");

    const plan = await billing(["plan", ...sandbox, "--adopt"], context);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("Postgres: the file is applied");
    expect(plan.out).toContain('tag Product "Pro monthly"');
    expect(plan.out).toContain("Links: 4 live prices of 2 sold plans");
    expect(plan.out).toContain("This was a plan, so nothing changed.");
    expect(context.fake.writes).toEqual([]);

    const railwayFile = join(root, "railway.txt");
    const applied = await billing(["apply", ...sandbox, "--adopt", "--yes", "--railway-file", railwayFile], context);
    expect(applied.err).toBe("");
    expect(applied.code).toBe(0);
    expect(context.fake.writes.every((entry) => entry.method === "PATCH")).toBe(true);
    expect(context.fake.state.products.map((product) => product.id)).toEqual(ids);
    expect(applied.out).toContain("Links: recorded 6 changes in run");
    expect(applied.out).toContain("Result: in sync (exit 0).");
    // Postgres wasn't asked to apply again, only for dry runs: the file was applied in step 1.
    expect(context.instance.requests.filter((request) => request.path === "POST /api/v1/billing/catalog/runs").map((request) => (request.body as { dry_run?: boolean }).dry_run)).toEqual([true, true, true]);
    expect(context.instance.plans.filter((entry) => entry.sold).map((entry) => entry.status)).toEqual(["active", "active"]);
    expect(context.instance.prices.map((price) => price.polar_id).sort()).toEqual([...ids].sort());

    // The Railway values, readable only by this user, without a webhook secret: Polar already had the webhook.
    const railway = await readFile(railwayFile, "utf8");
    expect((await stat(railwayFile)).mode & 0o777).toBe(0o600);
    expect(railway).toContain("[lobbystack-admin, worker]\nPOLAR_API_BASE_URL=https://sandbox-api.polar.sh\nPOLAR_ORGANIZATION_ID=org_test\n");
    expect(railway).not.toContain("PRODUCT_ID");
    expect(railway).not.toContain("POLAR_WEBHOOK_SECRET");

    // Again: nothing to do anywhere.
    context.fake.writes.length = 0;
    const again = await billing(["apply", ...sandbox, "--yes"], context);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Postgres: the file is applied");
    expect(again.out).toContain("Polar: sells what the file says");
    expect(again.out).toContain("Links: already recorded");
    expect(context.fake.writes).toEqual([]);
  });

  it("applies an applied file again when the running code resolves it to other rows", async () => {
    const context = await setUp();
    expect((await billing(["apply", ...sandbox, "--adopt", "--yes"], context)).code).toBe(0);
    // As if older code had written another value for the same file.
    context.instance.plans.find((plan) => plan.code === "pro")!.sort = 99;
    context.instance.requests.length = 0;
    const applied = await billing(["apply", ...sandbox, "--yes"], context);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("Postgres: 1 change");
    expect(applied.out).toContain("Postgres: applied 1 change in run");
    expect(context.instance.plans.find((plan) => plan.code === "pro")!.sort).not.toBe(99);
    expect(context.instance.requests.filter((request) => request.path === "POST /api/v1/billing/catalog/runs").map((request) => (request.body as { dry_run?: boolean }).dry_run === true)).toEqual([true, false]);
  });

  it("sets an empty organization up, saving the new webhook's secret to the Railway file, and reports what the instance still needs", async () => {
    const context = await setUp({ seeded: false });
    context.instance.polar.secret = "polar_whs_old";
    const railwayFile = join(root, "railway.txt");
    const applied = await billing(["apply", ...sandbox, "--yes", "--railway-file", railwayFile], context);
    expect(applied.out).toContain("done create Webhook https://demo.alloplace.com/api/webhooks/polar: Raw, 15 events");
    expect(applied.code).toBe(1);
    expect(applied.out).toContain("DRIFT  webhook_secret");
    expect(applied.out).toContain("ok     checkout sells the linked products; no product ID variable is needed");
    const secret = context.fake.state.webhooks[0]!.secret!;
    const railway = await readFile(railwayFile, "utf8");
    expect(railway).toContain(`[lobbystack-admin]\nPOLAR_WEBHOOK_SECRET=${secret}\n`);
    expect(railway).toContain("delete it once Railway has the values");
    // The secret goes to the file only, never to the output.
    expect(applied.out).not.toContain(secret);

    // Once Railway has the values, verify passes.
    context.instance.polar.secret = secret;
    expect((await billing(["verify", ...sandbox], context, { env: { POLAR_READ_TOKEN: "polar_oat_read" } })).code).toBe(0);
  });

  it("keeps a new webhook's secret in the Railway file when a later Polar call fails", async () => {
    const context = await setUp({ seeded: false });
    await billing(["apply", ...sandbox, "--yes"], context);
    // The webhook went missing, and a product the file doesn't sell waits to be archived after it's made again.
    context.fake.state.webhooks.length = 0;
    const annual = context.fake.state.products.find((product) => product.name === "Pro annual")!;
    context.fake.state.products.push({ ...annual, id: "prod_gold", name: "Gold annual", metadata: { ...annual.metadata, lobbystack_plan: "gold" } });
    const reachable = context.fake.fetch;
    context.fake.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const response = await reachable(input, init);
      if (init.method === "POST" && new URL(String(input)).pathname.startsWith("/v1/webhooks/endpoints")) context.fake.rejectToken = true;
      return response;
    }) as typeof fetch;
    const railwayFile = join(root, "railway.txt");
    const stopped = await billing(["apply", ...sandbox, "--yes", "--allow-archive", "--railway-file", railwayFile], context);
    expect(stopped.out).toContain("done create Webhook");
    expect(stopped.err).toContain("Polar answered 401 to PATCH /v1/products/prod_gold");
    expect(stopped.code).toBe(2);
    expect(await readFile(railwayFile, "utf8")).toContain(`[lobbystack-admin]\nPOLAR_WEBHOOK_SECRET=${context.fake.state.webhooks[0]!.secret}\n`);
    expect(context.instance.linkRuns).toHaveLength(1);
  });

  it("applies a changed file only with --allow-undeployed, then the catalog, Polar and the links in that order", async () => {
    const context = await setUp({ seeded: false, change: (file) => { file.plans.pro.prices.monthlyCents = 12000; } });
    const refused = await billing(["apply", ...sandbox, "--yes"], context);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Deploy the merged file first, or add --allow-undeployed to try it on a sandbox.");
    expect(context.fake.writes).toEqual([]);

    const plan = await billing(["plan", ...sandbox, "--allow-undeployed", "--json"], context);
    expect(plan.code).toBe(0);
    const shown = JSON.parse(plan.out) as { catalog: Array<{ key: string; action: string }>; steps: Array<{ action: string; object: string }>; refusals: string[] };
    expect(shown.catalog.map((change) => `${change.action} ${change.key}`)).toEqual(["update pro", "update pro/monthly/cad"]);
    expect(shown.steps.filter((step) => step.object === "product").map((step) => step.action)).toEqual(["create", "create", "create", "create", "attach", "attach"]);
    expect(shown.refusals).toEqual([]);

    context.instance.requests.length = 0;
    const applied = await billing(["apply", ...sandbox, "--yes", "--allow-undeployed"], context);
    expect(applied.out).toContain("Postgres: applied 2 changes in run");
    expect(applied.out).toContain("warn   code_hash");
    // Read, dry run, apply, then link once Polar matches, then read for the report.
    expect(context.instance.requests.map((request) => request.path)).toEqual([
      "GET /api/v1/billing/catalog",
      "POST /api/v1/billing/catalog/runs",
      "POST /api/v1/billing/catalog/runs",
      "POST /api/v1/billing/catalog/polar-links",
      "GET /api/v1/billing/catalog",
    ]);
    expect(context.instance.requests[1]!.body).toMatchObject({ dry_run: true });
    expect(context.instance.requests[2]!.body).toEqual({ brand: "alloplace", billing_file: expect.objectContaining({ version: 1 }), replaces_hash: context.instance.catalogRuns[0]!.hash, allow_undeployed: true });
    expect(context.fake.state.products.find((product) => product.name === "Pro monthly")!.prices.find((price) => price.amount_type === "fixed" && !price.is_archived)!.price_amount).toBe(12000);
  });

  it("asks before changing anything, and changes nothing on another answer", async () => {
    const context = await setUp();
    expect(await billing(["apply", ...sandbox, "--adopt"], context)).toMatchObject({ code: 2, err: "Add --yes to apply without a question." });
    const declined = await billing(["apply", ...sandbox, "--adopt"], context, { answer: "no" });
    expect(declined.asked).toEqual([expect.stringContaining("Apply these to https://demo.alloplace.com and Polar sandbox organization Test organization? Type yes to continue:")]);
    expect(declined).toMatchObject({ code: 1, out: expect.stringContaining("Nothing changed.") });
    expect(context.fake.writes).toEqual([]);
  });

  it("asks for a token with typing hidden when none is set, and stops on a token for another organization", async () => {
    const context = await setUp();
    const asked = await billing(["verify", ...sandbox], context, { env: { POLAR_SETUP_TOKEN: "" }, answer: "polar_oat_typed" });
    expect(asked.asked).toEqual(["Polar sandbox read token (typing is hidden): "]);
    context.instance.polar.org = "org_other";
    const other = await billing(["plan", ...sandbox, "--adopt"], context);
    expect(other.code).toBe(1);
    expect(other.err).toContain("The instance uses Polar sandbox organization org_other, and the token reaches sandbox organization Test organization (org_test).");
  });

  it("verifies the three copies, exits 1 on a drift with --json listing every check, and 2 when Polar can't be read", async () => {
    const context = await setUp();
    expect((await billing(["apply", ...sandbox, "--adopt", "--yes"], context)).code).toBe(0);
    context.fake.state.credits.find((credits) => credits.metadata.lobbystack_key === "alloplace/pro/voice_minutes")!.properties.units = 450;
    const drift = await billing(["verify", ...sandbox], context);
    expect(drift.code).toBe(1);
    expect(drift.out.split("\n")[0]).toMatch(/^alloplace billing\.json v1 \([0-9a-f]{12}\) against Polar sandbox and https:\/\/demo\.alloplace\.com$/);
    expect(drift.out).toContain("DRIFT  credits:");
    const listed = JSON.parse((await billing(["verify", ...sandbox, "--json"], context)).out) as { status: string; checks: Array<{ code: string; level: string }> };
    expect(listed.status).toBe("drift");
    expect(listed.checks.filter((check) => check.level === "drift").map((check) => check.code)).toEqual(["credits"]);
    context.fake.rejectToken = true;
    const unreadable = await billing(["verify", ...sandbox], context);
    expect(unreadable.code).toBe(2);
    expect(unreadable.out).toContain("Result: failed (exit 2).");
  });
});
