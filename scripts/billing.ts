// pnpm billing plan|apply|verify: takes a brand's billing.json to the
// deployment's tables and to its Polar organization, links the two and checks
// all three (sections 6 and 7 of the billing step 2 design).
//
//   pnpm billing plan   --brand alloplace --polar sandbox [--profile <name>] [--json], and apply's other flags
//   pnpm billing apply  --brand alloplace --polar sandbox [--profile <name>] [--adopt] [--yes]
//                       [--allow-replace] [--allow-archive] [--allow-less] [--allow-undeployed]
//                       [--webhook-url <url>] [--railway-file <new file>]
//   pnpm billing verify --brand alloplace --polar sandbox [--profile <name>] [--webhook-url <url>] [--json]
//
// The instance and its operator key come from a `lobbystack login` profile,
// or LOBBYSTACK_URL and LOBBYSTACK_API_KEY. apply needs a Polar setup token
// (POLAR_SETUP_TOKEN); plan and verify a read token (POLAR_READ_TOKEN, else the
// setup token). Without one it asks, with typing hidden. It never stores or
// prints a token. Exit codes: 0 in sync, 1 a refusal or drift, 2 a side that
// couldn't be read or a write that failed.

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { createClient, type Client } from "../packages/cli/src/client";
import { configPath, readConfig, resolveConnection } from "../packages/cli/src/config";
import { ApiError, CliError } from "../packages/cli/src/errors";
import { desiredBillingPlans } from "../packages/domain/src/server/billingCatalog";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans, runPolarSteps, POLAR_WEBHOOK_PATH, type PolarPlanOptions, type PolarRefusal, type PolarStep } from "../packages/domain/src/server/billingPolar";
import { billingVerifyReport, verifyBillingCatalog, type BillingVerifyResult } from "../packages/domain/src/server/billingVerify";
import { PolarCatalogClient, type PolarSnapshot } from "../packages/providers/src/polar/polarCatalog";
import { billingProfileSchema, canonicalBillingProfileJson, polarBaseUrls, type ApiBillingCatalog, type ApiBillingCatalogChange, type ApiBillingCatalogRefusal, type BillingProfile, type PolarEnv } from "../packages/shared/src/index";

export type BillingIo = {
  env: NodeJS.ProcessEnv;
  /** The checkout whose brands/ folder holds the file. */
  root: string;
  out(text: string): void;
  err(text: string): void;
  /** Asks a question at the terminal. Left out where no one can answer, as in a pipeline. */
  ask?(question: string, options: { hidden: boolean }): Promise<string>;
  /** For both the instance and Polar, in tests. */
  fetch?: typeof fetch;
};

const USAGE = [
  "Usage:",
  "  pnpm billing plan   --brand <brand> --polar sandbox|live [--profile <name>] [--json] and apply's flags but --yes and --railway-file",
  "  pnpm billing apply  --brand <brand> --polar sandbox|live [--profile <name>] [--adopt] [--yes]",
  "                      [--allow-replace] [--allow-archive] [--allow-less] [--allow-undeployed]",
  "                      [--webhook-url <url>] [--railway-file <new file>]",
  "  pnpm billing verify --brand <brand> --polar sandbox|live [--profile <name>] [--webhook-url <url>] [--json]",
].join("\n");

const exit = { ok: 0, drift: 1, failed: 2 } as const;

/** Something that stops the run before it changes anything, or a drift it found: exit 1. */
class Refused extends Error {
  constructor(readonly reasons: string[], readonly heading = "Refused, so nothing changed:") {
    super(reasons.join("\n"));
  }
}

/** A wrong command or a missing input: exit 2 with the usage. */
class Usage extends Error {}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const short = (hash: string | null | undefined) => (hash ? hash.slice(0, 12) : "none");
const polarWord = (env: PolarEnv) => (env === "production" ? "live" : "sandbox");

type Options = {
  command: "plan" | "apply" | "verify";
  brand: string;
  polar: PolarEnv;
  profile: string | undefined;
  json: boolean;
  yes: boolean;
  allowUndeployed: boolean;
  webhookUrl: string | undefined;
  railwayFile: string | undefined;
  plan: PolarPlanOptions;
};

function parse(argv: string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        brand: { type: "string" },
        polar: { type: "string" },
        profile: { type: "string" },
        adopt: { type: "boolean" },
        yes: { type: "boolean" },
        json: { type: "boolean" },
        "allow-replace": { type: "boolean" },
        "allow-archive": { type: "boolean" },
        "allow-less": { type: "boolean" },
        "allow-undeployed": { type: "boolean" },
        "webhook-url": { type: "string" },
        "railway-file": { type: "string" },
      },
    });
  } catch (error) {
    throw new Usage((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...extra] = positionals;
  if (command !== "plan" && command !== "apply" && command !== "verify") throw new Usage(command ? `There's no billing command ${command}.` : "Name a command: plan, apply or verify.");
  if (extra.length) throw new Usage(`Unexpected ${extra.join(" ")}.`);
  if (!values.brand || !/^[a-z0-9-]+$/.test(values.brand)) throw new Usage("--brand names a folder of brands/, such as alloplace.");
  if (values.polar !== "sandbox" && values.polar !== "live") throw new Usage("--polar is sandbox or live.");
  // A plan takes apply's flags but --yes and --railway-file, so it shows what that apply would do.
  const misplaced = (names: ReadonlyArray<keyof typeof values>) => names.filter((name) => values[name] !== undefined).map((name) => `--${String(name)}`).join(", ");
  if (command !== "apply" && misplaced(["yes", "railway-file"])) throw new Usage(`${misplaced(["yes", "railway-file"])} only goes with apply.`);
  if (command === "verify" && misplaced(["adopt", "allow-replace", "allow-archive", "allow-less", "allow-undeployed"])) throw new Usage(`${misplaced(["adopt", "allow-replace", "allow-archive", "allow-less", "allow-undeployed"])} only goes with plan and apply.`);
  if (command === "apply" && values.json) throw new Usage("--json only goes with plan and verify.");
  if (values["webhook-url"] !== undefined) {
    let url: URL;
    try {
      url = new URL(values["webhook-url"]);
    } catch {
      throw new Usage("--webhook-url must be a whole address, such as https://demo.alloplace.com/api/webhooks/polar.");
    }
    if (url.protocol !== "https:") throw new Usage("--webhook-url must start with https://, as Polar only calls https addresses.");
  }
  return {
    command,
    brand: values.brand,
    polar: values.polar === "live" ? "production" : "sandbox",
    profile: values.profile,
    json: values.json === true,
    yes: values.yes === true,
    allowUndeployed: values["allow-undeployed"] === true,
    webhookUrl: values["webhook-url"],
    railwayFile: values["railway-file"],
    plan: { adopt: values.adopt === true, allowReplace: values["allow-replace"] === true, allowArchive: values["allow-archive"] === true, allowLess: values["allow-less"] === true },
  };
}

type BillingFile = { json: unknown; profile: BillingProfile; hash: string; plans: ReturnType<typeof desiredBillingPlans> };

async function readBillingFile(root: string, brand: string): Promise<BillingFile> {
  const path = join(root, "brands", brand, "billing.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Usage(`There's no brands/${brand}/billing.json in this checkout.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Usage(`brands/${brand}/billing.json isn't JSON: ${(error as Error).message}`);
  }
  const parsed = billingProfileSchema.safeParse(json);
  if (!parsed.success) throw new Usage(`brands/${brand}/billing.json doesn't pass the schema: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ")}`);
  return { json, profile: parsed.data, hash: sha256(canonicalBillingProfileJson(parsed.data)), plans: desiredBillingPlans(parsed.data) };
}

async function polarToken(options: Options, io: BillingIo): Promise<string> {
  const setup = io.env.POLAR_SETUP_TOKEN?.trim();
  const token = options.command === "apply" ? setup : io.env.POLAR_READ_TOKEN?.trim() || setup;
  if (token) return token;
  const kind = options.command === "apply" ? "setup" : "read";
  if (!io.ask) throw new Usage(`Set POLAR_${kind.toUpperCase()}_TOKEN to a Polar ${kind} token.`);
  const typed = (await io.ask(`Polar ${polarWord(options.polar)} ${kind} token (typing is hidden): `, { hidden: true })).trim();
  if (!typed) throw new Usage("No Polar token was given.");
  return typed;
}

function changeLine(change: ApiBillingCatalogChange): string {
  const fields = Object.keys(change.fields);
  const warns = [change.lowers_allowance ? "lowers an allowance" : "", change.raises_price ? "raises a price" : ""].filter(Boolean);
  return `  ${change.action} ${change.table} ${change.key}${fields.length ? ` (${fields.join(", ")})` : ""}${warns.length ? `: ${warns.join(", ")}` : ""}`;
}

const stepLine = (step: Pick<PolarStep, "action" | "subject" | "changes" | "object">) => `  ${step.action} ${step.subject}${step.changes.length ? `: ${step.changes.join("; ")}` : ""}`;
const refusalLine = (refusal: PolarRefusal) => `${refusal.subject}: ${refusal.message}`;
const apiRefusalLine = (refusal: Pick<ApiBillingCatalogRefusal, "code" | "path" | "message">) => `${refusal.code} (${refusal.path}): ${refusal.message}`;

/** The checks of step 2 of an apply: the instance, its Polar organization and its code must be the ones this run is for. */
function preflight(options: Options, file: BillingFile, catalog: ApiBillingCatalog, snapshot: PolarSnapshot): string[] {
  const reasons: string[] = [];
  const org = snapshot.organization;
  const word = polarWord(options.polar);
  if (catalog.brand !== options.brand) reasons.push(`The instance shows the ${catalog.brand} brand, not ${options.brand}.`);
  if (catalog.polar.org === null) reasons.push(`The instance has no POLAR_ORGANIZATION_ID. Set it to ${org.id}, and POLAR_API_BASE_URL to ${polarBaseUrls[options.polar]}, on lobbystack-admin and worker, redeploy, then run again.`);
  else if (catalog.polar.env !== options.polar || catalog.polar.org !== org.id) reasons.push(`The instance uses Polar ${polarWord(catalog.polar.env)} organization ${catalog.polar.org}, and the token reaches ${word} organization ${org.name} (${org.id}). Use a token for the instance's organization.`);
  const link = catalog.polar.last_link;
  if (link && (link.polar_env !== options.polar || link.polar_org !== org.id)) reasons.push(`The instance was linked to Polar ${polarWord(link.polar_env ?? "production")} organization ${String(link.polar_org)}, and it stays with it. Live payments get a deployment of their own.`);
  if (!options.allowUndeployed && catalog.code_hash !== file.hash) reasons.push(catalog.code_hash ? `The instance's code was built with billing.json ${short(catalog.code_hash)}, and this checkout's is ${short(file.hash)}. Deploy the merged file first, or add --allow-undeployed to try it on a sandbox.` : `The instance's code has no billing.json for ${options.brand}. Deploy it first, or add --allow-undeployed to try it on a sandbox.`);
  return reasons;
}

// No product IDs: checkout sells the products the links name, so the four
// POLAR_*_PRODUCT_ID variables aren't needed.
function railwayText(options: Options, organizationId: string, webhookSecret: string | null, today: string): string {
  const shown = /\s/.test(options.railwayFile!) ? `"${options.railwayFile}"` : options.railwayFile!;
  return [
    `# Railway variables from pnpm billing apply --brand ${options.brand} (Polar ${polarWord(options.polar)}), ${today}.`,
    `# Set them with: node railway-vars.mjs ${shown}`,
    "# Each [...] line names Railway services; change it if yours are named differently.",
    ...(webhookSecret ? ["# It holds the webhook secret, so delete it once Railway has the values."] : []),
    "",
    "[lobbystack-admin, worker]",
    `POLAR_API_BASE_URL=${polarBaseUrls[options.polar]}`,
    `POLAR_ORGANIZATION_ID=${organizationId}`,
    ...(webhookSecret ? ["", "[lobbystack-admin]", `POLAR_WEBHOOK_SECRET=${webhookSecret}`] : []),
    "",
  ].join("\n");
}

/** Writes the --railway-file, or says where the secret of a webhook this run made is. */
async function saveRailwayValues(options: Options, io: BillingIo, organizationId: string, webhookSecret: string | null): Promise<void> {
  if (options.railwayFile) {
    await writeFile(options.railwayFile, railwayText(options, organizationId, webhookSecret, new Date().toISOString().slice(0, 10)), { flag: "wx", mode: 0o600 });
    io.out(`\nSaved the Railway variables to ${options.railwayFile}. Set them with: node railway-vars.mjs ${options.railwayFile}`);
  } else if (webhookSecret) {
    io.out("\nPolar made the webhook just now. Copy its secret from the webhook's page in Polar to POLAR_WEBHOOK_SECRET on lobbystack-admin, or run again with --railway-file next time.");
  }
}

const verifyExit = (result: BillingVerifyResult) => (result.status === "passed" ? exit.ok : result.status === "drift" ? exit.drift : exit.failed);

async function verifyCommand(options: Options, io: BillingIo, input: { file: BillingFile; api: Client; polar: PolarCatalogClient; url: string; webhookUrl: string }): Promise<number> {
  const catalog = (await input.api.call("getBillingCatalog")).data;
  if (catalog.brand !== options.brand) throw new Refused([`The instance shows the ${catalog.brand} brand, not ${options.brand}.`]);
  let polar: { env: PolarEnv; snapshot: PolarSnapshot } | { env: PolarEnv; error: string };
  try {
    polar = { env: options.polar, snapshot: await input.polar.readSnapshot() };
  } catch (error) {
    polar = { env: options.polar, error: (error as Error).message };
  }
  const result = verifyBillingCatalog({ file: { brand: options.brand, hash: input.file.hash, profile: input.file.profile, plans: input.file.plans }, catalog, polar, webhookUrl: input.webhookUrl, checkWebhookSecret: true });
  if (options.json) io.out(JSON.stringify({ status: result.status, checks: result.checks }, null, 2));
  else io.out(billingVerifyReport(result, `${options.brand} billing.json v${input.file.profile.version} (${short(input.file.hash)}) against Polar ${polarWord(options.polar)} and ${input.url}`));
  return verifyExit(result);
}

async function planOrApply(options: Options, io: BillingIo, input: { file: BillingFile; api: Client; polar: PolarCatalogClient; url: string; webhookUrl: string }): Promise<number> {
  const { file, api, polar } = input;
  // Steps 1 to 4: the file, the instance and Polar as they are.
  const catalog = (await api.call("getBillingCatalog")).data;
  const snapshot = await polar.readSnapshot();
  const org = snapshot.organization;
  const reasons = preflight(options, file, catalog, snapshot);
  let catalogChanges: ApiBillingCatalogChange[] = [];
  let catalogChanged = catalog.hash !== file.hash;
  if (catalog.brand === options.brand) {
    // An applied file too: new code can resolve the same file to other rows. The undeployed check is the preflight's, so the dry run leaves it out.
    const preview = (await api.call("applyBillingCatalog", { body: { brand: options.brand, billing_file: file.profile, replaces_hash: catalog.hash, allow_undeployed: true, dry_run: true } })).data;
    catalogChanges = preview.changes;
    catalogChanged ||= catalogChanges.length > 0;
    reasons.push(...preview.blocked_by.map(apiRefusalLine));
  }
  const desired = desiredPolarCatalog({ brand: options.brand, profile: file.profile, plans: file.plans, webhookUrl: input.webhookUrl });
  const polarPlan = planPolarChanges({ catalog: desired, snapshot, options: options.plan });
  reasons.push(...polarPlan.refusals.map(refusalLine));
  const sold = file.plans.filter((plan) => plan.sold && plan.prices.length);
  const linkCount = sold.reduce((total, plan) => total + plan.prices.length, 0);

  // Step 5: the plan.
  if (options.json) {
    io.out(JSON.stringify({
      brand: options.brand,
      hash: file.hash,
      instance: input.url,
      polar: { env: polarWord(options.polar), organization: org.id },
      catalog: catalogChanges,
      steps: polarPlan.steps.map(({ object, action, subject, changes, leftover }) => ({ object, action, subject, changes, ...(leftover ? { leftover } : {}) })),
      links: { plans: sold.length, prices: linkCount },
      refusals: reasons,
    }, null, 2));
  } else {
    io.out(`${options.brand} billing.json v${file.profile.version} (${short(file.hash)}) to ${input.url} and Polar ${polarWord(options.polar)} organization ${org.name} (${org.id})`);
    io.out("");
    io.out(catalogChanged ? `Postgres: ${catalogChanges.length} ${catalogChanges.length === 1 ? "change" : "changes"}${catalogChanges.length ? "" : ", only the file's hash"}` : "Postgres: the file is applied");
    for (const change of catalogChanges) io.out(changeLine(change));
    io.out(polarPlan.steps.length ? `Polar: ${polarPlan.steps.length} ${polarPlan.steps.length === 1 ? "call" : "calls"}` : "Polar: sells what the file says");
    for (const step of polarPlan.steps) io.out(stepLine(step));
    io.out(`Links: ${linkCount} live prices of ${sold.length} sold plans, written once Polar sells what the file says`);
  }
  if (reasons.length) throw new Refused(reasons);
  if (options.command === "plan") {
    if (!options.json) io.out("\nThis was a plan, so nothing changed. Run pnpm billing apply with the same flags to make these changes.");
    return exit.ok;
  }

  // Step 6: confirm.
  if (!options.yes) {
    if (!io.ask) throw new Usage("Add --yes to apply without a question.");
    const answer = (await io.ask(`\nApply these to ${input.url} and Polar ${polarWord(options.polar)} organization ${org.name}? Type yes to continue: `, { hidden: false })).trim().toLowerCase();
    if (answer !== "yes") {
      io.out("Nothing changed.");
      return exit.drift;
    }
  }

  // Step 7: the catalog.
  if (catalogChanged) {
    const run = (await api.call("applyBillingCatalog", { body: { brand: options.brand, billing_file: file.profile, replaces_hash: catalog.hash, allow_undeployed: true }, idempotencyKey: randomUUID() })).data;
    io.out(`\nPostgres: ${run.status === "unchanged" ? "the tables already matched" : `applied ${run.changes.length} ${run.changes.length === 1 ? "change" : "changes"}`} in run ${String(run.id)}.`);
  }

  // Step 8: Polar.
  if (polarPlan.steps.length) io.out("\nPolar:");
  const made: { webhookSecret: string | null } = { webhookSecret: null };
  try {
    await runPolarSteps(polar, polarPlan.steps, (step, secret) => {
      made.webhookSecret ??= secret;
      io.out(`  done ${stepLine(step).trimStart()}`);
    });
  } catch (error) {
    // A webhook made before the call that failed: the next run finds it and gets no secret, so this one is saved first.
    if (made.webhookSecret) await saveRailwayValues(options, io, org.id, made.webhookSecret);
    throw error;
  }
  // The Railway values as soon as Polar is set up, so a refusal or drift after this doesn't lose them.
  await saveRailwayValues(options, io, org.id, made.webhookSecret);

  // Step 9: Polar against the file, before anything is linked.
  const after = await polar.readSnapshot();
  const check = planPolarChanges({ catalog: desired, snapshot: after, options: { adopt: false, allowReplace: true, allowArchive: true, allowLess: true } });
  if (check.steps.length || check.refusals.length) throw new Refused([...check.steps.map((step) => stepLine(step).trimStart()), ...check.refusals.map(refusalLine)], "Polar still differs from the file, so nothing was linked. Run again:");

  // Step 10: the links.
  const links = polarLinkPlans({ catalog: desired, plans: file.plans, snapshot: after });
  if (links.missing.length) throw new Refused(links.missing, "Polar has no single object for these, so nothing was linked:");
  const link = (await api.call("linkBillingCatalog", { body: { brand: options.brand, hash: file.hash, polar_env: options.polar, polar_org: after.organization.id, plans: links.plans, ...(options.plan.allowReplace ? { replace_ids: true } : {}) }, idempotencyKey: randomUUID() })).data;
  io.out(`\nLinks: ${link.status === "unchanged" ? "already recorded" : `recorded ${link.changes.length} ${link.changes.length === 1 ? "change" : "changes"}`} in run ${String(link.id)}.`);

  // Step 11: all three pairs.
  const result = verifyBillingCatalog({ file: { brand: options.brand, hash: file.hash, profile: file.profile, plans: file.plans }, catalog: (await api.call("getBillingCatalog")).data, polar: { env: options.polar, snapshot: after }, webhookUrl: input.webhookUrl, checkWebhookSecret: true });
  io.out("");
  io.out(billingVerifyReport(result, `${options.brand} billing.json v${file.profile.version} (${short(file.hash)}) against Polar ${polarWord(options.polar)} and ${input.url}`));
  return verifyExit(result);
}

/** Runs one command and returns its exit code. Never throws. */
export async function runBilling(argv: string[], io: BillingIo): Promise<number> {
  let options: Options;
  try {
    options = parse(argv);
    if (options.railwayFile && (await stat(options.railwayFile).then(() => true, () => false))) throw new Usage(`${options.railwayFile} already exists. Name a new file, or delete that one first.`);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return exit.failed;
  }
  try {
    const file = await readBillingFile(io.root, options.brand);
    const connection = resolveConnection(await readConfig(configPath(io.env)), io.env, { profile: options.profile });
    const api = createClient({ url: connection.url, key: connection.key, userAgent: "lobbystack-billing", ...(io.fetch ? { fetch: io.fetch } : {}) });
    const polar = new PolarCatalogClient({ token: await polarToken(options, io), baseUrl: polarBaseUrls[options.polar], ...(io.fetch ? { fetch: io.fetch } : {}) });
    const webhookUrl = options.webhookUrl ?? `${new URL(connection.url).origin}${POLAR_WEBHOOK_PATH}`;
    const input = { file, api, polar, url: connection.url, webhookUrl };
    return options.command === "verify" ? await verifyCommand(options, io, input) : await planOrApply(options, io, input);
  } catch (error) {
    if (error instanceof Refused) {
      io.err(`\n${error.heading}\n${error.reasons.map((reason) => `  ${reason}`).join("\n")}`);
      return exit.drift;
    }
    if (error instanceof Usage) {
      io.err(error.message);
      return exit.failed;
    }
    if (error instanceof ApiError) {
      // A 409 is the instance refusing, with each reason in details.
      const details = error.details.map((detail) => `  ${(detail as { code?: string }).code ?? "refused"} (${detail.path}): ${detail.message}`);
      io.err(`\n${error.message}${details.length ? `\n${details.join("\n")}` : ""}`);
      return error.status === 409 ? exit.drift : exit.failed;
    }
    io.err(`\n${error instanceof CliError || error instanceof Error ? error.message : String(error)}`);
    return exit.failed;
  }
}

/** The terminal's question, with what's typed hidden when asked. */
function ask(question: string, options: { hidden: boolean }): Promise<string> {
  return new Promise((resolveAnswer) => {
    const terminal = process.stdin.isTTY === true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
    let muted = false;
    if (options.hidden && terminal) {
      // Show the question, then hide what's typed; a redraw keeps only the question.
      (rl as unknown as { _writeToOutput(text: string): void })._writeToOutput = (text: string) => {
        if (!muted) process.stdout.write(text);
        else if (text.startsWith(question)) process.stdout.write(question);
      };
    }
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\nStopped.\n");
      process.exit(130);
    });
    rl.question(question, (answer) => {
      rl.close();
      if (muted) process.stdout.write("\n");
      resolveAnswer(answer);
    });
    muted = options.hidden && terminal;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const code = await runBilling(process.argv.slice(2), {
    env: process.env,
    root,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    ...(process.stdin.isTTY ? { ask } : {}),
  });
  process.exitCode = code;
}
