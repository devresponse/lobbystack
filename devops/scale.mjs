#!/usr/bin/env node
// scale.mjs: runs more copies of the admin and the worker on Railway, or fewer, after the checks
// the deployment guide asks for before a second copy (docs/deployment/guide/part-7-operations.md,
// 7.24). Railway calls the copies replicas. Every copy runs the same release with the same
// variables: Railway spreads the admin's visitors over its copies, and the admin spreads new calls
// over the worker's. Railway starts the copies from the release that's running, without a build,
// but it replaces the running copies too, as a deploy does (seen on its first run, on 2026-11-20),
// and gives each copy it stops the service's draining time to finish. Postgres, Redis and migrate
// stay at one copy.
//
//   node devops/scale.mjs                      how many copies run, how busy each one is, and what more would need
//   node devops/scale.mjs admin=2 worker=2     two of each
//   node devops/scale.mjs worker+1             one more worker (worker-1: one fewer)
//   node devops/scale.mjs admin=1 worker=1     back to one of each
//
// Options:
//   --max-connections <n>    what `show max_connections;` says in the database, instead of a question
//   --dry-run                run the checks and show the change; change nothing
//   --yes                    ask nothing; a check that fails still stops the change
//   --no-wait                don't wait for new copies to start
//   --admin-service <name>   the admin's service name in Railway, when it isn't admin
//   --worker-service <name>  the worker's, when it isn't worker
//   --bootstrap <settings file>   a deployment devops/bootstrap.mjs made: its state file names the
//                            project, the environment and the services
//   --project <id> [--environment <name>]   with an account or workspace token
//   --status-url <address>   the dashboard's address, for what the copies report about themselves,
//                            when APP_BASE_URL and Railway's domains don't give it
//
// With no change asked for, it shows the copies each service runs and then how busy they are, from
// two places. Railway's metrics give each copy's processor and memory. The admin's fleet status
// address (GET /api/internal/fleet, docs/features/observability.md) gives what every copy reports
// about itself every 10 seconds: whether it runs, how busy its one thread is, its memory, its
// database connections, a worker's calls and jobs, and each queue's jobs. A copy that went silent is
// named as a problem, and a copy that died in the last 24 hours is listed with what it reported
// last. The script asks that address with the admin's FLEET_STATUS_TOKEN, which it reads from the
// admin's variables, sends only to that address over HTTPS, and never prints.
// Neither part stops the run: where Railway or the admin doesn't answer, it says so and goes on.
//
// It needs a Railway token, which it reads from the environment or asks for, and never saves or
// prints. By default that's a project token, which belongs to one environment of one project (in
// Railway, open the project, then Settings > Tokens), from RAILWAY_TOKEN, as devops/railway-vars.mjs
// takes it. With --bootstrap or --project it's an account or workspace token (railway.com/account/tokens)
// from RAILWAY_API_TOKEN, and with --bootstrap also from the settings file's .secrets file, as
// bootstrap.mjs reads it.
//
// Before it adds a copy, it checks:
//   - the release: both services' running commits have the replica fixes of fork PR #168, which added
//     packages/db/src/pool-budget.ts with them. It looks in this Git checkout, then on GitHub.
//   - the database's connections: each copy can open the sum of its …_POOL_MAX variables (the code's
//     defaults when they're unset), and during a release the old copies keep theirs while they finish,
//     so twice every copy has to fit under max_connections, less the 3 PostgreSQL keeps for itself.
//     Up to 97 fits PostgreSQL's default of 100; past that it asks what the database allows.
//   - that Railway can run copies of the service: none for a service with a volume. It changes only a
//     service that runs in one region.
// Before it adds or takes away a copy, it checks the time a copy has to finish when Railway takes it
// away or replaces it: RAILWAY_DEPLOYMENT_DRAINING_SECONDS, 60 on the admin and 1860 on the worker.
// It reads the admin's and the worker's variables only for these checks, and for the admin's address
// and the token of its fleet status address, and never prints them. It never reads the database's
// variables and never signs in to the database.
//
// The change is the one Railway's own CLI makes for `railway scale` (railwayapp/cli 5.74.0,
// 2026-11-13): one environmentPatchCommit that sets the services' deploy.multiRegionConfig, read from
// their latest deployment's serviceManifest. Node 18 or later, nothing to install.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// The SCALE_* variables exist for tests against stand-ins.
const ENDPOINT = process.env.SCALE_RAILWAY_URL ?? "https://backboard.railway.com/graphql/v2";
// A stand-in admin answers over plain HTTP on this computer. Anywhere else the token needs HTTPS.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const GITHUB_RAW = process.env.SCALE_GITHUB_URL ?? "https://raw.githubusercontent.com";
const REPO_ROOT = process.env.SCALE_GIT_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLL_MS = Number(process.env.SCALE_POLL_MS ?? 5000);
const WAIT_MS = Number(process.env.SCALE_WAIT_MS ?? 10 * 60_000);

// Fork PR #168 added this file with the three fixes copies need, so a release that has it has them.
const FIX_FILE = "packages/db/src/pool-budget.ts";
const FIX_PR = "fork PR #168";
// PostgreSQL's default max_connections, and the connections it keeps for superusers.
const DEFAULT_MAX_CONNECTIONS = 100;
const RESERVED_CONNECTIONS = 3;
// The most copies Railway runs of one service.
const MAX_COPIES = 50;
// Each service's pools, one per database role, as packages/db/src/pool-budget.ts counts them:
// <ROLE>_POOL_MAX, else 12, and 4 for the dispatcher.
const ROLES = {
  admin: ["lobbystack_app", "lobbystack_auth", "lobbystack_worker", "lobbystack_dispatcher", "lobbystack_finance_export"],
  worker: ["lobbystack_worker", "lobbystack_dispatcher"],
};
const DEFAULT_POOL_MAX = 12;
const DEFAULT_DISPATCHER_POOL_MAX = 4;
// The draining time each needs (guide 7.4): the admin a minute to finish its requests, the worker
// longer than a call can last, 30 minutes, with its goodbye.
const DRAINING = { admin: 60, worker: 1860 };
// How far back Railway's metrics are read for each copy's newest processor and memory figures.
const METRICS_WINDOW_MS = 5 * 60_000;
const FLEET_STATUS_PATH = "/api/internal/fleet";

const PROJECT_TOKEN_QUERY = `query ProjectToken {
  projectToken {
    project { id name }
    environment { id name }
  }
}`;

const PROJECT_QUERY = `query Project($id: String!) {
  project(id: $id) {
    id
    name
    services { edges { node { id name } } }
    environments { edges { node { id name } } }
  }
}`;

const VOLUMES_QUERY = `query EnvironmentVolumes($environmentId: String!, $projectId: String) {
  environment(id: $environmentId, projectId: $projectId) {
    volumeInstances { edges { node { serviceId mountPath } } }
  }
}`;

// A deployment's meta names its commit, and under serviceManifest.deploy its regions and copies.
const INSTANCE_QUERY = `query ServiceInstance($environmentId: String!, $serviceId: String!) {
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    region
    numReplicas
    drainingSeconds
    sleepApplication
    latestDeployment { id status createdAt meta instances { status } }
    activeDeployments { id status createdAt meta instances { status } }
  }
}`;

// Unrendered, so a reference reads back as ${{...}}, not as the value it points to.
const VARIABLES_QUERY = `query ServiceVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
}`;

// One series for each copy (Railway's deployment instance) and measurement: processors in use, and memory in GB.
const METRICS_QUERY = `query ReplicaMetrics($environmentId: String!, $serviceId: String!, $startDate: DateTime!) {
  metrics(environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, measurements: [CPU_USAGE, MEMORY_USAGE_GB], groupBy: [DEPLOYMENT_INSTANCE_ID], sampleRateSeconds: 60, averagingWindowSeconds: 60) {
    measurement
    tags { deploymentInstanceId }
    values { ts value }
  }
}`;

const DOMAINS_QUERY = `query ServiceDomains($projectId: String!, $environmentId: String!, $serviceId: String!) {
  domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
    serviceDomains { domain }
    customDomains { domain }
  }
}`;

const PATCH_MUTATION = `mutation EnvironmentPatchCommit($environmentId: String!, $patch: EnvironmentConfig, $commitMessage: String) {
  environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage)
}`;

const WORKFLOW_QUERY = `query WorkflowStatus($workflowId: String!) {
  workflowStatus(workflowId: $workflowId) { status error }
}`;

class Stop extends Error {}

const options = parseArgs(process.argv.slice(2));
let auth = null;
let prompter = null;
let changed = false;

main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    if (!changed) console.error("Nothing was changed.");
    process.exitCode = 1;
  })
  .finally(() => prompter?.close());

async function main() {
  if (typeof fetch !== "function") throw new Error("this script needs Node 18 or later");
  const where = await connect();
  console.log(`Railway project ${where.project.name}, environment ${where.environment.name}`);
  const volumes = await readVolumes(where);
  const services = [];
  for (const role of ["admin", "worker"]) services.push(await readService(where, role, volumes));
  console.log("");
  for (const service of services) printService(service);

  if (!options.changes.length) {
    await printCopies(where, services);
    await printFleet(where, services);
    printNeeds(services);
    return;
  }
  const plans = plan(services);
  const moving = plans.filter((item) => item.to !== item.from);
  console.log("");
  if (!moving.length) {
    console.log(`Nothing to change: ${listNames(plans.filter((item) => options.changes.some((c) => c.role === item.role)).map((item) => `${item.name} has ${copies(item.to)}`))} already.`);
    return;
  }
  console.log(moving.map((item) => `${item.name}: ${item.from} to ${copies(item.to)}`).join(", "));
  console.log("\nChecks");
  const findings = await check(plans);
  if (findings.some((finding) => finding.level === "stop")) throw new Stop("a check failed (stop above), so the copies stay as they are.");

  if (options.dryRun) {
    console.log("\nDry run: nothing was changed. Run the same command without --dry-run to change the copies.");
    return;
  }
  const what = listNames(moving.map((item) => `${item.name} from ${item.from} to ${copies(item.to)}`));
  if (!options.yes) {
    const adding = moving.some((item) => item.to > item.from);
    const removing = moving.filter((item) => item.to < item.from);
    const notes = [
      adding ? "Railway starts the copies from the release that's running and replaces the running ones, as a deploy does: they get the service's draining time to finish." : "",
      removing.length ? `Each copy Railway takes away gets ${listNames(removing.map((item) => `${item.name}'s ${item.draining} s`))} to finish first.` : "",
    ].filter(Boolean).join(" ");
    const answer = await ask(`\nChange ${what} in ${where.project.name} (${where.environment.name})? ${notes} Type yes to continue: `);
    if (answer.toLowerCase() !== "yes") {
      console.log("Nothing changed.");
      return;
    }
  }

  const patch = { services: {} };
  for (const item of moving) {
    patch.services[item.id] = { deploy: { multiRegionConfig: { ...regionConfig(item.regions), [item.region]: { numReplicas: item.to } } } };
  }
  const message = `Scale ${listNames(moving.map((item) => `${item.name} to ${copies(item.to)}`))} (devops/scale.mjs)`;
  const data = await gql(PATCH_MUTATION, { environmentId: where.environment.id, patch, commitMessage: message }, { mutation: true });
  changed = true;
  console.log(`\nDone: Railway is changing ${what}.`);
  await waitForWorkflow(data?.environmentPatchCommit);

  const growing = moving.filter((item) => item.to > item.from);
  if (growing.length && options.wait) await waitForCopies(where, growing);
  for (const item of moving.filter((entry) => entry.to < entry.from)) {
    console.log(`${item.name}: Railway takes ${item.from - item.to === 1 ? "a copy" : `${item.from - item.to} copies`} away, each after up to ${item.draining} s to finish what it started.`);
  }
  console.log("\nRun node devops/scale.mjs again, with the same token or options, to see the copies.");
}

// ---------------------------------------------------------------- reading the deployment

/** The project, its environment, and the admin's and the worker's services, by token kind. */
async function connect() {
  const accountToken = Boolean(options.bootstrap || options.project);
  if (!accountToken && !process.env.RAILWAY_TOKEN?.trim() && process.env.RAILWAY_API_TOKEN?.trim()) {
    console.log("RAILWAY_API_TOKEN holds an account or workspace token, which this script takes with --bootstrap or --project; without them it asks for a project token.");
  }
  if (!accountToken) {
    const token = process.env.RAILWAY_TOKEN?.trim() || (await ask("Railway project token (typing is hidden): ", { hidden: true }));
    if (!token) throw new Stop("no token given");
    auth = { kind: "project", headers: { "project-access-token": token } };
    const { projectToken } = await gql(PROJECT_TOKEN_QUERY);
    const project = await readProject(projectToken.project.id);
    return { project, environment: projectToken.environment, services: findServices(project) };
  }

  const state = options.bootstrap ? readBootstrapState(options.bootstrap) : null;
  const token = process.env.RAILWAY_API_TOKEN?.trim() || (state && secretFromFile(`${options.bootstrap}.secrets`, "RAILWAY_API_TOKEN"))
    || (await ask("Railway account or workspace token (typing is hidden): ", { hidden: true }));
  if (!token) throw new Stop("no token given");
  auth = { kind: "account", headers: { authorization: `Bearer ${token}` } };
  const project = await readProject(state?.RAILWAY_PROJECT_ID ?? options.project);
  const environments = project.environments.edges.map((edge) => edge.node);
  const wanted = state?.RAILWAY_ENVIRONMENT_ID ?? options.environment;
  const environment = wanted
    ? environments.find((item) => item.id === wanted || item.name.toLowerCase() === wanted.toLowerCase())
    : environments.length === 1 ? environments[0] : undefined;
  if (!environment) {
    const known = `Its environments are ${environments.map((item) => `"${item.name}"`).join(", ") || "none"}.`;
    throw new Stop(wanted ? `${project.name} has no environment ${wanted}. ${known}` : `${project.name} has more than one environment: name one with --environment. ${known}`);
  }
  if (!state) return { project, environment, services: findServices(project) };
  const ids = state.RAILWAY_SERVICE_IDS ?? {};
  const byId = (id) => project.services.edges.map((edge) => edge.node).find((service) => service.id === id);
  const services = { admin: byId(ids.admin), worker: byId(ids.worker) };
  for (const role of ["admin", "worker"]) {
    if (!services[role]) throw new Stop(`${project.name} has no ${role} service with the ID ${options.bootstrap}.state.json names (${ids[role] ?? "none"}). Was it deleted, or the project made again? Run bootstrap's up first`);
  }
  return { project, environment, services };
}

async function readProject(id) {
  const { project } = await gql(PROJECT_QUERY, { id });
  if (!project) throw new Stop(`Railway has no project ${id}`);
  return project;
}

function findServices(project) {
  const services = project.services.edges.map((edge) => edge.node);
  const find = (name) => services.find((service) => service.name.toLowerCase() === name.toLowerCase());
  const found = { admin: find(options.names.admin), worker: find(options.names.worker) };
  const missing = ["admin", "worker"].filter((role) => !found[role]);
  if (missing.length) {
    const known = services.length ? `Its services are ${services.map((service) => `"${service.name}"`).join(", ")}.` : "It has no services.";
    const flags = missing.map((role) => `--${role}-service <name>`).join(" and ");
    throw new Stop(`${project.name} has no service named ${missing.map((role) => `"${options.names[role]}"`).join(" or ")}. ${known} Name ${missing.length > 1 ? "them" : "it"} with ${flags}.`);
  }
  return found;
}

/** The IDs devops/bootstrap.mjs keeps in <settings file>.state.json. */
function readBootstrapState(file) {
  const stateFile = path.join(path.dirname(file), `${path.basename(file)}.state.json`);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    throw new Stop(error.code === "ENOENT" ? `${stateFile} doesn't exist. Give --bootstrap the settings file bootstrap's up ran with, such as .env.bootstrap-<name>` : `couldn't read ${stateFile} (${error.code ?? error.message})`);
  }
  const values = state?.values ?? {};
  if (!values.RAILWAY_PROJECT_ID || !values.RAILWAY_ENVIRONMENT_ID || !values.RAILWAY_SERVICE_IDS) {
    throw new Stop(`${stateFile} names no Railway project, environment and services yet: run bootstrap's up first`);
  }
  return values;
}

/** One KEY=value line's value from a secrets file, as bootstrap.mjs reads it; empty, ?, <placeholders> and ${{references}} don't count. */
function secretFromFile(file, key) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  let found = "";
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    const equals = line.indexOf("=");
    if (line.startsWith("#") || equals < 1 || line.slice(0, equals).trim() !== key) continue;
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (value && value !== "?" && !/^<[^>]*>$/.test(value) && !value.includes("${{")) found = value;
  }
  return found;
}

async function readVolumes(where) {
  const { environment } = await gql(VOLUMES_QUERY, { environmentId: where.environment.id, projectId: where.project.id });
  return (environment?.volumeInstances?.edges ?? []).map((edge) => edge.node);
}

async function readInstance(where, serviceId, name) {
  try {
    const { serviceInstance } = await gql(INSTANCE_QUERY, { environmentId: where.environment.id, serviceId });
    if (serviceInstance) return serviceInstance;
  } catch (error) {
    if (!/not found/i.test(error.message)) throw error;
  }
  throw new Stop(`${name} isn't in the environment ${where.environment.name}`);
}

async function readService(where, role, volumes) {
  const { id, name } = where.services[role];
  const instance = await readInstance(where, id, name);
  const { variables } = await gql(VARIABLES_QUERY, { projectId: where.project.id, environmentId: where.environment.id, serviceId: id });
  const deployment = currentDeployment(instance);
  const regions = regionsOf(instance);
  const pools = poolsOf(role, variables ?? {});
  const draining = drainingOf(variables ?? {}, instance);
  // Only these few facts are kept; the variables themselves go no further.
  return {
    role, id, name, instance, deployment, regions, pools, draining,
    // The admin's own address and the token of its fleet status address, when they are plain values.
    ...(role === "admin" ? { baseUrl: addressOf(variables?.APP_BASE_URL), statusToken: plainValue(variables?.FLEET_STATUS_TOKEN) } : {}),
    configured: regions ? Object.values(regions).reduce((sum, count) => sum + count, 0) : null,
    running: runningCopies(instance),
    volume: volumes.find((volume) => volume.serviceId === id)?.mountPath ?? null,
    sleeps: instance.sleepApplication === true,
    commit: commitOf(deployment?.meta),
    branch: metaOf(deployment)?.branch ?? null,
    repo: repoOf(metaOf(deployment)),
  };
}

function metaOf(deployment) {
  let meta = deployment?.meta ?? null;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = null;
    }
  }
  return meta && typeof meta === "object" ? meta : null;
}

/** The deployment that's serving: the latest when it succeeded, else the newest active one. */
function currentDeployment(instance) {
  if (instance.latestDeployment?.status === "SUCCESS") return instance.latestDeployment;
  const active = (instance.activeDeployments ?? []).filter((deployment) => deployment.status === "SUCCESS");
  active.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return active[0] ?? instance.latestDeployment ?? null;
}

function runningCopies(instance) {
  return (currentDeployment(instance)?.instances ?? []).filter((item) => item.status === "RUNNING").length;
}

/**
 * The service's copies in each region, as `railway scale` reads them: the latest deployment's
 * deploy.multiRegionConfig, else its region and numReplicas (older deployments), else the instance's.
 */
function regionsOf(instance) {
  for (const deployment of [instance.latestDeployment, currentDeployment(instance)]) {
    const deploy = metaOf(deployment)?.serviceManifest?.deploy;
    if (!deploy || typeof deploy !== "object") continue;
    const multi = deploy.multiRegionConfig;
    if (multi && typeof multi === "object") {
      const regions = Object.entries(multi).filter(([, value]) => value && value.numReplicas !== 0);
      if (regions.length) return Object.fromEntries(regions.map(([region, value]) => [region, Number(value.numReplicas ?? 1)]));
    }
    if (deploy.region) return { [deploy.region]: Number(deploy.numReplicas ?? 1) };
  }
  if (instance.region) return { [instance.region]: Number(instance.numReplicas ?? 1) };
  return null;
}

function regionConfig(regions) {
  return Object.fromEntries(Object.entries(regions).map(([region, count]) => [region, { numReplicas: count }]));
}

function commitOf(meta) {
  const parsed = typeof meta === "string" ? metaOf({ meta }) : meta;
  const commit = parsed?.commitHash ?? parsed?.commitSha ?? null;
  return typeof commit === "string" && /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : null;
}

function repoOf(meta) {
  const repo = String(meta?.repo ?? "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

/** One copy's connections: the sum of its pools, null when a …_POOL_MAX isn't a whole number. */
function poolsOf(role, variables) {
  let total = 0;
  const unset = [];
  const unreadable = [];
  for (const databaseRole of ROLES[role]) {
    const name = `${databaseRole.toUpperCase()}_POOL_MAX`;
    const raw = String(variables[name] ?? "").trim();
    if (!raw) {
      unset.push(name);
      total += databaseRole === "lobbystack_dispatcher" ? DEFAULT_DISPATCHER_POOL_MAX : DEFAULT_POOL_MAX;
      continue;
    }
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 1) total += value;
    else unreadable.push(name);
  }
  return { total: unreadable.length ? null : total, unset, unreadable };
}

/** A variable's value when it is one: not empty, and not a reference to another variable. */
function plainValue(raw) {
  const value = String(raw ?? "").trim();
  return value && !value.includes("${{") ? value : null;
}

/** An address a variable holds as a plain value, without a closing slash. */
function addressOf(raw) {
  const value = plainValue(raw);
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/** RAILWAY_DEPLOYMENT_DRAINING_SECONDS when it's a number, else the service's draining setting. */
function drainingOf(variables, instance) {
  const raw = String(variables.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? "").trim();
  if (raw && Number.isFinite(Number(raw))) return Number(raw);
  return Number(instance.drainingSeconds) || 0;
}

// ---------------------------------------------------------------- showing it

function printService(service) {
  const where = service.regions ? ` in ${Object.entries(service.regions).map(([region, count]) => (Object.keys(service.regions).length > 1 ? `${region} (${count})` : region)).join(", ")}` : "";
  const count = service.configured ?? service.running;
  const running = service.configured !== null && service.running !== service.configured ? `, ${service.running} running` : "";
  const deployment = service.deployment?.status && service.deployment.status !== "SUCCESS" ? `, latest deployment ${service.deployment.status.toLowerCase()}` : "";
  const release = service.commit ? `, release ${service.commit.slice(0, 7)}${service.branch ? ` (${service.branch})` : ""}` : "";
  console.log(`${service.name.padEnd(8)} ${copies(count)}${running}${where}${release}${deployment}`);
  const pools = service.pools.total === null
    ? `${service.pools.unreadable.join(", ")} isn't a whole number`
    : `${service.pools.total} database connections a copy${service.pools.unset.length === ROLES[service.role].length ? " (the code's defaults: no …_POOL_MAX variables)" : service.pools.unset.length ? ` (${service.pools.unset.join(", ")} unset)` : ""}`;
  console.log(`${"".padEnd(8)} ${pools}, ${service.draining} s to finish when a copy stops`);
}

function printNeeds(services) {
  const [admin, worker] = services;
  if (admin.pools.total === null || worker.pools.total === null || admin.configured === null || worker.configured === null) return;
  const now = duringRelease(admin.configured, worker.configured, admin.pools.total, worker.pools.total);
  const twoEach = duringRelease(Math.max(2, admin.configured), Math.max(2, worker.configured), admin.pools.total, worker.pools.total);
  console.log("");
  console.log(`These copies can hold up to ${now} database connections while a release replaces them.`);
  if (admin.configured < 2 || worker.configured < 2) {
    const usable = DEFAULT_MAX_CONNECTIONS - RESERVED_CONNECTIONS;
    console.log(`${Math.max(2, admin.configured)} admins and ${Math.max(2, worker.configured)} workers could hold up to ${twoEach}${twoEach <= usable ? `, within PostgreSQL's default of ${DEFAULT_MAX_CONNECTIONS}` : `, so the database's max_connections must be ${twoEach + RESERVED_CONNECTIONS} or more`} (guide 7.24).`);
  }
  console.log("Change the copies with node devops/scale.mjs admin=<n> worker=<n>, or worker+1 and worker-1.");
}

// ---------------------------------------------------------------- how busy the copies are

/** Each copy's newest processor and memory figures from Railway's metrics. Says so and goes on when Railway gives none. */
async function printCopies(where, services) {
  const startDate = new Date(Date.now() - METRICS_WINDOW_MS).toISOString();
  const lines = [];
  console.log("");
  for (const service of services) {
    let series;
    try {
      series = (await gql(METRICS_QUERY, { environmentId: where.environment.id, serviceId: service.id, startDate }, { plain: true })).metrics;
    } catch (error) {
      console.log(`Railway didn't give each copy's processor and memory (${error.message}). Each service's Metrics tab in Railway shows them.`);
      return;
    }
    const found = new Map();
    for (const item of Array.isArray(series) ? series : []) {
      const newest = (Array.isArray(item?.values) ? item.values : []).reduce((latest, point) => (Number.isFinite(Number(point?.value)) && (!latest || Number(point.ts) >= Number(latest.ts)) ? point : latest), null);
      if (!newest) continue;
      const id = String(item.tags?.deploymentInstanceId ?? "");
      const figures = found.get(id) ?? {};
      if (item.measurement === "CPU_USAGE") figures.cpu = Number(newest.value);
      if (item.measurement === "MEMORY_USAGE_GB") figures.memoryGb = Number(newest.value);
      found.set(id, figures);
    }
    for (const [id, figures] of found) {
      const cpu = figures.cpu === undefined ? "" : `${figures.cpu.toFixed(2)} vCPU`;
      const memory = figures.memoryGb === undefined ? "" : `${Math.round(figures.memoryGb * 1024)} MB`;
      lines.push(`  ${service.name.padEnd(8)} ${(id ? shortId(id) : "all copies").padEnd(10)} ${cpu.padStart(10)}  ${memory.padStart(8)}`);
    }
  }
  if (!lines.length) {
    console.log("Railway has no processor and memory figures for these copies yet. Each service's Metrics tab in Railway shows them.");
    return;
  }
  console.log("Each copy's processor and memory, as Railway measured them last:");
  for (const line of lines) console.log(line);
}

/** What the copies report about themselves, from the admin's fleet status address. Says so and goes on when it can't be asked. */
async function printFleet(where, services) {
  const [admin, worker] = services;
  const hidden = "What the copies report about themselves isn't shown";
  console.log("");
  if (!admin.statusToken) {
    console.log(`${hidden}: the admin has no FLEET_STATUS_TOKEN of its own (guide 7.10).`);
    return;
  }
  const base = options.statusUrl || admin.baseUrl || (await publicAddress(where, admin));
  if (!base) {
    console.log(`${hidden}: the admin's address isn't known. Give it with --status-url https://<the dashboard's address>.`);
    return;
  }
  let url;
  try {
    url = new URL(`${base.replace(/\/+$/, "")}${FLEET_STATUS_PATH}`);
  } catch {
    console.log(`${hidden}: ${base} isn't an address.`);
    return;
  }
  if (url.protocol !== "https:" && !LOCAL_HOSTS.has(url.hostname)) {
    console.log(`${hidden}: ${url.origin} isn't an HTTPS address, so the token isn't sent to it.`);
    return;
  }
  // As many running copies as Railway is set to run, so a copy that never reported counts as missing.
  for (const service of [admin, worker]) if (service.configured) url.searchParams.set(service.role, String(Math.min(service.configured, MAX_COPIES)));
  let response;
  let body;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${admin.statusToken}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    body = parseJson(await response.text());
  } catch (error) {
    console.log(`${hidden}: ${url.origin} couldn't be reached (${error.cause?.code ?? error.message}).`);
    return;
  }
  const address = `${url.origin}${FLEET_STATUS_PATH}`;
  if (response.status === 404) {
    console.log(`${hidden}: ${address} answers 404. The admin's release is from before the fleet status address, or the admin started before FLEET_STATUS_TOKEN was set, or the token has fewer than 32 characters. A variable takes effect at the admin's next deploy.`);
    return;
  }
  if (response.status === 401) {
    console.log(`${hidden}: ${address} refused the token. The running admin has another FLEET_STATUS_TOKEN than its variables hold now: deploy the admin.`);
    return;
  }
  if (!Array.isArray(body?.copies)) {
    console.log(`${hidden}: ${address} answered ${response.status}${Array.isArray(body?.problems) && body.problems.length ? `: ${body.problems.join(" ")}` : body?.error ? `: ${body.error}` : ""}`);
    return;
  }
  console.log(`What the copies report about themselves (${address}):`);
  const now = Date.parse(body.checkedAt) || Date.now();
  for (const copy of body.copies) console.log(`  ${describeCopy(copy, now)}`);
  console.log(`  ${describeQueues(body.queues, body.queuesCountedSecondsAgo)}`);
  const problems = Array.isArray(body.problems) ? body.problems : [];
  if (!problems.length) console.log("  Every copy reports in.");
  for (const problem of problems) console.log(`  Problem: ${problem}`);
  // An admin from before the list of copies that died sends none.
  const died = Array.isArray(body.died) ? body.died : [];
  if (!died.length) return;
  console.log("Copies that died in the last 24 hours, each with what it reported last:");
  for (const copy of died) console.log(`  ${describeCopy(copy, now)}`);
  const all = Object.values(body.services ?? {}).reduce((sum, service) => sum + (Number(service?.died) || 0), 0);
  if (all > died.length) console.log(`  ${count(all - died.length, "older one")} ${all - died.length === 1 ? "isn't" : "aren't"} listed.`);
}

/** The admin's address from Railway: its own domain first, else the one Railway gave the service. */
async function publicAddress(where, admin) {
  try {
    const { domains } = await gql(DOMAINS_QUERY, { projectId: where.project.id, environmentId: where.environment.id, serviceId: admin.id }, { plain: true });
    const domain = domains?.customDomains?.[0]?.domain ?? domains?.serviceDomains?.[0]?.domain;
    return typeof domain === "string" && /^[a-z0-9.-]+$/i.test(domain) ? `https://${domain}` : null;
  } catch {
    return null;
  }
}

function describeCopy(copy, now) {
  const seen = Number(copy.lastSeenSecondsAgo) || 0;
  const state = {
    running: "running",
    not_ready: "not ready",
    draining: `shutting down for ${span(Number(copy.drainingForSeconds) || 0)}`,
    silent: `silent for ${span(seen)}`,
    left: `left ${span(seen)} ago`,
    died: `died ${span(seen)} ago`,
  }[copy.state] ?? String(copy.state);
  const parts = [
    `${String(copy.service).padEnd(8)} ${shortId(String(copy.replica)).padEnd(10)} ${state.padEnd(24)}`,
    `busy ${String(Math.round((Number(copy.busy) || 0) * 100)).padStart(3)}%`,
    `${String(Math.round((Number(copy.rssBytes) || 0) / 1_048_576)).padStart(5)} MB`,
  ];
  if (copy.db) parts.push(`${copy.db.inUse} of ${copy.db.max} connections${copy.db.waiting ? `, ${copy.db.waiting} waiting` : ""}`);
  if (copy.service === "worker") parts.push(`${count(Number(copy.liveCalls) || 0, "call")}, ${count(Number(copy.activeJobs) || 0, "job")}`);
  const started = Date.parse(copy.startedAt);
  // A copy that stopped ran until its last report, not until now.
  const stopped = ["silent", "left", "died"].includes(copy.state);
  if (Number.isFinite(started)) parts.push(`${stopped ? "ran" : "up"} ${span(Math.max(0, Math.round((now - started) / 1000) - (stopped ? seen : 0)))}`);
  // The moment to look for in the host's logs.
  if (copy.state === "died") {
    const last = Date.parse(copy.lastSeenAt);
    parts.push(`last report ${new Date(Number.isFinite(last) ? last : now - seen * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`);
  }
  return parts.join("   ");
}

function describeQueues(queues, countedSecondsAgo) {
  if (!queues || typeof queues !== "object") return "Queues: no worker reports them.";
  const busy = Object.entries(queues).flatMap(([name, jobs]) => {
    const parts = [jobs.waiting ? `${jobs.waiting} waiting` : "", jobs.active ? `${jobs.active} running` : "", jobs.delayed ? `${jobs.delayed} scheduled` : ""].filter(Boolean);
    return parts.length ? [`${name} ${parts.join(", ")}`] : [];
  });
  const counted = Number.isFinite(Number(countedSecondsAgo)) ? ` (counted ${span(Number(countedSecondsAgo))} ago)` : "";
  return busy.length ? `Queues: ${busy.join("; ")}${counted}.` : `Queues: no job waiting, running or scheduled${counted}.`;
}

/** Railway's copy IDs are UUIDs, which their first eight characters tell apart. Any other name, such as a host's, stays whole. */
function shortId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id;
}

function count(number, noun) {
  return `${number} ${noun}${number === 1 ? "" : "s"}`;
}

function span(seconds) {
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}

// ---------------------------------------------------------------- the change and its checks

function plan(services) {
  return services.map((service) => {
    const change = options.changes.find((item) => item.role === service.role);
    if (!change) return { ...service, from: service.configured, to: service.configured };
    if (service.configured === null) throw new Stop(`${service.name} hasn't been deployed in this environment, so it has no region to run copies in. Deploy it first`);
    const to = change.op === "=" ? change.count : change.op === "+" ? service.configured + change.count : service.configured - change.count;
    if (to < 1) throw new Stop(`${service.name} would have ${to} copies. One is the fewest this script leaves: to stop a service, use its menu in Railway`);
    if (to > MAX_COPIES) throw new Stop(`${service.name} would have ${to} copies, and Railway runs at most ${MAX_COPIES} of a service`);
    const region = Object.keys(service.regions)[0];
    return { ...service, from: service.configured, to, region };
  });
}

/** Each finding is printed as it's known; "stop" ones keep the copies as they are. */
async function check(plans) {
  const findings = [];
  const say = (level, text) => {
    findings.push({ level, text });
    console.log(`  ${level.padEnd(5)} ${text}`);
  };
  const moving = plans.filter((item) => item.to !== item.from);
  const adding = moving.some((item) => item.to > item.from);

  for (const item of moving) {
    if (item.volume) say("stop", `${item.name} has a volume at ${item.volume}, and Railway runs no copies of a service with a volume.`);
    if (Object.keys(item.regions).length > 1) {
      say("stop", `${item.name} runs in ${Object.keys(item.regions).length} regions (${Object.entries(item.regions).map(([region, count]) => `${region} ${count}`).join(", ")}), and this script changes a service that runs in one. Change it under its Settings in Railway.`);
    }
  }

  if (adding) {
    // The admin spreads calls over the worker's copies, and both open the pools, so both releases count.
    for (const item of plans) {
      if (!item.commit) {
        say("note", `${item.name}'s running deployment names no Git commit, so the script can't tell whether it has the replica fixes (${FIX_PR}). Check that its release includes them (guide 7.24, step 1).`);
        continue;
      }
      const has = await hasFixes(item.commit, item.repo);
      const release = `${item.commit.slice(0, 7)}${item.branch ? ` from ${item.branch}` : ""}`;
      if (has === true) say("ok", `${item.name} runs ${release}, which has the replica fixes (${FIX_PR}).`);
      else if (has === false) say("stop", `${item.name} runs ${release}, which doesn't have the replica fixes (${FIX_PR}): copies would run out of database connections and the admin would send every call to one worker. Deploy a release with them first (guide 7.24, step 1).`);
      else say("note", `${item.name} runs ${release}, and neither this Git checkout nor GitHub could say whether that has the replica fixes (${FIX_PR}). Check that its release includes them (guide 7.24, step 1).`);
    }
    for (const item of plans.filter((entry) => entry.to > entry.from && entry.sleeps)) {
      say("note", `${item.name} sleeps when it's idle (Serverless in its Settings). A production service never should: a call that comes in while it sleeps waits for it to start.`);
    }
    await checkConnections(plans, say, findings);
  }

  for (const item of moving) {
    const needed = DRAINING[item.role];
    if (item.draining >= needed) {
      say("ok", `${item.name} has ${item.draining} s to finish when a copy stops (RAILWAY_DEPLOYMENT_DRAINING_SECONDS).`);
      continue;
    }
    const harm = item.role === "worker"
      ? item.draining ? `a worker copy that stops ends the calls still on it after ${item.draining} s` : "a worker copy that stops cuts the calls on it at once, probably before the receptionist's goodbye"
      : item.draining ? `an admin copy that stops fails the requests still running after ${item.draining} s` : "an admin copy that stops fails the requests it's serving, a new call's hand-over to a worker among them";
    say("note", `${item.name} has ${item.draining} s to finish when a copy stops, and needs ${needed}: ${harm}. Set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=${needed} on it (guide 7.4).`);
  }
  return findings;
}

async function checkConnections(plans, say, findings) {
  const [admin, worker] = plans;
  for (const item of plans) {
    if (item.pools.total === null) say("stop", `${item.name}'s ${item.pools.unreadable.join(" and ")} isn't a whole number of 1 or more, so its connections can't be counted. Set it to one (guide 4.6).`);
  }
  if (admin.pools.total === null || worker.pools.total === null) return;
  // A service with no deployment yet holds no connections now, but will once it's deployed.
  const admins = admin.to ?? 1;
  const workers = worker.to ?? 1;
  const peak = duringRelease(admins, workers, admin.pools.total, worker.pools.total);
  const sizes = `${copies(admins, "admin")} at ${admin.pools.total} connections and ${copies(workers, "worker")} at ${worker.pools.total}`;
  const usableByDefault = DEFAULT_MAX_CONNECTIONS - RESERVED_CONNECTIONS;
  if (peak <= usableByDefault) {
    say("ok", `Connections: ${sizes} hold up to ${peak} while a release replaces them, within PostgreSQL's default of ${DEFAULT_MAX_CONNECTIONS}.`);
    return;
  }
  const needed = peak + RESERVED_CONNECTIONS;
  const defaults = plans.filter((item) => item.pools.unset.length);
  const smaller = defaults.length
    ? ` ${listNames(defaults.map((item) => item.name))} ${defaults.length > 1 ? "take" : "takes"} the code's defaults for ${listNames(defaults.flatMap((item) => item.pools.unset.map((name) => `${name}${defaults.length > 1 ? ` on ${item.name}` : ""}`)))}: the smaller shares (guide 4.6) need fewer. A deployment bootstrap.mjs made gets them from \`node devops/bootstrap.mjs redo <settings file> variables\` and then \`up\`.`
    : "";
  if (findings.some((finding) => finding.level === "stop")) return;
  let max = options.maxConnections;
  if (max === null) {
    if (options.yes) {
      say("stop", `Connections: ${sizes} hold up to ${peak} while a release replaces them, so the database's max_connections must be ${needed} or more. Say what \`show max_connections;\` shows with --max-connections <n>.${smaller}`);
      return;
    }
    console.log(`  ?     Connections: ${sizes} hold up to ${peak} while a release replaces them, so the database's max_connections must be ${needed} or more.`);
    const answer = await ask(`        What does \`show max_connections;\` say in the database, signed in as postgres (guide Part 7)? `);
    max = Number(answer.match(/\d+/)?.[0] ?? Number.NaN);
    if (!Number.isInteger(max) || max < 1) {
      say("stop", "Connections: no number given, so the database's limit isn't known.");
      return;
    }
  }
  if (max - RESERVED_CONNECTIONS >= peak) {
    say("ok", `Connections: ${sizes} hold up to ${peak} while a release replaces them, within the ${max - RESERVED_CONNECTIONS} of max_connections ${max} that the app can use.`);
    return;
  }
  const raise = max < 200 && peak + RESERVED_CONNECTIONS <= 200
    ? `Raise it first: \`alter system set max_connections = 200;\` in the database as postgres, then restart Postgres (guide 7.24, step 2).`
    : `Past 200, put PgBouncer in front of the database (guide 7.24), or run fewer copies.`;
  say("stop", `Connections: ${sizes} hold up to ${peak} while a release replaces them, more than the ${max - RESERVED_CONNECTIONS} of max_connections ${max} that the app can use. ${raise}${smaller}`);
}

/** While a release replaces every copy, the old copies keep their connections as they finish: twice the copies at once. */
function duringRelease(admins, workers, admin, worker) {
  return 2 * (admins * admin + workers * worker);
}

/** Whether a commit has FIX_FILE: true, false, or null when neither this checkout nor GitHub can say. */
async function hasFixes(commit, repo) {
  const git = (args) => {
    const result = spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", windowsHide: true });
    return result.error ? null : result.status;
  };
  if (git(["cat-file", "-e", `${commit}^{commit}`]) === 0) return git(["cat-file", "-e", `${commit}:${FIX_FILE}`]) === 0;
  if (!repo) return null;
  const status = async (file) => {
    try {
      const response = await fetch(`${GITHUB_RAW}/${repo}/${commit}/${file}`, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      return response.status;
    } catch {
      return null;
    }
  };
  const fixFile = await status(FIX_FILE);
  if (fixFile === 200) return true;
  // A missing file and a commit GitHub can't show both answer 404, so a file every commit has tells them apart.
  if (fixFile === 404 && (await status("package.json")) === 200) return false;
  return null;
}

/** environmentPatchCommit answers with the workflow that applies the change; an unknown one isn't waited for. */
async function waitForWorkflow(workflowId) {
  if (typeof workflowId !== "string" || !workflowId) return;
  const deadline = Date.now() + Math.min(WAIT_MS, 3 * 60_000);
  for (;;) {
    let result;
    try {
      result = (await gql(WORKFLOW_QUERY, { workflowId })).workflowStatus;
    } catch {
      return;
    }
    if (result?.status === "Error") throw new Stop(`Railway couldn't apply the change: ${result.error || "it gave no reason"}. The service's page in Railway may say more`);
    if (result?.status !== "Running" || Date.now() > deadline) return;
    await sleep(POLL_MS);
  }
}

async function waitForCopies(where, items) {
  const pending = new Map(items.map((item) => [item.id, item]));
  const shown = new Map();
  const deadline = Date.now() + WAIT_MS;
  console.log(`Waiting for the new copies to start${WAIT_MS >= 60_000 ? ` (up to ${Math.round(WAIT_MS / 60_000)} minutes; --no-wait skips this)` : ""}:`);
  for (;;) {
    for (const [id, item] of pending) {
      const running = runningCopies(await readInstance(where, id, item.name));
      if (shown.get(id) !== running) console.log(`  ${item.name}: ${running} of ${item.to} running`);
      shown.set(id, running);
      if (running >= item.to) pending.delete(id);
    }
    if (!pending.size) return;
    if (Date.now() >= deadline) {
      throw new Stop(`${listNames([...pending.values()].map((item) => `${item.name} has ${shown.get(item.id)} of ${item.to} copies running`))} after ${Math.round(WAIT_MS / 60_000)} minutes. Railway has the change: the service's Deployments tab says what its new copies are doing`);
    }
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------- Railway's API

/** `plain` gives Railway's own words for a refusal, for a read the run can do without. */
async function gql(query, variables = {}, { mutation = false, plain = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { ...auth.headers, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      // A change that timed out may have landed, so only reads are retried here.
      if (!mutation && attempt < 4) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(`couldn't reach Railway (${error.cause?.code ?? error.message})`);
    }
    if (response.status === 429) {
      // Railway answers 429 before doing anything, so any request can go again after the wait.
      const wait = Number(response.headers.get("retry-after"));
      if (attempt < 4 && (!(wait > 0) || wait <= 60)) {
        await sleep(wait > 0 ? wait * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Railway's API limit is used up${wait > 0 ? `; it resets in about ${Math.ceil(wait / 60)} minutes` : ""}`);
    }
    if (!mutation && response.status >= 500 && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await response.text();
    const body = parseJson(text);
    // Railway reports refusals, a bad token included, as errors in a 200 answer.
    if (body?.errors?.length) throw new Error(plain ? body.errors.map((error) => error.message).join("; ") : describeErrors(body.errors, mutation));
    if (!response.ok || !body?.data) throw new Error(`Railway answered ${response.status}: ${text.slice(0, 300)}`);
    return body.data;
  }
}

function describeErrors(errors, mutation) {
  const message = errors.map((error) => error.message).join("; ");
  if (/project token not found/i.test(message)) {
    return "Railway doesn't know this token as a project token. Make one in the project's Settings > Tokens, for the environment to scale; for an account or workspace token, use --bootstrap or --project.";
  }
  if (/not authorized/i.test(message)) {
    if (mutation && auth?.kind === "project") return `Railway refused the change for this project token (${message}). Run again with an account or workspace token, through --bootstrap or --project, or change the copies under each service's Settings in Railway.`;
    return auth?.kind === "project"
      ? `Railway refused the request (${message}). The token has to be a project token for this environment, from the project's Settings > Tokens.`
      : `Railway refused the request (${message}). The token has to reach this project: an account token, or a token of the project's workspace.`;
  }
  return `Railway answered: ${message}`;
}

// ---------------------------------------------------------------- the command line

function parseArgs(argv) {
  const parsed = { changes: [], bootstrap: "", project: "", environment: "", statusUrl: "", maxConnections: null, names: { admin: "admin", worker: "worker" }, dryRun: false, yes: false, wait: true };
  const takesValue = new Set(["--bootstrap", "--project", "--environment", "--max-connections", "--admin-service", "--worker-service", "--status-url"]);
  for (let index = 0; index < argv.length; index++) {
    let arg = argv[index];
    let value;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (equals > 0) [arg, value] = [arg.slice(0, equals), arg.slice(equals + 1)];
    if (takesValue.has(arg)) {
      value ??= argv[++index];
      if (value === undefined || value === "" || value.startsWith("--")) usage(`${arg} needs a value.`);
    } else if (value !== undefined) {
      usage(`${arg} takes no value.`);
    }
    if (arg === "--help" || arg === "-h") help();
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--yes") parsed.yes = true;
    else if (arg === "--no-wait") parsed.wait = false;
    else if (arg === "--bootstrap") parsed.bootstrap = value;
    else if (arg === "--project") parsed.project = value;
    else if (arg === "--environment") parsed.environment = value;
    else if (arg === "--admin-service") parsed.names.admin = value;
    else if (arg === "--worker-service") parsed.names.worker = value;
    else if (arg === "--status-url") {
      if (!addressOf(value)) usage("--status-url takes the dashboard's address, such as https://app.example.com.");
      parsed.statusUrl = addressOf(value);
    }
    else if (arg === "--max-connections") {
      const max = Number(value);
      if (!Number.isInteger(max) || max < 1) usage("--max-connections takes what `show max_connections;` says, a whole number such as 200.");
      parsed.maxConnections = max;
    } else if (arg.startsWith("-") && !/^(admin|worker)[-+=]/i.test(arg)) {
      usage(`Unknown option ${arg}.`);
    } else {
      const match = arg.match(/^(admin|worker)([-+=])(\d+)$/i);
      if (!match) usage(`${arg} isn't a change such as admin=2, worker+1 or worker-1. Only the admin and the worker run copies.`);
      const role = match[1].toLowerCase();
      if (parsed.changes.some((item) => item.role === role)) usage(`${role} is named twice.`);
      const count = Number(match[3]);
      if (match[2] === "=" && count < 1) usage(`${role}=${count} would stop the service. One copy is the fewest this script leaves.`);
      if (match[2] !== "=" && count < 1) usage(`${arg} changes nothing.`);
      parsed.changes.push({ role, op: match[2], count });
    }
  }
  if (parsed.bootstrap && parsed.project) usage("Give --bootstrap or --project, not both.");
  if (parsed.environment && !parsed.project) usage("--environment goes with --project. A project token belongs to one environment, and --bootstrap reads it from the state file.");
  if (parsed.bootstrap && (parsed.names.admin !== "admin" || parsed.names.worker !== "worker")) usage("--bootstrap finds the services by the IDs in the state file, so it takes no service names.");
  return parsed;
}

function help() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split(/\r?\n/);
  const end = text.findIndex((line) => line.startsWith("import "));
  console.log(text.slice(1, end).map((line) => line.replace(/^\/\/ ?/, "")).join("\n").trim());
  process.exit(0);
}

function usage(problem) {
  console.error(`${problem}\n\nUsage: node devops/scale.mjs [admin=<n>] [worker=<n>] [--max-connections <n>] [--dry-run] [--yes] [--no-wait]\n       [--bootstrap <settings file> | --project <id> [--environment <name>]] [--admin-service <name>] [--worker-service <name>]\n       [--status-url <address>]\nRun it with --help for more.`);
  process.exit(2);
}

// One reader for every question, so answers piped in on separate lines all arrive.
function ask(question, { hidden = false } = {}) {
  prompter ??= createPrompter();
  return prompter.ask(question, hidden);
}

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
  rl.on("SIGINT", () => {
    rl.close();
    process.stdout.write(`\n${changed ? "Stopped." : "Nothing changed."}\n`);
    process.exit(130);
  });
  if (terminal) {
    // Show the question, then hide what's typed; a redraw keeps only the question.
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

function copies(count, noun = "copy") {
  if (count === null || count === undefined) return `? ${noun === "copy" ? "copies" : `${noun}s`}`;
  return `${count} ${noun === "copy" ? (count === 1 ? "copy" : "copies") : count === 1 ? noun : `${noun}s`}`;
}

function listNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
