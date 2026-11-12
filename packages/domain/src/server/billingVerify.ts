import { createHash } from "node:crypto";

import type { PolarSnapshot } from "@lobbystack/providers";
import type { StripeSnapshot } from "@lobbystack/providers/stripe/catalog";
import { billingProfileForProvider, billingProfileSchema, POLAR_API_VERSION, trimTrailingSlashes, upgradeStoredBillingProfile, type ApiBillingCatalog, type ApiBillingCatalogPrice, type ApiBillingCheck, type BillingCheckCode, type BillingCheckPair, type BillingProfile, type BillingProviderEnv, type PolarEnv } from "@lobbystack/shared";

import { billingCatalogDeployment, desiredBillingPacks, desiredBillingPlans, diffBillingCatalog, diffBillingPackCatalog, getBillingCatalogForApi, recordBillingVerifyRun, type DesiredBillingPack, type DesiredBillingPlan, type StoredBillingPack, type StoredBillingPackPrice, type StoredBillingPlan, type StoredBillingPrice } from "./billingCatalog";
import { desiredPolarCatalog, planPolarChanges, polarTags, type PolarStep, type PolarStepObject } from "./billingPolar";
import { polarProductVariableName } from "./billingPlans";
import type { DomainContext } from "./context";
import type { BillingProviderId } from "@lobbystack/providers/billing/types";
import { plannerFor, readBillingDeployment } from "./billingProvider";

// Verify compares the three copies of a brand's plans and packs two at a
// time, so a failure names the side that moved: the repository file (the
// reference), the Postgres tables and Polar. File and Polar agree exactly
// when an apply would make no Polar call, so that pair reuses the apply's own
// plan. Packs are named in what passes only when the file has some.

export type BillingCheckLevel = "ok" | "drift" | "warn" | "info";
export type BillingCheckResult = { code: BillingCheckCode; pair: BillingCheckPair; level: BillingCheckLevel; subject: string; message: string };
export type BillingVerifyStatus = "passed" | "drift" | "failed";
export type BillingVerifyResult = { status: BillingVerifyStatus; checks: BillingCheckResult[] };

export type BillingVerifyInput = {
  /** packs: the file's, absent or empty for a file without them. */
  file: { brand: string; hash: string; profile: Pick<BillingProfile, "currency" | "polar">; plans: readonly DesiredBillingPlan[]; packs?: readonly DesiredBillingPack[] };
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

/** The catalog's rows in the shape the apply's diffs read. An instance older than packs answers without them. */
function storedRows(catalog: ApiBillingCatalog): { plans: StoredBillingPlan[]; prices: StoredBillingPrice[]; packs: StoredBillingPack[]; packPrices: StoredBillingPackPrice[] } {
  const plans = catalog.plans.map(({ prices: _prices, ...plan }) => ({ ...plan, run_id: null }) as unknown as StoredBillingPlan);
  const prices = catalog.plans.flatMap((plan) => plan.prices.map((price) => ({ ...price, plan: plan.code, run_id: null }) as StoredBillingPrice));
  const packRows = catalog.packs ?? [];
  const packs = packRows.map(({ prices: _prices, ...pack }) => ({ ...pack, run_id: null }) as StoredBillingPack);
  const packPrices = packRows.flatMap((pack) => pack.prices.map((price) => ({ ...price, pack: pack.code, run_id: null }) as StoredBillingPackPrice));
  return { plans, prices, packs, packPrices };
}

const stepCodes: Record<PolarStepObject, BillingCheckCode> = { organization: "org_settings", meter: "meter", product: "product", discount: "discount", webhook: "webhook" };

function stepCode(step: Pick<PolarStep, "object" | "action" | "leftover">): BillingCheckCode {
  if (step.leftover) return "leftover";
  // Credits on a product are the Credits check's business.
  if (step.action === "detach") return "credits";
  return stepCodes[step.object];
}

export type AddBillingCheck = (code: BillingCheckCode, pair: BillingCheckPair, level: BillingCheckLevel, subject: string, message: string) => void;

/** How the file and Postgres checks name a provider and what links a price to it. */
export type BillingLinkWords = { provider: string; object: string; linkOf(price: ApiBillingCatalogPrice): string | null };

const polarLinkWords: BillingLinkWords = { provider: "Polar", object: "product", linkOf: (price) => price.polar_id };

/** File and Postgres, the same for every provider but for its words: the hashes, the rows an apply would write, and the links. */
export function fileAndPostgresChecks(input: { file: Pick<BillingVerifyInput["file"], "hash" | "plans" | "packs"> & { brand: string; profile: Pick<BillingProfile, "currency"> }; catalog: ApiBillingCatalog; now?: string }, add: AddBillingCheck, words: BillingLinkWords): void {
  const { file, catalog } = input;
  const rows = storedRows(catalog);
  const sold = file.plans.filter((plan) => plan.sold && plan.prices.length);
  const packs = file.packs ?? [];
  const now = input.now ?? new Date().toISOString();
  if (catalog.hash === file.hash) add("catalog_hash", "file_postgres", "ok", "catalog", `catalog ${short(file.hash)} applied`);
  else add("catalog_hash", "file_postgres", "drift", "catalog", `The latest catalog run is ${short(catalog.hash)} and the file is ${short(file.hash)}. Run pnpm billing apply.`);
  if (catalog.code_hash === file.hash) add("code_hash", "file_postgres", "ok", "code", "the deployed code was built with this file");
  else add("code_hash", "file_postgres", "warn", "code", catalog.code_hash ? `The deployed code was built with ${short(catalog.code_hash)}, not this file. Deploy the merged file.` : `The deployed code has no billing.json for ${file.brand}.`);
  const diff = diffBillingCatalog({ plans: [...file.plans], currency: file.profile.currency, current: rows, now });
  const packDiff = diffBillingPackCatalog({ packs, currency: file.profile.currency, current: rows, now });
  const writes = [...diff.writes, ...packDiff.writes];
  const refusals = [...diff.refusals, ...packDiff.refusals];
  for (const write of writes) add("plan_rows", "file_postgres", "drift", write.change.key, `${write.change.table} ${write.change.key} would be ${write.change.action === "update" ? `updated (${Object.keys(write.change.fields).join(", ")})` : `${write.change.action}d`} by an apply.`);
  for (const refusal of refusals) add("plan_rows", "file_postgres", "drift", refusal.path, refusal.message);
  const packRows = packs.length ? `, ${rows.packs.filter((pack) => pack.status !== "retired").length} packs, ${rows.packPrices.filter((price) => price.retired_at === null).length} live pack prices` : "";
  if (!writes.length && !refusals.length) add("plan_rows", "file_postgres", "ok", "rows", `${rows.plans.filter((plan) => plan.status !== "retired").length} plans, ${rows.prices.filter((price) => price.retired_at === null).length} live prices${packRows}`);
  let unlinked = 0;
  for (const plan of sold) {
    const row = catalog.plans.find((entry) => entry.code === plan.code);
    if (!row) continue;
    if (row.status !== "active") {
      unlinked += 1;
      add("not_linked", "file_postgres", "drift", plan.code, `${plan.code} is ${row.status}${row.status === "draft" ? `, so ${words.provider} doesn't sell it as the file says yet` : ""}. Run pnpm billing apply.`);
    }
    for (const price of row.prices.filter((entry) => entry.retired_at === null && words.linkOf(entry) === null)) {
      unlinked += 1;
      add("not_linked", "file_postgres", "drift", `${plan.code}/${price.period}`, `${plan.code} ${price.period} has no ${words.provider} ${words.object}. Run pnpm billing apply.`);
    }
  }
  // A pack is sold through the object its live price names, under provider_ref on every provider.
  for (const pack of packs) {
    const row = rows.packs.find((entry) => entry.code === pack.code);
    if (!row) continue;
    if (row.status !== "active") {
      unlinked += 1;
      add("not_linked", "file_postgres", "drift", pack.code, `Pack ${pack.code} is ${row.status}${row.status === "draft" ? `, so ${words.provider} doesn't sell it as the file says yet` : ""}. Run pnpm billing apply.`);
    }
    for (const price of rows.packPrices.filter((entry) => entry.pack === pack.code && entry.retired_at === null && entry.provider_ref === null)) {
      unlinked += 1;
      add("not_linked", "file_postgres", "drift", `${pack.code}/${price.currency}`, `Pack ${pack.code} has no ${words.provider} ${words.object}. Run pnpm billing apply.`);
    }
  }
  if (!unlinked) add("not_linked", "file_postgres", "ok", "links", `${sold.length} sold plans${packs.length ? ` and ${packs.length} packs` : ""} active and linked`);
}

/** Every check of section 7.1 of the step 2 design, ok ones included. Pure. */
export function verifyBillingCatalog(input: BillingVerifyInput): BillingVerifyResult {
  const { file, catalog } = input;
  const checks: BillingCheckResult[] = [];
  const add: AddBillingCheck = (code, pair, level, subject, message) => checks.push({ code, pair, level, subject, message });

  fileAndPostgresChecks({ file, catalog, ...(input.now ? { now: input.now } : {}) }, add, polarLinkWords);

  if ("error" in input.polar) {
    add("unreadable", "file_polar", "drift", "Polar", input.polar.error);
    return { status: "failed", checks };
  }
  const { snapshot, env } = input.polar;

  // File and Polar: everything an apply would still change.
  const desired = desiredPolarCatalog({ brand: file.brand, profile: file.profile, plans: file.plans, ...(file.packs ? { packs: file.packs } : {}), webhookUrl: input.webhookUrl });
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
  const packs = desired.packs.length;
  const okLines: Array<[BillingCheckCode, string]> = [
    ["org_settings", `currency ${desired.currency.toUpperCase()}, ${desired.settings.allowMultipleSubscriptions ? "several subscriptions" : "one subscription"} per customer, plan changes ${desired.settings.portalPlanChanges ? "on" : "off"} in the portal`],
    ["meter", `${desired.meters.length} meters`],
    ["credits", "no Credits on the products: the worker reports only each month's overage"],
    ["product", `${desired.products.length} products${packs ? ` and ${packs} one-time pack ${packs === 1 ? "product" : "products"}` : ""}, tagged and priced as the file says${desired.products.some((product) => product.meterInterval) ? ", annual ones invoicing overage each month" : ""}`],
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
  // A pack's product is one-time, tagged with the pack, with one fixed price.
  const packRows = catalog.packs ?? [];
  let packsLinked = 0;
  for (const row of packRows.filter((entry) => entry.status !== "retired")) {
    for (const price of row.prices.filter((entry) => entry.retired_at === null && entry.provider_ref !== null)) {
      packsLinked += 1;
      const subject = `${row.code}/${price.currency}`;
      const product = products.get(price.provider_ref!);
      const tags = product ? [product.metadata[polarTags.brand], product.metadata[polarTags.pack]] : [];
      const problem = !product ? "isn't in this Polar organization"
        : product.is_archived ? `is archived ("${product.name}")`
        : tags[0] !== file.brand || tags[1] !== row.code ? `is tagged ${tags.map((tag) => String(tag ?? "-")).join(" ")} ("${product.name}")`
        : product.recurring_interval !== null ? `bills every ${product.recurring_interval_count ?? 1} ${product.recurring_interval}, while a pack is paid once ("${product.name}")`
        : !product.prices.some((entry) => !entry.is_archived && entry.amount_type === "fixed" && entry.price_amount === price.cents && entry.price_currency.toLowerCase() === price.currency) ? `doesn't sell ${(price.cents / 100).toFixed(2)} ${price.currency.toUpperCase()} ("${product.name}")`
        : null;
      if (problem) {
        badLinks += 1;
        add("linked_id", "postgres_polar", "drift", subject, `Pack ${subject} is linked to product ${price.provider_ref}, which ${problem}.`);
      }
    }
  }
  if (!badLinks) add("linked_id", "postgres_polar", "ok", "links", `${linked} products${packs ? ` and ${packsLinked} pack ${packsLinked === 1 ? "product" : "products"}` : ""} linked, all live, tagged and priced as the rows say`);
  for (const row of catalog.plans) {
    for (const price of row.prices.filter((entry) => entry.retired_at !== null && entry.polar_id !== null)) {
      if (!products.has(price.polar_id!)) add("retired_id", "postgres_polar", "info", `${row.code}/${price.period}`, `The retired ${row.code} ${price.period} price's product ${price.polar_id} isn't in Polar any more.`);
    }
  }
  for (const row of packRows) {
    for (const price of row.prices.filter((entry) => entry.retired_at !== null && entry.provider_ref !== null)) {
      if (!products.has(price.provider_ref!)) add("retired_id", "postgres_polar", "info", `${row.code}/${price.currency}`, `The retired pack ${row.code} ${price.currency} price's product ${price.provider_ref} isn't in Polar any more.`);
    }
  }
  // A deployment that isn't on Polar has no Polar settings: the check then finds no organization.
  const instance = catalog.polar ?? { env: "production" as const, org: null, secret_sha256: null, product_vars: {}, last_link: null };
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

const pairTitles: Record<BillingCheckPair, string> = { file_postgres: "File and Postgres", file_polar: "File and Polar", postgres_polar: "Postgres and Polar", file_provider: "File and the provider", postgres_provider: "Postgres and the provider" };
const levelLabels: Record<BillingCheckLevel, string> = { ok: "ok    ", drift: "DRIFT ", warn: "warn  ", info: "info  " };

/** The report pnpm billing prints, one line per check under its pair; provider names the one a Stripe deployment's pairs compare with. */
export function billingVerifyReport(result: BillingVerifyResult, heading: string, provider?: string): string {
  const lines = [heading];
  const titles: Record<BillingCheckPair, string> = provider ? { ...pairTitles, file_provider: `File and ${provider}`, postgres_provider: `Postgres and ${provider}` } : pairTitles;
  for (const pair of Object.keys(titles) as BillingCheckPair[]) {
    const checks = result.checks.filter((check) => check.pair === pair);
    if (!checks.length) continue;
    lines.push("", titles[pair], ...checks.map((check) => `  ${levelLabels[check.level]} ${check.level === "ok" ? check.message : `${check.code}: ${check.message}`}`));
  }
  const unreadable = provider ? `${provider} couldn't be read: check the key's permissions and run again.` : "Polar couldn't be read: check the token's scopes and run again.";
  const ending = result.status === "passed" ? "Result: in sync (exit 0)." : result.status === "drift" ? "Result: drift (exit 1). Run pnpm billing apply, or change billing.json in a pull request." : `Result: failed (exit 2). ${unreadable}`;
  lines.push("", ending);
  return lines.join("\n");
}

export type DailyBillingVerifyInput = {
  brand: string;
  env: Record<string, string | undefined>;
  /** Reads the worker's Polar organization with its own token, webhooks left out. */
  readPolar?(): Promise<PolarSnapshot>;
  /** Reads the worker's Stripe account with its own key, endpoints left out. */
  readStripe?(): Promise<StripeSnapshot>;
};

export type DailyBillingVerifyOutcome =
  | { status: "skipped"; reason: string }
  /** polarEnv is Polar's server, null on another provider. */
  | { status: BillingVerifyStatus; previousStatus: string | null; problems: ApiBillingCheck[]; polarEnv: PolarEnv | null; provider: BillingProviderId; providerEnv: BillingProviderEnv; runId: string };

/**
 * The worker's daily check: every check but the webhook's, against the
 * profile stored on the latest catalog run. Polar lists the webhook with its
 * signing secret, so the worker's token goes without webhooks:read, and
 * pnpm billing verify checks the webhook; on Stripe it checks the endpoint and
 * the meter error destination too. Skipped until the deployment has its
 * provider's account and a first link.
 */
export async function runDailyBillingVerify(context: DomainContext, input: DailyBillingVerifyInput): Promise<DailyBillingVerifyOutcome> {
  const deployment = readBillingDeployment(input.env, { withSecret: false });
  if (!deployment.account) return { status: "skipped", reason: deployment.provider === "stripe" ? "STRIPE_ACCOUNT_ID isn't set" : "POLAR_ORGANIZATION_ID isn't set" };
  const catalog = await getBillingCatalogForApi(context, { deployment: billingCatalogDeployment(input.brand, input.env, { withSecret: false }) });
  const latest = catalog.last_run;
  if (!latest || !catalog.profile || !catalog.provider.last_link) return { status: "skipped", reason: "nothing was linked yet" };
  // A profile stored before packs took a plan's fields reads in today's shape, with the same rows.
  const parsed = billingProfileSchema.safeParse(upgradeStoredBillingProfile(catalog.profile));
  if (!parsed.success) throw new Error(`The profile stored on catalog run ${latest.id} no longer passes billingProfileSchema.`);
  const sells = billingProfileForProvider(parsed.data, deployment.provider);
  const file = { brand: latest.brand, hash: latest.hash, profile: parsed.data, plans: desiredBillingPlans(sells), packs: desiredBillingPacks(sells) };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let result: BillingVerifyResult;
  if (deployment.stripe) {
    if (!input.readStripe) return { status: "skipped", reason: "the worker has no Stripe key" };
    const env = deployment.stripe.env;
    let stripe: { env: BillingProviderEnv; snapshot: StripeSnapshot } | { env: BillingProviderEnv; error: string };
    try {
      stripe = { env, snapshot: await input.readStripe() };
    } catch (error) {
      stripe = { env, error: message(error) };
    }
    result = plannerFor("stripe").verify({ file, catalog, stripe, webhookUrl: null, checkWebhookSecret: false });
  } else {
    if (!input.readPolar) return { status: "skipped", reason: "the worker has no Polar token" };
    const env = deployment.polar!.env;
    let polar: { env: PolarEnv; snapshot: PolarSnapshot } | { env: PolarEnv; error: string };
    try {
      polar = { env, snapshot: await input.readPolar() };
    } catch (error) {
      polar = { env, error: message(error) };
    }
    result = plannerFor("polar").verify({ file, catalog, polar, webhookUrl: null, checkWebhookSecret: false });
  }
  const problems = billingProblems(result.checks);
  const recorded = await recordBillingVerifyRun(context, { catalog: { brand: latest.brand, ver: latest.ver, hash: latest.hash }, codeHash: catalog.code_hash, status: result.status, problems, provider: deployment.provider, providerEnv: deployment.providerEnv, providerAccount: deployment.account });
  return { status: result.status, previousStatus: recorded.previousStatus, problems, polarEnv: deployment.polar?.env ?? null, provider: deployment.provider, providerEnv: deployment.providerEnv, runId: recorded.run.id! };
}
