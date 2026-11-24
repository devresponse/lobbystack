import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// devops/redeploy.mjs end to end, run as a person runs it: in a folder with a deployment's settings files, against one
// local server that stands in for Railway's API and Cloudflare's, with stand-ins for Docker and the AWS CLI on the PATH.
// The stand-in answers Railway's schema query with scripts/fixtures/railway-redeploy-schema.json, the part of Railway's
// live schema the script uses, which `node devops/redeploy.mjs schema --save` wrote: so the first test is also a check
// that every call the script makes was in Railway's API on the day the fixture was saved.

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(repoRoot, "devops", "redeploy.mjs");
const fixture = join(repoRoot, "scripts", "fixtures", "railway-redeploy-schema.json");

const railwayToken = "railway-account-token-never-printed";
const cloudflareToken = "cloudflare-token-never-printed";
const zone = "example.com";
const host = "app.example.com";
const settingsName = ".env.bootstrap-acme-prod";
const copyName = `${settingsName}-pg18`;

type Vars = Record<string, string>;
type StandInService = { id: string; name: string; image: string | null; status: string; copies: number; commit: string | null; variables: Vars; sealed: string[] };
type StandInDomain = { domain: string; verified: boolean; records: Array<{ recordType: string; fqdn: string; requiredValue: string }> };
type StandInProject = {
  id: string;
  name: string;
  environment: { id: string; name: string };
  services: StandInService[];
  volumes: Array<{ id: string; serviceId: string; mountPath: string; sizeMB: number }>;
  buckets: Array<{ id: string; name: string; objectCount: number; sizeBytes: number }>;
  /** Custom and Railway domains by service ID. */
  domains: Record<string, { custom: StandInDomain[]; railway: string[] }>;
  proxies: Record<string, Array<{ id: string; domain: string; proxyPort: number; applicationPort: number; syncStatus: string }>>;
  backups: Record<string, Array<{ id: string; name: string | null; createdAt: string; expiresAt: string | null; usedMB: number }>>;
  schedules: Record<string, string[]>;
};
type World = {
  projects: StandInProject[];
  /** What the schema query answers; a test takes something out of it. */
  schema: { __schema: { types: Array<{ name: string; fields: Array<{ name: string }> | null }> } };
  /** The operations Railway was asked for, in order, and the credentials each carried. */
  operations: string[];
  credentials: string[];
  cloudflare: Array<{ id: string; type: string; name: string; content: string; proxied: boolean }>;
  cloudflareCalls: string[];
};

let server: Server;
let base = "";
let dir = "";
let bin = "";
let world: World;

// The old project as bootstrap made it before fork PR #223: PostgreSQL 16, two admins and two workers, the address on
// the admin. Its admin has variables connect set and one added by hand, and its keys are newer than the files'.
function oldProject(): StandInProject {
  return {
    id: "prj-old",
    name: host,
    environment: { id: "env-old", name: "production" },
    services: [
      service("old", "Postgres", { image: "pgvector/pgvector:pg16", commit: null, variables: { POSTGRES_PASSWORD: "postgres-password-never-read" } }),
      service("old", "Redis", { image: "redis:7-alpine", commit: null, variables: { REDIS_PASSWORD: "redis-password-never-read" } }),
      service("old", "migrate", { variables: { RAILWAY_DOCKERFILE_PATH: "Dockerfile.migrator", DATABASE_URL: "postgresql://postgres:${{Postgres.POSTGRES_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack" } }),
      service("old", "admin", {
        copies: 2,
        variables: {
          ...adminVariables(`https://${host}`),
          OPENAI_API_KEY: "sk-production-key-newer-than-the-files-0001",
          LOBBYSTACK_APP_POOL_MAX: "12",
          OPENAI_WEBHOOK_SECRET: "whsec_production-webhook-secret-0002",
          PLATFORM_API_KEYS: "platform-keys-never-printed-0003",
          POLAR_WEBHOOK_SECRET: "polar-webhook-secret-never-printed-0004",
          GOOGLE_CLIENT_ID: "google-client-id-added-by-hand",
          GOOGLE_CLIENT_SECRET: "google-client-secret-never-printed-0005",
          RAILWAY_PUBLIC_DOMAIN: "admin-old.up.railway.app",
        },
        sealed: ["LEGACY_SEALED_KEY"],
      }),
      service("old", "worker", { copies: 2, variables: workerVariables() }),
    ],
    volumes: [
      { id: "vol-old-postgres", serviceId: "svc-old-postgres", mountPath: "/var/lib/postgresql/data", sizeMB: 2048 },
      { id: "vol-old-redis", serviceId: "svc-old-redis", mountPath: "/data", sizeMB: 40 },
    ],
    buckets: [{ id: "bkt-old", name: "Bucket", objectCount: 1234, sizeBytes: 3 * 1024 ** 3 }],
    domains: { "svc-old-admin": { custom: [{ domain: host, verified: true, records: [{ recordType: "DNS_RECORD_TYPE_CNAME", fqdn: host, requiredValue: "old1234.up.railway.app" }] }], railway: ["admin-old.up.railway.app"] } },
    proxies: {},
    backups: {
      "vol-old-postgres": [
        { id: "bak-1", name: null, createdAt: "2026-11-22T03:00:00.000Z", expiresAt: "2026-11-29T03:00:00.000Z", usedMB: 300 },
        { id: "bak-2", name: "before the move", createdAt: "2026-11-23T10:00:00.000Z", expiresAt: null, usedMB: 310 },
      ],
    },
    schedules: { "vol-old-postgres": ["DAILY", "WEEKLY"] },
  };
}

// The new project as bootstrap's up builds it from the -pg18 copy: PostgreSQL 18, one copy of each, the temporary address.
function newProject(): StandInProject {
  const temporary = "app-new.example.com";
  return {
    id: "prj-new",
    name: host,
    environment: { id: "env-new", name: "production" },
    services: [
      service("new", "Postgres", { image: "pgvector/pgvector:pg18-trixie", commit: null, variables: { POSTGRES_PASSWORD: "postgres-password-never-read" } }),
      service("new", "Redis", { image: "redis:7-alpine", commit: null, variables: { REDIS_PASSWORD: "redis-password-never-read" } }),
      service("new", "migrate", { variables: { RAILWAY_DOCKERFILE_PATH: "Dockerfile.migrator", DATABASE_URL: "postgresql://postgres:${{Postgres.POSTGRES_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack" } }),
      service("new", "admin", {
        variables: {
          ...adminVariables(`https://${temporary}`),
          OPENAI_API_KEY: "sk-the-files-older-key-0006",
          LOBBYSTACK_APP_POOL_MAX: "6",
          FLEET_STATUS_TOKEN: "fleet-status-token-never-printed-0007",
          RAILWAY_PUBLIC_DOMAIN: "admin-new.up.railway.app",
        },
      }),
      service("new", "worker", { variables: workerVariables() }),
    ],
    volumes: [{ id: "vol-new-postgres", serviceId: "svc-new-postgres", mountPath: "/var/lib/postgresql/data", sizeMB: 120 }],
    buckets: [{ id: "bkt-new", name: "Bucket", objectCount: 1200, sizeBytes: 2 * 1024 ** 3 }],
    domains: { "svc-new-admin": { custom: [{ domain: temporary, verified: true, records: [] }], railway: ["admin-new.up.railway.app"] } },
    proxies: {},
    backups: { "vol-new-postgres": [] },
    schedules: {},
  };
}

function service(project: string, name: string, overrides: Partial<StandInService> = {}): StandInService {
  return { id: `svc-${project}-${name.toLowerCase()}`, name, image: null, status: "SUCCESS", copies: 1, commit: "d533e698a1b2c3d4e5f60718293a4b5c6d7e8f90", variables: {}, sealed: [], ...overrides };
}

function adminVariables(address: string): Vars {
  return {
    RAILWAY_DOCKERFILE_PATH: "Dockerfile.admin",
    APP_BASE_URL: address,
    SITE_URL: "${{APP_BASE_URL}}",
    AUTH_TRUSTED_ORIGINS: `\${{APP_BASE_URL}},https://${address.includes("new") ? "admin-new" : "admin-old"}.up.railway.app`,
    ENCRYPTION_KEY: "encryption-key-the-same-in-both-0008",
    DATABASE_URL: "postgresql://lobbystack_app:${{Postgres.LOBBYSTACK_APP_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack",
  };
}

function workerVariables(): Vars {
  return { RAILWAY_DOCKERFILE_PATH: "Dockerfile.worker", APP_BASE_URL: "${{admin.APP_BASE_URL}}", ENCRYPTION_KEY: "${{admin.ENCRYPTION_KEY}}", SMTP_PASSWORD: "smtp-password-the-same-in-both-0009" };
}

/** Every value the stand-ins hold that's secret: none may show in what the script prints. */
function secretValues(): string[] {
  const values = world.projects.flatMap((project) => project.services.flatMap((item) => Object.entries(item.variables)))
    .filter(([name]) => /KEY|KEYS|TOKEN|SECRET|PASSWORD/.test(name)).map(([, value]) => value);
  return [...new Set([...values, railwayToken, cloudflareToken, "postgres-state-password-0010"])];
}

function freshWorld(): World {
  return {
    projects: [oldProject()],
    schema: JSON.parse(readFileSync(fixture, "utf8")) as World["schema"],
    operations: [],
    credentials: [],
    cloudflare: [
      { id: "rec-cname", type: "CNAME", name: host, content: "old1234.up.railway.app", proxied: false },
      { id: "rec-txt", type: "TXT", name: `_railway-verify.${host}`, content: "\"railway-verify=old-verification-token\"", proxied: false },
      { id: "rec-other", type: "CNAME", name: `www.${zone}`, content: "elsewhere.example.net", proxied: true },
    ],
    cloudflareCalls: [],
  };
}

const projectById = (id: unknown) => world.projects.find((project) => project.id === id);
const serviceById = (id: unknown) => {
  for (const project of world.projects) {
    const found = project.services.find((item) => item.id === id);
    if (found) return { project, service: found };
  }
  return undefined;
};

function read(request: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += String(chunk)));
    request.on("end", () => done(text));
  });
}

function railwayAnswer(body: { query: string; variables: Record<string, unknown> }, authorization: string): { data?: unknown; errors?: Array<{ message: string }> } {
  const operation = /^\s*(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? "";
  world.operations.push(/^\s*mutation\b/.test(body.query) ? `mutation ${operation}` : operation);
  if (operation === "RailwaySchema") return { data: world.schema };
  world.credentials.push(authorization);
  if (authorization !== `Bearer ${railwayToken}`) return { errors: [{ message: "Not Authorized" }] };
  const vars = body.variables;
  const refuse = (message: string) => ({ errors: [{ message }] });
  switch (operation) {
    case "ProjectView": {
      const project = projectById(vars.id);
      if (!project) return refuse("Project not found");
      const instance = (item: StandInService) => ({
        environmentId: project.environment.id,
        region: null,
        numReplicas: null,
        source: { image: item.image, repo: item.commit ? "acme/lobbystack" : null },
        latestDeployment: {
          id: `dep-${item.id}`,
          status: item.status,
          createdAt: "2026-11-23T00:00:00.000Z",
          meta: {
            ...(item.commit ? { commitHash: item.commit, branch: "releases/r2", repo: "acme/lobbystack" } : { image: item.image }),
            serviceManifest: { deploy: { multiRegionConfig: { "us-west2": { numReplicas: item.copies } } } },
          },
        },
      });
      return {
        data: {
          project: {
            id: project.id,
            name: project.name,
            deletedAt: null,
            workspaceId: "ws-acme",
            environments: { edges: [{ node: project.environment }] },
            services: { edges: project.services.map((item) => ({ node: { id: item.id, name: item.name, serviceInstances: { edges: [{ node: instance(item) }] } } })) },
            volumes: {
              edges: project.volumes.map((volume) => ({
                node: { id: `v-${volume.id}`, name: volume.mountPath, volumeInstances: { edges: [{ node: { id: volume.id, environmentId: project.environment.id, serviceId: volume.serviceId, mountPath: volume.mountPath, currentSizeMB: volume.sizeMB, state: "READY" } }] } },
              })),
            },
            buckets: { edges: project.buckets.map(({ id, name }) => ({ node: { id, name } })) },
          },
        },
      };
    }
    case "Projects":
      return { data: { projects: { edges: world.projects.map(({ id, name }) => ({ node: { id, name, deletedAt: null } })) } } };
    case "ServiceVariables": {
      const found = serviceById(vars.serviceId);
      if (!found || found.project.environment.id !== vars.environmentId) return refuse("Service not found");
      if (!/unrendered: true/.test(body.query)) return refuse("expected unrendered variables");
      // The script never reads the database's or Redis's variables.
      if (["Postgres", "Redis"].includes(found.service.name)) return refuse(`the stand-in won't give ${found.service.name}'s variables`);
      const sealed = new Set(found.service.sealed);
      return { data: { variables: Object.fromEntries(Object.entries(found.service.variables).filter(([name]) => !sealed.has(name))) } };
    }
    case "VariableNames": {
      const project = world.projects.find((item) => item.environment.id === vars.id);
      if (!project) return refuse("Environment not found");
      const edges = project.services.flatMap((item) => [
        ...Object.keys(item.variables).map((name) => ({ node: { name, isSealed: false, serviceId: item.id } })),
        ...item.sealed.map((name) => ({ node: { name, isSealed: true, serviceId: item.id } })),
      ]);
      return { data: { environment: { variables: { edges } } } };
    }
    case "Domains": {
      const found = serviceById(vars.serviceId);
      if (!found) return refuse("Service not found");
      const domains = found.project.domains[found.service.id] ?? { custom: [], railway: [] };
      return {
        data: {
          domains: {
            customDomains: domains.custom.map((item, index) => ({
              id: `dom-${index}`,
              domain: item.domain,
              status: { verified: item.verified, dnsRecords: item.records.map((record) => ({ ...record, currentValue: record.requiredValue, status: "DNS_RECORD_STATUS_PROPAGATED" })) },
            })),
            serviceDomains: domains.railway.map((domain, index) => ({ id: `sd-${index}`, domain })),
          },
        },
      };
    }
    case "TcpProxies": {
      const found = serviceById(vars.serviceId);
      return found ? { data: { tcpProxies: found.project.proxies[found.service.id] ?? [] } } : refuse("Service not found");
    }
    case "BackupList": {
      const project = world.projects.find((item) => item.volumes.some((volume) => volume.id === vars.volumeInstanceId));
      return project ? { data: { volumeInstanceBackupList: project.backups[String(vars.volumeInstanceId)] ?? [] } } : refuse("Volume instance not found");
    }
    case "BackupSchedules": {
      const project = world.projects.find((item) => item.volumes.some((volume) => volume.id === vars.volumeInstanceId));
      const kinds = project?.schedules[String(vars.volumeInstanceId)] ?? [];
      return project ? { data: { volumeInstanceBackupScheduleList: kinds.map((kind, index) => ({ id: `sch-${index}`, kind, cron: "0 3 * * *", retentionSeconds: 604_800 })) } } : refuse("Volume instance not found");
    }
    case "BucketDetails": {
      const bucket = world.projects.flatMap((project) => project.buckets).find((item) => item.id === vars.bucketId);
      return bucket ? { data: { bucketInstanceDetails: { objectCount: String(bucket.objectCount), sizeBytes: String(bucket.sizeBytes) } } } : refuse("Bucket not found");
    }
    default:
      return refuse(`the stand-in doesn't know ${operation}`);
  }
}

function cloudflareAnswer(url: URL, authorization: string): [number, unknown] {
  world.cloudflareCalls.push(`${url.pathname}${url.search}`);
  if (authorization !== `Bearer ${cloudflareToken}`) return [401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }];
  const path = url.pathname.slice("/cloudflare".length);
  if (path === "/zones") return [200, { success: true, result: url.searchParams.get("name") === zone ? [{ id: "zone-1", name: zone }] : [] }];
  if (path === "/zones/zone-1/dns_records") {
    const name = url.searchParams.get("name");
    return [200, { success: true, result: world.cloudflare.filter((record) => record.name === name) }];
  }
  return [404, { success: false, errors: [{ code: 7003, message: "No route" }] }];
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", base);
  const authorization = String(request.headers.authorization ?? "");
  if (url.pathname.startsWith("/cloudflare/")) {
    const [status, body] = cloudflareAnswer(url, authorization);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    return;
  }
  const answer = railwayAnswer(JSON.parse(await read(request)) as { query: string; variables: Record<string, unknown> }, authorization);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: null, ...answer }));
}

// ---------------------------------------------------------------- the files and the tools

function writeSettings(file = settingsName, address = `https://${host}`, extra: Vars = {}) {
  const lines = { NAME: "acme-prod", APP_BASE_URL: address, ENVIRONMENT: "production", BRAND: "acme", REPO: "acme/lobbystack", BRANCH: "releases/r2", CLOUDFLARE_ZONE: zone, ...extra };
  writeFileSync(join(dir, file), `# Settings for node devops/bootstrap.mjs\n${Object.entries(lines).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function writeSecrets(file = settingsName, values: Vars = { RAILWAY_API_TOKEN: railwayToken, CLOUDFLARE_API_TOKEN: cloudflareToken }) {
  writeFileSync(join(dir, `${file}.secrets`), `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function writeState(file: string, project: StandInProject | null, extra: Record<string, unknown> = {}) {
  const values = project
    ? { RAILWAY_PROJECT_ID: project.id, RAILWAY_ENVIRONMENT_ID: project.environment.id, RAILWAY_PROJECT_NAME: host, RAILWAY_SERVICE_IDS: Object.fromEntries(project.services.map((item) => [item.name, item.id])) }
    : {};
  writeFileSync(join(dir, `${file}.state.json`), `${JSON.stringify({ done: {}, values: { ...values, POSTGRES_PASSWORD: "postgres-state-password-0010", ...extra } }, null, 2)}\n`);
}

/** The old deployment's three files, as bootstrap's up left them. */
function oldFiles() {
  writeSettings();
  writeSecrets();
  writeState(settingsName, world.projects[0] ?? null);
}

/** The -pg18 copy, after steps 8 and 9, and after up built the new project (step 13) unless `built` is false. */
function copyFiles({ built = true, secrets = {} }: { built?: boolean; secrets?: Vars } = {}) {
  const fresh = newProject();
  const old = world.projects[0];
  // Step 10 renamed the old project before up built the new one under its name.
  if (built && old) old.name = `${host} (old, PostgreSQL 16)`;
  if (built) world.projects.push(fresh);
  writeSettings(copyName, "https://app-new.example.com");
  writeSecrets(copyName, { RAILWAY_API_TOKEN: railwayToken, CLOUDFLARE_API_TOKEN: cloudflareToken, ...secrets });
  writeState(copyName, built ? fresh : world.projects[0] ?? null);
}

const tool = (body: string) => `#!/bin/sh\nexec "${process.execPath}" -e '${body.replace(/'/g, "'\\''")}' -- "$@"\n`;

/** Stand-ins for Docker and the AWS CLI. `docker` is running and has postgres:18 unless told otherwise. */
function writeTools({ docker = true, dockerRunning = true, image = true, aws = true } = {}) {
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin);
  if (docker) {
    writeFileSync(join(bin, "docker"), tool(`
      const [a, b, c] = process.argv.slice(1);
      if (a === "--version") { console.log("Docker version 28.1.1, build 4eba377"); process.exit(0); }
      if (a === "info") process.exit(${dockerRunning ? 0 : 1});
      if (a === "image" && b === "inspect" && c === "postgres:18") process.exit(${image ? 0 : 1});
      process.exit(3);`), { mode: 0o755 });
  }
  if (aws) writeFileSync(join(bin, "aws"), tool(`console.log("aws-cli/2.31.4 Python/3.13.7 Linux/6.8.0 exe/x86_64.ubuntu.24"); process.exit(0);`), { mode: 0o755 });
}

type Result = { code: number | null; out: string };

/** Runs redeploy.mjs in the folder with the settings files, its answers piped in, against the stand-ins. */
function redeploy(args: string[], { input = "", env = {} }: { input?: string; env?: Record<string, string | undefined> } = {}): Promise<Result> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: dir,
      env: {
        // Only the stand-in tools: the script finds no other Docker or AWS CLI.
        PATH: bin,
        SystemRoot: process.env.SystemRoot,
        HOME: dir,
        REDEPLOY_RAILWAY_URL: `${base}/railway`,
        REDEPLOY_CLOUDFLARE_URL: `${base}/cloudflare`,
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

const stateOf = () => JSON.parse(readFileSync(join(dir, `${settingsName}.redeploy.json`), "utf8")) as { done: Record<string, string>; values: { noted?: { at: string; host: string; project: string; records: Array<{ type: string; name: string; content: string }>; copies: Record<string, number> } } };
const lineWith = (out: string, text: string) => out.split("\n").find((line) => line.includes(text)) ?? "";

describe.skipIf(process.platform === "win32")("devops/redeploy.mjs", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ errors: [{ message: String(error) }] }));
      });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "redeploy-test-"));
    bin = join(dir, "bin");
    world = freshWorld();
    writeTools();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds every call it makes in Railway's API as the fixture has it", async () => {
    const result = await redeploy(["schema"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/Railway's API: it has every call this script makes \(\d+ checked\)\./);
    // No token goes with the schema query.
    expect(world.credentials).toEqual([]);
  });

  it("names a call Railway's API no longer has, and status goes on reading", async () => {
    const project = world.schema.__schema.types.find((type) => type.name === "Project");
    if (!project?.fields) throw new Error("the fixture has no Project type");
    project.fields = project.fields.filter((field) => field.name !== "workspaceId");
    const schema = await redeploy(["schema"]);
    expect(schema.code, schema.out).toBe(1);
    expect(schema.out).toContain("ProjectView: Project has no field workspaceId");

    oldFiles();
    const result = await redeploy(["status", settingsName]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Railway's API has changed: a call this script makes won't work as written.");
    expect(result.out).toContain(`The old project: "${host}" (prj-old, environment production)`);
  });

  it("finds the settings file by its address, and stops when none or two name it", async () => {
    oldFiles();
    // The copy names the same address once the cutover has run, and is never taken for the original.
    copyFiles();
    writeSettings(copyName);
    writeSettings(".env.bootstrap-other", "https://other.example.com");
    const found = await redeploy(["status", host]);
    expect(found.code, found.out).toBe(0);
    expect(found.out).toContain(`settings file: ${settingsName} (found by its address)`);

    const fromCopy = await redeploy(["status", copyName]);
    expect(fromCopy.out).toContain(`settings file: ${settingsName} (the original of ${copyName})`);

    const none = await redeploy(["status", "nowhere.example.com"]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("no .env.bootstrap-<name> file in");
    expect(none.out).toContain("has APP_BASE_URL=https://nowhere.example.com");

    writeSettings(".env.bootstrap-acme-again", `https://${host}/`);
    const two = await redeploy(["status", host]);
    expect(two.code).toBe(1);
    expect(two.out).toContain(`2 settings files here name ${host}: .env.bootstrap-acme-again, ${settingsName}.`);
  });

  it("shows the old project before the copy is made, and keeps its DNS records and copies for going back", async () => {
    oldFiles();
    const result = await redeploy(["status", settingsName]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`the new project's copy: not made yet (step 8)`);
    expect(result.out).toContain("Railway's API: it has every call this script makes");
    expect(result.out).toContain("ok     Docker 28.1.1, with the postgres:18 image");
    expect(result.out).toContain("ok     AWS CLI 2.31.4");
    expect(lineWith(result.out, "  Postgres ")).toContain("active, PostgreSQL 16 (pgvector/pgvector:pg16), volume 2.0 GB");
    expect(result.out).toContain(`Railway backups: 2 backups, the newest 2026-11-23 10:00 UTC ("before the move"), 1 locked; schedule daily, weekly`);
    expect(result.out).toContain("TCP proxy: none, so the database takes no connection from the internet");
    expect(lineWith(result.out, "  admin ")).toContain("2 copies, active, release d533e69 (releases/r2)");
    expect(result.out).toContain(`addresses: ${host} (the address), admin-old.up.railway.app`);
    expect(lineWith(result.out, "  Bucket ")).toContain("bucket, 1,234 files, 3.0 GB");
    expect(result.out).toContain("The new project: none yet. Its settings files are made from these (step 8)");
    expect(result.out).toContain(`The old project still has the name "${host}", which up gives the new one: step 10 renames the old one first.`);
    expect(result.out).toContain(`For going back and for the copies (step 7), from Cloudflare's ${zone}:`);
    expect(result.out).toContain(`CNAME ${host}  old1234.up.railway.app`);
    expect(result.out).toContain(`TXT   _railway-verify.${host}  "railway-verify=old-verification-token"`);
    expect(result.out).toContain("copies: 2 of the admin, 2 of the worker");
    expect(result.out).toContain(`Kept in ${settingsName}.redeploy.json.`);
    expect(result.out).not.toContain(`www.${zone}`);

    const noted = stateOf().values.noted;
    expect(noted).toMatchObject({ host, project: "prj-old", copies: { admin: 2, worker: 2 } });
    expect(noted?.records.map((record) => `${record.type} ${record.name} ${record.content}`)).toEqual([
      `CNAME ${host} old1234.up.railway.app`,
      `TXT _railway-verify.${host} "railway-verify=old-verification-token"`,
    ]);
    // It only reads: no call changed anything, and the database's and Redis's variables weren't asked for.
    expect(world.operations.filter((operation) => operation.startsWith("mutation"))).toEqual([]);
    expect(world.operations).not.toContain("ServiceVariables");
    expect(existsSync(join(dir, `${settingsName}.redeploy.json.lock`))).toBe(false);

    const again = await redeploy(["status", settingsName]);
    expect(again.out).toContain(`Kept in ${settingsName}.redeploy.json since ${noted?.at.slice(0, 16).replace("T", " ")} UTC.`);
    expect(stateOf().values.noted?.at).toBe(noted?.at);
  });

  it("compares both projects' variables by name, and never prints a value", async () => {
    oldFiles();
    copyFiles({ secrets: { OPENAI_WEBHOOK_SECRET: "whsec_production-webhook-secret-0002" } });
    const result = await redeploy(["status", settingsName]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`The old project: "${host} (old, PostgreSQL 16)" (prj-old, environment production)`);
    expect(result.out).toContain(`The new project: "${host}" (prj-new, environment production)`);
    expect(lineWith(result.out, "  Postgres ").length).toBeGreaterThan(0);
    expect(result.out).toContain("active, PostgreSQL 18 (pgvector/pgvector:pg18-trixie)");
    expect(result.out).toContain(`"${host}" is the new project's name, as it should be.`);
    expect(result.out).toContain("Buckets: the new one has 1,200 files (2.0 GB), the old one 1,234 files (3.0 GB). Copy the old one's files across again before the switch (steps 18 and 28).");

    const block = result.out.slice(result.out.indexOf("Variables, old against new"), result.out.indexOf("For going back"));
    expect(block).toContain("migrate: the same in both");
    expect(block).toContain("worker: the same in both");
    expect(block).toContain("only in the old project, set by connect: OPENAI_WEBHOOK_SECRET, PLATFORM_API_KEYS, POLAR_WEBHOOK_SECRET.");
    expect(block).toContain("only in the old project, so added in Railway by hand: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. Copy them to the new admin (step 16)");
    expect(block).toContain("different: APP_BASE_URL, AUTH_TRUSTED_ORIGINS, the address, which the cutover sets back (step 30)");
    expect(block).toContain(`different: OPENAI_API_KEY, a key changed in Railway since the files were written.`);
    expect(block).toContain(`the key in ${copyName}.secrets, then redo its step and up (step 16)`);
    expect(block).toContain("different: LOBBYSTACK_APP_POOL_MAX. The new value is the script's own; keep it");
    expect(block).toContain("only in the new project: FLEET_STATUS_TOKEN");
    expect(block).toContain("sealed, so Railway shows no value to compare: LEGACY_SEALED_KEY. Check it by hand");
    expect(block).toContain(`OPENAI_WEBHOOK_SECRET in ${copyName}.secrets, which connect puts on the admin: the same as the old admin's`);
    // Railway's own variables differ between projects by nature, and aren't listed.
    expect(block).not.toContain("RAILWAY_PUBLIC_DOMAIN");
    expect(block).not.toContain("control");
    for (const value of secretValues()) expect(result.out).not.toContain(value);
    // The old admin still has the address, so the notes are kept.
    expect(stateOf().values.noted?.records[0]?.content).toBe("old1234.up.railway.app");
  });

  it("says when the copy's webhook secret isn't the old admin's", async () => {
    oldFiles();
    copyFiles({ secrets: { OPENAI_WEBHOOK_SECRET: "whsec_an-older-webhook-secret-0011" } });
    const result = await redeploy(["status", settingsName]);
    expect(result.out).toContain(`OPENAI_WEBHOOK_SECRET in ${copyName}.secrets, which connect puts on the admin: differs from the old admin's. Put the old admin's there before connect runs (step 16)`);
    expect(result.out).not.toContain("whsec_an-older-webhook-secret-0011");
  });

  it("says when the copy still names the old project, before step 11", async () => {
    oldFiles();
    copyFiles({ built: false });
    const result = await redeploy(["status", settingsName]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`the new project's copy: ${copyName}, at the address app-new.example.com`);
    expect(result.out).toContain(`The new project: none yet. ${copyName} still names the old project: step 11 makes it forget it (redo railway.project, once), then up builds the new one (step 13).`);
    expect(result.out).not.toContain("Variables, old against new");
  });

  it("keeps the notes from before the switch once the new admin has the address", async () => {
    oldFiles();
    copyFiles();
    await redeploy(["status", settingsName]);
    const before = stateOf().values.noted;
    // Step 30: the address moved, and Cloudflare's CNAME now points at the new project.
    const [old, fresh] = world.projects;
    if (!old || !fresh) throw new Error("two projects expected");
    old.domains["svc-old-admin"] = { custom: [], railway: ["admin-old.up.railway.app"] };
    fresh.domains["svc-new-admin"] = { custom: [{ domain: host, verified: true, records: [] }], railway: ["admin-new.up.railway.app"] };
    const cname = world.cloudflare.find((record) => record.id === "rec-cname");
    if (cname) cname.content = "new5678.up.railway.app";
    const result = await redeploy(["status", settingsName]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`CNAME ${host}  new5678.up.railway.app`);
    expect(result.out).toContain(`Kept from before the switch, ${before?.at.slice(0, 16).replace("T", " ")} UTC, in ${settingsName}.redeploy.json, and not changed now: the new admin has ${host}.`);
    expect(stateOf().values.noted).toEqual(before);
  });

  it("shows a TCP proxy that opens a database to the internet", async () => {
    oldFiles();
    const old = world.projects[0];
    if (!old) throw new Error("the old project is missing");
    old.proxies["svc-old-postgres"] = [{ id: "tcp-1", domain: "junction.proxy.rlwy.net", proxyPort: 20393, applicationPort: 5432, syncStatus: "ACTIVE" }];
    const result = await redeploy(["status", settingsName]);
    expect(result.out).toContain("TCP proxy: junction.proxy.rlwy.net:20393 to port 5432: open to the internet to anyone with the password until it's deleted (steps 20 and 39)");
  });

  it("doesn't keep notes while another run holds the lock", async () => {
    oldFiles();
    writeFileSync(join(dir, `${settingsName}.redeploy.json.lock`), JSON.stringify({ pid: process.pid, command: "cutover", started: "2026-11-24T05:00:00.000Z" }));
    const result = await redeploy(["status", settingsName]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`another run (cutover, process ${process.pid}, since 2026-11-24T05:00:00.000Z) is using ${settingsName}.redeploy.json`);
    expect(result.out).toContain(`Not kept: another run is using ${settingsName}.redeploy.json.`);
    expect(existsSync(join(dir, `${settingsName}.redeploy.json`))).toBe(false);
    expect(existsSync(join(dir, `${settingsName}.redeploy.json.lock`))).toBe(true);
  });

  it("takes over a lock left by a run that's gone", async () => {
    oldFiles();
    writeFileSync(join(dir, `${settingsName}.redeploy.json.lock`), JSON.stringify({ pid: 2 ** 22 + 12_345, command: "prepare", started: "2026-11-24T05:00:00.000Z" }));
    const result = await redeploy(["status", settingsName]);
    expect(result.out).toContain(`a lock left by a run that's gone: ${settingsName}.redeploy.json.lock, which the next run takes over (R2)`);
    expect(result.out).toContain(`Kept in ${settingsName}.redeploy.json.`);
    expect(existsSync(join(dir, `${settingsName}.redeploy.json.lock`))).toBe(false);
  });

  it("stops with a clear message when Railway refuses the token, and never prints it", async () => {
    oldFiles();
    writeSecrets(settingsName, { RAILWAY_API_TOKEN: "railway-token-from-another-account-0012" });
    const result = await redeploy(["status", settingsName]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Stopped: Railway refused ProjectView (Not Authorized). The token has to reach both projects: an account token, or a token of their workspace (railway.com/account/tokens)");
    expect(result.out).not.toContain("railway-token-from-another-account-0012");

    // From the environment, it wins over the file.
    const fromEnvironment = await redeploy(["status", settingsName], { env: { RAILWAY_API_TOKEN: railwayToken } });
    expect(fromEnvironment.code, fromEnvironment.out).toBe(0);
  });

  it("asks for the token when no file has it", async () => {
    oldFiles();
    writeSecrets(settingsName, { CLOUDFLARE_API_TOKEN: cloudflareToken });
    const result = await redeploy(["status", settingsName], { input: `${railwayToken}\n` });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Railway account or workspace token (typing is hidden):");
    expect(result.out).not.toContain(railwayToken);
    const none = await redeploy(["status", settingsName]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("Stopped: no Railway token given");
  });

  it("names what this computer lacks for the copy", async () => {
    oldFiles();
    writeTools({ dockerRunning: false, aws: false });
    const stopped = await redeploy(["status", settingsName]);
    expect(stopped.out).toContain("note   Docker 28.1.1 is installed but isn't running: start Docker Desktop before the copy");
    expect(stopped.out).toContain("FIX    no AWS CLI: the bucket's files are copied with it (guide 7.7)");
    writeTools({ docker: false, image: false });
    const missing = await redeploy(["status", settingsName]);
    expect(missing.out).toContain("FIX    no Docker: PostgreSQL 18's tools run in it, for the database copy (Docker Desktop on Windows and Mac)");
    writeTools({ image: false });
    const noImage = await redeploy(["status", settingsName]);
    expect(noImage.out).toContain("note   Docker 28.1.1, without the postgres:18 image yet: docker pull postgres:18 gets it (step 2)");
  });

  it("reads the records Railway asks for when the settings name no Cloudflare zone", async () => {
    world.projects[0] = oldProject();
    writeSettings(settingsName, `https://${host}`, { CLOUDFLARE_ZONE: "" });
    writeSecrets(settingsName, { RAILWAY_API_TOKEN: railwayToken });
    writeState(settingsName, world.projects[0]);
    const result = await redeploy(["status", settingsName]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("For going back and for the copies (step 7), from what Railway asks for:");
    expect(result.out).toContain(`CNAME ${host}  old1234.up.railway.app`);
    expect(result.out).toContain(`The settings name no CLOUDFLARE_ZONE, so note the records ${host} and _railway-verify.${host} have at the DNS provider.`);
    expect(world.cloudflareCalls).toEqual([]);
  });

  it("stops when the state file names a project Railway doesn't have", async () => {
    oldFiles();
    world.projects = [];
    const result = await redeploy(["status", settingsName]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Stopped: Railway has no old project prj-old, which its state file names: was it deleted?");
  });

  it("explains its commands, and refuses what it doesn't know", async () => {
    const help = await redeploy(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("node devops/redeploy.mjs status <settings file or address>");
    const unknown = await redeploy(["cutover", settingsName]);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain("Unknown command cutover.");
    const noTarget = await redeploy(["status"]);
    expect(noTarget.code).toBe(2);
    expect(noTarget.out).toContain("status takes the settings file, or the deployment's address.");
  });
});
