import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POLAR_API_VERSION } from "../packages/shared/src/billing";

// devops/bootstrap.mjs end to end, run as a person runs it: against one local server that stands in for Railway's API,
// Polar's API and the deployment's admin, with a fake pnpm on PATH for platform-key:create and pnpm billing. Each test
// writes a settings file and the state file an earlier run would have left, runs the script, and checks what it did
// to the stand-ins and what it kept on disk. The fake pnpm is a shell script, so Windows skips these.

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(repoRoot, "devops", "bootstrap.mjs");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const railwayHost = "acme-test-production.up.railway.app";
const webhookUrl = `https://${railwayHost}/api/webhooks/polar`;
const openaiWebhookSecret = `whsec_${"o".repeat(32)}`;
const earlier = "2026-11-01T00:00:00.000Z";
type Organization = { id: string; name: string; slug: string };
const acme: Organization = { id: "8c7b6a5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d", name: "Acme", slug: "acme" };
const other: Organization = { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", name: "Other", slug: "other" };
// Organization tokens of Acme's sandbox, and one of another organization.
const polarTokens = {
  admin: `polar_oat_admin${"a".repeat(24)}`,
  worker: `polar_oat_worker${"b".repeat(24)}`,
  setup: `polar_oat_setup${"c".repeat(24)}`,
  other: `polar_oat_other${"d".repeat(24)}`,
};
const serviceIds = { Postgres: "svc-postgres", Redis: "svc-redis", migrate: "svc-migrate", admin: "svc-admin", worker: "svc-worker" };
const platformSecrets = Object.fromEntries(["POSTGRES_PASSWORD", "LOBBYSTACK_AUTH_PASSWORD", "LOBBYSTACK_APP_PASSWORD", "LOBBYSTACK_WORKER_PASSWORD",
  "LOBBYSTACK_DISPATCHER_PASSWORD", "REDIS_PASSWORD", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "INTERNAL_SERVICE_SECRET", "INTERNAL_SERVICE_TOKEN",
  "NUMBER_CLAIM_TOKEN_SECRET", "OTP_HASH_SECRET", "WIDGET_SESSION_SECRET"].map((key) => [key, randomBytes(32).toString("hex")])) as Record<string, string>;
// What up has done by the time connect runs, with STEP_*=no and no APP_BASE_URL.
const upSteps = ["openai.manual", "twilio.manual", "resend.manual", "polar.tokens", "railway.project", "railway.services", "railway.volume.Postgres",
  "railway.volume.Redis", "railway.bucket", "railway.settings.Redis", "railway.settings.migrate", "railway.settings.admin", "railway.settings.worker",
  "railway.predeploy", "railway.domain", "turnstile", "secrets", "variables", "deploy.databases", "deploy.migrate", "deploy.admin", "deploy.worker",
  "post.urls", "post.turnstile"];
const connectSteps = ["connect.health", "connect.webhook", "connect.platformKey", "connect.variables"];
const billingSteps = ["connect.billing.apply", "connect.billing.secret", "connect.billing.verify"];

// ---------------------------------------------------------------- the fake pnpm

// platform-key:create as the real one prints, and pnpm billing plan, apply and verify as bootstrap.mjs sees them: apply
// makes the webhook in the stand-in Polar (or finds it) and writes the --railway-file, with the secret only when it made
// the webhook; apply and verify end 0 when the admin runs with the webhook's secret, else 1, as the real ones' drift
// check does. FAKE_PNPM_CONTROL can make them end otherwise, or make apply refuse a token as Polar refuses one without
// the setup scopes; FAKE_PNPM_LOG gets one line per run.
const fakePnpm = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const args = process.argv.slice(2).filter((arg) => arg !== "--silent");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const log = (entry) => fs.appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify(entry) + "\\n");
let control = {};
try {
  control = JSON.parse(fs.readFileSync(process.env.FAKE_PNPM_CONTROL, "utf8"));
} catch {}

async function call(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...options.headers, "x-stand-in-caller": "pnpm" } });
  const json = await response.json();
  if (!response.ok) throw new Error(url + " answered " + response.status + ": " + JSON.stringify(json));
  return json;
}

function platformKey() {
  const short = crypto.randomBytes(4).toString("hex");
  const key = "lsp_" + short + "_" + crypto.randomBytes(24).toString("base64url");
  const entry = { id: crypto.randomUUID(), prefix: "lsp_" + short, hash: sha256(key), name: flag("--name"), partner: flag("--partner"), owner_email: flag("--owner-email"), access: flag("--access") };
  const file = path.join(process.cwd(), ".platform-keys", entry.prefix + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ key, entry }), { mode: 0o600 });
  log({ command: "platform-key:create", cwd: process.cwd() });
  console.log("Key written to " + file + ". Send it to its holder securely, then delete the file.\\n");
  console.log("New entry:\\n" + JSON.stringify(entry, null, 2));
  console.log(JSON.stringify(JSON.parse(process.env.PLATFORM_API_KEYS || "[]").concat([entry])));
  return 0;
}

async function result(secret) {
  const catalog = await call(process.env.LOBBYSTACK_URL + "/api/v1/billing/catalog", { headers: { authorization: "Bearer " + process.env.LOBBYSTACK_API_KEY } });
  if (secret && catalog.polar.secret_sha256 === sha256(secret)) {
    console.log("Result: in sync (exit 0)");
    return 0;
  }
  console.log("DRIFT  webhook_secret: POLAR_WEBHOOK_SECRET isn't set on the instance, so it refuses every Polar event.");
  console.log("Result: drift (exit 1)");
  return 1;
}

async function billing(command, entry) {
  const url = flag("--webhook-url");
  if (command === "plan") {
    console.log("Plan: brands/" + flag("--brand") + "/billing.json on Polar's " + flag("--polar") + ": a meter, four products and a webhook to " + url);
    return control.planExit ?? 0;
  }
  if (command === "apply") {
    if (!args.includes("--yes")) {
      console.log("Add --yes to apply without a question.");
      return 1;
    }
    if (control.refuseApply && control.refuseApply === process.env.POLAR_SETUP_TOKEN) {
      console.error('Polar answered 403 to POST /v1/meters/: {"error":"insufficient_scope"}');
      return 2;
    }
    const made = await call(process.env.BOOTSTRAP_POLAR_URL + "/__fake/webhooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, token: process.env.POLAR_SETUP_TOKEN }) });
    entry.madeWebhook = made.created;
    console.log((made.created ? "  done create webhook " : "  = webhook ") + url);
    const lines = ["[admin, worker]", "POLAR_API_BASE_URL=https://sandbox-api.polar.sh", "POLAR_ORGANIZATION_ID=" + made.organization];
    if (made.created) lines.push("", "[admin]", "POLAR_WEBHOOK_SECRET=" + made.secret);
    fs.writeFileSync(flag("--railway-file"), lines.join("\\n") + "\\n", { mode: 0o600, flag: "wx" });
    if (control.applyExit !== undefined) return control.applyExit;
    return result(made.secret);
  }
  if (command === "verify") {
    const endpoints = await call(process.env.BOOTSTRAP_POLAR_URL + "/v1/webhooks/endpoints?page=1&limit=100", { headers: { authorization: "Bearer " + process.env.POLAR_READ_TOKEN } });
    const webhook = endpoints.items.find((item) => item.url === url);
    if (control.verifyExit !== undefined) {
      console.log("DRIFT  product: the stand-in says so");
      return control.verifyExit;
    }
    return result(webhook && webhook.secret);
  }
  return 2;
}

async function main() {
  if (args[0] === "--version") {
    console.log("10.99.0");
    return 0;
  }
  if (args[0] === "platform-key:create") return platformKey();
  if (args[0] !== "billing") return 2;
  const env = Object.fromEntries(["LOBBYSTACK_URL", "LOBBYSTACK_API_KEY", "POLAR_SETUP_TOKEN", "POLAR_READ_TOKEN", "XDG_CONFIG_HOME"].map((key) => [key, process.env[key]]));
  const entry = { command: "billing " + args[1], args: args.slice(2), cwd: process.cwd(), env, configFolder: fs.existsSync(process.env.XDG_CONFIG_HOME || "") };
  try {
    return await billing(args[1], entry);
  } finally {
    log(entry);
  }
}

main().then((code) => {
  process.exitCode = code;
}, (error) => {
  console.error(error.message);
  process.exitCode = 2;
});
`;

// ---------------------------------------------------------------- the stand-ins

type Vars = Record<string, string>;
type Service = keyof typeof serviceIds;
type Deployment = { id: string; status: "DEPLOYING" | "SUCCESS"; polls: number };
type Webhook = { id: string; url: string; secret: string; organization_id: string };
type World = {
  /** Each service's variables on Railway, and those its live deployment started with. */
  variables: Record<Service, Vars>;
  running: Record<Service, Vars>;
  deployments: Record<Service, Deployment[]>;
  /** A variable write Railway refuses. */
  refuse: ((service: Service, variables: Vars) => boolean) | null;
  organizations: Map<string, Organization>;
  /** The tokens that may read webhooks (webhooks:write): setup tokens, and the worker's when a test gives it the setup scopes. */
  webhookTokens: Set<string>;
  webhooks: Webhook[];
  /** How many more times the admin says the operator key's owner hasn't verified their email. */
  ownerInactiveAnswers: number;
  /** The polar-version header of each of bootstrap.mjs's calls to Polar. */
  polarVersions: Array<string | undefined>;
};

const services = Object.keys(serviceIds) as Service[];
const serviceOf = (id: unknown) => services.find((name) => serviceIds[name] === id);

function freshWorld(): World {
  const each = <T>(make: (service: Service) => T) => Object.fromEntries(services.map((service) => [service, make(service)])) as Record<Service, T>;
  return {
    variables: each(() => ({})),
    running: each(() => ({})),
    deployments: each((service) => [{ id: `${service}-deployment-1`, status: "SUCCESS", polls: 0 }]),
    refuse: null,
    organizations: new Map([[polarTokens.admin, acme], [polarTokens.worker, acme], [polarTokens.setup, acme], [polarTokens.other, other]]),
    webhookTokens: new Set([polarTokens.setup, polarTokens.other]),
    webhooks: [],
    ownerInactiveAnswers: 0,
    polarVersions: [],
  };
}

let world = freshWorld();

function deploy(service: Service) {
  const list = world.deployments[service];
  list.unshift({ id: `${service}-deployment-${list.length + 1}`, status: "DEPLOYING", polls: 0 });
}

type GraphQL = { query?: string; variables?: { serviceId?: string; input?: { serviceId?: string; variables?: Vars; skipDeploys?: boolean } } };

function railwayAnswer(body: GraphQL | null): unknown {
  const operation = /^(?:query|mutation) (\w+)/.exec(body?.query ?? "")?.[1];
  const variables = body?.variables ?? {};
  if (operation === "project") {
    return { data: { project: { id: "proj-1", name: "acme-test", deletedAt: null,
      services: { edges: services.map((name) => ({ node: { id: serviceIds[name], name } })) },
      environments: { edges: [{ node: { id: "env-1", name: "test" } }] },
      volumes: { edges: [] },
      buckets: { edges: [{ node: { id: "bucket-1", name: "Bucket" } }] } } } };
  }
  if (operation === "domains") return { data: { domains: { serviceDomains: [{ id: "domain-1", domain: railwayHost, targetPort: 3000 }], customDomains: [] } } };
  if (operation === "workspace") return { data: { workspace: { name: "Acme's workspace" } } };
  const service = serviceOf(variables.serviceId ?? variables.input?.serviceId);
  if (!service) return { errors: [{ message: `the stand-in has no ${operation ?? "such call"} for that service` }] };
  if (operation === "variables") return { data: { variables: { ...world.variables[service] } } };
  if (operation === "variableCollectionUpsert") {
    const values = variables.input?.variables ?? {};
    if (world.refuse?.(service, values)) return { errors: [{ message: "Problem processing request" }] };
    Object.assign(world.variables[service], values);
    if (!variables.input?.skipDeploys) deploy(service);
    return { data: { variableCollectionUpsert: true } };
  }
  if (operation === "serviceInstanceRedeploy") {
    deploy(service);
    return { data: { serviceInstanceRedeploy: true } };
  }
  if (operation === "deployments") {
    const latest = world.deployments[service][0];
    // A new deployment goes live at the second look, with the variables Railway has then.
    if (latest?.status === "DEPLOYING" && (latest.polls += 1) > 1) {
      latest.status = "SUCCESS";
      world.running[service] = { ...world.variables[service] };
    }
    return { data: { deployments: { edges: latest ? [{ node: { id: latest.id, status: latest.status } }] : [] } } };
  }
  return { errors: [{ message: `the stand-in doesn't answer ${operation ?? "that"}` }] };
}

type FakeWebhookRequest = { url?: string; token?: string };

function polarAnswer(method: string, path: string, token: string, body: FakeWebhookRequest | null): [number, unknown] {
  // The fake pnpm billing apply's way to make the webhook, or find it, as the real apply does with its setup token.
  if (method === "POST" && path === "/__fake/webhooks") {
    const organization = world.organizations.get(body?.token ?? "");
    if (!organization) return [401, { detail: "Invalid token." }];
    const found = world.webhooks.find((webhook) => webhook.url === body?.url && webhook.organization_id === organization.id);
    if (found) return [200, { secret: found.secret, created: false, organization: organization.id }];
    const webhook = { id: randomUUID(), url: String(body?.url), secret: `polar_whs_${randomBytes(24).toString("hex")}`, organization_id: organization.id };
    world.webhooks.push(webhook);
    return [200, { secret: webhook.secret, created: true, organization: organization.id }];
  }
  const organization = world.organizations.get(token);
  if (!organization) return [401, { detail: "Invalid token." }];
  if (path === "/v1/organizations/") return [200, { items: [organization], pagination: { total_count: 1, max_page: 1 } }];
  if (path === "/v1/webhooks/endpoints") {
    if (!world.webhookTokens.has(token)) return [403, { detail: "The token's scopes don't allow this." }];
    const items = world.webhooks.filter((webhook) => webhook.organization_id === organization.id);
    return [200, { items, pagination: { total_count: items.length, max_page: 1 } }];
  }
  return [404, { detail: `the stand-in has no ${method} ${path}` }];
}

function adminAnswer(path: string, key: string): [number, unknown] {
  if (path === "/api/health/ready") return [200, { ok: true, brand: "acme" }];
  // The keys of the admin's live deployment, as PLATFORM_API_KEYS has them.
  const running = world.running.admin;
  let entries: Array<{ hash?: string }> = [];
  try {
    entries = JSON.parse(running.PLATFORM_API_KEYS ?? "[]") as Array<{ hash?: string }>;
  } catch {
    // None.
  }
  if (!entries.some((entry) => entry.hash === sha256(key))) return [401, { error: { code: "invalid_api_key", message: "Unknown API key." } }];
  if (world.ownerInactiveAnswers > 0) {
    world.ownerInactiveAnswers -= 1;
    return [403, { error: { code: "key_owner_inactive", message: "The key's owner hasn't verified their email yet." } }];
  }
  if (path === "/api/v1/me") return [200, { data: { email: "ops@example.com" } }];
  if (path === "/api/v1/billing/catalog") {
    const secret = running.POLAR_WEBHOOK_SECRET;
    return [200, { brand: "acme", polar: { env: "sandbox", org: running.POLAR_ORGANIZATION_ID ?? null, secret_sha256: secret ? sha256(secret) : null } }];
  }
  return [404, { error: { code: "not_found", message: `the stand-in has no ${path}` } }];
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  const body: unknown = text ? JSON.parse(text) : null;
  const url = new URL(request.url ?? "/", "http://stand-in");
  const token = String(request.headers.authorization ?? "").replace(/^Bearer /i, "");
  let answer: [number, unknown] = [404, { detail: "no such stand-in" }];
  if (url.pathname === "/railway") answer = [200, railwayAnswer(body as GraphQL | null)];
  else if (url.pathname.startsWith("/polar/")) {
    const version = request.headers["polar-version"];
    if (request.headers["x-stand-in-caller"] !== "pnpm") world.polarVersions.push(Array.isArray(version) ? version.join(",") : version);
    answer = polarAnswer(request.method ?? "GET", url.pathname.slice("/polar".length), token, body as FakeWebhookRequest | null);
  } else if (url.pathname.startsWith("/app/")) answer = adminAnswer(url.pathname.slice("/app".length), token);
  response.writeHead(answer[0], { "content-type": "application/json" });
  response.end(JSON.stringify(answer[1]));
}

// ---------------------------------------------------------------- settings, state and runs

let server: Server;
let base = "";
let bin = "";
let dir = "";

const settings = () => join(dir, ".env.bootstrap-acme-test");
type State = { done: Record<string, string>; values: Record<string, unknown>; byHand?: Record<string, string> };
const stateText = () => readFileSync(`${settings()}.state.json`, "utf8");
const readState = () => JSON.parse(stateText()) as State;
const logText = () => readFileSync(`${settings()}.log`, "utf8");

function writeSettings(changes: Record<string, string> = {}) {
  const values = { NAME: "acme-test", BRAND: "acme", ENVIRONMENT: "test", REPO: "acme/lobbystack", BRANCH: "main", DEPLOYMENT_MODE: "cloud",
    OPERATOR_EMAIL: "ops@example.com", EMAIL_FROM: "hello@mail.example.com", RAILWAY_WORKSPACE_ID: "ws-1", BILLING_PROVIDER: "polar", POLAR: "sandbox",
    POLAR_ORGANIZATION_ID: "", STEP_GITHUB: "no", STEP_OPENAI: "no", STEP_TWILIO: "no", STEP_RESEND: "no", STEP_TURNSTILE: "no", ...changes };
  writeFileSync(settings(), `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  writeFileSync(`${settings()}.secrets`, `OPENAI_WEBHOOK_SECRET=${openaiWebhookSecret}\n`, { mode: 0o600 });
}

const writeState = (state: State) => writeFileSync(`${settings()}.state.json`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

/** The state file up leaves. */
function stateAfterUp(): State {
  return {
    done: Object.fromEntries(upSteps.map((id) => [id, earlier])),
    values: {
      RAILWAY_PROJECT_ID: "proj-1", RAILWAY_PROJECT_NAME: "acme-test", RAILWAY_ENVIRONMENT_ID: "env-1", RAILWAY_SERVICE_IDS: serviceIds,
      RAILWAY_HOST: railwayHost, APP_HOST: railwayHost,
      OPENAI_PROJECT_ID: "proj_acme", OPENAI_API_KEY: `sk-proj-${"e".repeat(40)}`,
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, TWILIO_AUTH_TOKEN: "f".repeat(32), TWILIO_SIP_TRUNK_SID: `TK${"2".repeat(32)}`,
      SMTP_PASSWORD: `re_${"g".repeat(30)}`, TURNSTILE_SITE_KEY: "0x4AAAAAAAstandin", TURNSTILE_SECRET_KEY: `0x4AAAAAAA${"h".repeat(24)}`,
      POLAR_ADMIN_TOKEN: polarTokens.admin, POLAR_WORKER_TOKEN: polarTokens.worker, POLAR_ORGANIZATION_ID: acme.id,
      ...platformSecrets,
    },
  };
}

/** Railway as up leaves it: the databases run with the state file's passwords. */
function railwayAfterUp() {
  world.variables.Postgres = { PGDATA: "/var/lib/postgresql/data/pgdata", POSTGRES_DB: "lobbystack", POSTGRES_USER: "postgres",
    ...Object.fromEntries(Object.entries(platformSecrets).filter(([key]) => key.startsWith("POSTGRES_") || key.startsWith("LOBBYSTACK_"))) };
  world.variables.Redis = { REDIS_PASSWORD: String(platformSecrets.REDIS_PASSWORD) };
  world.variables.admin = { NODE_ENV: "production", APP_BASE_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}" };
  for (const service of services) world.running[service] = { ...world.variables[service] };
}

type OperatorKey = { key: string; entry: { prefix: string; hash: string; partner: string; owner_email: string } };

/** Settings, state and Railway as connect leaves them before its billing steps: the operator key is live on the admin. */
function readyForBilling({ keyFile = true }: { keyFile?: boolean } = {}): OperatorKey & { file: string } {
  writeSettings();
  railwayAfterUp();
  const short = randomBytes(4).toString("hex");
  const key = `lsp_${short}_${randomBytes(24).toString("base64url")}`;
  const entry = { prefix: `lsp_${short}`, hash: sha256(key), partner: "operator", owner_email: "ops@example.com" };
  const file = join(dir, ".platform-keys", `${entry.prefix}.json`);
  if (keyFile) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ key, entry }), { mode: 0o600 });
  }
  const state = stateAfterUp();
  for (const id of connectSteps) state.done[id] = earlier;
  Object.assign(state.values, { OPENAI_WEBHOOK_SECRET: openaiWebhookSecret, WEBHOOK_URL: `https://${railwayHost}/api/webhooks/openai/live`,
    PLATFORM_API_KEYS: JSON.stringify([entry]), PLATFORM_KEY_FILE: file });
  writeState(state);
  Object.assign(world.variables.admin, { OPENAI_WEBHOOK_SECRET: openaiWebhookSecret, PLATFORM_API_KEYS: JSON.stringify([entry]) });
  world.running.admin = { ...world.variables.admin };
  return { key, entry, file };
}

type PnpmRun = { command: string; args?: string[]; cwd: string; env?: Record<string, string | undefined>; configFolder?: boolean; madeWebhook?: boolean };
const pnpmRuns = (): PnpmRun[] => {
  const file = join(dir, "pnpm.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as PnpmRun) : [];
};
const billingRuns = () => pnpmRuns().filter((run) => run.command.startsWith("billing "));
const control = (value: { planExit?: number; applyExit?: number; verifyExit?: number; refuseApply?: string }) => writeFileSync(join(dir, "pnpm-control.json"), JSON.stringify(value));
const flagOf = (run: PnpmRun | undefined, name: string) => (run?.args?.includes(name) ? run.args[run.args.indexOf(name) + 1] : undefined);

type Result = { code: number | null; out: string };

/** Runs bootstrap.mjs with its answers piped in, against the stand-ins. */
function bootstrap(args: string[], { input = "", env = {} }: { input?: string; env?: Record<string, string> } = {}): Promise<Result> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: dir,
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        HOME: dir,
        TMPDIR: join(dir, "tmp"),
        BOOTSTRAP_RAILWAY_URL: `${base}/railway`,
        BOOTSTRAP_POLAR_URL: `${base}/polar`,
        BOOTSTRAP_APP_URL: `${base}/app`,
        BOOTSTRAP_POLL_MS: "1",
        BOOTSTRAP_RAILWAY_CLI: join(dir, "no-railway-cli"),
        RAILWAY_API_TOKEN: "railway-stand-in-token",
        POLAR_SETUP_TOKEN: polarTokens.setup,
        FAKE_PNPM_LOG: join(dir, "pnpm.jsonl"),
        FAKE_PNPM_CONTROL: join(dir, "pnpm-control.json"),
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (out += String(chunk)));
    // A run that ends before reading its input.
    child.stdin.on("error", () => undefined);
    child.on("error", fail);
    child.on("close", (code) => done({ code, out }));
    child.stdin.end(input);
  });
}

describe.skipIf(process.platform === "win32")("devops/bootstrap.mjs", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    bin = mkdtempSync(join(tmpdir(), "bootstrap-test-bin-"));
    writeFileSync(join(bin, "pnpm.cjs"), fakePnpm);
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "pnpm.cjs")}" "$@"\n`, { mode: 0o755 });
    server = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: String(error) }));
      });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
    rmSync(bin, { recursive: true, force: true });
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bootstrap-test-"));
    mkdirSync(join(dir, "tmp"));
    world = freshWorld();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks Polar for the API version pnpm billing uses", () => {
    expect(readFileSync(script, "utf8")).toContain(`const POLAR_API_VERSION = "${POLAR_API_VERSION}";`);
  });

  it("refuses a POLAR_ORGANIZATION_ID that isn't a Polar organization's ID", async () => {
    writeSettings({ POLAR_ORGANIZATION_ID: "org_acme" });
    const result = await bootstrap(["status", settings()]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("POLAR_ORGANIZATION_ID is the Polar organization's ID, a UUID, or empty to take it from the worker's token");
  });

  it("takes POLAR_ORGANIZATION_ID from the worker's token in up, for the admin and the worker", async () => {
    writeSettings();
    railwayAfterUp();
    const state = stateAfterUp();
    delete state.done["polar.tokens"];
    delete state.done.variables;
    for (const key of ["POLAR_ADMIN_TOKEN", "POLAR_WORKER_TOKEN", "POLAR_ORGANIZATION_ID"]) delete state.values[key];
    writeState(state);
    const result = await bootstrap(["up", settings(), "--yes"], { env: { POLAR_ADMIN_TOKEN: polarTokens.admin, POLAR_WORKER_TOKEN: polarTokens.worker } });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`the worker's token belongs to Polar's sandbox organization Acme (${acme.id})`);
    expect(readState().values.POLAR_ORGANIZATION_ID).toBe(acme.id);
    expect(world.variables.admin).toMatchObject({ POLAR_ORGANIZATION_ID: acme.id, POLAR_API_BASE_URL: "https://sandbox-api.polar.sh", POLAR_ACCESS_TOKEN: polarTokens.admin });
    expect(world.variables.worker).toMatchObject({ POLAR_ORGANIZATION_ID: acme.id, POLAR_API_BASE_URL: "https://sandbox-api.polar.sh", POLAR_ACCESS_TOKEN: polarTokens.worker });
    expect(readFileSync(`${settings()}.vars`, "utf8")).toContain(`POLAR_ORGANIZATION_ID=${acme.id}`);
    // connect's billing works with a key that acts as the operator's account, so up says to sign up first.
    expect(result.out).toContain(`sign up at https://${railwayHost}/en/signup as ops@example.com`);
    expect(world.polarVersions).toEqual([POLAR_API_VERSION]);
  });

  it("takes one Polar token for both the admin and the worker in up", async () => {
    writeSettings();
    railwayAfterUp();
    const state = stateAfterUp();
    delete state.done["polar.tokens"];
    delete state.done.variables;
    for (const key of ["POLAR_ADMIN_TOKEN", "POLAR_WORKER_TOKEN", "POLAR_ORGANIZATION_ID"]) delete state.values[key];
    writeState(state);
    const result = await bootstrap(["up", settings(), "--yes"], { env: { POLAR_ADMIN_TOKEN: polarTokens.worker, POLAR_WORKER_TOKEN: polarTokens.worker } });
    expect(result.code, result.out).toBe(0);
    expect(readState().done["polar.tokens"]).toBeTruthy();
    expect(world.variables.admin.POLAR_ACCESS_TOKEN).toBe(polarTokens.worker);
    expect(world.variables.worker.POLAR_ACCESS_TOKEN).toBe(polarTokens.worker);
  });

  it("refuses a worker token of another organization than POLAR_ORGANIZATION_ID", async () => {
    writeSettings({ POLAR_ORGANIZATION_ID: other.id });
    railwayAfterUp();
    const state = stateAfterUp();
    delete state.done["polar.tokens"];
    delete state.done.variables;
    for (const key of ["POLAR_ADMIN_TOKEN", "POLAR_WORKER_TOKEN", "POLAR_ORGANIZATION_ID"]) delete state.values[key];
    writeState(state);
    const result = await bootstrap(["up", settings(), "--yes"], { env: { POLAR_ADMIN_TOKEN: polarTokens.admin, POLAR_WORKER_TOKEN: polarTokens.worker } });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain(`the worker's Polar token belongs to the sandbox organization Acme (${acme.id}), and POLAR_ORGANIZATION_ID in`);
    expect(readState().done["polar.tokens"]).toBeUndefined();
    expect(world.variables.admin.POLAR_ORGANIZATION_ID).toBeUndefined();
  });

  it("checks in doctor that the worker's and the setup token belong to one organization", async () => {
    writeSettings();
    const tokens = { POLAR_ADMIN_TOKEN: polarTokens.admin, POLAR_WORKER_TOKEN: polarTokens.worker };
    const mixed = await bootstrap(["doctor", settings()], { env: { ...tokens, POLAR_SETUP_TOKEN: polarTokens.other } });
    expect(mixed.code, mixed.out).toBe(1);
    expect(mixed.out).toContain("ok     pnpm 10.99.0 (connect uses it for the platform key and pnpm billing)");
    expect(mixed.out).toContain(`ok     Polar: POLAR_WORKER_TOKEN works (the sandbox organization Acme, ${acme.id}, which up makes POLAR_ORGANIZATION_ID)`);
    expect(mixed.out).toContain(`FIX    Polar: POLAR_SETUP_TOKEN belongs to the sandbox organization Other (${other.id}), not to ${acme.id}`);
    const matching = await bootstrap(["doctor", settings()], { env: tokens });
    expect(matching.code, matching.out).toBe(0);
    expect(matching.out).toContain(`ok     Polar: POLAR_SETUP_TOKEN works (the sandbox organization Acme, ${acme.id})`);
    expect(matching.out).toContain("Nothing to fix.");
  });

  it("says in doctor whether connect sets the plans up with the deployment's own token or asks for a setup token", async () => {
    writeSettings();
    const minimal = await bootstrap(["doctor", settings()], { env: { POLAR_ADMIN_TOKEN: polarTokens.admin, POLAR_WORKER_TOKEN: polarTokens.worker, POLAR_SETUP_TOKEN: "" } });
    expect(minimal.code, minimal.out).toBe(0);
    expect(minimal.out).toContain("note   Polar: the deployment's own tokens can't set plans up (Polar shows them no webhooks), so connect will ask for a setup token with organizations:write, meters:write, products:write, discounts:write and webhooks:write");

    // One token for both, made with the setup scopes too.
    world.webhookTokens.add(polarTokens.worker);
    const one = await bootstrap(["doctor", settings()], { env: { POLAR_ADMIN_TOKEN: polarTokens.worker, POLAR_WORKER_TOKEN: polarTokens.worker, POLAR_SETUP_TOKEN: "" } });
    expect(one.code, one.out).toBe(0);
    expect(one.out).toContain("note   Polar: POLAR_ADMIN_TOKEN and POLAR_WORKER_TOKEN are one token, so the admin holds the worker's scopes too");
    expect(one.out).toContain("ok     Polar: connect sets the plans up with POLAR_WORKER_TOKEN, which Polar shows the webhooks, so it needs no setup token");
    expect(one.out).not.toContain("FIX");
  });

  it("sets Polar billing up in connect: the sign-up, plan, yes, apply, the webhook's secret on the admin, verify", async () => {
    writeSettings();
    railwayAfterUp();
    writeState(stateAfterUp());
    world.ownerInactiveAnswers = 1;
    // Enter once the sign-up is done, then yes to the plan.
    const result = await bootstrap(["connect", settings()], { input: "\nyes\n" });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("/en/signup as ops@example.com, with the 6-digit code from the email");
    expect(result.out).toContain("Polar sells the plans. Delete the setup token now, in Polar's sandbox organization (Settings > Developers).");
    expect(result.out).toContain("Done by the script, Polar billing included.");

    const [webhook] = world.webhooks;
    expect(world.webhooks).toHaveLength(1);
    expect(webhook?.url).toBe(webhookUrl);
    expect(world.running.admin.POLAR_WEBHOOK_SECRET).toBe(webhook?.secret);
    const state = readState();
    for (const id of billingSteps) expect(state.done[id], id).toBeTruthy();
    expect(state.values.POLAR_WEBHOOK_SECRET).toBe(webhook?.secret);

    // pnpm billing ran from the repository, with the operator key the run made and the setup token, and nothing of the person's own.
    const { key } = JSON.parse(readFileSync(String(state.values.PLATFORM_KEY_FILE), "utf8")) as { key: string };
    const runs = billingRuns();
    expect(runs.map((run) => run.command)).toEqual(["billing plan", "billing apply", "billing verify"]);
    for (const run of runs) {
      expect(run.cwd).toBe(repoRoot);
      expect(run.env).toMatchObject({ LOBBYSTACK_URL: `${base}/app`, LOBBYSTACK_API_KEY: key, POLAR_SETUP_TOKEN: polarTokens.setup, POLAR_READ_TOKEN: polarTokens.setup });
      expect(run.configFolder).toBe(true);
      expect(String(run.env?.XDG_CONFIG_HOME).startsWith(join(dir, "tmp", "lobbystack-billing-"))).toBe(true);
      expect(run.args?.slice(0, 6)).toEqual(["--brand", "acme", "--polar", "sandbox", "--webhook-url", webhookUrl]);
    }
    const apply = runs[1];
    expect(apply?.args).toContain("--yes");
    expect(flagOf(apply, "--railway-file")).toBe(join(String(apply?.env?.XDG_CONFIG_HOME), "railway.env"));
    expect(runs[0]?.args).not.toContain("--yes");
    // The private folder, with the file that held the secret, is gone.
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);

    // The setup token and the operator key stay in memory; the log shows no secret.
    expect(stateText()).not.toContain(polarTokens.setup);
    expect(stateText()).not.toContain(key);
    for (const value of [polarTokens.setup, polarTokens.admin, polarTokens.worker, key, String(webhook?.secret), openaiWebhookSecret]) expect(logText()).not.toContain(value);
    expect(world.polarVersions.length).toBeGreaterThan(0);
    expect(world.polarVersions.every((version) => version === POLAR_API_VERSION)).toBe(true);

    expect(result.out).toContain("  1. In Polar's sandbox organization, Settings > Developers, delete the setup token: billing is set up, and nothing else uses it.");

    // A second connect finds it all done, and runs nothing again.
    const again = await bootstrap(["connect", settings()]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("  1. If connect asked for a setup token, delete it in Polar's sandbox organization (Settings > Developers)");
    expect(again.out).toContain("= pnpm billing verify: billing.json, the admin's tables and Polar agree (done");
    expect(billingRuns()).toHaveLength(3);
  });

  it("puts the secret of a webhook an earlier run made on the admin, read from Polar", async () => {
    readyForBilling();
    world.webhooks.push({ id: "webhook-1", url: webhookUrl, secret: `polar_whs_${"9".repeat(48)}`, organization_id: acme.id });
    const result = await bootstrap(["connect", settings()], { input: "yes\n" });
    expect(result.code, result.out).toBe(0);
    expect(billingRuns().find((run) => run.command === "billing apply")?.madeWebhook).toBe(false);
    expect(world.webhooks).toHaveLength(1);
    expect(world.running.admin.POLAR_WEBHOOK_SECRET).toBe(`polar_whs_${"9".repeat(48)}`);
    expect(readState().values.POLAR_WEBHOOK_SECRET).toBe(`polar_whs_${"9".repeat(48)}`);
  });

  it("asks for the operator key when its file is gone, and for a setup token that isn't given, and keeps neither", async () => {
    const operator = readyForBilling({ keyFile: false });
    const result = await bootstrap(["connect", settings()], { input: `${operator.key}\n${polarTokens.setup}\nyes\n`, env: { POLAR_SETUP_TOKEN: "" } });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`${operator.file} isn't here any more, so pnpm billing needs the operator key from the password manager.`);
    expect(result.out).toContain("The deployment's own Polar tokens can't set plans up (Polar shows them no webhooks), as guide 3.7 makes them.");
    expect(result.out).toContain("pnpm billing needs a token with organizations:write, meters:write, products:write, discounts:write and webhooks:write. Make one in Polar's sandbox organization,");
    expect(billingRuns().map((run) => run.env?.LOBBYSTACK_API_KEY)).toEqual([operator.key, operator.key, operator.key]);
    for (const value of [operator.key, polarTokens.setup]) {
      expect(stateText()).not.toContain(value);
      expect(logText()).not.toContain(value);
    }
  });

  it("sets the plans up with the worker's token when Polar lets it, and asks for no setup token", async () => {
    readyForBilling();
    world.webhookTokens.add(polarTokens.worker);
    const result = await bootstrap(["connect", settings()], { input: "yes\n", env: { POLAR_SETUP_TOKEN: "" } });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("pnpm billing uses the worker's Polar token, which Polar lets set plans up, so no setup token is needed");
    expect(result.out).toContain("Polar sells the plans, set up with the worker's Polar token.");
    expect(result.out).not.toContain("needs a token with");
    expect(result.out).not.toContain("Delete the setup token");
    expect(result.out).not.toContain("delete the setup token");
    expect(result.out).toContain("  1. Sign the command line in with the operator key");
    const runs = billingRuns();
    expect(runs.map((run) => run.command)).toEqual(["billing plan", "billing apply", "billing verify"]);
    for (const run of runs) expect(run.env).toMatchObject({ POLAR_SETUP_TOKEN: polarTokens.worker, POLAR_READ_TOKEN: polarTokens.worker });
    const [webhook] = world.webhooks;
    expect(world.webhooks).toHaveLength(1);
    expect(world.running.admin.POLAR_WEBHOOK_SECRET).toBe(webhook?.secret);
    expect(logText()).not.toContain(polarTokens.worker);
  });

  it("asks for a setup token, then plans and applies again, when Polar refuses the worker's token a change", async () => {
    readyForBilling();
    world.webhookTokens.add(polarTokens.worker);
    control({ refuseApply: polarTokens.worker });
    // yes to the plan, the setup token once Polar refused the worker's, then yes to the new plan.
    const result = await bootstrap(["connect", settings()], { input: `yes\n${polarTokens.setup}\nyes\n`, env: { POLAR_SETUP_TOKEN: "" } });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Polar refused the worker's Polar token for that (above).");
    expect(result.out).toContain("pnpm billing needs a token with organizations:write, meters:write, products:write, discounts:write and webhooks:write.");
    expect(result.out).toContain("Polar sells the plans. Delete the setup token now, in Polar's sandbox organization (Settings > Developers).");
    const runs = billingRuns();
    expect(runs.map((run) => run.command)).toEqual(["billing plan", "billing apply", "billing plan", "billing apply", "billing verify"]);
    expect(runs.map((run) => run.env?.POLAR_SETUP_TOKEN)).toEqual([polarTokens.worker, polarTokens.worker, polarTokens.setup, polarTokens.setup, polarTokens.setup]);
    expect(world.webhooks).toHaveLength(1);
    expect(world.running.admin.POLAR_WEBHOOK_SECRET).toBe(world.webhooks[0]?.secret);
    for (const value of [polarTokens.setup, polarTokens.worker]) expect(logText()).not.toContain(value);
    expect(stateText()).not.toContain(polarTokens.setup);
  });

  it("refuses a setup token Polar shows no webhooks, before pnpm billing runs", async () => {
    readyForBilling();
    const result = await bootstrap(["connect", settings()], { input: "yes\n", env: { POLAR_SETUP_TOKEN: polarTokens.admin } });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("Polar shows the setup token no webhooks, so it can't set plans up. Give a token with organizations:write, meters:write, products:write, discounts:write and webhooks:write");
    expect(billingRuns()).toEqual([]);
  });

  it("stops when pnpm billing plan refuses, before any change", async () => {
    readyForBilling();
    control({ planExit: 1 });
    const result = await bootstrap(["connect", settings()], { input: "yes\n" });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("pnpm billing plan refused, so nothing changed (above)");
    expect(billingRuns().map((run) => run.command)).toEqual(["billing plan"]);
    expect(world.webhooks).toEqual([]);
    expect(readState().done["connect.billing.apply"]).toBeUndefined();
  });

  it("applies nothing unless the person types yes", async () => {
    readyForBilling();
    const result = await bootstrap(["connect", settings()], { input: "no\n" });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("you didn't type yes");
    expect(billingRuns().map((run) => run.command)).toEqual(["billing plan"]);
    expect(world.webhooks).toEqual([]);
    expect(readState().done["connect.billing.apply"]).toBeUndefined();
  });

  it("keeps the webhook's secret when Railway refuses it, and finishes the next time without applying again", async () => {
    readyForBilling();
    world.refuse = (service, variables) => service === "admin" && "POLAR_WEBHOOK_SECRET" in variables;
    const first = await bootstrap(["connect", settings()], { input: "yes\n" });
    expect(first.code, first.out).toBe(1);
    expect(first.out).toContain("Stopped at connect.billing.secret");
    const [webhook] = world.webhooks;
    const state = readState();
    expect(state.done["connect.billing.apply"]).toBeTruthy();
    expect(state.done["connect.billing.secret"]).toBeUndefined();
    expect(state.values.POLAR_WEBHOOK_SECRET).toBe(webhook?.secret);
    expect(world.variables.admin.POLAR_WEBHOOK_SECRET).toBeUndefined();

    world.refuse = null;
    // No question this time: the apply is done.
    const second = await bootstrap(["connect", settings()]);
    expect(second.code, second.out).toBe(0);
    expect(billingRuns().map((run) => run.command)).toEqual(["billing plan", "billing apply", "billing verify"]);
    expect(world.running.admin.POLAR_WEBHOOK_SECRET).toBe(webhook?.secret);
  });

  it("keeps the webhook's secret when apply stops after making the webhook, and applies again the next time", async () => {
    readyForBilling();
    control({ applyExit: 2 });
    const first = await bootstrap(["connect", settings()], { input: "yes\n" });
    expect(first.code, first.out).toBe(1);
    expect(first.out).toContain("pnpm billing apply stopped (above)");
    const [webhook] = world.webhooks;
    expect(readState().values.POLAR_WEBHOOK_SECRET).toBe(webhook?.secret);
    expect(readState().done["connect.billing.apply"]).toBeUndefined();

    control({});
    const second = await bootstrap(["connect", settings()], { input: "yes\n" });
    expect(second.code, second.out).toBe(0);
    expect(billingRuns().map((run) => run.command)).toEqual(["billing plan", "billing apply", "billing plan", "billing apply", "billing verify"]);
    expect(world.webhooks).toHaveLength(1);
    expect(world.running.admin.POLAR_WEBHOOK_SECRET).toBe(webhook?.secret);
  });

  it("runs the apply again, after a yes, when verify finds a difference", async () => {
    readyForBilling();
    control({ verifyExit: 1 });
    const first = await bootstrap(["connect", settings()], { input: "yes\n" });
    expect(first.code, first.out).toBe(1);
    expect(first.out).toContain("pnpm billing verify found differences (the DRIFT lines above)");
    const state = readState();
    for (const id of billingSteps) expect(state.done[id], id).toBeUndefined();

    control({});
    const second = await bootstrap(["connect", settings()], { input: "yes\n" });
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("= the admin runs with the webhook's secret already");
    expect(billingRuns().map((run) => run.command)).toEqual(["billing plan", "billing apply", "billing verify", "billing plan", "billing apply", "billing verify"]);
  });

  it("refuses a setup token of another organization, and keeps no token", async () => {
    readyForBilling();
    const result = await bootstrap(["connect", settings()], { input: "yes\n", env: { POLAR_SETUP_TOKEN: polarTokens.other } });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain(`the setup token belongs to Polar's sandbox organization Other (${other.id}), and this deployment sells through ${acme.id}`);
    expect(billingRuns()).toEqual([]);
    expect(stateText()).not.toContain(polarTokens.other);
  });

  it("with --yes, leaves billing open until a run without --yes, once the operator has signed up", async () => {
    readyForBilling();
    world.ownerInactiveAnswers = 1_000;
    const result = await bootstrap(["connect", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("--yes doesn't wait here, so this step stays open");
    expect(result.out).toContain("Still to do by hand");
    expect(result.out).toContain("connect.billing.apply");
    expect(result.out).not.toContain("Done by the script");
    expect(readState().byHand?.["connect.billing.apply"]).toBeTruthy();
    expect(billingRuns()).toEqual([]);
  });

  it("runs the billing steps again in a new Railway project (redo railway.project)", async () => {
    readyForBilling();
    const state = readState();
    for (const id of billingSteps) state.done[id] = earlier;
    writeState(state);
    const result = await bootstrap(["redo", settings(), "railway.project"]);
    expect(result.code, result.out).toBe(0);
    const after = readState();
    for (const id of billingSteps) expect(after.done[id], id).toBeUndefined();
    expect(after.done["connect.webhook"]).toBeTruthy();
  });

  it("names the command line's profile within the 40 characters the command line takes", async () => {
    const host = "reception-for-a-rather-long-brand.example.com";
    readyForBilling();
    writeSettings({ NAME: "", APP_BASE_URL: `https://${host}`, DEPLOYMENT_MODE: "self_hosted_standard" });
    const state = readState();
    Object.assign(state.done, { "railway.custom": earlier, "post.dns": earlier });
    Object.assign(state.values, { APP_HOST: host, POST_DNS_HOST: host, WEBHOOK_URL: `https://${host}/api/webhooks/openai/live` });
    writeState(state);
    const result = await bootstrap(["connect", settings()]);
    expect(result.code, result.out).toBe(0);
    const profile = /--profile ([^\s,]+)/.exec(result.out)?.[1] ?? "";
    // The command line's own rule (packages/cli/src/config.ts).
    const rule = /const PROFILE_NAME = \/(.+)\/;/.exec(readFileSync(join(repoRoot, "packages", "cli", "src", "config.ts"), "utf8"))?.[1];
    expect(rule).toBeTruthy();
    expect(profile).toBe("reception-for-a-rather-long-brand-exampl");
    expect(new RegExp(String(rule)).test(profile)).toBe(true);
  });
});
