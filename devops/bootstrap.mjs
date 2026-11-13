#!/usr/bin/env node
// bootstrap.mjs: sets up one LobbyStack environment on Railway, with its outside services,
// from one small settings file. It does in one run what parts 3 and 4 of the deployment guide
// (docs/deployment/guide) do by hand, except the few steps that only a person can do, for which
// it stops and says what to do. "guide 3.2" and the like in its messages are that guide's sections.
//
//   node devops/bootstrap.mjs init <name>              writes .env.bootstrap-<name> and its .secrets file
//   node devops/bootstrap.mjs up <settings file>       sets everything up, then deploys
//   node devops/bootstrap.mjs connect <settings file>  the steps once the address works
//   node devops/bootstrap.mjs status <settings file>   what's done and what's left
//   node devops/bootstrap.mjs doctor <settings file>   checks settings, tools and tokens; changes nothing
//   node devops/bootstrap.mjs redo <settings file> <step>   runs a finished step again next time
//   node devops/bootstrap.mjs template <settings file> makes a private Railway template of the
//                                                      layout, which up then deploys (RAILWAY_TEMPLATE)
// Options: --dry-run (show the steps, call nothing), --yes (don't stop at questions or pauses),
//          --verbose (show each API call), --secrets <file> (read keys from that file instead
//          of <settings file>.secrets)
//
// Every step can run again safely: it finds what an earlier run made, by the ID it recorded or
// else by name, and reuses or updates it. Names come from APP_BASE_URL's address, else NAME, and
// are recorded the first time, so later changes to either rename nothing. Keys a provider shows
// only once (OpenAI's, Resend's) are read back from Railway
// when they got there; otherwise the script asks before replacing them. Each run appends to
// <settings file>.log, with secrets replaced by ‹hidden›.
//
// Each step is recorded in .env.bootstrap-<name>.state.json, beside the settings file, as
// soon as it succeeds, so a run that stops is finished by running the same command again.
// That file holds every secret the run made or was given: Git ignores it (.env.*), never
// commit or share it, and copy its secrets to the password manager. The script never prints
// a secret.
//
// It needs Node.js 18 or later and nothing installed. The Railway CLI is used for one step
// only, the bucket; without it, the script asks you to make the bucket in the dashboard.
// Keys and tokens come from the environment, then from the secrets file, then a hidden prompt.
// The secrets file is <settings file>.secrets (init writes one to fill in), or the file given
// with --secrets, which may also be a railway-vars.mjs variable file such as .env.realinfobot.
// A key given there for something the script would create, such as OPENAI_API_KEY or
// TWILIO_ACCOUNT_SID, is used instead of creating a new one. The tokens it needs:
//   RAILWAY_API_TOKEN       a Railway account or workspace token (railway.com/account/tokens)
//   OPENAI_ADMIN_KEY        an OpenAI admin key (platform.openai.com/settings/organization/admin-keys)
//   TWILIO_MAIN_ACCOUNT_SID, TWILIO_MAIN_AUTH_TOKEN   the main Twilio account, which owns the subaccounts
//   RESEND_ADMIN_KEY        a Resend key with full access, only to make the domain and the sending key
//   CLOUDFLARE_API_TOKEN    Zone DNS edit on the zone, and Turnstile Sites write on the account
// In cloud mode with Polar, connect also runs pnpm billing, with the deployment's own Polar token when Polar lets
// that token set plans up (made with the setup scopes too). Else it asks for a short-lived Polar setup token
// (POLAR_SETUP_TOKEN), which it keeps only in memory.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const URLS = {
  railway: process.env.BOOTSTRAP_RAILWAY_URL ?? "https://backboard.railway.com/graphql/v2",
  openai: process.env.BOOTSTRAP_OPENAI_URL ?? "https://api.openai.com/v1",
  twilio: process.env.BOOTSTRAP_TWILIO_URL ?? "https://api.twilio.com/2010-04-01",
  trunking: process.env.BOOTSTRAP_TRUNKING_URL ?? "https://trunking.twilio.com/v1",
  resend: process.env.BOOTSTRAP_RESEND_URL ?? "https://api.resend.com",
  cloudflare: process.env.BOOTSTRAP_CLOUDFLARE_URL ?? "https://api.cloudflare.com/client/v4",
  stripe: process.env.BOOTSTRAP_STRIPE_URL ?? "https://api.stripe.com/v1",
  // Polar's sandbox and live are separate servers (POLAR_SERVERS), so this one only replaces both in tests.
  polar: process.env.BOOTSTRAP_POLAR_URL ?? null,
};
// The BOOTSTRAP_*_URL variables, BOOTSTRAP_APP_URL and BOOTSTRAP_RAILWAY_CLI exist for tests against stand-ins.
const RAILWAY_CLI = process.env.BOOTSTRAP_RAILWAY_CLI ?? "railway";
const POLAR_SERVERS = { sandbox: "https://sandbox-api.polar.sh", live: "https://api.polar.sh" };
// The version pnpm billing asks Polar for (POLAR_API_VERSION in packages/shared/src/billing.ts), so lists come back alike.
const POLAR_API_VERSION = "2026-10";
const POLAR_WEBHOOK_PATH = "/api/webhooks/polar";
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * On Windows, pnpm and the Railway CLI are .cmd files that only start through the shell, and the shell splits
 * arguments on spaces, so each argument is quoted and the whole line goes to the shell as one string (an argument
 * list with shell: true would also print Node's DEP0190 warning).
 */
const shellLine = (command, args) => [command, ...args].map((arg) => (/^[\w@+=:,./\\-]+$/.test(String(arg)) ? String(arg) : `"${String(arg).replace(/"/g, '""')}"`)).join(" ");

/** Runs a command-line tool and returns spawnSync's result. */
function runTool(command, args, options = {}) {
  if (process.platform !== "win32") return spawnSync(command, args, { encoding: "utf8", ...options });
  return spawnSync(shellLine(command, args), { encoding: "utf8", ...options, shell: true });
}

/**
 * Runs a tool whose output the person reads as it comes, such as pnpm billing: each line it prints goes through
 * console, so the log gets it too, with secrets hidden. It gets no input, so a question it would ask stops it instead
 * of waiting. Resolves to { status, output }, status null when it couldn't start.
 */
function runToolLive(command, args, options = {}) {
  const settings = { ...options, stdio: ["ignore", "pipe", "pipe"] };
  const child = process.platform === "win32" ? spawn(shellLine(command, args), { ...settings, shell: true }) : spawn(command, args, settings);
  let output = "";
  const forward = (stream) => {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      const lines = `${rest}${chunk}`.split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) console.log(`    ${line}`);
    });
    stream.on("end", () => rest && console.log(`    ${rest}`));
  };
  forward(child.stdout);
  forward(child.stderr);
  return new Promise((resolve) => {
    child.on("error", (error) => resolve({ status: null, error, output }));
    child.on("close", (status) => resolve({ status, output }));
  });
}

/** Whether a runTool result means the tool isn't installed. On Windows the shell always starts, and says so instead. */
function missingTool(result) {
  if (result.error) return true;
  return process.platform === "win32" && result.status !== 0 && /is not recognized as an internal or external command|cannot find the path specified/i.test(`${result.stderr ?? ""}${result.stdout ?? ""}`);
}

const SETTINGS_TEMPLATE = `# Settings for node devops/bootstrap.mjs (see devops/bootstrap.md).
# Lines starting with # are ignored. Never put a comment after a value.

# What this environment is called. Its Railway project, OpenAI project, Twilio subaccount, Turnstile
# widget and Resend key are named after APP_BASE_URL's address (below) when it's set, else after NAME.
# Each name is recorded the first time and kept, so changing these later renames nothing: start a
# new settings file to start over. NAME also names the command line's profile. Lower case letters,
# digits and dashes; it may be empty when APP_BASE_URL is set.
NAME=__NAME__
# The brand folder under brands/ (it must be on the branch below).
BRAND=
# test or production. production adds REQUIRE_EMAIL_VERIFICATION=true and no BRAND_PRESET.
ENVIRONMENT=test
# The fork (owner/name) and branch Railway builds from. Railway's GitHub app must reach the
# repository, or pushes won't redeploy (Railway can build a public repository it can't reach).
REPO=
BRANCH=main
# self_hosted_standard (every business unlimited) or cloud (businesses buy plans, through the
# provider BILLING_PROVIDER names below).
DEPLOYMENT_MODE=self_hosted_standard
# The operator's email: the platform key's owner, and DMARC reports.
OPERATOR_EMAIL=
# The ID of the Railway workspace the project goes in. Railway refuses to make a project without
# one, so fill it in unless the project already exists. Find it in Railway under the workspace's
# Settings, General tab (Workspace ID, with a copy button), or run doctor, which lists the
# workspaces your token can reach. A workspace token reaches only its own workspace.
RAILWAY_WORKSPACE_ID=
# Optional: the code of a private Railway template made by the template command (it prints the code).
# With it, up makes the services, volumes and settings from the template in one call, instead
# of one by one. Empty: one by one. TEMPLATE_PROJECT names the project the template command
# builds the template from (default lobbystack-template); it holds no keys or passwords.
# TEMPLATE_REPO: the repository that project's code services point at, if not REPO. Railway's
# GitHub access must reach it. up connects each deployment to its own REPO either way.
RAILWAY_TEMPLATE=
TEMPLATE_PROJECT=
TEMPLATE_REPO=
# The bucket's region, which never changes: sjc, iad, ams or sin.
BUCKET_REGION=iad
# Optional: the dashboard's own address, such as demo.example.com (https:// in front is fine).
# up adds it to Railway as the admin's custom domain, writes its CNAME in CLOUDFLARE_ZONE, adds it
# to the Turnstile widget, and makes it the admin's APP_BASE_URL. It also names the projects (see
# NAME). Empty: Railway's free address. CUSTOM_HOST is its older name and still works.
APP_BASE_URL=

# Email through Resend. EMAIL_DOMAIN is the subdomain kept for email; EMAIL_FROM is on it.
EMAIL_DOMAIN=
EMAIL_FROM=
# us-east-1, eu-west-1, sa-east-1 or ap-northeast-1. It can't change later.
RESEND_REGION=us-east-1

# Cloudflare. CLOUDFLARE_ZONE is the domain name of the zone that holds EMAIL_DOMAIN and
# APP_BASE_URL, such as example.com: the name, not the 32-character Zone ID that Cloudflare shows
# beside it. CLOUDFLARE_ACCOUNT_ID is the Account ID from the zone's Overview page (right-hand
# column, under API). Empty zone: the script prints the DNS records for you to add instead.
# Empty account ID: you make the Turnstile widget by hand.
CLOUDFLARE_ZONE=
CLOUDFLARE_ACCOUNT_ID=

# Twilio's shared toll-free number, only with DEPLOYMENT_MODE=cloud: buy (the script buys one),
# a number you already have in the subaccount (+18445550123), or empty for none.
TWILIO_TOLLFREE=

# Only with DEPLOYMENT_MODE=cloud: who sells the plans, polar or stripe.
BILLING_PROVIDER=polar
# Polar, only with BILLING_PROVIDER=polar: sandbox or live, and the organization's ID. Leave the ID empty
# to take it from the worker's token; when it's set, up checks that the token belongs to it.
POLAR_ORGANIZATION_ID=
POLAR=sandbox
# Stripe, only with BILLING_PROVIDER=stripe: sandbox or live. The account is the one the keys
# belong to (STRIPE_ADMIN_KEY and STRIPE_WORKER_KEY, in the secrets file).
STRIPE=sandbox

# Turn steps off with no (each then takes its values from the secrets file, or asks you).
STEP_GITHUB=yes
STEP_OPENAI=yes
STEP_TWILIO=yes
STEP_RESEND=yes
STEP_TURNSTILE=yes
`;

const SECRETS_TEMPLATE = `# Keys for node devops/bootstrap.mjs (see devops/bootstrap.md). It holds secrets:
# Git ignores it (.env.*), never commit or send it, and delete what you no longer need.
# Leave a line empty to be asked, or to let the script create that thing. Lines starting
# with # are ignored. For the tokens in the first group, the Polar tokens, the Stripe keys and
# the webhook secret, an environment variable of the same name wins over this file.

# Tokens the script uses to create things (it never puts them on Railway).
RAILWAY_API_TOKEN=
OPENAI_ADMIN_KEY=
TWILIO_MAIN_ACCOUNT_SID=
TWILIO_MAIN_AUTH_TOKEN=
RESEND_ADMIN_KEY=
CLOUDFLARE_API_TOKEN=

# Things you already have. Each one given here is used instead of creating a new one,
# and the token above for that service is then not needed for it.
# OpenAI: the project and its key, both or neither.
OPENAI_PROJECT_ID=
OPENAI_API_KEY=
# Twilio: the (sub)account's SID and Auth Token, and optionally its SIP trunk to OpenAI.
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_SIP_TRUNK_SID=
# Resend's sending key (re_...).
SMTP_PASSWORD=
# Cloudflare Turnstile's widget for the admin's address.
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
# Polar, only with DEPLOYMENT_MODE=cloud: the admin's and the worker's tokens (guide 3.7, Polar, step 3).
# One token may be both. connect sets the plans up with the worker's token when it also has organizations:write,
# meters:write, products:write, discounts:write and webhooks:write; else it asks for a short-lived setup token
# (POLAR_SETUP_TOKEN), which it keeps in memory only: paste it when asked rather than putting it here.
POLAR_ADMIN_TOKEN=
POLAR_WORKER_TOKEN=
# Stripe, only with BILLING_PROVIDER=stripe: the admin's and the worker's restricted keys, both of
# the deployment's account (rk_test_... in a sandbox; guide 3.7, "Selling plans (Stripe)", step 3).
STRIPE_ADMIN_KEY=
STRIPE_WORKER_KEY=
# For connect: the incoming-call webhook's signing secret (whsec_...), once it exists.
OPENAI_WEBHOOK_SECRET=

# Optional: the 13 platform secrets, to reuse ones already made (64 hex characters each).
# Left out, the script makes new ones. POSTGRES_PASSWORD, REDIS_PASSWORD, ENCRYPTION_KEY, ...
`;

const SECRETS = ["POSTGRES_PASSWORD", "LOBBYSTACK_AUTH_PASSWORD", "LOBBYSTACK_APP_PASSWORD", "LOBBYSTACK_WORKER_PASSWORD",
  "LOBBYSTACK_DISPATCHER_PASSWORD", "REDIS_PASSWORD", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "INTERNAL_SERVICE_SECRET",
  "INTERNAL_SERVICE_TOKEN", "NUMBER_CLAIM_TOKEN_SECRET", "OTP_HASH_SECRET", "WIDGET_SESSION_SECRET"];

const MIGRATE_PRE_DEPLOY = "sh -c 'node_modules/.bin/tsx dist/cli.js migrate && node_modules/.bin/tsx dist/cli.js bootstrap && node_modules/.bin/tsx dist/cli.js check && VERIFY_RLS_BEHAVIOR=true node_modules/.bin/tsx dist/cli.js verify-rls'";
const REDIS_START = "sh -c 'exec redis-server --bind :: 0.0.0.0 --appendonly yes --maxmemory-policy noeviction --requirepass \"$REDIS_PASSWORD\"'";

// ---------------------------------------------------------------- command line

// ---------------------------------------------------------------- log file and hidden secrets

// Every line the script prints also goes to <settings file>.log, with the time, plus each API
// call it makes (service, method, path, answer, time taken; never headers or bodies). Known
// secrets, and anything shaped like a provider key, are replaced by ‹hidden› in both.
let logPath = null;
let verbose = false;
const hiddenValues = new Set();
const KEY_SHAPES = /\b(?:sk-[A-Za-z0-9_-]{16,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=_-]{16,}|re_[A-Za-z0-9_]{16,}|lsp_[A-Za-z0-9_]{16,}|polar_[a-z]{2,4}_[A-Za-z0-9_]{16,})/g;
const SECRET_KEYS = new Set(["OPENAI_API_KEY", "TWILIO_AUTH_TOKEN", "SMTP_PASSWORD", "TURNSTILE_SECRET_KEY", "POLAR_ADMIN_TOKEN",
  "POLAR_WORKER_TOKEN", "OPENAI_WEBHOOK_SECRET", "RAILWAY_API_TOKEN", "OPENAI_ADMIN_KEY", "TWILIO_MAIN_AUTH_TOKEN", "RESEND_ADMIN_KEY",
  "CLOUDFLARE_API_TOKEN", "POLAR_ACCESS_TOKEN", "S3_SECRET_ACCESS_KEY", "STRIPE_ADMIN_KEY", "STRIPE_WORKER_KEY", "STRIPE_API_KEY",
  "POLAR_SETUP_TOKEN", "POLAR_WEBHOOK_SECRET"]);

function hide(value) {
  if (typeof value === "string" && value.length >= 8) hiddenValues.add(value);
  return value;
}

function redact(text) {
  let out = String(text);
  for (const value of hiddenValues) if (out.includes(value)) out = out.split(value).join("‹hidden›");
  return out.replace(KEY_SHAPES, "‹hidden›");
}

function writeLog(line) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${redact(line)}\n`, { mode: 0o600 });
  } catch {
    // A log that can't be written never stops the run.
  }
}

/** An API call or other detail: in the log always, on screen with --verbose. */
function trace(line) {
  writeLog(`  . ${line}`);
  if (verbose) consoleOriginal.log(`  . ${redact(line)}`);
}

const consoleOriginal = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
for (const level of ["log", "warn", "error"]) {
  console[level] = (...args) => {
    const text = redact(args.join(" "));
    consoleOriginal[level](text);
    for (const line of text.split("\n")) writeLog(level === "log" ? line : `${level.toUpperCase()} ${line}`);
  };
}

class Stop extends Error {}

const flags = new Set();
const positional = [];
let secretsOption = null;
for (let args = process.argv.slice(2), i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--secrets" || arg.startsWith("--secrets=")) {
    secretsOption = arg === "--secrets" ? args[(i += 1)] : arg.slice("--secrets=".length);
    if (!secretsOption) usage("--secrets needs a file.");
  } else if (arg.startsWith("--")) {
    if (!["--dry-run", "--yes", "--verbose"].includes(arg)) usage(`Unknown option ${arg}.`);
    flags.add(arg);
  } else positional.push(arg);
}
const [command, target] = positional;
const dryRun = flags.has("--dry-run");
const assumeYes = flags.has("--yes");
verbose = flags.has("--verbose");

let prompter = null;

async function main() {
  if (typeof fetch !== "function") throw new Error("this script needs Node 18 or later");
  if (command === "init") return init(target);
  if (!["up", "connect", "status", "doctor", "redo", "template"].includes(command) || !target) usage("Give a command and the settings file.");
  // status only reads, so it doesn't add to the log either.
  const run = loadRun(target, { log: command !== "status" });
  if (command === "status") return status(run);
  if (!dryRun && ["up", "connect", "redo", "template"].includes(command)) lockState(run);
  writeLog(`==== ${command} ${path.basename(target)}${dryRun ? " --dry-run" : ""}${assumeYes ? " --yes" : ""}${config ? ` (keys: ${config.file})` : ""} | node ${process.version} on ${process.platform} | bootstrap.mjs ${scriptVersion()}`);
  // Names a state file from before recorded names was made with, kept from now on (see recordEarlierNames).
  if (!dryRun && run.earlierNames.length && ["up", "connect", "redo"].includes(command)) {
    save(run);
    console.log(`Recorded the names earlier runs gave things, which they keep: ${run.earlierNames.map((key) => `${key}="${v(run, key)}"`).join(", ")}\n`);
  }
  if (command === "doctor") return doctor(run);
  if (command === "redo") return redo(run, positional.slice(2));
  if (command === "up") return up(run);
  if (command === "template") return makeTemplate(run);
  return connect(run);
}

/** The script's own commit, for the log, when it runs from a Git checkout. */
function scriptVersion() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const result = runTool("git", ["log", "-1", "--format=%h %cs", "--", "bootstrap.mjs"], { cwd: dir });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : "(not in Git)";
}

function usage(problem) {
  console.error(`${problem}

Usage:
  node devops/bootstrap.mjs init <name>                  write the settings and secrets files
  node devops/bootstrap.mjs doctor <settings file>       check settings, tools and tokens; changes nothing
  node devops/bootstrap.mjs up <settings file>           set everything up, then deploy
  node devops/bootstrap.mjs connect <settings file>      the last steps, once the address works
  node devops/bootstrap.mjs status <settings file>       what's done
  node devops/bootstrap.mjs redo <settings file> <step>  run a finished step again next time (status lists them)
  node devops/bootstrap.mjs template <settings file>     make a private Railway template of the layout, for RAILWAY_TEMPLATE
Options: --dry-run, --yes, --verbose (show each API call), --secrets <file>
See devops/bootstrap.md.`);
  process.exit(2);
}

function init(name) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) usage("Give a short name in lower case, such as realinfobot-test.");
  const file = `.env.bootstrap-${name}`;
  if (fs.existsSync(file)) {
    // A settings file made before the secrets file existed: add only the secrets file.
    if (fs.existsSync(`${file}.secrets`)) throw new Error(`${file} and ${file}.secrets already exist`);
    fs.writeFileSync(`${file}.secrets`, SECRETS_TEMPLATE, { mode: 0o600 });
    return console.log(`${file} already exists, so only ${file}.secrets was written. Put the keys you have in it.`);
  }
  fs.writeFileSync(file, SETTINGS_TEMPLATE.replace("__NAME__", name), { mode: 0o600 });
  if (!fs.existsSync(`${file}.secrets`)) fs.writeFileSync(`${file}.secrets`, SECRETS_TEMPLATE, { mode: 0o600 });
  console.log(`Wrote ${file} and ${file}.secrets. Fill in the first; put the keys you have in the second`);
  console.log(`(or leave it empty to be asked). Then run:\n  node devops/bootstrap.mjs up ${file} --dry-run`);
}

// ---------------------------------------------------------------- settings and state

// Every setting the script reads: the template's keys, and CUSTOM_HOST, APP_BASE_URL's older name.
const KNOWN_SETTINGS = new Set([...SETTINGS_TEMPLATE.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]).concat("CUSTOM_HOST"));

/** The brand brands/index.json gives a host, by the host or a parent domain; null for none, undefined if the index can't be read. */
function brandForHost(host) {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "brands", "index.json"), "utf8"));
  } catch {
    return undefined;
  }
  const labels = String(host).toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    const domain = labels.slice(i).join(".");
    if (Object.hasOwn(index.domains ?? {}, domain)) return index.domains[domain];
  }
  return null;
}

const hashText = (text) => createHash("sha256").update(text).digest("hex");

/**
 * What new things are named at the providers: APP_BASE_URL's host, such as demo.example.com, else NAME. A host longer
 * than 50 characters leaves it to NAME, since Twilio's names stop at 64 characters and Resend's keys at 50.
 */
const baseName = (s) => (s.CUSTOM_HOST && s.CUSTOM_HOST.length <= 50 ? s.CUSTOM_HOST : s.NAME);

/**
 * The name of each thing a step finds or makes by name, built from baseName() until the step records the name it used
 * in the state. From then on that name is kept, so a changed APP_BASE_URL or NAME never renames what exists, and never
 * makes a second one beside it.
 */
const NAMES = {
  RAILWAY_PROJECT_NAME: (base) => base,
  OPENAI_PROJECT_NAME: (base) => base,
  OPENAI_ACCOUNT_NAME: (base) => `${base} platform`,
  TWILIO_SUBACCOUNT_NAME: (base) => base,
  TWILIO_TRUNK_NAME: (base) => `${base} to OpenAI`,
  TWILIO_TOLLFREE_NAME: (base) => `${base} shared texts`,
  RESEND_KEY_NAME: (base) => base,
  TURNSTILE_WIDGET_NAME: (base) => base,
};
const nameFor = (run, key) => v(run, key) ?? NAMES[key](baseName(run.settings));

/** For each provider whose things come from the secrets file or by hand, how; they're never found by a name. */
function notNamed(run) {
  const s = run.settings;
  const file = (...keys) => keys.some((key) => fromFile(key, { quiet: true }));
  return {
    openai: !s.STEP_OPENAI ? "typed in" : file("OPENAI_PROJECT_ID", "OPENAI_API_KEY") ? "from the secrets file" : null,
    twilio: !s.STEP_TWILIO ? "typed in" : file("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SIP_TRUNK_SID") ? "from the secrets file" : null,
    trunk: !s.STEP_TWILIO ? "typed in" : file("TWILIO_SIP_TRUNK_SID") ? "from the secrets file" : null,
    resend: !s.STEP_RESEND ? "typed in" : file("SMTP_PASSWORD") ? "from the secrets file" : null,
    turnstile: !s.STEP_TURNSTILE || !s.CLOUDFLARE_ACCOUNT_ID ? "made by hand" : file("TURNSTILE_SITE_KEY") && file("TURNSTILE_SECRET_KEY") ? "from the secrets file" : null,
  };
}

/**
 * A state file from before the script recorded names: everything it made was named after NAME, so those are the names
 * to record, or a later APP_BASE_URL would send the next run looking for (and making) projects under another name.
 * Returns the keys it recorded; the next save keeps them.
 */
function recordEarlierNames(run) {
  const s = run.settings;
  const x = (key) => v(run, key);
  const not = notNamed(run);
  const made = {
    RAILWAY_PROJECT_NAME: x("RAILWAY_PROJECT_ID"),
    OPENAI_PROJECT_NAME: x("OPENAI_PROJECT_ID") && !not.openai,
    OPENAI_ACCOUNT_NAME: x("OPENAI_API_KEY") && !not.openai,
    TWILIO_SUBACCOUNT_NAME: x("TWILIO_ACCOUNT_SID") && !not.twilio,
    TWILIO_TRUNK_NAME: x("TWILIO_SIP_TRUNK_SID") && !not.trunk && !not.twilio,
    TWILIO_TOLLFREE_NAME: x("TWILIO_ALERT_SMS_FROM") && s.TWILIO_TOLLFREE === "buy",
    RESEND_KEY_NAME: x("SMTP_PASSWORD") && !not.resend,
    TURNSTILE_WIDGET_NAME: x("TURNSTILE_SITE_KEY") && !not.turnstile,
  };
  const earlier = Object.keys(made).filter((key) => made[key] && !x(key));
  if (!earlier.length) return [];
  if (!s.NAME) throw new Error(`${run.stateFile} is from before the script recorded names, and what it made is named after the NAME it was made with: put that NAME back in ${run.file}`);
  for (const key of earlier) run.state.values[key] = NAMES[key](s.NAME);
  return earlier;
}

/** Each provider's name in use, then one line when the settings would name new things otherwise. */
function nameLines(run) {
  const base = baseName(run.settings);
  const not = notNamed(run);
  const shown = [
    ["Railway project", "RAILWAY_PROJECT_NAME", null],
    ["OpenAI project", "OPENAI_PROJECT_NAME", not.openai],
    ["Twilio subaccount", "TWILIO_SUBACCOUNT_NAME", not.twilio],
    ["Turnstile widget", "TURNSTILE_WIDGET_NAME", not.turnstile],
    ["Resend key", "RESEND_KEY_NAME", not.resend],
  ];
  const lines = [`names: ${shown.map(([label, key, how]) => (how ? `${label} ${how}` : `${label} "${nameFor(run, key)}"`)).join(", ")}`];
  const kept = shown.filter(([, key, how]) => !how && v(run, key) && v(run, key) !== NAMES[key](base));
  if (kept.length) {
    const from = base === run.settings.CUSTOM_HOST ? "APP_BASE_URL" : "NAME";
    lines.push(`names stay as first recorded, so nothing is renamed or made twice: new things would be named "${base}" (from ${from}), but ${kept.map(([label, key]) => `the ${label} keeps "${v(run, key)}"`).join(" and ")}. To name everything after the settings, start a new settings file.`);
  }
  return lines;
}

/** The one item found by a name, or undefined. Two or more stop the run: names aren't unique at most providers. */
function only(items, what) {
  if (items.length > 1) throw new Error(`${what}: ${items.length} of them have that name (${items.map((item) => item.id ?? item.sid ?? item.sitekey).join(", ")}). Delete or rename the extra ones, or give the one to use in the secrets file, then run again`);
  return items[0];
}

function loadRun(file, { log = true } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`couldn't read ${file} (${error.code ?? error.message})`);
  }
  const settings = {};
  const problems = [];
  const repeated = new Set();
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const equals = line.indexOf("=");
    if (equals < 1) return problems.push(`line ${index + 1} isn't KEY=value`);
    let value = line.slice(equals + 1).trim();
    if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    const key = line.slice(0, equals).trim();
    if (key in settings && settings[key] !== value) repeated.add(key);
    settings[key] = value;
  });
  // A setting left empty, such as BRANCH=, takes its default rather than an empty value.
  const defaults = { ENVIRONMENT: "test", BRANCH: "main", DEPLOYMENT_MODE: "self_hosted_standard", BUCKET_REGION: "iad", RESEND_REGION: "us-east-1", BILLING_PROVIDER: "polar", POLAR: "sandbox", STRIPE: "sandbox" };
  const s = { ...defaults, ...Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== "" || !(key in defaults))) };
  for (const step of ["GITHUB", "OPENAI", "TWILIO", "RESEND", "TURNSTILE"]) {
    const word = String(s[`STEP_${step}`] || "yes").toLowerCase();
    if (!["yes", "no", "true", "false", "on", "off", "1", "0"].includes(word)) problems.push(`STEP_${step} is yes or no`);
    s[`STEP_${step}`] = !["no", "false", "off", "0"].includes(word);
  }
  for (const key of ["BRAND", "REPO", "OPERATOR_EMAIL", "EMAIL_FROM"]) if (!s[key]) problems.push(`${key} is empty`);
  if (s.NAME && !/^[a-z0-9][a-z0-9-]*$/.test(s.NAME)) problems.push("NAME is lower case letters, digits and dashes, such as acme-test");
  if (s.STEP_RESEND && !s.EMAIL_DOMAIN) problems.push("EMAIL_DOMAIN is empty (or set STEP_RESEND=no)");
  if (!["self_hosted_standard", "cloud"].includes(s.DEPLOYMENT_MODE)) problems.push("DEPLOYMENT_MODE is self_hosted_standard or cloud");
  if (!["test", "production"].includes(s.ENVIRONMENT)) problems.push("ENVIRONMENT is test or production");
  if (!["sjc", "iad", "ams", "sin"].includes(s.BUCKET_REGION)) problems.push("BUCKET_REGION is sjc, iad, ams or sin");
  if (!["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"].includes(s.RESEND_REGION)) problems.push("RESEND_REGION is us-east-1, eu-west-1, sa-east-1 or ap-northeast-1");
  if (!["polar", "stripe"].includes(s.BILLING_PROVIDER)) problems.push("BILLING_PROVIDER is polar or stripe");
  if (!["sandbox", "live"].includes(s.POLAR)) problems.push("POLAR is sandbox or live");
  if (!["sandbox", "live"].includes(s.STRIPE)) problems.push("STRIPE is sandbox or live");
  if (s.BILLING_PROVIDER === "stripe" && s.DEPLOYMENT_MODE !== "cloud") problems.push("BILLING_PROVIDER=stripe is only for DEPLOYMENT_MODE=cloud");
  if (s.REPO && !/^[\w.-]+\/[\w.-]+$/.test(s.REPO)) problems.push("REPO is owner/name");
  if (s.TEMPLATE_REPO && !/^[\w.-]+\/[\w.-]+$/.test(s.TEMPLATE_REPO)) problems.push("TEMPLATE_REPO is owner/name");
  // APP_BASE_URL is the dashboard's own address, and CUSTOM_HOST its older name: both come down to the host name.
  const hostOf = (address) => String(address ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  const appHost = hostOf(s.APP_BASE_URL);
  if (appHost && s.CUSTOM_HOST && appHost !== hostOf(s.CUSTOM_HOST)) problems.push("APP_BASE_URL and CUSTOM_HOST name different addresses: keep only APP_BASE_URL");
  s.CUSTOM_HOST = appHost || hostOf(s.CUSTOM_HOST);
  // Things at the providers are named after APP_BASE_URL's address, else NAME (see baseName), so one of them is needed.
  if (!s.NAME && !s.CUSTOM_HOST) problems.push("NAME and APP_BASE_URL are both empty: set one, since projects are named after APP_BASE_URL's address, else NAME");
  else if (!s.NAME && s.CUSTOM_HOST.length > 50) problems.push("APP_BASE_URL's address is longer than 50 characters, too long to name projects after (Twilio's names stop at 64): set NAME too");
  const hostSetting = s.APP_BASE_URL ? "APP_BASE_URL" : "CUSTOM_HOST";
  const zone = String(s.CLOUDFLARE_ZONE ?? "").toLowerCase();
  if (s.CUSTOM_HOST && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.CUSTOM_HOST)) problems.push(`${hostSetting} is the dashboard's address, such as demo.example.com or https://demo.example.com, with no path`);
  else if (s.CUSTOM_HOST && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone) && s.CUSTOM_HOST !== zone && !s.CUSTOM_HOST.endsWith(`.${zone}`)) problems.push(`${hostSetting} must be in CLOUDFLARE_ZONE (${s.CLOUDFLARE_ZONE}), where the script writes its CNAME; or empty CLOUDFLARE_ZONE to add the records by hand`);
  const emailDomain = String(s.EMAIL_DOMAIN ?? "").toLowerCase();
  if (s.STEP_RESEND && emailDomain && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone) && emailDomain !== zone && !emailDomain.endsWith(`.${zone}`)) problems.push(`EMAIL_DOMAIN must be in CLOUDFLARE_ZONE (${s.CLOUDFLARE_ZONE}), where the script writes its records; or empty CLOUDFLARE_ZONE to add them by hand`);
  // The admin and the worker take their brand from APP_BASE_URL's domain when brands/index.json gives it one, and
  // from BRAND_PRESET only on other addresses. Production sets no BRAND_PRESET, so its address must be on the brand's
  // domain, or both refuse to start (BRAND_REQUIRED) under the default brand.
  const hostBrand = s.CUSTOM_HOST && s.BRAND ? brandForHost(s.CUSTOM_HOST) : undefined;
  if (s.ENVIRONMENT === "production" && !s.CUSTOM_HOST) problems.push("production needs APP_BASE_URL: an address on a domain the brand owns, since production sets no BRAND_PRESET");
  else if (hostBrand && hostBrand !== s.BRAND) problems.push(`APP_BASE_URL (${s.CUSTOM_HOST}) is on a domain brands/index.json gives the brand ${hostBrand}, which wins over BRAND_PRESET, not ${s.BRAND}`);
  else if (s.ENVIRONMENT === "production" && hostBrand === null) problems.push(`APP_BASE_URL (${s.CUSTOM_HOST}) is on no domain brands/index.json gives a brand, so production would start under the default brand and stop. Add its domain for ${s.BRAND} there (and push it), or use an address on one of ${s.BRAND}'s domains`);
  if (s.CLOUDFLARE_ZONE && /^[0-9a-f]{32}$/i.test(s.CLOUDFLARE_ZONE)) problems.push("CLOUDFLARE_ZONE is the zone's domain name, such as example.com, not its Zone ID");
  else if (s.CLOUDFLARE_ZONE && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.CLOUDFLARE_ZONE)) problems.push("CLOUDFLARE_ZONE is a domain name only, such as example.com");
  if (s.CLOUDFLARE_ACCOUNT_ID && !/^[0-9a-f]{32}$/i.test(s.CLOUDFLARE_ACCOUNT_ID)) problems.push("CLOUDFLARE_ACCOUNT_ID is the 32-character Account ID from the zone's Overview page");
  // Empty, it comes from the worker's Polar token (polar.tokens).
  if (s.POLAR_ORGANIZATION_ID && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.POLAR_ORGANIZATION_ID)) problems.push("POLAR_ORGANIZATION_ID is the Polar organization's ID, a UUID, or empty to take it from the worker's token");
  if (s.TWILIO_TOLLFREE && s.TWILIO_TOLLFREE !== "buy" && !/^\+\d{8,15}$/.test(s.TWILIO_TOLLFREE)) problems.push("TWILIO_TOLLFREE is buy, a number such as +18445550123, or empty");
  if (s.TWILIO_TOLLFREE && s.DEPLOYMENT_MODE !== "cloud") problems.push("TWILIO_TOLLFREE is only for DEPLOYMENT_MODE=cloud");
  if (problems.length) throw new Error(`${file} needs fixing:\n  ${problems.join("\n  ")}`);
  const unknown = Object.keys(settings).filter((key) => !KNOWN_SETTINGS.has(key));
  if (unknown.length) console.warn(`Warning: ${file} has settings the script doesn't read: ${unknown.join(", ")}. Check their spelling.`);
  if (repeated.size) console.warn(`Warning: ${file} sets ${[...repeated].join(", ")} more than once, to different values; the last line is used.`);
  const stateFile = path.join(path.dirname(file), `${path.basename(file)}.state.json`);
  const { stateText, state } = readState(stateFile);
  if (log) logPath = `${file}.log`;
  for (const [key, value] of Object.entries(state.values)) if (SECRET_KEYS.has(key) || SECRETS.includes(key)) hide(value);
  const secretsFile = secretsOption ?? (fs.existsSync(`${file}.secrets`) ? `${file}.secrets` : null);
  config = secretsFile ? loadConfig(secretsFile) : null;
  const run = { file, settings: s, stateFile, state, stateHash: stateText === null ? null : hashText(stateText) };
  run.earlierNames = recordEarlierNames(run);
  return run;
}

/** A state file's text, kept so save() can tell when another run has written it since, and what it holds. */
function readState(stateFile) {
  const stateText = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
  let state = { done: {}, values: {} };
  try {
    if (stateText !== null) state = JSON.parse(stateText);
  } catch (error) {
    throw new Error(`${stateFile} isn't valid JSON (${error.message}). Put back a copy that is, such as a .bak file beside it`);
  }
  state.done ??= {};
  state.values ??= {};
  return { stateText, state };
}

// ---------------------------------------------------------------- the secrets file

let config = null;

/**
 * Reads KEY=value lines. Also reads devops/railway-vars.mjs files: their [service] lines are
 * kept, so a key set differently per service (POLAR_ACCESS_TOKEN) is found by service. Empty
 * values, ?, <placeholders> and ${{references}} count as not given.
 */
function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`couldn't read the secrets file ${file} (${error.code ?? error.message})`);
  }
  const flat = {};
  const conflicts = new Set();
  const outside = new Set();
  const services = {};
  const problems = [];
  let current = [];
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      current = section[1].split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
      return;
    }
    const body = line.replace(/^export\s+/, "");
    const equals = body.indexOf("=");
    const key = equals > 0 ? body.slice(0, equals).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return problems.push(`line ${index + 1} isn't KEY=value`);
    let value = body.slice(equals + 1).trim();
    if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    if (!value || value === "?" || /^<[^>]*>$/.test(value) || value.includes("${{")) return;
    if (!/(_ID|_SID|SITE_KEY|_URL|_HOST|EMAIL|_FROM|DOMAIN|MODE|REGION|PRESET|_PORT|_PATH|NODE_ENV|_USER|_DB|_NAME)$/.test(key)) hide(value);
    for (const name of current) (services[name] ??= {})[key] = value;
    if (!current.length) outside.add(key);
    if (key in flat && flat[key] !== value) conflicts.add(key);
    else flat[key] = value;
  });
  if (problems.length) throw new Error(`the secrets file ${file} needs fixing:\n  ${problems.join("\n  ")}`);
  for (const key of conflicts) delete flat[key];
  // A key set differently under each [service] line is found by service (POLAR_ACCESS_TOKEN); only values outside them clash.
  for (const key of conflicts) if (outside.has(key)) console.warn(`Warning: ${file} sets ${key} to different values outside a [service] line, so neither is used.`);
  const ignored = runTool("git", ["check-ignore", "-q", file]);
  if (ignored.status === 1) console.warn(`Warning: Git doesn't ignore ${file}. It holds secrets: never commit it.`);
  return { file, flat, services, used: new Set() };
}

/** Where else a value may be in a variable file: [service, key], service "" for any. */
const CONFIG_ALIASES = {
  TURNSTILE_SITE_KEY: [["", "NEXT_PUBLIC_TURNSTILE_SITE_KEY"]],
  POLAR_ADMIN_TOKEN: [["admin", "POLAR_ACCESS_TOKEN"]],
  POLAR_WORKER_TOKEN: [["worker", "POLAR_ACCESS_TOKEN"]],
  STRIPE_ADMIN_KEY: [["admin", "STRIPE_API_KEY"]],
  STRIPE_WORKER_KEY: [["worker", "STRIPE_API_KEY"]],
};

/** A value from the secrets file only, or undefined. */
function fromFile(name, { quiet = false } = {}) {
  if (!config) return undefined;
  let found = config.flat[name];
  for (const [service, key] of CONFIG_ALIASES[name] ?? []) {
    if (found) break;
    if (!service) found = config.flat[key];
    else {
      found = Object.entries(config.services).find(([names, values]) => (names === service || names.endsWith(`-${service}`)) && values[key])?.[1][key];
    }
  }
  if (found && !quiet && !config.used.has(name)) {
    config.used.add(name);
    console.log(`  ${name}: from ${config.file}`);
  }
  return found;
}

/** A value from the environment, then the secrets file, or undefined. */
function given(name) {
  return process.env[name]?.trim() || fromFile(name);
}

function save(run) {
  if (dryRun) return;
  // Another run may have saved since this one read the file: an old run left at a prompt for hours once wrote its
  // stale progress over a newer project's. Never write over another run's progress.
  const onDisk = fs.existsSync(run.stateFile) ? hashText(fs.readFileSync(run.stateFile, "utf8")) : null;
  if (onDisk !== (run.stateHash ?? null)) {
    throw new Stop(`another run changed ${run.stateFile} after this one read it, so this run saved nothing. Close any other window running bootstrap.mjs, then run the command again`);
  }
  const text = `${JSON.stringify(run.state, null, 2)}\n`;
  const temp = `${run.stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  try {
    fs.renameSync(temp, run.stateFile);
  } catch {
    // Windows refuses the rename while another program has the file open: write it in place instead.
    fs.writeFileSync(run.stateFile, text, { mode: 0o600 });
    fs.rmSync(temp, { force: true });
  }
  run.stateHash = hashText(text);
  try {
    fs.chmodSync(run.stateFile, 0o600);
  } catch {
    // Windows has no such modes.
  }
}

/** Keeps a second run off the same state file while this one runs. A lock left by a run that's gone is taken over. */
function lockState(run) {
  const lock = `${run.stateFile}.lock`;
  const mine = JSON.stringify({ pid: process.pid, command, started: new Date().toISOString() });
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      fs.writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
      process.on("exit", () => {
        try {
          if (fs.readFileSync(lock, "utf8") === mine) fs.rmSync(lock);
        } catch {
          // Already gone.
        }
      });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let other = {};
      try {
        other = JSON.parse(fs.readFileSync(lock, "utf8"));
      } catch {
        // Unreadable: treated as left by a run that's gone.
      }
      if (other.pid && isRunning(other.pid)) {
        throw new Stop(`another bootstrap.mjs run (${other.command ?? "a command"}, process ${other.pid}, since ${other.started ?? "?"}) is using ${run.stateFile}. Let it finish, or close its window, then run this again. If no such run is left, delete ${lock}`);
      }
      fs.rmSync(lock, { force: true });
    }
  }
  throw new Stop(`couldn't lock ${run.stateFile}. If no other run is using it, delete ${lock}`);
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Runs one recorded step once. `work` returns the values to keep. */
async function step(run, id, title, work) {
  if (run.state.done[id]) {
    console.log(`= ${title} (done ${run.state.done[id]})`);
    return;
  }
  console.log(`${dryRun ? "~" : "+"} ${title}`);
  writeLog(`  step ${id}`);
  if (dryRun) return;
  const started = Date.now();
  currentStep = id;
  byHandSkipped = false;
  const values = (await work()) ?? {};
  currentStep = null;
  for (const [key, value] of Object.entries(values)) if (SECRET_KEYS.has(key) || SECRETS.includes(key)) hide(value);
  Object.assign(run.state.values, values);
  run.state.byHand ??= {};
  if (byHandSkipped) {
    // --yes didn't wait at its BY HAND part, so nobody confirmed it: it stays open, is listed at the end and by
    // status, and runs again next time (a skipped "GPT-Live SIP and the spending limit" once went unnoticed).
    run.state.byHand[id] = title;
    save(run);
    writeLog(`  left ${id} open: its BY HAND part wasn't confirmed`);
    return;
  }
  delete run.state.byHand[id];
  run.state.done[id] = new Date().toISOString();
  save(run);
  const seconds = Math.round((Date.now() - started) / 1000);
  writeLog(`  done ${id} in ${seconds} s`);
}

let byHandSkipped = false;

/** The steps whose BY HAND part is still waiting for someone, as a block to print, or "". */
function openByHand(run, command) {
  const open = Object.entries(run.state.byHand ?? {}).filter(([id]) => !run.state.done[id]);
  if (!open.length) return "";
  // Each step is finished by the command that runs it, which isn't always the one that just ended: up's steps,
  // such as openai.limits, are still open when connect ends, and running connect again wouldn't close them.
  const owner = (id) => (command === "template" ? "template" : id.startsWith("connect.") ? "connect" : "up");
  const commands = ["up", "connect", "template"].filter((name) => open.some(([id]) => owner(id) === name));
  return `\n\nStill to do by hand (--yes didn't wait for these, so they aren't recorded as done):\n${open.map(([id, title]) => `  - ${id}: ${title}`).join("\n")}\nDo them, then run ${commands.join(", then ")} again without --yes and press Enter at each.`;
}

let currentStep = null;

const v = (run, key) => run.state.values[key];

/**
 * The dashboard's address: APP_BASE_URL's host (CUSTOM_HOST) as the settings say now, else Railway's address. The
 * settings win over the address an earlier run recorded, so setting APP_BASE_URL later is enough for connect.
 */
const appHost = (run) => run.settings.CUSTOM_HOST || v(run, "APP_HOST") || v(run, "RAILWAY_HOST");

// ---------------------------------------------------------------- prompts

function createPrompter() {
  const terminal = process.stdin.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
  const waiting = [];
  let closed = false;
  let current = null;
  let pending = null;
  rl.on("line", (line) => waiting.push(line));
  // Ctrl+C at a question stops the run, as it does elsewhere. Without a listener, readline closes the input instead,
  // and the open question would look answered.
  rl.on("SIGINT", () => process.emit("SIGINT"));
  rl.on("close", () => {
    closed = true;
    // Input ended mid-question (a pipe, or Ctrl+D): the question gets no answer (null), and the caller stops.
    if (pending) {
      process.stdout.write("\n");
      pending(null);
    }
  });
  if (terminal) {
    rl._writeToOutput = (text) => {
      if (!current?.muted) process.stdout.write(text);
      else if (text.startsWith(current.question)) process.stdout.write(current.question);
    };
  }
  return {
    ask(question, hidden) {
      // In a terminal, a line typed before its question (a second Enter, an early paste) never answers it. Piped
      // answers, as tests feed them, are taken in order.
      if (terminal) waiting.length = 0;
      if (waiting.length) {
        process.stdout.write(`${question}\n`);
        return Promise.resolve(waiting.shift().trim());
      }
      if (closed) {
        process.stdout.write(`${question}\n`);
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        current = { question, muted: false };
        pending = resolve;
        rl.question(question, (answer) => {
          const { muted } = current;
          current = null;
          pending = null;
          if (muted) process.stdout.write("\n");
          resolve(answer.trim());
        });
        current.muted = hidden && terminal;
      });
    },
    close() {
      rl.close();
    },
  };
}

async function ask(question, { hidden = false } = {}) {
  prompter ??= createPrompter();
  writeLog(`ASK ${question.trim()}`);
  const answer = await prompter.ask(question, hidden);
  writeLog(`  answer: ${hidden ? "(hidden)" : answer || "(empty)"}`);
  return answer;
}

/**
 * A secret from the environment (tokens only, envToo) or the secrets file, else asked for with
 * typing hidden. Keys that stand in for something the script creates, such as OPENAI_API_KEY,
 * come only from the file, so a key that happens to be set in the shell is never picked up.
 */
async function secret(name, question, check = () => true, { envToo = true } = {}) {
  const found = hide(envToo ? given(name) : fromFile(name));
  if (found) {
    if (!check(found)) throw new Error(`${name} in ${envToo && process.env[name]?.trim() ? "the environment" : config.file} doesn't look right (${question})`);
    return found;
  }
  return askSecret(name, question, check);
}

/** A secret asked for, with typing hidden where the terminal can hide it. */
async function askSecret(name, question, check = () => true, instead = "put the value in the secrets file instead") {
  if (!process.stdin.isTTY) console.log(`  (This terminal can't hide typing, such as Git Bash's: ${instead}, or run in PowerShell.)`);
  const answer = hide(await ask(`${question} (typing is hidden): `, { hidden: true }));
  if (!answer || !check(answer)) throw new Error(`no valid value given for ${name}`);
  return answer;
}

/** A value that isn't secret: from the secrets file, else asked for. */
async function value(name, question, check = () => true) {
  const found = fromFile(name);
  if (found) {
    if (!check(found)) throw new Error(`${name} in ${config.file} doesn't look right (${question})`);
    return found;
  }
  const answer = await ask(`${question}: `);
  if (!answer || !check(answer)) throw new Error(`that isn't a valid answer to "${question}"`);
  return answer;
}

const looksLike = {
  project: (answer) => /^proj_\w+$/.test(answer),
  account: (answer) => /^AC\w{32}$/.test(answer),
  trunk: (answer) => /^TK\w{32}$/.test(answer),
};

async function confirm(question) {
  if (assumeYes) return true;
  const answer = String((await ask(`${question} Type yes to go on: `)) ?? "").toLowerCase();
  if (answer !== "yes") throw new Stop("you didn't type yes");
  return true;
}

/** A step only a person can do: says what to do, then waits for Enter. With --yes it doesn't wait, and step() keeps the step open. */
async function byHand(lines) {
  console.log(`\n  BY HAND:\n${lines.map((line) => `    ${line}`).join("\n")}`);
  if (assumeYes) {
    byHandSkipped = true;
    return console.log("  (--yes doesn't wait here, so this step stays open: do it, then run again without --yes.)");
  }
  const answer = await ask("  Press Enter when it's done: ");
  if (answer === null) throw new Stop("input ended at a BY HAND step, so it isn't recorded as done. Do it, then run the same command again");
}

// ---------------------------------------------------------------- HTTP

async function http(service, url, { method = "GET", headers = {}, body, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const label = `${service} ${method} ${new URL(url).pathname}${service === "Railway" && body?.query ? ` ${body.query.match(/^(?:query|mutation) (\w+)/)?.[1] ?? ""}` : ""}`;
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const reason = error.cause?.code ?? error.cause?.errors?.[0]?.code ?? error.cause?.message ?? error.message;
    trace(`${label} -> no answer (${reason})`);
    const failure = new Error(`${service} couldn't be reached (${reason})`);
    failure.service = service;
    failure.network = reason;
    throw failure;
  }
  trace(`${label} -> ${response.status} in ${Date.now() - started} ms`);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: reported below by status.
  }
  if (!response.ok) {
    // Polar's answers carry their reason in detail; the admin's API names its error in error.code.
    const message = json?.error?.message ?? json?.message ?? json?.errors?.[0]?.message ?? (typeof json?.detail === "string" ? json.detail : undefined) ?? `HTTP ${response.status}`;
    const error = new Error(`${service} refused ${method} ${new URL(url).pathname}: ${message}`);
    error.status = response.status;
    error.service = service;
    if (typeof json?.error?.code === "string") error.code = json.error.code;
    throw error;
  }
  return json;
}

const tokens = {};
async function token(name, question) {
  tokens[name] ??= hide(await secret(name, question));
  return tokens[name];
}

async function railway(query, variables = {}) {
  const auth = await token("RAILWAY_API_TOKEN", "Railway account or workspace token");
  const json = await http("Railway", URLS.railway, { method: "POST", headers: { Authorization: `Bearer ${auth}` }, body: { query, variables } });
  if (json?.errors?.length) {
    const error = new Error(`Railway refused ${query.match(/^(?:query|mutation) (\w+)/)?.[1] ?? "it"}: ${json.errors.map((item) => item.message).join("; ")}`);
    error.graphql = json.errors;
    error.service = "Railway";
    throw error;
  }
  return json.data;
}

async function openai(pathname, options = {}) {
  const key = await token("OPENAI_ADMIN_KEY", "OpenAI admin key");
  return http("OpenAI", `${URLS.openai}${pathname}`, { ...options, headers: { Authorization: `Bearer ${key}` } });
}

async function twilioMain(pathname, options = {}) {
  const sid = await token("TWILIO_MAIN_ACCOUNT_SID", "Twilio main account's Account SID");
  const auth = await token("TWILIO_MAIN_AUTH_TOKEN", "Twilio main account's Auth Token");
  return http("Twilio", `${URLS.twilio}${pathname}`, { ...options, headers: { Authorization: basic(sid, auth) } });
}

function twilioSub(run, base, pathname, options = {}) {
  return http("Twilio", `${base}${pathname}`, { ...options, headers: { Authorization: basic(v(run, "TWILIO_ACCOUNT_SID"), v(run, "TWILIO_AUTH_TOKEN")) } });
}

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

async function resend(pathname, options = {}) {
  const key = await token("RESEND_ADMIN_KEY", "Resend key with full access");
  return http("Resend", `${URLS.resend}${pathname}`, { ...options, headers: { Authorization: `Bearer ${key}` } });
}

async function cloudflare(pathname, options = {}) {
  const key = await token("CLOUDFLARE_API_TOKEN", "Cloudflare API token");
  const json = await http("Cloudflare", `${URLS.cloudflare}${pathname}`, { ...options, headers: { Authorization: `Bearer ${key}` } });
  if (json && json.success === false) throw Object.assign(new Error(`Cloudflare refused ${pathname}: ${json.errors?.map((item) => item.message).join("; ")}`), { service: "Cloudflare" });
  return json?.result;
}

/** Every item of a Polar list, 100 a page, read with one of the deployment's Polar tokens on POLAR's server. */
async function polarList(run, token, pathname) {
  const base = URLS.polar ?? POLAR_SERVERS[run.settings.POLAR];
  const items = [];
  for (let page = 1; ; page += 1) {
    const data = await http("Polar", `${base}${pathname}?page=${page}&limit=100`, { headers: { Authorization: `Bearer ${token}`, "polar-version": POLAR_API_VERSION } });
    items.push(...(data?.items ?? []));
    if (page >= (data?.pagination?.max_page ?? 1)) return items;
  }
}

/** The one organization a Polar organization token belongs to, as Polar lists it to that token. */
async function polarOrganizationOf(run, token, who) {
  let organizations;
  try {
    organizations = await polarList(run, token, "/v1/organizations/");
  } catch (error) {
    // Which token it was, for the message and for hints().
    error.message = `${who}: ${error.message}`;
    throw error;
  }
  if (organizations.length !== 1) {
    throw Object.assign(new Error(`${who} reaches ${organizations.length} Polar organizations. Use an organization token, made in the organization's Settings > Developers, which reaches exactly one`), { service: "Polar" });
  }
  return organizations[0];
}

/**
 * The deployment's Polar organization: the one polar.tokens found the worker's token belongs to, else the setting (a
 * state file from before polar.tokens recorded it). The two can only differ when the setting changed afterwards.
 */
function polarOrganization(run) {
  const recorded = v(run, "POLAR_ORGANIZATION_ID");
  const setting = run.settings.POLAR_ORGANIZATION_ID;
  if (recorded && setting && recorded.toLowerCase() !== setting.toLowerCase()) {
    throw new Error(`POLAR_ORGANIZATION_ID in ${run.file} is ${setting}, but the worker's Polar token belongs to ${recorded}. To move to another organization, put its tokens in the secrets file, then redo polar.tokens`);
  }
  return recorded ?? setting;
}

// ---------------------------------------------------------------- up

async function up(run) {
  const s = run.settings;
  console.log(`${dryRun ? "Dry run: nothing is called or changed.\n" : ""}${baseName(s)}: ${s.ENVIRONMENT}, ${s.DEPLOYMENT_MODE}, brand ${s.BRAND}, from ${s.REPO}@${s.BRANCH}`);
  for (const line of nameLines(run)) console.log(line.charAt(0).toUpperCase() + line.slice(1));
  console.log(`${config ? `Keys from ${config.file}, the environment, or asked for.` : "No secrets file: keys come from the environment or are asked for."}\n`);
  const providers = ["Railway", s.STEP_OPENAI && "OpenAI", s.STEP_TWILIO && "Twilio", s.STEP_RESEND && "Resend", (s.CLOUDFLARE_ZONE || (s.STEP_TURNSTILE && s.CLOUDFLARE_ACCOUNT_ID)) && "Cloudflare"].filter(Boolean);
  if (!dryRun) await confirm(`This sets up ${baseName(s)} at ${providers.slice(0, -1).join(", ")}${providers.length > 1 ? " and " : ""}${providers.at(-1)}, which bill your accounts.`);

  console.log("\nGitHub");
  await githubSteps(run);
  console.log("\nOpenAI");
  await openaiSteps(run);
  console.log("\nTwilio");
  await twilioSteps(run);
  console.log("\nEmail");
  await resendSteps(run);
  if (s.DEPLOYMENT_MODE === "cloud" && s.BILLING_PROVIDER === "stripe") {
    console.log("\nStripe");
    await stripeKeysStep(run);
  } else if (s.DEPLOYMENT_MODE === "cloud") {
    console.log("\nPolar");
    await step(run, "polar.tokens", "Polar's two platform tokens, and the organization they belong to (Polar makes tokens only in its dashboard)", async () => {
      if (!given("POLAR_ADMIN_TOKEN") || !given("POLAR_WORKER_TOKEN")) await byHand([
        `In Polar's ${s.POLAR} organization, Settings > Developers > New Token, make two tokens (guide 3.7, "Selling plans (Polar)", step 3):`,
        `"${baseName(s)} admin" with customer_sessions:write only, and "${baseName(s)} worker" with checkouts:write,`,
        "events:write, organizations:read, meters:read, products:read, discounts:read, subscriptions:write, customers:write.",
        `With ${SETUP_SCOPES} as well, the worker's token`,
        "also sets the plans up in connect, which then asks for no other token (the worker can then change the plans and read",
        "the webhook's secret too). One token with all these scopes may be both.",
      ]);
      // One token may be both: it then has both sets of scopes.
      const admin = await secret("POLAR_ADMIN_TOKEN", "The admin's Polar token");
      const worker = await secret("POLAR_WORKER_TOKEN", "The worker's Polar token");
      // The worker's token reads its organization (organizations:read), as Stripe's keys name their account. The
      // admin's can only open customer portals, so it isn't checked.
      const organization = await polarOrganizationOf(run, worker, "The worker's Polar token");
      if (s.POLAR_ORGANIZATION_ID && s.POLAR_ORGANIZATION_ID.toLowerCase() !== String(organization.id).toLowerCase()) {
        throw new Error(`the worker's Polar token belongs to the ${s.POLAR} organization ${organization.name} (${organization.id}), and POLAR_ORGANIZATION_ID in ${run.file} is ${s.POLAR_ORGANIZATION_ID}. Make both tokens in that organization, or empty POLAR_ORGANIZATION_ID to use ${organization.id}`);
      }
      console.log(`  the worker's token belongs to Polar's ${s.POLAR} organization ${organization.name} (${organization.id})`);
      return { POLAR_ADMIN_TOKEN: admin, POLAR_WORKER_TOKEN: worker, POLAR_ORGANIZATION_ID: organization.id };
    });
  }
  console.log("\nRailway");
  await railwaySteps(run);
  console.log("\nAddress");
  await addressSteps(run);
  if (s.TWILIO_TOLLFREE) {
    console.log("\nShared toll-free number");
    await tollfreeSteps(run);
  }
  console.log("\nVariables");
  await variableSteps(run);
  console.log("\nDeploy");
  await deploySteps(run);
  console.log("\nAfter the deploy");
  await postDeploySteps(run);
  if (!dryRun) {
    const railwayHost = v(run, "RAILWAY_HOST");
    const host = appHost(run);
    const first = railwayHost && railwayHost !== host ? ` (https://${railwayHost} answers first, while DNS spreads and Railway issues the certificate)` : "";
    // connect's Polar billing works with the operator key, which acts as OPERATOR_EMAIL's account: signing up first saves a wait there.
    const next = s.DEPLOYMENT_MODE === "cloud" && s.BILLING_PROVIDER === "polar" ? `, sign up at https://${host}/en/signup as ${s.OPERATOR_EMAIL} with the 6-digit code from the email\n(connect sets Polar up with a key that acts as that account). Then run:` : ", run:";
    console.log(`\nSet up and deploying. Once https://${host}/api/health/ready shows "ok":true${first}${next}\n  node devops/bootstrap.mjs connect ${run.file}${openByHand(run, "up")}`);
  }
}

// ---------------------------------------------------------------- Stripe

/** Why a Stripe key can't serve a deployment of this mode (sandbox or live), or null when it can. */
function stripeKeyProblem(name, key, mode) {
  const match = /^([rs])k_(test|live)_[A-Za-z0-9]+$/.exec(key);
  if (!match) return `${name} isn't a Stripe key: a restricted key starts with rk_test_ in a sandbox, or rk_live_`;
  if ((match[2] === "live") !== (mode === "live")) return `${name} is a ${match[2] === "live" ? "live" : "test"} key, and STRIPE is ${mode}: make it in Stripe's ${mode === "live" ? "live mode" : "sandbox"}`;
  return null;
}

/** The ID of the Stripe account a key belongs to, which Stripe tells the key's holder. */
async function stripeAccountOf(key) {
  const account = await http("Stripe", `${URLS.stripe}/account`, { headers: { Authorization: `Bearer ${key}` } });
  if (!/^acct_\w+$/.test(account?.id ?? "")) throw Object.assign(new Error("Stripe didn't say which account the key belongs to"), { service: "Stripe" });
  return account.id;
}

/** Whether brands/<brand>/billing.json has the stripe block that pnpm billing --stripe needs; undefined when the file can't be read. */
function brandHasStripeBlock(brand) {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "brands", brand, "billing.json"), "utf8"));
    return Boolean(file?.stripe);
  } catch {
    return undefined;
  }
}

/**
 * The admin's and the worker's restricted keys, as the Polar tokens are on a Polar deployment: each of the deployment's
 * mode, and both of one account, which becomes STRIPE_ACCOUNT_ID. Stripe makes restricted keys only in its Dashboard.
 */
async function stripeKeysStep(run) {
  const s = run.settings;
  await step(run, "stripe.keys", "Stripe's two restricted keys, both of one account and of the deployment's mode (Stripe makes them only in its Dashboard)", async () => {
    if (!given("STRIPE_ADMIN_KEY") || !given("STRIPE_WORKER_KEY")) await byHand([
      `In the deployment's Stripe ${s.STRIPE === "live" ? "account, in live mode" : "sandbox"}, Developers > API keys > Create restricted key, make two keys (guide 3.7, "Selling plans (Stripe)", step 3):`,
      `"${baseName(s)} admin", which opens the billing portal and reads customers and PaymentIntents (to find the business of a disputed`,
      `prepaid pack payment), and "${baseName(s)} worker", which makes customers,`,
      "Checkout Sessions, subscriptions, subscription schedules, invoices and meter events, and reads the catalog for its daily check.",
      "docs/providers/stripe.md lists each key's permissions.",
    ]);
    const keys = {};
    for (const [name, question] of [["STRIPE_ADMIN_KEY", "The admin's Stripe restricted key"], ["STRIPE_WORKER_KEY", "The worker's Stripe restricted key"]]) {
      const key = await secret(name, question);
      const problem = stripeKeyProblem(name, key, s.STRIPE);
      if (problem) throw new Error(problem);
      if (key.startsWith("sk_")) console.log(`  ${name} is a secret key, which can do anything in the account: a restricted key with only the permissions it needs is safer.`);
      keys[name] = key;
    }
    const admin = await stripeAccountOf(keys.STRIPE_ADMIN_KEY);
    const worker = await stripeAccountOf(keys.STRIPE_WORKER_KEY);
    if (admin !== worker) throw new Error(`the admin's key belongs to Stripe account ${admin}, and the worker's to ${worker}: make both in the deployment's own account`);
    console.log(`  both keys belong to Stripe account ${admin}, in its ${s.STRIPE === "live" ? "live mode" : "sandbox"}`);
    return { ...keys, STRIPE_ACCOUNT_ID: admin };
  });
}

// The workflows a deployment needs. CodeQL and the landing link check are optional on a fork.
const NEEDED_WORKFLOWS = ["ci.yml", "runtime-images.yml", "replacement-platform.yml"];

/** The first line of what a command printed when it failed. */
function firstLine(result) {
  return (result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim().split("\n")[0];
}

async function githubSteps(run) {
  const s = run.settings;
  if (!s.STEP_GITHUB) return console.log("  skipped (STEP_GITHUB=no)");
  await step(run, "github.actions", `Check that the checks of ${s.REPO} are on`, async () => {
    // Reading the workflows needs only read access; turning them on needs admin rights, so that is
    // tried only for the ones that are really off.
    const listed = runTool("gh", ["api", `repos/${s.REPO}/actions/workflows?per_page=100`]);
    if (missingTool(listed)) return byHand([`GitHub CLI isn't installed. Open https://github.com/${s.REPO}/actions and check that CI is on:`, "if GitHub shows a button to enable the workflows, click it."]);
    let workflows = null;
    try {
      if (listed.status === 0) workflows = JSON.parse(listed.stdout).workflows ?? null;
    } catch {}
    const needed = (workflows ?? []).filter((workflow) => NEEDED_WORKFLOWS.includes(path.posix.basename(workflow.path ?? "")));
    const off = needed.filter((workflow) => workflow.state !== "active");
    if (needed.length && !off.length) {
      const others = workflows.filter((workflow) => workflow.state !== "active").map((workflow) => workflow.name);
      return console.log(`  = already on: ${needed.map((workflow) => workflow.name).join(", ")}${others.length ? ` (also off, and not needed: ${others.join(", ")})` : ""}`);
    }
    const problems = [];
    // A fork starts with Actions off for the whole repository, which shows as no workflows or as disabled_fork.
    if (!needed.length || off.some((workflow) => workflow.state === "disabled_fork")) {
      const result = runTool("gh", ["api", "-X", "PUT", `repos/${s.REPO}/actions/permissions`, "-F", "enabled=true"]);
      if (result.error || result.status !== 0) problems.push(firstLine(result));
    }
    for (const workflow of off.filter((item) => item.state !== "disabled_fork")) {
      const result = runTool("gh", ["api", "-X", "PUT", `repos/${s.REPO}/actions/workflows/${workflow.id}/enable`]);
      if (result.error || result.status !== 0) problems.push(`${workflow.name}: ${firstLine(result)}`);
    }
    if (!problems.length) return console.log(`  turned on: ${off.length ? off.map((workflow) => workflow.name).join(", ") : "Actions"}`);
    const why = listed.status !== 0 ? `GitHub CLI couldn't read the workflows of ${s.REPO} (${firstLine(listed)})` : `The checks are off, and turning them on needs admin rights on ${s.REPO} (${problems[0]})`;
    await byHand([`${why}.`, `Open https://github.com/${s.REPO}/actions as the repository's owner and enable the workflows,`, "or sign gh in as the owner (gh auth login) and redo github.actions."]);
  });
  await step(run, "github.brand", `Check that ${s.REPO}@${s.BRANCH} has brands/${s.BRAND}`, async () => {
    const result = runTool("gh", ["api", `repos/${s.REPO}/contents/brands/${s.BRAND}/brand.json?ref=${s.BRANCH}`, "--jq", ".name"]);
    if (missingTool(result)) return byHand([`GitHub CLI isn't installed. Check that https://github.com/${s.REPO}/tree/${s.BRANCH}/brands/${s.BRAND} exists`, "(click Sync fork first if it's missing): BRAND_REQUIRED stops the admin and the worker without it."]);
    if (result.status !== 0 && /auth login|not logged in|authentication|HTTP 401/i.test(`${result.stderr ?? ""}`)) throw new Error(`gh isn't signed in, so it couldn't check ${s.REPO}@${s.BRANCH}: run gh auth login, then run again`);
    if (result.status !== 0) throw new Error(`${s.REPO}@${s.BRANCH} has no brands/${s.BRAND}/brand.json. Click Sync fork on GitHub, or add the brand (guide 3.6), then run again`);
  });
}

async function openaiSteps(run) {
  const s = run.settings;
  if (!s.STEP_OPENAI) {
    await step(run, "openai.manual", "OpenAI project and key, typed in (STEP_OPENAI=no)", async () => ({
      OPENAI_PROJECT_ID: await value("OPENAI_PROJECT_ID", "The OpenAI project's ID (proj_...)", looksLike.project),
      OPENAI_API_KEY: await secret("OPENAI_API_KEY", "The project's API key (sk-...)", undefined, { envToo: false }),
    }));
    return;
  }
  await step(run, "openai.project", `OpenAI project "${nameFor(run, "OPENAI_PROJECT_NAME")}"`, async () => {
    // A key or project given in the secrets file is used as it is: the key belongs to that project.
    if (fromFile("OPENAI_PROJECT_ID") || fromFile("OPENAI_API_KEY")) {
      return { OPENAI_PROJECT_ID: await value("OPENAI_PROJECT_ID", "The ID of the OpenAI project your OPENAI_API_KEY belongs to (proj_...)", looksLike.project), OPENAI_PROJECT_NAME: undefined, OPENAI_ACCOUNT_NAME: undefined };
    }
    // The project an earlier run used, while it's active: OpenAI's project names aren't unique.
    const saved = v(run, "OPENAI_PROJECT_ID") && (await openai(`/organization/projects/${v(run, "OPENAI_PROJECT_ID")}`).catch((error) => (error.status === 404 ? null : Promise.reject(error))));
    if (saved && saved.status !== "archived") {
      console.log(`  = ${saved.id} ("${saved.name}")`);
      return { OPENAI_PROJECT_ID: saved.id, OPENAI_PROJECT_NAME: saved.name };
    }
    const name = nameFor(run, "OPENAI_PROJECT_NAME");
    const list = await openai("/organization/projects?limit=100");
    const found = only((list?.data ?? []).filter((project) => project.name === name && project.status !== "archived"), `OpenAI has active projects named "${name}"`);
    if (found) {
      console.log(`  = ${found.id}`);
      return { OPENAI_PROJECT_ID: found.id, OPENAI_PROJECT_NAME: name };
    }
    const project = await openai("/organization/projects", { method: "POST", body: { name } });
    return { OPENAI_PROJECT_ID: project.id, OPENAI_PROJECT_NAME: name };
  });
  await step(run, "openai.key", "Its API key, owned by a service account", async () => {
    if (fromFile("OPENAI_API_KEY") || fromFile("OPENAI_PROJECT_ID")) return { OPENAI_API_KEY: await secret("OPENAI_API_KEY", "The project's API key (sk-...)", undefined, { envToo: false }), OPENAI_ACCOUNT_NAME: undefined };
    const base = `/organization/projects/${v(run, "OPENAI_PROJECT_ID")}/service_accounts`;
    const name = nameFor(run, "OPENAI_ACCOUNT_NAME");
    const old = only(((await openai(`${base}?limit=100`))?.data ?? []).filter((account) => account.name === name), `The OpenAI project has service accounts named "${name}"`);
    if (old) {
      // OpenAI shows a key only once. An earlier run made it: take it from Railway if it got there.
      const onRailway = await railwayVariable(run, "admin", "OPENAI_API_KEY");
      if (onRailway) return { OPENAI_API_KEY: onRailway, OPENAI_ACCOUNT_NAME: name };
      await confirm(`The service account "${name}" exists, but its key isn't saved anywhere this script can read. Replace it with a new one? Its old key stops working.`);
      await openai(`${base}/${old.id}`, { method: "DELETE" });
    }
    const account = await openai(base, { method: "POST", body: { name } });
    if (!account?.api_key?.value) throw new Error("OpenAI made the service account but sent no key");
    return { OPENAI_API_KEY: account.api_key.value, OPENAI_ACCOUNT_NAME: name };
  });
  await step(run, "openai.limits", "GPT-Live SIP and the spending limit", () => byHand([
    `In the OpenAI project ${v(run, "OPENAI_PROJECT_ID") ?? "made above"}${v(run, "OPENAI_PROJECT_NAME") ? ` ("${v(run, "OPENAI_PROJECT_NAME")}")` : ""}:`,
    "1. Make sure the project can take GPT-Live SIP calls (guide 3.2, \"Phone calls (SIP)\"). OpenAI documents no switch for it, so the first test call is the check.",
    "2. Limits > Spend: a monthly spend limit, Enforce a hard limit on, and alerts below it (guide 3.2, steps 12 and 13).",
  ]));
}

async function twilioSteps(run) {
  const s = run.settings;
  if (!s.STEP_TWILIO) {
    await step(run, "twilio.manual", "Twilio subaccount and trunk, typed in (STEP_TWILIO=no)", async () => ({
      TWILIO_ACCOUNT_SID: await value("TWILIO_ACCOUNT_SID", "The subaccount's Account SID (AC...)", looksLike.account),
      TWILIO_AUTH_TOKEN: await secret("TWILIO_AUTH_TOKEN", "The subaccount's Auth Token", undefined, { envToo: false }),
      TWILIO_SIP_TRUNK_SID: await value("TWILIO_SIP_TRUNK_SID", "The trunk's SID (TK...)", looksLike.trunk),
    }));
    return;
  }
  await step(run, "twilio.subaccount", `Twilio subaccount "${nameFor(run, "TWILIO_SUBACCOUNT_NAME")}"`, async () => {
    // An account given in the secrets file is used instead of a new subaccount; a trunk given there must be in it.
    if (fromFile("TWILIO_ACCOUNT_SID") || fromFile("TWILIO_AUTH_TOKEN") || fromFile("TWILIO_SIP_TRUNK_SID")) {
      return {
        TWILIO_ACCOUNT_SID: await value("TWILIO_ACCOUNT_SID", "The Twilio account's SID (AC...)", looksLike.account),
        TWILIO_AUTH_TOKEN: await secret("TWILIO_AUTH_TOKEN", "That account's Auth Token", undefined, { envToo: false }),
        TWILIO_SUBACCOUNT_NAME: undefined,
      };
    }
    // The subaccount an earlier run used, while it's open: Twilio's names aren't unique.
    const saved = v(run, "TWILIO_ACCOUNT_SID") && (await twilioMain(`/Accounts/${v(run, "TWILIO_ACCOUNT_SID")}.json`).catch((error) => (error.status === 404 ? null : Promise.reject(error))));
    const name = nameFor(run, "TWILIO_SUBACCOUNT_NAME");
    let found = saved && saved.status !== "closed" ? saved : undefined;
    if (!found) {
      const list = await twilioMain(`/Accounts.json?FriendlyName=${encodeURIComponent(name)}&PageSize=20`);
      found = only((list?.accounts ?? []).filter((account) => account.friendly_name === name && account.status !== "closed"), `Twilio has subaccounts named "${name}"`);
    }
    if (found) console.log(`  = ${found.sid}${found.friendly_name !== name ? ` ("${found.friendly_name}")` : ""}`);
    const account = found ?? (await twilioMain("/Accounts.json", { method: "POST", form: { FriendlyName: name } }));
    if (!account?.auth_token) throw new Error(`Twilio didn't send the Auth Token of subaccount ${account?.sid}`);
    return { TWILIO_ACCOUNT_SID: account.sid, TWILIO_AUTH_TOKEN: account.auth_token, TWILIO_SUBACCOUNT_NAME: account.friendly_name ?? name };
  });
  await step(run, "twilio.trunk", "The SIP trunk to OpenAI: Secure Trunking, transfers, caller ID of the transferee", async () => {
    if (fromFile("TWILIO_SIP_TRUNK_SID")) return { TWILIO_SIP_TRUNK_SID: await value("TWILIO_SIP_TRUNK_SID", "The trunk's SID (TK...)", looksLike.trunk), TWILIO_TRUNK_NAME: undefined };
    // The trunk an earlier run used, else the one with this name.
    let found = v(run, "TWILIO_SIP_TRUNK_SID") && (await twilioSub(run, URLS.trunking, `/Trunks/${v(run, "TWILIO_SIP_TRUNK_SID")}`).catch((error) => (error.status === 404 ? null : Promise.reject(error))));
    const name = nameFor(run, "TWILIO_TRUNK_NAME");
    if (!found) found = only(((await twilioSub(run, URLS.trunking, "/Trunks?PageSize=100"))?.trunks ?? []).filter((trunk) => trunk.friendly_name === name), `The subaccount has trunks named "${name}"`);
    // Found: its settings are set again, under its own name, so a trunk changed by hand is put back as the guide wants it.
    const form = { FriendlyName: found?.friendly_name ?? name, Secure: "true", TransferMode: "enable-all", TransferCallerId: "from-transferee", CnamLookupEnabled: "false" };
    if (found) console.log(`  = ${found.sid}, settings checked`);
    const trunk = await twilioSub(run, URLS.trunking, found ? `/Trunks/${found.sid}` : "/Trunks", { method: "POST", form });
    return { TWILIO_SIP_TRUNK_SID: trunk?.sid ?? found.sid, TWILIO_TRUNK_NAME: form.FriendlyName };
  });
  await step(run, "twilio.origination", "Its origination URI to the OpenAI project", async () => {
    const trunk = v(run, "TWILIO_SIP_TRUNK_SID");
    const sipUrl = `sip:${v(run, "OPENAI_PROJECT_ID")}@sip.api.openai.com;transport=tls`;
    const list = await twilioSub(run, URLS.trunking, `/Trunks/${trunk}/OriginationUrls`);
    const urls = list?.origination_urls ?? [];
    const form = { FriendlyName: "OpenAI GPT-Live", SipUrl: sipUrl, Priority: "10", Weight: "10", Enabled: "true" };
    // Checked first: with a second URI, such as one to an older project, Twilio sends some calls there.
    if (urls.length > 1) throw new Error(`trunk ${trunk} has ${urls.length} origination URIs. Keep exactly one, to ${sipUrl}, in Twilio's console (guide 3.3, step 11), then run again`);
    if (urls.some((url) => url.sip_url === sipUrl && url.enabled !== false)) return console.log("  = already there");
    if (urls.length === 1) console.log(`  ~ the trunk's origination URI pointed to ${urls[0].sip_url}; now to the OpenAI project`);
    await twilioSub(run, URLS.trunking, urls.length === 1 ? `/Trunks/${trunk}/OriginationUrls/${urls[0].sid}` : `/Trunks/${trunk}/OriginationUrls`, { method: "POST", form });
  });
  await step(run, "twilio.console", "Twilio's console-only steps", () => byHand([
    "1. Voice > Settings > Geo permissions: allow each country whose phones take transfers.",
    "2. The business profile and US texting registration, if not done yet: Twilio reviews them for days (guide 3.3, steps 3 and 14).",
  ]));
}

async function resendSteps(run) {
  const s = run.settings;
  if (!s.STEP_RESEND) {
    await step(run, "resend.manual", "Resend's sending key, typed in (STEP_RESEND=no)", async () => ({ SMTP_PASSWORD: await secret("SMTP_PASSWORD", "The Resend API key (re_...)", undefined, { envToo: false }) }));
    return;
  }
  await step(run, "resend.domain", `Resend domain ${s.EMAIL_DOMAIN}`, async () => {
    const list = await resend("/domains");
    const found = list?.data?.find((domain) => domain.name === s.EMAIL_DOMAIN);
    if (found) console.log(`  = ${found.id}${found.status ? ` (${found.status})` : ""}`);
    const domain = found ? await resend(`/domains/${found.id}`) : await resend("/domains", { method: "POST", body: { name: s.EMAIL_DOMAIN, region: s.RESEND_REGION } });
    return { RESEND_DOMAIN_ID: domain.id, RESEND_RECORDS: domain.records ?? [] };
  });
  await step(run, "resend.dns", "Its DNS records", async () => {
    const records = v(run, "RESEND_RECORDS").map((record) => ({
      type: record.type,
      name: fullName(record.name, s.EMAIL_DOMAIN, s.CLOUDFLARE_ZONE),
      content: record.value,
      ...(record.priority !== undefined ? { priority: Number(record.priority) } : {}),
    }));
    if (s.CLOUDFLARE_ZONE) {
      const dmarc = `_dmarc.${s.EMAIL_DOMAIN}`;
      records.push({ type: "TXT", name: dmarc, content: `v=DMARC1; p=none; rua=mailto:${s.OPERATOR_EMAIL}`, onlyIfNone: true });
    }
    await dnsRecords(run, records);
  });
  await step(run, "resend.verify", "Ask Resend to check the records", async () => {
    await resend(`/domains/${v(run, "RESEND_DOMAIN_ID")}/verify`, { method: "POST", body: {} });
    console.log("  Resend checks in the background; the domain's page shows Verified once DNS has spread.");
  });
  await step(run, "resend.key", "A sending key for that domain only", async () => {
    if (fromFile("SMTP_PASSWORD")) return { SMTP_PASSWORD: await secret("SMTP_PASSWORD", "The Resend API key (re_...)", undefined, { envToo: false }), RESEND_KEY_NAME: undefined };
    const name = nameFor(run, "RESEND_KEY_NAME");
    const old = only(((await resend("/api-keys"))?.data ?? []).filter((key) => key.name === name), `Resend has keys named "${name}"`);
    if (old) {
      // Resend shows a key only once. An earlier run made it: take it from Railway if it got there.
      const onRailway = await railwayVariable(run, "worker", "SMTP_PASSWORD");
      if (onRailway) return { SMTP_PASSWORD: onRailway, RESEND_KEY_NAME: name };
      await confirm(`Resend has a key named "${name}", but it isn't saved anywhere this script can read. Replace it with a new one? The old key stops working.`);
      await resend(`/api-keys/${old.id}`, { method: "DELETE" });
    }
    const key = await resend("/api-keys", { method: "POST", body: { name, permission: "sending_access", domain_id: v(run, "RESEND_DOMAIN_ID") } });
    return { SMTP_PASSWORD: key.token, RESEND_KEY_NAME: name };
  });
}

/** A record name from Resend as a full host name in the zone. Resend's names leave out the zone, and may or may not include the email subdomain. */
function fullName(name, emailDomain, zone) {
  if (!zone) return name || "@";
  if (!name || name === "@") return emailDomain;
  if (name === zone || name.endsWith(`.${zone}`)) return name;
  const sub = emailDomain.endsWith(`.${zone}`) ? emailDomain.slice(0, -(zone.length + 1)) : "";
  if (sub && (name === sub || name.endsWith(`.${sub}`))) return `${name}.${zone}`;
  return sub ? `${name}.${emailDomain}` : `${name}.${zone}`;
}

async function zoneId(run) {
  const name = run.settings.CLOUDFLARE_ZONE.toLowerCase();
  // Kept with the zone's name, so a changed CLOUDFLARE_ZONE is looked up again (state files from before kept only the ID).
  if (v(run, "CLOUDFLARE_ZONE_ID") && (v(run, "CLOUDFLARE_ZONE_NAME") ?? name) === name) return v(run, "CLOUDFLARE_ZONE_ID");
  const zones = await cloudflare(`/zones?name=${encodeURIComponent(name)}`);
  if (!zones?.length) throw new Error(`the Cloudflare token can't see a zone named ${run.settings.CLOUDFLARE_ZONE}: check the name, and that the token's Zone Resources include it`);
  Object.assign(run.state.values, { CLOUDFLARE_ZONE_ID: zones[0].id, CLOUDFLARE_ZONE_NAME: name });
  save(run);
  return zones[0].id;
}

/** Creates each record in Cloudflare, DNS only, or prints them all when no zone is set. */
async function dnsRecords(run, records) {
  if (!run.settings.CLOUDFLARE_ZONE) {
    return byHand(["Create these records at the DNS provider, DNS only (not proxied), with the names as Resend's domain page shows them:", ...records.map((record) => `${record.type.padEnd(5)} ${record.name}  ${record.priority !== undefined ? `${record.priority} ` : ""}${record.content}`)]);
  }
  const zone = await zoneId(run);
  const zoneName = run.settings.CLOUDFLARE_ZONE.toLowerCase();
  for (const record of records) {
    // Cloudflare's lookups need the full name, though it accepts a short one when making a record: a short name
    // would never be found again, and a second run would add it twice.
    record.name = record.name.toLowerCase().replace(/\.$/, "");
    if (record.name !== zoneName && !record.name.endsWith(`.${zoneName}`)) record.name = record.name === "@" ? zoneName : `${record.name}.${zoneName}`;
    // A CNAME target may come with a trailing dot, and host names are compared without case.
    const norm = (text) => (record.type === "CNAME" ? text.replace(/\.$/, "").toLowerCase() : text);
    if (record.type === "CNAME") record.content = norm(record.content);
    const existing = (await cloudflare(`/zones/${zone}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`)) ?? [];
    const same = (item) => norm(item.content.replace(/^"|"$/g, "")) === record.content && (record.priority === undefined || item.priority === record.priority);
    if (existing.some((item) => same(item) || (record.onlyIfNone && item.content.includes("v=DMARC1")))) {
      console.log(`  = ${record.type} ${record.name}`);
      continue;
    }
    if (record.type === "CNAME" && !existing.length) {
      // A name with a CNAME can hold no other address, so an A or AAAA record there is replaced, after asking.
      const others = ((await cloudflare(`/zones/${zone}/dns_records?name=${encodeURIComponent(record.name)}`)) ?? []).filter((item) => item.type === "A" || item.type === "AAAA");
      if (others.length) {
        await confirm(`${record.name} has ${others.map((item) => `${item.type} ${item.content}`).join(", ")} now. Replace ${others.length === 1 ? "it" : "them"} with a CNAME to ${record.content}? Visitors to that address then reach this deployment.`);
        for (const item of others) await cloudflare(`/zones/${zone}/dns_records/${item.id}`, { method: "DELETE" });
        console.log(`  - ${others.map((item) => item.type).join(", ")} ${record.name} (replaced by the CNAME)`);
      }
    }
    const { onlyIfNone, ...body } = record;
    // A name holds one CNAME, one DKIM key, one SPF record and one Railway check: an old one is updated, not doubled.
    const kind = (content) => (content.includes("v=spf1") ? "spf" : content.includes("railway-verify=") ? "railway" : record.name.includes("._domainkey.") ? "dkim" : null);
    const replace = record.type === "CNAME" ? existing[0] : record.type === "TXT" && kind(record.content) ? existing.find((item) => kind(item.content) === kind(record.content)) : null;
    if (replace) {
      if (record.type === "CNAME") await confirm(`${record.name} points to ${replace.content} now. Point it to ${record.content} instead? Visitors to that address then reach this deployment.`);
      await cloudflare(`/zones/${zone}/dns_records/${replace.id}`, { method: "PATCH", body: { ...body, ttl: 1, proxied: false } });
      console.log(`  ~ ${record.type} ${record.name} (updated)`);
      continue;
    }
    await cloudflare(`/zones/${zone}/dns_records`, { method: "POST", body: { ...body, ttl: 1, proxied: false } });
    console.log(`  + ${record.type} ${record.name}`);
  }
}

// ---------------------------------------------------------------- Railway

const Q = {
  projectCreate: "mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }",
  project: "query project($id: String!) { project(id: $id) { id name deletedAt services { edges { node { id name } } } environments { edges { node { id name } } } volumes { edges { node { id name volumeInstances { edges { node { mountPath serviceId environmentId } } } } } } buckets { edges { node { id name } } } } }",
  workspaces: "query workspaces { me { workspaces { id name } } }",
  projects: "query projects($workspaceId: String) { projects(workspaceId: $workspaceId) { edges { node { id name deletedAt } } } }",
  domains: "query domains($projectId: String!, $environmentId: String!, $serviceId: String!) { domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { id domain targetPort } customDomains { id domain status { verified certificateStatus verificationDnsHost verificationToken dnsRecords { recordType fqdn requiredValue } } } } }",
  readVariables: "query variables($projectId: String!, $environmentId: String!, $serviceId: String!) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true) }",
  serviceCreate: "mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }",
  volumeCreate: "mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }",
  instanceUpdate: "mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }",
  domainCreate: "mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain } }",
  customDomainCreate: "mutation customDomainCreate($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id domain status { verified certificateStatus verificationDnsHost verificationToken dnsRecords { recordType fqdn requiredValue } } } }",
  variables: "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }",
  connect: "mutation serviceConnect($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }",
  templateGenerate: "mutation templateGenerate($input: TemplateGenerateInput!) { templateGenerate(input: $input) { id code name status } }",
  template: "query template($code: String!) { template(code: $code) { id code name serializedConfig } }",
  templateDeploy: "mutation templateDeployV2($input: TemplateDeployV2Input!) { templateDeployV2(input: $input) { projectId workflowId } }",
  triggerCreate: "mutation deploymentTriggerCreate($input: DeploymentTriggerCreateInput!) { deploymentTriggerCreate(input: $input) { id } }",
  triggers: "query deploymentTriggers($projectId: String!, $environmentId: String!, $serviceId: String!) { deploymentTriggers(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { edges { node { id repository branch } } } }",
  workflowStatus: "query workflowStatus($workflowId: String!) { workflowStatus(workflowId: $workflowId) { status error } }",
  instance: "query serviceInstance($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id } }",
  deployService: "mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }",
  redeploy: "mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }",
  deploymentRemove: "mutation deploymentRemove($id: String!) { deploymentRemove(id: $id) }",
  deployments: "query deployments($input: DeploymentListInput!) { deployments(first: 1, input: $input) { edges { node { id status } } } }",
};

/** Waits for a Railway workflow, such as a template deploy, to finish. */
async function waitForWorkflow(workflowId, what) {
  if (!workflowId) return;
  const pause = Number(process.env.BOOTSTRAP_POLL_MS ?? 3000);
  for (let tries = 0; tries < 200; tries += 1) {
    const { workflowStatus } = await railway(Q.workflowStatus, { workflowId });
    if (workflowStatus?.status === "Complete") return;
    if (workflowStatus?.status === "Error") throw new Error(`Railway couldn't finish ${what}: ${workflowStatus.error ?? "no reason given"}`);
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error(`Railway was still working on ${what} after ${Math.round((200 * pause) / 60000)} minutes. Check the project in Railway, then run again`);
}

/** A service's newest deployment in this environment, or undefined. */
async function latestDeployment(run, serviceId) {
  const { deployments } = await railway(Q.deployments, { input: { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId } });
  return deployments?.edges?.[0]?.node;
}

/**
 * Waits for a service's deployment to succeed: the one with the id given, or else the first one newer than
 * `after` (the newest before the change, so a slow or wrong clock doesn't matter). A failed deployment throws
 * an error marked `deployFailed`, so callers can tell it from a call Railway refused.
 */
async function waitForDeployment(run, service, serviceId, { id, after } = {}) {
  const pause = Number(process.env.BOOTSTRAP_POLL_MS ?? 3000);
  for (let tries = 0; tries < 300; tries += 1) {
    const latest = await latestDeployment(run, serviceId);
    const mine = id ? (latest?.id === id ? latest : undefined) : latest && latest.id !== after ? latest : undefined;
    if (mine?.status === "SUCCESS") return;
    if (["FAILED", "CRASHED", "REMOVED"].includes(mine?.status)) {
      throw Object.assign(new Error(`${service}'s deployment ended ${mine.status.toLowerCase()}: its logs in Railway say why`), { deployFailed: true });
    }
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw Object.assign(new Error(`${service} still wasn't deployed after ${Math.round((300 * pause) / 60000)} minutes. Check it in Railway, then run again`), { deployFailed: true });
}

const SERVICES = [
  { name: "Postgres", image: "pgvector/pgvector:pg16" },
  { name: "Redis", image: "redis:7-alpine" },
  { name: "migrate" },
  { name: "admin" },
  { name: "worker" },
];

async function projectView(run, id = v(run, "RAILWAY_PROJECT_ID")) {
  const again = `Run: node devops/bootstrap.mjs redo ${run.file} railway.project, then up, then connect`;
  let project;
  try {
    ({ project } = await railway(Q.project, { id }));
  } catch (error) {
    if (error.graphql && /not found/i.test(error.message)) throw new Stop(`Railway has no project ${id}, which ${run.stateFile} names: it was deleted. ${again}`);
    throw error;
  }
  if (!project) throw new Stop(`Railway has no project ${id}, which ${run.stateFile} names: it was deleted. ${again}`);
  // Railway keeps answering for a deleted project for about two days: never work on one.
  if (project.deletedAt) throw new Stop(`the Railway project ${project.name} that ${run.stateFile} names is being deleted (Railway removes it after ${String(project.deletedAt).slice(0, 10)}). ${again}`);
  return {
    id,
    name: project.name,
    services: Object.fromEntries(project.services.edges.map(({ node }) => [node.name, node.id])),
    environments: Object.fromEntries(project.environments.edges.map(({ node }) => [node.name, node.id])),
    volumes: project.volumes.edges.flatMap(({ node }) => node.volumeInstances.edges.map(({ node: instance }) => instance)),
    buckets: project.buckets.edges.map(({ node }) => node.name),
  };
}

/** The workspaces the Railway token can reach, as a sentence for an error or doctor. */
async function workspaceList(auth) {
  try {
    const data = auth
      ? (await http("Railway", URLS.railway, { method: "POST", headers: { Authorization: `Bearer ${auth}` }, body: { query: Q.workspaces } }))?.data
      : await railway(Q.workspaces);
    const list = data?.me?.workspaces ?? [];
    if (list.length === 1) return `Put RAILWAY_WORKSPACE_ID=${list[0].id} (${list[0].name}) in the settings file.`;
    if (list.length) return `Put one of these in the settings file as RAILWAY_WORKSPACE_ID: ${list.map((item) => `${item.id} (${item.name})`).join(", ")}.`;
  } catch {}
  return "Copy it from the workspace's Settings, General tab in Railway (Workspace ID).";
}

/** This run's Railway project if it exists, by its saved ID or by name; never creates it. */
async function findProject(run) {
  if (v(run, "RAILWAY_PROJECT_ID")) return v(run, "RAILWAY_PROJECT_ID");
  const s = run.settings;
  const name = nameFor(run, "RAILWAY_PROJECT_NAME");
  const { projects } = await railway(Q.projects, s.RAILWAY_WORKSPACE_ID ? { workspaceId: s.RAILWAY_WORKSPACE_ID } : {});
  // A deleted project stays listed until Railway removes it for good, days later: never reuse one.
  const matches = projects.edges.map(({ node }) => node).filter((project) => project.name === name && !project.deletedAt);
  if (matches.length > 1) throw new Error(`Railway has ${matches.length} projects named ${name}. Delete or rename the extra ones, then run again`);
  return matches[0]?.id ?? null;
}

const variableCache = {};
/**
 * A variable's current value on one of this run's Railway services, or undefined. Used to pick
 * up a value made in an earlier run whose state file was lost, so it isn't made again.
 */
async function railwayVariable(run, service, key) {
  // "Not set" only after a read that worked: a failed read stops the run, since taking it for "not set" would make a
  // new password or key, or drop the admin's other platform keys.
  if (!(service in variableCache)) {
    let read = {};
    const projectId = await findProject(run);
    if (projectId) {
      const view = await projectView(run, projectId);
      const environmentId = v(run, "RAILWAY_ENVIRONMENT_ID") ?? view.environments[run.settings.ENVIRONMENT];
      const serviceId = view.services[service];
      if (environmentId && serviceId) read = (await railway(Q.readVariables, { projectId, environmentId, serviceId })).variables ?? {};
    }
    variableCache[service] = read;
  }
  const value = variableCache[service][key];
  if (typeof value !== "string" || !value || value.includes("${{")) return undefined;
  console.log(`  ${key}: found on Railway's ${service} service`);
  return hide(value);
}

/**
 * Railway reports the template deploy complete a few seconds before the project shows what it made (seen on the
 * first real up from a template: the address step got "ServiceInstance not found", and the volume steps made
 * two spare volumes because the template's own weren't listed yet). So wait until every service, its instance
 * in this environment and every volume the template holds can be read.
 */
async function waitForTemplateApplied(run, config) {
  const pause = Number(process.env.BOOTSTRAP_POLL_MS ?? 3000);
  const services = Object.values(config.services ?? {}).filter((service) => service?.name);
  const mounts = services.reduce((sum, service) => sum + Object.keys(service.volumeMounts ?? {}).length, 0);
  let waiting = "the services";
  for (let tries = 0; tries < 60; tries += 1) {
    const view = await projectView(run);
    const missing = services.filter((service) => !view.services[service.name]);
    if (missing.length) waiting = missing.map((service) => service.name).join(", ");
    else if (view.volumes.filter((volume) => volume.environmentId === v(run, "RAILWAY_ENVIRONMENT_ID")).length < mounts) waiting = "the volumes";
    else {
      const unread = [];
      for (const service of services) {
        try {
          await railway(Q.instance, { serviceId: view.services[service.name], environmentId: v(run, "RAILWAY_ENVIRONMENT_ID") });
        } catch {
          unread.push(service.name);
        }
      }
      if (!unread.length) return;
      waiting = `${unread.join(", ")} in ${run.settings.ENVIRONMENT}`;
    }
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error(`Railway still didn't show ${waiting} from the template after ${Math.round((60 * pause) / 1000)} seconds. Check the project in Railway, then run again`);
}

async function railwaySteps(run) {
  const s = run.settings;
  // A project deleted since the last run must stop the run here, before the steps already done are skipped over it.
  if (!dryRun && v(run, "RAILWAY_PROJECT_ID")) await projectView(run);
  await step(run, "railway.project", `Railway project "${nameFor(run, "RAILWAY_PROJECT_NAME")}" with the environment ${s.ENVIRONMENT}`, async () => {
    // Kept at once, with its name, so a run that stops after this call never makes a second project.
    if (!v(run, "RAILWAY_PROJECT_ID")) {
      const name = nameFor(run, "RAILWAY_PROJECT_NAME");
      const existing = await findProject(run);
      if (existing) console.log(`  found the project ${name}; using it`);
      if (!existing && !s.RAILWAY_WORKSPACE_ID) throw new Error(`RAILWAY_WORKSPACE_ID is empty, and Railway needs it to make a project. ${await workspaceList()}`);
      const id = existing ?? (await railway(Q.projectCreate, { input: { name, defaultEnvironmentName: s.ENVIRONMENT, ...(s.RAILWAY_WORKSPACE_ID ? { workspaceId: s.RAILWAY_WORKSPACE_ID } : {}) } })).projectCreate.id;
      Object.assign(run.state.values, { RAILWAY_PROJECT_ID: id, RAILWAY_PROJECT_NAME: name });
      save(run);
    }
    const view = await projectView(run);
    const environmentId = view.environments[s.ENVIRONMENT] ?? Object.values(view.environments)[0];
    if (!environmentId) throw new Error("Railway made the project without an environment");
    // Its name as Railway has it, in case someone renamed it there.
    return { RAILWAY_ENVIRONMENT_ID: environmentId, RAILWAY_PROJECT_NAME: view.name };
  });
  if (s.RAILWAY_TEMPLATE && !run.template) {
    // The template deploy starts Postgres and Redis at once, so their passwords must be in it: without one,
    // Postgres refuses to start and restarts, and on the first real run such a restart overlapped the next
    // deployment on the same volume and shut it down. So the secrets are settled before the template.
    await secretsStep(run);
    await step(run, "railway.template", `The services, volumes and settings from the template ${s.RAILWAY_TEMPLATE}`, async () => {
      const view = await projectView(run);
      if (SERVICES.some((service) => view.services[service.name])) return console.log("  = the project has its services already, so the template isn't deployed again");
      const { template } = await railway(Q.template, { code: s.RAILWAY_TEMPLATE });
      if (!template) throw new Error(`Railway has no template with the code ${s.RAILWAY_TEMPLATE}. Run template again, or empty RAILWAY_TEMPLATE`);
      // Passed through whole, as the Railway CLI does: only the values are filled in, from the template's
      // defaults. Railway keeps only references as defaults and drops plain values such as PORT (seen on the
      // first real template), so those come from this deployment's own variables, as the variable step sets them.
      const config = template.serializedConfig ?? {};
      const known = perService(variableSections(run));
      for (const service of Object.values(config.services ?? {})) {
        for (const [key, variable] of Object.entries(service?.variables ?? {})) {
          if (!variable || variable.value !== undefined) continue;
          const value = variable.defaultValue || known[service.name]?.[key];
          if (value) variable.value = value;
        }
        // The template holds no secrets, so the databases' passwords are added here (see secretsStep above).
        if (service?.name === "Postgres" || service?.name === "Redis") {
          service.variables ??= {};
          for (const [key, value] of Object.entries(known[service.name] ?? {})) if (value && !service.variables[key]) service.variables[key] = { value, isOptional: true };
        }
      }
      const deploy = async (serializedConfig) => (await railway(Q.templateDeploy, { input: {
        templateId: template.id, serializedConfig, projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"),
      } })).templateDeployV2;
      // The template names the repository it was made from. Its code services are deployed without it, so they
      // wait for the connect steps at the end (migrate first, after the secrets), as they do without a template.
      const repoServices = (cfg) => Object.values(cfg.services ?? {}).filter((service) => service?.source?.repo);
      const withoutSource = structuredClone(config);
      for (const service of repoServices(withoutSource)) delete service.source;
      // Railway may refuse the deploy call, or accept it and fail the deploy afterwards (seen on the first
      // real up from a template: "migrate does not have a source"). Either way, deploy again with the source.
      const deployAndWait = async (serializedConfig) => waitForWorkflow((await deploy(serializedConfig))?.workflowId, `the template ${s.RAILWAY_TEMPLATE}`);
      try {
        await deployAndWait(withoutSource);
      } catch (error) {
        if (!repoServices(config).length || !/\bsource\b/i.test(error.message)) throw error;
        const partly = await projectView(run);
        if (SERVICES.some((service) => partly.services[service.name])) throw new Error(`${error.message}. Railway made some of the services anyway; check the project, then run again`);
        console.log(`  Railway wants the code services' source in the deploy (${String(error.message).split("\n")[0]}), so they get ${s.REPO}@${s.BRANCH}.`);
        console.log("  They start building now and fail until the secrets are set: that's expected, and the connect steps deploy them again.");
        for (const service of repoServices(config)) {
          // Keep the template's own form: a full GitHub address, or owner/name.
          service.source.repo = /^https?:\/\//.test(service.source.repo) ? `https://github.com/${s.REPO}` : s.REPO;
          if ("branch" in service.source) service.source.branch = s.BRANCH;
        }
        await deployAndWait(config);
      }
      await waitForTemplateApplied(run, config);
      const made = await projectView(run);
      console.log(`  made ${SERVICES.filter((service) => made.services[service.name]).map((service) => service.name).join(", ") || "no services with the expected names"}; the next steps add anything it left out`);
    });
  }
  await step(run, "railway.services", "Services Postgres, Redis, migrate, admin and worker", async () => {
    const view = await projectView(run);
    const ids = {};
    for (const service of SERVICES) {
      if (view.services[service.name]) {
        ids[service.name] = view.services[service.name];
        console.log(`  = ${service.name}`);
        continue;
      }
      const input = { projectId: v(run, "RAILWAY_PROJECT_ID"), name: service.name, ...(service.image ? { source: { image: service.image } } : {}) };
      ids[service.name] = (await railway(Q.serviceCreate, { input })).serviceCreate.id;
    }
    return { RAILWAY_SERVICE_IDS: ids };
  });
  const id = (name) => v(run, "RAILWAY_SERVICE_IDS")?.[name];
  for (const [service, mountPath] of [["Postgres", "/var/lib/postgresql/data"], ["Redis", "/data"]]) {
    await step(run, `railway.volume.${service}`, `A volume on ${service} at ${mountPath}`, async () => {
      const view = await projectView(run);
      const existing = view.volumes.find((volume) => volume.serviceId === id(service) && volume.environmentId === v(run, "RAILWAY_ENVIRONMENT_ID"));
      if (existing) {
        if (existing.mountPath !== mountPath) throw new Error(`${service} already has a volume, mounted at ${existing.mountPath}. Change its mount path to ${mountPath} in Railway, then run again`);
        return console.log(`  = already there`);
      }
      await railway(Q.volumeCreate, { input: { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: id(service), mountPath } });
    });
  }
  await step(run, "railway.bucket", `The bucket "Bucket" in ${s.BUCKET_REGION}`, async () => {
    if ((await projectView(run)).buckets.includes("Bucket")) return console.log("  = already there");
    // In a folder of its own: `railway link` remembers a project per folder, and in the repository folder it would aim
    // later railway commands typed there at this project.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-railway-"));
    try {
      const link = runTool(RAILWAY_CLI, ["link", "--project", v(run, "RAILWAY_PROJECT_ID"), "--environment", s.ENVIRONMENT], { env: cliEnv(), cwd });
      const made = !missingTool(link) && link.status === 0 && runTool(RAILWAY_CLI, ["bucket", "create", "Bucket", "--region", s.BUCKET_REGION, "--json"], { env: cliEnv(), cwd });
      if (!made || made.status !== 0) {
        const reason = String(link.error?.message || (made && made.stderr) || link.stderr || "").trim().split("\n")[0];
        const why = missingTool(link) ? "The Railway CLI isn't installed (npm install --global @railway/cli), so it couldn't make the bucket." : `The Railway CLI couldn't make the bucket${reason ? ` (${reason})` : ""}.`;
        await byHand([why, `In the project's canvas: create a Bucket in region ${s.BUCKET_REGION}, named exactly Bucket (guide 4.4, step 11).`]);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  const settings = [
    ["Redis", { startCommand: REDIS_START }],
    ["migrate", { startCommand: "true", restartPolicyType: "NEVER", dockerfilePath: "Dockerfile.migrator", rootDirectory: "/" }],
    ["admin", { healthcheckPath: "/api/health/ready", healthcheckTimeout: 300, dockerfilePath: "Dockerfile.admin", rootDirectory: "/" }],
    ["worker", { healthcheckPath: "/health/ready", healthcheckTimeout: 300, dockerfilePath: "Dockerfile.worker", rootDirectory: "/" }],
  ];
  for (const [service, input] of settings) {
    await step(run, `railway.settings.${service}`, `${service}'s settings: ${Object.keys(input).join(", ")}`, async () => {
      await railway(Q.instanceUpdate, { serviceId: id(service), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), input });
    });
  }
  await step(run, "railway.predeploy", "migrate's pre-deploy command: migrate, bootstrap, check, verify-rls", async () => {
    const vars = { serviceId: id("migrate"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID") };
    for (const shape of [[MIGRATE_PRE_DEPLOY], MIGRATE_PRE_DEPLOY]) {
      try {
        await railway(Q.instanceUpdate, { ...vars, input: { preDeployCommand: shape } });
        return;
      } catch (error) {
        if (!error.graphql) throw error;
      }
    }
    await byHand(["Railway's API didn't take the pre-deploy command. In migrate > Settings > Deploy, set Pre-deploy command to exactly:", MIGRATE_PRE_DEPLOY]);
  });
}

// ---------------------------------------------------------------- template

// Variables that differ for each deployment, or depend on its settings, stay out of the template.
const NOT_IN_TEMPLATE = new Set(["DEPLOYMENT_MODE", "BRAND_PRESET", "EMAIL_FROM", "POLAR_ORGANIZATION_ID", "POLAR_API_BASE_URL", "TWILIO_ALERT_SMS_FROM", "REQUIRE_EMAIL_VERIFICATION",
  "BILLING_PROVIDER", "STRIPE_ACCOUNT_ID"]);

/**
 * Builds a Railway project that holds only the layout (services, volumes, bucket, settings,
 * pre-deploy command and the variables that are the same everywhere, such as references), then
 * makes a private template of it. No secret, key or per-deployment value goes in: up sets those.
 */
async function makeTemplate(run) {
  // The template project's code services point at TEMPLATE_REPO, which Railway's GitHub access must reach.
  const s = { ...run.settings, REPO: run.settings.TEMPLATE_REPO || run.settings.REPO };
  const name = s.TEMPLATE_PROJECT || "lobbystack-template";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("TEMPLATE_PROJECT is a short name in lower case, such as lobbystack-template");
  if ([baseName(run.settings), nameFor(run, "RAILWAY_PROJECT_NAME")].includes(name)) throw new Error("TEMPLATE_PROJECT must differ from the deployment's Railway project: the template is made from a project of its own");
  const stateFile = run.stateFile.replace(/\.state\.json$/, ".template.state.json");
  // Read as loadRun reads the main state file: save() refuses to write over a file whose hash changed since.
  const { stateText, state } = readState(stateFile);
  // With no address of its own, the template project is named after TEMPLATE_PROJECT (see baseName).
  const trun = {
    file: run.file, stateFile, template: true,
    settings: { ...s, NAME: name, CUSTOM_HOST: "", APP_BASE_URL: "", ENVIRONMENT: "test" },
    state,
    stateHash: stateText === null ? null : hashText(stateText),
  };
  const earlierNames = recordEarlierNames(trun);
  if (!dryRun) lockState(trun);
  if (!dryRun && earlierNames.length) save(trun);
  console.log(`${dryRun ? "Dry run: nothing is called or changed.\n" : ""}Template: a Railway project "${name}" with the layout only, then a private template of it.`);
  console.log(`Progress: ${stateFile}\n`);
  if (!dryRun) await confirm(`This makes the Railway project ${name} in your workspace. Postgres and Redis there start without passwords and stop after a few retries; nothing else deploys.`);
  console.log("\nRailway");
  await railwaySteps(trun);
  // Railway makes a template only of services that have a source (an image or a repository).
  await step(trun, "template.sources", `${s.REPO} as the source of migrate, admin and worker, which Railway needs to make a template`, async () => {
    const ids = v(trun, "RAILWAY_SERVICE_IDS");
    for (const service of ["migrate", "admin", "worker"]) {
      try {
        await railway(Q.instanceUpdate, { serviceId: ids[service], environmentId: v(trun, "RAILWAY_ENVIRONMENT_ID"), input: { source: { repo: s.REPO } } });
        console.log(`  ${service}: ${s.REPO}`);
      } catch (error) {
        console.log(`  ${service}: Railway refused the source as a setting (${String(error.message).split("\n")[0]}), so it's connected to ${s.REPO}@${s.BRANCH} instead.`);
        console.log("    That starts a build here, which fails without the secrets: that's expected in this project.");
        await railway(Q.connect, { id: ids[service], input: { repo: s.REPO, branch: s.BRANCH } });
      }
    }
  });
  await step(trun, "template.variables", "The variables that are the same in every deployment (references, ports, file paths)", async () => {
    const ids = v(trun, "RAILWAY_SERVICE_IDS");
    const services = perService(variableSections(trun));
    services.admin.APP_BASE_URL = "https://${{RAILWAY_PUBLIC_DOMAIN}}";
    for (const [service, all] of Object.entries(services)) {
      // A secret's name stays only as a reference to another service, such as ${{Postgres.LOBBYSTACK_APP_PASSWORD}}.
      const secret = (key, value) => (SECRETS.includes(key) || SECRET_KEYS.has(key)) && !/^\$\{\{[\w-]+\.[A-Z0-9_]+\}\}$/.test(value);
      const variables = Object.fromEntries(Object.entries(all).filter(([key, value]) => value && !NOT_IN_TEMPLATE.has(key) && !secret(key, value)));
      await railway(Q.variables, { input: { projectId: v(trun, "RAILWAY_PROJECT_ID"), environmentId: v(trun, "RAILWAY_ENVIRONMENT_ID"), serviceId: ids[service], variables, skipDeploys: true } });
      console.log(`  ${service}: ${Object.keys(variables).length} variables`);
    }
  });
  await step(trun, "template.generate", `A private template of ${name}`, async () => {
    const where = { projectId: v(trun, "RAILWAY_PROJECT_ID"), environmentId: v(trun, "RAILWAY_ENVIRONMENT_ID") };
    const ids = v(trun, "RAILWAY_SERVICE_IDS");
    const generate = async () => (await railway(Q.templateGenerate, { input: where })).templateGenerate;
    // A whole word, so "resource" in another error doesn't count.
    const noSource = (error) => /\bsource\b/i.test(error.message);
    // Railway wants each code service linked to a repository and branch, not only its source setting
    // (seen on the first real run). Link them without a build first; connect them only if that isn't enough.
    const links = [
      ["linked to", async (service) => {
        await railway(Q.instanceUpdate, { serviceId: ids[service], environmentId: where.environmentId, input: { source: { repo: s.REPO } } });
        await railway(Q.triggerCreate, { input: { ...where, serviceId: ids[service], provider: "github", repository: s.REPO, branch: s.BRANCH, rootDirectory: "/" } });
      }],
      ["connected to", (service) => railway(Q.connect, { id: ids[service], input: { repo: s.REPO, branch: s.BRANCH } })],
    ];
    let templateGenerate;
    for (let attempt = 0; !templateGenerate; attempt += 1) {
      try {
        templateGenerate = await generate();
      } catch (error) {
        if (!noSource(error) || attempt >= links.length) throw error;
        const [verb, link] = links[attempt];
        console.log(`  Railway: ${String(error.message).split("\n")[0].replace(/^Railway refused templateGenerate: /, "")}`);
        if (verb === "connected to") console.log("  Connecting starts builds here, which fail without the secrets: that's expected in this project.");
        for (const service of ["migrate", "admin", "worker"]) {
          try {
            await link(service);
            console.log(`  ${service}: ${verb} ${s.REPO}@${s.BRANCH}`);
          } catch (linkError) {
            if (verb === "connected to") throw linkError;
            // Connecting wouldn't help: Railway builds a public repository it can't link, but makes no template of it.
            if (/access/i.test(linkError.message)) throw new Error(`Railway's GitHub access can't reach ${s.REPO} (${String(linkError.message).split("\n")[0]}). Add that repository to Railway's GitHub app (GitHub: Settings, Applications, Railway, Configure) for an account linked to your Railway workspace, or set TEMPLATE_REPO to a repository it reaches, then run template again`);
            console.log(`  ${service}: couldn't link it (${String(linkError.message).split("\n")[0]})`);
          }
        }
      }
    }
    if (!templateGenerate?.code) throw new Error("Railway made no template");
    console.log(`  made ${templateGenerate.name ?? "the template"} (${templateGenerate.status ?? "draft"}), code ${templateGenerate.code}`);
    return { TEMPLATE_CODE: templateGenerate.code };
  });
  if (dryRun) return;
  // What Railway put in it, so a missing part shows now rather than at the next up.
  const code = v(trun, "TEMPLATE_CODE");
  const { template } = await railway(Q.template, { code });
  const config = template?.serializedConfig ?? {};
  const file = `${run.file}.template.json`;
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const services = Object.values(config.services ?? {});
  console.log(`\nWhat the template holds (all of it is in ${file}):`);
  for (const service of services) {
    const variables = Object.values(service?.variables ?? {});
    const source = service?.source?.image ?? service?.source?.repo ?? "no source";
    console.log(`  ${service?.name ?? "?"}: ${source}, ${variables.length} variables${variables.some((item) => item?.defaultValue) ? "" : " (no values)"}`);
  }
  // Railway's layout of serializedConfig isn't documented, so look for each part by key name anywhere outside
  // the variables (S3_BUCKET is a variable, not a bucket), and count it only when it isn't empty.
  const holds = (node, pattern) => node && typeof node === "object" && Object.entries(node).some(([key, value]) => key !== "variables" &&
    ((pattern.test(key) && (Array.isArray(value) ? value.length > 0 : value && typeof value === "object" ? Object.keys(value).length > 0 : Boolean(value))) || holds(value, pattern)));
  for (const [label, pattern] of [["volumes", /volume/i], ["the bucket", /bucket/i], ["the pre-deploy command", /^preDeployCommand$/], ["start commands", /^startCommand$/]]) {
    console.log(`  ${holds(config, pattern) ? "has" : "NO "} ${label}`);
  }
  console.log(`\nPut this in your settings files, then up makes the layout from it:\n  RAILWAY_TEMPLATE=${code}`);
  console.log(`Anything the template left out, up still makes step by step. Only your workspace lists the template, but anyone with its code can read it: that's why it holds no keys or passwords.${openByHand(trun, "template")}`);
}

function cliEnv() {
  // A RAILWAY_TOKEN in the shell (a project token, such as railway-vars.mjs uses) would win over this run's token.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "RAILWAY_TOKEN"));
  return { ...env, ...(tokens.RAILWAY_API_TOKEN ? { RAILWAY_API_TOKEN: tokens.RAILWAY_API_TOKEN } : {}) };
}

/** The admin's custom domain (APP_BASE_URL's host) on Railway, made if missing, and the DNS records Railway wants for it. */
async function customDomain(run) {
  const s = run.settings;
  const where = { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: v(run, "RAILWAY_SERVICE_IDS")?.admin };
  const existing = (await railway(Q.domains, where)).domains.customDomains.find((domain) => domain.domain === s.CUSTOM_HOST);
  const domain = existing ?? (await railway(Q.customDomainCreate, { input: { ...where, domain: s.CUSTOM_HOST, targetPort: 3000 } })).customDomainCreate;
  const records = (domain.status?.dnsRecords ?? []).filter((record) => record.fqdn && record.requiredValue).map((record) => ({ type: record.recordType.replace("DNS_RECORD_TYPE_", ""), name: record.fqdn, content: record.requiredValue }));
  const { verified, verificationDnsHost, verificationToken } = domain.status ?? {};
  // Railway names the check's record relative to the domain's apex, such as _railway-verify.demo for demo.example.com.
  const check = String(verificationDnsHost ?? "").toLowerCase().replace(/\.$/, "");
  const rest = check.replace(/^_railway-verify\.?/, "");
  const checkName = check === s.CUSTOM_HOST || check.endsWith(`.${s.CUSTOM_HOST}`) ? check : check.startsWith("_railway-verify") && (!rest || s.CUSTOM_HOST.startsWith(`${rest}.`)) ? `_railway-verify.${s.CUSTOM_HOST}` : check;
  if (!verified && checkName && verificationToken) records.push({ type: "TXT", name: checkName, content: `railway-verify=${verificationToken.replace(/^(railway-verify=)+/, "")}` });
  return { domain, records, existed: Boolean(existing) };
}

async function addressSteps(run) {
  const s = run.settings;
  const admin = () => v(run, "RAILWAY_SERVICE_IDS")?.admin;
  const domains = async () => (await railway(Q.domains, { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: admin() })).domains;
  await step(run, "railway.domain", "The admin's Railway address, port 3000", async () => {
    const existing = (await domains()).serviceDomains[0];
    if (existing) console.log(`  = ${existing.domain}${existing.targetPort && existing.targetPort !== 3000 ? ` (port ${existing.targetPort}: set it to 3000 in admin > Settings > Networking)` : ""}`);
    const domain = existing?.domain ?? (await railway(Q.domainCreate, { input: { serviceId: admin(), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), targetPort: 3000 } })).serviceDomainCreate.domain;
    return { RAILWAY_HOST: domain, APP_HOST: s.CUSTOM_HOST || domain };
  });
  if (s.CUSTOM_HOST) {
    await step(run, "railway.custom", `The custom domain ${s.CUSTOM_HOST} (APP_BASE_URL), and its CNAME in Cloudflare`, async () => {
      const { records, existed } = await customDomain(run);
      if (existed) console.log(`  = ${s.CUSTOM_HOST} is on the admin already`);
      if (!records.length) {
        // Railway may send the records a little after making the domain: post.dns asks again after the deploy.
        console.log(`  Railway sent no DNS records for ${s.CUSTOM_HOST} yet; the step after the deploy asks again`);
      } else {
        await dnsRecords(run, records);
        if (s.CLOUDFLARE_ZONE) console.log("  Railway checks the records and issues the certificate; the domain shows a green check mark once DNS has spread (guide 4.7, step 2).");
      }
    });
  }
  await step(run, "turnstile", "The Turnstile widget for the address", async () => {
    const both = fromFile("TURNSTILE_SITE_KEY") && fromFile("TURNSTILE_SECRET_KEY");
    if (both || !s.STEP_TURNSTILE || !s.CLOUDFLARE_ACCOUNT_ID) {
      // A widget given in the secrets file may not list this deployment's addresses (seen on realinfobot-test1):
      // post.turnstile adds them after the deploy, or says what to add by hand.
      if (!both) await byHand([`In Cloudflare, Turnstile > Add widget for ${appHost(run)}, Managed, Pre-clearance No (guide 3.5).`]);
      return {
        TURNSTILE_SITE_KEY: await value("TURNSTILE_SITE_KEY", "The widget's Site Key"),
        TURNSTILE_SECRET_KEY: await secret("TURNSTILE_SECRET_KEY", "The widget's Secret Key", undefined, { envToo: false }),
        TURNSTILE_WIDGET_NAME: undefined,
      };
    }
    const hosts = [...new Set([appHost(run), v(run, "RAILWAY_HOST")].filter(Boolean))];
    const base = `/accounts/${s.CLOUDFLARE_ACCOUNT_ID}/challenges/widgets`;
    const name = nameFor(run, "TURNSTILE_WIDGET_NAME");
    // The widget an earlier run used, by its site key, else the one with this name: Cloudflare's names aren't unique.
    let found = v(run, "TURNSTILE_SITE_KEY") && (await cloudflare(`${base}/${v(run, "TURNSTILE_SITE_KEY")}`).catch((error) => (error.status === 404 ? null : Promise.reject(error))));
    if (!found) found = only(((await cloudflare(`${base}?per_page=100`)) ?? []).filter((widget) => widget.name === name), `Cloudflare has Turnstile widgets named "${name}"`);
    if (found) {
      const widget = found.secret ? found : await cloudflare(`${base}/${found.sitekey}`);
      const missing = hosts.filter((host) => !(widget.domains ?? []).includes(host));
      if (missing.length) await widgetAddHosts(`${base}/${widget.sitekey}`, widget, hosts);
      console.log(`  = the widget "${widget.name}"${missing.length ? `, now also for ${missing.join(", ")}` : ""}`);
      return { TURNSTILE_SITE_KEY: widget.sitekey, TURNSTILE_SECRET_KEY: widget.secret, TURNSTILE_WIDGET_NAME: widget.name };
    }
    const widget = await cloudflare(base, { method: "POST", body: { name, domains: hosts, mode: "managed" } });
    return { TURNSTILE_SITE_KEY: widget.sitekey, TURNSTILE_SECRET_KEY: widget.secret, TURNSTILE_WIDGET_NAME: name };
  });
}

/** Adds hosts to a Turnstile widget. A PUT replaces all of a widget's settings, so everything it has goes back with them. */
async function widgetAddHosts(widgetPath, widget, hosts) {
  const keep = Object.fromEntries(["bot_fight_mode", "clearance_level", "ephemeral_id", "offlabel", "region"].filter((key) => widget[key] !== undefined && widget[key] !== null).map((key) => [key, widget[key]]));
  await cloudflare(widgetPath, { method: "PUT", body: { ...keep, name: widget.name, mode: widget.mode ?? "managed", domains: [...new Set([...(widget.domains ?? []), ...hosts])] } });
}

async function tollfreeSteps(run) {
  const s = run.settings;
  await step(run, "twilio.tollfree", s.TWILIO_TOLLFREE === "buy" ? "Buy a toll-free number in the subaccount" : `Use ${s.TWILIO_TOLLFREE}`, async () => {
    const smsUrl = `https://${appHost(run)}/api/webhooks/twilio/sms`;
    const base = `${URLS.twilio}/Accounts/${v(run, "TWILIO_ACCOUNT_SID")}`;
    let number = s.TWILIO_TOLLFREE;
    const friendly = nameFor(run, "TWILIO_TOLLFREE_NAME");
    if (number === "buy") {
      // A number an earlier run bought is found by its name, so a rerun never buys a second one.
      const owned = await twilioSub(run, base, `/IncomingPhoneNumbers.json?FriendlyName=${encodeURIComponent(friendly)}&PageSize=20`);
      const mine = only((owned?.incoming_phone_numbers ?? []).filter((item) => item.friendly_name === friendly), `The subaccount has numbers named "${friendly}"`);
      if (mine) {
        number = mine.phone_number;
        console.log(`  = ${number}, bought earlier`);
        await twilioSub(run, base, `/IncomingPhoneNumbers/${mine.sid}.json`, { method: "POST", form: { SmsUrl: smsUrl, SmsMethod: "POST" } });
      }
    }
    if (number === "buy") {
      const available = await twilioSub(run, base, "/AvailablePhoneNumbers/US/TollFree.json?SmsEnabled=true&PageSize=1");
      number = available?.available_phone_numbers?.[0]?.phone_number;
      if (!number) throw new Error("Twilio offered no toll-free number");
      await confirm(`Buy ${number} in subaccount ${v(run, "TWILIO_ACCOUNT_SID")}? Twilio bills it every month.`);
      await twilioSub(run, base, "/IncomingPhoneNumbers.json", { method: "POST", form: { PhoneNumber: number, SmsUrl: smsUrl, SmsMethod: "POST", FriendlyName: friendly } });
    } else if (s.TWILIO_TOLLFREE !== "buy") {
      const owned = await twilioSub(run, base, `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
      const sid = owned?.incoming_phone_numbers?.[0]?.sid;
      if (!sid) throw new Error(`${number} isn't in subaccount ${v(run, "TWILIO_ACCOUNT_SID")}`);
      await twilioSub(run, base, `/IncomingPhoneNumbers/${sid}.json`, { method: "POST", form: { SmsUrl: smsUrl, SmsMethod: "POST" } });
    }
    await byHand([`Send ${number} for toll-free verification in Twilio's console (guide 3.3, step 19). Texts to US and Canadian phones wait for it.`]);
    return { TWILIO_ALERT_SMS_FROM: number, ...(s.TWILIO_TOLLFREE === "buy" ? { TWILIO_TOLLFREE_NAME: friendly } : {}) };
  });
}

// ---------------------------------------------------------------- variables

/** The variables of guide Appendix A, for a test or a production environment, with this run's values. */
function variableSections(run) {
  const s = run.settings;
  const x = (key) => v(run, key);
  const cloud = s.DEPLOYMENT_MODE === "cloud";
  // A deployment that sells plans does so through one provider, and gets only that provider's variables.
  const polar = cloud && s.BILLING_PROVIDER !== "stripe";
  const stripe = cloud && s.BILLING_PROVIDER === "stripe";
  const production = s.ENVIRONMENT === "production";
  const role = (name, variable) => `postgresql://${name}:\${{Postgres.${variable}}}@\${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack`;
  return [
    ["Postgres", {
      PGDATA: "/var/lib/postgresql/data/pgdata", POSTGRES_DB: "lobbystack", POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: x("POSTGRES_PASSWORD"), LOBBYSTACK_AUTH_PASSWORD: x("LOBBYSTACK_AUTH_PASSWORD"), LOBBYSTACK_APP_PASSWORD: x("LOBBYSTACK_APP_PASSWORD"),
      LOBBYSTACK_WORKER_PASSWORD: x("LOBBYSTACK_WORKER_PASSWORD"), LOBBYSTACK_DISPATCHER_PASSWORD: x("LOBBYSTACK_DISPATCHER_PASSWORD"),
    }],
    ["Redis", { REDIS_PASSWORD: x("REDIS_PASSWORD") }],
    ["migrate", {
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.migrator", NODE_ENV: "production",
      DATABASE_URL: "postgresql://postgres:${{Postgres.POSTGRES_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack",
      LOBBYSTACK_AUTH_PASSWORD: "${{Postgres.LOBBYSTACK_AUTH_PASSWORD}}", LOBBYSTACK_APP_PASSWORD: "${{Postgres.LOBBYSTACK_APP_PASSWORD}}",
      LOBBYSTACK_WORKER_PASSWORD: "${{Postgres.LOBBYSTACK_WORKER_PASSWORD}}", LOBBYSTACK_DISPATCHER_PASSWORD: "${{Postgres.LOBBYSTACK_DISPATCHER_PASSWORD}}",
    }],
    ["admin, worker", {
      NODE_ENV: "production", DEPLOYMENT_MODE: s.DEPLOYMENT_MODE, LIVE_PROTOTYPE_ENABLED: "true",
      // An address on the brand's own domain picks the brand by itself (BRAND_PRESET would only log that it's ignored).
      ...(production || (s.CUSTOM_HOST && brandForHost(s.CUSTOM_HOST) === s.BRAND) ? {} : { BRAND_PRESET: s.BRAND }), BRAND_REQUIRED: "true",
      REDIS_URL: "redis://default:${{Redis.REDIS_PASSWORD}}@${{Redis.RAILWAY_PRIVATE_DOMAIN}}:6379",
      STORAGE_PROVIDER: "s3", S3_BUCKET: "${{Bucket.BUCKET}}", S3_ENDPOINT: "${{Bucket.ENDPOINT}}", S3_REGION: "${{Bucket.REGION}}",
      S3_ACCESS_KEY_ID: "${{Bucket.ACCESS_KEY_ID}}", S3_SECRET_ACCESS_KEY: "${{Bucket.SECRET_ACCESS_KEY}}", S3_FORCE_PATH_STYLE: "false",
      ...(cloud && x("TWILIO_ALERT_SMS_FROM") ? { TWILIO_ALERT_SMS_FROM: x("TWILIO_ALERT_SMS_FROM") } : {}),
      ...(polar ? { POLAR_ORGANIZATION_ID: polarOrganization(run), ...(s.POLAR === "sandbox" ? { POLAR_API_BASE_URL: POLAR_SERVERS.sandbox } : {}) } : {}),
      ...(stripe ? { BILLING_PROVIDER: "stripe", STRIPE_ACCOUNT_ID: x("STRIPE_ACCOUNT_ID") } : {}),
    }],
    ["admin", {
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.admin", PORT: "3000", HOSTNAME: "::",
      APP_BASE_URL: s.CUSTOM_HOST ? `https://${s.CUSTOM_HOST}` : "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      // With its own address, sign-in also works on Railway's, which answers first while DNS spreads.
      SITE_URL: "${{APP_BASE_URL}}", AUTH_TRUSTED_ORIGINS: s.CUSTOM_HOST && x("RAILWAY_HOST") ? `\${{APP_BASE_URL}},https://${x("RAILWAY_HOST")}` : "${{APP_BASE_URL}}",
      TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
      ...(production ? { REQUIRE_EMAIL_VERIFICATION: "true" } : {}), WIDGET_KEY_ISSUANCE_ENABLED: "true",
      WORKER_INTERNAL_URL: "http://${{worker.RAILWAY_PRIVATE_DOMAIN}}:3002",
      DATABASE_URL: role("lobbystack_app", "LOBBYSTACK_APP_PASSWORD"),
      LOBBYSTACK_AUTH_PASSWORD: "${{Postgres.LOBBYSTACK_AUTH_PASSWORD}}", LOBBYSTACK_WORKER_PASSWORD: "${{Postgres.LOBBYSTACK_WORKER_PASSWORD}}",
      LOBBYSTACK_DISPATCHER_PASSWORD: "${{Postgres.LOBBYSTACK_DISPATCHER_PASSWORD}}",
      BETTER_AUTH_SECRET: x("BETTER_AUTH_SECRET"), ENCRYPTION_KEY: x("ENCRYPTION_KEY"), INTERNAL_SERVICE_SECRET: x("INTERNAL_SERVICE_SECRET"),
      INTERNAL_SERVICE_TOKEN: x("INTERNAL_SERVICE_TOKEN"), NUMBER_CLAIM_TOKEN_SECRET: x("NUMBER_CLAIM_TOKEN_SECRET"), OTP_HASH_SECRET: x("OTP_HASH_SECRET"),
      WIDGET_SESSION_SECRET: x("WIDGET_SESSION_SECRET"), OPENAI_API_KEY: x("OPENAI_API_KEY"),
      TWILIO_ACCOUNT_SID: x("TWILIO_ACCOUNT_SID"), TWILIO_AUTH_TOKEN: x("TWILIO_AUTH_TOKEN"),
      TWILIO_SMS_WEBHOOK_URL: "${{APP_BASE_URL}}/api/webhooks/twilio/sms", TWILIO_STATUS_CALLBACK_URL: "${{APP_BASE_URL}}/api/webhooks/twilio/status",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: x("TURNSTILE_SITE_KEY"), TURNSTILE_SECRET_KEY: x("TURNSTILE_SECRET_KEY"),
      ...(polar ? { POLAR_ACCESS_TOKEN: x("POLAR_ADMIN_TOKEN") } : {}), ...(stripe ? { STRIPE_API_KEY: x("STRIPE_ADMIN_KEY") } : {}),
    }],
    ["worker", {
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.worker", PORT: "3002", RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "1860",
      APP_BASE_URL: "${{admin.APP_BASE_URL}}", DATABASE_URL: role("lobbystack_worker", "LOBBYSTACK_WORKER_PASSWORD"),
      LOBBYSTACK_DISPATCHER_PASSWORD: "${{Postgres.LOBBYSTACK_DISPATCHER_PASSWORD}}", ENCRYPTION_KEY: "${{admin.ENCRYPTION_KEY}}",
      OTP_HASH_SECRET: "${{admin.OTP_HASH_SECRET}}", INTERNAL_SERVICE_TOKEN: "${{admin.INTERNAL_SERVICE_TOKEN}}",
      OPENAI_API_KEY: "${{admin.OPENAI_API_KEY}}", TWILIO_ACCOUNT_SID: "${{admin.TWILIO_ACCOUNT_SID}}", TWILIO_AUTH_TOKEN: "${{admin.TWILIO_AUTH_TOKEN}}",
      TWILIO_STATUS_CALLBACK_URL: "${{admin.TWILIO_STATUS_CALLBACK_URL}}", TWILIO_SIP_TRUNK_SID: x("TWILIO_SIP_TRUNK_SID"),
      SMTP_HOST: "smtp.resend.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USERNAME: "resend", SMTP_PASSWORD: x("SMTP_PASSWORD"),
      EMAIL_FROM: s.EMAIL_FROM, ...(polar ? { POLAR_ACCESS_TOKEN: x("POLAR_WORKER_TOKEN") } : {}), ...(stripe ? { STRIPE_API_KEY: x("STRIPE_WORKER_KEY") } : {}),
    }],
  ];
}

/** Each service's variables, the shared section merged in. */
function perService(sections) {
  const services = {};
  for (const [names, variables] of sections) {
    for (const name of names.split(",").map((item) => item.trim())) Object.assign((services[name] ??= {}), variables);
  }
  return services;
}

const secretsListed = new WeakSet();

async function secretsStep(run) {
  // With a template it runs before the Railway steps; a dry run lists it once.
  if (dryRun && secretsListed.has(run)) return;
  secretsListed.add(run);
  // Kept, given, or already on Railway (a lost state file must never change the database's passwords), else new.
  const holder = (key) => (key.startsWith("POSTGRES_") || key.startsWith("LOBBYSTACK_") ? "Postgres" : key === "REDIS_PASSWORD" ? "Redis" : "admin");
  await step(run, "secrets", "The 13 passwords and secrets (64 hex characters each)", async () => {
    const values = {};
    for (const key of SECRETS) {
      const fromSecretsFile = fromFile(key);
      // They go into connection URLs and keys, so only URL-safe characters, and enough of them.
      if (fromSecretsFile && !/^[A-Za-z0-9_-]{32,}$/.test(fromSecretsFile)) throw new Error(`${key} in ${config.file} must be at least 32 letters, digits, dashes or underscores, such as 64 hex characters`);
      values[key] = run.state.values[key] ?? fromSecretsFile ?? (await railwayVariable(run, holder(key), key)) ?? randomBytes(32).toString("hex");
    }
    return values;
  });
}

async function variableSteps(run) {
  await secretsStep(run);
  // A dry run names each service's variables, never a value.
  if (dryRun && !run.state.done.variables) {
    for (const [service, variables] of Object.entries(perService(variableSections(run)))) console.log(`    ${service}: ${Object.keys(variables).join(", ")}`);
  }
  await step(run, "variables", "Every service's variables (guide Appendix A)", async () => {
    const sections = variableSections(run);
    const missing = sections.flatMap(([section, variables]) => Object.entries(variables).filter(([, value]) => !value).map(([key]) => `${key} (${section})`));
    if (missing.length) throw new Error(`these have no value yet: ${missing.join(", ")}`);
    writeVariableFile(run, sections);
    const ids = v(run, "RAILWAY_SERVICE_IDS");
    const where = { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID") };
    const wanted = perService(sections);
    // Before a service's first deploy, all of its variables go in without deploying. Once it's deployed, such as when
    // a redone step brings a new key, only what differs is set, and Railway deploys the service again with it.
    const deployedBy = { Postgres: "deploy.databases", Redis: "deploy.databases", migrate: "deploy.migrate", admin: "deploy.admin", worker: "deploy.worker" };
    const changed = {};
    for (const [service, variables] of Object.entries(wanted)) {
      if (!run.state.done[deployedBy[service]]) {
        await railway(Q.variables, { input: { ...where, serviceId: ids[service], variables, skipDeploys: true } });
        console.log(`  ${service}: ${Object.keys(variables).length} variable${Object.keys(variables).length === 1 ? "" : "s"}`);
        continue;
      }
      const current = (await railway(Q.readVariables, { ...where, serviceId: ids[service] })).variables ?? {};
      changed[service] = Object.keys(variables).filter((key) => current[key] !== variables[key]);
    }
    // A running database keeps the passwords it started with, so new ones on Railway would lock the services out.
    const databases = ["Postgres", "Redis"].filter((service) => changed[service]?.length);
    if (databases.length) throw new Error(`${databases.map((service) => `${service}'s ${changed[service].join(", ")}`).join(" and ")} on Railway differ from the state file's, and the database runs with Railway's. The script won't change a running database's settings: to change a password, follow guide 7.18`);
    for (const [service, keys] of Object.entries(changed)) {
      if (!keys.length) {
        console.log(`  = ${service}: unchanged`);
        continue;
      }
      await railway(Q.variables, { input: { ...where, serviceId: ids[service], variables: Object.fromEntries(keys.map((key) => [key, wanted[service][key]])) } });
      console.log(`  ~ ${service}: ${keys.join(", ")} (Railway deploys it again)`);
    }
    // The worker refers to some of the admin's values, such as ${{admin.OPENAI_API_KEY}}, and sees a new one only once
    // it deploys again.
    const refersTo = Object.values(wanted.worker).flatMap((value) => [...String(value).matchAll(/\$\{\{admin\.(\w+)\}\}/g)].map((match) => match[1]));
    if (changed.worker && !changed.worker.length && (changed.admin ?? []).some((key) => refersTo.includes(key))) {
      await railway(Q.redeploy, { environmentId: where.environmentId, serviceId: ids.worker });
      console.log("  ~ worker: deployed again, for the admin's values it refers to");
    }
  });
}

/** The same variables as a file for devops/railway-vars.mjs, kept beside the settings. */
function writeVariableFile(run, sections) {
  const file = path.join(path.dirname(run.file), `${path.basename(run.file)}.vars`);
  const lines = [
    `# Railway variables of ${baseName(run.settings)}, written by devops/bootstrap.mjs on ${new Date().toISOString().slice(0, 10)}.`,
    "# It holds secrets: Git ignores it (.env.*). node devops/railway-vars.mjs <this file> sets them again.",
  ];
  for (const [names, variables] of sections) lines.push("", `[${names}]`, ...Object.entries(variables).map(([key, value]) => `${key}=${value}`));
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(`  wrote ${file}`);
}

async function deploySteps(run) {
  const s = run.settings;
  const ids = () => v(run, "RAILWAY_SERVICE_IDS");
  const source = { repo: s.REPO, branch: s.BRANCH };
  const environmentId = () => v(run, "RAILWAY_ENVIRONMENT_ID");
  // Deployed through the API: with a template, Postgres and Redis were deployed before their passwords were set
  // (Postgres refused to start), and nothing is staged for a Deploy banner, since the variables went in with
  // skipDeploys. Railway reports an image service's deployment SUCCESS once it's running.
  await step(run, "deploy.databases", "Deploy Postgres and Redis with their passwords", async () => {
    try {
      for (const service of ["Postgres", "Redis"]) {
        // A deployment that isn't running, such as one that started without its password, is removed first:
        // its restarts must not overlap the new deployment on the same volume.
        const previous = await latestDeployment(run, ids()[service]);
        if (previous && previous.status !== "SUCCESS" && previous.status !== "REMOVED") {
          await railway(Q.deploymentRemove, { id: previous.id });
          console.log(`  ${service}: removed its ${previous.status.toLowerCase()} deployment first`);
        }
        const id = (await railway(Q.deployService, { serviceId: ids()[service], environmentId: environmentId() })).serviceInstanceDeployV2;
        console.log(`  ${service}: deploying`);
        await waitForDeployment(run, service, ids()[service], typeof id === "string" && id ? { id } : {});
        console.log(`  ${service}: running`);
      }
    } catch (error) {
      // Only a call Railway refused falls back to the dashboard; a failed deployment or an unreachable Railway stops.
      if (!error.graphql) throw error;
      console.log(`  Railway didn't deploy them through its API (${String(error.message).split("\n")[0]}).`);
      await byHand(["Deploy Postgres and Redis in the project's canvas (the Deploy banner, or each service's Deployments > Redeploy).", "Then check that Postgres's and Redis's logs say they're ready to accept connections (guide 4.4, step 13)."]);
    }
  });
  await step(run, "deploy.migrate", `Connect migrate to ${s.REPO}@${s.BRANCH}, which deploys it`, async () => {
    const before = await latestDeployment(run, ids().migrate).catch(() => undefined);
    await railway(Q.connect, { id: ids().migrate, input: source });
    await checkTrigger(run, "migrate");
    try {
      console.log("  migrate: building, then its pre-deploy runs the migrations (several minutes)");
      await waitForDeployment(run, "migrate", ids().migrate, { after: before?.id });
      console.log("  migrate: succeeded, so its pre-deploy passed (migrations, roles, RLS check)");
    } catch (error) {
      if (error.deployFailed) throw new Error(`${error.message}. Guide 4.5, step 6, and 8.2 list the usual causes; run up again once it's fixed`);
      if (!error.graphql) throw error;
      await byHand(["Wait for migrate's deployment to succeed: its log ends with RLS enabled and forced on <n> tables (guide 4.5, step 6).", "If it fails, guide 4.5, step 6, and 8.2 list the usual causes; run this command again once it passes."]);
    }
  });
  for (const service of ["admin", "worker"]) {
    await step(run, `deploy.${service}`, `Connect the ${service} to ${s.REPO}@${s.BRANCH}, which builds it`, async () => {
      await railway(Q.connect, { id: ids()[service], input: source });
      await checkTrigger(run, service);
    });
  }
}

/**
 * Warns when a service connected to the repository has no deployment trigger: Railway builds a public repository
 * its GitHub app can't reach, but then never redeploys on a push. Only a warning, since the deploy itself works.
 */
async function checkTrigger(run, service) {
  const s = run.settings;
  let triggers;
  try {
    const where = { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: v(run, "RAILWAY_SERVICE_IDS")[service] };
    triggers = (await railway(Q.triggers, where)).deploymentTriggers?.edges?.map(({ node }) => node) ?? [];
  } catch (error) {
    return trace(`couldn't read ${service}'s deployment triggers: ${error.message}`);
  }
  const repo = (name) => String(name ?? "").replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").toLowerCase();
  if (triggers.some((trigger) => repo(trigger.repository) === repo(s.REPO) && trigger.branch === s.BRANCH)) return;
  console.log(`  WARNING: ${service} has no trigger for ${s.REPO}@${s.BRANCH}, so pushes there won't redeploy it. Add ${s.REPO} to Railway's GitHub app (GitHub: Settings, Applications, Railway, Configure), then in ${service} > Settings > Source, disconnect and connect the repository again.`);
}

// ---------------------------------------------------------------- after the deploy

/**
 * The admin's own address (APP_BASE_URL) and the Turnstile widget, settled once the deployment exists: Railway may
 * send a custom domain's DNS records only a while after making the domain, and only now are both of the admin's
 * addresses known. Each step reads what's there and changes only what differs.
 */
async function postDeploySteps(run) {
  const s = run.settings;
  const where = () => ({ projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID") });
  if (s.CUSTOM_HOST) {
    await step(run, "post.dns", `${s.CUSTOM_HOST} points to this deployment: its CNAME in Cloudflare, and Railway's check`, async () => {
      const pause = Number(process.env.BOOTSTRAP_POLL_MS ?? 3000);
      let found = await customDomain(run);
      for (let tries = 0; tries < 20 && !found.records.length && !found.domain.status?.verified; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, pause));
        found = await customDomain(run);
      }
      const { domain, records } = found;
      // The address this was done for, so connect can tell when APP_BASE_URL changed afterwards.
      const done = { POST_DNS_HOST: s.CUSTOM_HOST };
      if (records.length) await dnsRecords(run, records);
      else if (!domain.status?.verified) {
        await byHand([`Railway sent no DNS records for ${s.CUSTOM_HOST}. Add the ones under admin > Settings > Networking, DNS only (guide 4.7, step 2): a CNAME to the target Railway shows.`]);
        return done;
      }
      const { verified, certificateStatus } = domain.status ?? {};
      // Railway names the status like CERTIFICATE_STATUS_TYPE_VALID.
      console.log(`  Railway: ${verified ? "verified" : "not verified yet"}, certificate ${String(certificateStatus ?? "status unknown").replace(/^CERTIFICATE_STATUS_TYPE_/i, "").toLowerCase().replace(/_/g, " ")}${verified ? "" : ". Railway checks again by itself once DNS has spread, usually within minutes"}`);
      return done;
    });
  }
  await step(run, "post.urls", "The admin's and the worker's APP_BASE_URL and AUTH_TRUSTED_ORIGINS match the settings", async () => {
    const wanted = perService(variableSections(run));
    for (const [service, keys] of [["admin", ["APP_BASE_URL", "SITE_URL", "AUTH_TRUSTED_ORIGINS"]], ["worker", ["APP_BASE_URL"]]]) {
      const serviceId = v(run, "RAILWAY_SERVICE_IDS")[service];
      const current = (await railway(Q.readVariables, { ...where(), serviceId })).variables ?? {};
      const changed = Object.fromEntries(keys.filter((key) => current[key] !== wanted[service][key]).map((key) => [key, wanted[service][key]]));
      if (!Object.keys(changed).length) {
        console.log(`  = ${service}: ${keys.map((key) => `${key}=${wanted[service][key]}`).join(", ")}`);
        continue;
      }
      // Set without skipping deploys, so Railway redeploys the service with them.
      await railway(Q.variables, { input: { ...where(), serviceId, variables: changed } });
      console.log(`  ~ ${service}: ${Object.entries(changed).map(([key, value]) => `${key}=${value}`).join(", ")} (Railway redeploys it)`);
    }
  });
  await step(run, "post.turnstile", "The Turnstile widget lists this deployment's addresses", async () => {
    const hosts = [...new Set([appHost(run), v(run, "RAILWAY_HOST")].filter(Boolean))];
    const siteKey = v(run, "TURNSTILE_SITE_KEY");
    const byHandHosts = () => byHand([`In Cloudflare, Turnstile, the widget${siteKey ? ` with site key ${siteKey}` : ""}, Hostname management: make sure it lists ${hosts.join(" and ")}.`, "Sign-up and sign-in fail their Turnstile check on an address it doesn't list."]);
    if (!s.STEP_TURNSTILE || !s.CLOUDFLARE_ACCOUNT_ID || !siteKey) return byHandHosts();
    // The widget is found by its site key, so this works for a widget given in the secrets file too.
    const widgetPath = `/accounts/${s.CLOUDFLARE_ACCOUNT_ID}/challenges/widgets/${siteKey}`;
    try {
      const widget = await cloudflare(widgetPath);
      const missing = hosts.filter((host) => !(widget.domains ?? []).includes(host));
      if (!missing.length) return console.log(`  = the widget "${widget.name}" lists ${hosts.join(" and ")}`);
      await widgetAddHosts(widgetPath, widget, hosts);
      console.log(`  ~ the widget "${widget.name}" now also lists ${missing.join(" and ")}`);
    } catch (error) {
      console.log(`  Cloudflare didn't let the script read or change the widget (${String(error.message).split("\n")[0]}). Its token needs Account > Turnstile > Edit.`);
      await byHandHosts();
    }
  });
}

// ---------------------------------------------------------------- connect

/**
 * The admin's Railway address as Railway has it now, kept in the state file. A state file left from an earlier
 * project names that project's address, which answers "Application not found" once the project is gone.
 */
async function currentRailwayHost(run) {
  const recorded = v(run, "RAILWAY_HOST");
  const serviceId = v(run, "RAILWAY_SERVICE_IDS")?.admin;
  if (!serviceId || !v(run, "RAILWAY_PROJECT_ID")) return recorded;
  try {
    const { domains } = await railway(Q.domains, { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId });
    const now = domains?.serviceDomains?.[0]?.domain;
    if (now && now !== recorded) {
      console.log(`  The state file had https://${recorded}; Railway's admin is at https://${now} now, so that's used and kept.`);
      if (v(run, "APP_HOST") === recorded) run.state.values.APP_HOST = now;
      run.state.values.RAILWAY_HOST = now;
      save(run);
    }
    return now ?? recorded;
  } catch (error) {
    console.log(`  Railway didn't list the admin's addresses (${String(error.message).split("\n")[0]}), so the address the state file names is used.`);
    return recorded;
  }
}

/**
 * Sets those of the admin's variables that differ, which makes Railway deploy it again. Returns what waiting for that
 * deployment needs ({ after: the newest deployment before }), or null when nothing differed.
 */
async function setAdminVariables(run, variables) {
  const where = { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: v(run, "RAILWAY_SERVICE_IDS").admin };
  const current = (await railway(Q.readVariables, where)).variables ?? {};
  const changed = Object.fromEntries(Object.entries(variables).filter(([key, wanted]) => current[key] !== wanted));
  if (!Object.keys(changed).length) {
    console.log(`  = the admin has ${Object.keys(variables).join(" and ")} already`);
    return null;
  }
  const before = await latestDeployment(run, where.serviceId);
  await railway(Q.variables, { input: { ...where, variables: changed, skipDeploys: false } });
  console.log(`  ~ admin: ${Object.keys(changed).join(", ")} (Railway deploys it again)`);
  return { after: before?.id ?? null };
}

// ---------------------------------------------------------------- Polar billing, from connect

// What the billing steps share within one run, and never save: the admin's deployment to wait for, the admin's address
// that answers, the operator key, the Polar token pnpm billing uses (billingToken) and the tokens Polar refused it.
const billingRun = { redeploy: null, base: null, key: null, token: null, refused: new Set() };
const SETUP_SCOPES = "organizations:write, meters:write, products:write, discounts:write and webhooks:write";
const pollPause = () => new Promise((resolve) => setTimeout(resolve, Number(process.env.BOOTSTRAP_POLL_MS ?? 3000)));
const withoutTrailingSlash = (url) => String(url ?? "").replace(/\/+$/, "");

/** Waits until the admin runs its newest deployment: the one this run started by changing its variables, else whatever is newest. */
async function adminDeployed(run) {
  const serviceId = v(run, "RAILWAY_SERVICE_IDS").admin;
  const started = billingRun.redeploy;
  billingRun.redeploy = null;
  if (started) {
    console.log("  waiting for the admin's new deployment, with its new variables (a few minutes)");
    return waitForDeployment(run, "admin", serviceId, started);
  }
  const latest = await latestDeployment(run, serviceId);
  if (!latest) throw new Error("the admin has no deployment in Railway. Run up again");
  if (["SUCCESS", "SLEEPING"].includes(latest.status)) return;
  console.log(`  the admin's newest deployment is ${String(latest.status).toLowerCase()}: waiting for it`);
  return waitForDeployment(run, "admin", serviceId, { id: latest.id });
}

/** The admin's address that answers: APP_BASE_URL's, else Railway's while DNS or the certificate is on its way. */
async function answeringAdmin(hosts) {
  if (billingRun.base) return billingRun.base;
  if (process.env.BOOTSTRAP_APP_URL) return (billingRun.base = process.env.BOOTSTRAP_APP_URL);
  let failures = [];
  // A deployment that just went live may take a moment to answer at every address.
  for (let tries = 0; tries < 20; tries += 1) {
    failures = [];
    for (const host of [...new Set(hosts.filter(Boolean))]) {
      const health = await http("The admin", `https://${host}/api/health/ready`).catch((error) => ({ failed: error.message }));
      if (health?.ok === true) return (billingRun.base = `https://${host}`);
      failures.push(`https://${host}: ${health?.failed ?? JSON.stringify(health)}`);
    }
    await pollPause();
  }
  throw new Error(`the admin doesn't answer (${failures.join("; ")}). Check its deployment in Railway, then run connect again`);
}

/** The operator's platform key: from the file connect.platformKey wrote, else asked for. Kept in memory only. */
async function operatorKey(run) {
  if (billingRun.key) return billingRun.key;
  const file = v(run, "PLATFORM_KEY_FILE");
  if (file && fs.existsSync(file)) {
    let key;
    try {
      key = JSON.parse(fs.readFileSync(file, "utf8"))?.key;
    } catch {
      // Said below.
    }
    if (typeof key !== "string" || !key.startsWith("lsp_")) throw new Error(`${file} holds no platform key (lsp_...). Put the operator key back in it, or delete the file to be asked for the key`);
    console.log(`  the operator key: from ${file}`);
    return (billingRun.key = hide(key));
  }
  console.log(`  ${file ? `${file} isn't here any more, so` : "There's no key file on this computer, so"} pnpm billing needs the operator key from the password manager.`);
  return (billingRun.key = await askSecret("the operator key", "The operator's platform key (lsp_...)", (answer) => answer.startsWith("lsp_"), "put the key back in its .platform-keys file instead"));
}

/**
 * Checks the operator key against the admin (GET /api/v1/me). The key acts as OPERATOR_EMAIL's account, so until that
 * account is signed up and verified the admin answers 403 key_owner_inactive: the person signs up, and it checks again.
 * Returns false when --yes didn't wait for that.
 */
async function operatorKeyWorks(run, base, key) {
  for (let unknown = 0; ; ) {
    try {
      await http("The admin", `${base}/api/v1/me`, { headers: { Authorization: `Bearer ${key}` } });
      console.log("  the operator key works");
      return true;
    } catch (error) {
      if (error.status === 403 && error.code === "key_owner_inactive") {
        await byHand([`Sign up at ${base}/en/signup as ${run.settings.OPERATOR_EMAIL}, with the 6-digit code from the email (guide 6.1).`,
          "The operator key acts as that account, so pnpm billing can use it only once the account's email is verified."]);
        if (byHandSkipped) return false;
        continue;
      }
      // Railway may send a request or two to the deployment from before PLATFORM_API_KEYS changed.
      if (error.status === 401 && (unknown += 1) < 10) {
        await pollPause();
        continue;
      }
      if (error.status === 401) throw new Error(`the admin doesn't know the operator key: its PLATFORM_API_KEYS has no entry for it. Give the key connect.platformKey made for ${run.settings.OPERATOR_EMAIL}, or redo connect.platformKey`);
      throw error;
    }
  }
}

/**
 * Whether Polar shows a token the organization's webhooks, as pnpm billing needs (webhooks:read or webhooks:write). The
 * worker's token as guide 3.7 makes it can't: then the token is refused (401 or 403), and this says no.
 */
async function listsWebhooks(run, value) {
  try {
    await polarList(run, value, "/v1/webhooks/endpoints");
    return true;
  } catch (error) {
    if (error.status === 401 || error.status === 403) return false;
    throw error;
  }
}

/** Which of the deployment's own Polar tokens a token is, as words for a message, or null for another token. */
function ownPolarToken(run, value) {
  if (value === v(run, "POLAR_WORKER_TOKEN")) return "the worker's";
  if (value === v(run, "POLAR_ADMIN_TOKEN")) return "the admin's";
  return null;
}

/**
 * Whether one of the deployment's own Polar tokens can do what pnpm billing does: it belongs to the deployment's
 * organization, and Polar shows it the webhooks. A token Polar refuses either is one it can't.
 */
async function setsPlansUp(run, value, deployment) {
  const organization = await polarOrganizationOf(run, value, "The deployment's Polar token").catch((error) => {
    if (error.network) throw error;
    return null;
  });
  return Boolean(organization && deployment && String(organization.id).toLowerCase() === deployment.toLowerCase() && (await listsWebhooks(run, value)));
}

/**
 * The Polar token pnpm billing uses, kept in memory only: { value, own }, where own names the deployment's own token it
 * is, or is null for a setup token. A setup token given in the environment or the secrets file comes first. Else the
 * deployment's own token, the worker's and then the admin's, when it belongs to the deployment's organization and Polar
 * shows it the webhooks, so a token made with the setup scopes too needs no other. Else a setup token is asked for:
 * any token of the deployment's organization that Polar shows the webhooks will do.
 */
async function billingToken(run) {
  if (billingRun.token) return billingRun.token;
  const s = run.settings;
  const deployment = polarOrganization(run);
  const given = process.env.POLAR_SETUP_TOKEN?.trim() || fromFile("POLAR_SETUP_TOKEN", { quiet: true });
  if (!given) {
    const own = [...new Set([v(run, "POLAR_WORKER_TOKEN"), v(run, "POLAR_ADMIN_TOKEN")])].filter((value) => value && !billingRun.refused.has(value));
    for (const value of own) {
      if (!(await setsPlansUp(run, value, deployment))) continue;
      console.log(`  pnpm billing uses ${ownPolarToken(run, value)} Polar token, which Polar lets set plans up, so no setup token is needed`);
      return (billingRun.token = { value, own: ownPolarToken(run, value) });
    }
    if (own.length && !billingRun.refused.size) {
      const them = own.length > 1 ? "them" : "it";
      console.log(`  The deployment's own Polar ${own.length > 1 ? "tokens" : "token"} can't set plans up (Polar shows ${them} no webhooks), as guide 3.7 makes ${them}.`);
    }
    console.log(`  pnpm billing needs a token with ${SETUP_SCOPES}. Make one in Polar's ${s.POLAR} organization,`);
    console.log("  Settings > Developers > New Token, with the shortest end date offered: it's used for this run only, never saved.");
  }
  const value = await token("POLAR_SETUP_TOKEN", "The Polar setup token");
  try {
    if (billingRun.refused.has(value)) throw new Error(`Polar refused that token for pnpm billing (above). Give a token with ${SETUP_SCOPES}`);
    const organization = await polarOrganizationOf(run, value, "The setup token");
    if (deployment && String(organization.id).toLowerCase() !== deployment.toLowerCase()) {
      throw new Error(`the setup token belongs to Polar's ${s.POLAR} organization ${organization.name} (${organization.id}), and this deployment sells through ${deployment}. Make the setup token in that organization`);
    }
    if (!(await listsWebhooks(run, value))) throw new Error(`Polar shows the setup token no webhooks, so it can't set plans up. Give a token with ${SETUP_SCOPES}`);
    return (billingRun.token = { value, own: ownPolarToken(run, value) });
  } catch (error) {
    delete tokens.POLAR_SETUP_TOKEN;
    throw error;
  }
}

/**
 * Whether Polar refused the token pnpm billing just used (401 or 403, as pnpm billing prints it). Then that token isn't
 * used again in this run, and the next billingToken asks for a setup token, so the caller runs the command once more.
 */
function polarRefusedToken(result) {
  if (!billingRun.token || result.status === 0 || !/Polar answered 40[13] to /.test(result.output ?? "")) return false;
  billingRun.refused.add(billingRun.token.value);
  delete tokens.POLAR_SETUP_TOKEN;
  console.log(`  Polar refused ${billingRun.token.own ? `${billingRun.token.own} Polar token` : "the setup token"} for that (above).`);
  billingRun.token = null;
  return true;
}

/** pnpm billing's connection and token: its own, never a profile or token of the person's shell. */
function billingEnv(base, key, token, folder) {
  // XDG_CONFIG_HOME in a folder of its own, so the command line's saved profiles aren't even read.
  return { ...process.env, LOBBYSTACK_URL: base, LOBBYSTACK_API_KEY: key, POLAR_SETUP_TOKEN: token, POLAR_READ_TOKEN: token, XDG_CONFIG_HOME: folder };
}

/** Runs pnpm billing from the repository, showing what it prints; says so when pnpm itself is missing. */
async function pnpmBilling(args, env) {
  console.log(`  pnpm billing ${args.join(" ")}`);
  const result = await runToolLive("pnpm", ["--silent", "billing", ...args], { cwd: REPO_ROOT, env });
  if (result.status === null || (process.platform === "win32" && result.status !== 0 && /is not recognized as an internal or external command/i.test(result.output))) {
    throw new Error("pnpm isn't installed: npm install --global pnpm, then pnpm install in the repository folder, then run again");
  }
  return result;
}

/** A new folder only this user can read, for pnpm billing's files, deleted once fn is done. */
async function inPrivateFolder(fn) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lobbystack-billing-"));
  try {
    return await fn(folder);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** The [service] sections of a file for railway-vars.mjs, such as the one pnpm billing apply writes. */
function readVariableSections(text) {
  const services = {};
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) current = section[1].split(",").map((name) => name.trim()).filter(Boolean);
    else if (line && !line.startsWith("#") && line.includes("=")) {
      for (const service of current) (services[service] ??= {})[line.slice(0, line.indexOf("=")).trim()] = line.slice(line.indexOf("=") + 1).trim();
    }
  }
  return services;
}

/**
 * Sets Polar up for the deployment as guide 3.7, "Selling plans (Polar)", steps 5 to 8 do by hand, through the same
 * pnpm billing: plan, then apply once the person types yes, then the webhook's secret on the admin, then verify. It
 * uses the operator key connect.platformKey made and the deployment's own Polar token, or a setup token when Polar
 * doesn't let that one set plans up (billingToken), and saves neither.
 */
async function polarBillingSteps(run, hosts) {
  const s = run.settings;
  // The webhook is for APP_BASE_URL's address even while only Railway's answers, as OpenAI's is.
  const webhookUrl = `https://${hosts[0]}${POLAR_WEBHOOK_PATH}`;
  const flags = ["--brand", s.BRAND, "--polar", s.POLAR, "--webhook-url", webhookUrl];
  await step(run, "connect.billing.apply", `Polar sells brands/${s.BRAND}/billing.json's plans: pnpm billing plan, then apply once you type yes`, async () => {
    await adminDeployed(run);
    const base = await answeringAdmin(hosts);
    const key = await operatorKey(run);
    if (!(await operatorKeyWorks(run, base, key))) return {};
    // When Polar refuses the deployment's own token a change, the plan and the apply run again with a setup token.
    for (;;) {
      const token = await billingToken(run);
      const done = await inPrivateFolder(async (folder) => {
        const env = billingEnv(base, key, token.value, folder);
        const plan = await pnpmBilling(["plan", ...flags], env);
        if (polarRefusedToken(plan)) return null;
        if (plan.status === 1) throw new Stop("pnpm billing plan refused, so nothing changed (above). Fix what it lists, then run connect again");
        if (plan.status !== 0) throw new Error("pnpm billing plan stopped (above). Fix what it says, then run connect again");
        if (assumeYes) console.log("  --yes: applying the plan without asking");
        await confirm(`  Apply that plan to ${base} and Polar's ${s.POLAR} organization?`);
        // The webhook's secret goes through a file in the private folder, never through what pnpm billing prints, all of
        // which goes to the log.
        const file = path.join(folder, "railway.env");
        const apply = await pnpmBilling(["apply", ...flags, "--yes", "--railway-file", file], env);
        const values = fs.existsSync(file) ? readVariableSections(fs.readFileSync(file, "utf8")) : {};
        const secret = values.admin?.POLAR_WEBHOOK_SECRET;
        if (secret) {
          // Kept at once, so a step that fails after this one still has it. Polar lists it again to a token that can
          // read webhooks.
          run.state.values.POLAR_WEBHOOK_SECRET = hide(secret);
          save(run);
          console.log("  kept the new webhook's secret, for the admin (connect.billing.secret)");
        }
        const organization = values.worker?.POLAR_ORGANIZATION_ID;
        if (organization && organization.toLowerCase() !== String(polarOrganization(run)).toLowerCase()) throw new Error(`pnpm billing apply set up Polar organization ${organization}, but the deployment uses ${polarOrganization(run)}`);
        // What the refused apply made in Polar, the next one finds again by its tags.
        if (polarRefusedToken(apply)) return null;
        // 1 is drift as well as a refusal: on a first run, apply's own check always finds the admin without the
        // webhook's secret. The next steps set it, and verify decides.
        if (apply.status !== 0 && apply.status !== 1) throw new Error("pnpm billing apply stopped (above). Run connect again: what it made in Polar is found again by its tags");
        return {};
      });
      if (done) return done;
    }
  });
  if (!dryRun && !run.state.done["connect.billing.apply"]) return;
  await step(run, "connect.billing.secret", "POLAR_WEBHOOK_SECRET on the admin: the signing secret of Polar's webhook, which redeploys it", async () => {
    const token = await billingToken(run);
    const endpoints = (await polarList(run, token.value, "/v1/webhooks/endpoints")).filter((endpoint) => withoutTrailingSlash(endpoint.url) === withoutTrailingSlash(webhookUrl));
    if (!endpoints.length) {
      // The apply didn't make it, such as when it was refused after the plan: it runs again.
      delete run.state.done["connect.billing.apply"];
      save(run);
      throw new Error(`Polar has no webhook to ${webhookUrl}, so connect.billing.apply runs again next time. Fix what pnpm billing apply listed, then run connect again`);
    }
    if (endpoints.length > 1) throw new Error(`Polar has ${endpoints.length} webhooks to ${webhookUrl}. Delete all but one in Polar (Settings > Webhooks), then run connect again`);
    const secret = endpoints[0].secret;
    if (typeof secret !== "string" || !secret) throw Object.assign(new Error("Polar didn't show the webhook's secret to that token: it needs webhooks:write"), { service: "Polar" });
    hide(secret);
    if (v(run, "POLAR_WEBHOOK_SECRET") && v(run, "POLAR_WEBHOOK_SECRET") !== secret) console.log("  Polar's webhook has another secret than the state file kept: Polar's is the one that counts, so it's used");
    const base = await answeringAdmin(hosts);
    const key = await operatorKey(run);
    // The admin reports the hash of the secret it runs with, never the secret, inside its API's data envelope.
    const running = async () => (await http("The admin", `${base}/api/v1/billing/catalog`, { headers: { Authorization: `Bearer ${key}` } }))?.data?.polar?.secret_sha256 ?? null;
    if ((await running()) === hashText(secret)) {
      console.log("  = the admin runs with the webhook's secret already");
      return { POLAR_WEBHOOK_SECRET: secret };
    }
    const serviceId = v(run, "RAILWAY_SERVICE_IDS").admin;
    let started = await setAdminVariables(run, { POLAR_WEBHOOK_SECRET: secret });
    if (!started) {
      // Railway has it, but the admin runs a deployment from before: deploy it again.
      started = { after: (await latestDeployment(run, serviceId))?.id ?? null };
      await railway(Q.redeploy, { environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId });
    }
    console.log("  waiting for the admin's new deployment (a few minutes)");
    await waitForDeployment(run, "admin", serviceId, started);
    // Railway may still send a request or two to the deployment from before.
    let reported;
    for (let tries = 1; (reported = await running().catch(() => undefined)) !== hashText(secret); tries += 1) {
      if (tries >= 40) {
        const what = reported === undefined ? "didn't answer GET /api/v1/billing/catalog" : reported === null ? "reports no POLAR_WEBHOOK_SECRET" : "runs with another POLAR_WEBHOOK_SECRET";
        throw new Error(`the admin's new deployment ${what}, so not the webhook's secret. Check its variables and deployment in Railway, then run connect again`);
      }
      await pollPause();
    }
    console.log("  the admin runs with the webhook's secret");
    return { POLAR_WEBHOOK_SECRET: secret };
  });
  if (!dryRun && !run.state.done["connect.billing.secret"]) return;
  await step(run, "connect.billing.verify", "pnpm billing verify: billing.json, the admin's tables and Polar agree", async () => {
    const base = await answeringAdmin(hosts);
    const key = await operatorKey(run);
    let result;
    do {
      const token = await billingToken(run);
      result = await inPrivateFolder((folder) => pnpmBilling(["verify", ...flags], billingEnv(base, key, token.value, folder)));
    } while (polarRefusedToken(result));
    if (result.status === 1) {
      // The apply finds what exists and changes only what differs, so running it again is how a difference is fixed.
      for (const id of ["connect.billing.apply", "connect.billing.secret"]) delete run.state.done[id];
      save(run);
      throw new Stop("pnpm billing verify found differences (the DRIFT lines above). Fix what they say, then run connect again: it runs the apply again, and asks for yes");
    }
    if (result.status !== 0) throw new Error("pnpm billing verify couldn't read all it checks (above). Run connect again once that's fixed");
    // A token of the deployment's own stays: it's the one the admin or the worker runs with.
    console.log(billingRun.token?.own ? `  Polar sells the plans, set up with ${billingRun.token.own} Polar token.` : `  Polar sells the plans. Delete the setup token now, in Polar's ${s.POLAR} organization (Settings > Developers).`);
  });
}

async function connect(run) {
  const s = run.settings;
  if (!run.state.done["deploy.admin"]) throw new Error("run up first, and finish it");
  // APP_BASE_URL set or changed after up ran: Railway, Cloudflare and the admin's variables don't know the address yet.
  // post.dns records the address it was done for; state files from before only have APP_HOST.
  if (s.CUSTOM_HOST && (!run.state.done["post.dns"] || (v(run, "POST_DNS_HOST") ?? v(run, "APP_HOST")) !== s.CUSTOM_HOST)) {
    throw new Error(`up ran before APP_BASE_URL was ${s.CUSTOM_HOST}, so the admin isn't on that address yet. Run: node devops/bootstrap.mjs redo ${run.file} railway.domain railway.custom turnstile variables "post.*", then up, then connect again`);
  }
  // The project as Railway has it now, and the admin's Railway address: a state file can name an address from an
  // earlier, deleted project, which answers "Application not found".
  if (!dryRun) await projectView(run);
  const railwayHost = dryRun ? v(run, "RAILWAY_HOST") : await currentRailwayHost(run);
  const host = appHost(run);
  const webhookUrl = `https://${host}/api/webhooks/openai/live`;
  const openaiProject = v(run, "OPENAI_PROJECT_ID") ? `${v(run, "OPENAI_PROJECT_ID")}${v(run, "OPENAI_PROJECT_NAME") ? ` ("${v(run, "OPENAI_PROJECT_NAME")}")` : ""}` : `"${nameFor(run, "OPENAI_PROJECT_NAME")}"`;
  console.log(`${dryRun ? "Dry run: nothing is called or changed.\n" : ""}${baseName(s)} at https://${host}${config ? `, keys from ${config.file}` : ""}\n`);
  if (!dryRun && run.state.done["connect.webhook"] && v(run, "WEBHOOK_URL") && v(run, "WEBHOOK_URL") !== webhookUrl) {
    // The address changed since the webhook was made, such as for a new project without APP_BASE_URL. There's no API
    // to change a webhook, so a person does it, and its signing secret stays the same.
    byHandSkipped = false;
    await byHand([`OpenAI's incoming-call webhook was made for ${v(run, "WEBHOOK_URL")}, but the admin is at https://${host} now.`,
      `In the OpenAI project ${openaiProject}: Settings > Webhooks, open that webhook and change its URL to ${webhookUrl} (its secret stays).`]);
    if (!byHandSkipped) {
      run.state.values.WEBHOOK_URL = webhookUrl;
      save(run);
    }
  }
  await step(run, "connect.health", `https://${host}/api/health/ready answers "ok":true with the ${s.BRAND} brand`, async () => {
    // Both of the admin's addresses are tried: APP_BASE_URL's may still wait for DNS or its certificate.
    const failures = [];
    for (const candidate of [...new Set([host, railwayHost].filter(Boolean))]) {
      const health = await http("The admin", `${process.env.BOOTSTRAP_APP_URL ?? `https://${candidate}`}/api/health/ready`).catch((error) => ({ failed: error.message }));
      if (health?.failed || health?.ok !== true) {
        failures.push(`https://${candidate}: ${health?.failed ?? JSON.stringify(health)}`);
        continue;
      }
      const brand = typeof health.brand === "string" ? health.brand : health.brand?.id;
      if (brand && brand !== s.BRAND) throw new Error(`the admin shows the ${brand} brand, not ${s.BRAND}`);
      if (candidate !== host) console.log(`  https://${host} doesn't answer yet, but https://${candidate} does: DNS or the certificate for ${host} is still on its way. The webhook still uses https://${host}.`);
      return;
    }
    throw new Error(`the admin isn't ready yet (${failures.join("; ")}). Check its deployment, then run again`);
  });
  await step(run, "connect.webhook", "OpenAI's incoming-call webhook (OpenAI's API can't make this one yet)", async () => {
    // WEBHOOK_URL: the address the webhook is for, so a later run can tell when the admin's address has changed.
    if (!given("OPENAI_WEBHOOK_SECRET")) {
      const onRailway = await railwayVariable(run, "admin", "OPENAI_WEBHOOK_SECRET");
      if (onRailway) {
        console.log("  To use a new webhook's secret instead, put it as OPENAI_WEBHOOK_SECRET in the secrets file and redo connect.webhook.");
        return { OPENAI_WEBHOOK_SECRET: onRailway, WEBHOOK_URL: webhookUrl };
      }
    }
    // OpenAI sends a call only to the webhooks of the project the trunk names: one made in another project never hears
    // of these calls (seen on realinfobot-test1, whose calls rang unanswered).
    if (!given("OPENAI_WEBHOOK_SECRET")) {
      await byHand([
        `In the OpenAI project ${openaiProject}, the one the Twilio trunk sends calls to (pick it in the project menu at the`,
        "top left of platform.openai.com first): Settings > Webhooks > Create (guide 3.2, steps 14 to 16).",
        `URL: ${webhookUrl}   (no slash at the end)`,
        "Event types: only live.transport.incoming. Copy the whsec_ signing secret it shows once.",
      ]);
      // --yes didn't wait for the webhook, so there's no secret to ask for yet: the step stays open.
      if (byHandSkipped) return {};
    }
    return { OPENAI_WEBHOOK_SECRET: await secret("OPENAI_WEBHOOK_SECRET", "The webhook's signing secret (whsec_...)", (answer) => answer.startsWith("whsec_")), WEBHOOK_URL: webhookUrl };
  });
  await step(run, "connect.platformKey", "The operator's platform key (pnpm platform-key:create)", async () => {
    // The admin's current keys are kept: a new key is added to them, never put in their place.
    const current = (await railwayVariable(run, "admin", "PLATFORM_API_KEYS")) ?? "";
    let entries = [];
    try {
      entries = current ? JSON.parse(current) : [];
    } catch {
      throw new Error("the admin's PLATFORM_API_KEYS isn't valid JSON. Fix it in Railway first, then run again");
    }
    const mine = Array.isArray(entries) && entries.find((entry) => entry?.partner === "operator" && entry?.owner_email === s.OPERATOR_EMAIL);
    if (mine) {
      console.log(`  = the admin already has an operator key for ${s.OPERATOR_EMAIL} (${mine.prefix}). To make a new one, remove that entry from PLATFORM_API_KEYS on the admin and redo connect.platformKey.`);
      return { PLATFORM_API_KEYS: current };
    }
    const result = runTool("pnpm", ["--silent", "platform-key:create", "--name", "Operator key", "--partner", "operator", "--owner-email", s.OPERATOR_EMAIL, "--access", "all"], {
      env: { ...process.env, PLATFORM_API_KEYS: current },
    });
    if (missingTool(result)) throw new Error("pnpm isn't installed: npm install --global pnpm, then pnpm install in the repository folder, then run again");
    if (result.status !== 0) throw new Error(`pnpm platform-key:create failed: ${(result.stderr || result.stdout || "").trim().split("\n").at(-1)}`);
    const last = result.stdout.trim().split(/\r?\n/).at(-1);
    if (!last?.startsWith("[")) throw new Error("pnpm platform-key:create didn't print the PLATFORM_API_KEYS value");
    const file = result.stdout.match(/Key written to (.+?\.json)/)?.[1];
    console.log(`  The key itself is in ${file ?? ".platform-keys/"}: move it to the password manager, then delete the file.`);
    // The file's path, not the key, so the last message can name it.
    return { PLATFORM_API_KEYS: last, ...(file ? { PLATFORM_KEY_FILE: file } : {}) };
  });
  // connect.variables puts both values on the admin together, so it waits for a webhook --yes didn't wait for.
  if (!dryRun && !run.state.done["connect.webhook"]) return console.log(openByHand(run, "connect"));
  await step(run, "connect.variables", "OPENAI_WEBHOOK_SECRET and PLATFORM_API_KEYS on the admin, which redeploys it", async () => {
    // The billing steps wait for this deployment before they use the key.
    billingRun.redeploy = await setAdminVariables(run, { OPENAI_WEBHOOK_SECRET: v(run, "OPENAI_WEBHOOK_SECRET"), PLATFORM_API_KEYS: v(run, "PLATFORM_API_KEYS") });
  });
  const cloud = s.DEPLOYMENT_MODE === "cloud";
  const stripe = s.BILLING_PROVIDER === "stripe";
  if (cloud && !stripe) {
    console.log("\nPolar billing");
    await polarBillingSteps(run, [host, railwayHost]);
    // A step --yes didn't wait at, such as the sign-up, leaves the rest for the next run.
    if (!dryRun && !run.state.done["connect.billing.verify"]) return console.log(openByHand(run, "connect"));
  }
  if (dryRun) return;
  // The command line's profile is local, so it keeps the settings file's NAME when there is one. The command line
  // takes up to 40 letters, digits, dashes or underscores.
  const profile = (s.NAME || baseName(s)).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "") || "default";
  const keyFile = v(run, "PLATFORM_KEY_FILE") && fs.existsSync(v(run, "PLATFORM_KEY_FILE")) ? v(run, "PLATFORM_KEY_FILE") : null;
  const login = `pnpm lobbystack login --url https://${host} --key-stdin --profile ${profile}`;
  const billing = (command) => `pnpm billing ${command} --brand ${s.BRAND} --stripe ${s.STRIPE} --profile ${profile}`;
  const billingFile = `.env.stripe-${profile}`;
  const noStripeBlock = stripe && brandHasStripeBlock(s.BRAND) === false ? `
     First, brands/${s.BRAND}/billing.json needs a stripe block, which it hasn't yet: add one in a pull request
     (brands/README.md), and deploy it.` : "";
  // With Polar, connect did the billing above, which needs the operator's account, so the sign-up is done too. A setup
  // token goes once billing is set up: the one this run used, or one an earlier run may have asked for. A token of the
  // deployment's own stays, as the admin or the worker runs with it.
  const setupTokenGoes = billingRun.token?.own ? []
    : [billingRun.token ? `In Polar's ${s.POLAR} organization, Settings > Developers, delete the setup token: billing is set up, and nothing else uses it.`
      : `If connect asked for a setup token, delete it in Polar's ${s.POLAR} organization (Settings > Developers): billing is set up, and nothing else uses it.`];
  const steps = [
    ...(cloud && !stripe ? setupTokenGoes : [`Once the admin's new deployment is Active, sign up at https://${host}/en/signup as ${s.OPERATOR_EMAIL},
     with the 6-digit code from the email.`]),
    `Sign the command line in with the operator key${keyFile ? ` (in ${keyFile})` : ""}:
     ${keyFile ? `PowerShell: (Get-Content "${keyFile}" -Raw | ConvertFrom-Json).key | ${login}` : login}
     ${keyFile ? `Or run ${login}, paste` : "Paste"} the key, press Enter, then Ctrl+D (in PowerShell or cmd: Ctrl+Z, then Enter).${keyFile ? `
     Then move the key to the password manager and delete the file.` : ""}`,
    ...(cloud && stripe ? [`Stripe (guide 3.7, "Selling plans (Stripe)", steps 6 to 8), with a setup key (STRIPE_SETUP_KEY) made in
     the same Stripe ${s.STRIPE === "live" ? "account's live mode" : "sandbox"} as the deployment's keys:${noStripeBlock}
     ${billing("plan")}
     ${billing("apply")} --railway-file ${billingFile}
     Then run node devops/railway-vars.mjs ${billingFile}, which asks for a Railway project token
     (the project's Settings > Tokens). Delete the file once the admin has redeployed. Set what
     plan lists for Stripe's Dashboard, which Stripe's API can't, then check:
     ${billing("verify")}     (should end "Result: in sync (exit 0)")`] : []),
    `Set up the first business and buy its number (guide 6.3 and 6.4), then call it: the receptionist answers.
     If it rings with no answer, check that the webhook is in the OpenAI project ${openaiProject}.`,
    `Optional, in Git Bash: pnpm smoke:production (guide 4.9) with this deployment's values on the same line,
     ADMIN_BASE_URL=https://${host} SMOKE_EXPECTED_NUMBERS=<the number> and the Twilio values from the .vars file;
     without them it checks the original project's address and numbers.`,
  ];
  console.log(`
Done by the script${cloud && !stripe ? ", Polar billing included" : ""}. What's left needs you (guide 4.8, 4.9 and 6.1):
${steps.map((text, index) => `  ${index + 1}. ${text}`).join("\n")}${openByHand(run, "connect")}`);
}

// ---------------------------------------------------------------- status

function status(run) {
  const s = run.settings;
  console.log(`${baseName(s)}: ${run.stateFile}`);
  for (const line of nameLines(run)) console.log(`  ${line}`);
  console.log(`  secrets file: ${config ? config.file : "none (keys come from the environment or are asked for)"}`);
  const log = `${run.file}.log`;
  console.log(`  log: ${fs.existsSync(log) ? log : `${log} (not written yet)`}`);
  const done = Object.entries(run.state.done);
  if (!done.length) console.log("  nothing done yet: run up");
  for (const [id, at] of done) console.log(`  done  ${at}  ${id}`);
  // Steps whose BY HAND part --yes didn't wait for: they run again, and wait, at the next run without --yes.
  for (const [id, title] of Object.entries(run.state.byHand ?? {}).filter(([id]) => !run.state.done[id])) console.log(`  OPEN  by hand: ${id} (${title})`);
  const host = appHost(run);
  if (host) console.log(`  address: https://${host}`);
  console.log(`  values kept (never printed): ${Object.keys(run.state.values).length}`);
  if (done.length) console.log(`\nTo run a step again: node devops/bootstrap.mjs redo ${run.file} <step>, then the same command as before.`);
}

// ---------------------------------------------------------------- redo

// Steps that pass on what another step found: redoing that step runs them again too, so a new value gets where it's
// used. Without this, a redone key stayed in the state file and never reached Railway.
const PASSED_ON = {
  "openai.project": ["openai.key", "twilio.origination"],
  "openai.manual": ["twilio.origination", "variables"],
  "openai.key": ["variables"],
  "twilio.subaccount": ["twilio.trunk", "variables"],
  "twilio.manual": ["twilio.origination", "variables"],
  "twilio.trunk": ["twilio.origination", "variables"],
  "resend.key": ["variables"],
  "resend.manual": ["variables"],
  "turnstile": ["variables"],
  "polar.tokens": ["variables"],
  "stripe.keys": ["variables"],
  "twilio.tollfree": ["variables"],
  "secrets": ["variables"],
  "connect.webhook": ["connect.variables"],
  "connect.platformKey": ["connect.variables"],
  "connect.billing.apply": ["connect.billing.secret", "connect.billing.verify"],
  "connect.billing.secret": ["connect.billing.verify"],
};

/** Takes the done mark off steps, so the next up or connect runs them again. Their values stay, and each step finds what it made before. */
function redo(run, wanted) {
  const done = Object.keys(run.state.done);
  if (!wanted.length) throw new Stop(`name the step to run again, such as twilio.trunk, or a group such as twilio.* Finished steps:\n  ${done.join("\n  ") || "(none)"}`);
  const matches = done.filter((id) => wanted.some((want) => id === want || (want.endsWith("*") && id.startsWith(want.slice(0, -1)))));
  if (!matches.length) throw new Stop(`no finished step matches ${wanted.join(" ")}. Finished steps:\n  ${done.join("\n  ") || "(none)"}`);
  const again = new Set(matches);
  for (const id of again) for (const next of PASSED_ON[id] ?? []) if (run.state.done[next]) again.add(next);
  for (const id of again) {
    delete run.state.done[id];
    console.log(`  ${id}: runs again next time${matches.includes(id) ? "" : ", to pass on what it uses"}`);
  }
  // Redoing the project step means a new project, such as after deleting the old one in Railway:
  // forget the old project's IDs and address too, or the next steps would keep using them.
  if (matches.includes("railway.project")) {
    for (const key of ["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_IDS", "RAILWAY_HOST", "APP_HOST", "POST_DNS_HOST"]) delete run.state.values[key];
    // Every step that made or set something in the old project runs again in the new one. The secrets stay (the new
    // database gets the same passwords), and so do the webhook's secret and the operator key, which connect puts on
    // the new admin. Without APP_BASE_URL the address changes, and with it the toll-free number's texting URL. The
    // billing steps run again too: the new database has no plans yet, and Polar's webhook may need the new address.
    const projectBound = (id) => /^(railway\.|deploy\.|post\.|connect\.billing\.)/.test(id) || ["turnstile", "variables", "connect.health", "connect.variables"].includes(id) || (id === "twilio.tollfree" && !run.settings.CUSTOM_HOST);
    for (const id of Object.keys(run.state.done).filter(projectBound)) {
      delete run.state.done[id];
      console.log(`  ${id}: runs again next time`);
    }
    console.log("  forgot the Railway project's IDs and address, so up finds or makes the project again");
    if (run.state.done["connect.webhook"] && !run.settings.CUSTOM_HOST) console.log("  The new project gets a new Railway address: connect then says to change OpenAI's webhook URL to it (the secret stays).");
  }
  save(run);
  if (matches.includes("railway.project")) return console.log(`\nNow run up, then connect. The project is found by name, or made if there's none (a project being deleted doesn't count).`);
  console.log(`\nNow run the command that made ${matches.length === 1 ? "it" : "them"} again (up, or connect for connect.* steps). What exists is found and reused or updated, not made twice.`);
}

// ---------------------------------------------------------------- troubleshooting

const PROVIDERS = {
  Railway: { token: "RAILWAY_API_TOKEN", make: "https://railway.com/account/tokens", status: "https://status.railway.com",
    needs: "an account token, or a workspace token for RAILWAY_WORKSPACE_ID (a project token can't create projects)" },
  OpenAI: { token: "OPENAI_ADMIN_KEY", make: "https://platform.openai.com/settings/organization/admin-keys", status: "https://status.openai.com",
    needs: "an admin key, which only an organization owner can make (a project's API key can't create projects)" },
  Twilio: { token: "TWILIO_MAIN_ACCOUNT_SID and TWILIO_MAIN_AUTH_TOKEN (or, for the trunk and numbers, TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)",
    make: "https://console.twilio.com (Account Info)", status: "https://status.twilio.com",
    needs: "the main account's Account SID and Auth Token, on an account upgraded from trial (API keys can't create subaccounts)" },
  Resend: { token: "RESEND_ADMIN_KEY", make: "https://resend.com/api-keys", status: "https://resend-status.com",
    needs: "a Full access key (a Sending access key can't create domains or keys)" },
  Cloudflare: { token: "CLOUDFLARE_API_TOKEN", make: "https://dash.cloudflare.com/profile/api-tokens", status: "https://www.cloudflarestatus.com",
    needs: "Zone > DNS > Edit on the zone, and Account > Turnstile > Edit on the account" },
  Stripe: { token: "STRIPE_ADMIN_KEY or STRIPE_WORKER_KEY", make: "https://dashboard.stripe.com/apikeys (Create restricted key)", status: "https://status.stripe.com",
    needs: "a restricted key of the deployment's own account and mode, with the permissions docs/providers/stripe.md lists" },
  Polar: { token: "the Polar token named above", make: "Polar: the organization's Settings > Developers > New Token", status: "https://status.polar.sh",
    needs: "an organization token of the deployment's organization, made in Polar's sandbox or live as POLAR says (each knows only its own tokens), with the scopes guide 3.7 lists" },
};

/** Suggestions for an error, from what failed and how. */
function hints(error) {
  const tips = [];
  const provider = PROVIDERS[error.service];
  const doctorLine = target ? `Check every token and tool without changing anything: node devops/bootstrap.mjs doctor ${target}` : null;
  const message = error.message ?? "";
  if (error.network) {
    tips.push(`Check that this computer reaches ${error.service}: the internet connection, a VPN, or a firewall. If your network needs a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1, which recent Node.js versions read.`);
    if (provider) tips.push(`See whether ${error.service} has an outage: ${provider.status}`);
  } else if (error.status === 401 || (!error.status && /not authorized|unauthori[sz]ed|invalid api key|authenticate/i.test(message))) {
    if (provider) {
      tips.push(`${error.service} didn't accept ${provider.token}. Copy it again in full (no spaces or quotes), and check it isn't expired, deleted, or for another account.`);
      tips.push(`It must be ${provider.needs}. Make one at ${provider.make}`);
    }
    if (doctorLine) tips.push(doctorLine);
  } else if (error.status === 403 || (!error.status && /forbidden|permission|insufficient/i.test(message))) {
    if (provider) tips.push(`${provider.token} works but isn't allowed to do this. It must be ${provider.needs}.`);
    if (error.service === "Twilio" && /trial/i.test(message)) tips.push("Upgrade the Twilio account from trial (guide 3.3, step 2): trial accounts can't make subaccounts or buy numbers.");
  } else if (error.status === 404) {
    tips.push(`${error.service} doesn't have something this step needs; it may have been deleted by hand. Run node devops/bootstrap.mjs status ${target ?? "<settings file>"}, then redo the step that made it, and run again.`);
  } else if (error.status === 409 || error.status === 422 || error.status === 400) {
    tips.push(`${error.service} refused the request as it stands: read its message above. Something with the same name may already exist with other settings, or a value in the settings file may be off.`);
  } else if (error.status === 429) {
    tips.push(`${error.service} is limiting requests. Wait a few minutes, then run the same command again.`);
  } else if (error.status >= 500 || (!error.status && /problem processing request|internal server error|timed? ?out/i.test(message))) {
    tips.push(`${error.service ?? "The service"} had a problem on its side. Run the same command again in a few minutes${provider ? `, and check ${provider.status}` : ""}.`);
  }
  if (/workspace/i.test(message) && error.service === "Railway") tips.push("Set RAILWAY_WORKSPACE_ID in the settings file to the workspace's ID (Railway: the workspace's Settings, General tab, Workspace ID; doctor lists them), and use a token that can reach it.");
  if (/no valid value given/.test(message)) tips.push("The script needed a value and got none. Put it in the secrets file (see init), or run in a terminal where you can type it.");
  if (currentStep === "resend.key") tips.push("If Resend won't make a key limited to one domain, make a Sending access key for the domain at https://resend.com/api-keys, put it as SMTP_PASSWORD in the secrets file, and run again.");
  if (currentStep === "railway.domain") tips.push("Railway may not give an address before the service's first deploy. Run up again once the admin has deployed once (guide 4.6).");
  if (currentStep?.startsWith("railway.volume")) tips.push("If the volume was made by hand already, check it's on the right service and mount path; the script then finds it.");
  if (currentStep === "connect.platformKey") tips.push("Run pnpm install in the repository folder first: the platform key is made by pnpm platform-key:create.");
  return tips;
}

// ---------------------------------------------------------------- doctor

/** Checks the settings, the tools and every token it can find, with read-only calls. Asks nothing and changes nothing. */
async function doctor(run) {
  const s = run.settings;
  let fixes = 0;
  const ok = (text) => console.log(`  ok     ${text}`);
  const note = (text) => console.log(`  note   ${text}`);
  const fix = (text) => {
    fixes += 1;
    console.log(`  FIX    ${text}`);
  };
  const tool = (name, args) => runTool(name, args);
  console.log(`Checking ${run.file}. Nothing is changed.\n`);

  console.log("This computer");
  const major = Number(process.versions.node.split(".")[0]);
  (major >= 18 ? ok : fix)(`Node.js ${process.version}${major >= 18 ? "" : ": needs 18 or later"}`);
  const secretFiles = [run.file, run.stateFile, config?.file, logPath, `${run.file}.vars`].filter((file) => file && fs.existsSync(file));
  for (const file of [run.file, run.stateFile, config?.file, logPath].filter(Boolean)) {
    const ignored = tool("git", ["check-ignore", "-q", file]);
    if (ignored.status === 1) fix(`Git doesn't ignore ${file}: name it .env.<something>, or add it to .gitignore, so it's never committed`);
  }
  if (process.platform === "win32") {
    // Windows ignores the files' 0600 mode. A folder made at the top of a drive, such as C:\repos, lets every account on
    // the computer read what's in it. icacls names the groups in the system's language, so this only knows English ones.
    const readable = secretFiles.filter((file) => /\\Users:|Authenticated Users:|Everyone:/i.test(tool("icacls", [file]).stdout ?? ""));
    if (readable.length) note(`other accounts on this computer can read ${readable.join(", ")}. To keep them to yours, in PowerShell: icacls <file> /inheritance:r /grant:r "\${env:USERNAME}:F"`);
  }
  const pnpm = tool("pnpm", ["--version"]);
  (pnpm.status === 0 ? ok : fix)(pnpm.status === 0 ? `pnpm ${pnpm.stdout.trim()} (connect uses it for the platform key${s.DEPLOYMENT_MODE === "cloud" && s.BILLING_PROVIDER === "polar" ? " and pnpm billing" : ""})` : missingTool(pnpm) ? "pnpm isn't installed: connect needs it (npm install --global pnpm, then pnpm install here)" : `pnpm didn't run: ${firstLine(pnpm)}`);
  const cli = tool(RAILWAY_CLI, ["--version"]);
  (cli.status === 0 ? ok : note)(cli.status === 0 ? `Railway CLI ${cli.stdout.trim()} (makes the bucket)` : "no Railway CLI: you'll make the bucket by hand (npm install --global @railway/cli to avoid that)");
  if (s.STEP_GITHUB) {
    const gh = tool("gh", ["api", `repos/${s.REPO}/contents/brands/${s.BRAND}/brand.json?ref=${s.BRANCH}`, "--jq", ".name"]);
    if (missingTool(gh)) note(`no GitHub CLI: you'll check ${s.REPO} by hand`);
    else if (gh.status === 0) ok(`${s.REPO}@${s.BRANCH} has brands/${s.BRAND}`);
    else if (/auth login|not logged in|authentication|HTTP 401/i.test(`${gh.stderr ?? ""}`)) fix("gh isn't signed in: run gh auth login");
    else fix(`${s.REPO}@${s.BRANCH} has no brands/${s.BRAND}/brand.json. Click Sync fork on GitHub if the brand is missing`);
  }

  console.log("\nSettings and keys");
  ok(`${baseName(s)}: ${s.ENVIRONMENT}, ${s.DEPLOYMENT_MODE}, brand ${s.BRAND}, from ${s.REPO}@${s.BRANCH}`);
  for (const line of nameLines(run)) note(line);
  if (s.CUSTOM_HOST) note(`APP_BASE_URL https://${s.CUSTOM_HOST}: up adds it to Railway, ${s.CLOUDFLARE_ZONE ? `writes its CNAME in ${s.CLOUDFLARE_ZONE}` : "prints its DNS records for you"}, and adds it to the Turnstile widget`);
  const off = ["GITHUB", "OPENAI", "TWILIO", "RESEND", "TURNSTILE"].filter((name) => !s[`STEP_${name}`]);
  if (off.length) note(`turned off: ${off.map((name) => `STEP_${name}`).join(", ")} (their values come from the secrets file, or are asked for)`);
  if (config) ok(`secrets file ${config.file}: ${Object.keys(config.flat).length} values (names only: ${Object.keys(config.flat).sort().join(", ") || "none"})`);
  else note("no secrets file: up will ask for each key (init writes one)");
  const done = Object.keys(run.state.done).length;
  note(done ? `${done} steps already done (status lists them)` : "nothing done yet");
  const open = Object.keys(run.state.byHand ?? {}).filter((id) => !run.state.done[id]);
  if (open.length) note(`waiting for you by hand, since --yes didn't wait: ${open.join(", ")}. Run again without --yes and press Enter at each once it's done`);

  console.log("\nTokens (read-only calls)");
  const quietGiven = (name) => process.env[name]?.trim() || config?.flat[name];
  const bearer = (value) => ({ Authorization: `Bearer ${value}` });
  const check = async (label, name, call) => {
    const value = quietGiven(name);
    if (!value) return note(`${label}: ${name} isn't set, so up will ask for it`);
    hide(value);
    try {
      const detail = await call(value);
      ok(`${label}: ${name} works${detail ? ` (${detail})` : ""}`);
    } catch (error) {
      fix(`${label}: ${name} was refused: ${error.message}`);
      for (const tip of hints(error)) console.log(`         ${tip}`);
    }
  };
  await check("Railway", "RAILWAY_API_TOKEN", async (value) => {
    const query = s.RAILWAY_WORKSPACE_ID ? "query workspace($id: String!) { workspace(workspaceId: $id) { name } }" : "query me { me { email } }";
    const json = await http("Railway", URLS.railway, { method: "POST", headers: bearer(value), body: { query, variables: s.RAILWAY_WORKSPACE_ID ? { id: s.RAILWAY_WORKSPACE_ID } : {} } });
    if (json?.errors?.length) throw Object.assign(new Error(json.errors.map((item) => item.message).join("; ")), { service: "Railway", graphql: json.errors });
    return s.RAILWAY_WORKSPACE_ID ? `workspace ${json.data.workspace.name}` : "your account";
  });
  if (!s.RAILWAY_WORKSPACE_ID && !run.state.done["railway.project"]) {
    const value = quietGiven("RAILWAY_API_TOKEN");
    fix(`RAILWAY_WORKSPACE_ID is empty, and Railway needs it to make a project. ${value ? await workspaceList(value) : "Copy it from the workspace's Settings, General tab in Railway (Workspace ID)."}`);
  }
  const openaiGiven = config?.flat.OPENAI_API_KEY || config?.flat.OPENAI_PROJECT_ID;
  if (s.STEP_OPENAI && !openaiGiven && !run.state.done["openai.key"]) {
    await check("OpenAI", "OPENAI_ADMIN_KEY", async (value) => {
      const list = await http("OpenAI", `${URLS.openai}/organization/projects?limit=100`, { headers: bearer(value) });
      const name = nameFor(run, "OPENAI_PROJECT_NAME");
      const count = (list?.data ?? []).filter((project) => project.name === name && project.status !== "archived").length;
      if (count > 1) throw Object.assign(new Error(`OpenAI has ${count} active projects named "${name}", so up wouldn't know which to use: archive or rename the extra ones`), { service: "OpenAI" });
      return count ? `project "${name}" exists and will be reused` : `project "${name}" will be made`;
    });
  } else note("OpenAI: no admin key needed (the project and key are given, or done)");
  const twilioGiven = config?.flat.TWILIO_ACCOUNT_SID || config?.flat.TWILIO_AUTH_TOKEN;
  if (s.STEP_TWILIO && !twilioGiven && !run.state.done["twilio.subaccount"]) {
    const sid = quietGiven("TWILIO_MAIN_ACCOUNT_SID");
    await check("Twilio", "TWILIO_MAIN_AUTH_TOKEN", async (value) => {
      if (!sid) throw Object.assign(new Error("TWILIO_MAIN_ACCOUNT_SID isn't set"), { service: "Twilio" });
      const account = await http("Twilio", `${URLS.twilio}/Accounts/${sid}.json`, { headers: { Authorization: basic(sid, value) } });
      if (account?.type === "Trial") throw Object.assign(new Error("the account is still a trial, which can't make subaccounts or buy numbers"), { service: "Twilio", status: 403 });
      return `${account?.friendly_name ?? sid}, ${account?.type ?? "type unknown"}`;
    });
  } else note("Twilio: no main account token needed (the account is given, or done)");
  const subSid = config?.flat.TWILIO_ACCOUNT_SID ?? v(run, "TWILIO_ACCOUNT_SID");
  const subToken = config?.flat.TWILIO_AUTH_TOKEN ?? v(run, "TWILIO_AUTH_TOKEN");
  if (subSid && subToken) {
    try {
      const account = await http("Twilio", `${URLS.twilio}/Accounts/${subSid}.json`, { headers: { Authorization: basic(subSid, hide(subToken)) } });
      ok(`Twilio: account ${account?.friendly_name ?? subSid} answers with TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN`);
    } catch (error) {
      fix(`Twilio: TWILIO_ACCOUNT_SID with TWILIO_AUTH_TOKEN was refused: ${error.message}`);
    }
  }
  if (s.STEP_RESEND && !run.state.done["resend.key"]) {
    await check("Resend", "RESEND_ADMIN_KEY", async (value) => {
      const list = await http("Resend", `${URLS.resend}/domains`, { headers: bearer(value) });
      const found = list?.data?.find((domain) => domain.name === s.EMAIL_DOMAIN);
      return found ? `${s.EMAIL_DOMAIN} exists (${found.status ?? "status unknown"}) and will be reused` : `${s.EMAIL_DOMAIN} will be added`;
    });
  }
  if (s.CLOUDFLARE_ZONE || (s.STEP_TURNSTILE && s.CLOUDFLARE_ACCOUNT_ID)) {
    await check("Cloudflare", "CLOUDFLARE_API_TOKEN", async (value) => {
      const results = [];
      if (s.CLOUDFLARE_ZONE) {
        const zones = await http("Cloudflare", `${URLS.cloudflare}/zones?name=${encodeURIComponent(s.CLOUDFLARE_ZONE)}`, { headers: bearer(value) });
        if (!zones?.result?.length) throw Object.assign(new Error(`the token can't see a zone named ${s.CLOUDFLARE_ZONE}: check the name, and that the token's Zone Resources include it`), { service: "Cloudflare", status: 403 });
        results.push(`sees ${s.CLOUDFLARE_ZONE}`);
      }
      if (s.STEP_TURNSTILE && s.CLOUDFLARE_ACCOUNT_ID) {
        await http("Cloudflare", `${URLS.cloudflare}/accounts/${s.CLOUDFLARE_ACCOUNT_ID}/challenges/widgets?per_page=1`, { headers: bearer(value) });
        results.push("can read Turnstile widgets");
      }
      return results.join(", ");
    });
  }
  if (s.DEPLOYMENT_MODE === "cloud" && s.BILLING_PROVIDER === "stripe") {
    // Each key's mode, then its account, which the two must share.
    const accounts = {};
    for (const name of ["STRIPE_ADMIN_KEY", "STRIPE_WORKER_KEY"]) {
      const key = process.env[name]?.trim() || fromFile(name, { quiet: true }) || (run.state.done["stripe.keys"] ? v(run, name) : undefined);
      if (!key) {
        note(`Stripe: ${name} isn't set, so up will ask for it`);
        continue;
      }
      hide(key);
      const problem = stripeKeyProblem(name, key, s.STRIPE);
      if (problem) {
        fix(`Stripe: ${problem}`);
        continue;
      }
      try {
        accounts[name] = await stripeAccountOf(key);
        ok(`Stripe: ${name} works (account ${accounts[name]}${key.startsWith("sk_") ? "; a secret key, where a restricted key with only its permissions is safer" : ""})`);
      } catch (error) {
        fix(`Stripe: ${name} was refused: ${error.message}`);
        for (const tip of hints(error)) console.log(`         ${tip}`);
      }
    }
    if (accounts.STRIPE_ADMIN_KEY && accounts.STRIPE_WORKER_KEY && accounts.STRIPE_ADMIN_KEY !== accounts.STRIPE_WORKER_KEY) {
      fix(`Stripe: the admin's key belongs to account ${accounts.STRIPE_ADMIN_KEY}, and the worker's to ${accounts.STRIPE_WORKER_KEY}: make both in the deployment's own account`);
    }
    if (brandHasStripeBlock(s.BRAND) === false) note(`Stripe: brands/${s.BRAND}/billing.json has no stripe block yet, which pnpm billing --stripe needs after the deploy: add one in a pull request (brands/README.md)`);
  } else if (s.DEPLOYMENT_MODE === "cloud") {
    const polarToken = (name) => process.env[name]?.trim() || fromFile(name, { quiet: true }) || (run.state.done["polar.tokens"] ? v(run, name) : undefined);
    const admin = polarToken("POLAR_ADMIN_TOKEN");
    const worker = polarToken("POLAR_WORKER_TOKEN");
    // The admin's token can only open billing portals, so no read-only call checks it.
    (admin ? ok : note)(`Polar: POLAR_ADMIN_TOKEN ${admin ? "is set" : "isn't set, so up will ask for it"}`);
    if (admin && admin === worker) note("Polar: POLAR_ADMIN_TOKEN and POLAR_WORKER_TOKEN are one token, so the admin holds the worker's scopes too");
    // The worker's token reads its organization, which becomes POLAR_ORGANIZATION_ID; a setup token for connect must be of the same one.
    let expected = s.POLAR_ORGANIZATION_ID || v(run, "POLAR_ORGANIZATION_ID");
    const setup = process.env.POLAR_SETUP_TOKEN?.trim() || fromFile("POLAR_SETUP_TOKEN", { quiet: true });
    for (const [name, value] of [["POLAR_WORKER_TOKEN", worker], ["POLAR_SETUP_TOKEN", setup]]) {
      if (!value) {
        if (name === "POLAR_WORKER_TOKEN") note("Polar: POLAR_WORKER_TOKEN isn't set, so up will ask for it");
        continue;
      }
      hide(value);
      try {
        const organization = await polarOrganizationOf(run, value, name);
        if (expected && expected.toLowerCase() !== String(organization.id).toLowerCase()) fix(`Polar: ${name} belongs to the ${s.POLAR} organization ${organization.name} (${organization.id}), not to ${expected}`);
        else ok(`Polar: ${name} works (the ${s.POLAR} organization ${organization.name}, ${organization.id}${expected ? "" : ", which up makes POLAR_ORGANIZATION_ID"})`);
        expected ||= String(organization.id);
      } catch (error) {
        fix(`Polar: ${error.message}`);
        for (const tip of hints(error)) console.log(`         ${tip}`);
      }
    }
    // Without a setup token, connect sets the plans up with the deployment's own token when Polar lets it, the worker's
    // and then the admin's, as billingToken tries them.
    const own = [...new Set([worker, admin])].filter(Boolean);
    if (!setup && expected && own.length) {
      try {
        let user = null;
        for (const value of own) {
          if (await setsPlansUp(run, value, expected)) {
            user = value === worker ? "POLAR_WORKER_TOKEN" : "POLAR_ADMIN_TOKEN";
            break;
          }
        }
        if (user) ok(`Polar: connect sets the plans up with ${user}, which Polar shows the webhooks, so it needs no setup token`);
        else note(`Polar: the deployment's own ${own.length > 1 ? "tokens" : "token"} can't set plans up (Polar shows ${own.length > 1 ? "them" : "it"} no webhooks), so connect will ask for a setup token with ${SETUP_SCOPES}`);
      } catch (error) {
        note(`Polar: couldn't tell whether connect will need a setup token (${error.message})`);
      }
    }
  }
  const host = v(run, "APP_HOST") && appHost(run);
  if (host) {
    console.log("\nThe deployment");
    try {
      const health = await http("The admin", `${process.env.BOOTSTRAP_APP_URL ?? `https://${host}`}/api/health/ready`);
      (health?.ok === true ? ok : fix)(`https://${host}/api/health/ready says ${JSON.stringify(health)}`);
    } catch (error) {
      note(`https://${host}/api/health/ready doesn't answer yet (${error.message}); normal until the admin's first deploy finishes`);
    }
  }
  console.log(fixes ? `\n${fixes} thing${fixes === 1 ? "" : "s"} to fix first (FIX above).` : `\nNothing to fix. Next: node devops/bootstrap.mjs ${run.state.done["deploy.admin"] ? "connect" : "up"} ${run.file}${run.state.done["deploy.admin"] ? "" : " --dry-run"}`);
  process.exitCode = fixes ? 1 : 0;
}

// Last, so every declaration above is in place before the first step runs.
process.on("SIGINT", () => {
  console.error(`\nStopped by Ctrl+C${currentStep ? ` during ${currentStep}` : ""}. Finished steps are recorded: run the same command again to go on.`);
  prompter?.close();
  process.exit(130);
});

main()
  .catch((error) => {
    console.error(`\nStopped${currentStep ? ` at ${currentStep}` : ""}: ${error.message}`);
    if (error instanceof Stop) {
      process.exitCode = 1;
      return;
    }
    const tips = hints(error);
    if (tips.length) console.error(`\nWhat to try:\n${tips.map((tip) => `  - ${tip}`).join("\n")}`);
    if (logPath && command !== "init") {
      console.error(`\nFinished steps are recorded: fix the problem, then run the same command again.`);
      console.error(`Details, with every API call: ${logPath}${verbose ? "" : " (or run again with --verbose)"}`);
    }
    writeLog(`ERROR ${error.stack ?? error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prompter?.close());
