import { createHash } from "node:crypto";

import type { PolarSnapshot } from "@lobbystack/providers";
import { billingProfileSchema, POLAR_API_VERSION, trimTrailingSlashes, type ApiBillingCatalog, type ApiBillingCheck, type BillingCheckCode, type BillingCheckPair, type BillingProfile, type PolarEnv } from "@lobbystack/shared";

import { billingDeploymentPolar, desiredBillingPlans, diffBillingCatalog, getBillingCatalogForApi, recordBillingVerifyRun, type DesiredBillingPlan, type StoredBillingPlan, type StoredBillingPrice } from "./billingCatalog";
import { desiredPolarCatalog, planPolarChanges, polarTags, POLAR_WEBHOOK_PATH, type PolarStep, type PolarStepObject } from "./billingPolar";
import { polarProductVariableName } from "./billingPlans";
import type { DomainContext } from "./context";

// Verify compares the three copies of a brand's plans two at a time, so a
// failure names the side that moved: the repository file (the reference),
// the Postgres tables and Polar. File and Polar agree exactly when an apply
// would make no Polar call, so that pair reuses the apply's own plan.

export type BillingCheckLevel = "ok" | "drift" | "warn" | "info";
export type BillingCheckResult = { code: BillingCheckCode; pair: BillingCheckPair; level: BillingCheckLevel; subject: string; message: string };
export type BillingVerifyStatus = "passed" | "drift" | "failed";
export type BillingVerifyResult = { status: BillingVerifyStatus; checks: BillingCheckResult[] };

export type BillingVerifyInput = {
  file: { brand: string; hash: string; profile: Pick<BillingProfile, "currency" | "polar">; plans: readonly DesiredBillingPlan[] };
  /** getBillingCatalog's answer: the tables, and the instance's Polar settings. */
  catalog: ApiBillingCatalog;
  /** What the Polar token read, or why it couldn't. */
  polar: { env: PolarEnv; snapshot: PolarSnapshot } | { env: PolarEnv; error: string };
  /** The address the webhook should call. Null skips the webhook checks. */
  webhookUrl: string | null;
  /** Only the admin knows its webhook secret, so the worker leaves this check out. */
  checkWebhookSecret: boolean;
  now?: string;
};

const short = (hash: string | null | undefined) => (hash ? hash.slice(0, 12) : "none");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The catalog's rows in the shape the apply's diff reads. */
function storedRows(catalog: ApiBillingCatalog): { plans: StoredBillingPlan[]; prices: StoredBillingPrice[] } {
  const plans = catalog.plans.map(({ prices: _prices, ...plan }) => ({ ...plan, run_id: null }) as unknown as StoredBillingPlan);
  const prices = catalog.plans.flatMap((plan) => plan.prices.map((price) => ({ ...price, plan: plan.code, run_id: null }) as StoredBillingPrice));
  return { plans, prices };
}

const stepCodes: Record<PolarStepObject, BillingCheckCode> = { organization: "org_settings", meter: "meter", product: "product", discount: "discount", webhook: "webhook" };

function stepCode(step: Pick<PolarStep, "object" | "action" | "leftover">): BillingCheckCode {
  if (step.leftover) return "leftover";
  // Credits on a product are the Credits check's business.
  if (step.action === "detach") return "credits";
  return stepCodes[step.object];
}

/** Every check of section 7.1 of the step 2 design, ok ones included. Pure. */
export function verifyBillingCatalog(input: BillingVerifyInput): BillingVerifyResult {
  const { file, catalog } = input;
  const checks: BillingCheckResult[] = [];
  const add = (code: BillingCheckCode, pair: BillingCheckPair, level: BillingCheckLevel, subject: string, message: string) => checks.push({ code, pair, level, subject, message });
  const rows = storedRows(catalog);
  const sold = file.plans.filter((plan) => plan.sold && plan.prices.length);

  // File and Postgres.
  if (catalog.hash === file.hash) add("catalog_hash", "file_postgres", "ok", "catalog", `catalog ${short(file.hash)} applied`);
  else add("catalog_hash", "file_postgres", "drift", "catalog", `The latest catalog run is ${short(catalog.hash)} and the file is ${short(file.hash)}. Run pnpm billing apply.`);
  if (catalog.code_hash === file.hash) add("code_hash", "file_postgres", "ok", "code", "the deployed code was built with this file");
  else add("code_hash", "file_postgres", "warn", "code", catalog.code_hash ? `The deployed code was built with ${short(catalog.code_hash)}, not this file. Deploy the merged file.` : `The deployed code has no billing.json for ${file.brand}.`);
  const diff = diffBillingCatalog({ plans: [...file.plans], currency: file.profile.currency, current: rows, now: input.now ?? new Date().toISOString() });
  for (const write of diff.writes) add("plan_rows", "file_postgres", "drift", write.change.key, `${write.change.table} ${write.change.key} would be ${write.change.action === "update" ? `updated (${Object.keys(write.change.fields).join(", ")})` : `${write.change.action}d`} by an apply.`);
  for (const refusal of diff.refusals) add("plan_rows", "file_postgres", "drift", refusal.path, refusal.message);
  if (!diff.writes.length && !diff.refusals.length) add("plan_rows", "file_postgres", "ok", "rows", `${rows.plans.filter((plan) => plan.status !== "retired").length} plans, ${rows.prices.filter((price) => price.retired_at === null).length} live prices`);
  let unlinked = 0;
  for (const plan of sold) {
    const row = catalog.plans.find((entry) => entry.code === plan.code);
    if (!row) continue;
    if (row.status !== "active") {
      unlinked += 1;
      add("not_linked", "file_postgres", "drift", plan.code, `${plan.code} is ${row.status}${row.status === "draft" ? ", so Polar doesn't sell it as the file says yet" : ""}. Run pnpm billing apply.`);
    }
    for (const price of row.prices.filter((entry) => entry.retired_at === null && entry.polar_id === null)) {
      unlinked += 1;
      add("not_linked", "file_postgres", "drift", `${plan.code}/${price.period}`, `${plan.code} ${price.period} has no Polar product. Run pnpm billing apply.`);
    }
  }
  if (!unlinked) add("not_linked", "file_postgres", "ok", "links", `${sold.length} sold plans active and linked`);

  if ("error" in input.polar) {
    add("unreadable", "file_polar", "drift", "Polar", input.polar.error);
    return { status: "failed", checks };
  }
  const { snapshot, env } = input.polar;

  // File and Polar: everything an apply would still change.
  const desired = desiredPolarCatalog({ brand: file.brand, profile: file.profile, plans: file.plans, webhookUrl: input.webhookUrl });
  const plan = planPolarChanges({ catalog: desired, snapshot, options: { adopt: false, allowReplace: true, allowArchive: true }, ...(input.now ? { now: input.now } : {}) });
  const found = new Set<BillingCheckCode>();
  for (const step of plan.steps) {
    const code = stepCode(step);
    found.add(code);
    add(code, "file_polar", "drift", step.subject, `${step.subject}: ${step.changes.join("; ") || step.action}.`);
  }
  for (const refusal of plan.refusals) {
    found.add(stepCodes[refusal.object]);
    add(stepCodes[refusal.object], "file_polar", "drift", refusal.subject, `${refusal.subject}: ${refusal.message}`);
  }
  const okLines: Array<[BillingCheckCode, string]> = [
    ["org_settings", `currency ${desired.currency.toUpperCase()}, ${desired.settings.allowMultipleSubscriptions ? "several subscriptions" : "one subscription"} per customer, plan changes ${desired.settings.portalPlanChanges ? "on" : "off"} in the portal`],
    ["meter", `${desired.meters.length} meters`],
    ["credits", "no Credits on the products: the worker reports only each month's overage"],
    ["product", `${desired.products.length} products, tagged and priced as the file says${desired.products.some((product) => product.meterInterval) ? ", annual ones invoicing overage each month" : ""}`],
    ["discount", desired.discounts.length ? `${desired.discounts.length} ${desired.discounts.length === 1 ? "discount" : "discounts"}` : "no discounts"],
    ...(desired.webhook ? [["webhook", `webhook ${desired.webhook.url}, Raw, on, API version ${POLAR_API_VERSION}`] as [BillingCheckCode, string]] : []),
    ["leftover", `nothing else tagged for ${file.brand}`],
  ];
  for (const [code, message] of okLines) if (!found.has(code)) add(code, "file_polar", "ok", code, message);

  // Postgres and Polar.
  const products = new Map(snapshot.products.map((product) => [product.id, product]));
  let linked = 0;
  let badLinks = 0;
  for (const row of catalog.plans.filter((entry) => entry.status !== "retired")) {
    for (const price of row.prices.filter((entry) => entry.retired_at === null && entry.polar_id !== null)) {
      linked += 1;
      const subject = `${row.code}/${price.period}`;
      const product = products.get(price.polar_id!);
      const tags = product ? [product.metadata[polarTags.brand], product.metadata[polarTags.plan], product.metadata[polarTags.interval]] : [];
      const problem = !product ? "isn't in this Polar organization"
        : product.is_archived ? `is archived ("${product.name}")`
        : tags[0] !== file.brand || tags[1] !== row.code || tags[2] !== price.period ? `is tagged ${tags.map((tag) => String(tag ?? "-")).join(" ")} ("${product.name}")`
        : !product.prices.some((entry) => !entry.is_archived && entry.amount_type === "fixed" && entry.price_amount === price.cents && entry.price_currency.toLowerCase() === price.currency) ? `doesn't sell ${(price.cents / 100).toFixed(2)} ${price.currency.toUpperCase()} ("${product.name}")`
        : null;
      if (problem) {
        badLinks += 1;
        add("linked_id", "postgres_polar", "drift", subject, `${subject} is linked to product ${price.polar_id}, which ${problem}.`);
      }
    }
  }
  if (!badLinks) add("linked_id", "postgres_polar", "ok", "links", `${linked} products linked, all live, tagged and priced as the rows say`);
  for (const row of catalog.plans) {
    for (const price of row.prices.filter((entry) => entry.retired_at !== null && entry.polar_id !== null)) {
      if (!products.has(price.polar_id!)) add("retired_id", "postgres_polar", "info", `${row.code}/${price.period}`, `The retired ${row.code} ${price.period} price's product ${price.polar_id} isn't in Polar any more.`);
    }
  }
  const instance = catalog.polar;
  const lastLink = instance.last_link;
  const orgProblems = [
    ...(instance.org === null ? ["POLAR_ORGANIZATION_ID isn't set on the instance"] : instance.env !== env || instance.org !== snapshot.organization.id ? [`the instance uses Polar ${instance.env} ${instance.org} and the token reaches ${env} ${snapshot.organization.id}`] : []),
    ...(lastLink && (lastLink.polar_env !== env || lastLink.polar_org !== snapshot.organization.id) ? [`the last link went to Polar ${String(lastLink.polar_env)} ${String(lastLink.polar_org)}`] : []),
  ];
  if (orgProblems.length) add("polar_org", "postgres_polar", "drift", "organization", `${orgProblems.join("; ")}.`);
  else add("polar_org", "postgres_polar", "ok", "organization", `Polar ${env} organization ${snapshot.organization.name}`);
  if (input.checkWebhookSecret && desired.webhook) {
    const endpoint = snapshot.webhooks.find((entry) => trimTrailingSlashes(entry.url) === trimTrailingSlashes(desired.webhook!.url));
    if (endpoint) {
      if (!instance.secret_sha256) add("webhook_secret", "postgres_polar", "drift", "webhook", "POLAR_WEBHOOK_SECRET isn't set on the instance, so it refuses every Polar event.");
      else if (typeof endpoint.secret !== "string") add("webhook_secret", "postgres_polar", "drift", "webhook", "Polar didn't send the webhook's secret: the token needs webhooks:read.");
      else if (sha256(endpoint.secret) !== instance.secret_sha256) add("webhook_secret", "postgres_polar", "drift", "webhook", "The instance's POLAR_WEBHOOK_SECRET isn't the webhook's secret, so it refuses every Polar event. Copy the secret from the webhook's page in Polar to Railway.");
      else add("webhook_secret", "postgres_polar", "ok", "webhook", "webhook secrets match");
    }
  }
  // The four product ID variables are optional: a plan the link made active
  // sells only through its linked products, and checkout ignores them.
  const leftover: string[] = [];
  for (const [key, value] of Object.entries(instance.product_vars)) {
    if (value === null) continue;
    const [code, period] = key.split("/") as [string, string];
    const row = catalog.plans.find((entry) => entry.code === code);
    if (row?.status !== "active") continue;
    const link = row.prices.find((price) => price.period === period && price.retired_at === null)?.polar_id ?? null;
    const name = polarProductVariableName(code, period);
    if (value === link) leftover.push(name);
    else add("product_vars", "postgres_polar", "warn", name, `${name} is ${value}, not the linked product ${link ?? "(none)"}. Checkout sells the linked product and ignores the variable, so remove it from the instance.`);
  }
  if (leftover.length) add("product_vars", "postgres_polar", "info", "variables", `${leftover.join(", ")} ${leftover.length === 1 ? "matches its link and isn't" : "match their links and aren't"} needed any more; remove ${leftover.length === 1 ? "it" : "them"} from the instance when convenient.`);
  if (!checks.some((check) => check.code === "product_vars")) add("product_vars", "postgres_polar", "ok", "variables", "checkout sells the linked products; no product ID variable is needed");

  return { status: checks.some((check) => check.level === "drift") ? "drift" : "passed", checks };
}

/** The checks a run stores: every one that wasn't ok. */
export function billingProblems(checks: readonly BillingCheckResult[]): ApiBillingCheck[] {
  return checks.filter((check): check is BillingCheckResult & { level: ApiBillingCheck["level"] } => check.level !== "ok").map(({ code, pair, level, subject, message }) => ({ code, pair, level, subject, message }));
}

const pairTitles: Record<BillingCheckPair, string> = { file_postgres: "File and Postgres", file_polar: "File and Polar", postgres_polar: "Postgres and Polar" };
const levelLabels: Record<BillingCheckLevel, string> = { ok: "ok    ", drift: "DRIFT ", warn: "warn  ", info: "info  " };

/** The report pnpm billing prints, one line per check under its pair. */
export function billingVerifyReport(result: BillingVerifyResult, heading: string): string {
  const lines = [heading];
  for (const pair of Object.keys(pairTitles) as BillingCheckPair[]) {
    const checks = result.checks.filter((check) => check.pair === pair);
    if (!checks.length) continue;
    lines.push("", pairTitles[pair], ...checks.map((check) => `  ${levelLabels[check.level]} ${check.level === "ok" ? check.message : `${check.code}: ${check.message}`}`));
  }
  const ending = result.status === "passed" ? "Result: in sync (exit 0)." : result.status === "drift" ? "Result: drift (exit 1). Run pnpm billing apply, or change billing.json in a pull request." : "Result: failed (exit 2). Polar couldn't be read: check the token's scopes and run again.";
  lines.push("", ending);
  return lines.join("\n");
}

export type DailyBillingVerifyInput = {
  brand: string;
  env: Record<string, string | undefined>;
  /** Reads the worker's Polar organization with its own token. */
  readPolar(): Promise<PolarSnapshot>;
};

export type DailyBillingVerifyOutcome =
  | { status: "skipped"; reason: string }
  | { status: BillingVerifyStatus; previousStatus: string | null; problems: ApiBillingCheck[]; polarEnv: PolarEnv; runId: string };

/**
 * The worker's daily check: every check but the webhook secret, which only
 * the admin knows, against the profile stored on the latest catalog run.
 * Skipped until the deployment has a Polar organization and a first link.
 */
export async function runDailyBillingVerify(context: DomainContext, input: DailyBillingVerifyInput): Promise<DailyBillingVerifyOutcome> {
  const polar = billingDeploymentPolar(input.env, { withSecret: false });
  if (!polar.org) return { status: "skipped", reason: "POLAR_ORGANIZATION_ID isn't set" };
  const catalog = await getBillingCatalogForApi(context, { deployment: { brand: input.brand, polar } });
  const latest = catalog.last_run;
  if (!latest || !catalog.profile || !catalog.polar.last_link) return { status: "skipped", reason: "nothing was linked yet" };
  const parsed = billingProfileSchema.safeParse(catalog.profile);
  if (!parsed.success) throw new Error(`The profile stored on catalog run ${latest.id} no longer passes billingProfileSchema.`);
  const base = input.env.APP_BASE_URL?.trim();
  let snapshot: { env: PolarEnv; snapshot: PolarSnapshot } | { env: PolarEnv; error: string };
  try {
    snapshot = { env: polar.env, snapshot: await input.readPolar() };
  } catch (error) {
    snapshot = { env: polar.env, error: error instanceof Error ? error.message : String(error) };
  }
  const result = verifyBillingCatalog({
    file: { brand: latest.brand, hash: latest.hash, profile: parsed.data, plans: desiredBillingPlans(parsed.data) },
    catalog,
    polar: snapshot,
    webhookUrl: base ? `${new URL(base).origin}${POLAR_WEBHOOK_PATH}` : null,
    checkWebhookSecret: false,
  });
  const problems = billingProblems(result.checks);
  const recorded = await recordBillingVerifyRun(context, { catalog: { brand: latest.brand, ver: latest.ver, hash: latest.hash }, codeHash: catalog.code_hash, status: result.status, problems, polarEnv: polar.env, polarOrg: polar.org });
  return { status: result.status, previousStatus: recorded.previousStatus, problems, polarEnv: polar.env, runId: recorded.run.id! };
}
