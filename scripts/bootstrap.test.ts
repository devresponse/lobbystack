import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { connectionBudget } from "../packages/db/src/pool-budget";
import { POLAR_API_VERSION } from "../packages/shared/src/billing";

// devops/bootstrap.mjs end to end, run as a person runs it: against one local server that stands in for Railway's API,
// Polar's API, PostHog's API and the deployment's admin, with a fake pnpm on PATH for platform-key:create and pnpm billing. Each test
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
// A PostHog personal API key, the organization it reaches, and a project token.
const posthogKey = `phx_${"k".repeat(40)}`;
const posthogOrg = { id: "0f1e2d3c-4b5a-4968-8776-655443322110", name: "Acme Analytics" };
const posthogToken = (id: number) => `phc_project${id}${"t".repeat(32)}`;
const serviceIds = { Postgres: "svc-postgres", Redis: "svc-redis", migrate: "svc-migrate", admin: "svc-admin", worker: "svc-worker" };
// The control panel's services, which a project has only once up has made them (or a test says they're there).
const controlServiceIds = { control: "svc-control", cloudflared: "svc-cloudflared" };
// The Cloudflare zone and account of a deployment with the control panel, the stand-in token, and Zero Trust's team domain.
const cloudflareZone = "example.com";
const cloudflareAccount = "0123456789abcdef0123456789abcdef";
const cloudflareToken = "cloudflare-stand-in-token";
const teamDomain = "acme-team.cloudflareaccess.com";
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
  if (secret && catalog.data.polar.secret_sha256 === sha256(secret)) {
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
type Service = keyof typeof serviceIds | keyof typeof controlServiceIds;
type Deployment = { id: string; status: "DEPLOYING" | "SUCCESS"; polls: number };
type Webhook = { id: string; url: string; secret: string; organization_id: string };
type PostHogProject = { id: number; name: string; api_token: string; is_demo: boolean; ingested_event: boolean; session_recording_opt_in: boolean; recording_domains: string[] };
type Ingress = { hostname?: string; service: string };
type Tunnel = { id: string; name: string; config_src: string; deleted_at: string | null; ingress: Ingress[]; token: string };
type DnsRecord = { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number };
type AccessPolicy = { id: string; name: string; decision: string; include: Array<{ email: { email: string } }>; session_duration?: string | undefined };
type AccessApp = { id: string; aud: string; name: string; domain: string; type: string; session_duration?: string | undefined; app_launcher_visible?: boolean | undefined; policies: Array<{ id: string; precedence?: number }> };
/** Cloudflare as the deployment's token sees it: the zone's DNS records, the account's tunnels and Zero Trust. */
type CloudflareWorld = {
  records: DnsRecord[];
  tunnels: Tunnel[];
  /** Zero Trust's settings, null while it isn't set up for the account. */
  organization: { name: string; auth_domain: string } | null;
  policies: AccessPolicy[];
  apps: AccessApp[];
  identityProviders: Array<{ id: string; name: string; type: string }>;
  /** Paths under the account that the token may not use: they answer 403. */
  forbidden: string[];
  calls: string[];
};
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
  /**
   * PostHog's organization as the personal key sees it: its plan's project limit (undefined for the free plan's 1, null for none), the
   * limit its features show when that differs, and its projects.
   */
  posthog: { limit: number | null | undefined; shownLimit?: number | null; membershipLevel: number; projects: PostHogProject[]; calls: string[] };
  /** The control panel's services that the project has, the image of one made from an image, and each service's settings. */
  made: Set<Service>;
  images: Partial<Record<Service, string>>;
  /** The deployment's own services (Postgres to worker) that the project doesn't have yet, which up then makes. */
  absent: Set<Service>;
  /** The private template RAILWAY_TEMPLATE names, if any, and the layout each deploy of it sent. */
  template: { id: string; code: string; name: string; serializedConfig: TemplateConfig } | null;
  templateDeploys: TemplateConfig[];
  settings: Record<Service, Record<string, unknown>>;
  /** The control service's own addresses on Railway, which it shouldn't have. */
  controlDomains: Array<{ id: string; domain: string; targetPort: number }>;
  cloudflare: CloudflareWorld;
};

/** A private template's layout, as Railway's serializedConfig holds it: only what bootstrap.mjs reads. */
type TemplateConfig = {
  services: Record<string, { name: string; source?: { image?: string; repo?: string }; variables?: Record<string, { value?: string; defaultValue?: string; isOptional?: boolean }> }>;
};

const allServiceIds: Record<Service, string> = { ...serviceIds, ...controlServiceIds };
const services = Object.keys(allServiceIds) as Service[];
const serviceOf = (id: unknown) => services.find((name) => allServiceIds[name] === id);
const isControlService = (service: Service): service is keyof typeof controlServiceIds => service in controlServiceIds;

function freshWorld(): World {
  const each = <T>(make: (service: Service) => T) => Object.fromEntries(services.map((service) => [service, make(service)])) as Record<Service, T>;
  return {
    variables: each(() => ({})),
    running: each(() => ({})),
    // The control panel's services start with no deployment.
    deployments: each((service) => (isControlService(service) ? [] : [{ id: `${service}-deployment-1`, status: "SUCCESS", polls: 0 }])),
    refuse: null,
    organizations: new Map([[polarTokens.admin, acme], [polarTokens.worker, acme], [polarTokens.setup, acme], [polarTokens.other, other]]),
    webhookTokens: new Set([polarTokens.setup, polarTokens.other]),
    webhooks: [],
    ownerInactiveAnswers: 0,
    polarVersions: [],
    posthog: { limit: 6, membershipLevel: 15, projects: [], calls: [] },
    made: new Set(),
    images: {},
    absent: new Set(),
    template: null,
    templateDeploys: [],
    settings: each(() => ({})),
    controlDomains: [],
    cloudflare: { records: [], tunnels: [], organization: { name: "Acme", auth_domain: teamDomain }, policies: [], apps: [],
      identityProviders: [{ id: "idp-otp", name: "One-time PIN", type: "onetimepin" }], forbidden: [], calls: [] },
  };
}

let world = freshWorld();

function deploy(service: Service) {
  const list = world.deployments[service];
  list.unshift({ id: `${service}-deployment-${list.length + 1}`, status: "DEPLOYING", polls: 0 });
}

type GraphQL = {
  query?: string;
  variables?: {
    id?: string; serviceId?: string; code?: string;
    input?: { serviceId?: string; variables?: Vars; skipDeploys?: boolean; name?: string; source?: { image?: string }; serializedConfig?: TemplateConfig } & Record<string, unknown>;
  };
};

function railwayAnswer(body: GraphQL | null): unknown {
  const operation = /^(?:query|mutation) (\w+)/.exec(body?.query ?? "")?.[1];
  const variables = body?.variables ?? {};
  if (operation === "project") {
    return { data: { project: { id: "proj-1", name: "acme-test", deletedAt: null,
      services: { edges: services.filter((name) => (isControlService(name) ? world.made.has(name) : !world.absent.has(name))).map((name) => ({ node: { id: allServiceIds[name], name } })) },
      environments: { edges: [{ node: { id: "env-1", name: "test" } }] },
      volumes: { edges: [] },
      buckets: { edges: [{ node: { id: "bucket-1", name: "Bucket" } }] } } } };
  }
  if (operation === "domains") {
    const serviceDomains = variables.serviceId === controlServiceIds.control ? world.controlDomains : [{ id: "domain-1", domain: railwayHost, targetPort: 3000 }];
    return { data: { domains: { serviceDomains, customDomains: [] } } };
  }
  if (operation === "workspace") return { data: { workspace: { name: "Acme's workspace" } } };
  if (operation === "serviceCreate") {
    const name = variables.input?.name as Service | undefined;
    const missing = name !== undefined && (isControlService(name) ? !world.made.has(name) : world.absent.has(name));
    if (!name || !missing) return { errors: [{ message: `the stand-in doesn't make a service named ${name ?? "?"}` }] };
    if (isControlService(name)) world.made.add(name);
    else world.absent.delete(name);
    if (variables.input?.source?.image) world.images[name] = variables.input.source.image;
    return { data: { serviceCreate: { id: allServiceIds[name], name } } };
  }
  // A private template: deploying it makes the services it lists, each image service from its image.
  if (operation === "template") return { data: { template: world.template?.code === variables.code ? world.template : null } };
  if (operation === "templateDeployV2") {
    const config = variables.input?.serializedConfig;
    if (!config) return { errors: [{ message: "a template deploy needs its layout" }] };
    world.templateDeploys.push(structuredClone(config));
    for (const service of Object.values(config.services)) {
      const name = service.name as Service;
      if (!world.absent.delete(name)) continue;
      if (service.source?.image) world.images[name] = service.source.image;
    }
    return { data: { templateDeployV2: { projectId: "proj-1", workflowId: "workflow-1" } } };
  }
  if (operation === "workflowStatus") return { data: { workflowStatus: { status: "Complete", error: null } } };
  const service = serviceOf(variables.serviceId ?? variables.input?.serviceId ?? variables.id);
  if (!service) return { errors: [{ message: `the stand-in has no ${operation ?? "such call"} for that service` }] };
  if (operation === "variables") return { data: { variables: { ...world.variables[service] } } };
  if (operation === "serviceInstance") return { data: { serviceInstance: { id: `${service}-instance` } } };
  if (operation === "serviceConnect") {
    deploy(service);
    return { data: { serviceConnect: { id: allServiceIds[service] } } };
  }
  if (operation === "variableCollectionUpsert") {
    const values = variables.input?.variables ?? {};
    if (world.refuse?.(service, values)) return { errors: [{ message: "Problem processing request" }] };
    Object.assign(world.variables[service], values);
    if (!variables.input?.skipDeploys) deploy(service);
    return { data: { variableCollectionUpsert: true } };
  }
  if (operation === "serviceInstanceUpdate") {
    Object.assign(world.settings[service], variables.input);
    return { data: { serviceInstanceUpdate: true } };
  }
  if (operation === "serviceInstanceRedeploy") {
    deploy(service);
    return { data: { serviceInstanceRedeploy: true } };
  }
  // Deploys an image service, such as Postgres in deploy.databases, and answers with the new deployment's ID.
  if (operation === "serviceInstanceDeployV2") {
    deploy(service);
    return { data: { serviceInstanceDeployV2: world.deployments[service][0]?.id } };
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

type PostHogBody = { name?: string; session_recording_opt_in?: boolean; recording_domains?: string[] } | null;

/** PostHog's API as the personal key sees it: one organization, its projects, and the plan's and the user's limits on making one. */
function posthogAnswer(method: string, url: URL, token: string, body: PostHogBody): [number, unknown] {
  const path = url.pathname.slice("/posthog".length);
  world.posthog.calls.push(`${method} ${path}`);
  if (token !== posthogKey) return [401, { type: "authentication_error", code: "authentication_failed", detail: "Invalid personal API key.", attr: null }];
  const { projects } = world.posthog;
  const shown = world.posthog.shownLimit !== undefined ? world.posthog.shownLimit : world.posthog.limit;
  const features = shown === undefined ? [] : [{ key: "organizations_projects", name: "Projects", limit: shown }];
  if (method === "GET" && path === "/api/organizations/") {
    return [200, { count: 1, next: null, previous: null, results: [{ ...posthogOrg, membership_level: world.posthog.membershipLevel, members_can_create_projects: false, available_product_features: features }] }];
  }
  const base = `/api/organizations/${posthogOrg.id}/projects/`;
  if (path === base && method === "GET") {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const results = projects.slice(offset, offset + limit).map(({ id, name, api_token, is_demo, ingested_event }) => ({ id, name, api_token, is_demo, ingested_event, organization: posthogOrg.id }));
    return [200, { count: projects.length, next: offset + limit < projects.length ? `https://us.posthog.com${base}?limit=${limit}&offset=${offset + limit}` : null, previous: null, results }];
  }
  if (path === base && method === "POST") {
    const limit = world.posthog.limit === undefined ? 1 : world.posthog.limit;
    if (world.posthog.membershipLevel < 8) return [403, { type: "authentication_error", code: "permission_denied", detail: "You need to be an organization admin or above to create new projects.", attr: null }];
    if (limit !== null && projects.filter((project) => !project.is_demo).length >= limit) {
      return [403, { type: "authentication_error", code: "permission_denied", detail: "You have reached the maximum limit of allowed projects for your current plan. Upgrade your plan to be able to create and manage more projects.", attr: null }];
    }
    const name = String(body?.name ?? "").trim();
    if (projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) return [409, { type: "invalid_request", code: "conflict", detail: `There is already a project called "${name}" in this organization. Choose a different name.`, attr: null }];
    const id = 100 + projects.length;
    const project = { id, name, api_token: posthogToken(id), is_demo: false, ingested_event: false, session_recording_opt_in: body?.session_recording_opt_in === true, recording_domains: [] };
    projects.push(project);
    return [201, { ...project, api_host: "https://us.i.posthog.com", organization: posthogOrg.id }];
  }
  const project = projects.find((item) => path === `${base}${item.id}/`);
  if (project && method === "GET") return [200, { ...project }];
  if (project && method === "PATCH") {
    if (body?.name !== undefined) {
      const name = String(body.name).trim();
      if (projects.some((other) => other !== project && other.name.toLowerCase() === name.toLowerCase())) return [409, { type: "invalid_request", code: "conflict", detail: `There is already a project called "${name}" in this organization. Choose a different name.`, attr: null }];
      project.name = name;
    }
    if (body?.session_recording_opt_in !== undefined) project.session_recording_opt_in = body.session_recording_opt_in;
    if (body?.recording_domains !== undefined) project.recording_domains = body.recording_domains;
    return [200, { ...project }];
  }
  return [404, { type: "invalid_request", code: "not_found", detail: "Not found.", attr: null }];
}

type CloudflareBody = Record<string, unknown> | null;

/**
 * Cloudflare's API as the token sees it: the zone's DNS records, and in the account the tunnels, Zero Trust's settings,
 * Access's reusable policies and applications, and its login methods. Answers wear Cloudflare's envelope.
 */
function cloudflareAnswer(method: string, url: URL, token: string, body: CloudflareBody): [number, unknown] {
  const cf = world.cloudflare;
  const path = url.pathname.slice("/cloudflare".length);
  cf.calls.push(`${method} ${path}`);
  const ok = (result: unknown): [number, unknown] => [200, { success: true, errors: [], messages: [], result }];
  const refuse = (status: number, code: number, message: string): [number, unknown] => [status, { success: false, errors: [{ code, message }], messages: [], result: null }];
  if (token !== cloudflareToken) return refuse(401, 10000, "Authentication error");
  const query = url.searchParams;
  if (method === "GET" && path === "/zones") return ok(query.get("name") === cloudflareZone ? [{ id: "zone-1", name: cloudflareZone }] : []);
  const record = /^\/zones\/zone-1\/dns_records(?:\/([\w-]+))?$/.exec(path);
  if (record) {
    const found = record[1] ? cf.records.find((item) => item.id === record[1]) : undefined;
    if (record[1] && !found) return refuse(404, 81044, "Record does not exist.");
    if (method === "GET") return ok(cf.records.filter((item) => (!query.get("type") || item.type === query.get("type")) && (!query.get("name") || item.name === query.get("name"))));
    if (method === "POST") {
      const made = { id: `record-${cf.records.length + 1}`, type: String(body?.type), name: String(body?.name), content: String(body?.content), proxied: body?.proxied === true, ttl: Number(body?.ttl ?? 1) };
      cf.records.push(made);
      return ok(made);
    }
    if (method === "PATCH" && found) return ok(Object.assign(found, body));
    if (method === "DELETE" && found) {
      cf.records.splice(cf.records.indexOf(found), 1);
      return ok({ id: found.id });
    }
  }
  const prefix = `/accounts/${cloudflareAccount}`;
  if (!path.startsWith(prefix)) return refuse(404, 7003, "Could not route to the path");
  const rest = path.slice(prefix.length);
  if (cf.forbidden.some((denied) => rest.startsWith(denied))) return refuse(403, 10000, "Authentication error");
  const tunnelPath = /^\/cfd_tunnel(?:\/([\w-]+)(?:\/(configurations|token))?)?$/.exec(rest);
  if (tunnelPath) {
    const [, id, part] = tunnelPath;
    if (!id && method === "GET") {
      const name = query.get("name");
      return ok(cf.tunnels.filter((item) => (!name || item.name === name) && (query.get("is_deleted") !== "false" || !item.deleted_at)));
    }
    if (!id && method === "POST") {
      const made = { id: randomUUID(), name: String(body?.name), config_src: String(body?.config_src ?? "local"), deleted_at: null, ingress: [], token: `eyJ${randomBytes(48).toString("base64url")}` };
      cf.tunnels.push(made);
      return ok({ id: made.id, name: made.name, config_src: made.config_src, deleted_at: null, status: "inactive" });
    }
    const tunnel = cf.tunnels.find((item) => item.id === id);
    if (!tunnel) return refuse(404, 1003, "Tunnel not found");
    if (!part && method === "GET") return ok({ id: tunnel.id, name: tunnel.name, config_src: tunnel.config_src, deleted_at: tunnel.deleted_at });
    if (part === "token" && method === "GET") return ok(tunnel.token);
    if (part === "configurations" && method === "GET") return ok({ tunnel_id: tunnel.id, version: 0, config: tunnel.ingress.length ? { ingress: tunnel.ingress } : null });
    if (part === "configurations" && method === "PUT") {
      tunnel.ingress = ((body?.config as { ingress?: Ingress[] } | undefined)?.ingress ?? []);
      return ok({ tunnel_id: tunnel.id, version: 1, config: { ingress: tunnel.ingress } });
    }
  }
  if (rest === "/access/organizations" && method === "GET") return cf.organization ? ok(cf.organization) : refuse(404, 12106, "access.api.error.organization_not_found");
  if (rest === "/access/identity_providers" && method === "GET") return ok(cf.identityProviders);
  const policyPath = /^\/access\/policies(?:\/([\w-]+))?$/.exec(rest);
  if (policyPath) {
    const [, id] = policyPath;
    const policy = cf.policies.find((item) => item.id === id);
    const fields = { name: String(body?.name), decision: String(body?.decision), include: (body?.include ?? []) as AccessPolicy["include"], session_duration: body?.session_duration as string | undefined };
    if (!id && method === "GET") return ok(cf.policies);
    if (!id && method === "POST") {
      const made = { id: randomUUID(), ...fields };
      cf.policies.push(made);
      return ok(made);
    }
    if (!policy) return refuse(404, 12130, "access.api.error.not_found");
    if (method === "GET") return ok(policy);
    if (method === "PUT") return ok(Object.assign(policy, fields));
  }
  const appPath = /^\/access\/apps(?:\/([\w-]+))?$/.exec(rest);
  if (appPath) {
    const [, id] = appPath;
    const app = cf.apps.find((item) => item.id === id);
    const fields = { name: String(body?.name), domain: String(body?.domain), type: String(body?.type), session_duration: body?.session_duration as string | undefined,
      app_launcher_visible: body?.app_launcher_visible as boolean | undefined, policies: (body?.policies ?? []) as AccessApp["policies"] };
    if (!id && method === "GET") return ok(cf.apps.filter((item) => !query.get("domain") || item.domain === query.get("domain")));
    // One application for an address.
    const taken = (domain: string) => cf.apps.some((item) => item !== app && item.domain === domain);
    if (!id && method === "POST") {
      if (taken(fields.domain)) return refuse(400, 12130, "access.api.error.conflict: an application for this domain already exists");
      const made = { id: randomUUID(), aud: randomBytes(32).toString("hex"), ...fields };
      cf.apps.push(made);
      return ok(made);
    }
    if (!app) return refuse(404, 12130, "access.api.error.not_found");
    if (method === "GET") return ok(app);
    if (method === "PUT") {
      if (taken(fields.domain)) return refuse(400, 12130, "access.api.error.conflict: an application for this domain already exists");
      return ok(Object.assign(app, fields));
    }
  }
  return refuse(404, 7003, `the stand-in has no ${method} ${path}`);
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
    // Inside the data envelope every /api/v1 answer of the admin has (apps/admin/src/lib/public-api/http.ts).
    return [200, { data: { brand: "acme", polar: { env: "sandbox", org: running.POLAR_ORGANIZATION_ID ?? null, secret_sha256: secret ? sha256(secret) : null } } }];
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
  } else if (url.pathname.startsWith("/posthog/")) answer = posthogAnswer(request.method ?? "GET", url, token, body as PostHogBody);
  else if (url.pathname.startsWith("/cloudflare/")) answer = cloudflareAnswer(request.method ?? "GET", url, token, body as CloudflareBody);
  else if (url.pathname === "/control/") {
    // The control panel's address: Cloudflare Access's sign-in once an application covers it, else the panel itself.
    const covered = world.cloudflare.apps.some((app) => app.domain === world.cloudflare.records.find((item) => item.type === "CNAME" && item.proxied)?.name);
    response.writeHead(covered ? 302 : 200, covered ? { location: `https://${teamDomain}/cdn-cgi/access/login/panel?kid=x` } : { "content-type": "text/html" });
    response.end(covered ? "" : "<html>the panel</html>");
    return;
  }
  else if (url.pathname === "/app/login") {
    // A page request that carries nothing: the access gate's 404 once the admin's live deployment has PROTECTION_TOKEN
    // (apps/admin/src/lib/access-gate.ts), else the sign-in page's redirect to its language.
    const closed = Boolean(world.running.admin.PROTECTION_TOKEN);
    response.writeHead(closed ? 404 : 308, closed ? { "content-type": "text/plain; charset=utf-8" } : { location: "/en/login" });
    response.end(closed ? "Not found" : "");
    return;
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

/** A settings file, PostHog off unless a test turns it on; a change to undefined leaves that line out. */
function writeSettings(changes: Record<string, string | undefined> = {}, secrets: Record<string, string> = {}) {
  const values = { NAME: "acme-test", BRAND: "acme", ENVIRONMENT: "test", REPO: "acme/lobbystack", BRANCH: "main", DEPLOYMENT_MODE: "cloud",
    OPERATOR_EMAIL: "ops@example.com", EMAIL_FROM: "hello@mail.example.com", RAILWAY_WORKSPACE_ID: "ws-1", BILLING_PROVIDER: "polar", POLAR: "sandbox",
    POLAR_ORGANIZATION_ID: "", STEP_GITHUB: "no", STEP_OPENAI: "no", STEP_TWILIO: "no", STEP_RESEND: "no", STEP_TURNSTILE: "no", POSTHOG: "no", ...changes };
  writeFileSync(settings(), `${Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  const lines = Object.entries({ OPENAI_WEBHOOK_SECRET: openaiWebhookSecret, ...secrets }).map(([key, value]) => `${key}=${value}`);
  writeFileSync(`${settings()}.secrets`, `${lines.join("\n")}\n`, { mode: 0o600 });
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
        BOOTSTRAP_POSTHOG_URL: `${base}/posthog`,
        BOOTSTRAP_APP_URL: `${base}/app`,
        BOOTSTRAP_CLOUDFLARE_URL: `${base}/cloudflare`,
        BOOTSTRAP_CONTROL_URL: `${base}/control/`,
        CLOUDFLARE_API_TOKEN: cloudflareToken,
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

  /** Railway and the state file as up leaves them, but with the variables to set again (and the admin's first deploy still to come, when `firstBuild`). */
  function readyForPostHog({ firstBuild = false }: { firstBuild?: boolean } = {}) {
    railwayAfterUp();
    const state = stateAfterUp();
    delete state.done.variables;
    if (firstBuild) delete state.done["deploy.admin"];
    writeState(state);
  }

  const posthogProject = (id: number, name: string, changes: Partial<PostHogProject> = {}): PostHogProject =>
    ({ id, name, api_token: posthogToken(id), is_demo: false, ingested_event: false, session_recording_opt_in: false, recording_domains: [], ...changes });

  it("makes a PostHog project in up by default, and puts its values on the services before the admin's first build", async () => {
    // A settings file with no POSTHOG line, as one from before the PostHog step has.
    writeSettings({ POSTHOG: undefined }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    readyForPostHog({ firstBuild: true });
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(world.posthog.projects).toEqual([posthogProject(100, "acme-test", { session_recording_opt_in: true, recording_domains: [`https://${railwayHost}`] })]);
    const token = posthogToken(100);
    const logs = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://us.i.posthog.com/i", OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}` };
    expect(world.variables.admin).toMatchObject({ NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com", ...logs });
    expect(world.variables.worker).toMatchObject({ POSTHOG_API_KEY: "${{admin.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN}}", POSTHOG_HOST: "https://us.i.posthog.com", ...logs });
    expect(world.variables.migrate).toMatchObject(logs);
    // The admin's variables went in before its first deploy, which then built it with them.
    expect(world.deployments.admin[0]?.id).toBe("admin-deployment-2");
    const state = readState();
    for (const id of ["posthog.project", "variables", "deploy.admin", "post.posthog"]) expect(state.done[id], id).toBeTruthy();
    expect(state.values).toMatchObject({ POSTHOG_PROJECT_ID: 100, POSTHOG_PROJECT_NAME: "acme-test", POSTHOG_PROJECT_TOKEN: token, POSTHOG_HOST: "https://us.i.posthog.com", POSTHOG_ORGANIZATION_ID: posthogOrg.id });
    expect(readFileSync(`${settings()}.vars`, "utf8")).toContain(`[migrate, admin, worker]\nOTEL_EXPORTER_OTLP_ENDPOINT=https://us.i.posthog.com/i\nOTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${token}`);
    // The personal key is used, never kept or logged.
    expect(stateText()).not.toContain(posthogKey);
    expect(logText()).not.toContain(posthogKey);

    const again = await bootstrap(["up", settings(), "--yes"]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain('= PostHog project "acme-test" in PostHog\'s US cloud, with screen recordings on (done');
    expect(world.posthog.projects).toHaveLength(1);
  });

  it("leaves PostHog out of a deployment made before the PostHog step until its settings file asks, then runs the variables again", async () => {
    writeSettings({ POSTHOG: undefined }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    railwayAfterUp();
    writeState(stateAfterUp());
    const before = await bootstrap(["up", settings(), "--yes"]);
    expect(before.code, before.out).toBe(0);
    expect(before.out).toContain("not added: this deployment was set up before bootstrap made PostHog projects");
    expect(world.posthog.calls).toEqual([]);
    expect(world.variables.admin.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN).toBeUndefined();
    expect(readState().done["posthog.project"]).toBeUndefined();
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.out).toContain("note   PostHog: not added, since up deployed this before bootstrap made PostHog projects");

    writeSettings({ POSTHOG: "eu" }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    const added = await bootstrap(["up", settings(), "--yes"]);
    expect(added.code, added.out).toBe(0);
    expect(added.out).toContain("The variables are done already, so they run again below, to bring the PostHog values to the services.");
    const token = posthogToken(100);
    expect(world.variables.admin).toMatchObject({ NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: token, NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com", OTEL_EXPORTER_OTLP_ENDPOINT: "https://eu.i.posthog.com/i" });
    expect(world.variables.worker.POSTHOG_API_KEY).toBe("${{admin.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN}}");
    // Each deployed service with new values deploys again; the databases' values stay as they were.
    for (const service of ["migrate", "admin", "worker"] as const) expect(world.deployments[service][0]?.status, service).toBe("DEPLOYING");
    expect(world.deployments.Postgres).toHaveLength(1);
    expect(readState().done.variables).toBeTruthy();
  });

  it("stops with the ways out when PostHog's plan allows no more projects and the one there has events, and doctor says so first", async () => {
    // The free plan: one project, which the organization has, and which another app sends to.
    world.posthog.limit = undefined;
    world.posthog.projects.push(posthogProject(7, "Another app", { ingested_event: true }));
    writeSettings({ POSTHOG: "us" }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.code, doctor.out).toBe(1);
    expect(doctor.out).toContain(`ok     PostHog: POSTHOG_PERSONAL_API_KEY works (the organization Acme Analytics, ${posthogOrg.id})`);
    expect(doctor.out).toContain('FIX    PostHog: up can\'t make "acme-test": the organization Acme Analytics has 1 project, as many as its plan allows (1), and it has received events, so up won\'t take it over. Rename the project this deployment should use to "acme-test" in PostHog');

    readyForPostHog();
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("Stopped at posthog.project: PostHog won't make another project in the organization Acme Analytics, which has 1 and whose plan allows 1");
    expect(result.out).toContain('and it has received events, so up won\'t take it over. Either rename the project this deployment should use to "acme-test" in PostHog, which up then reuses');
    expect(result.out).toContain("move the organization to pay-as-you-go in PostHog's billing settings");
    expect(result.out).toContain("as POSTHOG_PROJECT_TOKEN, which this deployment then shares, or set POSTHOG=no in");
    expect(result.out).not.toContain("What to try");
    expect(readState().done["posthog.project"]).toBeUndefined();
    expect(world.posthog.projects).toEqual([posthogProject(7, "Another app", { ingested_event: true })]);
    expect(world.posthog.calls.filter((call) => call.startsWith("PATCH"))).toEqual([]);
  });

  it("takes over a full organization's only project that has never received an event, renames it, and doctor says so first", async () => {
    // The free plan, with the project PostHog makes with a new organization, and a demo project, which doesn't count.
    world.posthog.limit = undefined;
    world.posthog.projects.push(posthogProject(7, "Default project"), posthogProject(8, "Hedgebox", { is_demo: true }));
    writeSettings({ POSTHOG: "us" }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.out).toContain('ok     PostHog: the organization Acme Analytics has 1 project, as many as its plan allows (1), so up will take over "Default project" (7), which has never received an event, and rename it "acme-test"');
    expect(doctor.out).not.toContain("FIX    PostHog");

    readyForPostHog();
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('~ took over the project 7 ("Default project"), which has never received an event, since the plan of Acme Analytics allows no more projects, and renamed it "acme-test", with screen recordings on');
    // Nothing was made: the plan's limit was known before asking.
    expect(world.posthog.calls).not.toContain(`POST /api/organizations/${posthogOrg.id}/projects/`);
    expect(world.posthog.projects).toEqual([
      posthogProject(7, "acme-test", { session_recording_opt_in: true, recording_domains: [`https://${railwayHost}`] }),
      posthogProject(8, "Hedgebox", { is_demo: true }),
    ]);
    expect(world.variables.admin.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN).toBe(posthogToken(7));
    expect(readState().values).toMatchObject({ POSTHOG_PROJECT_ID: 7, POSTHOG_PROJECT_NAME: "acme-test", POSTHOG_PROJECT_TOKEN: posthogToken(7) });

    // Once events come in, the project is this deployment's by its ID: the next run takes nothing over.
    const taken = world.posthog.projects.find((item) => item.id === 7);
    if (taken) taken.ingested_event = true;
    const again = await bootstrap(["up", settings(), "--yes"]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain('= PostHog project "acme-test" in PostHog\'s US cloud, with screen recordings on (done');
    const redo = await bootstrap(["redo", settings(), "posthog.project"]);
    expect(redo.code, redo.out).toBe(0);
    const rerun = await bootstrap(["up", settings(), "--yes"]);
    expect(rerun.code, rerun.out).toBe(0);
    expect(rerun.out).toContain('= 7 ("acme-test")');
    expect(rerun.out).not.toContain("took over");
  });

  it("takes over the unused project when PostHog refuses another one that the plan's features didn't count, and leaves recordings off when asked", async () => {
    // The features show no limit, but PostHog counts one when asked to make a project.
    world.posthog.limit = 1;
    world.posthog.shownLimit = null;
    world.posthog.projects.push(posthogProject(7, "Default project"));
    writeSettings({ POSTHOG: "us", POSTHOG_RECORDINGS: "no" }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.out).toContain('ok     PostHog: up will make the project "acme-test" (the organization has 1)');

    readyForPostHog();
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(world.posthog.calls).toContain(`POST /api/organizations/${posthogOrg.id}/projects/`);
    expect(result.out).toContain('~ took over the project 7 ("Default project"), which has never received an event, since the plan of Acme Analytics allows no more projects, and renamed it "acme-test"\n');
    expect(world.posthog.projects).toEqual([posthogProject(7, "acme-test")]);
    expect(readState().values).toMatchObject({ POSTHOG_PROJECT_ID: 7, POSTHOG_PROJECT_NAME: "acme-test" });
  });

  it("won't choose between a full organization's projects when several have never received an event", async () => {
    world.posthog.limit = 2;
    world.posthog.projects.push(posthogProject(7, "Default project"), posthogProject(8, "Staging"));
    writeSettings({ POSTHOG: "us" }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.code, doctor.out).toBe(1);
    expect(doctor.out).toContain('FIX    PostHog: up can\'t make "acme-test": the organization Acme Analytics has 2 projects, as many as its plan allows (2), and 2 of them have never received an event, so up won\'t choose one.');

    readyForPostHog();
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("which has 2 and whose plan allows 2");
    expect(result.out).toContain("and 2 of them have never received an event, so up won't choose one. Either rename the project this deployment should use");
    expect(world.posthog.projects).toEqual([posthogProject(7, "Default project"), posthogProject(8, "Staging")]);
  });

  it("says how to make a personal API key, and stops, when none is given", async () => {
    writeSettings({ POSTHOG: "eu" });
    readyForPostHog();
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("At https://eu.posthog.com/settings/user-api-keys, Create personal API key");
    expect(result.out).toContain("Stopped at posthog.project: no PostHog personal API key (phx_...) given.");
    expect(world.posthog.calls).toEqual([]);
  });

  it("uses a project token from the secrets file as it is, with no personal key and no call to PostHog", async () => {
    writeSettings({ POSTHOG: "us" }, { POSTHOG_PROJECT_TOKEN: posthogToken(42) });
    readyForPostHog();
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("PostHog project from the secrets file");
    expect(world.posthog.calls).toEqual([]);
    expect(world.variables.admin).toMatchObject({ NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: posthogToken(42), NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com" });
    expect(readState().done["post.posthog"]).toBeUndefined();

    // A railway-vars.mjs file given as the secrets file names the project with the admin's own variable.
    writeFileSync(`${settings()}.secrets`, `[admin]\nNEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=${posthogToken(43)}\n`, { mode: 0o600 });
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.out).toContain("ok     PostHog: POSTHOG_PROJECT_TOKEN in the secrets file names the project, so no personal API key is needed");
    expect(world.posthog.calls).toEqual([]);
  });

  it("reuses the project with the deployment's name, turns its screen recordings on, and keeps its recording addresses", async () => {
    world.posthog.projects.push(posthogProject(9, "ACME-TEST", { recording_domains: ["https://old.example.com"] }));
    writeSettings({ POSTHOG: "us" }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    readyForPostHog();
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("~ screen recordings turned on");
    expect(world.posthog.projects).toEqual([posthogProject(9, "ACME-TEST", { session_recording_opt_in: true, recording_domains: ["https://old.example.com", `https://${railwayHost}`] })]);
    expect(world.variables.admin.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN).toBe(posthogToken(9));
  });

  it("keeps the PostHog token the admin has already, with its address, and finds its project", async () => {
    world.posthog.projects.push(posthogProject(5, "Hand made", { session_recording_opt_in: true }));
    writeSettings({ POSTHOG: "us" }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    readyForPostHog();
    Object.assign(world.variables.admin, { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: posthogToken(5), NEXT_PUBLIC_POSTHOG_HOST: "https://e.example.com" });
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.out).toContain('ok     PostHog: the project "Hand made" (5), whose token the admin has, exists and will be reused');
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('= the admin\'s, 5 ("Hand made")');
    expect(world.posthog.projects).toHaveLength(1);
    // The dashboard's events keep their address; logs go to PostHog's own.
    expect(world.variables.admin).toMatchObject({ NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: posthogToken(5), NEXT_PUBLIC_POSTHOG_HOST: "https://e.example.com", OTEL_EXPORTER_OTLP_ENDPOINT: "https://us.i.posthog.com/i" });
    expect(world.variables.worker.POSTHOG_HOST).toBe("https://us.i.posthog.com");
    expect(readState().values).toMatchObject({ POSTHOG_PROJECT_ID: 5, POSTHOG_PROJECT_NAME: "Hand made" });
  });

  it("keeps a token of a project outside the organization as it is, and leaves that project's settings alone", async () => {
    const elsewhere = `phc_elsewhere${"x".repeat(32)}`;
    // An EU organization, while the admin's token, with no address beside it, goes to PostHog's US address.
    writeSettings({ POSTHOG: "eu" }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    readyForPostHog();
    world.variables.admin.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = elsewhere;
    // With no room for another project, doctor still says up needs none.
    world.posthog.limit = undefined;
    world.posthog.projects.push(posthogProject(7, "Another app"));
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.out).toContain("note   PostHog: the admin has a token whose project isn't in the organization Acme Analytics, so up keeps it as it is");
    expect(doctor.out).not.toContain("FIX    PostHog");
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("kept as it is: its project isn't in the organization Acme Analytics");
    expect(result.out).toContain("isn't one the script found in your organization, so its settings stay as they are");
    expect(world.posthog.projects).toEqual([posthogProject(7, "Another app")]);
    expect(world.variables.admin).toMatchObject({ NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: elsewhere, NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com", OTEL_EXPORTER_OTLP_ENDPOINT: "https://us.i.posthog.com/i" });
    expect(world.variables.worker.POSTHOG_HOST).toBe("https://us.i.posthog.com");
    expect(readState().values.POSTHOG_PROJECT_KEPT).toBe(true);
    const status = await bootstrap(["status", settings()]);
    expect(status.out).toContain("PostHog project kept from the admin's variables");
  });

  it("makes the project without screen recordings or logs when the settings say no, and sends the dashboard's events through POSTHOG_PROXY", async () => {
    writeSettings({ POSTHOG: "us", POSTHOG_RECORDINGS: "no", POSTHOG_LOGS: "no", POSTHOG_PROXY: "https://e.example.com/" }, { POSTHOG_PERSONAL_API_KEY: posthogKey });
    readyForPostHog();
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(world.posthog.projects).toEqual([posthogProject(100, "acme-test")]);
    expect(world.variables.admin).toMatchObject({ NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: posthogToken(100), NEXT_PUBLIC_POSTHOG_HOST: "https://e.example.com" });
    expect(world.variables.worker.POSTHOG_HOST).toBe("https://us.i.posthog.com");
    for (const service of ["migrate", "admin", "worker"] as const) expect(world.variables[service].OTEL_EXPORTER_OTLP_ENDPOINT, service).toBeUndefined();
    expect(readState().done["post.posthog"]).toBeUndefined();
  });

  it("checks the PostHog settings, and redo posthog.project runs the variables and the recording addresses again", async () => {
    writeSettings({ POSTHOG: "maybe" });
    const wrong = await bootstrap(["status", settings()]);
    expect(wrong.code, wrong.out).toBe(1);
    expect(wrong.out).toContain("POSTHOG is us, eu, a self-hosted PostHog's https:// address with no path, or no");

    writeSettings({ POSTHOG: "https://posthog.example.com/" });
    railwayAfterUp();
    const state = stateAfterUp();
    Object.assign(state.done, { "posthog.project": earlier, "post.posthog": earlier });
    writeState(state);
    const redo = await bootstrap(["redo", settings(), "posthog.project"]);
    expect(redo.code, redo.out).toBe(0);
    const after = readState();
    for (const id of ["posthog.project", "variables", "post.posthog"]) expect(after.done[id], id).toBeUndefined();
  });

  // Room for two or more copies of the admin and the worker (guide 7.24, the 2026-11-13 replicas review).
  const adminPools = { LOBBYSTACK_APP_POOL_MAX: "6", LOBBYSTACK_AUTH_POOL_MAX: "2", LOBBYSTACK_WORKER_POOL_MAX: "12", LOBBYSTACK_DISPATCHER_POOL_MAX: "2", LOBBYSTACK_FINANCE_EXPORT_POOL_MAX: "2" };
  const workerPools = { LOBBYSTACK_WORKER_POOL_MAX: "10", LOBBYSTACK_DISPATCHER_POOL_MAX: "2" };

  it("gives a new deployment room for copies: a database with 200 connections, smaller pools, and a minute for the old admin to finish", async () => {
    writeSettings();
    // Up with everything made, but no variables set and nothing deployed yet.
    const state = stateAfterUp();
    for (const id of ["variables", "deploy.databases", "deploy.migrate", "deploy.admin", "deploy.worker"]) delete state.done[id];
    writeState(state);
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    // Postgres reads POSTGRES_INITDB_ARGS when it makes its database, at its first deploy, which had it.
    expect(world.variables.Postgres.POSTGRES_INITDB_ARGS).toBe("-c max_connections=200");
    expect(world.running.Postgres.POSTGRES_INITDB_ARGS).toBe("-c max_connections=200");
    // At a release Railway gives the old admin a minute to finish the requests it holds, such as connecting a call to
    // a worker; the old worker keeps its 31 minutes for the calls it carries. Both had them before their first deploy.
    expect(world.variables.admin.RAILWAY_DEPLOYMENT_DRAINING_SECONDS).toBe("60");
    expect(world.variables.worker.RAILWAY_DEPLOYMENT_DRAINING_SECONDS).toBe("1860");
    expect(world.variables.admin).toMatchObject(adminPools);
    expect(world.variables.worker).toMatchObject(workerPools);
    expect(world.deployments.admin[0]?.id).toBe("admin-deployment-2");
    expect(world.deployments.worker[0]?.id).toBe("worker-deployment-2");
    // The admin and the worker read those as 24 and 12 connections a copy (packages/db/src/pool-budget.ts). While a
    // release replaces two admins and two workers, the old copies still hold theirs: 144, within the 197 of 200 that
    // Postgres doesn't keep for superusers, and so are three admins and two workers (192).
    const admin = connectionBudget("admin", world.variables.admin);
    const worker = connectionBudget("worker", world.variables.worker);
    expect([admin, worker]).toEqual([24, 12]);
    expect(2 * (2 * admin + 2 * worker)).toBe(144);
    expect(2 * (3 * admin + 2 * worker)).toBeLessThanOrEqual(200 - 3);
    // The file for devops/railway-vars.mjs has them too.
    const vars = readFileSync(`${settings()}.vars`, "utf8");
    expect(vars).toContain("[Postgres]\nPGDATA=/var/lib/postgresql/data/pgdata\nPOSTGRES_DB=lobbystack\nPOSTGRES_USER=postgres\nPOSTGRES_INITDB_ARGS=-c max_connections=200\n");
    expect(vars).toContain("RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60");
    expect(vars).toContain("LOBBYSTACK_FINANCE_EXPORT_POOL_MAX=2");
  });

  it("brings an existing deployment's admin and worker their pools and the admin's minute, and leaves its running database alone", async () => {
    writeSettings();
    // A deployment up made before these settings: its database runs with Postgres's own 100 connections.
    railwayAfterUp();
    writeState(stateAfterUp());
    const redo = await bootstrap(["redo", settings(), "variables"]);
    expect(redo.code, redo.out).toBe(0);
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    // A database that exists ignores POSTGRES_INITDB_ARGS, and the script changes no running database's settings, so
    // it isn't set and Postgres doesn't deploy again; raising its limit is ALTER SYSTEM and a restart (guide 7.24).
    expect(world.variables.Postgres.POSTGRES_INITDB_ARGS).toBeUndefined();
    expect(result.out).toContain("= Postgres: unchanged");
    expect(world.deployments.Postgres).toHaveLength(1);
    expect(world.deployments.Redis).toHaveLength(1);
    expect(readFileSync(`${settings()}.vars`, "utf8")).not.toContain("POSTGRES_INITDB_ARGS");
    // The admin and the worker get the new values, and Railway deploys each again with them.
    expect(world.variables.admin).toMatchObject({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "60", ...adminPools });
    expect(world.variables.worker).toMatchObject({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "1860", ...workerPools });
    expect(world.deployments.admin[0]?.status).toBe("DEPLOYING");
    expect(world.deployments.worker[0]?.status).toBe("DEPLOYING");
    // With the smaller pools one admin and one worker fit Postgres's 97 even while a release replaces them both and the
    // old admin takes its minute, so the deployment needn't wait for the higher limit.
    expect(2 * (connectionBudget("admin", world.variables.admin) + connectionBudget("worker", world.variables.worker))).toBeLessThanOrEqual(100 - 3);
  });

  // PostgreSQL 18 for a new database (guide 7.22): a database that 16 wrote won't start on 18, so only a new Postgres gets it.
  const postgres18 = "pgvector/pgvector:pg18-trixie";

  it("makes a new deployment's Postgres from PostgreSQL 18's image, and leaves an existing deployment's image alone", async () => {
    writeSettings();
    // A project with every service but Postgres, as a run that stopped before making it leaves it.
    world.absent = new Set(["Postgres"]);
    const state = stateAfterUp();
    delete state.done["railway.services"];
    writeState(state);
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(world.images).toEqual({ Postgres: postgres18 });
    expect(world.absent.size).toBe(0);
    // A deployment made before, on 16: running the services step again makes nothing and changes no service's source.
    world = freshWorld();
    railwayAfterUp();
    writeState(stateAfterUp());
    const redo = await bootstrap(["redo", settings(), "railway.services"]);
    expect(redo.code, redo.out).toBe(0);
    const again = await bootstrap(["up", settings(), "--yes"]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("= Postgres");
    expect(world.images).toEqual({});
    for (const service of services) expect(world.settings[service], service).not.toHaveProperty("source");
  });

  it("deploys a template's Postgres from PostgreSQL 18's image, even from a template made with 16", async () => {
    writeSettings({ RAILWAY_TEMPLATE: "tmpl01" });
    const repo = { repo: "https://github.com/acme/lobbystack" };
    world.template = { id: "template-1", code: "tmpl01", name: "acme-template", serializedConfig: { services: {
      "svc-a": { name: "Postgres", source: { image: "pgvector/pgvector:pg16" }, variables: { PGDATA: {} } },
      "svc-b": { name: "Redis", source: { image: "redis:7-alpine" }, variables: {} },
      "svc-c": { name: "migrate", source: repo, variables: {} },
      "svc-d": { name: "admin", source: repo, variables: {} },
      "svc-e": { name: "worker", source: repo, variables: {} },
    } } };
    // A new project: the template makes its services.
    world.absent = new Set(["Postgres", "Redis", "migrate", "admin", "worker"]);
    const state = stateAfterUp();
    delete state.done["railway.services"];
    writeState(state);
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`Postgres: ${postgres18}, in place of the template's pgvector/pgvector:pg16`);
    expect(world.templateDeploys).toHaveLength(1);
    const deployed = Object.values(world.templateDeploys[0]?.services ?? {});
    expect(deployed.find((service) => service.name === "Postgres")?.source).toEqual({ image: postgres18 });
    expect(deployed.find((service) => service.name === "Redis")?.source).toEqual({ image: "redis:7-alpine" });
    expect(world.images).toEqual({ Postgres: postgres18, Redis: "redis:7-alpine" });
    // The database's variables went in with it, PGDATA in its own folder of the volume as before.
    expect(deployed.find((service) => service.name === "Postgres")?.variables?.PGDATA?.value).toBe("/var/lib/postgresql/data/pgdata");
  });

  // The fleet status address (docs/features/observability.md, "Watch every copy"): the admin's FLEET_STATUS_TOKEN, which
  // opens GET /api/internal/fleet to an uptime check and to devops/scale.mjs.
  const fleetTokenShape = /^[0-9a-f]{64}$/;
  const fleetStep = "The fleet status address's token (FLEET_STATUS_TOKEN on the admin, 64 hex characters)";
  /** Up with everything made, but no variables set and nothing deployed yet. */
  function beforeTheVariables() {
    const state = stateAfterUp();
    for (const id of ["variables", "deploy.databases", "deploy.migrate", "deploy.admin", "deploy.worker"]) delete state.done[id];
    writeState(state);
  }

  it("gives a new deployment's admin the token of its fleet status address before its first deploy, and keeps it from run to run", async () => {
    writeSettings();
    beforeTheVariables();
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`+ ${fleetStep}`);
    const state = readState();
    const token = String(state.values.FLEET_STATUS_TOKEN);
    expect(token).toMatch(fleetTokenShape);
    for (const id of ["fleet.token", "variables", "deploy.admin"]) expect(state.done[id], id).toBeTruthy();
    // Only the admin has it, and it went in before the admin's first deploy, which then started with it.
    expect(world.variables.admin.FLEET_STATUS_TOKEN).toBe(token);
    expect(world.deployments.admin[0]?.id).toBe("admin-deployment-2");
    for (const service of ["Postgres", "Redis", "migrate", "worker"] as const) expect(world.variables[service].FLEET_STATUS_TOKEN, service).toBeUndefined();
    expect(readFileSync(`${settings()}.vars`, "utf8")).toContain(`FLEET_STATUS_TOKEN=${token}\n`);
    // Neither the screen nor the log ever has it.
    expect(result.out).not.toContain(token);
    expect(logText()).not.toContain(token);

    // The token stays from run to run, so an uptime check that carries it keeps working.
    const again = await bootstrap(["up", settings(), "--yes"]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain(`= ${fleetStep} (done`);
    expect(readState().values.FLEET_STATUS_TOKEN).toBe(token);
    expect(world.variables.admin.FLEET_STATUS_TOKEN).toBe(token);
  });

  it("leaves a deployment made before the fleet status address as it is, and brings its admin the token when the variables run again", async () => {
    writeSettings();
    railwayAfterUp();
    writeState(stateAfterUp());
    const plain = await bootstrap(["up", settings(), "--yes"]);
    expect(plain.code, plain.out).toBe(0);
    expect(plain.out).not.toContain("fleet status address");
    expect(world.variables.admin.FLEET_STATUS_TOKEN).toBeUndefined();
    expect(readState().done["fleet.token"]).toBeUndefined();
    expect(readState().values.FLEET_STATUS_TOKEN).toBeUndefined();

    const redo = await bootstrap(["redo", settings(), "variables"]);
    expect(redo.code, redo.out).toBe(0);
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`+ ${fleetStep}`);
    const token = String(readState().values.FLEET_STATUS_TOKEN);
    expect(token).toMatch(fleetTokenShape);
    expect(world.variables.admin.FLEET_STATUS_TOKEN).toBe(token);
    expect(result.out).toMatch(/~ admin: .*FLEET_STATUS_TOKEN.* \(Railway deploys it again\)/);
    expect(world.deployments.admin[0]?.status).toBe("DEPLOYING");
    expect(result.out).not.toContain(token);
  });

  it("keeps the fleet status token the admin has already, and after a redo takes the secrets file's or refuses one too short", async () => {
    // Set by hand on the admin, and an uptime check carries it in its address.
    const byHand = "set-by-hand-".padEnd(40, "u");
    writeSettings();
    railwayAfterUp();
    world.variables.admin.FLEET_STATUS_TOKEN = byHand;
    world.running.admin = { ...world.variables.admin };
    writeState(stateAfterUp());
    expect((await bootstrap(["redo", settings(), "variables"])).code).toBe(0);
    const kept = await bootstrap(["up", settings(), "--yes"]);
    expect(kept.code, kept.out).toBe(0);
    expect(kept.out).toContain("FLEET_STATUS_TOKEN: found on Railway's admin service");
    expect(readState().values.FLEET_STATUS_TOKEN).toBe(byHand);
    expect(world.variables.admin.FLEET_STATUS_TOKEN).toBe(byHand);
    expect(kept.out).not.toContain(byHand);
    expect(logText()).not.toContain(byHand);

    // A token of the operator's own, in the secrets file: the kept one stays until its step is redone.
    const own = "own.fleet~token-".padEnd(36, "k");
    writeSettings({}, { FLEET_STATUS_TOKEN: own });
    const unchanged = await bootstrap(["up", settings(), "--yes"]);
    expect(unchanged.code, unchanged.out).toBe(0);
    expect(world.variables.admin.FLEET_STATUS_TOKEN).toBe(byHand);

    const redo = await bootstrap(["redo", settings(), "fleet.token"]);
    expect(redo.code, redo.out).toBe(0);
    expect(redo.out).toContain("fleet.token: runs again next time");
    expect(redo.out).toContain("variables: runs again next time, to pass on what it uses");
    expect(redo.out).toContain("forgot the fleet status address's token");
    expect(readState().values.FLEET_STATUS_TOKEN).toBeUndefined();
    const changed = await bootstrap(["up", settings(), "--yes"]);
    expect(changed.code, changed.out).toBe(0);
    expect(readState().values.FLEET_STATUS_TOKEN).toBe(own);
    expect(world.variables.admin.FLEET_STATUS_TOKEN).toBe(own);
    expect(changed.out).not.toContain(own);
    expect(logText()).not.toContain(own);

    // Fewer than 32 characters would leave the address off, so the script stops before it sets anything.
    writeSettings({}, { FLEET_STATUS_TOKEN: "too-short" });
    expect((await bootstrap(["redo", settings(), "fleet.token"])).code).toBe(0);
    const refused = await bootstrap(["up", settings(), "--yes"]);
    expect(refused.code, refused.out).toBe(1);
    expect(refused.out).toContain("FLEET_STATUS_TOKEN in");
    expect(refused.out).toContain("must be at least 32 letters, digits, dashes, underscores, dots or tildes");
    expect(world.variables.admin.FLEET_STATUS_TOKEN).toBe(own);
  });

  // The access gate (docs/features/access-gate.md): the admin's PROTECTION_TOKEN and the access link. PROTECT=yes in the
  // settings file closes a deployment with a token the script makes, and a PROTECTION_TOKEN in the secrets file closes it
  // by itself.
  const tokenShape = /^[A-Za-z0-9_-]{43}$/;
  const accessLinkOf = (token: unknown) => `https://${railwayHost}/login?access=${String(token)}`;
  const secretsFile = () => `${settings()}.secrets`;
  /** A token of the operator's own, as the secrets file gives it: not the 43 characters the script makes. */
  const ownToken = (letter = "t") => `own.token~${letter.repeat(30)}`;

  /** A deployment up finished with PROTECT=yes: the token is kept, and the admin's live deployment has it. */
  function protectedAfterUp(token = randomBytes(32).toString("base64url")): string {
    railwayAfterUp();
    world.variables.admin.PROTECTION_TOKEN = token;
    world.running.admin = { ...world.variables.admin };
    const state = stateAfterUp();
    state.done.protection = earlier;
    state.values.PROTECTION_TOKEN = token;
    writeState(state);
    return token;
  }

  it("leaves a deployment open unless PROTECT says yes or the secrets file has a token, and never closes production", async () => {
    writeSettings();
    const state = stateAfterUp();
    for (const id of ["variables", "deploy.databases", "deploy.migrate", "deploy.admin", "deploy.worker"]) delete state.done[id];
    writeState(state);
    const open = await bootstrap(["up", settings(), "--yes"]);
    expect(open.code, open.out).toBe(0);
    expect(world.variables.admin.PROTECTION_TOKEN).toBeUndefined();
    expect(open.out).not.toContain("Access gate");
    expect(open.out).not.toContain("?access=");
    expect(readState().done.protection).toBeUndefined();
    expect((await bootstrap(["status", settings()])).out).not.toContain("access link");

    writeSettings({ PROTECT: "maybe" });
    const unclear = await bootstrap(["status", settings()]);
    expect(unclear.code, unclear.out).toBe(1);
    expect(unclear.out).toContain("PROTECT is yes or no");

    writeSettings({ PROTECT: "yes", ENVIRONMENT: "production" });
    const production = await bootstrap(["status", settings()]);
    expect(production.code, production.out).toBe(1);
    expect(production.out).toContain("PROTECT=yes is only for ENVIRONMENT=test");

    // The secrets file's token closes a deployment as PROTECT=yes does, so production refuses it too. The settings are
    // otherwise good for production: an address on a domain brands/index.json gives the brand.
    const [domain, brand] = Object.entries((JSON.parse(readFileSync(join(repoRoot, "brands", "index.json"), "utf8")) as { domains: Record<string, string> }).domains)[0] ?? [];
    expect(domain && brand, "brands/index.json gives a brand a domain").toBeTruthy();
    const productionSettings = { ENVIRONMENT: "production", BRAND: brand, APP_BASE_URL: `app.${domain}` };
    writeSettings(productionSettings);
    const unprotected = await bootstrap(["status", settings()]);
    expect(unprotected.code, unprotected.out).toBe(0);
    writeSettings(productionSettings, { PROTECTION_TOKEN: ownToken() });
    const withToken = await bootstrap(["status", settings()]);
    expect(withToken.code, withToken.out).toBe(1);
    expect(withToken.out).toContain(`the secrets file ${secretsFile()} needs fixing`);
    expect(withToken.out).toContain("PROTECTION_TOKEN closes the deployment to strangers, and");
    expect(withToken.out).toContain("says ENVIRONMENT=production");
    expect(withToken.out).not.toContain(ownToken());

    // In the settings file the token would close nothing, so the script stops there rather than leave the deployment open.
    writeSettings({ PROTECTION_TOKEN: ownToken() });
    const misplaced = await bootstrap(["status", settings()]);
    expect(misplaced.code, misplaced.out).toBe(1);
    expect(misplaced.out).toContain(`PROTECTION_TOKEN is in this file, where the script doesn't read it, so it closes nothing. Move the line to the secrets file (${secretsFile()})`);
    expect(misplaced.out).not.toContain(ownToken());
  });

  it("makes the access gate's token in up, puts it on the admin before its first deploy, and shows the access link, which the log never has", async () => {
    writeSettings({ PROTECT: "yes" });
    const before = stateAfterUp();
    for (const id of ["variables", "deploy.databases", "deploy.migrate", "deploy.admin", "deploy.worker"]) delete before.done[id];
    writeState(before);
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    const state = readState();
    const token = String(state.values.PROTECTION_TOKEN);
    expect(token).toMatch(tokenShape);
    for (const id of ["protection", "variables", "deploy.admin"]) expect(state.done[id], id).toBeTruthy();
    // Only the admin has it, and it went in before the admin's first deploy, which then started with it.
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(token);
    expect(world.deployments.admin[0]?.id).toBe("admin-deployment-2");
    for (const service of ["Postgres", "Redis", "migrate", "worker"] as const) expect(world.variables[service].PROTECTION_TOKEN, service).toBeUndefined();
    expect(readFileSync(`${settings()}.vars`, "utf8")).toContain(`PROTECTION_TOKEN=${token}\n`);
    // The link is on screen, for the operator to send on, and the log has it without the token.
    expect(result.out).toContain("+ The access gate's token (PROTECTION_TOKEN on the admin, 43 random characters)");
    expect(result.out).toContain("Closed to strangers (PROTECT=yes): every page answers 404 until a browser opens the access link once.");
    expect(result.out).toContain(accessLinkOf(token));
    expect(logText()).not.toContain(token);
    expect(logText()).toContain(`https://${railwayHost}/login?access=‹hidden›`);

    const status = await bootstrap(["status", settings()]);
    expect(status.code, status.out).toBe(0);
    expect(status.out).toContain(`access link (PROTECT=yes): ${accessLinkOf(token)}`);
    expect(logText()).not.toContain(token);

    // The token stays from run to run, so the link that was sent out keeps working.
    const again = await bootstrap(["up", settings(), "--yes"]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("= The access gate's token (PROTECTION_TOKEN on the admin) (done");
    expect(readState().values.PROTECTION_TOKEN).toBe(token);
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(token);
  });

  it("closes a deployment that is already up, and doctor says whether it is closed yet", async () => {
    writeSettings({ PROTECT: "yes" });
    railwayAfterUp();
    writeState(stateAfterUp());
    const waiting = await bootstrap(["doctor", settings()]);
    expect(waiting.out).toContain("note   access gate: on (PROTECT=yes), with a token up makes: every page answers 404 until a browser opens the access link once");
    expect(waiting.out).toContain("note   PROTECT=yes, and up hasn't made the access gate's token yet");
    expect((await bootstrap(["status", settings()])).out).toContain("access link (PROTECT=yes): none yet: up makes the token and shows the link");

    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("The variables are done already, so they run again below, to bring the token to the admin.");
    const token = String(readState().values.PROTECTION_TOKEN);
    expect(token).toMatch(tokenShape);
    expect(result.out).toContain("~ admin: ");
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(token);
    expect(result.out).toContain(accessLinkOf(token));
    // Railway deploys the admin again with it. Until that deployment is live, pages still answer.
    expect(world.deployments.admin[0]?.status).toBe("DEPLOYING");
    expect(world.deployments.Postgres).toHaveLength(1);
    const stillOpen = await bootstrap(["doctor", settings()]);
    expect(stillOpen.code, stillOpen.out).toBe(1);
    expect(stillOpen.out).toContain(`FIX    PROTECT=yes, but https://${railwayHost}/login answers 308 without the access link, so the deployment is open to anyone.`);
    expect(stillOpen.out).toContain("acme/lobbystack@main is from before the access gate");

    world.running.admin = { ...world.variables.admin };
    const closed = await bootstrap(["doctor", settings()]);
    expect(closed.out).toContain(`ok     closed to strangers: https://${railwayHost}/login answers 404 without the access link`);
    expect(closed.out).toContain("note   access gate: on (PROTECT=yes), with the token an earlier run kept: every page answers 404");
    expect(closed.out).not.toContain("FIX    PROTECT=yes");
    expect(logText()).not.toContain(token);
  });

  it("says in connect whether the deployment is closed, and gives the access link with what is left to do", async () => {
    readyForBilling();
    writeSettings({ DEPLOYMENT_MODE: "self_hosted_standard", PROTECT: "yes" });
    const token = randomBytes(32).toString("base64url");
    const state = readState();
    state.done.protection = earlier;
    state.values.PROTECTION_TOKEN = token;
    writeState(state);
    world.variables.admin.PROTECTION_TOKEN = token;
    world.running.admin = { ...world.variables.admin };
    const closed = await bootstrap(["connect", settings()]);
    expect(closed.code, closed.out).toBe(0);
    expect(closed.out).toContain(`closed to strangers: https://${railwayHost}/login answers 404 without the access link`);
    expect(closed.out).toContain("1. The deployment is closed to strangers (PROTECT=yes). Open the access link once in each browser that should");
    expect(closed.out).toContain(accessLinkOf(token));
    expect(logText()).not.toContain(token);

    // A branch from before the access gate ignores the variable, and the deployment stays open with no error anywhere.
    delete world.running.admin.PROTECTION_TOKEN;
    const open = await bootstrap(["connect", settings()]);
    expect(open.code, open.out).toBe(0);
    expect(open.out).toContain(`WARNING: PROTECT=yes, but https://${railwayHost}/login answers 308 without the access link, so the deployment is open to anyone.`);

    // The same with the token in the secrets file and no PROTECT=yes: connect names what closes the deployment.
    writeSettings({ DEPLOYMENT_MODE: "self_hosted_standard" }, { PROTECTION_TOKEN: token });
    const stillOpen = await bootstrap(["connect", settings()]);
    expect(stillOpen.code, stillOpen.out).toBe(0);
    expect(stillOpen.out).toContain(`WARNING: PROTECTION_TOKEN is in ${secretsFile()}, but https://${railwayHost}/login answers 308 without the access link, so the deployment is open to anyone.`);
    world.running.admin = { ...world.variables.admin };
    const given = await bootstrap(["connect", settings()]);
    expect(given.code, given.out).toBe(0);
    expect(given.out).toContain(`closed to strangers: https://${railwayHost}/login answers 404 without the access link`);
    expect(given.out).toContain(`1. The deployment is closed to strangers (PROTECTION_TOKEN is in ${secretsFile()}). Open the access link once in each browser that should`);
    expect(given.out).toContain(accessLinkOf(token));
    expect(logText()).not.toContain(token);
  });

  it("closes a deployment with a PROTECTION_TOKEN in the secrets file alone, whatever PROTECT says", async () => {
    const chosen = ownToken();
    const by = `PROTECTION_TOKEN is in ${secretsFile()}`;
    // PROTECT=no, as init writes it: the token closes the deployment by itself.
    writeSettings({ PROTECT: "no" }, { PROTECTION_TOKEN: chosen });
    railwayAfterUp();
    writeState(stateAfterUp());
    const waiting = await bootstrap(["doctor", settings()]);
    expect(waiting.out).toContain(`note   access gate: on (${by}), with the secrets file's token: every page answers 404 until a browser opens the access link once`);
    expect(waiting.out).toContain(`note   ${by}, and up hasn't put the access gate's token on the admin yet: https://${railwayHost} is open until up has run`);
    expect((await bootstrap(["status", settings()])).out).toContain(`access link (${by}): none yet: up puts the token on the admin and shows the link`);
    const dry = await bootstrap(["up", settings(), "--dry-run"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain(`~ The access gate's token (PROTECTION_TOKEN on the admin, from ${secretsFile()})`);
    expect(readState().values.PROTECTION_TOKEN).toBeUndefined();

    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("\nAccess gate\n");
    expect(result.out).toContain(`+ The access gate's token (PROTECTION_TOKEN on the admin, from ${secretsFile()})`);
    expect(result.out).toContain("The variables are done already, so they run again below, to bring the token to the admin.");
    // The secrets file's token is the admin's, and the one the script keeps: none is made.
    const state = readState();
    expect(state.values.PROTECTION_TOKEN).toBe(chosen);
    for (const id of ["protection", "variables"]) expect(state.done[id], id).toBeTruthy();
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(chosen);
    for (const service of ["Postgres", "Redis", "migrate", "worker"] as const) expect(world.variables[service].PROTECTION_TOKEN, service).toBeUndefined();
    expect(readFileSync(`${settings()}.vars`, "utf8")).toContain(`PROTECTION_TOKEN=${chosen}\n`);
    expect(result.out).toContain(`Closed to strangers (${by}): every page answers 404 until a browser opens the access link once.`);
    expect(result.out).toContain(accessLinkOf(chosen));
    expect(logText()).not.toContain(chosen);
    expect(logText()).toContain(`https://${railwayHost}/login?access=‹hidden›`);

    // Railway deploys the admin again with it. Until that deployment is live, pages still answer.
    expect(world.deployments.admin[0]?.status).toBe("DEPLOYING");
    const stillOpen = await bootstrap(["doctor", settings()]);
    expect(stillOpen.code, stillOpen.out).toBe(1);
    expect(stillOpen.out).toContain(`FIX    ${by}, but https://${railwayHost}/login answers 308 without the access link, so the deployment is open to anyone.`);
    world.running.admin = { ...world.variables.admin };
    const closed = await bootstrap(["doctor", settings()]);
    expect(closed.out).toContain(`ok     closed to strangers: https://${railwayHost}/login answers 404 without the access link`);
    expect(closed.out).not.toContain(`FIX    ${by}`);
    const status = await bootstrap(["status", settings()]);
    expect(status.out).toContain(`access link (${by}): ${accessLinkOf(chosen)}`);
    expect(status.out).not.toContain("access gate:");

    // A settings file from before the setting has no PROTECT line: the same.
    writeSettings({ PROTECT: undefined }, { PROTECTION_TOKEN: chosen });
    const again = await bootstrap(["up", settings(), "--yes"]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("= The access gate's token (PROTECTION_TOKEN on the admin) (done");
    expect(again.out).toContain(accessLinkOf(chosen));
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(chosen);

    // With PROTECT=yes as well, the secrets file's token is still the one used, and none is made.
    writeSettings({ PROTECT: "yes" }, { PROTECTION_TOKEN: chosen });
    const both = await bootstrap(["status", settings()]);
    expect(both.out).toContain(`access link (PROTECT=yes): ${accessLinkOf(chosen)}`);

    // Taking the token out of the secrets file deletes no variable: the deployment stays closed, and the script says so.
    writeSettings({ PROTECT: "no" });
    const reminder = "Nothing asks for the access gate any more (PROTECT isn't yes in";
    const left = await bootstrap(["status", settings()]);
    expect(left.out).toContain(`access gate: ${reminder}`);
    expect(left.out).not.toContain("?access=");
    expect((await bootstrap(["doctor", settings()])).out).toContain(`note   ${reminder}`);
    const up = await bootstrap(["up", settings(), "--yes"]);
    expect(up.code, up.out).toBe(0);
    expect(up.out).toContain(reminder);
    expect(up.out).not.toContain("Access gate");
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(chosen);
  });

  it("makes a new token when the protection step is redone, or takes the secrets file's, and refuses one the admin wouldn't start with", async () => {
    writeSettings({ PROTECT: "yes" });
    const first = protectedAfterUp();
    const redo = await bootstrap(["redo", settings(), "protection"]);
    expect(redo.code, redo.out).toBe(0);
    expect(redo.out).toContain("forgot the access gate's token, so up makes a new one");
    const forgotten = readState();
    expect(forgotten.values.PROTECTION_TOKEN).toBeUndefined();
    for (const id of ["protection", "variables"]) expect(forgotten.done[id], id).toBeUndefined();

    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    const second = String(readState().values.PROTECTION_TOKEN);
    expect(second).toMatch(tokenShape);
    expect(second).not.toBe(first);
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(second);
    expect(world.deployments.admin[0]?.status).toBe("DEPLOYING");
    expect(result.out).toContain(accessLinkOf(second));
    expect(result.out).not.toContain(first);

    // A token of the operator's own choosing, from the secrets file. As with every key, the one an earlier run kept
    // stays until its step is redone, so the link that was sent out keeps working, and the script says which is which.
    const chosen = ownToken("c");
    const waits = `PROTECTION_TOKEN in ${secretsFile()} isn't the token an earlier run put on the admin. That one stays, and the access link carries it.`;
    for (const protect of ["yes", "no"]) {
      writeSettings({ PROTECT: protect }, { PROTECTION_TOKEN: chosen });
      const kept = await bootstrap(["up", settings(), "--yes"]);
      expect(kept.code, kept.out).toBe(0);
      expect(kept.out.split(waits)).toHaveLength(3);
      expect(kept.out).toContain(accessLinkOf(second));
      expect(kept.out).not.toContain(chosen);
      expect(world.variables.admin.PROTECTION_TOKEN).toBe(second);
      expect(readState().values.PROTECTION_TOKEN).toBe(second);
      const status = await bootstrap(["status", settings()]);
      expect(status.out).toContain(`access link (${protect === "yes" ? "PROTECT=yes" : `PROTECTION_TOKEN is in ${secretsFile()}`}): ${accessLinkOf(second)}`);
      expect(status.out).toContain(`access gate: ${waits}`);
      const doctor = await bootstrap(["doctor", settings()]);
      expect(doctor.out).toContain("with the token an earlier run kept: every page answers 404");
      expect(doctor.out).toContain(`note   ${waits}`);
    }
    const redoGiven = await bootstrap(["redo", settings(), "protection"]);
    expect(redoGiven.code, redoGiven.out).toBe(0);
    expect(redoGiven.out).toContain(`forgot the access gate's token, so up takes the one in ${secretsFile()}.`);
    const given = await bootstrap(["up", settings(), "--yes"]);
    expect(given.code, given.out).toBe(0);
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(chosen);
    expect(given.out).toContain(accessLinkOf(chosen));
    expect(given.out).not.toContain(waits);
    expect(given.out).not.toContain(second);

    // A token the admin wouldn't start with: doctor says so before anything runs, and up stops at the step.
    writeSettings({ PROTECT: "yes" }, { PROTECTION_TOKEN: "too+short" });
    const shape = "must be at least 32 letters, digits, dashes, underscores, dots or tildes";
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.code, doctor.out).toBe(1);
    expect(doctor.out).toContain(`FIX    PROTECTION_TOKEN in ${secretsFile()} ${shape}`);
    expect((await bootstrap(["redo", settings(), "protection"])).code).toBe(0);
    const refused = await bootstrap(["up", settings(), "--yes"]);
    expect(refused.code, refused.out).toBe(1);
    expect(refused.out).toContain(shape);
    expect(refused.out).not.toContain("too+short");
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(chosen);
  });

  it("says in doctor when the admin is closed by a token the script doesn't know of, and takes it over from the secrets file without a new deployment", async () => {
    writeSettings();
    railwayAfterUp();
    writeState(stateAfterUp());
    expect((await bootstrap(["doctor", settings()])).out).not.toContain("access gate");
    // Someone set the variable by hand in Railway, and the admin runs with it.
    const byHand = ownToken("h");
    world.variables.admin.PROTECTION_TOKEN = byHand;
    world.running.admin = { ...world.variables.admin };
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.out).toContain(`note   https://${railwayHost}/login answers the access gate's 404, so PROTECTION_TOKEN is set on the admin, though PROTECT isn't yes in ${settings()} and the secrets file has no PROTECTION_TOKEN.`);
    expect(doctor.out).toContain("put the admin's token in the secrets file as PROTECTION_TOKEN and run up, which keeps it");
    expect((await bootstrap(["status", settings()])).out).not.toContain("access link");

    // In the secrets file, the same token closes nothing anew: the script keeps it, and from then on shows the link.
    writeSettings({}, { PROTECTION_TOKEN: byHand });
    const first = await bootstrap(["up", settings(), "--yes"]);
    expect(first.code, first.out).toBe(0);
    expect(readState().values.PROTECTION_TOKEN).toBe(byHand);
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(byHand);
    expect(first.out).toContain(accessLinkOf(byHand));
    // The stand-in's admin had only a few of its variables, so that run set the rest. With all of them there, a token
    // the admin has already changes nothing, and Railway deploys nothing.
    world.running.admin = { ...world.variables.admin };
    const deployments = world.deployments.admin.length;
    expect((await bootstrap(["redo", settings(), "protection"])).code).toBe(0);
    const taken = await bootstrap(["up", settings(), "--yes"]);
    expect(taken.code, taken.out).toBe(0);
    expect(taken.out).toContain("= admin: unchanged");
    expect(world.deployments.admin).toHaveLength(deployments);
    expect(readState().values.PROTECTION_TOKEN).toBe(byHand);
    expect(taken.out).toContain(accessLinkOf(byHand));
    expect((await bootstrap(["doctor", settings()])).out).toContain(`ok     closed to strangers: https://${railwayHost}/login answers 404 without the access link`);
  });

  it("says that a deployment stays closed after PROTECT goes back to no, until the variable is deleted in Railway", async () => {
    writeSettings({ PROTECT: "yes" });
    const token = protectedAfterUp();
    writeSettings({ PROTECT: "no" });
    const reminder = "Nothing asks for the access gate any more (PROTECT isn't yes in";
    const status = await bootstrap(["status", settings()]);
    expect(status.code, status.out).toBe(0);
    expect(status.out).toContain(`access gate: ${reminder}`);
    expect(status.out).toContain("the deployment stays closed until you delete PROTECTION_TOKEN from the admin's variables in Railway");
    expect(status.out).not.toContain("?access=");
    const up = await bootstrap(["up", settings(), "--yes"]);
    expect(up.code, up.out).toBe(0);
    expect(up.out).toContain(reminder);
    // The script deletes no variable, and makes no new deployment for it.
    expect(world.variables.admin.PROTECTION_TOKEN).toBe(token);
    expect(up.out).not.toContain("Access gate");

    // Once the variable is gone from Railway, redo forgets the token and the reminder stops.
    delete world.variables.admin.PROTECTION_TOKEN;
    world.running.admin = { ...world.variables.admin };
    const redo = await bootstrap(["redo", settings(), "protection"]);
    expect(redo.code, redo.out).toBe(0);
    expect(redo.out).toContain("forgot the access gate's token. PROTECT isn't yes and the secrets file has no PROTECTION_TOKEN, so up puts none on the admin.");
    expect(readState().values.PROTECTION_TOKEN).toBeUndefined();
    const after = await bootstrap(["up", settings(), "--yes"]);
    expect(after.code, after.out).toBe(0);
    expect(after.out).not.toContain(reminder);
    expect(world.variables.admin.PROTECTION_TOKEN).toBeUndefined();
    expect((await bootstrap(["status", settings()])).out).not.toContain("access gate");
    expect((await bootstrap(["doctor", settings()])).out).not.toContain("access gate");
  });

  // ---------------------------------------------------------------- the control panel

  const panelHost = "control-acme-test.example.com";
  const panelOrigin = "http://control.railway.internal:3000";
  const panelSteps = ["control.services", "control.settings", "control.password", "control.tunnel", "control.dns", "control.access", "deploy.control", "deploy.cloudflared"];
  const withControl = (changes: Record<string, string | undefined> = {}) => ({ CONTROL: "yes", CLOUDFLARE_ZONE: cloudflareZone, CLOUDFLARE_ACCOUNT_ID: cloudflareAccount, ...changes });

  /** Every deployment the stand-in has started is live, with the variables Railway has now. */
  function settle() {
    for (const service of services) {
      for (const deployment of world.deployments[service]) deployment.status = "SUCCESS";
      world.running[service] = { ...world.variables[service] };
    }
  }

  /** A deployment that is up, every service with the variables up gives it, and no control panel. */
  async function upWithoutControl() {
    writeSettings();
    railwayAfterUp();
    const state = stateAfterUp();
    delete state.done.variables;
    writeState(state);
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    settle();
  }

  /** The same deployment once up has given it the control panel. */
  async function controlAfterUp() {
    await upWithoutControl();
    writeSettings(withControl());
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    settle();
    return result;
  }

  it("leaves the control panel out unless the settings file says CONTROL=yes", async () => {
    writeSettings({ CLOUDFLARE_ZONE: cloudflareZone, CLOUDFLARE_ACCOUNT_ID: cloudflareAccount });
    railwayAfterUp();
    writeState(stateAfterUp());
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toContain("Control panel");
    expect(world.made.size).toBe(0);
    expect(world.cloudflare.calls).toEqual([]);
    expect(Object.keys(readState().done).filter((id) => panelSteps.includes(id))).toEqual([]);
    expect((await bootstrap(["status", settings()])).out).not.toContain("control panel");
  });

  it("refuses CONTROL=yes without Cloudflare's zone and account, an address outside the zone, and emails that aren't", async () => {
    writeSettings({ CONTROL: "yes" });
    const bare = await bootstrap(["status", settings()]);
    expect(bare.code, bare.out).toBe(1);
    expect(bare.out).toContain("CONTROL=yes needs CLOUDFLARE_ZONE and CLOUDFLARE_ACCOUNT_ID");
    writeSettings(withControl({ CONTROL_HOST: "control.example.org", CONTROL_ADMIN_EMAILS: "ops@example.com, not-an-email" }));
    const wrong = await bootstrap(["status", settings()]);
    expect(wrong.code, wrong.out).toBe(1);
    expect(wrong.out).toContain("CONTROL_HOST must be under CLOUDFLARE_ZONE (example.com)");
    expect(wrong.out).toContain("CONTROL_ADMIN_EMAILS is emails separated by commas, and not-an-email isn't one");
    writeSettings(withControl({ CONTROL: "maybe" }));
    expect((await bootstrap(["status", settings()])).out).toContain("CONTROL is yes or no");
    // An address two levels under the zone works only with a certificate of its own, so it's a warning.
    writeSettings(withControl({ CONTROL_HOST: "https://Panel.Ops.example.com/" }));
    const deep = await bootstrap(["status", settings()]);
    expect(deep.code, deep.out).toBe(0);
    expect(deep.out).toContain("CONTROL_HOST (panel.ops.example.com) is more than one level under example.com");
    expect(deep.out).toContain("control panel: https://panel.ops.example.com, once up has set it up");
    // Production's is control.<zone>, on a domain brands/index.json gives the brand.
    const [domain, brand] = Object.entries((JSON.parse(readFileSync(join(repoRoot, "brands", "index.json"), "utf8")) as { domains: Record<string, string> }).domains)[0] ?? [];
    expect(domain && brand, "brands/index.json gives a brand a domain").toBeTruthy();
    writeSettings(withControl({ ENVIRONMENT: "production", BRAND: brand, APP_BASE_URL: `app.${domain}`, CLOUDFLARE_ZONE: domain }));
    const production = await bootstrap(["status", settings()]);
    expect(production.code, production.out).toBe(0);
    expect(production.out).toContain(`control panel: https://control.${domain}, once up has set it up`);
  });

  it("gives a deployment that is up the control panel: its services, the tunnel, the DNS record, Access, the variables and the deploys", async () => {
    await upWithoutControl();
    const before = { admin: world.deployments.admin.length, worker: world.deployments.worker.length, migrate: world.deployments.migrate.length };
    writeSettings(withControl());
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    const state = readState();
    for (const id of panelSteps) expect(state.done[id], id).toBeTruthy();
    // Railway: the panel, built from Dockerfile.control and with no address of its own, and the tunnel's connector.
    expect([...world.made].sort()).toEqual(["cloudflared", "control"]);
    expect(world.images.cloudflared).toBe("cloudflare/cloudflared:latest");
    expect(world.settings.control).toEqual({ dockerfilePath: "Dockerfile.control", rootDirectory: "/", healthcheckPath: "/api/health/live", healthcheckTimeout: 300 });
    expect(world.settings.cloudflared).toEqual({ startCommand: "cloudflared tunnel --no-autoupdate run" });
    // Cloudflare: a tunnel that sends only the panel's address to the control service, ...
    expect(world.cloudflare.tunnels).toHaveLength(1);
    const tunnel = world.cloudflare.tunnels[0];
    expect(tunnel).toMatchObject({ name: "acme-test-control-panel", config_src: "cloudflare" });
    expect(tunnel?.ingress).toEqual([{ hostname: panelHost, service: panelOrigin }, { service: "http_status:404" }]);
    // ... the address's CNAME to the tunnel, proxied, and Access in front of it, for the operator's email only.
    expect(world.cloudflare.records).toEqual([expect.objectContaining({ type: "CNAME", name: panelHost, content: `${tunnel?.id}.cfargotunnel.com`, proxied: true })]);
    expect(world.cloudflare.policies).toHaveLength(1);
    const policy = world.cloudflare.policies[0];
    expect(policy).toMatchObject({ name: "acme-test control panel admins", decision: "allow", include: [{ email: { email: "ops@example.com" } }] });
    expect(world.cloudflare.apps).toHaveLength(1);
    const app = world.cloudflare.apps[0];
    expect(app).toMatchObject({ name: "acme-test control panel", domain: panelHost, type: "self_hosted", policies: [{ id: policy?.id, precedence: 1 }] });
    // The panel's variables, and migrate's, which gives lobbystack_control its login once migrate deploys again with it.
    const password = String(state.values.LOBBYSTACK_CONTROL_PASSWORD);
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(world.variables.control).toEqual({
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.control", NODE_ENV: "production", PORT: "3000", HOSTNAME: "::", LOBBYSTACK_CONTROL_PASSWORD: password,
      DATABASE_URL: "postgresql://lobbystack_control:${{LOBBYSTACK_CONTROL_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack",
      CONTROL_ACCESS_TEAM_DOMAIN: teamDomain, CONTROL_ACCESS_AUD: app?.aud, CONTROL_ADMIN_EMAILS: "ops@example.com",
      // The System health page asks the admin over the private network, with the admin's own fleet token.
      CONTROL_ADMIN_URL: "http://${{admin.RAILWAY_PRIVATE_DOMAIN}}:3000", FLEET_STATUS_TOKEN: "${{admin.FLEET_STATUS_TOKEN}}",
    });
    expect(world.variables.cloudflared).toEqual({ TUNNEL_TOKEN: tunnel?.token });
    expect(world.variables.migrate.LOBBYSTACK_CONTROL_PASSWORD).toBe("${{control.LOBBYSTACK_CONTROL_PASSWORD}}");
    expect(result.out).toContain("The variables are done already, so they run again below, to bring the panel's.");
    expect(result.out).toContain("~ migrate: LOBBYSTACK_CONTROL_PASSWORD (Railway deploys it again)");
    expect(world.deployments.migrate).toHaveLength(before.migrate + 1);
    // Nothing else changed, so the admin and the worker don't deploy again.
    expect(result.out).toContain("= admin: unchanged");
    expect(result.out).toContain("= worker: unchanged");
    expect(world.deployments.admin).toHaveLength(before.admin);
    expect(world.deployments.worker).toHaveLength(before.worker);
    // The panel builds from the repository, and the connector runs.
    expect(world.deployments.control).toHaveLength(1);
    expect(world.deployments.cloudflared[0]?.status).toBe("SUCCESS");
    expect(result.out).toContain(`The control panel: https://${panelHost}, for ops@example.com.`);
    expect(readFileSync(`${settings()}.vars`, "utf8")).toContain(`[cloudflared]\nTUNNEL_TOKEN=${tunnel?.token}\n`);
    // Neither the screen nor the log ever has the password or the tunnel's token.
    for (const secret of [password, String(tunnel?.token)]) {
      expect(result.out).not.toContain(secret);
      expect(logText()).not.toContain(secret);
    }

    // Again: every step is done, so nothing is called, made or deployed.
    settle();
    const counts = { calls: world.cloudflare.calls.length, migrate: world.deployments.migrate.length, control: world.deployments.control.length };
    const again = await bootstrap(["up", settings(), "--yes"]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).not.toContain("run again below");
    expect(world.cloudflare.calls).toHaveLength(counts.calls);
    expect(world.deployments.migrate).toHaveLength(counts.migrate);
    expect(world.deployments.control).toHaveLength(counts.control);

    expect((await bootstrap(["status", settings()])).out).toContain(`control panel: https://${panelHost}, behind Cloudflare Access for ops@example.com`);
    const doctor = await bootstrap(["doctor", settings()]);
    expect(doctor.out).toContain(`ok     https://${panelHost} answers with Cloudflare Access's sign-in`);
    expect(doctor.out).toContain("ok     the control service has no address of its own on Railway: only the tunnel reaches it");
    expect(doctor.out).toContain("ok     Cloudflare: CLOUDFLARE_API_TOKEN reads tunnels, Access applications, Access policies (up needs Edit on them)");
    expect(doctor.out).toContain(`ok     Cloudflare: Zero Trust is set up, team domain ${teamDomain}`);
    // A token without the tunnel permission, and an address of the panel's own on Railway, are both things to fix.
    world.cloudflare.forbidden = ["/cfd_tunnel"];
    world.controlDomains = [{ id: "domain-2", domain: "control-production.up.railway.app", targetPort: 3000 }];
    const worse = await bootstrap(["doctor", settings()]);
    expect(worse.out).toContain("FIX    Cloudflare: CLOUDFLARE_API_TOKEN can't read tunnels (Cloudflare refused GET /cloudflare/accounts/");
    expect(worse.out).toContain("For the control panel it needs Account > Cloudflare Tunnel > Edit");
    expect(worse.out).toContain("FIX    the control service has an address of its own on Railway (control-production.up.railway.app)");
  });

  it("sets a new deployment's panel up before migrate's first deploy, which then gives the role its login, and lists it in a dry run", async () => {
    writeSettings(withControl());
    const state = stateAfterUp();
    for (const id of ["variables", "deploy.databases", "deploy.migrate", "deploy.admin", "deploy.worker"]) delete state.done[id];
    writeState(state);
    const dry = await bootstrap(["up", settings(), "--dry-run"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("~ Services control (the panel, with no public address) and cloudflared (the tunnel's connector)");
    expect(dry.out).toContain("control: RAILWAY_DOCKERFILE_PATH, NODE_ENV, PORT, HOSTNAME, LOBBYSTACK_CONTROL_PASSWORD, DATABASE_URL, CONTROL_ACCESS_TEAM_DOMAIN");
    expect(dry.out).toContain("~ Deploy cloudflared, which connects the tunnel to Cloudflare");
    expect(world.made.size).toBe(0);
    expect(world.cloudflare.calls).toEqual([]);

    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    for (const id of panelSteps) expect(readState().done[id], id).toBeTruthy();
    // Every variable went in before the first deploys, so migrate's first deploy already had the panel's password.
    expect(result.out).not.toContain("run again below");
    expect(world.running.migrate.LOBBYSTACK_CONTROL_PASSWORD).toBe("${{control.LOBBYSTACK_CONTROL_PASSWORD}}");
    expect(world.deployments.migrate).toHaveLength(2);
    expect(world.variables.control.LOBBYSTACK_CONTROL_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(world.deployments.control).toHaveLength(1);
    expect(world.deployments.cloudflared).toHaveLength(1);
    expect(result.out).toContain(`The control panel: https://${panelHost}, for ops@example.com.`);
  });

  it("brings a new CONTROL_ADMIN_EMAILS to Cloudflare Access and to the panel, which deploys again", async () => {
    await controlAfterUp();
    writeSettings(withControl({ CONTROL_ADMIN_EMAILS: "ops@example.com, Owner@Example.com" }));
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("CONTROL_ADMIN_EMAILS changed, so Cloudflare Access and the panel are brought to it.");
    expect(world.cloudflare.policies).toHaveLength(1);
    expect(world.cloudflare.policies[0]?.include).toEqual([{ email: { email: "ops@example.com" } }, { email: { email: "owner@example.com" } }]);
    expect(world.cloudflare.apps).toHaveLength(1);
    expect(world.variables.control.CONTROL_ADMIN_EMAILS).toBe("ops@example.com,owner@example.com");
    expect(result.out).toContain("~ control: CONTROL_ADMIN_EMAILS (Railway deploys it again)");
    expect(world.deployments.control).toHaveLength(2);
    expect(result.out).toContain("= migrate: unchanged");
  });

  it("brings the System health page's variables to a panel set up before they existed, which deploys again", async () => {
    await controlAfterUp();
    // A panel whose variables were set by an older script: without the admin's address and token, and with that
    // script's digest of them.
    const older = readState();
    older.values.CONTROL_VARIABLES = "an older script's digest";
    writeState(older);
    delete world.variables.control.CONTROL_ADMIN_URL;
    delete world.variables.control.FLEET_STATUS_TOKEN;
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("The variables are done already, so they run again below, to bring the panel's.");
    expect(result.out).toContain("~ control: CONTROL_ADMIN_URL, FLEET_STATUS_TOKEN (Railway deploys it again)");
    expect(world.variables.control).toMatchObject({ CONTROL_ADMIN_URL: "http://${{admin.RAILWAY_PRIVATE_DOMAIN}}:3000", FLEET_STATUS_TOKEN: "${{admin.FLEET_STATUS_TOKEN}}" });
    expect(world.deployments.control).toHaveLength(2);
    // The admin keeps its token, so nothing else deploys again.
    expect(result.out).toContain("= admin: unchanged");
    expect(result.out).toContain("= migrate: unchanged");
    expect(readState().values.CONTROL_VARIABLES).not.toBe("an older script's digest");
  });

  it("waits for Zero Trust to be set up by hand, and sets the rest of the deployment up meanwhile", async () => {
    world.cloudflare.organization = null;
    await upWithoutControl();
    writeSettings(withControl());
    const first = await bootstrap(["up", settings(), "--yes"]);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain("Cloudflare Zero Trust isn't set up for the account yet.");
    expect(first.out).toContain(`- control.access: Cloudflare Access in front of ${panelHost}, which lets in ops@example.com`);
    let state = readState();
    for (const id of ["control.services", "control.settings", "control.password", "control.tunnel", "control.dns"]) expect(state.done[id], id).toBeTruthy();
    for (const id of ["control.access", "deploy.control", "deploy.cloudflared"]) expect(state.done[id], id).toBeUndefined();
    // The panel's variables wait for Access's, and migrate's with them.
    expect(world.variables.control).toEqual({});
    expect(world.variables.migrate.LOBBYSTACK_CONTROL_PASSWORD).toBeUndefined();
    expect(world.cloudflare.apps).toEqual([]);

    world.cloudflare.organization = { name: "Acme", auth_domain: teamDomain };
    const second = await bootstrap(["up", settings(), "--yes"]);
    expect(second.code, second.out).toBe(0);
    state = readState();
    for (const id of panelSteps) expect(state.done[id], id).toBeTruthy();
    expect(world.variables.control.CONTROL_ACCESS_TEAM_DOMAIN).toBe(teamDomain);
    expect(world.variables.migrate.LOBBYSTACK_CONTROL_PASSWORD).toBe("${{control.LOBBYSTACK_CONTROL_PASSWORD}}");
    expect(second.out).not.toContain("Still to do by hand");
  });

  it("keeps the panel at its address when CONTROL_HOST changes, until control.tunnel is redone, which moves it", async () => {
    await controlAfterUp();
    writeSettings(withControl({ CONTROL_HOST: "panel.example.com" }));
    const stays = await bootstrap(["up", settings(), "--yes"]);
    expect(stays.code, stays.out).toBe(0);
    expect(stays.out).toContain(`The panel stays at https://${panelHost}, the address its steps were done for, though the settings now give https://panel.example.com.`);
    expect(world.cloudflare.tunnels[0]?.ingress[0]?.hostname).toBe(panelHost);

    const redo = await bootstrap(["redo", settings(), "control.tunnel"]);
    expect(redo.code, redo.out).toBe(0);
    expect(redo.out).toContain("control.dns: runs again next time, to pass on what it uses");
    expect(redo.out).toContain(`forgot the control panel's address, ${panelHost}, so up sets the panel up at panel.example.com, the one the settings give now.`);
    const moved = await bootstrap(["up", settings(), "--yes"]);
    expect(moved.code, moved.out).toBe(0);
    expect(world.cloudflare.tunnels).toHaveLength(1);
    expect(world.cloudflare.tunnels[0]?.ingress).toEqual([{ hostname: "panel.example.com", service: panelOrigin }, { service: "http_status:404" }]);
    expect(world.cloudflare.records.map((record) => record.name).sort()).toEqual(["control-acme-test.example.com", "panel.example.com"]);
    expect(world.cloudflare.apps).toHaveLength(1);
    expect(world.cloudflare.apps[0]?.domain).toBe("panel.example.com");
    expect(readState().values.CONTROL_HOST).toBe("panel.example.com");
    // The same tunnel and application: the panel's variables are as they were, so it doesn't deploy again.
    expect(moved.out).toContain("= control: unchanged");
    expect(world.deployments.control).toHaveLength(1);
  });

  it("finds the services, the password, the tunnel, the policy and the application again when the state file has lost them", async () => {
    await controlAfterUp();
    const made = { tunnel: world.cloudflare.tunnels[0]?.id, policy: world.cloudflare.policies[0]?.id, app: world.cloudflare.apps[0]?.id, password: readState().values.LOBBYSTACK_CONTROL_PASSWORD };
    const lost = readState();
    for (const id of panelSteps) delete lost.done[id];
    for (const key of Object.keys(lost.values).filter((name) => /^CONTROL_|^LOBBYSTACK_CONTROL_/.test(name))) delete lost.values[key];
    lost.values.RAILWAY_SERVICE_IDS = serviceIds;
    writeState(lost);
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("= control\n");
    expect(result.out).toContain("LOBBYSTACK_CONTROL_PASSWORD: found on Railway's control service");
    expect(result.out).toContain(`= the tunnel "acme-test-control-panel"`);
    expect(result.out).toContain(`= the policy "acme-test control panel admins", for ops@example.com`);
    expect(result.out).toContain(`= the application "acme-test control panel"`);
    expect(world.cloudflare.tunnels.map((item) => item.id)).toEqual([made.tunnel]);
    expect(world.cloudflare.policies.map((item) => item.id)).toEqual([made.policy]);
    expect(world.cloudflare.apps.map((item) => item.id)).toEqual([made.app]);
    expect(world.cloudflare.records).toHaveLength(1);
    expect(readState().values.LOBBYSTACK_CONTROL_PASSWORD).toBe(made.password);
    expect(world.variables.control.LOBBYSTACK_CONTROL_PASSWORD).toBe(made.password);
  });

  it("takes the secrets file's password after a redo, and deploys migrate again, which refers to it, to give it to the role", async () => {
    await controlAfterUp();
    const own = "c".repeat(64);
    writeSettings(withControl(), { LOBBYSTACK_CONTROL_PASSWORD: own });
    const redo = await bootstrap(["redo", settings(), "control.password"]);
    expect(redo.code, redo.out).toBe(0);
    expect(redo.out).toContain("variables: runs again next time, to pass on what it uses");
    const migrate = world.deployments.migrate.length;
    const result = await bootstrap(["up", settings(), "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(readState().values.LOBBYSTACK_CONTROL_PASSWORD).toBe(own);
    expect(world.variables.control.LOBBYSTACK_CONTROL_PASSWORD).toBe(own);
    expect(result.out).toContain("~ control: LOBBYSTACK_CONTROL_PASSWORD (Railway deploys it again)");
    expect(result.out).toContain("~ migrate: deployed again, for the new values of control that it refers to");
    expect(world.deployments.migrate).toHaveLength(migrate + 1);
    expect(result.out).not.toContain(own);
    expect(logText()).not.toContain(own);
  });

  it("says that the panel keeps running after CONTROL goes back to no, since the script deletes nothing", async () => {
    await controlAfterUp();
    writeSettings({ CLOUDFLARE_ZONE: cloudflareZone, CLOUDFLARE_ACCOUNT_ID: cloudflareAccount });
    const calls = world.cloudflare.calls.length;
    const up = await bootstrap(["up", settings(), "--yes"]);
    expect(up.code, up.out).toBe(0);
    expect(up.out).toContain(`Nothing asks for the control panel any more (CONTROL isn't yes in ${settings()}), but an earlier run set it up at https://${panelHost}`);
    expect(world.cloudflare.calls).toHaveLength(calls);
    expect(world.variables.control.CONTROL_ACCESS_AUD).toBeTruthy();
    expect((await bootstrap(["status", settings()])).out).toContain("control panel: Nothing asks for the control panel any more");
  });
});
