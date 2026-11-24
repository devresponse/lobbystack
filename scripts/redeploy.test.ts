import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// devops/redeploy.mjs end to end, run as a person runs it: in a folder with a deployment's settings files, against one
// local server that stands in for Railway's API, Cloudflare's and the admins' addresses, with stand-ins for Docker and
// the AWS CLI on the PATH, and for bootstrap.mjs and scale.mjs, which the change commands run.
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
/** A service and its latest deployment: deployments counts the ones made since the test began, which changes its ID. */
type StandInService = { id: string; name: string; image: string | null; status: string; copies: number; commit: string | null; variables: Vars; sealed: string[]; deployments?: number };
/** Railway gives the check record of a name it hasn't verified apart from the CNAME, named relative to the zone's apex. */
type StandInDomain = { id?: string; domain: string; verified: boolean; records: Array<{ recordType: string; fqdn: string; requiredValue: string }>; verification?: { host: string; token: string } };
type StandInProject = {
  id: string;
  name: string;
  deletedAt?: string | null;
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
  cloudflare: Array<{ id: string; type: string; name: string; content: string; proxied: boolean; comment?: string }>;
  cloudflareCalls: string[];
  /** What the change commands asked Railway to change, for the tests to check where each change went. */
  patches: Array<{ environmentId: string; skipDeploys: unknown; patch: unknown }>;
  upserts: Array<{ serviceId: string; names: string[] }>;
  domainsMade: Array<{ serviceId: string; domain: string }>;
  domainsDeleted: string[];
  disconnected: string[];
  /** Each deployment the script started, and how: "redeploy <service> on its image", "service redeploy <service>", "deploy <service>", "up <service>". */
  deploys: string[];
  /** Whether Railway refuses to deploy a removed deployment again. */
  refuseRedeploy: boolean;
  /** Whether Railway refuses the token a change's progress, as it did a production run's on 2026-11-24. */
  refuseWorkflowStatus: boolean;
  /** The calls in progress the old workers report through the fleet status address, one answer at a time; the last stays. */
  liveCalls: number[];
  /** What the admin's /api/health/live says it runs. */
  version: string;
  /** How many of bootstrap's up runs fail before one succeeds. */
  upFails: number;
  /** Addresses whose health check doesn't answer ok. */
  unhealthy: Set<string>;
  counter: number;
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
    patches: [],
    upserts: [],
    domainsMade: [],
    domainsDeleted: [],
    disconnected: [],
    deploys: [],
    refuseRedeploy: false,
    refuseWorkflowStatus: false,
    liveCalls: [0],
    version: "d533e698a1b2c3d4e5f60718293a4b5c6d7e8f90",
    upFails: 0,
    unhealthy: new Set(),
    counter: 0,
  };
}

const projectById = (id: unknown) => world.projects.find((project) => project.id === id);
const deploymentOf = (item: StandInService) => `dep-${item.id}${item.deployments ? `-${item.deployments}` : ""}`;
const allServices = () => world.projects.flatMap((project) => project.services);
const projectOfVolume = (id: unknown) => world.projects.find((item) => item.volumes.some((volume) => volume.id === id));
const domainId = (serviceId: string, item: StandInDomain, index: number) => item.id ?? `dom-${serviceId}-${index}`;
// The keys of each bucket, which only the AWS CLI stand-in may receive.
const bucketSecret = (id: string) => `bucket-secret-${id}-never-printed-0015`;
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
          id: deploymentOf(item),
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
            deletedAt: project.deletedAt ?? null,
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
      return { data: { projects: { edges: world.projects.map(({ id, name, deletedAt }) => ({ node: { id, name, deletedAt: deletedAt ?? null } })) } } };
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
      const answer = {
        data: {
          domains: {
            customDomains: domains.custom.map((item, index) => ({
              id: domainId(found.service.id, item, index),
              domain: item.domain,
              status: {
                verified: item.verified,
                verificationDnsHost: item.verification?.host ?? null,
                verificationToken: item.verification?.token ?? null,
                dnsRecords: item.records.map((record) => ({ ...record, currentValue: record.requiredValue, status: "DNS_RECORD_STATUS_PROPAGATED" })),
              },
            })),
            serviceDomains: domains.railway.map((domain, index) => ({ id: `sd-${index}`, domain })),
          },
        },
      };
      // A name Railway hasn't verified yet is verified by the next time it's asked.
      for (const item of domains.custom) item.verified = true;
      return answer;
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
    case "BackupCreate": {
      const project = projectOfVolume(vars.volumeInstanceId);
      if (!project) return refuse("Volume instance not found");
      world.counter += 1;
      (project.backups[String(vars.volumeInstanceId)] ??= []).push({ id: `bak-made-${world.counter}`, name: String(vars.name), createdAt: new Date().toISOString(), expiresAt: "2026-12-31T00:00:00.000Z", usedMB: 320 });
      return { data: { volumeInstanceBackupCreate: { workflowId: `wf-${world.counter}` } } };
    }
    case "WorkflowStatus":
      return world.refuseWorkflowStatus ? refuse("Not Authorized") : { data: { workflowStatus: { status: "Complete", error: null } } };
    case "BackupLock": {
      const backup = projectOfVolume(vars.volumeInstanceId)?.backups[String(vars.volumeInstanceId)]?.find((item) => item.id === vars.volumeInstanceBackupId);
      if (!backup) return refuse("Backup not found");
      backup.expiresAt = null;
      return { data: { volumeInstanceBackupLock: true } };
    }
    case "BackupScheduleUpdate": {
      const project = projectOfVolume(vars.volumeInstanceId);
      if (!project) return refuse("Volume instance not found");
      project.schedules[String(vars.volumeInstanceId)] = vars.kinds as string[];
      return { data: { volumeInstanceBackupScheduleUpdate: true } };
    }
    case "BucketCredentials": {
      const project = projectById(vars.projectId);
      const bucket = project?.buckets.find((item) => item.id === vars.bucketId);
      if (!project || !bucket || project.environment.id !== vars.environmentId) return refuse("Bucket not found");
      return { data: { bucketS3Credentials: [{ accessKeyId: `access-${bucket.id}`, secretAccessKey: bucketSecret(bucket.id), endpoint: "https://storage.example.net", bucketName: `${bucket.id}-name`, region: "auto", urlStyle: "virtual" }] } };
    }
    case "ProjectRename": {
      const project = projectById(vars.id);
      if (!project) return refuse("Project not found");
      project.name = String(vars.name);
      return { data: { projectUpdate: { id: project.id, name: project.name } } };
    }
    case "Logs": {
      const found = allServices().find((item) => deploymentOf(item) === vars.deploymentId);
      const major = found?.image?.match(/pg(\d+)/)?.[1];
      if (major) return { data: { deploymentLogs: [{ timestamp: "2026-11-24T01:00:00.000Z", message: `LOG:  starting PostgreSQL ${major}.1 (Debian ${major}.1-1.pgdg13+2) on x86_64-pc-linux-gnu`, severity: "info" }] } };
      const worker = [
        { timestamp: "2026-11-24T06:01:00.000Z", message: "outbox: 3 jobs done", severity: "info" },
        { timestamp: "2026-11-24T06:02:00.000Z", message: "Twilio answered 503, trying again", severity: "error" },
      ];
      return { data: { deploymentLogs: found?.name === "worker" ? worker : [] } };
    }
    case "VariablesUpsert": {
      const input = vars.input as { projectId: string; environmentId: string; serviceId: string; variables: Vars };
      const found = serviceById(input.serviceId);
      if (!found || found.project.id !== input.projectId || found.project.environment.id !== input.environmentId) return refuse("Service not found");
      Object.assign(found.service.variables, input.variables);
      world.upserts.push({ serviceId: input.serviceId, names: Object.keys(input.variables) });
      return { data: { variableCollectionUpsert: true } };
    }
    case "DeploymentRemove": {
      const found = allServices().find((item) => deploymentOf(item) === vars.id);
      if (!found) return refuse("Deployment not found");
      found.status = "REMOVED";
      return { data: { deploymentRemove: true } };
    }
    case "DeploymentRedeploy": {
      const found = allServices().find((item) => deploymentOf(item) === vars.id);
      if (!found) return refuse("Deployment not found");
      if (world.refuseRedeploy) return refuse("This deployment can't be redeployed");
      found.deployments = (found.deployments ?? 0) + 1;
      found.status = "SUCCESS";
      world.deploys.push(`redeploy ${found.id}${vars.usePreviousImageTag === true ? " on its image" : ""}`);
      return { data: { deploymentRedeploy: { id: deploymentOf(found), status: "INITIALIZING" } } };
    }
    case "ServiceRedeploy":
    case "ServiceDeploy": {
      const found = serviceById(vars.serviceId);
      if (!found || found.project.environment.id !== vars.environmentId) return refuse("Service not found");
      found.service.deployments = (found.service.deployments ?? 0) + 1;
      found.service.status = "SUCCESS";
      world.deploys.push(`${operation === "ServiceRedeploy" ? "service redeploy" : "deploy"} ${found.service.id}`);
      return { data: operation === "ServiceRedeploy" ? { serviceInstanceRedeploy: true } : { serviceInstanceDeployV2: deploymentOf(found.service) } };
    }
    case "DomainAvailable": {
      const taken = world.projects.some((project) => Object.values(project.domains).some((item) => item.custom.some((domain) => domain.domain === vars.domain)));
      return { data: { customDomainAvailable: { available: !taken, message: taken ? "Domain is already in use" : "" } } };
    }
    case "DomainCreate": {
      const input = vars.input as { domain: string; environmentId: string; projectId: string; serviceId: string; targetPort: number };
      const found = serviceById(input.serviceId);
      if (!found || found.project.id !== input.projectId || input.targetPort !== 3000) return refuse("Service not found");
      world.counter += 1;
      const label = input.domain.endsWith(`.${zone}`) ? input.domain.slice(0, -(zone.length + 1)) : input.domain;
      const domain: StandInDomain = {
        id: `dom-made-${world.counter}`,
        domain: input.domain,
        verified: false,
        records: [{ recordType: "DNS_RECORD_TYPE_CNAME", fqdn: input.domain, requiredValue: `${found.service.id}.up.railway.app` }],
        verification: { host: `_railway-verify.${label}`, token: `railway-verify=${found.service.id}` },
      };
      (found.project.domains[found.service.id] ??= { custom: [], railway: [] }).custom.push(domain);
      world.domainsMade.push({ serviceId: found.service.id, domain: input.domain });
      return { data: { customDomainCreate: { id: domain.id, domain: domain.domain } } };
    }
    case "DomainDelete": {
      for (const project of world.projects) {
        for (const [serviceId, domains] of Object.entries(project.domains)) {
          const index = domains.custom.findIndex((item, at) => domainId(serviceId, item, at) === vars.id);
          if (index < 0) continue;
          world.domainsDeleted.push(domains.custom[index]?.domain ?? "");
          domains.custom.splice(index, 1);
          return { data: { customDomainDelete: true } };
        }
      }
      return refuse("Domain not found");
    }
    case "EnvironmentPatch": {
      const project = world.projects.find((item) => item.environment.id === vars.environmentId);
      if (!project) return refuse("Environment not found");
      world.patches.push({ environmentId: String(vars.environmentId), skipDeploys: vars.skipDeploys, patch: vars.patch });
      const services = (vars.patch as { services?: Record<string, { networking?: { tcpProxies?: Record<string, unknown> } }> }).services ?? {};
      for (const [serviceId, config] of Object.entries(services)) {
        if (!project.services.some((item) => item.id === serviceId)) return refuse("Service not found in the environment");
        const proxy = config.networking?.tcpProxies?.["5432"];
        if (proxy === null) delete project.proxies[serviceId];
        else if (proxy) {
          world.counter += 1;
          project.proxies[serviceId] = [{ id: `tcp-${world.counter}`, domain: `${project.id.replace("prj-", "")}.proxy.rlwy.net`, proxyPort: 20_000 + world.counter, applicationPort: 5432, syncStatus: "ACTIVE" }];
        }
      }
      return { data: { environmentPatchCommit: `wf-patch-${world.patches.length}` } };
    }
    case "TcpProxyDelete": {
      for (const project of world.projects) for (const [serviceId, list] of Object.entries(project.proxies)) project.proxies[serviceId] = list.filter((item) => item.id !== vars.id);
      return { data: { tcpProxyDelete: true } };
    }
    case "ServiceDisconnect": {
      const found = serviceById(vars.id);
      if (!found) return refuse("Service not found");
      found.service.commit = null;
      world.disconnected.push(found.service.id);
      return { data: { serviceDisconnect: { id: found.service.id } } };
    }
    case "ProjectScheduleDelete": {
      const project = projectById(vars.id);
      if (!project) return refuse("Project not found");
      project.deletedAt = "2026-12-03T00:00:00.000Z";
      return { data: { projectScheduleDelete: true } };
    }
    default:
      return refuse(`the stand-in doesn't know ${operation}`);
  }
}

function cloudflareAnswer(method: string, url: URL, authorization: string, body: Record<string, unknown> | null): [number, unknown] {
  world.cloudflareCalls.push(`${method === "GET" ? "" : `${method} `}${url.pathname}${url.search}`);
  if (authorization !== `Bearer ${cloudflareToken}`) return [401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }];
  const path = url.pathname.slice("/cloudflare".length);
  if (path === "/zones") return [200, { success: true, result: url.searchParams.get("name") === zone ? [{ id: "zone-1", name: zone }] : [] }];
  if (path === "/zones/zone-1/dns_records" && method === "GET") {
    const name = url.searchParams.get("name");
    const type = url.searchParams.get("type");
    return [200, { success: true, result: world.cloudflare.filter((record) => record.name === name && (!type || record.type === type)) }];
  }
  if (path === "/zones/zone-1/dns_records" && method === "POST" && body) {
    world.counter += 1;
    const record = { id: `rec-made-${world.counter}`, type: String(body.type), name: String(body.name), content: String(body.content), proxied: Boolean(body.proxied), comment: String(body.comment ?? "") };
    world.cloudflare.push(record);
    return [200, { success: true, result: record }];
  }
  const one = /^\/zones\/zone-1\/dns_records\/([\w-]+)$/.exec(path);
  const record = one && world.cloudflare.find((item) => item.id === one[1]);
  if (record && method === "PATCH" && body) {
    Object.assign(record, { content: String(body.content ?? record.content), proxied: Boolean(body.proxied ?? record.proxied) });
    return [200, { success: true, result: record }];
  }
  if (record && method === "DELETE") {
    world.cloudflare = world.cloudflare.filter((item) => item !== record);
    return [200, { success: true, result: { id: record.id } }];
  }
  return [404, { success: false, errors: [{ code: 7003, message: "No route" }] }];
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", base);
  const authorization = String(request.headers.authorization ?? "");
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname.startsWith("/cloudflare/")) {
    const method = request.method ?? "GET";
    const text = method === "GET" ? "" : await read(request);
    const [status, body] = cloudflareAnswer(method, url, authorization, text ? (JSON.parse(text) as Record<string, unknown>) : null);
    return json(status, body);
  }
  // An admin's addresses, and the control panel's, at the address the script was given.
  const site = /^\/site\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (site) {
    const [, name = "", rest = "/"] = site;
    if (rest === "/api/health/ready") return world.unhealthy.has(name) ? json(503, { ok: false }) : json(200, { ok: true, checks: { database: "ok" } });
    if (rest === "/api/health/live") return json(200, { ok: true, service: "admin", version: world.version });
    if (rest === "/api/internal/fleet") {
      const token = world.projects[0]?.services.find((item) => item.name === "admin")?.variables.FLEET_STATUS_TOKEN;
      if (!token || authorization !== `Bearer ${token}`) return json(401, { error: "unauthorized" });
      const calls = world.liveCalls.length > 1 ? world.liveCalls.shift() : world.liveCalls[0];
      return json(200, { copies: [{ service: "admin", liveCalls: 0 }, { service: "worker", liveCalls: calls ?? 0 }] });
    }
    // The control panel, behind Cloudflare Access.
    response.writeHead(302, { location: "https://acme.cloudflareaccess.com/" });
    return response.end();
  }
  // bootstrap.mjs's stand-in, at up: Railway has the new project, and the address in the copy's settings is on its
  // admin, its CNAME pointing there; a stopped admin and worker are deployed again with their new variables (step 30).
  if (url.pathname === "/test/up") {
    const asked = JSON.parse((await read(request)) || "{}") as { host?: string };
    if (world.upFails > 0) {
      world.upFails -= 1;
      return json(200, { fail: `Railway says ${asked.host} is in use` });
    }
    const fresh = projectById("prj-new") ?? newProject();
    if (!projectById("prj-new")) world.projects.push(fresh);
    const admin = (fresh.domains["svc-new-admin"] ??= { custom: [], railway: [] });
    if (asked.host && !admin.custom.some((item) => item.domain === asked.host)) {
      admin.custom.push({ domain: asked.host, verified: true, records: [{ recordType: "DNS_RECORD_TYPE_CNAME", fqdn: asked.host, requiredValue: "svc-new-admin.up.railway.app" }] });
      for (const record of world.cloudflare) if (record.type === "CNAME" && record.name === asked.host) record.content = "svc-new-admin.up.railway.app";
    }
    for (const item of fresh.services) {
      if (!["admin", "worker"].includes(item.name) || item.status !== "REMOVED") continue;
      item.deployments = (item.deployments ?? 0) + 1;
      item.status = "SUCCESS";
      world.deploys.push(`up ${item.id}`);
    }
    return json(200, { id: fresh.id, environmentId: fresh.environment.id, services: Object.fromEntries(fresh.services.map((item) => [item.name, item.id])) });
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

// The steps bootstrap's up marks done for a deployment like this one, outside Railway and in it.
const BOOTSTRAP_DONE = ["openai.project", "openai.key", "twilio.subaccount", "twilio.trunk", "twilio.tollfree", "resend.domain", "resend.key", "polar.tokens", "secrets", "railway.project", "railway.services", "railway.domain", "railway.custom", "turnstile", "variables", "deploy.admin", "post.health"];

function writeState(file: string, project: StandInProject | null, extra: Record<string, unknown> = {}) {
  const values = project
    ? { RAILWAY_PROJECT_ID: project.id, RAILWAY_ENVIRONMENT_ID: project.environment.id, RAILWAY_PROJECT_NAME: host, RAILWAY_SERVICE_IDS: Object.fromEntries(project.services.map((item) => [item.name, item.id])) }
    : {};
  const done = Object.fromEntries(BOOTSTRAP_DONE.map((step) => [step, "2026-10-01T00:00:00.000Z"]));
  writeFileSync(join(dir, `${file}.state.json`), `${JSON.stringify({ done, values: { ...values, POSTGRES_PASSWORD: "postgres-state-password-0010", ...extra } }, null, 2)}\n`);
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

/**
 * Stand-ins for Docker and the AWS CLI. `docker` is running and has postgres:18 unless told otherwise; its psql, pg_dump,
 * pg_restore, createdb, dropdb and vacuumdb answer as the two servers would, the old one on oldMajor and the new one on
 * newMajor, each keeping its list of databases in databases.json, and each call is written to docker-calls.txt with
 * the password it was given. The new lobbystack counts newTables tables, the trial copy trialTables; the old database
 * has the reset-protection mark when mark is true, and calls.txt holds the calls in progress it counts, one line each
 * time it's asked. `aws s3 sync` writes aws-calls.txt.
 */
function writeTools({ docker = true, dockerRunning = true, image = true, aws = true, oldMajor = 16, newMajor = 18, trialTables = 87, newTables = 87, mark = false } = {}) {
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin);
  if (docker) {
    writeFileSync(join(bin, "docker"), tool(`
      const fs = require("node:fs");
      const all = process.argv.slice(1);
      const [a, b, c] = all;
      if (a === "--version") { console.log("Docker version 28.1.1, build 4eba377"); process.exit(0); }
      if (a === "info") process.exit(${dockerRunning ? 0 : 1});
      if (a === "image" && b === "inspect" && c === "postgres:18") process.exit(${image ? 0 : 1});
      if (a === "pull") process.exit(0);
      if (a !== "run") process.exit(3);
      const [name, ...rest] = all.slice(all.indexOf("postgres:18") + 1);
      const mount = all[all.indexOf("-v") + 1] || "";
      const folder = mount.slice(0, mount.lastIndexOf(":/backup"));
      fs.appendFileSync("docker-calls.txt", JSON.stringify({ name, rest, password: process.env.PGPASSWORD || null, all }) + "\\n");
      if (name === "pg_dump" && rest[0] === "--version") { console.log("pg_dump (PostgreSQL) 18.1"); process.exit(0); }
      if (process.env.PGPASSWORD !== "postgres-state-password-0010") { console.error("FATAL: password authentication failed for user postgres"); process.exit(2); }
      const server = (rest[rest.indexOf("-h") + 1] || "").split(".")[0];
      const database = rest.includes("-d") ? rest[rest.indexOf("-d") + 1] : "";
      const file = rest.includes("-f") ? rest[rest.indexOf("-f") + 1] : "";
      const sql = rest.filter((item, index) => ["-c", "-Atc"].includes(rest[index - 1])).join("; ");
      const databases = fs.existsSync("databases.json") ? JSON.parse(fs.readFileSync("databases.json", "utf8")) : { old: ["postgres", "lobbystack"], new: ["postgres", "lobbystack"] };
      const keep = () => fs.writeFileSync("databases.json", JSON.stringify(databases));
      if (name === "psql" && sql.includes("pg_control_system")) {
        console.log(server === "old" ? "${oldMajor}0004 7300000000000000001" : "${newMajor}0001 7400000000000000002");
        process.exit(0);
      }
      if (name === "psql" && sql.includes("from calls")) {
        const counts = fs.existsSync("calls.txt") ? fs.readFileSync("calls.txt", "utf8").trim().split("\\n") : ["0"];
        console.log(counts[0]);
        if (counts.length > 1) fs.writeFileSync("calls.txt", counts.slice(1).join("\\n"));
        process.exit(0);
      }
      if (name === "psql" && sql.includes("from pg_database")) { console.log(databases[server].join("\\n")); process.exit(0); }
      const renamed = /rename to (\\w+)/.exec(sql);
      if (name === "psql" && renamed) { databases[server] = databases[server].map((item) => (item === "lobbystack" ? renamed[1] : item)); keep(); process.exit(0); }
      if (name === "psql" && sql) process.exit(0);
      if (name === "psql" && file === "freeze.sql") { console.log("3\\n" + ${mark ? '"lobbystack.reset_protection=on"' : '"none"'}); process.exit(0); }
      if (name === "psql" && file === "count.sql") {
        const tables = database === "lobbystack_trial" ? ${trialTables} : server === "new" && database === "lobbystack" ? ${newTables} : 87;
        console.log("tables " + tables + ", rows 45678, fingerprint " + (tables === 87 ? "0123abcd" : "4567ef01"));
        process.exit(0);
      }
      if (name === "psql" && file === "tables.sql") {
        const short = database === "lobbystack_trial" || (server === "new" && ${newTables} !== 87);
        console.log(short ? "public.calls 12" : "public.calls 12\\npublic.extra 3");
        process.exit(0);
      }
      if (name === "psql" && file === "hours.sql") { console.log("03 1\\n09 30\\n14 42"); process.exit(0); }
      if (name === "pg_dump") { fs.writeFileSync(folder + "/" + file, "PGDMP a dump"); process.exit(0); }
      if (name === "createdb") { if (!databases[server].includes(rest.at(-1))) databases[server].push(rest.at(-1)); keep(); process.exit(0); }
      if (name === "dropdb") { databases[server] = databases[server].filter((item) => item !== rest.at(-1)); keep(); process.exit(0); }
      if (["pg_restore", "vacuumdb"].includes(name)) process.exit(0);
      process.exit(3);`), { mode: 0o755 });
  }
  if (aws) {
    writeFileSync(join(bin, "aws"), tool(`
      const fs = require("node:fs");
      const all = process.argv.slice(1);
      if (all[0] === "--version") { console.log("aws-cli/2.31.4 Python/3.13.7 Linux/6.8.0 exe/x86_64.ubuntu.24"); process.exit(0); }
      if (all[0] !== "s3" || all[1] !== "sync") process.exit(3);
      const [from, to] = [all[2], all[3]];
      fs.appendFileSync("aws-calls.txt", JSON.stringify({ from, to, key: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, region: process.env.AWS_DEFAULT_REGION, all }) + "\\n");
      if (from.startsWith("s3://")) {
        fs.mkdirSync(to + "/businesses", { recursive: true });
        fs.writeFileSync(to + "/businesses/logo.png", "a logo");
        fs.writeFileSync(to + "/price-list.pdf", "a price list");
      }
      process.exit(0);`), { mode: 0o755 });
  }
}

/**
 * Stand-ins for bootstrap.mjs and scale.mjs, which the change commands run with node. Each writes its arguments, and
 * whether the Railway token came through its environment, to bootstrap-calls.txt or scale-calls.txt. bootstrap's redo
 * of railway.project forgets the project as bootstrap does, and any other redo forgets the steps it names; its up asks
 * the stand-in server for the new project with the copy's address on it, and its connect records connect's steps.
 */
function writeScripts() {
  writeFileSync(join(dir, "bootstrap-stand-in.mjs"), `import fs from "node:fs";
const POSTGRES_IMAGE = "pgvector/pgvector:pg18-trixie";
const [command, file, ...rest] = process.argv.slice(2);
fs.appendFileSync("bootstrap-calls.txt", [command, file, ...rest].join(" ") + (process.env.RAILWAY_API_TOKEN === "${railwayToken}" ? "" : " (no token)") + "\\n");
const stateFile = file + ".state.json";
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
if (command === "redo") {
  const project = rest.includes("railway.project");
  if (project) for (const key of ["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_IDS", "RAILWAY_HOST", "APP_HOST", "POST_DNS_HOST"]) delete state.values[key];
  const named = (id) => rest.some((step) => (step.endsWith(".*") ? id.startsWith(step.slice(0, -1)) : id === step));
  for (const id of Object.keys(state.done)) {
    if (project ? /^(railway\\.|deploy\\.|post\\.)/.test(id) || ["turnstile", "variables"].includes(id) : named(id)) {
      delete state.done[id];
      console.log("  " + id + ": runs again next time");
    }
  }
  save();
  console.log("Now run up, then connect. " + POSTGRES_IMAGE);
} else if (command === "up" && !rest.includes("--dry-run")) {
  const address = /^APP_BASE_URL=(.*)$/m.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "";
  const made = await (await fetch(process.env.REDEPLOY_RAILWAY_URL.replace(/\\/railway$/, "/test/up"), { method: "POST", body: JSON.stringify({ host: new URL(address).host }) })).json();
  if (made.fail) {
    console.log("up: stopped: " + made.fail);
    process.exit(1);
  }
  Object.assign(state.values, { RAILWAY_PROJECT_ID: made.id, RAILWAY_ENVIRONMENT_ID: made.environmentId, RAILWAY_SERVICE_IDS: made.services });
  for (const id of ["railway.project", "railway.services", "variables", "deploy.admin"]) state.done[id] = new Date().toISOString();
  save();
  console.log("up: the new project is built");
} else if (command === "connect") {
  for (const id of ["connect.webhook", "connect.platformKey", "connect.billing.verify"]) state.done[id] = new Date().toISOString();
  save();
  console.log("connect: Polar's billing plan makes nothing");
} else console.log(command + ": nothing to fix");
`);
  writeFileSync(join(dir, "scale-stand-in.mjs"), `import fs from "node:fs";
fs.appendFileSync("scale-calls.txt", process.argv.slice(2).join(" ") + (process.env.RAILWAY_API_TOKEN === "${railwayToken}" ? "" : " (no token)") + "\\n");
`);
}

type Result = { code: number | null; out: string };

const backupDir = () => join(dir, "backups", "app-before-pg18");

/** What the change commands need from the test: the stand-ins for bootstrap and scale, the health address, short waits. */
const changeEnv = () => ({
  REDEPLOY_BOOTSTRAP: join(dir, "bootstrap-stand-in.mjs"),
  REDEPLOY_SCALE: join(dir, "scale-stand-in.mjs"),
  REDEPLOY_SITE_URL: `${base}/site/{host}`,
  REDEPLOY_POLL_MS: "1",
});

const linesOf = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean) : []);
const dockerCalls = () => linesOf("docker-calls.txt").map((line) => JSON.parse(line) as { name: string; rest: string[]; password: string | null; all: string[] });
const awsCalls = () => linesOf("aws-calls.txt").map((line) => JSON.parse(line) as { from: string; to: string; key: string; secret: string; region: string; all: string[] });
const mutations = () => world.operations.filter((operation) => operation.startsWith("mutation ")).map((operation) => operation.slice("mutation ".length));

/** The move after prepare: the copy built into the new project, and the steps up to 17 recorded with their notes. */
function prepared(done: number[] = range(1, 17), values: Record<string, unknown> = {}) {
  oldFiles();
  copyFiles();
  mkdirSync(backupDir(), { recursive: true });
  // Four days and an hour ago, so retire finds finish ran 4 days ago.
  const at = new Date(Date.now() - 4 * 86_400_000 - 3_600_000).toISOString();
  const noted = { at, project: "prj-old", host, records: [{ type: "CNAME", name: host, content: "old1234.up.railway.app" }], copies: { admin: 2, worker: 2 } };
  writeFileSync(join(dir, `${settingsName}.redeploy.json`), `${JSON.stringify({
    done: Object.fromEntries(done.map((step) => [String(step), at])),
    values: { noted, temporary: "app-new.example.com", oldName: `${host} (old, PostgreSQL 16)`, ...values },
    backup: backupDir(),
    version: 1,
    settings: settingsName,
  }, null, 2)}\n`);
}

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/** The cutover's address move (step 30): the new admin has the address, and Cloudflare's CNAME points at it. */
function moveAddress() {
  const [old, fresh] = world.projects;
  if (!old || !fresh) throw new Error("two projects expected");
  old.domains["svc-old-admin"] = { custom: [], railway: ["admin-old.up.railway.app"] };
  fresh.domains["svc-new-admin"]?.custom.push({ domain: host, verified: true, records: [] });
  const cname = world.cloudflare.find((record) => record.id === "rec-cname");
  if (cname) cname.content = "new5678.up.railway.app";
}

/** The control panel's two services in both projects, as bootstrap's up adds them; step 17 stopped the new cloudflared. */
function withControl() {
  for (const project of world.projects) {
    const which = project.id.replace("prj-", "");
    project.services.push(service(which, "control"), service(which, "cloudflared", { image: "cloudflare/cloudflared:latest", commit: null, status: which === "new" ? "REMOVED" : "SUCCESS" }));
  }
}

/** Both databases' TCP proxies, as step 22 left them open. */
function proxiesOpen() {
  for (const project of world.projects) {
    const which = project.id.replace("prj-", "");
    project.proxies[`svc-${which}-postgres`] = [{ id: `tcp-${which}`, domain: `${which}.proxy.rlwy.net`, proxyPort: 21_000, applicationPort: 5432, syncStatus: "ACTIVE" }];
  }
}

const serviceOf = (project: number, name: string) => {
  const found = world.projects[project]?.services.find((item) => item.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

/** A Docker call as "<tool> <server> <database> <file>", leaving out the checks of each server's version. */
const dockerSteps = () => dockerCalls().filter((call) => call.rest[0] !== "--version" && !call.rest.some((item) => item.includes("pg_control_system"))).map((call) => {
  const after = (flag: string) => (call.rest.includes(flag) ? call.rest[call.rest.indexOf(flag) + 1] : "");
  const sql = call.rest.filter((_, index) => ["-c", "-Atc"].includes(call.rest[index - 1] ?? "")).join("; ");
  return [call.name, (after("-h") ?? "").split(".")[0], after("-d") || call.rest.at(-1), after("-f") || sql].filter(Boolean).join(" ");
});

const databasesOn = () => JSON.parse(readFileSync(join(dir, "databases.json"), "utf8")) as Record<string, string[]>;

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
    writeScripts();
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
    expect(stopped.out).toContain("FIX    no AWS CLI, version 2: the bucket's files are copied with it (guide 7.7)");
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
    const unknown = await redeploy(["move", settingsName]);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain("Unknown command move.");
    const noTarget = await redeploy(["status"]);
    expect(noTarget.code).toBe(2);
    expect(noTarget.out).toContain("status takes the settings file, or the deployment's address.");
    const misplaced = await redeploy(["status", settingsName, "--rehearse", "x.example.com"]);
    expect(misplaced.code).toBe(2);
    expect(misplaced.out).toContain("--rehearse goes with trial.");
  });

  // ---------------------------------------------------------------- prepare

  it("prepare runs steps 1 to 17: the backups, the copy, the new project and the variables it lacks", async () => {
    oldFiles();
    // The copy's secrets file gets an older webhook secret than the old admin's, which step 16 puts right.
    writeSecrets(settingsName, { RAILWAY_API_TOKEN: railwayToken, CLOUDFLARE_API_TOKEN: cloudflareToken, OPENAI_WEBHOOK_SECRET: "whsec_an-older-webhook-secret-0011" });
    // The first yes is to the plan, the second keeps the files' OPENAI_API_KEY (step 16).
    const result = await redeploy(["prepare", settingsName, "--backup", backupDir()], { input: "yes\nyes\n", env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("prepare will:");
    expect(result.out).toContain("Production keeps running throughout, and nothing changes at OpenAI, Twilio, Resend or Polar.\nType yes to go on:");
    expect(result.out).toContain(`rename the old Railway project to "${host} (old, PostgreSQL 16)" (step 10)`);
    expect(result.out).toContain(`build a new Railway project named "${host}" at app-new.example.com with bootstrap's up`);
    expect(result.out).toContain("Next, a day or so before the cutover: node devops/redeploy.mjs trial, steps 18 to 20.");

    // Steps 2 to 4: the tools, the checkout, the backup folder with the three files and the SQL.
    expect(result.out).toContain("ok  pg_dump (PostgreSQL) 18.1");
    expect(result.out).toContain("ok  devops/bootstrap.mjs makes Postgres from pgvector/pgvector:pg18-trixie");
    for (const name of [settingsName, `${settingsName}.secrets`, `${settingsName}.state.json`, "count.sql", "freeze.sql", "tables.sql", "hours.sql"]) expect(existsSync(join(backupDir(), name)), name).toBe(true);
    // Step 5: a backup of the old database, locked.
    const made = world.projects[0]?.backups["vol-old-postgres"]?.find((item) => item.name?.startsWith("before-pg18-"));
    expect(made?.expiresAt).toBeNull();
    expect(result.out).toMatch(/the backup "before-pg18-\d{4}-\d{2}-\d{2}", .* UTC, locked: the schedule never deletes it/);
    // Step 6: the old bucket into the backup folder, with its keys through the environment only.
    expect(awsCalls().map((call) => [call.from, call.to, call.key, call.region])).toEqual([["s3://bkt-old-name", join(backupDir(), "app-files"), "access-bkt-old", "auto"]]);
    expect(awsCalls()[0]?.all).not.toContain(bucketSecret("bkt-old"));
    expect(existsSync(join(backupDir(), "app-files", "businesses", "logo.png"))).toBe(true);
    // Step 7: the notes for going back.
    expect(stateOf().values.noted).toMatchObject({ project: "prj-old", host, copies: { admin: 2, worker: 2 } });
    // Steps 8 and 9: the copy, with the temporary address.
    const copy = readFileSync(join(dir, copyName), "utf8");
    expect(copy).toContain("APP_BASE_URL=https://app-new.example.com\n");
    expect(copy).toContain("NAME=acme-prod\n");
    // Step 10: the old project renamed before up ran.
    expect(world.projects[0]?.name).toBe(`${host} (old, PostgreSQL 16)`);
    // Steps 11 to 13: bootstrap, on the copy only, with the token passed on.
    expect(linesOf("bootstrap-calls.txt")).toEqual([`redo ${copyName} railway.project`, `doctor ${copyName}`, `up ${copyName} --dry-run`, `up ${copyName}`]);
    expect(result.out).toContain("| Now run up, then connect.");
    const copyState = JSON.parse(readFileSync(join(dir, `${copyName}.state.json`), "utf8")) as { done: Record<string, string>; values: Record<string, unknown> };
    expect(copyState.values.RAILWAY_PROJECT_ID).toBe("prj-new");
    for (const step of ["openai.project", "twilio.tollfree", "resend.key", "polar.tokens"]) expect(copyState.done[step], step).toBe("2026-10-01T00:00:00.000Z");
    // The original files still describe the old project.
    expect(JSON.parse(readFileSync(join(dir, `${settingsName}.state.json`), "utf8")).values.RAILWAY_PROJECT_ID).toBe("prj-old");
    // Step 14.
    expect(readdirSync(join(backupDir(), "after-stage-1")).sort()).toEqual([copyName, `${copyName}.secrets`, `${copyName}.state.json`]);
    // Step 15.
    expect(result.out).toContain("ok  Postgres, Redis, migrate, admin, worker: running, and migrate done");
    expect(result.out).toContain("ok  the new Postgres runs pgvector/pgvector:pg18-trixie, and its log says PostgreSQL 18");
    expect(result.out).toContain(`ok  https://app-new.example.com/api/health/ready answers "ok":true.`);
    // Step 16: what connect set and what was added by hand, copied to the new admin with production's values.
    expect(world.upserts).toEqual([{ serviceId: "svc-new-admin", names: ["OPENAI_WEBHOOK_SECRET", "PLATFORM_API_KEYS", "POLAR_WEBHOOK_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] }]);
    const newAdmin = world.projects[1]?.services.find((item) => item.name === "admin");
    expect(newAdmin?.variables.POLAR_WEBHOOK_SECRET).toBe("polar-webhook-secret-never-printed-0004");
    expect(newAdmin?.variables.OPENAI_API_KEY).toBe("sk-the-files-older-key-0006");
    expect(result.out).toContain("different: OPENAI_API_KEY, a key changed in Railway since the files were written.");
    expect(readFileSync(join(dir, `${copyName}.secrets`), "utf8")).toContain("OPENAI_WEBHOOK_SECRET=whsec_production-webhook-secret-0002\n");
    expect(readFileSync(join(dir, `${settingsName}.secrets`), "utf8")).toContain("OPENAI_WEBHOOK_SECRET=whsec_an-older-webhook-secret-0011\n");
    // Step 17: no control panel here, so nothing to stop.
    expect(result.out).toContain("the deployment has no control panel, so no cloudflared: nothing to stop");

    // The old project got a backup and a new name, and nothing else; the new admin got the variables.
    expect(mutations()).toEqual(["BackupCreate", "BackupLock", "ProjectRename", "VariablesUpsert"]);
    expect(Object.keys(stateOf().done).sort((a, b) => Number(a) - Number(b))).toEqual(range(1, 17).map(String));
    for (const value of [...secretValues(), bucketSecret("bkt-old"), "whsec_an-older-webhook-secret-0011"]) expect(result.out).not.toContain(value);
    const log = readFileSync(join(dir, `${settingsName}.redeploy.log`), "utf8");
    expect(log).toContain(`==== prepare ${settingsName}`);
    expect(log).toContain(`ran: node bootstrap-stand-in.mjs up ${copyName}`);
    for (const value of secretValues()) expect(log).not.toContain(value);
    expect(existsSync(join(dir, `${settingsName}.redeploy.json.lock`))).toBe(false);

    const again = await redeploy(["prepare", settingsName], { env: changeEnv() });
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("Every step of prepare is done.");
    expect(linesOf("bootstrap-calls.txt")).toHaveLength(4);
  });

  it("prepare makes and locks the backup when Railway won't show the token its progress", async () => {
    oldFiles();
    world.refuseWorkflowStatus = true;
    const result = await redeploy(["prepare", settingsName, "--backup", backupDir()], { input: "yes\nyes\n", env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Railway won't show this token the progress of the backup, so the script waits for its result instead");
    expect(result.out).toMatch(/the backup "before-pg18-\d{4}-\d{2}-\d{2}", .* UTC, locked: the schedule never deletes it/);
    const made = world.projects[0]?.backups["vol-old-postgres"]?.filter((item) => item.name?.startsWith("before-pg18-"));
    expect(made?.map((item) => item.expiresAt)).toEqual([null]);
    expect(mutations()).toEqual(["BackupCreate", "BackupLock", "ProjectRename", "VariablesUpsert"]);
  });

  it("prepare stops before bootstrap runs while another project has the new one's name, then carries on", async () => {
    oldFiles();
    const stray = { ...oldProject(), id: "prj-stray", name: host, environment: { id: "env-stray", name: "production" }, services: [], volumes: [], buckets: [], domains: {} };
    world.projects.push(stray);
    const stopped = await redeploy(["prepare", settingsName, "--backup", backupDir()], { input: "yes\n", env: changeEnv() });
    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain(`Stopped: step 10: Railway has a project named "${host}" (prj-stray), which up would build into. Rename it, then run again`);
    expect(world.projects[0]?.name).toBe(`${host} (old, PostgreSQL 16)`);
    expect(existsSync(join(dir, "bootstrap-calls.txt"))).toBe(false);
    expect(stateOf().done["9"]).toBeTruthy();
    expect(stateOf().done["10"]).toBeUndefined();

    world.projects = world.projects.filter((project) => project.id !== "prj-stray");
    const resumed = await redeploy(["prepare", settingsName], { input: "yes\nyes\n", env: changeEnv() });
    expect(resumed.code, resumed.out).toBe(0);
    expect(resumed.out).toContain(`= the old project is named "${host} (old, PostgreSQL 16)" already`);
    // The backup made before the stop is the one kept: no second one.
    expect(world.projects[0]?.backups["vol-old-postgres"]?.filter((item) => item.name?.startsWith("before-pg18-"))).toHaveLength(1);
    expect(linesOf("bootstrap-calls.txt")).toEqual([`redo ${copyName} railway.project`, `doctor ${copyName}`, `up ${copyName} --dry-run`, `up ${copyName}`]);
  });

  it("prepare --dry-run lists the steps and what it would change, and changes nothing", async () => {
    oldFiles();
    const result = await redeploy(["prepare", settingsName, "--dry-run", "--backup", backupDir()], { env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("prepare: steps 1 to 17, while production runs");
    expect(result.out).toContain("      13. The new project, built by bootstrap's up from the copy, on PostgreSQL 18");
    expect(result.out).toContain("prepare would:\n  - make a Railway backup of the old database and lock it (step 5)");
    expect(result.out).toContain("A dry run: nothing was changed.");
    expect(mutations()).toEqual([]);
    expect(existsSync(backupDir())).toBe(false);
    expect(existsSync(join(dir, copyName))).toBe(false);
    expect(existsSync(join(dir, `${settingsName}.redeploy.json`))).toBe(false);
    expect(existsSync(join(dir, `${settingsName}.redeploy.log`))).toBe(false);
  });

  it("prepare refuses an old database on PostgreSQL 18 unless asked to rehearse, and stops at a no", async () => {
    oldFiles();
    const postgres = world.projects[0]?.services.find((item) => item.name === "Postgres");
    if (!postgres) throw new Error("no Postgres");
    postgres.image = "pgvector/pgvector:pg18-trixie";
    const refused = await redeploy(["prepare", settingsName, "--backup", backupDir()], { input: "yes\n", env: changeEnv() });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("Stopped: the old database runs PostgreSQL 18 already (pgvector/pgvector:pg18-trixie), so there's nothing to move. To rehearse the move on it anyway, add --same-version");

    const declined = await redeploy(["prepare", settingsName, "--same-version", "--backup", backupDir()], { input: "no\n", env: changeEnv() });
    expect(declined.code).toBe(1);
    expect(declined.out).toContain(`rename the old Railway project to "${host} (old, PostgreSQL 18)" (step 10)`);
    expect(declined.out).toContain("Stopped: stopped at your answer. Nothing more was changed");
    expect(mutations()).toEqual([]);
  });

  it("refuses to run while another run holds the lock", async () => {
    oldFiles();
    writeFileSync(join(dir, `${settingsName}.redeploy.json.lock`), JSON.stringify({ pid: process.pid, command: "trial", started: "2026-11-24T05:00:00.000Z" }));
    const result = await redeploy(["prepare", settingsName, "--backup", backupDir()], { input: "yes\n", env: changeEnv() });
    expect(result.code).toBe(1);
    expect(result.out).toContain(`Stopped: another run (trial, process ${process.pid}) is using ${settingsName}.redeploy.json. Let it finish; if none is running, delete ${settingsName}.redeploy.json.lock (R2)`);
    expect(world.operations).toEqual([]);
  });

  // ---------------------------------------------------------------- trial

  it("trial copies the bucket, rehearses the address move and makes a timed trial copy, then cleans up", async () => {
    prepared();
    const result = await redeploy(["trial", settingsName], { input: "yes\n", env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`add move-test.${zone} to the old admin with its records in Cloudflare, move it to the new admin, then remove it and its records; ${host} isn't touched (step 19)`);

    // Step 18: old bucket into the folder, the folder into the new bucket, each with its own keys.
    expect(awsCalls().map((call) => [call.from, call.to, call.key])).toEqual([
      ["s3://bkt-old-name", join(backupDir(), "app-files"), "access-bkt-old"],
      [join(backupDir(), "app-files"), "s3://bkt-new-name", "access-bkt-new"],
    ]);
    expect(awsCalls().every((call) => !call.all.includes("--delete"))).toBe(true);

    // Step 19: on the old admin, then the new one, then gone, records and all; production's address untouched.
    expect(world.domainsMade).toEqual([{ serviceId: "svc-old-admin", domain: `move-test.${zone}` }, { serviceId: "svc-new-admin", domain: `move-test.${zone}` }]);
    expect(world.domainsDeleted).toEqual([`move-test.${zone}`, `move-test.${zone}`]);
    expect(world.projects[0]?.domains["svc-old-admin"]?.custom.map((item) => item.domain)).toEqual([host]);
    expect(world.cloudflare.map((record) => record.id).sort()).toEqual(["rec-cname", "rec-other", "rec-txt"]);
    expect(world.cloudflareCalls.filter((call) => /^(POST|PATCH|DELETE) /.test(call)).map((call) => call.split(" ")[0])).toEqual(["POST", "POST", "PATCH", "PATCH", "DELETE", "DELETE"]);
    expect(result.out).toContain(`Cloudflare: CNAME move-test.${zone}  svc-new-admin.up.railway.app`);
    expect(result.out).toMatch(/Railway took \d+ seconds? to verify the name on the new admin/);

    // Step 20: both databases opened without a deploy, checked, the old one only read, the new one written only in
    // lobbystack_trial, then both closed again.
    expect(world.patches.map((item) => [item.environmentId, item.skipDeploys, JSON.stringify(item.patch)])).toEqual([
      ["env-old", true, '{"services":{"svc-old-postgres":{"networking":{"tcpProxies":{"5432":{}}}}}}'],
      ["env-new", true, '{"services":{"svc-new-postgres":{"networking":{"tcpProxies":{"5432":{}}}}}}'],
      ["env-old", true, '{"services":{"svc-old-postgres":{"networking":{"tcpProxies":{"5432":null}}}}}'],
      ["env-new", true, '{"services":{"svc-new-postgres":{"networking":{"tcpProxies":{"5432":null}}}}}'],
    ]);
    expect(world.projects.every((project) => Object.values(project.proxies).every((list) => !list.length))).toBe(true);
    const calls = dockerCalls().filter((call) => call.rest[0] !== "--version");
    const server = (call: { rest: string[] }) => (call.rest[call.rest.indexOf("-h") + 1] ?? "").split(".")[0];
    expect(calls.map((call) => `${call.name} ${server(call)} ${call.rest.includes("-d") ? call.rest[call.rest.indexOf("-d") + 1] : call.rest.at(-1)}`)).toEqual([
      "psql old postgres", "psql new postgres",
      "psql old lobbystack", "pg_dump old lobbystack",
      "psql new postgres", "dropdb new lobbystack_trial", "createdb new lobbystack_trial", "pg_restore new lobbystack_trial",
      "psql new lobbystack_trial", "psql old lobbystack",
      "psql new postgres", "dropdb new lobbystack_trial",
    ]);
    for (const call of calls) {
      expect(call.password).toBe("postgres-state-password-0010");
      expect(call.all.join(" ")).not.toContain("postgres-state-password-0010");
    }
    expect(calls.find((call) => call.name === "pg_restore")?.rest).toEqual(expect.arrayContaining(["-O", "-1", "-e", "trial.dump"]));
    expect(result.out).toContain("old: PostgreSQL 16, new: PostgreSQL 18");
    expect(result.out).toContain("RESTORE OK");
    expect(result.out).toContain("SAME: the trial copy has every table, with the same rows");
    expect(result.out).toContain("fewest, 0: 00h, 01h, 02h, 04h, 05h, 06h, 07h, 08h, and 13 more");
    expect(existsSync(join(backupDir(), "trial.dump"))).toBe(false);
    expect(stateOf().done).toMatchObject({ 18: expect.any(String), 19: expect.any(String), 20: expect.any(String) });
    for (const value of [...secretValues(), bucketSecret("bkt-old"), bucketSecret("bkt-new")]) expect(result.out).not.toContain(value);
    expect(mutations().filter((name) => name === "DomainCreate")).toHaveLength(2);
  });

  it("trial changes nothing on a new server that isn't on PostgreSQL 18, and still closes the databases", async () => {
    prepared();
    writeTools({ newMajor: 16 });
    const result = await redeploy(["trial", settingsName, "--no-rehearsal"], { input: "yes\n", env: changeEnv() });
    expect(result.code).toBe(1);
    expect(result.out).toContain("Stopped: step 20: the new server runs PostgreSQL 16, not 18, so nothing was copied");
    expect(dockerCalls().map((call) => call.name)).toEqual(["psql", "psql"]);
    expect(world.projects.every((project) => Object.values(project.proxies).every((list) => !list.length))).toBe(true);
    expect(stateOf().done["19"]).toBeTruthy();
    expect(stateOf().done["20"]).toBeUndefined();
  });

  it("trial stops when the trial copy lacks a table, and closes the proxies an interrupted run left open", async () => {
    // A run interrupted during step 20 left both proxies open, as the state file records.
    prepared(range(1, 19), { proxies: ["old", "new"] });
    for (const project of world.projects) project.proxies[`svc-${project.id.replace("prj-", "")}-postgres`] = [{ id: `tcp-${project.id}`, domain: `${project.id.replace("prj-", "")}.proxy.rlwy.net`, proxyPort: 21_000, applicationPort: 5432, syncStatus: "ACTIVE" }];
    writeTools({ trialTables: 86 });
    const result = await redeploy(["trial", settingsName], { input: "yes\n", env: changeEnv() });
    expect(result.code).toBe(1);
    expect(result.out).toContain("the old database's TCP proxy is there already, left open by an earlier run of this script: old.proxy.rlwy.net:21000");
    expect(result.out).toContain("    < public.extra 3");
    expect(result.out).toContain("Stopped: step 20: the trial copy has other tables than production. Find out why before the cutover");
    expect(dockerCalls().filter((call) => call.name === "dropdb").length).toBe(2);
    expect(existsSync(join(backupDir(), "trial.dump"))).toBe(false);
    expect(world.projects.every((project) => Object.values(project.proxies).every((list) => !list.length))).toBe(true);
    expect((stateOf().values as { proxies?: string[] }).proxies).toEqual([]);
  });

  it("trial leaves a TCP proxy opened by hand as it was", async () => {
    prepared(range(1, 19));
    const old = world.projects[0];
    if (!old) throw new Error("no old project");
    old.proxies["svc-old-postgres"] = [{ id: "tcp-by-hand", domain: "old.proxy.rlwy.net", proxyPort: 21_001, applicationPort: 5432, syncStatus: "ACTIVE" }];
    const result = await redeploy(["trial", settingsName], { input: "yes\n", env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("the old database's TCP proxy is there already: old.proxy.rlwy.net:21001");
    expect(old.proxies["svc-old-postgres"]?.map((item) => item.id)).toEqual(["tcp-by-hand"]);
    expect(world.patches.map((item) => item.environmentId)).toEqual(["env-new", "env-new"]);
  });

  it("trial goes on by the results when Railway won't show the token a change's progress", async () => {
    world.refuseWorkflowStatus = true;
    prepared(range(1, 19));
    const result = await redeploy(["trial", settingsName], { input: "yes\n", env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    for (const which of ["old", "new"]) {
      expect(result.out).toContain(`Railway won't show this token the progress of the ${which} database's TCP proxy, so the script waits for its result instead`);
      expect(result.out).toContain(`opened the ${which} database to the internet: ${which}.proxy.rlwy.net:`);
      expect(result.out).toContain(`Railway won't show this token the progress of closing the ${which} database's TCP proxy, so the script waits for its result instead`);
      expect(result.out).toContain(`closed the ${which} database's TCP proxy`);
    }
    expect(result.out).toContain("RESTORE OK");
    expect(world.operations.filter((operation) => operation === "WorkflowStatus")).toHaveLength(4);
    expect(world.patches.map((item) => item.environmentId)).toEqual(["env-old", "env-new", "env-old", "env-new"]);
    expect(world.projects.every((project) => Object.values(project.proxies).every((list) => !list.length))).toBe(true);
    expect((stateOf().values as { proxies?: string[] }).proxies).toEqual([]);
    expect(stateOf().done["20"]).toBeTruthy();
  });

  it("trial waits for prepare to finish", async () => {
    prepared(range(1, 15));
    const result = await redeploy(["trial", settingsName], { input: "yes\n", env: changeEnv() });
    expect(result.code).toBe(1);
    expect(result.out).toContain("Stopped: prepare hasn't finished: step 16 is next. Run prepare first");
    expect(world.operations.filter((operation) => operation.startsWith("mutation"))).toEqual([]);
  });

  // ---------------------------------------------------------------- cutover, check, back and recover

  it("cutover waits for trial, and check for the cutover", async () => {
    prepared(range(1, 17));
    const early = await redeploy(["cutover", settingsName], { input: "yes\n", env: changeEnv() });
    expect(early.code).toBe(1);
    expect(early.out).toContain("Stopped: trial hasn't finished: step 18 is next. Run it first; trial runs a day or so before the cutover");
    const check = await redeploy(["check", settingsName], { input: "yes\n", env: changeEnv() });
    expect(check.code).toBe(1);
    expect(check.out).toContain("Stopped: the cutover hasn't finished: step 22 is next. Run cutover");
    expect(mutations()).toEqual([]);
  });

  it("cutover stops production, copies the database, moves the address and connects, and runs again from a step that stopped", async () => {
    prepared(range(1, 20), { trial: { at: "2026-11-23T03:00:00.000Z", dumpSeconds: 40, restoreSeconds: 80, dumpBytes: 52_428_800, tables: 87, rows: 45_678 } });
    withControl();
    serviceOf(0, "admin").variables.FLEET_STATUS_TOKEN = "fleet-status-token-of-the-old-admin-0012";
    // One call is still in progress when the cutover starts, and ends a moment later.
    world.liveCalls = [1, 0];
    // bootstrap's up stops the first time, as when Railway hasn't let go of the address yet.
    world.upFails = 1;
    const stateBefore = readFileSync(join(dir, `${settingsName}.redeploy.json`), "utf8");

    const dry = await redeploy(["cutover", settingsName, "--dry-run"], { env: changeEnv() });
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("cutover: steps 22 to 33, at the hour picked. Production is offline from step 24 to step 33");
    expect(dry.out).toContain("the old cloudflared. Production is offline from then until step 33; the trial's dump and restore took 2 minutes (step 24)");
    expect(dry.out).toContain("A dry run: nothing was changed.");
    expect(mutations()).toEqual([]);
    expect(readFileSync(join(dir, `${settingsName}.redeploy.json`), "utf8")).toBe(stateBefore);

    const stopped = await redeploy(["cutover", settingsName], { input: "yes\n", env: changeEnv() });
    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain("Production goes offline at step 24, until step 33. Is it the hour you picked, with the customers who need notice told? Type yes to go on:");
    expect(stopped.out).toContain("old: PostgreSQL 16, new: PostgreSQL 18");
    expect(stopped.out).toContain("1 call in progress, from the old workers, through the old admin's fleet status address: waiting for it to end");
    expect(stopped.out).toContain("no call in progress, from the old workers");
    expect(stopped.out).toContain("Production is offline from now");
    expect(stopped.out).toContain("froze the old database: the app's roles can't connect any more, and 3 sessions ended. Its own settings: none");
    expect(stopped.out).toContain("RESTORE OK");
    expect(stopped.out).toContain("SAME: every table arrived, with every row");
    expect(stopped.out).toContain(`took ${host} off the old admin: it reaches neither project until up gives it to the new one`);
    expect(stopped.out).toContain("Stopped: step 30: bootstrap's up stopped (above).");
    expect(stateOf().done["29"]).toBeTruthy();
    expect(stateOf().done["30"]).toBeUndefined();
    // Steps 22 to 29: both databases opened, the new services and then the old ones stopped, the old database frozen,
    // dumped and restored into the new one, counted, and the new migrate deployed again on it.
    expect(world.patches.map((item) => [item.environmentId, item.skipDeploys])).toEqual([["env-old", true], ["env-new", true]]);
    expect(dockerSteps()).toEqual([
      "psql old lobbystack freeze.sql", "psql old lobbystack count.sql", "pg_dump old lobbystack app.dump.part",
      "dropdb new lobbystack", "createdb new lobbystack", "pg_restore new lobbystack", "vacuumdb new lobbystack",
      "psql new lobbystack count.sql",
    ]);
    expect(dockerCalls().find((call) => call.name === "pg_restore")?.rest).toEqual(expect.arrayContaining(["-O", "-1", "-e", "app.dump"]));
    expect(readFileSync(join(backupDir(), "app.dump"), "utf8")).toBe("PGDMP a dump");
    expect(readFileSync(join(backupDir(), "count-old.txt"), "utf8")).toBe("tables 87, rows 45678, fingerprint 0123abcd\n");
    expect(awsCalls().map((call) => [call.from, call.to])).toEqual([["s3://bkt-old-name", join(backupDir(), "app-files")], [join(backupDir(), "app-files"), "s3://bkt-new-name"]]);
    expect(mutations()).toEqual(["EnvironmentPatch", "EnvironmentPatch", "DeploymentRemove", "DeploymentRemove", "DeploymentRemove", "DeploymentRemove", "DeploymentRemove", "DeploymentRemove", "ServiceRedeploy", "DomainDelete"]);
    for (const name of ["admin", "worker", "cloudflared", "control"]) expect(serviceOf(0, name).status, name).toBe(name === "control" ? "SUCCESS" : "REMOVED");

    const resumed = await redeploy(["cutover", settingsName], { input: "yes\n", env: changeEnv() });
    expect(resumed.code, resumed.out).toBe(0);
    expect(resumed.out).toMatch(/Production has been offline since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(step 24\)\. Go on with the cutover\? Type yes to go on:/);
    expect(resumed.out).toContain(`= the old admin doesn't have ${host}`);
    // Step 30: redo once, up again, and the services up didn't deploy started on the image they ran.
    expect(linesOf("bootstrap-calls.txt")).toEqual([
      `redo ${copyName} railway.domain railway.custom turnstile variables post.*`, `up ${copyName}`, `up ${copyName}`,
      `redo ${copyName} connect.webhook connect.platformKey`, `connect ${copyName}`,
    ]);
    expect(readFileSync(join(dir, copyName), "utf8")).toContain(`APP_BASE_URL=https://${host}\n`);
    expect(world.deploys).toEqual(["service redeploy svc-new-migrate", "up svc-new-admin", "up svc-new-worker", "redeploy svc-new-control on its image", "redeploy svc-new-cloudflared on its image"]);
    expect(world.projects[1]?.domains["svc-new-admin"]?.custom.map((item) => item.domain)).toEqual(["app-new.example.com", host]);
    expect(world.cloudflare.find((record) => record.id === "rec-cname")?.content).toBe("svc-new-admin.up.railway.app");
    // Step 31, and step 33.
    expect(readdirSync(join(backupDir(), "after-cutover")).sort()).toEqual([copyName, `${copyName}.secrets`, `${copyName}.state.json`]);
    expect(resumed.out).toContain(`https://${host} answers "ok":true, from the new project, running d533e69`);
    expect(resumed.out).toMatch(/Production was offline for about \d+ seconds?/);
    expect(resumed.out).toContain("Next, right away: node devops/redeploy.mjs check, step 34.");
    const state = stateOf() as { done: Record<string, string>; values: { proxies?: string[]; cutover?: Record<string, unknown> } };
    expect(range(22, 33).every((step) => state.done[String(step)])).toBe(true);
    // The databases stay open until finish closes them (step 39).
    expect(state.values.proxies).toEqual(["old", "new"]);
    expect(state.values.cutover).toMatchObject({ release: "d533e698a1b2c3d4e5f60718293a4b5c6d7e8f90", mark: false, dump: { file: "app.dump", bytes: 12 } });
    for (const value of secretValues()) {
      expect(stopped.out).not.toContain(value);
      expect(resumed.out).not.toContain(value);
    }
  });

  it("cutover counts the calls in the old database, stops when the copy differs, and back puts production back on the old project", async () => {
    prepared(range(1, 20));
    writeTools({ newTables: 86, mark: true });
    writeFileSync(join(dir, "calls.txt"), "2\n0");
    const stopped = await redeploy(["cutover", settingsName], { input: "yes\n", env: changeEnv() });
    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain("2 calls in progress, from the old database: calls started in the last half hour that haven't ended: waiting for them to end");
    expect(stopped.out).toContain("Its own settings: lobbystack.reset_protection=on");
    expect(stopped.out).toContain("DIFFERENT. Lines only the old database has (<) or only the new one has (>):");
    expect(stopped.out).toContain("    < public.extra 3");
    expect(stopped.out).toContain("Stopped: step 27: the new database isn't the old one's copy. Run cutover again, which restores it again (step 26); if it differs again, go back: node devops/redeploy.mjs back");
    expect(stateOf().done["25"]).toBeTruthy();
    expect(stateOf().done["26"]).toBeUndefined();
    // The mark goes on the new database only once it's the old one's copy.
    expect(dockerSteps().filter((step) => step.includes("reset_protection"))).toEqual([]);

    const back = await redeploy(["back", settingsName], { input: "yes\n", env: changeEnv() });
    expect(back.code, back.out).toBe(0);
    expect(back.out).toContain("back: G1 to G3, going back before the address moved");
    expect(back.out).toContain(`${host} stayed on the old admin, so nothing outside Railway changes.`);
    expect(back.out).toContain("Production goes back to the old project, as it was before the cutover. Type yes to go on:");
    // G1 lets the app in again, G2 starts the old admin and worker from the deployments step 24 removed, and G3 empties
    // the new database and deploys its migrate again.
    expect(dockerSteps().slice(-3)).toEqual(["psql old postgres grant connect on database lobbystack to public", "dropdb new lobbystack", "createdb new lobbystack"]);
    expect(world.deploys).toEqual(["redeploy svc-old-admin on its image", "redeploy svc-old-worker on its image", "service redeploy svc-new-migrate"]);
    expect(back.out).toContain(`https://${host} answers "ok":true, from the old project`);
    expect(back.out).toContain("Production runs on the old project again.");
    // The proxies step 22 opened are closed, and the cutover's record cleared for another try.
    expect(world.projects.every((project) => Object.values(project.proxies).every((list) => !list.length))).toBe(true);
    const state = stateOf() as { done: Record<string, string>; values: Record<string, unknown> };
    expect(Object.keys(state.done).filter((step) => Number(step) >= 22 || step.startsWith("G"))).toEqual([]);
    expect(state.values.wentBack).toEqual([{ at: expect.any(String), path: "before" }]);
    expect(state.values.cutover).toBeUndefined();

    const status = await redeploy(["status", settingsName], { env: changeEnv() });
    expect(status.code, status.out).toBe(0);
    expect(status.out).toMatch(/trial\s+steps 18 to 20\s+done, /);
    expect(status.out).toMatch(/cutover\s+steps 22 to 33\s+not started/);
    expect(status.out).toMatch(/went back \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, before the address moved/);
  });

  it("check reads what it can, asks about the rest, and stops at a check that fails", async () => {
    prepared(range(1, 33));
    moveAddress();
    withControl();
    serviceOf(1, "cloudflared").status = "SUCCESS";
    writeState(copyName, world.projects[1] ?? null, { CONTROL_HOST: "control.example.com" });
    // Sign-in, files, a call, a text, the worker's log and the control panel: the call fails the first time.
    const failed = await redeploy(["check", settingsName], { input: "yes\nyes\nno\nyes\nyes\nyes\n", env: changeEnv() });
    expect(failed.code).toBe(1);
    expect(failed.out).not.toContain("Type yes to go on");
    expect(failed.out).toContain(`ok  https://${host}/api/health/ready answers "ok":true`);
    expect(failed.out).toContain("the new worker's log: 2 lines since it started, 1 error; the newest:");
    expect(failed.out).toContain("Twilio answered 503, trying again");
    expect(failed.out).toContain("ok  https://control.example.com answers (HTTP 302), through the new cloudflared");
    expect(failed.out).toContain("Call a business's number: did the receptionist answer?");
    expect(failed.out).toContain("Stopped: step 34: call didn't pass. Fix it if it's quick, then run check again; if not, go back within the first hour, before real traffic builds up on the new database: node devops/redeploy.mjs back");
    expect(linesOf("scale-calls.txt")).toEqual([`--bootstrap ${copyName}`]);
    expect(stateOf().done["34"]).toBeUndefined();
    const finish = await redeploy(["finish", settingsName], { input: "yes\n", env: changeEnv() });
    expect(finish.code).toBe(1);
    expect(finish.out).toContain("Stopped: the cutover's checks haven't passed yet: run check (step 34)");

    const passed = await redeploy(["check", settingsName], { input: "yes\n".repeat(6), env: changeEnv() });
    expect(passed.code, passed.out).toBe(0);
    expect(passed.out).toContain("Every check passed");
    expect(passed.out).toContain("Next, once you're happy with the new project: node devops/redeploy.mjs finish, steps 35 to 39.");
    expect(stateOf().done["34"]).toBeTruthy();
    expect(mutations()).toEqual([]);
  });

  it("back after the address moved gives it back to the old admin, sets the new database aside and starts the old services", async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    prepared(range(1, 33), {
      cutover: { release: "d533e698a1b2c3d4e5f60718293a4b5c6d7e8f90", offline: at, addressLeftOld: at, redo: at, connectRedo: at },
      removed: { old: { admin: { id: "dep-svc-old-admin", at }, worker: { id: "dep-svc-old-worker", at } } },
      servers: { old: "7300000000000000001", new: "7400000000000000002" },
      proxies: ["old", "new"],
    });
    moveAddress();
    proxiesOpen();
    for (const name of ["admin", "worker"]) serviceOf(0, name).status = "REMOVED";
    // Railway won't deploy the removed deployments again: the old services start from their source instead.
    world.refuseRedeploy = true;
    // The answers: the plan, then pointing the address's CNAME back at the old project.
    const result = await redeploy(["back", settingsName], { input: "yes\nyes\n", env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("back: G4 to G9, going back after the address moved");
    expect(result.out).toContain(`Production goes back to the old project, and ${host} with it; what customers wrote since the switch stays behind in the new project. Type yes to go on:`);
    // G4 and G5: the address off the new admin and on the old one, its records in Cloudflare pointed back.
    expect(world.domainsDeleted).toEqual([host]);
    expect(world.domainsMade).toEqual([{ serviceId: "svc-old-admin", domain: host }]);
    expect(result.out).toContain(`Railway asks for CNAME ${host} svc-old-admin.up.railway.app, where step 7 noted old1234.up.railway.app: Railway's is used`);
    expect(result.out).toContain(`${host} points to new5678.up.railway.app now. Point it to svc-old-admin.up.railway.app, the old project, again? Type yes to go on:`);
    expect(world.cloudflare.find((record) => record.id === "rec-cname")?.content).toBe("svc-old-admin.up.railway.app");
    expect(world.cloudflare.find((record) => record.id === "rec-txt")?.content).toBe("railway-verify=svc-old-admin");
    expect(world.cloudflareCalls.filter((call) => /^(POST|PATCH|DELETE) /.test(call))).toHaveLength(2);
    // G6 to G8: the old database open again, the old services started, the new database set aside under a name of its own.
    expect(dockerSteps()).toEqual([
      "psql old postgres grant connect on database lobbystack to public",
      "psql new postgres select datname from pg_database",
      "psql new postgres select count(pg_terminate_backend(pid, 5000)) from pg_stat_activity where datname = 'lobbystack' and pid <> pg_backend_pid(); alter database lobbystack rename to lobbystack_after_switch",
      "psql new postgres select datname from pg_database",
      "createdb new lobbystack",
    ]);
    expect(databasesOn().new).toEqual(["postgres", "lobbystack_after_switch", "lobbystack"]);
    expect(result.out).toContain("Railway wouldn't deploy the removed deployment again");
    expect(world.deploys).toEqual(["deploy svc-old-admin", "deploy svc-old-worker", "service redeploy svc-new-migrate"]);
    expect(mutations()).toEqual(["DomainDelete", "DeploymentRemove", "DeploymentRemove", "DomainCreate", "DeploymentRedeploy", "ServiceDeploy", "DeploymentRedeploy", "ServiceDeploy", "ServiceRedeploy", "EnvironmentPatch", "EnvironmentPatch"]);
    expect(result.out).toContain("Nothing changes at Twilio, OpenAI or Polar");
    const state = stateOf() as { done: Record<string, string>; values: Record<string, unknown> };
    expect(state.values.wentBack).toEqual([{ at: expect.any(String), path: "after", aside: "lobbystack_after_switch" }]);
    expect(Object.keys(state.done).filter((step) => Number(step) >= 22 || step.startsWith("G"))).toEqual([]);
    expect(world.projects.every((project) => Object.values(project.proxies).every((list) => !list.length))).toBe(true);
    for (const value of secretValues()) expect(result.out).not.toContain(value);
  });

  it("recover puts the copy's files back from the backup folder, and cutover runs the steps they missed again", async () => {
    const at = new Date().toISOString();
    prepared(range(1, 33), { cutover: { redo: at, connectRedo: at } });
    const saved = join(backupDir(), "after-cutover");
    mkdirSync(saved, { recursive: true });
    for (const end of ["", ".secrets", ".state.json"]) writeFileSync(join(saved, `${copyName}${end}`), readFileSync(join(dir, `${copyName}${end}`)));
    // The copy's state file is broken, and its secrets file is lost.
    writeFileSync(join(dir, `${copyName}.state.json`), "{ broken");
    rmSync(join(dir, `${copyName}.secrets`));

    const dry = await redeploy(["recover", settingsName, "--dry-run"], { env: changeEnv() });
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain(`the new project's copy: ${copyName}, which can't be read: ${copyName}.state.json isn't valid JSON`);
    expect(dry.out).toContain(`recover (R1) would:\n  - move ${copyName}, ${copyName}.state.json into ${join(backupDir(), "replaced-")}`);
    expect(dry.out).toContain(`  - copy the three -pg18 files back from ${saved}`);
    expect(dry.out).toContain("  - record steps 32 and 33 as not done, so cutover runs them again");
    expect(dry.out).toContain("A dry run: nothing was changed.");
    expect(readFileSync(join(dir, `${copyName}.state.json`), "utf8")).toBe("{ broken");

    const result = await redeploy(["recover", settingsName], { input: "yes\n", env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, `${copyName}.state.json`), "utf8")).values.RAILWAY_PROJECT_ID).toBe("prj-new");
    expect(readFileSync(join(dir, `${copyName}.secrets`), "utf8")).toContain(`RAILWAY_API_TOKEN=${railwayToken}`);
    const aside = readdirSync(backupDir()).filter((name) => name.startsWith("replaced-"));
    expect(aside).toHaveLength(1);
    expect(readdirSync(join(backupDir(), aside[0] ?? "")).sort()).toEqual([copyName, `${copyName}.state.json`]);
    const state = stateOf() as { done: Record<string, string>; values: { cutover?: Record<string, unknown> } };
    expect(state.done["31"]).toBeTruthy();
    expect(state.done["32"]).toBeUndefined();
    expect(state.done["33"]).toBeUndefined();
    expect(state.values.cutover).toEqual({ redo: at });
    // recover reads and writes files only.
    expect(world.operations).toEqual([]);
  });

  // ---------------------------------------------------------------- finish and retire

  it("finish sets the copies, disconnects the old services, turns on backups and removes what the move added", async () => {
    prepared(range(1, 20));
    moveAddress();
    // The cutover opened both databases (step 22), and up wrote the temporary address's records (step 13).
    for (const project of world.projects) project.proxies[`svc-${project.id.replace("prj-", "")}-postgres`] = [{ id: `tcp-${project.id}`, domain: `${project.id.replace("prj-", "")}.proxy.rlwy.net`, proxyPort: 21_000, applicationPort: 5432, syncStatus: "ACTIVE" }];
    world.cloudflare.push(
      { id: "rec-new-cname", type: "CNAME", name: "app-new.example.com", content: "svc-new-admin.up.railway.app", proxied: false },
      { id: "rec-new-txt", type: "TXT", name: "_railway-verify.app-new.example.com", content: "railway-verify=new", proxied: false },
    );
    const result = await redeploy(["finish", settingsName], { input: "yes\n", env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Have all of step 34's checks passed on the new project? Type yes to go on:");
    expect(result.out).toContain("disconnect the old migrate, admin and worker from the repository (step 36)");
    expect(result.out).toContain("scale.mjs set 2 admin and 2 worker copies");
    expect(linesOf("scale-calls.txt")).toEqual([`admin=2 worker=2 --max-connections 200 --bootstrap ${copyName} --dry-run`, `admin=2 worker=2 --max-connections 200 --bootstrap ${copyName}`]);
    expect(world.disconnected).toEqual(["svc-old-migrate", "svc-old-admin", "svc-old-worker"]);
    expect(world.projects[1]?.schedules["vol-new-postgres"]).toEqual(["DAILY", "WEEKLY"]);
    expect(world.projects[1]?.domains["svc-new-admin"]?.custom.map((item) => item.domain)).toEqual([host]);
    expect(world.cloudflare.map((record) => record.id).sort()).toEqual(["rec-cname", "rec-other", "rec-txt"]);
    expect(world.projects.every((project) => Object.values(project.proxies).every((list) => !list.length))).toBe(true);
    expect(result.out).toContain("Next, in a week, if nothing needed going back: node devops/redeploy.mjs retire, step 40.");
    // Nothing was disconnected or deleted in the new project but the temporary address.
    expect(world.domainsDeleted).toEqual(["app-new.example.com"]);
  });

  it("finish waits for the address to move", async () => {
    prepared(range(1, 20));
    const result = await redeploy(["finish", settingsName], { input: "yes\n", env: changeEnv() });
    expect(result.code).toBe(1);
    expect(result.out).toContain(`Stopped: the new admin doesn't have ${host} yet: finish comes after the cutover (steps 22 to 34)`);
    expect(mutations()).toEqual([]);
  });

  it("retire deletes the old project only when its name is typed, then moves the old files away", async () => {
    prepared(range(1, 39));
    moveAddress();
    const oldName = `${host} (old, PostgreSQL 16)`;
    const declined = await redeploy(["retire", settingsName], { input: "yes\n", env: changeEnv() });
    expect(declined.code).toBe(1);
    expect(declined.out).toContain(`Type "${oldName}" to go on:`);
    expect(declined.out).toContain("finish ran 4 days ago. The move keeps the old project a week, for going back");
    expect(mutations()).toEqual([]);

    const result = await redeploy(["retire", settingsName], { input: `${oldName}\n`, env: changeEnv() });
    expect(result.code, result.out).toBe(0);
    expect(mutations()).toEqual(["ProjectScheduleDelete"]);
    expect(world.projects[0]?.deletedAt).toBeTruthy();
    expect(world.projects[1]?.deletedAt).toBeFalsy();
    const moved = readdirSync(join(backupDir(), "old-project-files")).sort();
    expect(moved).toEqual([settingsName, `${settingsName}.redeploy.json`, `${settingsName}.redeploy.log`, `${settingsName}.secrets`, `${settingsName}.state.json`]);
    expect(existsSync(join(dir, settingsName))).toBe(false);
    expect(existsSync(join(dir, copyName))).toBe(true);
    expect(result.out).toContain("The move is over. From now on, bootstrap and the scale script run with the -pg18 files.");
  });
});
