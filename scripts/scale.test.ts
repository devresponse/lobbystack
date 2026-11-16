import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { connectionBudget } from "../packages/db/src/pool-budget";

// devops/scale.mjs end to end, run as a person runs it: against one local server that stands in for Railway's API and
// for GitHub's raw files, and with a small Git repository whose two commits stand in for a release from before fork
// PR #168 and one after it. Each test sets up the stand-in Railway project, runs the script with its answers piped in,
// and checks what it said and what it changed.

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(repoRoot, "devops", "scale.mjs");

const projectToken = "railway-project-token";
const accountToken = "railway-account-token";
const project = { id: "prj-acme", name: "acme-test" };
const production = { id: "env-production", name: "production" };
const staging = { id: "env-staging", name: "staging" };
const region = "us-west2";
const repo = "acme/lobbystack";
// The pool sizes devops/bootstrap.mjs gives each copy (POOLS there), and the draining times it sets.
const POOLS = {
  admin: { LOBBYSTACK_APP_POOL_MAX: "6", LOBBYSTACK_AUTH_POOL_MAX: "2", LOBBYSTACK_WORKER_POOL_MAX: "12", LOBBYSTACK_DISPATCHER_POOL_MAX: "2", LOBBYSTACK_FINANCE_EXPORT_POOL_MAX: "2" },
  worker: { LOBBYSTACK_WORKER_POOL_MAX: "10", LOBBYSTACK_DISPATCHER_POOL_MAX: "2" },
};

type Vars = Record<string, string>;
type StandInService = {
  id: string;
  name: string;
  /** Copies in each region, as the latest deployment's serviceManifest has them. */
  regions: Record<string, number>;
  /** Copies running in the deployment that serves. */
  running: number;
  /** Polls each new copy takes to start, or -1 when they never start. */
  startPolls: number;
  countdown: number;
  commit: string | null;
  variables: Vars;
  drainingSeconds: number | null;
  sleepApplication: boolean;
};
type Patch = { services: Record<string, { deploy: { multiRegionConfig: Record<string, { numReplicas: number } | null> } }> };
type World = {
  services: StandInService[];
  volumes: Array<{ serviceId: string; mountPath: string }>;
  patches: Array<{ environmentId: string; patch: Patch; commitMessage: string }>;
  /** The services whose variables were read, by name. */
  variableReads: string[];
  /** The credentials each request carried. */
  credentials: string[];
  workflow: { status: string; error: string | null };
  /** The files GitHub has at each owner/name@commit. */
  github: Record<string, string[]>;
  /** Railway's processor and memory series for each service, by its ID, or the words it refuses them with. */
  metrics: Record<string, Series[]> | string;
  /** The addresses Railway has for the admin. */
  domains: { serviceDomains: Array<{ domain: string }>; customDomains: Array<{ domain: string }> };
  /** The stand-in admin's fleet status address: the token it takes ("" while it is off), and what it answers. */
  fleet: { token: string; status: number; body: unknown };
  /** What the fleet status address was asked, and with which credential. */
  fleetRequests: Array<{ search: string; authorization: string }>;
  /** The operations Railway was asked for, in order. */
  operations: string[];
};
type Series = { measurement: string; tags: { deploymentInstanceId: string | null }; values: Array<{ ts: number; value: number }> };

let server: Server;
let base = "";
let gitDir = "";
let dir = "";
let world: World;
/** Commits in the stand-in repository: one before fork PR #168, one with it. */
const commits = { before: "", after: "" };

function service(id: string, name: string, overrides: Partial<StandInService> = {}): StandInService {
  return {
    id, name, regions: { [region]: 1 }, running: 1, startPolls: 1, countdown: 1, commit: commits.after, variables: {},
    drainingSeconds: null, sleepApplication: false, ...overrides,
  };
}

/** One copy's series as Railway gives them: a point a minute, the newest last. */
function series(deploymentInstanceId: string, cpu: number, memoryGb: number): Series[] {
  const newest = Math.floor(Date.now() / 1000);
  return [
    { measurement: "CPU_USAGE", tags: { deploymentInstanceId }, values: [{ ts: newest - 60, value: cpu / 2 }, { ts: newest, value: cpu }] },
    { measurement: "MEMORY_USAGE_GB", tags: { deploymentInstanceId }, values: [{ ts: newest - 60, value: memoryGb / 2 }, { ts: newest, value: memoryGb }] },
  ];
}

// What the admin's fleet status address answers (apps/admin/src/lib/fleet-status.ts) when one of two workers went silent.
const fleetToken = "fleet-status-token-never-printed-0123456789";
const silentWorker = {
  ok: false,
  service: "lobbystack-admin",
  answeredBy: "3f2a9c1e-0000-4000-8000-000000000001",
  checkedAt: "2026-11-15T20:00:00.000Z",
  problems: ["worker copy 9b8d7c6a stopped reporting 95 s ago without shutting down, and no newer copy took its place.", "1 worker copy is running, and 2 are expected."],
  services: { admin: { running: 1, notReady: 0, draining: 0, silent: 0, died: 0, expected: 1 }, worker: { running: 1, notReady: 0, draining: 0, silent: 1, died: 0, expected: 2 } },
  copies: [
    { service: "admin", replica: "3f2a9c1e-0000-4000-8000-000000000001", state: "running", release: "abc1234", deployment: "dep-1", region, startedAt: "2026-11-15T17:00:00.000Z", lastSeenSecondsAgo: 3, busy: 0.071, rssBytes: 256 * 1_048_576, heapUsedBytes: 120_000_000, db: { open: 5, inUse: 1, waiting: 0, max: 24 } },
    { service: "worker", replica: "5e4d3c2b-0000-4000-8000-000000000002", state: "running", release: "abc1234", deployment: "dep-2", region, startedAt: "2026-11-15T19:30:00.000Z", lastSeenSecondsAgo: 8, busy: 0.412, rssBytes: 384 * 1_048_576, heapUsedBytes: 200_000_000, db: { open: 4, inUse: 2, waiting: 1, max: 12 }, ready: true, activeJobs: 1, liveCalls: 2 },
    { service: "worker", replica: "9b8d7c6a-0000-4000-8000-000000000003", state: "silent", release: "abc1234", deployment: "dep-2", region, startedAt: "2026-11-15T19:30:00.000Z", lastSeenSecondsAgo: 95, busy: 0.2, rssBytes: 300 * 1_048_576, heapUsedBytes: 150_000_000, db: { open: 3, inUse: 0, waiting: 0, max: 12 }, ready: true, activeJobs: 0, liveCalls: 1 },
  ],
  died: [],
  queues: { critical: { waiting: 4, active: 2, delayed: 1, failed: 9 }, bulk: { waiting: 0, active: 0, delayed: 0, failed: 0 } },
  queuesCountedSecondsAgo: 8,
};
// A worker that died five hours before, as the address lists it for 24 hours: its last beat, and when that was.
const diedWorker = {
  service: "worker", replica: "7a6b5c4d-0000-4000-8000-000000000004", state: "died", release: "abc1234", deployment: "dep-2", region,
  startedAt: "2026-11-13T15:00:00.000Z", lastSeenSecondsAgo: 18_000, lastSeenAt: "2026-11-15T15:00:00.000Z", ranForSeconds: 172_800,
  busy: 0.97, rssBytes: 1_890 * 1_048_576, heapUsedBytes: 1_700_000_000, db: { open: 12, inUse: 11, waiting: 3, max: 12 }, ready: true, activeJobs: 12, liveCalls: 4,
  queues: { critical: { waiting: 40, active: 12, delayed: 0, failed: 9 } },
};

function freshWorld(): World {
  return {
    services: [
      service("svc-postgres", "Postgres", { variables: { POSTGRES_PASSWORD: "postgres-password-never-read" }, commit: null }),
      service("svc-redis", "Redis", { commit: null }),
      service("svc-migrate", "migrate", { running: 0 }),
      service("svc-admin", "admin", { variables: { ...POOLS.admin, RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "60", BETTER_AUTH_SECRET: "admin-secret-never-printed" } }),
      service("svc-worker", "worker", { variables: { ...POOLS.worker, RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "1860", ENCRYPTION_KEY: "${{admin.ENCRYPTION_KEY}}" } }),
    ],
    volumes: [{ serviceId: "svc-postgres", mountPath: "/var/lib/postgresql/data" }, { serviceId: "svc-redis", mountPath: "/data" }],
    patches: [],
    variableReads: [],
    credentials: [],
    workflow: { status: "Complete", error: null },
    github: {},
    metrics: {
      "svc-admin": series("c0ffee00-0000-4000-8000-00000000000a", 0.42, 0.5),
      "svc-worker": series("decaf111-0000-4000-8000-00000000000b", 1.5, 0.75),
    },
    domains: { serviceDomains: [], customDomains: [] },
    fleet: { token: "", status: 200, body: {} },
    fleetRequests: [],
    operations: [],
  };
}

const named = (name: string) => {
  const found = world.services.find((item) => item.name === name);
  if (!found) throw new Error(`no stand-in service ${name}`);
  return found;
};
const total = (regions: Record<string, number>) => Object.values(regions).reduce((sum, count) => sum + count, 0);

/** A serviceInstance as Railway answers it: each read brings a starting copy closer to running. */
function instanceOf(item: StandInService) {
  if (total(item.regions) > item.running && item.startPolls >= 0) {
    if (item.countdown <= 0) {
      item.running += 1;
      item.countdown = item.startPolls;
    } else {
      item.countdown -= 1;
    }
  }
  const starting = Math.max(0, total(item.regions) - item.running);
  const deployment = {
    id: `dep-${item.id}`,
    status: "SUCCESS",
    createdAt: "2026-11-15T00:00:00.000Z",
    meta: {
      ...(item.commit ? { commitHash: item.commit, branch: "develop/r2", repo } : { image: "postgres" }),
      serviceManifest: { deploy: { multiRegionConfig: Object.fromEntries(Object.entries(item.regions).map(([name, count]) => [name, { numReplicas: count }])) } },
    },
    instances: [...Array.from({ length: item.running }, () => ({ status: "RUNNING" })), ...Array.from({ length: starting }, () => ({ status: "INITIALIZING" }))],
  };
  return { region: null, numReplicas: null, drainingSeconds: item.drainingSeconds, sleepApplication: item.sleepApplication, latestDeployment: deployment, activeDeployments: [deployment] };
}

function read(request: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += String(chunk)));
    request.on("end", () => done(text));
  });
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", base);
  if (url.pathname.startsWith("/github/")) {
    const [owner, name, commit, ...file] = url.pathname.split("/").slice(2);
    const files = world.github[`${owner}/${name}@${commit}`] ?? [];
    response.writeHead(files.includes(file.join("/")) ? 200 : 404);
    response.end();
    return;
  }
  if (url.pathname === "/api/internal/fleet") {
    // The admin, as apps/admin/src/lib/fleet-status.ts answers: 404 while it is off, 401 for another token.
    const authorization = String(request.headers.authorization ?? "");
    world.fleetRequests.push({ search: url.search, authorization });
    const known = Boolean(world.fleet.token) && authorization === `Bearer ${world.fleet.token}`;
    const status = !world.fleet.token ? 404 : known ? world.fleet.status : 401;
    response.writeHead(status, { "content-type": known ? "application/json" : "text/plain" });
    response.end(known ? JSON.stringify(world.fleet.body) : status === 404 ? "Not found" : "Unauthorized");
    return;
  }
  const body = JSON.parse(await read(request)) as { query: string; variables: Record<string, unknown> };
  const operation = /^(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? "";
  world.operations.push(operation);
  const reply = (data: unknown) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data }));
  };
  const refuse = (message: string) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ errors: [{ message, extensions: { code: "INTERNAL_SERVER_ERROR" } }], data: null }));
  };
  const projectHeader = request.headers["project-access-token"];
  const bearer = request.headers.authorization;
  world.credentials.push(projectHeader ? `project ${String(projectHeader)}` : `bearer ${bearer ?? ""}`);
  const asProject = projectHeader === projectToken;
  if (projectHeader && !asProject) return refuse("Project Token not found");
  if (!asProject && bearer !== `Bearer ${accountToken}`) return refuse("Not Authorized");
  const environmentId = body.variables.environmentId;
  // A project token reaches only its own environment.
  if (asProject && environmentId !== undefined && environmentId !== production.id) return refuse("Not Authorized");
  const byId = (id: unknown) => world.services.find((item) => item.id === id);
  switch (operation) {
    case "ProjectToken":
      return asProject ? reply({ projectToken: { project, environment: production } }) : refuse("Project Token not found");
    case "Project":
      if (body.variables.id !== project.id) return refuse("Project not found");
      return reply({ project: { ...project, services: { edges: world.services.map(({ id, name }) => ({ node: { id, name } })) }, environments: { edges: [{ node: production }, { node: staging }] } } });
    case "EnvironmentVolumes":
      return reply({ environment: { volumeInstances: { edges: world.volumes.map((node) => ({ node })) } } });
    case "ServiceInstance": {
      const item = byId(body.variables.serviceId);
      return item ? reply({ serviceInstance: instanceOf(item) }) : refuse("ServiceInstance not found");
    }
    case "ServiceVariables": {
      const item = byId(body.variables.serviceId);
      if (!item) return refuse("Service not found");
      world.variableReads.push(item.name);
      if (body.variables.unrendered !== undefined || !/unrendered: true/.test(body.query)) return refuse("expected unrendered variables");
      return reply({ variables: item.variables });
    }
    case "EnvironmentPatchCommit": {
      const patch = body.variables.patch as Patch;
      world.patches.push({ environmentId: String(environmentId), patch, commitMessage: String(body.variables.commitMessage) });
      for (const [id, change] of Object.entries(patch.services)) {
        const item = byId(id);
        if (!item) return refuse("Service not found");
        const kept: Array<[string, number]> = [];
        for (const [name, value] of Object.entries(change.deploy.multiRegionConfig)) if (value) kept.push([name, value.numReplicas]);
        item.regions = Object.fromEntries(kept);
        item.running = Math.min(item.running, total(item.regions));
        item.countdown = item.startPolls;
      }
      return reply({ environmentPatchCommit: "wf-scale" });
    }
    case "WorkflowStatus":
      return reply({ workflowStatus: world.workflow });
    case "ReplicaMetrics": {
      if (typeof world.metrics === "string") return refuse(world.metrics);
      const since = Date.parse(String(body.variables.startDate));
      if (!/groupBy: \[DEPLOYMENT_INSTANCE_ID\]/.test(body.query) || !(Date.now() - since < 10 * 60_000)) return refuse("expected each copy's series for the last minutes");
      return reply({ metrics: world.metrics[String(body.variables.serviceId)] ?? [] });
    }
    case "ServiceDomains":
      return body.variables.serviceId === "svc-admin" ? reply({ domains: world.domains }) : refuse("Service not found");
    default:
      return refuse(`the stand-in doesn't know ${operation}`);
  }
}

type Result = { code: number | null; out: string };

/** Runs scale.mjs with its answers piped in, against the stand-ins, with the project token unless env says otherwise. */
function scale(args: string[], { input = "", env = {} }: { input?: string; env?: Record<string, string | undefined> } = {}): Promise<Result> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: dir,
        SCALE_RAILWAY_URL: `${base}/railway`,
        SCALE_GITHUB_URL: `${base}/github`,
        SCALE_GIT_DIR: gitDir,
        SCALE_POLL_MS: "1",
        SCALE_WAIT_MS: "3000",
        RAILWAY_TOKEN: projectToken,
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

const replicas = (count: number) => ({ deploy: { multiRegionConfig: { [region]: { numReplicas: count } } } });

describe("devops/scale.mjs", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    gitDir = mkdtempSync(join(tmpdir(), "scale-test-git-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", gitDir, "-c", "user.name=Stand-in", "-c", "user.email=stand-in@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    git("init", "-q");
    writeFileSync(join(gitDir, "package.json"), "{}\n");
    git("add", ".");
    git("commit", "-q", "-m", "A release from before fork PR #168");
    commits.before = git("rev-parse", "HEAD");
    mkdirSync(join(gitDir, "packages", "db", "src"), { recursive: true });
    writeFileSync(join(gitDir, "packages", "db", "src", "pool-budget.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-q", "-m", "Fork PR #168");
    commits.after = git("rev-parse", "HEAD");

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
    rmSync(gitDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scale-test-"));
    world = freshWorld();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts a copy's connections as packages/db does, and looks for the file fork PR #168 added", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toContain('const FIX_FILE = "packages/db/src/pool-budget.ts";');
    expect(existsSync(join(repoRoot, "packages", "db", "src", "pool-budget.ts"))).toBe(true);
    // The defaults and the roles the script copies from pool-budget.ts, through the numbers it prints.
    expect(connectionBudget("admin", POOLS.admin)).toBe(24);
    expect(connectionBudget("worker", POOLS.worker)).toBe(12);
    expect(connectionBudget("admin", {})).toBe(52);
    expect(connectionBudget("worker", {})).toBe(16);
  });

  it("shows the copies, the release and what two of each would need, and changes nothing", async () => {
    const result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Railway project acme-test, environment production");
    expect(result.out).toContain(`admin    1 copy in ${region}, release ${commits.after.slice(0, 7)} (develop/r2)`);
    expect(result.out).toContain("24 database connections a copy, 60 s to finish when a copy stops");
    expect(result.out).toContain("12 database connections a copy, 1860 s to finish when a copy stops");
    expect(result.out).toContain("These copies can hold up to 72 database connections while a release replaces them.");
    expect(result.out).toContain("2 admins and 2 workers could hold up to 144, so the database's max_connections must be 147 or more (guide 7.24).");
    // How busy the copies are comes between the two, from Railway and from the admin's fleet status address.
    expect(result.out).toContain("Each copy's processor and memory, as Railway measured them last:");
    expect(result.out).toContain("What the copies report about themselves isn't shown: the admin has no FLEET_STATUS_TOKEN of its own (guide 7.10).");
    expect(world.patches).toEqual([]);
    // Only the admin's and the worker's variables are read, and none is printed.
    expect(world.variableReads.sort()).toEqual(["admin", "worker"]);
    expect(result.out).not.toContain("never-printed");
    expect(result.out).not.toContain("never-read");
  });

  it("shows each copy's processor and memory as Railway measured them last", async () => {
    named("worker").regions = { [region]: 2 };
    named("worker").running = 2;
    (world.metrics as Record<string, Series[]>)["svc-worker"]!.push(...series("f00dbabe-0000-4000-8000-00000000000c", 0.031, 0.25));
    const result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Each copy's processor and memory, as Railway measured them last:");
    // The newest point of each series, not the one before it.
    expect(result.out).toMatch(/^ {2}admin +c0ffee00 +0\.42 vCPU +512 MB$/m);
    expect(result.out).toMatch(/^ {2}worker +decaf111 +1\.50 vCPU +768 MB$/m);
    expect(result.out).toMatch(/^ {2}worker +f00dbabe +0\.03 vCPU +256 MB$/m);
    expect(world.patches).toEqual([]);
  });

  it("goes on when Railway gives no figures for the copies", async () => {
    world.metrics = "Not Authorized";
    let result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Railway didn't give each copy's processor and memory (Not Authorized). Each service's Metrics tab in Railway shows them.");
    expect(result.out).toContain("These copies can hold up to 72 database connections while a release replaces them.");

    world.metrics = {};
    result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Railway has no processor and memory figures for these copies yet.");
  });

  it("shows what the copies report about themselves, and names a copy that went silent", async () => {
    named("worker").regions = { [region]: 2 };
    named("worker").running = 2;
    Object.assign(named("admin").variables, { APP_BASE_URL: `${base}/`, FLEET_STATUS_TOKEN: fleetToken });
    world.fleet = { token: fleetToken, status: 503, body: silentWorker };
    const result = await scale([]);
    // A problem in the fleet is shown, and the run still ends well: it changed nothing and read what it could.
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`What the copies report about themselves (${base}/api/internal/fleet):`);
    expect(result.out).toMatch(/^ {2}admin +3f2a9c1e +running +busy +7% +256 MB +1 of 24 connections +up 3 h$/m);
    expect(result.out).toMatch(/^ {2}worker +5e4d3c2b +running +busy +41% +384 MB +2 of 12 connections, 1 waiting +2 calls, 1 job +up 30 min$/m);
    // A copy that stopped ran until its last report, not until now.
    expect(result.out).toMatch(/^ {2}worker +9b8d7c6a +silent for 2 min +busy +20% +300 MB +0 of 12 connections +1 call, 0 jobs +ran 28 min$/m);
    expect(result.out).toContain("  Queues: critical 4 waiting, 2 running, 1 scheduled (counted 8 s ago).");
    expect(result.out).toContain("  Problem: worker copy 9b8d7c6a stopped reporting 95 s ago without shutting down, and no newer copy took its place.");
    expect(result.out).toContain("  Problem: 1 worker copy is running, and 2 are expected.");
    expect(result.out).not.toContain("Every copy reports in.");
    // It asks for as many running copies as Railway is set to run, with the token in a header, and never prints it.
    expect(world.fleetRequests).toEqual([{ search: "?admin=1&worker=2", authorization: `Bearer ${fleetToken}` }]);
    expect(result.out).not.toContain(fleetToken);
    // The admin's own variable gave the address, so Railway wasn't asked for one.
    expect(world.operations).not.toContain("ServiceDomains");
    expect(world.patches).toEqual([]);
    // No copy died in the last 24 hours, so that list isn't shown.
    expect(result.out).not.toContain("Copies that died");
  });

  it("lists the copies that died in the last 24 hours with what each reported last, and raises no problem for them", async () => {
    Object.assign(named("admin").variables, { APP_BASE_URL: base, FLEET_STATUS_TOKEN: fleetToken });
    const answer = {
      ...silentWorker, ok: true, problems: [], copies: silentWorker.copies.slice(0, 2), died: [diedWorker],
      services: { admin: { running: 1, notReady: 0, draining: 0, silent: 0, died: 0, expected: 1 }, worker: { running: 1, notReady: 0, draining: 0, silent: 0, died: 1, expected: 1 } },
    };
    world.fleet = { token: fleetToken, status: 200, body: answer };
    let result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("  Every copy reports in.");
    expect(result.out).not.toContain("Problem:");
    expect(result.out).toContain("Copies that died in the last 24 hours, each with what it reported last:");
    // How long ago it died, what it held then, how long it had run, and the moment to look for in the logs.
    expect(result.out).toMatch(/^ {2}worker +7a6b5c4d +died 5 h ago +busy +97% +1890 MB +11 of 12 connections, 3 waiting +4 calls, 12 jobs +ran 2 days +last report 2026-11-15 15:00:00 UTC$/m);
    expect(result.out).not.toContain("listed.");

    // The address lists the newest 50 and counts them all.
    answer.services.worker.died = 62;
    answer.services.admin.died = 1;
    result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("  62 older ones aren't listed.");

    // An admin from before the list sends none: nothing is said about it.
    const { died: _died, ...older } = answer;
    world.fleet = { token: fleetToken, status: 200, body: older };
    result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("  Every copy reports in.");
    expect(result.out).not.toContain("Copies that died");
  });

  it("says that every copy reports in when the status address finds no problem", async () => {
    Object.assign(named("admin").variables, { FLEET_STATUS_TOKEN: fleetToken });
    world.fleet = {
      token: fleetToken,
      status: 200,
      body: { ...silentWorker, ok: true, problems: [], copies: silentWorker.copies.slice(0, 2), queues: { critical: { waiting: 0, active: 0, delayed: 0, failed: 9 } }, queuesCountedSecondsAgo: 2 },
    };
    // The address on the command line, for an admin whose APP_BASE_URL is a reference or unset.
    const result = await scale(["--status-url", base]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("  Queues: no job waiting, running or scheduled (counted 2 s ago).");
    expect(result.out).toContain("  Every copy reports in.");
    expect(result.out).not.toContain("Problem:");
    expect(world.fleetRequests).toEqual([{ search: "?admin=1&worker=1", authorization: `Bearer ${fleetToken}` }]);
  });

  it("says why when the status address can't be asked, and goes on", async () => {
    const hidden = "What the copies report about themselves isn't shown";
    const admin = named("admin");

    // No token on the admin: the address is off, and nothing is asked.
    let result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`${hidden}: the admin has no FLEET_STATUS_TOKEN of its own (guide 7.10).`);
    expect(world.fleetRequests).toEqual([]);

    // A token that is a reference to another variable isn't one the script can send.
    admin.variables.FLEET_STATUS_TOKEN = "${{shared.FLEET_STATUS_TOKEN}}";
    result = await scale([]);
    expect(result.out).toContain(`${hidden}: the admin has no FLEET_STATUS_TOKEN of its own (guide 7.10).`);

    // A token, but no address anywhere.
    admin.variables.FLEET_STATUS_TOKEN = fleetToken;
    result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`${hidden}: the admin's address isn't known. Give it with --status-url https://<the dashboard's address>.`);
    expect(world.operations).toContain("ServiceDomains");

    // An address that isn't HTTPS never gets the token.
    admin.variables.APP_BASE_URL = "http://dashboard.example.com";
    result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`${hidden}: http://dashboard.example.com isn't an HTTPS address, so the token isn't sent to it.`);

    // The running admin has no token yet, or its release is from before the address: 404.
    admin.variables.APP_BASE_URL = base;
    result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`${hidden}: ${base}/api/internal/fleet answers 404.`);

    // The running admin has another token than its variables hold now: 401.
    world.fleet = { token: "the-token-the-running-admin-started-with", status: 200, body: silentWorker };
    result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`${hidden}: ${base}/api/internal/fleet refused the token.`);

    // Redis can't be read: the admin's own words.
    world.fleet = { token: fleetToken, status: 503, body: { ok: false, service: "lobbystack-admin", answeredBy: "3f2a9c1e", problems: ["The copies' heartbeats can't be read from Redis."] } };
    result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`${hidden}: ${base}/api/internal/fleet answered 503: The copies' heartbeats can't be read from Redis.`);

    expect(result.out).not.toContain(fleetToken);
    expect(world.patches).toEqual([]);
  });

  it("asks Railway for the admin's address when its variables don't give one, its own domain first", async () => {
    named("admin").variables.FLEET_STATUS_TOKEN = fleetToken;
    // Nothing answers HTTPS on this computer, so the address the script chose shows in what it couldn't reach.
    world.domains = { serviceDomains: [{ domain: "admin-production.up.railway.app" }], customDomains: [{ domain: "localhost" }] };
    const result = await scale([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/What the copies report about themselves isn't shown: https:\/\/localhost couldn't be reached \(\w+\)\./);
    expect(world.fleetRequests).toEqual([]);
    expect(result.out).not.toContain(fleetToken);
  });

  it("runs two admins and two workers in one change once the checks pass, and waits for them", async () => {
    const result = await scale(["admin=2", "worker=2", "--max-connections", "200", "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("admin: 1 to 2 copies, worker: 1 to 2 copies");
    expect(result.out).toContain(`ok    admin runs ${commits.after.slice(0, 7)} from develop/r2, which has the replica fixes (fork PR #168).`);
    expect(result.out).toContain(`ok    worker runs ${commits.after.slice(0, 7)} from develop/r2, which has the replica fixes (fork PR #168).`);
    expect(result.out).toContain("ok    Connections: 2 admins at 24 connections and 2 workers at 12 hold up to 144 while a release replaces them, within the 197 of max_connections 200 that the app can use.");
    expect(result.out).toContain("ok    admin has 60 s to finish when a copy stops (RAILWAY_DEPLOYMENT_DRAINING_SECONDS).");
    expect(result.out).toContain("ok    worker has 1860 s to finish when a copy stops (RAILWAY_DEPLOYMENT_DRAINING_SECONDS).");
    expect(world.patches).toEqual([{
      environmentId: production.id,
      patch: { services: { "svc-admin": replicas(2), "svc-worker": replicas(2) } },
      commitMessage: "Scale admin to 2 copies and worker to 2 copies (devops/scale.mjs)",
    }]);
    expect(result.out).toContain("admin: 2 of 2 running");
    expect(result.out).toContain("worker: 2 of 2 running");
    expect(new Set(world.credentials)).toEqual(new Set([`project ${projectToken}`]));
  });

  it("asks what the database allows when the copies need more than PostgreSQL's default, then asks before the change", async () => {
    const result = await scale(["admin=2", "worker=2"], { input: "200\nyes\n" });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Connections: 2 admins at 24 connections and 2 workers at 12 hold up to 144 while a release replaces them, so the database's max_connections must be 147 or more.");
    expect(result.out).toContain("What does `show max_connections;` say in the database, signed in as postgres (guide Part 7)?");
    expect(result.out).toContain("Change admin from 1 to 2 copies and worker from 1 to 2 copies in acme-test (production)? Railway starts each new copy from the release that's running, without a deploy.");
    expect(world.patches).toHaveLength(1);
  });

  it("stops when the database's limit is too low, and says how to raise it", async () => {
    const result = await scale(["admin=2", "worker=2"], { input: "100\n" });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("stop  Connections: 2 admins at 24 connections and 2 workers at 12 hold up to 144 while a release replaces them, more than the 97 of max_connections 100 that the app can use. Raise it first: `alter system set max_connections = 200;` in the database as postgres, then restart Postgres (guide 7.24, step 2).");
    expect(result.out).toContain("Nothing was changed.");
    expect(world.patches).toEqual([]);
  });

  it("wants the database's limit on the command line with --yes", async () => {
    const result = await scale(["admin=2", "worker=2", "--yes"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("Say what `show max_connections;` shows with --max-connections <n>.");
    expect(world.patches).toEqual([]);
  });

  it("adds a worker with no database question when the copies fit within PostgreSQL's default", async () => {
    const result = await scale(["worker+1", "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("ok    Connections: 1 admin at 24 connections and 2 workers at 12 hold up to 96 while a release replaces them, within PostgreSQL's default of 100.");
    expect(result.out).not.toContain("show max_connections");
    expect(world.patches.map((entry) => entry.patch)).toEqual([{ services: { "svc-worker": replicas(2) } }]);
  });

  it("stops when a service runs a release without the replica fixes", async () => {
    named("admin").commit = commits.before;
    const result = await scale(["worker=2", "--max-connections", "200", "--yes"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain(`stop  admin runs ${commits.before.slice(0, 7)} from develop/r2, which doesn't have the replica fixes (fork PR #168): copies would run out of database connections and the admin would send every call to one worker. Deploy a release with them first (guide 7.24, step 1).`);
    expect(result.out).toContain("Stopped: a check failed (stop above), so the copies stay as they are.");
    expect(world.patches).toEqual([]);
  });

  it("asks GitHub about a commit this checkout doesn't have", async () => {
    const elsewhere = "ab".repeat(20);
    named("admin").commit = elsewhere;
    named("worker").commit = elsewhere;
    world.github[`${repo}@${elsewhere}`] = ["package.json", "packages/db/src/pool-budget.ts"];
    let result = await scale(["admin=2", "--max-connections", "200", "--yes", "--dry-run"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("ok    admin runs abababa from develop/r2, which has the replica fixes (fork PR #168).");

    world.github[`${repo}@${elsewhere}`] = ["package.json"];
    result = await scale(["admin=2", "--max-connections", "200", "--yes", "--dry-run"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("stop  admin runs abababa from develop/r2, which doesn't have the replica fixes (fork PR #168)");

    // A commit GitHub can't show at all: the script can't tell, says so, and leaves it to the person.
    world.github = {};
    result = await scale(["admin=2", "--max-connections", "200", "--yes", "--dry-run"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("note  admin runs abababa from develop/r2, and neither this Git checkout nor GitHub could say whether that has the replica fixes (fork PR #168).");
    expect(world.patches).toEqual([]);
  });

  it("counts the code's defaults when a service has no pool variables, and says how to set them", async () => {
    for (const name of ["admin", "worker"]) {
      const item = named(name);
      item.variables = Object.fromEntries(Object.entries(item.variables).filter(([key]) => !key.endsWith("_POOL_MAX")));
    }
    const status = await scale([]);
    expect(status.out).toContain("52 database connections a copy (the code's defaults: no …_POOL_MAX variables)");
    expect(status.out).toContain("16 database connections a copy (the code's defaults: no …_POOL_MAX variables)");
    const result = await scale(["admin=2", "worker=2", "--max-connections", "200", "--yes"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("stop  Connections: 2 admins at 52 connections and 2 workers at 16 hold up to 272 while a release replaces them, more than the 197 of max_connections 200 that the app can use. Past 200, put PgBouncer in front of the database (guide 7.24), or run fewer copies.");
    expect(result.out).toContain("the smaller shares (guide 4.6) need fewer. A deployment bootstrap.mjs made gets them from `node devops/bootstrap.mjs redo <settings file> variables` and then `up`.");
    expect(world.patches).toEqual([]);
  });

  it("takes a worker copy away without the release and database checks, and leaves it time for its calls", async () => {
    named("worker").regions = { [region]: 2 };
    named("worker").running = 2;
    const result = await scale(["worker-1", "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toContain("replica fixes");
    expect(result.out).not.toContain("Connections:");
    expect(result.out).toContain("ok    worker has 1860 s to finish when a copy stops");
    expect(result.out).toContain("worker: Railway takes a copy away, each after up to 1860 s to finish what it started.");
    expect(world.patches.map((entry) => entry.patch)).toEqual([{ services: { "svc-worker": replicas(1) } }]);
  });

  it("warns before taking away a worker copy that would cut its calls, and changes nothing without a yes", async () => {
    named("worker").regions = { [region]: 2 };
    named("worker").running = 2;
    delete named("worker").variables.RAILWAY_DEPLOYMENT_DRAINING_SECONDS;
    const result = await scale(["worker=1"], { input: "no\n" });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("note  worker has 0 s to finish when a copy stops, and needs 1860: a worker copy that stops cuts the calls on it at once, probably before the receptionist's goodbye. Set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860 on it (guide 7.4).");
    expect(result.out).toContain("Each copy Railway takes away gets worker's 0 s to finish first. Type yes to continue:");
    expect(result.out).toContain("Nothing changed.");
    expect(world.patches).toEqual([]);
  });

  it("takes the draining time from the service's setting when the variable isn't there", async () => {
    delete named("admin").variables.RAILWAY_DEPLOYMENT_DRAINING_SECONDS;
    named("admin").drainingSeconds = 90;
    const result = await scale(["admin=2", "--max-connections", "200", "--dry-run", "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("ok    admin has 90 s to finish when a copy stops");
  });

  it("refuses a service with a volume, or one that runs in two regions", async () => {
    world.volumes.push({ serviceId: "svc-admin", mountPath: "/app/data" });
    named("worker").regions = { [region]: 1, "europe-west4-drams3a": 1 };
    named("worker").running = 2;
    const result = await scale(["admin=2", "worker=3", "--max-connections", "200", "--yes"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("stop  admin has a volume at /app/data, and Railway runs no copies of a service with a volume.");
    expect(result.out).toContain(`stop  worker runs in 2 regions (${region} 1, europe-west4-drams3a 1), and this script changes a service that runs in one. Change it under its Settings in Railway.`);
    expect(world.patches).toEqual([]);
  });

  it("notes a service that sleeps when it's idle", async () => {
    named("admin").sleepApplication = true;
    const result = await scale(["admin=2", "--max-connections", "200", "--dry-run", "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("note  admin sleeps when it's idle (Serverless in its Settings).");
  });

  it("runs the checks and changes nothing with --dry-run", async () => {
    const result = await scale(["admin=2", "worker=2", "--max-connections", "200", "--dry-run"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("ok    Connections:");
    expect(result.out).toContain("Dry run: nothing was changed.");
    expect(world.patches).toEqual([]);
  });

  it("says when the copies are already there", async () => {
    const result = await scale(["admin=1", "worker=1"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Nothing to change: admin has 1 copy and worker has 1 copy already.");
    expect(world.patches).toEqual([]);
  });

  it("finds a bootstrap deployment from its state file, with the account token from its secrets file", async () => {
    named("admin").name = "lobbystack-admin";
    const settings = join(dir, ".env.bootstrap-acme-test");
    writeFileSync(settings, "NAME=acme-test\n");
    writeFileSync(`${settings}.state.json`, JSON.stringify({ done: {}, values: { RAILWAY_PROJECT_ID: project.id, RAILWAY_ENVIRONMENT_ID: production.id, RAILWAY_SERVICE_IDS: { Postgres: "svc-postgres", admin: "svc-admin", worker: "svc-worker" } } }));
    writeFileSync(`${settings}.secrets`, `# Railway\nRAILWAY_API_TOKEN="${accountToken}"\nOPENAI_ADMIN_KEY=?\n`);
    // A project token in the shell is for another project, and goes unused.
    const result = await scale(["--bootstrap", settings, "worker=2", "--yes"], { env: { RAILWAY_TOKEN: "another-project-token" } });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("lobbystack-admin 1 copy");
    expect(world.patches.map((entry) => entry.patch)).toEqual([{ services: { "svc-worker": replicas(2) } }]);
    expect(new Set(world.credentials)).toEqual(new Set([`bearer Bearer ${accountToken}`]));
  });

  it("takes an account token with --project and --environment", async () => {
    let result = await scale(["--project", project.id, "worker=2", "--yes"], { env: { RAILWAY_TOKEN: undefined, RAILWAY_API_TOKEN: accountToken } });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('acme-test has more than one environment: name one with --environment. Its environments are "production", "staging".');
    result = await scale(["--project", project.id, "--environment", "production", "worker=2", "--yes"], { env: { RAILWAY_TOKEN: undefined, RAILWAY_API_TOKEN: accountToken } });
    expect(result.code, result.out).toBe(0);
    expect(world.patches.map((entry) => entry.patch)).toEqual([{ services: { "svc-worker": replicas(2) } }]);
  });

  it("finds services by other names, and lists the project's when one is missing", async () => {
    named("worker").name = "lobbystack-worker";
    let result = await scale([]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('acme-test has no service named "worker". Its services are "Postgres", "Redis", "migrate", "admin", "lobbystack-worker". Name it with --worker-service <name>.');
    result = await scale(["--worker-service", "lobbystack-worker"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("lobbystack-worker 1 copy");
  });

  it("explains a token Railway doesn't know", async () => {
    const result = await scale([], { env: { RAILWAY_TOKEN: "not-a-token" } });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("Railway doesn't know this token as a project token. Make one in the project's Settings > Tokens");
  });

  it("stops when Railway can't apply the change", async () => {
    world.workflow = { status: "Error", error: "the service has a volume" };
    const result = await scale(["worker=2", "--yes"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("Stopped: Railway couldn't apply the change: the service has a volume.");
  });

  it("says which copies didn't start in time", async () => {
    named("worker").startPolls = -1;
    const result = await scale(["worker=2", "--yes"], { env: { SCALE_WAIT_MS: "50" } });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("worker: 1 of 2 running");
    expect(result.out).toContain("Stopped: worker has 1 of 2 copies running after 0 minutes. Railway has the change: the service's Deployments tab says what its new copies are doing");
    expect(result.out).not.toContain("Nothing was changed.");
    expect(world.patches).toHaveLength(1);
  });

  it.each<[string[], string]>([
    [["admin=0"], "admin=0 would stop the service."],
    [["postgres=2"], "postgres=2 isn't a change such as admin=2, worker+1 or worker-1. Only the admin and the worker run copies."],
    [["admin=2", "admin=3"], "admin is named twice."],
    [["worker+0"], "worker+0 changes nothing."],
    [["--environment", "production"], "--environment goes with --project."],
    [["--max-connections", "lots"], "--max-connections takes what `show max_connections;` says"],
    [["--status-url", "dashboard"], "--status-url takes the dashboard's address, such as https://app.example.com."],
    [["--frobnicate"], "Unknown option --frobnicate."],
  ])("refuses %j", async (args, message) => {
    const result = await scale(args);
    expect(result.code, result.out).toBe(2);
    expect(result.out).toContain(message);
    expect(world.credentials).toEqual([]);
  });

  it("stops before going under one copy", async () => {
    const result = await scale(["admin-1"]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("admin would have 0 copies. One is the fewest this script leaves");
  });

  it("prints its instructions with --help", async () => {
    const result = await scale(["--help"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("node devops/scale.mjs admin=2 worker=2     two of each");
    expect(result.out).not.toContain("import ");
  });
});
