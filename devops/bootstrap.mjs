#!/usr/bin/env node
// bootstrap.mjs: sets up one LobbyStack environment on Railway, with its outside services,
// from one small settings file. It does in one run what the Railway deployment guide does by
// hand in sections 3 to 12, except the few steps that only a person can do, for which it stops
// and says what to do.
//
//   node devops/bootstrap.mjs init <name>              writes .env.bootstrap-<name> to fill in
//   node devops/bootstrap.mjs up <settings file>       sets everything up, then deploys
//   node devops/bootstrap.mjs connect <settings file>  the steps once the address works
//   node devops/bootstrap.mjs status <settings file>   what's done and what's left
// Options: --dry-run (show the steps, call nothing), --yes (don't stop at questions or pauses)
//
// Each step is recorded in .env.bootstrap-<name>.state.json, beside the settings file, as
// soon as it succeeds, so a run that stops is finished by running the same command again.
// That file holds every secret the run made or was given: Git ignores it (.env.*), never
// commit or share it, and copy its secrets to the password manager. The script never prints
// a secret.
//
// It needs Node.js 18 or later and nothing installed. The Railway CLI is used for one step
// only, the bucket; without it, the script asks you to make the bucket in the dashboard.
// Tokens come from the environment or a hidden prompt, and are never saved:
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
# Optional: a Railway workspace ID. Empty: your personal workspace.
RAILWAY_WORKSPACE_ID=
# The bucket's region, which never changes: sjc, iad, ams or sin.
BUCKET_REGION=iad
# Optional: the dashboard's own address, such as test.example.com. Empty: Railway's free address.
CUSTOM_HOST=

# Email through Resend. EMAIL_DOMAIN is the subdomain kept for email; EMAIL_FROM is on it.
EMAIL_DOMAIN=
EMAIL_FROM=
# us-east-1, eu-west-1, sa-east-1 or ap-northeast-1. It can't change later.
RESEND_REGION=us-east-1

# Cloudflare: the zone that holds EMAIL_DOMAIN and CUSTOM_HOST (such as example.com), and the
# account ID from the zone's Overview page. Empty zone: the script prints the DNS records instead.
CLOUDFLARE_ZONE=
CLOUDFLARE_ACCOUNT_ID=

# Twilio's shared toll-free number, only with DEPLOYMENT_MODE=cloud: buy (the script buys one),
# a number you already have in the subaccount (+18445550123), or empty for none.
TWILIO_TOLLFREE=

# Polar, only with DEPLOYMENT_MODE=cloud: the organization's ID, and sandbox or live.
POLAR_ORGANIZATION_ID=
POLAR=sandbox

# Turn steps off with no (each then asks you for its values instead).
STEP_GITHUB=yes
STEP_OPENAI=yes
STEP_TWILIO=yes
STEP_RESEND=yes
STEP_TURNSTILE=yes
`;

const SECRETS = ["POSTGRES_PASSWORD", "LOBBYSTACK_AUTH_PASSWORD", "LOBBYSTACK_APP_PASSWORD", "LOBBYSTACK_WORKER_PASSWORD",
  "LOBBYSTACK_DISPATCHER_PASSWORD", "REDIS_PASSWORD", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "INTERNAL_SERVICE_SECRET",
  "INTERNAL_SERVICE_TOKEN", "NUMBER_CLAIM_TOKEN_SECRET", "OTP_HASH_SECRET", "WIDGET_SESSION_SECRET"];

const MIGRATE_PRE_DEPLOY = "sh -c 'node_modules/.bin/tsx dist/cli.js migrate && node_modules/.bin/tsx dist/cli.js bootstrap && node_modules/.bin/tsx dist/cli.js check && VERIFY_RLS_BEHAVIOR=true node_modules/.bin/tsx dist/cli.js verify-rls'";
const REDIS_START = "sh -c 'exec redis-server --bind :: 0.0.0.0 --appendonly yes --maxmemory-policy noeviction --requirepass \"$REDIS_PASSWORD\"'";

// ---------------------------------------------------------------- command line

class Stop extends Error {}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
const [command, target] = argv.filter((arg) => !arg.startsWith("--"));
for (const flag of flags) if (!["--dry-run", "--yes"].includes(flag)) usage(`Unknown option ${flag}.`);
const dryRun = flags.has("--dry-run");
const assumeYes = flags.has("--yes");

let prompter = null;

async function main() {
  if (typeof fetch !== "function") throw new Error("this script needs Node 18 or later");
  if (command === "init") return init(target);
  if (!["up", "connect", "status"].includes(command) || !target) usage("Give a command and the settings file.");
  const run = loadRun(target);
  if (command === "status") return status(run);
  if (command === "up") return up(run);
  return connect(run);
}

function usage(problem) {
  console.error(`${problem}\n\nUsage:\n  node devops/bootstrap.mjs init <name>\n  node devops/bootstrap.mjs up|connect|status <settings file> [--dry-run] [--yes]`);
  process.exit(2);
}

function init(name) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) usage("Give a short name in lower case, such as realinfobot-test.");
  const file = `.env.bootstrap-${name}`;
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  fs.writeFileSync(file, SETTINGS_TEMPLATE.replace("__NAME__", name), { mode: 0o600 });
  console.log(`Wrote ${file}. Fill it in, then run:\n  node devops/bootstrap.mjs up ${file} --dry-run`);
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
  if (s.DEPLOYMENT_MODE === "cloud" && !s.POLAR_ORGANIZATION_ID) problems.push("POLAR_ORGANIZATION_ID is empty, and DEPLOYMENT_MODE is cloud");
  if (s.TWILIO_TOLLFREE && s.TWILIO_TOLLFREE !== "buy" && !/^\+\d{8,15}$/.test(s.TWILIO_TOLLFREE)) problems.push("TWILIO_TOLLFREE is buy, a number such as +18445550123, or empty");
  if (s.TWILIO_TOLLFREE && s.DEPLOYMENT_MODE !== "cloud") problems.push("TWILIO_TOLLFREE is only for DEPLOYMENT_MODE=cloud");
  if (problems.length) throw new Error(`${file} needs fixing:\n  ${problems.join("\n  ")}`);
  const stateFile = path.join(path.dirname(file), `${path.basename(file)}.state.json`);
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { done: {}, values: {} };
  return { file, settings: s, stateFile, state };
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
  if (dryRun) return;
  const values = (await work()) ?? {};
  Object.assign(run.state.values, values);
  run.state.done[id] = new Date().toISOString();
  save(run);
}

const v = (run, key) => run.state.values[key];

// ---------------------------------------------------------------- prompts

function createPrompter() {
  const terminal = process.stdin.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
  const waiting = [];
  let closed = false;
  let current = null;
  rl.on("line", (line) => waiting.push(line));
  rl.on("close", () => {
    closed = true;
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
        rl.question(question, (answer) => {
          const { muted } = current;
          current = null;
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

function ask(question, { hidden = false } = {}) {
  prompter ??= createPrompter();
  return prompter.ask(question, hidden);
}

async function secret(name, question) {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  const answer = await ask(`${question} (typing is hidden): `, { hidden: true });
  if (!answer) throw new Error(`no value given for ${name}`);
  return answer;
}

async function value(question, check = () => true) {
  const answer = await ask(`${question}: `);
  if (!answer || !check(answer)) throw new Error(`that isn't a valid answer to "${question}"`);
  return answer;
}

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
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`${service} couldn't be reached (${error.cause?.code ?? error.message})`);
  }
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
    throw error;
  }
  return json;
}

const tokens = {};
async function token(name, question) {
  tokens[name] ??= await secret(name, question);
  return tokens[name];
}

async function railway(query, variables = {}) {
  const auth = await token("RAILWAY_API_TOKEN", "Railway account or workspace token");
  const json = await http("Railway", URLS.railway, { method: "POST", headers: { Authorization: `Bearer ${auth}` }, body: { query, variables } });
  if (json?.errors?.length) {
    const error = new Error(`Railway refused it: ${json.errors.map((item) => item.message).join("; ")}`);
    error.graphql = json.errors;
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
  if (json && json.success === false) throw new Error(`Cloudflare refused ${pathname}: ${json.errors?.map((item) => item.message).join("; ")}`);
  return json.result;
}

// ---------------------------------------------------------------- up

async function up(run) {
  const s = run.settings;
  console.log(`${dryRun ? "Dry run: nothing is called or changed.\n" : ""}${s.NAME}: ${s.ENVIRONMENT}, ${s.DEPLOYMENT_MODE}, brand ${s.BRAND}, from ${s.REPO}@${s.BRANCH}\n`);
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
      await byHand([
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

async function githubSteps(run) {
  const s = run.settings;
  if (!s.STEP_GITHUB) return console.log("  skipped (STEP_GITHUB=no)");
  await step(run, "github.actions", `Turn on the checks of ${s.REPO}`, async () => {
    const result = spawnSync("gh", ["api", "-X", "PUT", `repos/${s.REPO}/actions/permissions`, "-F", "enabled=true"], { encoding: "utf8", shell: process.platform === "win32" });
    if (result.error || result.status !== 0) {
      await byHand([`GitHub CLI couldn't do it (${(result.stderr || result.error?.message || "").trim().split("\n")[0]}).`, `Open https://github.com/${s.REPO}/actions and enable the workflows.`]);
    }
  });
  await step(run, "github.brand", `Check that ${s.REPO}@${s.BRANCH} has brands/${s.BRAND}`, async () => {
    const result = spawnSync("gh", ["api", `repos/${s.REPO}/contents/brands/${s.BRAND}/brand.json?ref=${s.BRANCH}`, "--jq", ".name"], { encoding: "utf8", shell: process.platform === "win32" });
    if (result.error) return byHand([`GitHub CLI isn't installed. Check that https://github.com/${s.REPO}/tree/${s.BRANCH}/brands/${s.BRAND} exists`, "(click Sync fork first if it's missing): BRAND_REQUIRED stops the admin and the worker without it."]);
    if (result.status !== 0) throw new Error(`${s.REPO}@${s.BRANCH} has no brands/${s.BRAND}/brand.json. Click Sync fork on GitHub, or add the brand (guide section 4), then run again`);
  });
}

async function openaiSteps(run) {
  const s = run.settings;
  if (!s.STEP_OPENAI) {
    await step(run, "openai.manual", "OpenAI project and key, typed in (STEP_OPENAI=no)", async () => ({
      OPENAI_PROJECT_ID: await value("The OpenAI project's ID (proj_...)", (answer) => answer.startsWith("proj_")),
      OPENAI_API_KEY: await secret("OPENAI_API_KEY", "The project's API key (sk-...)"),
    }));
    return;
  }
  await step(run, "openai.project", `OpenAI project "${s.NAME}"`, async () => {
    const list = await openai("/organization/projects?limit=100");
    const found = list?.data?.find((project) => project.name === s.NAME && project.status !== "archived");
    if (found) return { OPENAI_PROJECT_ID: found.id };
    const project = await openai("/organization/projects", { method: "POST", body: { name: s.NAME } });
    return { OPENAI_PROJECT_ID: project.id };
  });
  await step(run, "openai.key", "Its API key, owned by a service account", async () => {
    const account = await openai(`/organization/projects/${v(run, "OPENAI_PROJECT_ID")}/service_accounts`, { method: "POST", body: { name: `${s.NAME} platform` } });
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
      TWILIO_ACCOUNT_SID: await value("The subaccount's Account SID (AC...)", (answer) => /^AC\w{32}$/.test(answer)),
      TWILIO_AUTH_TOKEN: await secret("TWILIO_AUTH_TOKEN", "The subaccount's Auth Token"),
      TWILIO_SIP_TRUNK_SID: await value("The trunk's SID (TK...)", (answer) => /^TK\w{32}$/.test(answer)),
    }));
    return;
  }
  await step(run, "twilio.subaccount", `Twilio subaccount "${s.NAME}"`, async () => {
    const list = await twilioMain(`/Accounts.json?FriendlyName=${encodeURIComponent(s.NAME)}&PageSize=20`);
    const found = list?.accounts?.find((account) => account.friendly_name === s.NAME && account.status !== "closed");
    const account = found ?? (await twilioMain("/Accounts.json", { method: "POST", form: { FriendlyName: s.NAME } }));
    if (!account?.auth_token) throw new Error(`Twilio didn't send the Auth Token of subaccount ${account?.sid}`);
    return { TWILIO_ACCOUNT_SID: account.sid, TWILIO_AUTH_TOKEN: account.auth_token };
  });
  await step(run, "twilio.trunk", "The SIP trunk to OpenAI: Secure Trunking, transfers, caller ID of the transferee", async () => {
    const list = await twilioSub(run, URLS.trunking, "/Trunks?PageSize=100");
    const name = `${s.NAME} to OpenAI`;
    const found = list?.trunks?.find((trunk) => trunk.friendly_name === name);
    const trunk = found ?? (await twilioSub(run, URLS.trunking, "/Trunks", {
      method: "POST",
      form: { FriendlyName: name, Secure: "true", TransferMode: "enable-all", TransferCallerId: "from-transferee", CnamLookupEnabled: "false" },
    }));
    return { TWILIO_SIP_TRUNK_SID: trunk.sid };
  });
  await step(run, "twilio.origination", "Its origination URI to the OpenAI project", async () => {
    const trunk = v(run, "TWILIO_SIP_TRUNK_SID");
    const sipUrl = `sip:${v(run, "OPENAI_PROJECT_ID")}@sip.api.openai.com;transport=tls`;
    const list = await twilioSub(run, URLS.trunking, `/Trunks/${trunk}/OriginationUrls`);
    const urls = list?.origination_urls ?? [];
    if (urls.some((url) => url.sip_url === sipUrl)) return;
    if (urls.length) throw new Error(`trunk ${trunk} already has another origination URI; keep exactly one (guide 3.6, step 9)`);
    await twilioSub(run, URLS.trunking, `/Trunks/${trunk}/OriginationUrls`, {
      method: "POST",
      form: { FriendlyName: "OpenAI GPT-Live", SipUrl: sipUrl, Priority: "10", Weight: "10", Enabled: "true" },
    });
  });
  await step(run, "twilio.console", "Twilio's console-only steps", () => byHand([
    "1. Voice > Settings > Geo permissions: allow each country whose phones take transfers (guide 3.6, step 12).",
    "2. The business profile and US texting registration, if not done yet: Twilio reviews them for days (guide 3.6, steps 3 and 13).",
  ]));
}

async function resendSteps(run) {
  const s = run.settings;
  if (!s.STEP_RESEND) {
    await step(run, "resend.manual", "Resend's sending key, typed in (STEP_RESEND=no)", async () => ({ SMTP_PASSWORD: await secret("SMTP_PASSWORD", "The Resend API key (re_...)") }));
    return;
  }
  await step(run, "resend.domain", `Resend domain ${s.EMAIL_DOMAIN}`, async () => {
    const list = await resend("/domains");
    const found = list?.data?.find((domain) => domain.name === s.EMAIL_DOMAIN);
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
  if (!zones?.length) throw new Error(`the Cloudflare token can't see the zone ${run.settings.CLOUDFLARE_ZONE}`);
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
    const existing = await cloudflare(`/zones/${zone}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`);
    if (existing?.some((item) => item.content === record.content || (record.onlyIfNone && item.content.startsWith("v=DMARC1")))) {
      console.log(`  = ${record.type} ${record.name}`);
      continue;
    }
    if (record.type === "CNAME" && existing?.length) throw new Error(`${record.name} already has a CNAME pointing elsewhere; change it by hand`);
    const { onlyIfNone, ...body } = record;
    await cloudflare(`/zones/${zone}/dns_records`, { method: "POST", body: { ...body, ttl: 1, proxied: false } });
    console.log(`  + ${record.type} ${record.name}`);
  }
}

// ---------------------------------------------------------------- Railway

const Q = {
  projectCreate: "mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }",
  project: "query project($id: String!) { project(id: $id) { id name services { edges { node { id name } } } environments { edges { node { id name } } } } }",
  serviceCreate: "mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }",
  volumeCreate: "mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }",
  instanceUpdate: "mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }",
  domainCreate: "mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain } }",
  customDomainCreate: "mutation customDomainCreate($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id domain status { verificationToken dnsRecords { hostlabel requiredValue status } } } }",
  variables: "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }",
  connect: "mutation serviceConnect($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }",
};

const SERVICES = [
  { name: "Postgres", image: "pgvector/pgvector:pg16" },
  { name: "Redis", image: "redis:7-alpine" },
  { name: "migrate" },
  { name: "admin" },
  { name: "worker" },
];

async function projectView(run) {
  const { project } = await railway(Q.project, { id: v(run, "RAILWAY_PROJECT_ID") });
  return {
    services: Object.fromEntries(project.services.edges.map(({ node }) => [node.name, node.id])),
    environments: Object.fromEntries(project.environments.edges.map(({ node }) => [node.name, node.id])),
  };
}

async function railwaySteps(run) {
  const s = run.settings;
  await step(run, "railway.project", `Railway project "${s.NAME}" with the environment ${s.ENVIRONMENT}`, async () => {
    // Kept at once, so a run that stops after this call never makes a second project.
    if (!v(run, "RAILWAY_PROJECT_ID")) {
      const input = { name: s.NAME, defaultEnvironmentName: s.ENVIRONMENT, ...(s.RAILWAY_WORKSPACE_ID ? { workspaceId: s.RAILWAY_WORKSPACE_ID } : {}) };
      const { projectCreate } = await railway(Q.projectCreate, { input });
      run.state.values.RAILWAY_PROJECT_ID = projectCreate.id;
      save(run);
    }
    const view = await projectView(run);
    const environmentId = view.environments[s.ENVIRONMENT] ?? Object.values(view.environments)[0];
    if (!environmentId) throw new Error("Railway made the project without an environment");
    return { RAILWAY_ENVIRONMENT_ID: environmentId };
  });
  await step(run, "railway.services", "Services Postgres, Redis, migrate, admin and worker", async () => {
    const view = await projectView(run);
    const ids = {};
    for (const service of SERVICES) {
      if (view.services[service.name]) {
        ids[service.name] = view.services[service.name];
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
      await railway(Q.volumeCreate, { input: { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: id(service), mountPath } });
    });
  }
  await step(run, "railway.bucket", `The bucket "Bucket" in ${s.BUCKET_REGION}`, async () => {
    const link = spawnSync(RAILWAY_CLI, ["link", "--project", v(run, "RAILWAY_PROJECT_ID"), "--environment", s.ENVIRONMENT], { encoding: "utf8", env: cliEnv(), shell: process.platform === "win32" });
    const made = !link.error && link.status === 0 && spawnSync(RAILWAY_CLI, ["bucket", "create", "Bucket", "--region", s.BUCKET_REGION, "--json"], { encoding: "utf8", env: cliEnv(), shell: process.platform === "win32" });
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

function cliEnv() {
  return { ...process.env, ...(tokens.RAILWAY_API_TOKEN ? { RAILWAY_API_TOKEN: tokens.RAILWAY_API_TOKEN } : {}) };
}

async function addressSteps(run) {
  const s = run.settings;
  const admin = () => v(run, "RAILWAY_SERVICE_IDS")?.admin;
  await step(run, "railway.domain", "The admin's Railway address, port 3000", async () => {
    const { serviceDomainCreate } = await railway(Q.domainCreate, { input: { serviceId: admin(), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), targetPort: 3000 } });
    return { RAILWAY_HOST: serviceDomainCreate.domain, APP_HOST: s.CUSTOM_HOST || serviceDomainCreate.domain };
  });
  if (s.CUSTOM_HOST) {
    await step(run, "railway.custom", `The custom domain ${s.CUSTOM_HOST}`, async () => {
      const { customDomainCreate } = await railway(Q.customDomainCreate, { input: { projectId: v(run, "RAILWAY_PROJECT_ID"), environmentId: v(run, "RAILWAY_ENVIRONMENT_ID"), serviceId: admin(), domain: s.CUSTOM_HOST, targetPort: 3000 } });
      const target = customDomainCreate.status?.dnsRecords?.find((record) => record.requiredValue)?.requiredValue;
      const verification = customDomainCreate.status?.verificationToken;
      if (target && s.CLOUDFLARE_ZONE) await dnsRecords(run, [{ type: "CNAME", name: s.CUSTOM_HOST, content: target }]);
      await byHand([
        target && s.CLOUDFLARE_ZONE ? `The CNAME ${s.CUSTOM_HOST} -> ${target} is made.` : `Create a CNAME ${s.CUSTOM_HOST} -> ${target ?? "the target Railway shows"}, DNS only.`,
        `Create the TXT record Railway shows under admin > Settings > Networking for ${s.CUSTOM_HOST}${verification ? ` (its value includes ${verification})` : ""}.`,
        "Wait for the green check mark next to the domain (guide section 11).",
      ]);
    });
  }
  await step(run, "turnstile", "The Turnstile widget for the address", async () => {
    if (!s.STEP_TURNSTILE || !s.CLOUDFLARE_ACCOUNT_ID) {
      await byHand([`In Cloudflare, Turnstile > Add widget for ${v(run, "APP_HOST")}, Managed, Pre-clearance No (guide 5.3).`]);
      return {
        TURNSTILE_SITE_KEY: await value("The widget's Site Key"),
        TURNSTILE_SECRET_KEY: await secret("TURNSTILE_SECRET_KEY", "The widget's Secret Key"),
      };
    }
    const domains = [...new Set([v(run, "APP_HOST"), v(run, "RAILWAY_HOST")])];
    const widget = await cloudflare(`/accounts/${s.CLOUDFLARE_ACCOUNT_ID}/challenges/widgets`, { method: "POST", body: { name: s.NAME, domains, mode: "managed" } });
    return { TURNSTILE_SITE_KEY: widget.sitekey, TURNSTILE_SECRET_KEY: widget.secret };
  });
}

async function tollfreeSteps(run) {
  const s = run.settings;
  await step(run, "twilio.tollfree", s.TWILIO_TOLLFREE === "buy" ? "Buy a toll-free number in the subaccount" : `Use ${s.TWILIO_TOLLFREE}`, async () => {
    const smsUrl = `https://${v(run, "APP_HOST")}/api/webhooks/twilio/sms`;
    const base = `${URLS.twilio}/Accounts/${v(run, "TWILIO_ACCOUNT_SID")}`;
    let number = s.TWILIO_TOLLFREE;
    if (number === "buy") {
      const available = await twilioSub(run, base, "/AvailablePhoneNumbers/US/TollFree.json?SmsEnabled=true&PageSize=1");
      number = available?.available_phone_numbers?.[0]?.phone_number;
      if (!number) throw new Error("Twilio offered no toll-free number");
      await confirm(`Buy ${number} in subaccount ${s.NAME}? Twilio bills it every month.`);
      await twilioSub(run, base, "/IncomingPhoneNumbers.json", { method: "POST", form: { PhoneNumber: number, SmsUrl: smsUrl, SmsMethod: "POST", FriendlyName: `${s.NAME} shared texts` } });
    } else {
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
  await step(run, "secrets", "The 13 passwords and secrets (64 hex characters each)", () =>
    Object.fromEntries(SECRETS.map((key) => [key, run.state.values[key] ?? randomBytes(32).toString("hex")])));
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
  console.log(`${dryRun ? "Dry run: nothing is called or changed.\n" : ""}${s.NAME} at https://${host}\n`);
  await step(run, "connect.health", `https://${host}/api/health/ready answers "ok":true with the ${s.BRAND} brand`, async () => {
    const health = await http("The admin", `${process.env.BOOTSTRAP_APP_URL ?? `https://${host}`}/api/health/ready`).catch((error) => ({ failed: error.message }));
    if (health?.failed || health?.ok !== true) throw new Error(`the admin isn't ready yet (${health?.failed ?? JSON.stringify(health)}). Check its deployment, then run again`);
    const brand = typeof health.brand === "string" ? health.brand : health.brand?.id;
    if (brand && brand !== s.BRAND) throw new Error(`the admin shows the ${brand} brand, not ${s.BRAND}`);
  });
  await step(run, "connect.webhook", "OpenAI's incoming-call webhook (OpenAI's API can't make this one yet)", async () => {
    await byHand([
      `In the OpenAI project "${s.NAME}": Settings > Webhooks > Create (guide 3.5, steps 8 to 10).`,
      `URL: https://${host}/api/webhooks/openai/live   (no slash at the end)`,
      "Event types: only live.transport.incoming. Copy the whsec_ signing secret it shows once.",
    ]);
    return { OPENAI_WEBHOOK_SECRET: await secret("OPENAI_WEBHOOK_SECRET", "The webhook's signing secret (whsec_...)") };
  });
  await step(run, "connect.platformKey", "The operator's platform key (pnpm platform-key:create)", async () => {
    const result = spawnSync("pnpm", ["--silent", "platform-key:create", "--name", "Operator key", "--partner", "operator", "--owner-email", s.OPERATOR_EMAIL, "--access", "all"], {
      encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, PLATFORM_API_KEYS: "" },
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
  console.log(`${s.NAME} (${run.stateFile})`);
  const done = Object.entries(run.state.done);
  if (!done.length) console.log("  nothing done yet: run up");
  for (const [id, at] of done) console.log(`  done  ${at}  ${id}`);
  const host = run.state.values.APP_HOST;
  if (host) console.log(`  address: https://${host}`);
  console.log(`  values kept (never printed): ${Object.keys(run.state.values).length}`);
}

// Last, so every declaration above is in place before the first step runs.
main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    console.error("Steps already done are recorded. Fix the problem and run the same command again.");
    process.exitCode = 1;
  })
  .finally(() => prompter?.close());
