#!/usr/bin/env node
// bootstrap.mjs: sets up one LobbyStack environment on Railway, with its outside services,
// from one small settings file. It does in one run what the Railway deployment guide does by
// hand in sections 3 to 12, except the few steps that only a person can do, for which it stops
// and says what to do.
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
// Every step can run again safely: it finds what an earlier run made, by name, and reuses or
// updates it. Keys a provider shows only once (OpenAI's, Resend's) are read back from Railway
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

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
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
};
// The BOOTSTRAP_*_URL variables, BOOTSTRAP_APP_URL and BOOTSTRAP_RAILWAY_CLI exist for tests against stand-ins.
const RAILWAY_CLI = process.env.BOOTSTRAP_RAILWAY_CLI ?? "railway";

/**
 * Runs a command-line tool and returns spawnSync's result. On Windows, pnpm and the Railway CLI are
 * .cmd files that only start through the shell, and the shell splits arguments on spaces, so each
 * argument is quoted and the whole line goes to the shell as one string (an argument list with
 * shell: true would also print Node's DEP0190 warning).
 */
function runTool(command, args, options = {}) {
  if (process.platform !== "win32") return spawnSync(command, args, { encoding: "utf8", ...options });
  const quote = (arg) => (/^[\w@+=:,./\\-]+$/.test(String(arg)) ? String(arg) : `"${String(arg).replace(/"/g, '""')}"`);
  return spawnSync([command, ...args].map(quote).join(" "), { encoding: "utf8", ...options, shell: true });
}

const SETTINGS_TEMPLATE = `# Settings for node devops/bootstrap.mjs (see devops/bootstrap.md).
# Lines starting with # are ignored. Never put a comment after a value.

# What this environment is called everywhere: Railway project, OpenAI project, Twilio subaccount.
NAME=__NAME__
# The brand folder under brands/ (it must be on the branch below).
BRAND=
# test or production. production adds REQUIRE_EMAIL_VERIFICATION=true and no BRAND_PRESET.
ENVIRONMENT=test
# The repository and branch Railway builds from.
REPO=realinfobot/lobbystack
BRANCH=main
# self_hosted_standard (every business unlimited) or cloud (businesses buy plans through Polar).
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
RAILWAY_TEMPLATE=
TEMPLATE_PROJECT=
# The bucket's region, which never changes: sjc, iad, ams or sin.
BUCKET_REGION=iad
# Optional: the dashboard's own address, such as test.example.com. Empty: Railway's free address.
CUSTOM_HOST=

# Email through Resend. EMAIL_DOMAIN is the subdomain kept for email; EMAIL_FROM is on it.
EMAIL_DOMAIN=
EMAIL_FROM=
# us-east-1, eu-west-1, sa-east-1 or ap-northeast-1. It can't change later.
RESEND_REGION=us-east-1

# Cloudflare. CLOUDFLARE_ZONE is the domain name of the zone that holds EMAIL_DOMAIN and
# CUSTOM_HOST, such as example.com: the name, not the 32-character Zone ID that Cloudflare shows
# beside it. CLOUDFLARE_ACCOUNT_ID is the Account ID from the zone's Overview page (right-hand
# column, under API). Empty zone: the script prints the DNS records for you to add instead.
# Empty account ID: you make the Turnstile widget by hand.
CLOUDFLARE_ZONE=
CLOUDFLARE_ACCOUNT_ID=

# Twilio's shared toll-free number, only with DEPLOYMENT_MODE=cloud: buy (the script buys one),
# a number you already have in the subaccount (+18445550123), or empty for none.
TWILIO_TOLLFREE=

# Polar, only with DEPLOYMENT_MODE=cloud: the organization's ID, and sandbox or live.
POLAR_ORGANIZATION_ID=
POLAR=sandbox

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
# with # are ignored. For the tokens in the first group, the Polar tokens and the webhook
# secret, an environment variable of the same name wins over this file.

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
# Polar, only with DEPLOYMENT_MODE=cloud: the admin's and the worker's tokens (guide 5.5).
POLAR_ADMIN_TOKEN=
POLAR_WORKER_TOKEN=
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
const KEY_SHAPES = /\b(?:sk-[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9+/=_-]{16,}|re_[A-Za-z0-9_]{16,}|lsp_[A-Za-z0-9_]{16,}|polar_[a-z]{2,4}_[A-Za-z0-9_]{16,})/g;
const SECRET_KEYS = new Set(["OPENAI_API_KEY", "TWILIO_AUTH_TOKEN", "SMTP_PASSWORD", "TURNSTILE_SECRET_KEY", "POLAR_ADMIN_TOKEN",
  "POLAR_WORKER_TOKEN", "OPENAI_WEBHOOK_SECRET", "RAILWAY_API_TOKEN", "OPENAI_ADMIN_KEY", "TWILIO_MAIN_AUTH_TOKEN", "RESEND_ADMIN_KEY",
  "CLOUDFLARE_API_TOKEN", "POLAR_ACCESS_TOKEN", "S3_SECRET_ACCESS_KEY"]);

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
  const run = loadRun(target);
  if (command === "status") {
    logPath = null; // status only reads, so it doesn't add to the log either
    return status(run);
  }
  writeLog(`==== ${command} ${path.basename(target)}${dryRun ? " --dry-run" : ""}${assumeYes ? " --yes" : ""}${config ? ` (keys: ${config.file})` : ""} | node ${process.version} on ${process.platform} | bootstrap.mjs ${scriptVersion()}`);
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

function loadRun(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`couldn't read ${file} (${error.code ?? error.message})`);
  }
  const settings = {};
  const problems = [];
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const equals = line.indexOf("=");
    if (equals < 1) return problems.push(`line ${index + 1} isn't KEY=value`);
    settings[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  });
  const s = { ENVIRONMENT: "test", BRANCH: "main", DEPLOYMENT_MODE: "self_hosted_standard", BUCKET_REGION: "iad", RESEND_REGION: "us-east-1", POLAR: "sandbox", ...settings };
  for (const step of ["GITHUB", "OPENAI", "TWILIO", "RESEND", "TURNSTILE"]) s[`STEP_${step}`] = (s[`STEP_${step}`] ?? "yes").toLowerCase() !== "no";
  for (const key of ["NAME", "BRAND", "REPO", "OPERATOR_EMAIL", "EMAIL_FROM"]) if (!s[key]) problems.push(`${key} is empty`);
  if (s.STEP_RESEND && !s.EMAIL_DOMAIN) problems.push("EMAIL_DOMAIN is empty (or set STEP_RESEND=no)");
  if (!["self_hosted_standard", "cloud"].includes(s.DEPLOYMENT_MODE)) problems.push("DEPLOYMENT_MODE is self_hosted_standard or cloud");
  if (!["test", "production"].includes(s.ENVIRONMENT)) problems.push("ENVIRONMENT is test or production");
  if (!["sjc", "iad", "ams", "sin"].includes(s.BUCKET_REGION)) problems.push("BUCKET_REGION is sjc, iad, ams or sin");
  if (!["sandbox", "live"].includes(s.POLAR)) problems.push("POLAR is sandbox or live");
  if (s.REPO && !/^[\w.-]+\/[\w.-]+$/.test(s.REPO)) problems.push("REPO is owner/name");
  if (s.CUSTOM_HOST && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.CUSTOM_HOST)) problems.push("CUSTOM_HOST is a host name only, such as test.example.com");
  if (s.CLOUDFLARE_ZONE && /^[0-9a-f]{32}$/i.test(s.CLOUDFLARE_ZONE)) problems.push("CLOUDFLARE_ZONE is the zone's domain name, such as example.com, not its Zone ID");
  else if (s.CLOUDFLARE_ZONE && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.CLOUDFLARE_ZONE)) problems.push("CLOUDFLARE_ZONE is a domain name only, such as example.com");
  if (s.CLOUDFLARE_ACCOUNT_ID && !/^[0-9a-f]{32}$/i.test(s.CLOUDFLARE_ACCOUNT_ID)) problems.push("CLOUDFLARE_ACCOUNT_ID is the 32-character Account ID from the zone's Overview page");
  if (s.DEPLOYMENT_MODE === "cloud" && !s.POLAR_ORGANIZATION_ID) problems.push("POLAR_ORGANIZATION_ID is empty, and DEPLOYMENT_MODE is cloud");
  if (s.TWILIO_TOLLFREE && s.TWILIO_TOLLFREE !== "buy" && !/^\+\d{8,15}$/.test(s.TWILIO_TOLLFREE)) problems.push("TWILIO_TOLLFREE is buy, a number such as +18445550123, or empty");
  if (s.TWILIO_TOLLFREE && s.DEPLOYMENT_MODE !== "cloud") problems.push("TWILIO_TOLLFREE is only for DEPLOYMENT_MODE=cloud");
  if (problems.length) throw new Error(`${file} needs fixing:\n  ${problems.join("\n  ")}`);
  const stateFile = path.join(path.dirname(file), `${path.basename(file)}.state.json`);
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { done: {}, values: {} };
  logPath = `${file}.log`;
  for (const [key, value] of Object.entries(state.values)) if (SECRET_KEYS.has(key) || SECRETS.includes(key)) hide(value);
  const secretsFile = secretsOption ?? (fs.existsSync(`${file}.secrets`) ? `${file}.secrets` : null);
  config = secretsFile ? loadConfig(secretsFile) : null;
  return { file, settings: s, stateFile, state };
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
    if (key in flat && flat[key] !== value) conflicts.add(key);
    else flat[key] = value;
  });
  if (problems.length) throw new Error(`the secrets file ${file} needs fixing:\n  ${problems.join("\n  ")}`);
  for (const key of conflicts) delete flat[key];
  for (const key of conflicts) console.warn(`Warning: ${file} sets ${key} to different values outside a [service] line, so neither is used.`);
  const ignored = runTool("git", ["check-ignore", "-q", file]);
  if (ignored.status === 1) console.warn(`Warning: Git doesn't ignore ${file}. It holds secrets: never commit it.`);
  return { file, flat, services, used: new Set() };
}

/** Where else a value may be in a variable file: [service, key], service "" for any. */
const CONFIG_ALIASES = {
  TURNSTILE_SITE_KEY: [["", "NEXT_PUBLIC_TURNSTILE_SITE_KEY"]],
  POLAR_ADMIN_TOKEN: [["admin", "POLAR_ACCESS_TOKEN"]],
  POLAR_WORKER_TOKEN: [["worker", "POLAR_ACCESS_TOKEN"]],
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
  fs.writeFileSync(run.stateFile, `${JSON.stringify(run.state, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(run.stateFile, 0o600);
  } catch {
    // Windows has no such modes.
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
  const values = (await work()) ?? {};
  currentStep = null;
  for (const [key, value] of Object.entries(values)) if (SECRET_KEYS.has(key) || SECRETS.includes(key)) hide(value);
  Object.assign(run.state.values, values);
  run.state.done[id] = new Date().toISOString();
  save(run);
  const seconds = Math.round((Date.now() - started) / 1000);
  writeLog(`  done ${id} in ${seconds} s`);
}

let currentStep = null;

const v = (run, key) => run.state.values[key];

// ---------------------------------------------------------------- prompts

function createPrompter() {
  const terminal = process.stdin.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
  const waiting = [];
  let closed = false;
  let current = null;
  let pending = null;
  rl.on("line", (line) => waiting.push(line));
  rl.on("close", () => {
    closed = true;
    // Input ended mid-question (a pipe or Ctrl+D): answer it empty, so the run stops with a reason.
    if (pending) {
      process.stdout.write("\n");
      pending("");
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
      if (waiting.length) {
        process.stdout.write(`${question}\n`);
        return Promise.resolve(waiting.shift().trim());
      }
      if (closed) {
        process.stdout.write(`${question}\n`);
        return Promise.resolve("");
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
  const answer = (await ask(`${question} Type yes to go on: `)).toLowerCase();
  if (answer !== "yes") throw new Stop("you didn't type yes");
  return true;
}

/** A step only a person can do: says what to do, then waits for Enter. */
async function byHand(lines) {
  console.log(`\n  BY HAND:\n${lines.map((line) => `    ${line}`).join("\n")}`);
  if (!assumeYes) await ask("  Press Enter when it's done: ");
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
    const message = json?.error?.message ?? json?.message ?? json?.errors?.[0]?.message ?? `HTTP ${response.status}`;
    const error = new Error(`${service} refused ${method} ${new URL(url).pathname}: ${message}`);
    error.status = response.status;
    error.service = service;
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
  return json.result;
}

// ---------------------------------------------------------------- up

async function up(run) {
  const s = run.settings;
  console.log(`${dryRun ? "Dry run: nothing is called or changed.\n" : ""}${s.NAME}: ${s.ENVIRONMENT}, ${s.DEPLOYMENT_MODE}, brand ${s.BRAND}, from ${s.REPO}@${s.BRANCH}`);
  console.log(`${config ? `Keys from ${config.file}, the environment, or asked for.` : "No secrets file: keys come from the environment or are asked for."}\n`);
  const providers = ["Railway", s.STEP_OPENAI && "OpenAI", s.STEP_TWILIO && "Twilio", s.STEP_RESEND && "Resend", (s.CLOUDFLARE_ZONE || (s.STEP_TURNSTILE && s.CLOUDFLARE_ACCOUNT_ID)) && "Cloudflare"].filter(Boolean);
  if (!dryRun) await confirm(`This sets up ${s.NAME} at ${providers.slice(0, -1).join(", ")}${providers.length > 1 ? " and " : ""}${providers.at(-1)}, which bill your accounts.`);

  console.log("\nGitHub");
  await githubSteps(run);
  console.log("\nOpenAI");
  await openaiSteps(run);
  console.log("\nTwilio");
  await twilioSteps(run);
  console.log("\nEmail");
  await resendSteps(run);
  if (s.DEPLOYMENT_MODE === "cloud") {
    console.log("\nPolar");
    await step(run, "polar.tokens", "Polar's two platform tokens (Polar makes tokens only in its dashboard)", async () => {
      if (!given("POLAR_ADMIN_TOKEN") || !given("POLAR_WORKER_TOKEN")) await byHand([
        `In Polar's ${s.POLAR} organization, Settings > Developers > New Token, make two tokens (guide 5.5):`,
        `"${s.NAME} admin" with customer_sessions:write only, and "${s.NAME} worker" with checkouts:write,`,
        "events:write, organizations:read, meters:read, products:read, discounts:read, subscriptions:write, customers:write.",
      ]);
      return {
        POLAR_ADMIN_TOKEN: await secret("POLAR_ADMIN_TOKEN", "The admin's Polar token"),
        POLAR_WORKER_TOKEN: await secret("POLAR_WORKER_TOKEN", "The worker's Polar token"),
      };
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
  if (!dryRun) {
    console.log(`\nSet up and deploying. Once https://${v(run, "APP_HOST")}/api/health/ready shows "ok":true, run:\n  node devops/bootstrap.mjs connect ${run.file}`);
  }
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
    if (listed.error) return byHand([`GitHub CLI isn't installed. Open https://github.com/${s.REPO}/actions and check that CI is on:`, "if GitHub shows a button to enable the workflows, click it."]);
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
    if (result.error) return byHand([`GitHub CLI isn't installed. Check that https://github.com/${s.REPO}/tree/${s.BRANCH}/brands/${s.BRAND} exists`, "(click Sync fork first if it's missing): BRAND_REQUIRED stops the admin and the worker without it."]);
    if (result.status !== 0) throw new Error(`${s.REPO}@${s.BRANCH} has no brands/${s.BRAND}/brand.json. Click Sync fork on GitHub, or add the brand (guide section 4), then run again`);
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
  await step(run, "openai.project", `OpenAI project "${s.NAME}"`, async () => {
    // A key or project given in the secrets file is used as it is: the key belongs to that project.
    if (fromFile("OPENAI_PROJECT_ID") || fromFile("OPENAI_API_KEY")) {
      return { OPENAI_PROJECT_ID: await value("OPENAI_PROJECT_ID", "The ID of the OpenAI project your OPENAI_API_KEY belongs to (proj_...)", looksLike.project) };
    }
    const list = await openai("/organization/projects?limit=100");
    const found = list?.data?.find((project) => project.name === s.NAME && project.status !== "archived");
    if (found) {
      console.log(`  = ${found.id}`);
      return { OPENAI_PROJECT_ID: found.id };
    }
    const project = await openai("/organization/projects", { method: "POST", body: { name: s.NAME } });
    return { OPENAI_PROJECT_ID: project.id };
  });
  await step(run, "openai.key", "Its API key, owned by a service account", async () => {
    if (fromFile("OPENAI_API_KEY") || fromFile("OPENAI_PROJECT_ID")) return { OPENAI_API_KEY: await secret("OPENAI_API_KEY", "The project's API key (sk-...)", undefined, { envToo: false }) };
    const base = `/organization/projects/${v(run, "OPENAI_PROJECT_ID")}/service_accounts`;
    const name = `${s.NAME} platform`;
    const old = (await openai(`${base}?limit=100`))?.data?.find((account) => account.name === name);
    if (old) {
      // OpenAI shows a key only once. An earlier run made it: take it from Railway if it got there.
      const onRailway = await railwayVariable(run, "admin", "OPENAI_API_KEY");
      if (onRailway) return { OPENAI_API_KEY: onRailway };
      await confirm(`The service account "${name}" exists, but its key isn't saved anywhere this script can read. Replace it with a new one? Its old key stops working.`);
      await openai(`${base}/${old.id}`, { method: "DELETE" });
    }
    const account = await openai(base, { method: "POST", body: { name } });
    if (!account?.api_key?.value) throw new Error("OpenAI made the service account but sent no key");
    return { OPENAI_API_KEY: account.api_key.value };
  });
  await step(run, "openai.limits", "GPT-Live SIP and the spending limit", () => byHand([
    `In the OpenAI project "${s.NAME}" (${v(run, "OPENAI_PROJECT_ID") ?? "its ID"}):`,
    "1. Make sure the project can take GPT-Live SIP calls (guide 3.5, step 7).",
    "2. Limits > Spend: a monthly spend limit, Enforce a hard limit on, and alerts below it (guide 3.5, step 6).",
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
  await step(run, "twilio.subaccount", `Twilio subaccount "${s.NAME}"`, async () => {
    // An account given in the secrets file is used instead of a new subaccount; a trunk given there must be in it.
    if (fromFile("TWILIO_ACCOUNT_SID") || fromFile("TWILIO_AUTH_TOKEN") || fromFile("TWILIO_SIP_TRUNK_SID")) {
      return {
        TWILIO_ACCOUNT_SID: await value("TWILIO_ACCOUNT_SID", "The Twilio account's SID (AC...)", looksLike.account),
        TWILIO_AUTH_TOKEN: await secret("TWILIO_AUTH_TOKEN", "That account's Auth Token", undefined, { envToo: false }),
      };
    }
    const list = await twilioMain(`/Accounts.json?FriendlyName=${encodeURIComponent(s.NAME)}&PageSize=20`);
    const found = list?.accounts?.find((account) => account.friendly_name === s.NAME && account.status !== "closed");
    if (found) console.log(`  = ${found.sid}`);
    const account = found ?? (await twilioMain("/Accounts.json", { method: "POST", form: { FriendlyName: s.NAME } }));
    if (!account?.auth_token) throw new Error(`Twilio didn't send the Auth Token of subaccount ${account?.sid}`);
    return { TWILIO_ACCOUNT_SID: account.sid, TWILIO_AUTH_TOKEN: account.auth_token };
  });
  await step(run, "twilio.trunk", "The SIP trunk to OpenAI: Secure Trunking, transfers, caller ID of the transferee", async () => {
    if (fromFile("TWILIO_SIP_TRUNK_SID")) return { TWILIO_SIP_TRUNK_SID: await value("TWILIO_SIP_TRUNK_SID", "The trunk's SID (TK...)", looksLike.trunk) };
    const list = await twilioSub(run, URLS.trunking, "/Trunks?PageSize=100");
    const name = `${s.NAME} to OpenAI`;
    const found = list?.trunks?.find((trunk) => trunk.friendly_name === name);
    const form = { FriendlyName: name, Secure: "true", TransferMode: "enable-all", TransferCallerId: "from-transferee", CnamLookupEnabled: "false" };
    // Found: its settings are set again, so a trunk changed by hand is put back as the guide wants it.
    if (found) console.log(`  = ${found.sid}, settings checked`);
    const trunk = await twilioSub(run, URLS.trunking, found ? `/Trunks/${found.sid}` : "/Trunks", { method: "POST", form });
    return { TWILIO_SIP_TRUNK_SID: trunk?.sid ?? found.sid };
  });
  await step(run, "twilio.origination", "Its origination URI to the OpenAI project", async () => {
    const trunk = v(run, "TWILIO_SIP_TRUNK_SID");
    const sipUrl = `sip:${v(run, "OPENAI_PROJECT_ID")}@sip.api.openai.com;transport=tls`;
    const list = await twilioSub(run, URLS.trunking, `/Trunks/${trunk}/OriginationUrls`);
    const urls = list?.origination_urls ?? [];
    const form = { FriendlyName: "OpenAI GPT-Live", SipUrl: sipUrl, Priority: "10", Weight: "10", Enabled: "true" };
    if (urls.some((url) => url.sip_url === sipUrl && url.enabled !== false)) return console.log("  = already there");
    if (urls.length > 1) throw new Error(`trunk ${trunk} has ${urls.length} origination URIs. Keep exactly one, to ${sipUrl}, in Twilio's console (guide 3.6, step 9), then run again`);
    if (urls.length === 1) console.log(`  ~ the trunk's origination URI pointed to ${urls[0].sip_url}; now to the OpenAI project`);
    await twilioSub(run, URLS.trunking, urls.length === 1 ? `/Trunks/${trunk}/OriginationUrls/${urls[0].sid}` : `/Trunks/${trunk}/OriginationUrls`, { method: "POST", form });
  });
  await step(run, "twilio.console", "Twilio's console-only steps", () => byHand([
    "1. Voice > Settings > Geo permissions: allow each country whose phones take transfers (guide 3.6, step 12).",
    "2. The business profile and US texting registration, if not done yet: Twilio reviews them for days (guide 3.6, steps 3 and 13).",
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
    if (fromFile("SMTP_PASSWORD")) return { SMTP_PASSWORD: await secret("SMTP_PASSWORD", "The Resend API key (re_...)", undefined, { envToo: false }) };
    const old = (await resend("/api-keys"))?.data?.find((key) => key.name === s.NAME);
    if (old) {
      // Resend shows a key only once. An earlier run made it: take it from Railway if it got there.
      const onRailway = await railwayVariable(run, "worker", "SMTP_PASSWORD");
      if (onRailway) return { SMTP_PASSWORD: onRailway };
      await confirm(`Resend has a key named "${s.NAME}", but it isn't saved anywhere this script can read. Replace it with a new one? The old key stops working.`);
      await resend(`/api-keys/${old.id}`, { method: "DELETE" });
    }
    const key = await resend("/api-keys", { method: "POST", body: { name: s.NAME, permission: "sending_access", domain_id: v(run, "RESEND_DOMAIN_ID") } });
    return { SMTP_PASSWORD: key.token };
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
  if (v(run, "CLOUDFLARE_ZONE_ID")) return v(run, "CLOUDFLARE_ZONE_ID");
  const zones = await cloudflare(`/zones?name=${encodeURIComponent(run.settings.CLOUDFLARE_ZONE)}`);
  if (!zones?.length) throw new Error(`the Cloudflare token can't see a zone named ${run.settings.CLOUDFLARE_ZONE}: check the name, and that the token's Zone Resources include it`);
  run.state.values.CLOUDFLARE_ZONE_ID = zones[0].id;
  save(run);
  return zones[0].id;
}

/** Creates each record in Cloudflare, DNS only, or prints them all when no zone is set. */
async function dnsRecords(run, records) {
  if (!run.settings.CLOUDFLARE_ZONE) {
    return byHand(["Create these records at the DNS provider, DNS only (not proxied), with the names as Resend's domain page shows them:", ...records.map((record) => `${record.type.padEnd(5)} ${record.name}  ${record.priority !== undefined ? `${record.priority} ` : ""}${record.content}`)]);
  }
  const zone = await zoneId(run);
  for (const record of records) {
    const existing = (await cloudflare(`/zones/${zone}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`)) ?? [];
    const same = (item) => item.content.replace(/^"|"$/g, "") === record.content && (record.priority === undefined || item.priority === record.priority);
    if (existing.some((item) => same(item) || (record.onlyIfNone && item.content.includes("v=DMARC1")))) {
      console.log(`  = ${record.type} ${record.name}`);
      continue;
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
  project: "query project($id: String!) { project(id: $id) { id name services { edges { node { id name } } } environments { edges { node { id name } } } volumes { edges { node { id name volumeInstances { edges { node { mountPath serviceId environmentId } } } } } } buckets { edges { node { id name } } } } }",
  workspaces: "query workspaces { me { workspaces { id name } } }",
  projects: "query projects($workspaceId: String) { projects(workspaceId: $workspaceId) { edges { node { id name } } } }",
  domains: "query domains($projectId: String!, $environmentId: String!, $serviceId: String!) { domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { id domain targetPort } customDomains { id domain status { verified verificationDnsHost verificationToken dnsRecords { recordType fqdn requiredValue } } } } }",
  readVariables: "query variables($projectId: String!, $environmentId: String!, $serviceId: String!) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true) }",
  serviceCreate: "mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }",
  volumeCreate: "mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }",
  instanceUpdate: "mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }",
  domainCreate: "mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain } }",
  customDomainCreate: "mutation customDomainCreate($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id domain status { verified verificationDnsHost verificationToken dnsRecords { recordType fqdn requiredValue } } } }",
  variables: "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }",
  connect: "mutation serviceConnect($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }",
  templateGenerate: "mutation templateGenerate($input: TemplateGenerateInput!) { templateGenerate(input: $input) { id code name status } }",
  template: "query template($code: String!) { template(code: $code) { id code name serializedConfig } }",
  templateDeploy: "mutation templateDeployV2($input: TemplateDeployV2Input!) { templateDeployV2(input: $input) { projectId workflowId } }",
  workflowStatus: "query workflowStatus($workflowId: String!) { workflowStatus(workflowId: $workflowId) { status error } }",
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

const SERVICES = [
  { name: "Postgres", image: "pgvector/pgvector:pg16" },
  { name: "Redis", image: "redis:7-alpine" },
  { name: "migrate" },
  { name: "admin" },
  { name: "worker" },
];

async function projectView(run, id = v(run, "RAILWAY_PROJECT_ID")) {
  const { project } = await railway(Q.project, { id });
  return {
    id,
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
  const { projects } = await railway(Q.projects, s.RAILWAY_WORKSPACE_ID ? { workspaceId: s.RAILWAY_WORKSPACE_ID } : {});
  const matches = projects.edges.map(({ node }) => node).filter((project) => project.name === s.NAME);
  if (matches.length > 1) throw new Error(`Railway has ${matches.length} projects named ${s.NAME}. Delete or rename the extra ones, then run again`);
  return matches[0]?.id ?? null;
}

const variableCache = {};
/**
 * A variable's current value on one of this run's Railway services, or undefined. Used to pick
 * up a value made in an earlier run whose state file was lost, so it isn't made again.
 */
async function railwayVariable(run, service, key) {
  try {
    if (!(service in variableCache)) {
      variableCache[service] = {};
      const projectId = await findProject(run);
      if (projectId) {
        const view = await projectView(run, projectId);
        const environmentId = v(run, "RAILWAY_ENVIRONMENT_ID") ?? view.environments[run.settings.ENVIRONMENT];
        const serviceId = view.services[service];
        if (environmentId && serviceId) variableCache[service] = (await railway(Q.readVariables, { projectId, environmentId, serviceId })).variables ?? {};
      }
    }
  } catch (error) {
    trace(`couldn't read ${service}'s variables on Railway: ${error.message}`);
    return undefined;
  }
  const value = variableCache[service][key];
  if (typeof value !== "string" || !value || value.includes("${{")) return undefined;
  console.log(`  ${key}: found on Railway's ${service} service`);
  return hide(value);
}

async function railwaySteps(run) {
  const s = run.settings;
  await step(run, "railway.project", `Railway project "${s.NAME}" with the environment ${s.ENVIRONMENT}`, async () => {
    // Kept at once, so a run that stops after this call never makes a second project.
    if (!v(run, "RAILWAY_PROJECT_ID")) {
      const existing = await findProject(run);
      if (existing) console.log(`  found the project ${s.NAME}; using it`);
      if (!existing && !s.RAILWAY_WORKSPACE_ID) throw new Error(`RAILWAY_WORKSPACE_ID is empty, and Railway needs it to make a project. ${await workspaceList()}`);
      const id = existing ?? (await railway(Q.projectCreate, { input: { name: s.NAME, defaultEnvironmentName: s.ENVIRONMENT, ...(s.RAILWAY_WORKSPACE_ID ? { workspaceId: s.RAILWAY_WORKSPACE_ID } : {}) } })).projectCreate.id;
      run.state.values.RAILWAY_PROJECT_ID = id;
      save(run);
    }
    const view = await projectView(run);
    const environmentId = view.environments[s.ENVIRONMENT] ?? Object.values(view.environments)[0];
    if (!environmentId) throw new Error("Railway made the project without an environment");
    return { RAILWAY_ENVIRONMENT_ID: environmentId };
  });
  if (s.RAILWAY_TEMPLATE && !run.template) {
    await step(run, "railway.template", `The services, volumes and settings from the template ${s.RAILWAY_TEMPLATE}`, async () => {
      const view = await projectView(run);
      if (SERVICES.some((service) => view.services[service.name])) return console.log("  = the project has its services already, so the template isn't deployed again");
      const { template } = await railway(Q.template, { code: s.RAILWAY_TEMPLATE });
      if (!template) throw new Error(`Railway has no template with the code ${s.RAILWAY_TEMPLATE}. Run template again, or empty RAILWAY_TEMPLATE`);
      // Passed through whole, as the Railway CLI does: only the values are filled in, from the template's defaults.
      const config = template.serializedConfig ?? {};
      for (const service of Object.values(config.services ?? {})) {
        for (const variable of Object.values(service?.variables ?? {})) {
          if (variable && variable.value === undefined && variable.defaultValue) variable.value = variable.defaultValue;
        }
      }
      const { templateDeployV2 } = await railway(Q.templateDeploy, { input: {
        templateId: template.id, serializedConfig: config, projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"),
      } });
      await waitForWorkflow(templateDeployV2?.workflowId, `the template ${s.RAILWAY_TEMPLATE}`);
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
    const link = runTool(RAILWAY_CLI, ["link", "--project", v(run, "RAILWAY_PROJECT_ID"), "--environment", s.ENVIRONMENT], { env: cliEnv() });
    const made = !link.error && link.status === 0 && runTool(RAILWAY_CLI, ["bucket", "create", "Bucket", "--region", s.BUCKET_REGION, "--json"], { env: cliEnv() });
    if (!made || made.status !== 0) {
      const reason = (link.error?.message ?? (made && made.stderr) ?? link.stderr ?? "").trim().split("\n")[0];
      await byHand([`The Railway CLI couldn't make the bucket${reason ? ` (${reason})` : ""}.`, `In the project's canvas: create a Bucket in region ${s.BUCKET_REGION}, named exactly Bucket (guide section 7, step 3).`]);
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
const NOT_IN_TEMPLATE = new Set(["DEPLOYMENT_MODE", "BRAND_PRESET", "EMAIL_FROM", "POLAR_ORGANIZATION_ID", "POLAR_API_BASE_URL", "TWILIO_ALERT_SMS_FROM", "REQUIRE_EMAIL_VERIFICATION"]);

/**
 * Builds a Railway project that holds only the layout (services, volumes, bucket, settings,
 * pre-deploy command and the variables that are the same everywhere, such as references), then
 * makes a private template of it. No secret, key or per-deployment value goes in: up sets those.
 */
async function makeTemplate(run) {
  const s = run.settings;
  const name = s.TEMPLATE_PROJECT || "lobbystack-template";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("TEMPLATE_PROJECT is a short name in lower case, such as lobbystack-template");
  if (name === s.NAME) throw new Error("TEMPLATE_PROJECT must differ from NAME: the template is made from a project of its own");
  const stateFile = run.stateFile.replace(/\.state\.json$/, ".template.state.json");
  const trun = {
    file: run.file, stateFile, template: true,
    settings: { ...s, NAME: name, CUSTOM_HOST: "", ENVIRONMENT: "test" },
    state: fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { done: {}, values: {} },
  };
  console.log(`${dryRun ? "Dry run: nothing is called or changed.\n" : ""}Template: a Railway project "${name}" with the layout only, then a private template of it.`);
  console.log(`Progress: ${stateFile}\n`);
  if (!dryRun) await confirm(`This makes the Railway project ${name} in your workspace. Postgres and Redis there start without passwords and stop after a few retries; nothing else deploys.`);
  console.log("\nRailway");
  await railwaySteps(trun);
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
    const { templateGenerate } = await railway(Q.templateGenerate, { input: { projectId: v(trun, "RAILWAY_PROJECT_ID"), environmentId: v(trun, "RAILWAY_ENVIRONMENT_ID") } });
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
  console.log("Anything the template left out, up still makes step by step. Only your workspace lists the template, but anyone with its code can read it: that's why it holds no keys or passwords.");
}

function cliEnv() {
  return { ...process.env, ...(tokens.RAILWAY_API_TOKEN ? { RAILWAY_API_TOKEN: tokens.RAILWAY_API_TOKEN } : {}) };
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
    await step(run, "railway.custom", `The custom domain ${s.CUSTOM_HOST}`, async () => {
      const existing = (await domains()).customDomains.find((domain) => domain.domain === s.CUSTOM_HOST);
      if (existing) console.log(`  = ${s.CUSTOM_HOST} is on the admin already`);
      const domain = existing ?? (await railway(Q.customDomainCreate, { input: { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: admin(), domain: s.CUSTOM_HOST, targetPort: 3000 } })).customDomainCreate;
      const records = (domain.status?.dnsRecords ?? []).filter((record) => record.fqdn && record.requiredValue).map((record) => ({ type: record.recordType.replace("DNS_RECORD_TYPE_", ""), name: record.fqdn, content: record.requiredValue }));
      const { verified, verificationDnsHost, verificationToken } = domain.status ?? {};
      if (!verified && verificationDnsHost && verificationToken) records.push({ type: "TXT", name: verificationDnsHost, content: `railway-verify=${verificationToken.replace(/^(railway-verify=)+/, "")}` });
      if (!records.length) {
        await byHand([`Railway sent no DNS records for ${s.CUSTOM_HOST}. Add the ones shown under admin > Settings > Networking, DNS only (guide section 11).`]);
      } else {
        await dnsRecords(run, records);
        if (s.CLOUDFLARE_ZONE) console.log("  Railway checks the records and issues the certificate; the domain shows a green check mark once DNS has spread (guide section 11).");
      }
    });
  }
  await step(run, "turnstile", "The Turnstile widget for the address", async () => {
    const both = fromFile("TURNSTILE_SITE_KEY") && fromFile("TURNSTILE_SECRET_KEY");
    if (both || !s.STEP_TURNSTILE || !s.CLOUDFLARE_ACCOUNT_ID) {
      if (!both) await byHand([`In Cloudflare, Turnstile > Add widget for ${v(run, "APP_HOST")}, Managed, Pre-clearance No (guide 5.3).`]);
      return {
        TURNSTILE_SITE_KEY: await value("TURNSTILE_SITE_KEY", "The widget's Site Key"),
        TURNSTILE_SECRET_KEY: await secret("TURNSTILE_SECRET_KEY", "The widget's Secret Key", undefined, { envToo: false }),
      };
    }
    const hosts = [...new Set([v(run, "APP_HOST"), v(run, "RAILWAY_HOST")])];
    const base = `/accounts/${s.CLOUDFLARE_ACCOUNT_ID}/challenges/widgets`;
    const found = (await cloudflare(`${base}?per_page=100`))?.find((widget) => widget.name === s.NAME);
    if (found) {
      const widget = await cloudflare(`${base}/${found.sitekey}`);
      const missing = hosts.filter((host) => !widget.domains?.includes(host));
      if (missing.length) await cloudflare(`${base}/${found.sitekey}`, { method: "PUT", body: { name: s.NAME, domains: [...new Set([...(widget.domains ?? []), ...hosts])], mode: widget.mode ?? "managed" } });
      console.log(`  = the widget ${s.NAME}${missing.length ? `, now also for ${missing.join(", ")}` : ""}`);
      return { TURNSTILE_SITE_KEY: widget.sitekey, TURNSTILE_SECRET_KEY: widget.secret };
    }
    const widget = await cloudflare(base, { method: "POST", body: { name: s.NAME, domains: hosts, mode: "managed" } });
    return { TURNSTILE_SITE_KEY: widget.sitekey, TURNSTILE_SECRET_KEY: widget.secret };
  });
}

async function tollfreeSteps(run) {
  const s = run.settings;
  await step(run, "twilio.tollfree", s.TWILIO_TOLLFREE === "buy" ? "Buy a toll-free number in the subaccount" : `Use ${s.TWILIO_TOLLFREE}`, async () => {
    const smsUrl = `https://${v(run, "APP_HOST")}/api/webhooks/twilio/sms`;
    const base = `${URLS.twilio}/Accounts/${v(run, "TWILIO_ACCOUNT_SID")}`;
    let number = s.TWILIO_TOLLFREE;
    const friendly = `${s.NAME} shared texts`;
    if (number === "buy") {
      // A number an earlier run bought is found by its name, so a rerun never buys a second one.
      const owned = await twilioSub(run, base, `/IncomingPhoneNumbers.json?FriendlyName=${encodeURIComponent(friendly)}&PageSize=20`);
      const mine = owned?.incoming_phone_numbers?.find((item) => item.friendly_name === friendly);
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
      await confirm(`Buy ${number} in subaccount ${s.NAME}? Twilio bills it every month.`);
      await twilioSub(run, base, "/IncomingPhoneNumbers.json", { method: "POST", form: { PhoneNumber: number, SmsUrl: smsUrl, SmsMethod: "POST", FriendlyName: friendly } });
    } else if (s.TWILIO_TOLLFREE !== "buy") {
      const owned = await twilioSub(run, base, `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
      const sid = owned?.incoming_phone_numbers?.[0]?.sid;
      if (!sid) throw new Error(`${number} isn't in subaccount ${s.NAME}`);
      await twilioSub(run, base, `/IncomingPhoneNumbers/${sid}.json`, { method: "POST", form: { SmsUrl: smsUrl, SmsMethod: "POST" } });
    }
    await byHand([`Send ${number} for toll-free verification in Twilio's console (guide 3.6, step 14). Texts to US and Canadian phones wait for it.`]);
    return { TWILIO_ALERT_SMS_FROM: number };
  });
}

// ---------------------------------------------------------------- variables

/** The variables of guide Appendix A.1 (test) or A.3 (production), with this run's values. */
function variableSections(run) {
  const s = run.settings;
  const x = (key) => v(run, key);
  const cloud = s.DEPLOYMENT_MODE === "cloud";
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
      ...(production || s.CUSTOM_HOST ? {} : { BRAND_PRESET: s.BRAND }), BRAND_REQUIRED: "true",
      REDIS_URL: "redis://default:${{Redis.REDIS_PASSWORD}}@${{Redis.RAILWAY_PRIVATE_DOMAIN}}:6379",
      STORAGE_PROVIDER: "s3", S3_BUCKET: "${{Bucket.BUCKET}}", S3_ENDPOINT: "${{Bucket.ENDPOINT}}", S3_REGION: "${{Bucket.REGION}}",
      S3_ACCESS_KEY_ID: "${{Bucket.ACCESS_KEY_ID}}", S3_SECRET_ACCESS_KEY: "${{Bucket.SECRET_ACCESS_KEY}}", S3_FORCE_PATH_STYLE: "false",
      ...(cloud && x("TWILIO_ALERT_SMS_FROM") ? { TWILIO_ALERT_SMS_FROM: x("TWILIO_ALERT_SMS_FROM") } : {}),
      ...(cloud ? { POLAR_ORGANIZATION_ID: s.POLAR_ORGANIZATION_ID, ...(s.POLAR === "sandbox" ? { POLAR_API_BASE_URL: "https://sandbox-api.polar.sh" } : {}) } : {}),
    }],
    ["admin", {
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.admin", PORT: "3000", HOSTNAME: "::",
      APP_BASE_URL: s.CUSTOM_HOST ? `https://${s.CUSTOM_HOST}` : "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      SITE_URL: "${{APP_BASE_URL}}", AUTH_TRUSTED_ORIGINS: "${{APP_BASE_URL}}", TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
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
      ...(cloud ? { POLAR_ACCESS_TOKEN: x("POLAR_ADMIN_TOKEN") } : {}),
    }],
    ["worker", {
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.worker", PORT: "3002", RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "1860",
      APP_BASE_URL: "${{admin.APP_BASE_URL}}", DATABASE_URL: role("lobbystack_worker", "LOBBYSTACK_WORKER_PASSWORD"),
      LOBBYSTACK_DISPATCHER_PASSWORD: "${{Postgres.LOBBYSTACK_DISPATCHER_PASSWORD}}", ENCRYPTION_KEY: "${{admin.ENCRYPTION_KEY}}",
      OTP_HASH_SECRET: "${{admin.OTP_HASH_SECRET}}", INTERNAL_SERVICE_TOKEN: "${{admin.INTERNAL_SERVICE_TOKEN}}",
      OPENAI_API_KEY: "${{admin.OPENAI_API_KEY}}", TWILIO_ACCOUNT_SID: "${{admin.TWILIO_ACCOUNT_SID}}", TWILIO_AUTH_TOKEN: "${{admin.TWILIO_AUTH_TOKEN}}",
      TWILIO_STATUS_CALLBACK_URL: "${{admin.TWILIO_STATUS_CALLBACK_URL}}", TWILIO_SIP_TRUNK_SID: x("TWILIO_SIP_TRUNK_SID"),
      SMTP_HOST: "smtp.resend.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USERNAME: "resend", SMTP_PASSWORD: x("SMTP_PASSWORD"),
      EMAIL_FROM: s.EMAIL_FROM, ...(cloud ? { POLAR_ACCESS_TOKEN: x("POLAR_WORKER_TOKEN") } : {}),
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

async function variableSteps(run) {
  // Kept, given, or already on Railway (a lost state file must never change the database's passwords), else new.
  const holder = (key) => (key.startsWith("POSTGRES_") || key.startsWith("LOBBYSTACK_") ? "Postgres" : key === "REDIS_PASSWORD" ? "Redis" : "admin");
  await step(run, "secrets", "The 13 passwords and secrets (64 hex characters each)", async () => {
    const values = {};
    for (const key of SECRETS) values[key] = run.state.values[key] ?? fromFile(key) ?? (await railwayVariable(run, holder(key), key)) ?? randomBytes(32).toString("hex");
    return values;
  });
  await step(run, "variables", "Every service's variables (guide Appendix A), without deploying yet", async () => {
    const sections = variableSections(run);
    const missing = sections.flatMap(([section, variables]) => Object.entries(variables).filter(([, value]) => !value).map(([key]) => `${key} (${section})`));
    if (missing.length) throw new Error(`these have no value yet: ${missing.join(", ")}`);
    writeVariableFile(run, sections);
    const ids = v(run, "RAILWAY_SERVICE_IDS");
    for (const [service, variables] of Object.entries(perService(sections))) {
      await railway(Q.variables, { input: { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: ids[service], variables, skipDeploys: true } });
      console.log(`  ${service}: ${Object.keys(variables).length} variable${Object.keys(variables).length === 1 ? "" : "s"}`);
    }
  });
}

/** The same variables as a file for devops/railway-vars.mjs, kept beside the settings. */
function writeVariableFile(run, sections) {
  const file = path.join(path.dirname(run.file), `${path.basename(run.file)}.vars`);
  const lines = [
    `# Railway variables of ${run.settings.NAME}, written by devops/bootstrap.mjs on ${new Date().toISOString().slice(0, 10)}.`,
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
  await step(run, "deploy.databases", "Deploy Postgres and Redis with their passwords", async () => {
    await byHand(["Railway stages the changes: open the project's canvas and click Deploy on the banner.", "Then check that Postgres's and Redis's logs say they're ready to accept connections (guide 8.3, step 5)."]);
  });
  await step(run, "deploy.migrate", `Connect migrate to ${s.REPO}@${s.BRANCH}, which deploys it`, async () => {
    await railway(Q.connect, { id: ids().migrate, input: source });
    await byHand(["Wait for migrate's deployment to succeed: its log ends with RLS enabled and forced on <n> tables (guide 10.1).", "If it fails, guide 10.3 lists the usual causes; run this command again once it passes."]);
  });
  for (const service of ["admin", "worker"]) {
    await step(run, `deploy.${service}`, `Connect the ${service} to ${s.REPO}@${s.BRANCH}, which builds it`, async () => {
      await railway(Q.connect, { id: ids()[service], input: source });
    });
  }
}

// ---------------------------------------------------------------- connect

async function connect(run) {
  const s = run.settings;
  if (!run.state.done["deploy.admin"]) throw new Error("run up first, and finish it");
  const host = v(run, "APP_HOST");
  console.log(`${dryRun ? "Dry run: nothing is called or changed.\n" : ""}${s.NAME} at https://${host}${config ? `, keys from ${config.file}` : ""}\n`);
  await step(run, "connect.health", `https://${host}/api/health/ready answers "ok":true with the ${s.BRAND} brand`, async () => {
    const health = await http("The admin", `${process.env.BOOTSTRAP_APP_URL ?? `https://${host}`}/api/health/ready`).catch((error) => ({ failed: error.message }));
    if (health?.failed || health?.ok !== true) throw new Error(`the admin isn't ready yet (${health?.failed ?? JSON.stringify(health)}). Check its deployment, then run again`);
    const brand = typeof health.brand === "string" ? health.brand : health.brand?.id;
    if (brand && brand !== s.BRAND) throw new Error(`the admin shows the ${brand} brand, not ${s.BRAND}`);
  });
  await step(run, "connect.webhook", "OpenAI's incoming-call webhook (OpenAI's API can't make this one yet)", async () => {
    if (!given("OPENAI_WEBHOOK_SECRET")) {
      const onRailway = await railwayVariable(run, "admin", "OPENAI_WEBHOOK_SECRET");
      if (onRailway) {
        console.log("  To use a new webhook's secret instead, put it as OPENAI_WEBHOOK_SECRET in the secrets file and redo connect.webhook.");
        return { OPENAI_WEBHOOK_SECRET: onRailway };
      }
    }
    if (!given("OPENAI_WEBHOOK_SECRET")) await byHand([
      `In the OpenAI project "${s.NAME}": Settings > Webhooks > Create (guide 3.5, steps 8 to 10).`,
      `URL: https://${host}/api/webhooks/openai/live   (no slash at the end)`,
      "Event types: only live.transport.incoming. Copy the whsec_ signing secret it shows once.",
    ]);
    return { OPENAI_WEBHOOK_SECRET: await secret("OPENAI_WEBHOOK_SECRET", "The webhook's signing secret (whsec_...)", (answer) => answer.startsWith("whsec_")) };
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
    if (result.error || result.status !== 0) throw new Error(`pnpm platform-key:create failed: ${(result.stderr || result.error?.message || "").trim().split("\n").at(-1)}`);
    const last = result.stdout.trim().split(/\r?\n/).at(-1);
    if (!last?.startsWith("[")) throw new Error("pnpm platform-key:create didn't print the PLATFORM_API_KEYS value");
    const file = result.stdout.match(/Key written to (.+?\.json)/)?.[1];
    console.log(`  The key itself is in ${file ?? ".platform-keys/"}: move it to the password manager, then delete the file.`);
    return { PLATFORM_API_KEYS: last };
  });
  await step(run, "connect.variables", "OPENAI_WEBHOOK_SECRET and PLATFORM_API_KEYS on the admin, which redeploys it", async () => {
    await railway(Q.variables, {
      input: {
        projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: v(run, "RAILWAY_SERVICE_IDS").admin,
        variables: { OPENAI_WEBHOOK_SECRET: v(run, "OPENAI_WEBHOOK_SECRET"), PLATFORM_API_KEYS: v(run, "PLATFORM_API_KEYS") }, skipDeploys: false,
      },
    });
  });
  if (dryRun) return;
  const profile = s.NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  console.log(`
Done by the script. What's left needs you (guide 12.3 to 14):
  1. Once the admin's new deployment is Active, sign up at https://${host}/en/signup as ${s.OPERATOR_EMAIL},
     with the 6-digit code from the email.
  2. pnpm lobbystack login --url https://${host} --key-stdin --profile ${profile}
     (paste the platform key from the file above, Enter, then Ctrl+D; on Windows Ctrl+Z, Enter)${s.DEPLOYMENT_MODE === "cloud" ? `
  3. Polar (guide 12.4), with a setup token made in Polar's ${s.POLAR} organization:
     pnpm billing plan  --brand ${s.BRAND} --polar ${s.POLAR} --profile ${profile}
     pnpm billing apply --brand ${s.BRAND} --polar ${s.POLAR} --profile ${profile} --railway-file .env.polar-${profile}
     then change lobbystack-admin to admin in that file, node devops/railway-vars.mjs .env.polar-${profile}, and delete it.` : ""}
  ${s.DEPLOYMENT_MODE === "cloud" ? 4 : 3}. pnpm smoke:production (guide section 13), then a test call.`);
}

// ---------------------------------------------------------------- status

function status(run) {
  const s = run.settings;
  console.log(`${s.NAME}: ${run.stateFile}`);
  console.log(`  secrets file: ${config ? config.file : "none (keys come from the environment or are asked for)"}`);
  const log = `${run.file}.log`;
  console.log(`  log: ${fs.existsSync(log) ? log : `${log} (not written yet)`}`);
  const done = Object.entries(run.state.done);
  if (!done.length) console.log("  nothing done yet: run up");
  for (const [id, at] of done) console.log(`  done  ${at}  ${id}`);
  const host = run.state.values.APP_HOST;
  if (host) console.log(`  address: https://${host}`);
  console.log(`  values kept (never printed): ${Object.keys(run.state.values).length}`);
  if (done.length) console.log(`\nTo run a step again: node devops/bootstrap.mjs redo ${run.file} <step>, then the same command as before.`);
}

// ---------------------------------------------------------------- redo

/** Takes the done mark off steps, so the next up or connect runs them again. Their values stay, and each step finds what it made before. */
function redo(run, wanted) {
  const done = Object.keys(run.state.done);
  if (!wanted.length) throw new Stop(`name the step to run again, such as twilio.trunk, or a group such as twilio.* Finished steps:\n  ${done.join("\n  ") || "(none)"}`);
  const matches = done.filter((id) => wanted.some((want) => id === want || (want.endsWith("*") && id.startsWith(want.slice(0, -1)))));
  if (!matches.length) throw new Stop(`no finished step matches ${wanted.join(" ")}. Finished steps:\n  ${done.join("\n  ") || "(none)"}`);
  for (const id of matches) {
    delete run.state.done[id];
    console.log(`  ${id}: runs again next time`);
  }
  save(run);
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
    if (error.service === "Twilio" && /trial/i.test(message)) tips.push("Upgrade the Twilio account from trial (guide 3.1): trial accounts can't make subaccounts or buy numbers.");
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
  if (currentStep === "railway.domain") tips.push("Railway may not give an address before the service's first deploy. Run up again once the admin has deployed once (guide Appendix D).");
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
  for (const file of [run.file, run.stateFile, config?.file, logPath].filter(Boolean)) {
    const ignored = tool("git", ["check-ignore", "-q", file]);
    if (ignored.status === 1) fix(`Git doesn't ignore ${file}: name it .env.<something>, or add it to .gitignore, so it's never committed`);
  }
  const pnpm = tool("pnpm", ["--version"]);
  (pnpm.status === 0 ? ok : fix)(pnpm.status === 0 ? `pnpm ${pnpm.stdout.trim()} (connect uses it for the platform key)` : "pnpm isn't installed: connect needs it (npm install --global pnpm, then pnpm install here)");
  const cli = tool(RAILWAY_CLI, ["--version"]);
  (cli.status === 0 ? ok : note)(cli.status === 0 ? `Railway CLI ${cli.stdout.trim()} (makes the bucket)` : "no Railway CLI: you'll make the bucket by hand (npm install --global @railway/cli to avoid that)");
  if (s.STEP_GITHUB) {
    const gh = tool("gh", ["api", `repos/${s.REPO}/contents/brands/${s.BRAND}/brand.json?ref=${s.BRANCH}`, "--jq", ".name"]);
    if (gh.error) note(`no GitHub CLI: you'll check ${s.REPO} by hand`);
    else if (gh.status === 0) ok(`${s.REPO}@${s.BRANCH} has brands/${s.BRAND}`);
    else fix(`${s.REPO}@${s.BRANCH} has no brands/${s.BRAND}/brand.json, or gh isn't signed in (gh auth login). Click Sync fork if the brand is missing`);
  }

  console.log("\nSettings and keys");
  ok(`${s.NAME}: ${s.ENVIRONMENT}, ${s.DEPLOYMENT_MODE}, brand ${s.BRAND}, from ${s.REPO}@${s.BRANCH}`);
  const off = ["GITHUB", "OPENAI", "TWILIO", "RESEND", "TURNSTILE"].filter((name) => !s[`STEP_${name}`]);
  if (off.length) note(`turned off: ${off.map((name) => `STEP_${name}`).join(", ")} (their values come from the secrets file, or are asked for)`);
  if (config) ok(`secrets file ${config.file}: ${Object.keys(config.flat).length} values (names only: ${Object.keys(config.flat).sort().join(", ") || "none"})`);
  else note("no secrets file: up will ask for each key (init writes one)");
  const done = Object.keys(run.state.done).length;
  note(done ? `${done} steps already done (status lists them)` : "nothing done yet");

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
      return list?.data?.some((project) => project.name === s.NAME && project.status !== "archived") ? `project ${s.NAME} exists and will be reused` : `project ${s.NAME} will be made`;
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
  if (s.DEPLOYMENT_MODE === "cloud") {
    for (const name of ["POLAR_ADMIN_TOKEN", "POLAR_WORKER_TOKEN"]) {
      const set = process.env[name]?.trim() || fromFile(name, { quiet: true });
      (set ? ok : note)(`Polar: ${name} ${set ? "is set" : "isn't set, so up will ask for it"}`);
    }
  }
  const host = v(run, "APP_HOST");
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
