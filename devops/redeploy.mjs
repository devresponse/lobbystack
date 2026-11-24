#!/usr/bin/env node
// redeploy.mjs: moves a deployment that devops/bootstrap.mjs made to a new Railway project on PostgreSQL 18, the way
// devops/redeploy.md describes, and carries its step numbers. The new project is built from a copy of the deployment's
// settings files, its data and its bucket's files are copied at a quiet hour, the address moves to it, and the old
// project stays a week for going back.
//
//   node devops/redeploy.mjs status <settings file or address>   where the move stands; changes nothing
//   node devops/redeploy.mjs schema                              whether Railway's API still has every call it makes
//
// The settings file is the deployment's own, such as .env.bootstrap-acme-prod, which bootstrap's up ran with. Given
// an address instead, such as app.example.com, the script finds the .env.bootstrap-<name> file in this folder whose
// APP_BASE_URL names it. The new project's copy of the files has the same name with -pg18 at the end.
//
// status reads both projects from Railway, and the address's DNS records from Cloudflare when the settings name a
// CLOUDFLARE_ZONE:
//   - each service: its copies, its latest deployment and release, and the database's PostgreSQL version from its
//     image, its volume, its Railway backups and their schedule, and any TCP proxy that opens it to the internet;
//   - the admin's addresses, and each bucket's files and size, so a copy of the files can be checked (steps 18, 28);
//   - the variables of migrate, the admin, the worker and the control panel, old against new: the names only one
//     project has, the names whose values differ, and the sealed ones Railway won't show (step 16). No value is printed;
//   - this computer's tools: Node.js, Docker with PostgreSQL 18's image, and the AWS CLI (steps 1 and 2).
// While the old admin still has the address, it keeps the address's DNS records and the admin's and the worker's
// copies in <settings file>.redeploy.json, for going back and for setting the copies again (step 7). It never reads
// the database's or Redis's variables, never signs in to a database, and changes nothing in Railway or Cloudflare.
//
// Options:
//   --backup <folder>   the backup folder, when it isn't lobbystack-backups/<the address's first part>-before-pg18
//                       beside this checkout
//   --save <file>       with schema: write the part of Railway's API the script uses into <file>, for its tests
//
// It needs a Railway account or workspace token (railway.com/account/tokens), which it reads as bootstrap.mjs does:
// RAILWAY_API_TOKEN from the environment, else from the settings file's .secrets file, else it asks. Cloudflare's
// token comes from CLOUDFLARE_API_TOKEN, the same way, and isn't asked for. Neither is saved or printed. Every run
// first checks each call the script makes against Railway's API schema, which Railway gives without a token.
// Node 18 or later, nothing to install.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// The REDEPLOY_*_URL variables exist for tests against stand-ins.
const URLS = {
  railway: process.env.REDEPLOY_RAILWAY_URL ?? "https://backboard.railway.com/graphql/v2",
  cloudflare: process.env.REDEPLOY_CLOUDFLARE_URL ?? "https://api.cloudflare.com/client/v4",
};
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The new project's copy of the settings files: the same names with this at the end (step 8).
const COPY_SUFFIX = "-pg18";
// A deployment's settings file, as bootstrap's init names it; its .secrets, .state.json and other files don't match.
const SETTINGS_NAME = /^\.env\.bootstrap-[a-z0-9][a-z0-9-]*$/;
// The PostgreSQL version the move goes to, and the image bootstrap makes the new database from.
const TARGET_MAJOR = 18;
// The services whose variables step 16 compares. The database's and Redis's come from the state file alone.
const COMPARED = ["migrate", "admin", "worker", "control"];
const SERVICE_ORDER = ["Postgres", "Redis", "migrate", "admin", "worker", "control", "cloudflared"];
// The admin's variables that name the address, which differ while the new project has the temporary one (step 30).
const ADDRESS_VARIABLES = new Set(["APP_BASE_URL", "SITE_URL", "AUTH_TRUSTED_ORIGINS"]);
// The admin's variables only bootstrap's connect sets, which runs on the new project after the switch (step 32).
const CONNECT_VARIABLES = new Set(["OPENAI_WEBHOOK_SECRET", "PLATFORM_API_KEYS", "POLAR_WEBHOOK_SECRET"]);
// Railway gives every service variables of its own, which differ between projects by nature; these few a person sets.
const RAILWAY_SETTABLE = new Set(["RAILWAY_DOCKERFILE_PATH", "RAILWAY_DEPLOYMENT_DRAINING_SECONDS", "RAILWAY_DEPLOYMENT_OVERLAP_SECONDS",
  "RAILWAY_HEALTHCHECK_TIMEOUT_SEC", "RAILWAY_RUN_UID", "RAILWAY_SHM_SIZE_BYTES"]);
// A name that holds a key: a difference there means a key was changed in Railway since the files were written.
const KEY_NAME = /(KEY|KEYS|TOKEN|SECRET|PASSWORD|_SID|_DSN|CREDENTIALS?)$/;
// Values never shown, as bootstrap.mjs hides them: a variable read under one of these names, and anything shaped like a key.
const HIDDEN_NAME = /(KEY|KEYS|TOKEN|SECRET|PASSWORD|_DSN|CREDENTIALS?|DATABASE_URL|REDIS_URL)$/;
const KEY_SHAPES = /\b(?:sk-[A-Za-z0-9_-]{16,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=_-]{16,}|re_[A-Za-z0-9_]{16,}|lsp_[A-Za-z0-9_]{16,}|polar_[a-z]{2,4}_[A-Za-z0-9_]{16,}|phx_[A-Za-z0-9_]{16,})/g;

// ---------------------------------------------------------------- Railway's API, every call the script makes

// Each document has one root field, so the schema check below can name the call that changed. Unrendered variables
// read back as written, so a reference such as ${{Postgres.RAILWAY_PRIVATE_DOMAIN}} compares equal in both projects.
const Q = {
  project: `query ProjectView($id: String!) {
  project(id: $id) {
    id name deletedAt workspaceId
    environments { edges { node { id name } } }
    services { edges { node { id name serviceInstances { edges { node { environmentId region numReplicas source { image repo } latestDeployment { id status createdAt meta } } } } } } }
    volumes { edges { node { id name volumeInstances { edges { node { id environmentId serviceId mountPath currentSizeMB state } } } } } }
    buckets { edges { node { id name } } }
  }
}`,
  projects: `query Projects($workspaceId: String) {
  projects(workspaceId: $workspaceId) { edges { node { id name deletedAt } } }
}`,
  variables: `query ServiceVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
}`,
  // Every variable's name in the environment, and whether it's sealed, which Railway says without the value.
  variableNames: `query VariableNames($id: String!) {
  environment(id: $id) { variables { edges { node { name isSealed serviceId } } } }
}`,
  domains: `query Domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
  domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
    customDomains { id domain status { verified dnsRecords { recordType fqdn requiredValue currentValue status } } }
    serviceDomains { id domain }
  }
}`,
  tcpProxies: `query TcpProxies($environmentId: String!, $serviceId: String!) {
  tcpProxies(environmentId: $environmentId, serviceId: $serviceId) { id domain proxyPort applicationPort syncStatus }
}`,
  backups: `query BackupList($volumeInstanceId: String!) {
  volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId) { id name createdAt expiresAt usedMB }
}`,
  schedules: `query BackupSchedules($volumeInstanceId: String!) {
  volumeInstanceBackupScheduleList(volumeInstanceId: $volumeInstanceId) { id kind cron retentionSeconds }
}`,
  bucket: `query BucketDetails($bucketId: String!, $environmentId: String!) {
  bucketInstanceDetails(bucketId: $bucketId, environmentId: $environmentId) { objectCount sizeBytes }
}`,
};

// What a run asks Railway's schema, without descriptions: every type with its fields, arguments and input fields.
const SCHEMA_QUERY = `query RailwaySchema {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name
      fields(includeDeprecated: true) { name args { name defaultValue type { ...TypeRef } } type { ...TypeRef } }
      inputFields { name defaultValue type { ...TypeRef } }
      enumValues(includeDeprecated: true) { name }
    }
  }
}
fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;

// The fields of each input object the script builds itself and passes as a variable, which its documents don't name.
const INPUT_FIELDS = {};

class Stop extends Error {}

const hidden = new Set();
const consoleOriginal = { log: console.log.bind(console), error: console.error.bind(console) };
for (const level of ["log", "error"]) console[level] = (...args) => consoleOriginal[level](redact(args.join(" ")));

let prompter = null;
let options;

async function main() {
  if (typeof fetch !== "function") throw new Error("this script needs Node 18 or later");
  if (options.command === "schema") return schemaCommand();
  const run = loadRun(options.target);
  return status(run);
}

// ---------------------------------------------------------------- the files

/** KEY=value lines, as bootstrap.mjs reads its settings: comments and empty lines skipped, quotes taken off, the last one wins. */
function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Stop(`couldn't read ${file} (${error.code ?? error.message})`);
  }
  const settings = {};
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    const equals = line.indexOf("=");
    if (!line || line.startsWith("#") || line.startsWith("[") || equals < 1) continue;
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    settings[line.slice(0, equals).trim()] = value;
  }
  return settings;
}

/** An address's host name, as bootstrap.mjs takes APP_BASE_URL and CUSTOM_HOST: no scheme, no path, lower case. */
function hostOf(address) {
  return String(address ?? "").trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "").toLowerCase();
}

const settingsHost = (settings) => hostOf(settings.APP_BASE_URL) || hostOf(settings.CUSTOM_HOST);

/** The deployment's settings file: the one given, the original of a -pg18 copy, or the one whose address is given. */
function findSettingsFile(target) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    if (!target.endsWith(COPY_SUFFIX)) return { file: target, how: "given" };
    const original = target.slice(0, -COPY_SUFFIX.length);
    if (!fs.existsSync(original)) throw new Stop(`${target} is the new project's copy, and its original ${original} isn't here. Give the original settings file, which names the old project`);
    return { file: original, how: `the original of ${target}` };
  }
  const host = hostOf(target);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Stop(`${target} is neither a settings file nor an address such as app.example.com`);
  const folder = process.cwd();
  const candidates = fs.readdirSync(folder).filter((name) => SETTINGS_NAME.test(name) && !name.endsWith(COPY_SUFFIX));
  const found = candidates.filter((name) => settingsHost(readSettings(path.join(folder, name))) === host).sort();
  if (found.length > 1) throw new Stop(`${found.length} settings files here name ${host}: ${found.join(", ")}. Give the one bootstrap's up ran with for this deployment`);
  if (!found.length) throw new Stop(`no .env.bootstrap-<name> file in ${folder} has APP_BASE_URL=https://${host}. Run this in the checkout that has the deployment's settings file, or give the file`);
  return { file: found[0], how: "found by its address" };
}

/** The values bootstrap.mjs keeps in <settings file>.state.json, or null when it has none. */
function readBootstrapValues(file) {
  const stateFile = `${file}.state.json`;
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"))?.values ?? {};
  } catch (error) {
    throw new Stop(`${stateFile} isn't valid JSON (${error.message})`);
  }
}

function loadRun(target) {
  const { file, how } = findSettingsFile(target);
  const settings = readSettings(file);
  const old = readBootstrapValues(file);
  if (!old?.RAILWAY_PROJECT_ID || !old.RAILWAY_ENVIRONMENT_ID) throw new Stop(`${file}.state.json names no Railway project and environment: give the settings file bootstrap's up made the deployment with`);
  const host = settingsHost(settings);
  const label = host ? host.split(".")[0] : settings.NAME || path.basename(file).replace(/^\.env\.bootstrap-/, "");
  const copyFile = `${file}${COPY_SUFFIX}`;
  const copy = fs.existsSync(copyFile) ? { file: copyFile, settings: readSettings(copyFile), values: readBootstrapValues(copyFile) ?? {} } : null;
  const stateFile = `${file}.redeploy.json`;
  const state = readState(stateFile);
  const backup = path.resolve(options.backup || state.backup || path.join(REPO_ROOT, "..", "lobbystack-backups", `${label}-before-pg18`));
  return { file, how, settings, host, label, old, copy, stateFile, state, backup };
}

/** This script's own progress: <settings file>.redeploy.json. Its text is kept, so a save can tell another run wrote it since. */
function readState(stateFile) {
  const text = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
  let state = {};
  try {
    if (text !== null) state = JSON.parse(text);
  } catch (error) {
    throw new Stop(`${stateFile} isn't valid JSON (${error.message}). Put back a copy that is, or delete it: it holds only this script's notes`);
  }
  state.done ??= {};
  state.values ??= {};
  Object.defineProperty(state, "text", { value: text, enumerable: false, writable: true });
  return state;
}

/** Writes the state file whole, unless another run changed it since this one read it. Returns whether it saved. */
function save(run) {
  const onDisk = fs.existsSync(run.stateFile) ? fs.readFileSync(run.stateFile, "utf8") : null;
  if (onDisk !== run.state.text) return false;
  const text = `${JSON.stringify({ ...run.state, version: 1, settings: path.basename(run.file) }, null, 2)}\n`;
  const temp = `${run.stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  try {
    fs.renameSync(temp, run.stateFile);
  } catch {
    // Windows refuses the rename while another program has the file open: write it in place instead.
    fs.writeFileSync(run.stateFile, text, { mode: 0o600 });
    fs.rmSync(temp, { force: true });
  }
  run.state.text = text;
  return true;
}

/** Takes the state file's lock, as bootstrap.mjs does, and returns its release; null while another run holds it. */
function tryLock(run) {
  const lock = `${run.stateFile}.lock`;
  const mine = JSON.stringify({ pid: process.pid, command: options.command, started: new Date().toISOString() });
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      fs.writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(lock, "utf8") === mine) fs.rmSync(lock);
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (lockHolder(run)) return null;
      // Left by a run that's gone: taken over.
      fs.rmSync(lock, { force: true });
    }
  }
  return null;
}

/** The run that holds the state file's lock, or null when there's no lock or the run that left it is gone. */
function lockHolder(run) {
  let other;
  try {
    other = JSON.parse(fs.readFileSync(`${run.stateFile}.lock`, "utf8"));
  } catch {
    return null;
  }
  if (!other?.pid || other.pid === process.pid) return null;
  try {
    process.kill(other.pid, 0);
    return other;
  } catch (error) {
    return error.code === "EPERM" ? other : null;
  }
}

/** A value from the environment, else from the settings files' .secrets files, as bootstrap.mjs reads it. */
function secretOf(run, key) {
  const fromEnvironment = process.env[key]?.trim();
  if (fromEnvironment) return hide(fromEnvironment);
  for (const file of [`${run.file}.secrets`, run.copy && `${run.copy.file}.secrets`].filter(Boolean)) {
    const found = secretFromFile(file, key);
    if (found) return hide(found);
  }
  return "";
}

/** One KEY=value line's value from a secrets file; empty, ?, <placeholders> and ${{references}} don't count. */
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

function hide(value) {
  if (typeof value === "string" && value.length >= 8) hidden.add(value);
  return value;
}

function redact(text) {
  let out = String(text);
  for (const value of hidden) if (out.includes(value)) out = out.split(value).join("‹hidden›");
  return out.replace(KEY_SHAPES, "‹hidden›");
}

// ---------------------------------------------------------------- status

async function status(run) {
  printFiles(run);
  console.log("");
  await checkSchema({ stopOnProblem: false });
  console.log("\nThis computer");
  printTools();

  const token = secretOf(run, "RAILWAY_API_TOKEN") || hide(await ask("Railway account or workspace token (typing is hidden): ", { hidden: true }));
  if (!token) throw new Stop("no Railway token given");
  railwayAuth = { Authorization: `Bearer ${token}` };

  const old = await readProject(run.old, "old");
  await printProject("The old project", old, run);
  const newId = run.copy?.values?.RAILWAY_PROJECT_ID;
  let fresh = null;
  if (!run.copy) console.log(`\nThe new project: none yet. Its settings files are made from these (step 8), then it's built (steps 11 to 13).`);
  else if (!newId) console.log(`\nThe new project: none yet. ${run.copy.file} names no project, so up builds one (step 13).`);
  else if (newId === run.old.RAILWAY_PROJECT_ID) console.log(`\nThe new project: none yet. ${run.copy.file} still names the old project: step 11 makes it forget it (redo railway.project, once), then up builds the new one (step 13).`);
  else {
    fresh = await readProject(run.copy.values, "new");
    await printProject("The new project", fresh, run);
  }
  await printNames(run, old, fresh);
  if (fresh) {
    printBuckets(old, fresh);
    await printVariables(run, old, fresh);
  }
  await notes(run, old, fresh);
  console.log(`\nThe steps, and what's still done by hand: devops/redeploy.md.`);
}

function printFiles(run) {
  console.log(`${run.host || run.label}: the move to a new Railway project on PostgreSQL ${TARGET_MAJOR} (devops/redeploy.md)`);
  console.log(`  settings file: ${run.file} (${run.how})`);
  const copyLine = !run.copy ? "not made yet (step 8)"
    : `${run.copy.file}${settingsHost(run.copy.settings) && settingsHost(run.copy.settings) !== run.host ? `, at the address ${settingsHost(run.copy.settings)}` : ""}`;
  console.log(`  the new project's copy: ${copyLine}`);
  console.log(`  backup folder: ${run.backup}${fs.existsSync(run.backup) ? "" : " (not made yet: step 4)"}`);
  const holder = lockHolder(run);
  if (holder) console.log(`  another run (${holder.command ?? "a command"}, process ${holder.pid}, since ${holder.started ?? "?"}) is using ${run.stateFile}`);
  else if (fs.existsSync(`${run.stateFile}.lock`)) console.log(`  a lock left by a run that's gone: ${run.stateFile}.lock, which the next run takes over (R2)`);
  const noted = run.state.values.noted;
  console.log(`  notes: ${noted ? `${run.stateFile}, since ${shortTime(noted.at)}` : `${run.stateFile} (none kept yet)`}`);
}

// ---------------------------------------------------------------- this computer

function printTools() {
  const ok = (text) => console.log(`  ok     ${text}`);
  const note = (text) => console.log(`  note   ${text}`);
  const fix = (text) => console.log(`  FIX    ${text}`);
  const major = Number(process.versions.node.split(".")[0]);
  (major >= 18 ? ok : fix)(`Node.js ${process.version}${major >= 18 ? "" : ": needs 18 or later"}`);
  const docker = runTool("docker", ["--version"]);
  if (docker.status !== 0) {
    fix(missingTool(docker) ? `no Docker: PostgreSQL ${TARGET_MAJOR}'s tools run in it, for the database copy (Docker Desktop on Windows and Mac)` : `docker --version failed: ${firstLine(docker)}`);
  } else {
    const version = docker.stdout.match(/version\s+([\w.+-]+)/i)?.[1] ?? docker.stdout.trim();
    const running = runTool("docker", ["info", "--format", "{{.ServerVersion}}"]).status === 0;
    const pulled = running && runTool("docker", ["image", "inspect", `postgres:${TARGET_MAJOR}`, "--format", "{{.Id}}"]).status === 0;
    if (!running) note(`Docker ${version} is installed but isn't running: start Docker Desktop before the copy`);
    else if (pulled) ok(`Docker ${version}, with the postgres:${TARGET_MAJOR} image`);
    else note(`Docker ${version}, without the postgres:${TARGET_MAJOR} image yet: docker pull postgres:${TARGET_MAJOR} gets it (step 2)`);
  }
  const aws = runTool("aws", ["--version"]);
  if (aws.status === 0) ok(`AWS CLI ${aws.stdout.match(/aws-cli\/([\w.]+)/)?.[1] ?? firstLine(aws)}`);
  else fix(missingTool(aws) ? "no AWS CLI: the bucket's files are copied with it (guide 7.7)" : `aws --version failed: ${firstLine(aws)}`);
}

/**
 * Runs a command-line tool and returns spawnSync's result. On Windows, a tool installed as a .cmd file only starts
 * through the shell, so the line goes to the shell whole, each argument quoted (as in devops/bootstrap.mjs).
 */
function runTool(command, args, settings = {}) {
  if (process.platform !== "win32") return spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...settings });
  const line = [command, ...args].map((arg) => (/^[\w@+=:,./\\-]+$/.test(String(arg)) ? String(arg) : `"${String(arg).replace(/"/g, '""')}"`)).join(" ");
  return spawnSync(line, { encoding: "utf8", windowsHide: true, ...settings, shell: true });
}

/** Whether a runTool result means the tool isn't installed. On Windows the shell always starts, and says so instead. */
function missingTool(result) {
  if (result.error) return true;
  return process.platform === "win32" && result.status !== 0 && /is not recognized as an internal or external command|cannot find the path specified/i.test(`${result.stderr ?? ""}${result.stdout ?? ""}`);
}

function firstLine(result) {
  return `${result.stderr || result.stdout || result.error?.message || ""}`.trim().split(/\r?\n/)[0] || `exit code ${result.status}`;
}

// ---------------------------------------------------------------- reading a project

/** A project as bootstrap's state file names it: its environment, its services there, volumes and buckets. */
async function readProject(values, which) {
  let project;
  try {
    ({ project } = await gql(Q.project, { id: values.RAILWAY_PROJECT_ID }));
  } catch (error) {
    if (!(error instanceof Stop) && /not found/i.test(error.message)) project = null;
    else throw error;
  }
  if (!project) throw new Stop(`Railway has no ${which} project ${values.RAILWAY_PROJECT_ID}, which its state file names: was it deleted?`);
  const environment = project.environments.edges.map((edge) => edge.node).find((item) => item.id === values.RAILWAY_ENVIRONMENT_ID);
  if (!environment) throw new Stop(`the ${which} project ${project.name} has no environment ${values.RAILWAY_ENVIRONMENT_ID}, which its state file names`);
  const ids = values.RAILWAY_SERVICE_IDS ?? {};
  const volumes = project.volumes.edges.flatMap((edge) => edge.node.volumeInstances.edges.map((item) => item.node)).filter((item) => item.environmentId === environment.id);
  const services = project.services.edges.map(({ node }) => {
    const instance = node.serviceInstances.edges.map((edge) => edge.node).find((item) => item.environmentId === environment.id) ?? null;
    // The name bootstrap knows the service by, from its ID, so a service renamed in Railway is still found.
    const known = Object.entries(ids).find(([, id]) => id === node.id)?.[0];
    return { id: node.id, name: node.name, role: known ?? node.name, instance, volume: volumes.find((item) => item.serviceId === node.id) ?? null };
  });
  const order = (service) => (SERVICE_ORDER.includes(service.role) ? SERVICE_ORDER.indexOf(service.role) : SERVICE_ORDER.length);
  services.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  return {
    which, values, project, environment, services,
    service: (role) => services.find((item) => item.role === role) ?? null,
    buckets: project.buckets.edges.map((edge) => edge.node),
    details: {},
  };
}

async function printProject(title, where, run) {
  const { project, environment } = where;
  console.log(`\n${title}: "${project.name}" (${project.id}, environment ${environment.name})${project.deletedAt ? `, being deleted: Railway removes it after ${String(project.deletedAt).slice(0, 10)}` : ""}`);
  await printServices(where, run);
}

async function printServices(where, run) {
  for (const service of where.services) {
    const parts = [describeDeployment(service)];
    const copies = copiesOf(service.instance);
    if (copies !== null && (copies > 1 || ["admin", "worker"].includes(service.role))) parts.unshift(count(copies, "copy", "copies"));
    const image = service.instance?.source?.image;
    if (service.role === "Postgres") {
      const major = pgMajor(image);
      const wrong = where.which === "new" && major !== TARGET_MAJOR ? `, but the move needs ${TARGET_MAJOR}: was the new project built with the script from fork PR #223 or later?` : "";
      parts.push(major ? `PostgreSQL ${major} (${image})${wrong}` : `image ${image ?? "unknown"}, whose tag doesn't name its PostgreSQL version`);
    } else if (image) parts.push(`image ${image}`);
    const meta = metaOf(service.instance?.latestDeployment);
    const commit = typeof meta?.commitHash === "string" && /^[0-9a-f]{7,40}$/i.test(meta.commitHash) ? meta.commitHash.slice(0, 7) : null;
    if (commit) parts.push(`release ${commit}${meta.branch ? ` (${meta.branch})` : ""}`);
    if (service.volume) parts.push(`volume ${megabytes(service.volume.currentSizeMB)}`);
    console.log(`  ${service.name.padEnd(12)} ${parts.join(", ")}`);
    if (service.role === "Postgres") await printDatabase(where, service);
    if (service.role === "admin") await printAddresses(where, service, run);
  }
  for (const bucket of where.buckets) {
    const details = await attempt(() => gql(Q.bucket, { bucketId: bucket.id, environmentId: where.environment.id }));
    where.details[bucket.id] = details?.bucketInstanceDetails ?? null;
    console.log(`  ${bucket.name.padEnd(12)} bucket, ${details?.bucketInstanceDetails ? `${count(Number(details.bucketInstanceDetails.objectCount), "file")}, ${bytes(details.bucketInstanceDetails.sizeBytes)}` : `its contents unknown (${details?.error ?? "Railway gave nothing"})`}`);
  }
}

// The lines under a service start where its first line's words do.
const UNDER = "".padEnd(15);

async function printDatabase(where, service) {
  const pad = UNDER;
  if (service.volume) {
    const backups = await attempt(() => gql(Q.backups, { volumeInstanceId: service.volume.id }));
    const schedules = await attempt(() => gql(Q.schedules, { volumeInstanceId: service.volume.id }));
    const list = backups?.volumeInstanceBackupList ?? null;
    const kinds = (schedules?.volumeInstanceBackupScheduleList ?? []).map((item) => String(item.kind).toLowerCase());
    let line = list === null ? `Railway backups: unknown (${backups?.error})` : `Railway backups: ${list.length ? count(list.length, "backup") : "none"}`;
    if (list?.length) {
      const newest = [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      // A locked backup has no end date: the schedule never deletes it (volumeInstanceBackupLock).
      const locked = list.filter((item) => !item.expiresAt);
      line += `, the newest ${shortTime(newest.createdAt)}${newest.name ? ` ("${newest.name}")` : ""}, ${locked.length ? `${locked.length} locked` : "none locked"}`;
    }
    line += `; ${schedules?.error ? `schedule unknown (${schedules.error})` : kinds.length ? `schedule ${kinds.join(", ")}` : "no schedule"}`;
    console.log(`${pad}${line}`);
  }
  const proxies = await attempt(() => gql(Q.tcpProxies, { environmentId: where.environment.id, serviceId: service.id }));
  const open = (proxies?.tcpProxies ?? []).filter((item) => !item.deletedAt);
  if (proxies?.error) console.log(`${pad}TCP proxy: unknown (${proxies.error})`);
  else if (!open.length) console.log(`${pad}TCP proxy: none, so the database takes no connection from the internet`);
  else for (const proxy of open) console.log(`${pad}TCP proxy: ${proxy.domain}:${proxy.proxyPort} to port ${proxy.applicationPort}${proxy.syncStatus && proxy.syncStatus !== "ACTIVE" ? ` (${String(proxy.syncStatus).toLowerCase()})` : ""}: open to the internet to anyone with the password until it's deleted (steps 20 and 39)`);
}

async function printAddresses(where, service, run) {
  const found = await attempt(() => gql(Q.domains, { projectId: where.project.id, environmentId: where.environment.id, serviceId: service.id }));
  service.domains = found?.domains ?? null;
  const pad = UNDER;
  if (!service.domains) return console.log(`${pad}addresses: unknown (${found?.error})`);
  const custom = service.domains.customDomains.map((item) => `${item.domain}${item.domain === run.host ? " (the address)" : ""}${item.status?.verified === false ? ", not verified yet" : ""}`);
  const railway = service.domains.serviceDomains.map((item) => item.domain);
  console.log(`${pad}addresses: ${[...custom, ...railway].join(", ") || "none"}`);
}

function describeDeployment(service) {
  const deployment = service.instance?.latestDeployment;
  if (!service.instance) return "not in this environment";
  if (!deployment) return "never deployed";
  const status = String(deployment.status);
  if (status === "SUCCESS") return service.role === "migrate" ? "succeeded" : "active";
  if (status === "REMOVED" || status === "REMOVING") return "stopped (its deployment was removed)";
  if (["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING"].includes(status)) return `deploying (${status.toLowerCase()})`;
  return status.toLowerCase().replace(/_/g, " ");
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

/** The copies a service runs, as devops/scale.mjs reads them: its latest deployment's regions, else its own setting. */
function copiesOf(instance) {
  if (!instance) return null;
  const deploy = metaOf(instance.latestDeployment)?.serviceManifest?.deploy;
  if (deploy && typeof deploy === "object") {
    const multi = deploy.multiRegionConfig;
    if (multi && typeof multi === "object") {
      const counts = Object.values(multi).filter((value) => value && value.numReplicas !== 0).map((value) => Number(value.numReplicas ?? 1));
      if (counts.length) return counts.reduce((sum, item) => sum + item, 0);
    }
    if (deploy.numReplicas) return Number(deploy.numReplicas);
  }
  return instance.numReplicas ? Number(instance.numReplicas) : instance.latestDeployment ? 1 : null;
}

/** The PostgreSQL version an image's tag names, such as pg16, 16, 16.4-alpine or pg18-trixie, else null. */
function pgMajor(image) {
  const tag = String(image ?? "").split("/").pop().split("@")[0].split(":")[1] ?? "";
  const match = tag.match(/^(?:pg)?(\d{2})(?:\D|$)/i);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------- old against new

/** The project's name, and whether another project in the workspace has the same one (steps 10 and 13). */
async function printNames(run, old, fresh) {
  const name = run.old.RAILWAY_PROJECT_NAME ?? (run.host || run.settings.NAME);
  if (!name) return;
  const listed = await attempt(() => gql(Q.projects, { workspaceId: run.settings.RAILWAY_WORKSPACE_ID || old.project.workspaceId || null }));
  if (listed?.error) return console.log(`\nProjects named "${name}": unknown (${listed.error})`);
  const named = listed.projects.edges.map((edge) => edge.node).filter((item) => item.name === name && !item.deletedAt);
  const which = (item) => (item.id === old.project.id ? "the old project" : fresh && item.id === fresh.project.id ? "the new project" : `another project, ${item.id}`);
  console.log("");
  if (!named.length) console.log(`No project is named "${name}" now: up builds the new project under that name (step 13).`);
  else if (named.length > 1) console.log(`${named.length} projects are named "${name}": ${named.map(which).join(", ")}. bootstrap.mjs finds the project by that name, so rename all but one (step 10).`);
  else if (named[0].id === old.project.id) console.log(`The old project still has the name "${name}", which up gives the new one: step 10 renames the old one first.`);
  else console.log(`"${name}" is ${which(named[0])}'s name${named[0].id === fresh?.project.id ? ", as it should be" : ""}.`);
}

function printBuckets(old, fresh) {
  const [a] = old.buckets;
  const [b] = fresh.buckets;
  if (!a || !b) return;
  const before = old.details[a.id];
  const after = fresh.details[b.id];
  if (!before || !after) return;
  const files = [Number(before.objectCount), Number(after.objectCount)];
  const sizes = [Number(before.sizeBytes), Number(after.sizeBytes)];
  console.log("");
  if (files[0] === files[1] && sizes[0] === sizes[1]) console.log(`Buckets: the new one has as many files as the old one, ${count(files[0], "file")}, and the same size, ${bytes(sizes[0])}.`);
  else console.log(`Buckets: the new one has ${count(files[1], "file")} (${bytes(sizes[1])}), the old one ${count(files[0], "file")} (${bytes(sizes[0])}). Copy the old one's files across again before the switch (steps 18 and 28).`);
}

/** Step 16: each compared service's variables, old against new, by name. Values are compared, and never printed. */
async function printVariables(run, old, fresh) {
  console.log("\nVariables, old against new (names only; no value is shown)");
  const sealedOld = await sealedNames(old);
  const sealedNew = await sealedNames(fresh);
  let oldAdmin = null;
  for (const role of COMPARED) {
    const a = old.service(role);
    const b = fresh.service(role);
    if (!a && !b) continue;
    if (!a || !b) {
      console.log(`  ${role}: only in the ${a ? "old" : "new"} project`);
      continue;
    }
    const left = await variablesOf(old, a);
    const right = await variablesOf(fresh, b);
    if (left.error || right.error) {
      console.log(`  ${role}: couldn't read its variables (${left.error ?? right.error})`);
      continue;
    }
    if (role === "admin") oldAdmin = left.values;
    const sealed = new Set([...(sealedOld.get(a.id) ?? []), ...(sealedNew.get(b.id) ?? [])]);
    const compared = (values) => Object.keys(values).filter((name) => !sealed.has(name) && (!name.startsWith("RAILWAY_") || RAILWAY_SETTABLE.has(name)));
    const oldNames = compared(left.values);
    const newNames = new Set(compared(right.values));
    const onlyOld = oldNames.filter((name) => !newNames.has(name)).sort();
    const onlyNew = [...newNames].filter((name) => !(name in left.values)).sort();
    const differ = oldNames.filter((name) => newNames.has(name) && String(left.values[name]) !== String(right.values[name])).sort();
    const lines = [];
    const connect = onlyOld.filter((name) => role === "admin" && CONNECT_VARIABLES.has(name));
    const byHand = onlyOld.filter((name) => !connect.includes(name));
    if (connect.length) lines.push(`only in the old project, set by connect: ${connect.join(", ")}. connect runs after the switch (step 32): copy them to the new admin now, so it answers calls and Polar from the first minute (step 16)`);
    if (byHand.length) lines.push(`only in the old project, so added in Railway by hand: ${byHand.join(", ")}. Copy them to the new ${role} (step 16)`);
    const address = differ.filter((name) => ADDRESS_VARIABLES.has(name));
    const keys = differ.filter((name) => !ADDRESS_VARIABLES.has(name) && KEY_NAME.test(name));
    const other = differ.filter((name) => !address.includes(name) && !keys.includes(name));
    if (address.length) lines.push(`different: ${address.join(", ")}, the address, which the cutover sets back (step 30)`);
    if (keys.length) lines.push(`different: ${keys.join(", ")}, ${keys.length === 1 ? "a key" : "keys"} changed in Railway since the files were written. Bring the copy's files up to date first, since every variables run puts the files' value back: the key in ${run.copy.file}.secrets, then redo its step and up (step 16)`);
    if (other.length) lines.push(`different: ${other.join(", ")}. The new ${other.length === 1 ? "value is" : "values are"} the script's own; keep ${other.length === 1 ? "it" : "them"}, unless production's was set by hand on purpose (step 16)`);
    if (onlyNew.length) lines.push(`only in the new project: ${onlyNew.join(", ")}`);
    const sealedHere = [...sealed].sort();
    if (sealedHere.length) lines.push(`sealed, so Railway shows no value to compare: ${sealedHere.join(", ")}. Check ${sealedHere.length === 1 ? "it" : "them"} by hand`);
    console.log(`  ${role}:${lines.length ? "" : " the same in both"}`);
    for (const line of lines) console.log(`    ${line}`);
  }
  const secret = run.copy && secretFromFile(`${run.copy.file}.secrets`, "OPENAI_WEBHOOK_SECRET");
  if (secret) {
    hide(secret);
    const same = oldAdmin && oldAdmin.OPENAI_WEBHOOK_SECRET === secret;
    console.log(`  OPENAI_WEBHOOK_SECRET in ${run.copy.file}.secrets, which connect puts on the admin: ${!oldAdmin ? "not compared, since the old admin's variables couldn't be read" : same ? "the same as the old admin's" : "differs from the old admin's. Put the old admin's there before connect runs (step 16)"}`);
  }
}

/** A service's variables, unrendered, with their values hidden from every line the script prints. */
async function variablesOf(where, service) {
  const read = await attempt(() => gql(Q.variables, { projectId: where.project.id, environmentId: where.environment.id, serviceId: service.id }));
  if (read?.error) return { error: read.error };
  const values = read?.variables && typeof read.variables === "object" ? read.variables : {};
  for (const [name, value] of Object.entries(values)) if (HIDDEN_NAME.test(name)) hide(String(value));
  return { values };
}

/** The sealed variables' names by service, from the environment's list, which gives names without values. */
async function sealedNames(where) {
  const read = await attempt(() => gql(Q.variableNames, { id: where.environment.id }));
  const byService = new Map();
  for (const { node } of read?.environment?.variables?.edges ?? []) {
    if (!node?.isSealed || !node.serviceId) continue;
    if (!byService.has(node.serviceId)) byService.set(node.serviceId, []);
    byService.get(node.serviceId).push(node.name);
  }
  return byService;
}

// ---------------------------------------------------------------- notes for going back (step 7)

/**
 * The address's DNS records and the admin's and the worker's copies, as they are before the switch: printed, and
 * kept in the state file while the old admin still has the address, so going back can put them back (step 7, G5)
 * and step 35 can set the copies again.
 */
async function notes(run, old, fresh) {
  const host = run.host;
  const admin = old.service("admin");
  const worker = old.service("worker");
  const copies = { admin: copiesOf(admin?.instance), worker: copiesOf(worker?.instance) };
  const records = host ? await dnsRecords(run, host, admin) : { list: [], from: "" };
  console.log(`\nFor going back and for the copies (step 7)${records.from ? `, from ${records.from}` : ""}:`);
  for (const record of records.list) console.log(`  ${record.type.padEnd(5)} ${record.name}  ${record.content}`);
  if (records.problem) console.log(`  ${records.problem}`);
  console.log(`  copies: ${copies.admin ?? "?"} of the admin, ${copies.worker ?? "?"} of the worker`);

  const onOld = Boolean(host) && Boolean(admin?.domains?.customDomains?.some((item) => item.domain === host));
  const onNew = Boolean(fresh?.service("admin")?.domains?.customDomains?.some((item) => item.domain === host));
  const kept = run.state.values.noted;
  if (!onOld || onNew) {
    console.log(`  ${kept ? `Kept from before the switch, ${shortTime(kept.at)}, in ${run.stateFile}, and not changed now` : "Not kept"}: ${!host ? "the settings name no address" : onNew ? `the new admin has ${host}` : `the old admin doesn't have ${host}`}.`);
    return;
  }
  const noted = { project: old.project.id, host, records: records.list, copies };
  if (kept && JSON.stringify({ ...kept, at: undefined }) === JSON.stringify({ ...noted, at: undefined })) {
    console.log(`  Kept in ${run.stateFile} since ${shortTime(kept.at)}.`);
    return;
  }
  const release = tryLock(run);
  if (!release) {
    console.log(`  Not kept: another run is using ${run.stateFile}.`);
    return;
  }
  try {
    run.state.values.noted = { at: new Date().toISOString(), ...noted };
    console.log(save(run) ? `  Kept in ${run.stateFile}.` : `  Not kept: another run changed ${run.stateFile} after this one read it.`);
  } finally {
    release();
  }
}

/** The address's CNAME and Railway's check record: from Cloudflare when the settings name its zone, else what Railway asks for. */
async function dnsRecords(run, host, admin) {
  const zone = String(run.settings.CLOUDFLARE_ZONE ?? "").toLowerCase();
  const check = `_railway-verify.${host}`;
  const fromRailway = () => {
    const domain = admin?.domains?.customDomains?.find((item) => item.domain === host);
    return (domain?.status?.dnsRecords ?? []).filter((record) => record.fqdn && record.requiredValue)
      .map((record) => ({ type: String(record.recordType).replace("DNS_RECORD_TYPE_", ""), name: String(record.fqdn).replace(/\.$/, ""), content: record.requiredValue }));
  };
  if (!zone) {
    const list = fromRailway();
    return { list, from: list.length ? "what Railway asks for" : "", problem: `The settings name no CLOUDFLARE_ZONE, so note the records ${host} and ${check} have at the DNS provider.` };
  }
  const token = secretOf(run, "CLOUDFLARE_API_TOKEN");
  if (!token) return { list: fromRailway(), from: "what Railway asks for", problem: `No CLOUDFLARE_API_TOKEN, in the environment or the secrets file, so Cloudflare's records weren't read.` };
  try {
    const zones = await cloudflare(token, `/zones?name=${encodeURIComponent(zone)}`);
    if (!zones?.length) return { list: fromRailway(), from: "what Railway asks for", problem: `The Cloudflare token can't see the zone ${zone}.` };
    const list = [];
    for (const [name, types] of [[host, ["CNAME", "A", "AAAA"]], [check, ["TXT"]]]) {
      const found = (await cloudflare(token, `/zones/${zones[0].id}/dns_records?name=${encodeURIComponent(name)}&per_page=100`)) ?? [];
      for (const item of found) if (types.includes(item.type)) list.push({ type: item.type, name: item.name, content: item.content, proxied: Boolean(item.proxied) });
    }
    return { list, from: `Cloudflare's ${zone}`, problem: list.length ? "" : `Cloudflare's ${zone} has no record for ${host}.` };
  } catch (error) {
    return { list: fromRailway(), from: "what Railway asks for", problem: `Cloudflare couldn't be read: ${error.message}` };
  }
}

// ---------------------------------------------------------------- Railway's schema

/**
 * Every document the script sends, checked against Railway's schema: each field, argument and input field it uses
 * must be there, and each argument Railway requires must be given. Stops before anything changes when one is gone,
 * unless asked only to say so.
 */
async function checkSchema({ stopOnProblem }) {
  let schema;
  try {
    schema = schemaOf((await gql(SCHEMA_QUERY, {}, { anonymous: true }))?.__schema);
  } catch (error) {
    const text = `Railway's API schema couldn't be read (${error.message}), so the calls weren't checked against it.`;
    if (stopOnProblem) throw new Stop(text);
    console.log(text);
    return null;
  }
  const { problems, checked } = checkDocuments(schema);
  if (!problems.length) {
    console.log(`Railway's API: it has every call this script makes (${checked} checked).`);
    return schema;
  }
  console.log(`Railway's API has changed: ${problems.length === 1 ? "a call" : "calls"} this script makes won't work as written.`);
  for (const problem of problems) console.log(`  ${problem}`);
  if (stopOnProblem) throw new Stop("Railway's API no longer has every call this script makes, so nothing was changed. The script needs an update first");
  return schema;
}

/** Introspection's answer as maps: type name to { kind, fields, inputFields, enumValues }. */
function schemaOf(raw) {
  if (!raw?.types) throw new Error("the answer had no types");
  const typeRef = (ref) => (ref.kind === "NON_NULL" ? `${typeRef(ref.ofType)}!` : ref.kind === "LIST" ? `[${typeRef(ref.ofType)}]` : ref.name);
  const types = new Map();
  for (const type of raw.types) {
    const args = (list) => new Map((list ?? []).map((arg) => [arg.name, { type: typeRef(arg.type), required: arg.type.kind === "NON_NULL" && arg.defaultValue == null }]));
    types.set(type.name, {
      kind: type.kind,
      fields: new Map((type.fields ?? []).map((field) => [field.name, { type: typeRef(field.type), args: args(field.args) }])),
      inputFields: args(type.inputFields),
      enumValues: new Set((type.enumValues ?? []).map((item) => item.name)),
    });
  }
  return { query: raw.queryType?.name, mutation: raw.mutationType?.name, types, raw };
}

const namedType = (ref) => String(ref).replace(/[[\]!]/g, "");

/** Each problem as a sentence naming the call and the field, and how many calls were checked. Marks what's used, for --save. */
function checkDocuments(schema, used = new Map()) {
  const problems = [];
  const use = (type, field) => {
    if (!used.has(type)) used.set(type, new Set());
    if (field) used.get(type).add(field);
  };
  const documents = Object.values(Q);
  for (const text of documents) {
    let document;
    try {
      document = parseDocument(text);
    } catch (error) {
      problems.push(`a document doesn't parse: ${error.message}`);
      continue;
    }
    const label = document.name ?? document.operation;
    for (const variable of document.variables) {
      const name = namedType(variable.type);
      if (!schema.types.has(name)) problems.push(`${label}: Railway's API has no type ${name}, which $${variable.name} is`);
      else use(name);
    }
    const root = document.operation === "mutation" ? schema.mutation : schema.query;
    if (!root) {
      problems.push(`${label}: Railway's API takes no ${document.operation}`);
      continue;
    }
    use(root);
    walk(document.selections, root, label);
  }
  for (const [input, fields] of Object.entries(INPUT_FIELDS)) {
    const type = schema.types.get(input);
    if (!type) {
      problems.push(`Railway's API has no input ${input}`);
      continue;
    }
    use(input);
    for (const field of fields) if (!type.inputFields.has(field)) problems.push(`${input} has no field ${field}`);
    for (const [field, { required }] of type.inputFields) if (required && !fields.includes(field)) problems.push(`${input} now requires ${field}`);
  }
  return { problems, checked: documents.length, used };

  function walk(selections, typeName, label) {
    const type = schema.types.get(typeName);
    for (const selection of selections) {
      if (selection.name === "__typename") continue;
      const field = type?.fields.get(selection.name);
      if (!field) {
        problems.push(`${label}: ${typeName} has no field ${selection.name}`);
        continue;
      }
      use(typeName, selection.name);
      for (const arg of selection.args) {
        const declared = field.args.get(arg.name);
        if (!declared) problems.push(`${label}: ${typeName}.${selection.name} takes no argument ${arg.name}`);
        else checkValue(arg.value, declared.type, `${label}: ${typeName}.${selection.name}(${arg.name})`);
      }
      for (const [name, { required }] of field.args) {
        if (required && !selection.args.some((arg) => arg.name === name)) problems.push(`${label}: ${typeName}.${selection.name} now requires the argument ${name}`);
      }
      const returned = namedType(field.type);
      const kind = schema.types.get(returned)?.kind;
      use(returned);
      if (selection.selections.length) {
        if (kind === "OBJECT" || kind === "INTERFACE") walk(selection.selections, returned, label);
        else problems.push(`${label}: ${typeName}.${selection.name} is a ${returned}, which has no fields`);
      } else if (kind === "OBJECT" || kind === "INTERFACE") problems.push(`${label}: ${typeName}.${selection.name} is a ${returned}, whose fields must be named`);
    }
  }

  function checkValue(value, typeRef, where) {
    const name = namedType(typeRef);
    const type = schema.types.get(name);
    if (!type) return problems.push(`${where}: Railway's API has no type ${name}`);
    use(name);
    if (value.kind === "object") {
      if (type.kind !== "INPUT_OBJECT") return problems.push(`${where} isn't an input object`);
      for (const [field, inner] of Object.entries(value.fields)) {
        const declared = type.inputFields.get(field);
        if (!declared) problems.push(`${where}: ${name} has no field ${field}`);
        else checkValue(inner, declared.type, `${where}.${field}`);
      }
      for (const [field, { required }] of type.inputFields) if (required && !(field in value.fields)) problems.push(`${where}: ${name} now requires ${field}`);
    } else if (value.kind === "enum" && type.kind === "ENUM" && !type.enumValues.has(value.value)) {
      problems.push(`${where}: ${name} has no value ${value.value}`);
    } else if (value.kind === "list") {
      for (const item of value.items) checkValue(item, typeRef.replace(/^\[|\]!?$/g, ""), where);
    }
  }
}

/** A query or mutation as the script writes them: variables, fields, aliases, arguments and nested selections. No fragments. */
function parseDocument(text) {
  const tokens = [];
  const pattern = /\s+|,|#[^\n]*|(\.\.\.|[{}()[\]:!$=@])|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([_A-Za-z][_0-9A-Za-z]*)|(.)/gy;
  for (let match; (match = pattern.exec(text)) && match[0] !== "";) {
    if (match[1]) tokens.push({ kind: "punct", value: match[1] });
    else if (match[2]) tokens.push({ kind: "string", value: JSON.parse(match[2]) });
    else if (match[3]) tokens.push({ kind: "number", value: Number(match[3]) });
    else if (match[4]) tokens.push({ kind: "name", value: match[4] });
    else if (match[5]) throw new Error(`unexpected ${match[5]}`);
  }
  let at = 0;
  const peek = (value) => tokens[at] && (value === undefined || tokens[at].value === value);
  const take = (value) => {
    const token = tokens[at];
    if (!token || (value !== undefined && token.value !== value)) throw new Error(`expected ${value ?? "more"} at token ${at}`);
    at += 1;
    return token.value;
  };
  const typeOf = () => {
    let type;
    if (peek("[")) {
      take("[");
      type = `[${typeOf()}]`;
      take("]");
    } else type = take();
    if (peek("!")) {
      take("!");
      type += "!";
    }
    return type;
  };
  const valueOf = () => {
    const token = tokens[at];
    if (token?.value === "$") {
      take("$");
      return { kind: "variable", name: take() };
    }
    if (token?.value === "[") {
      take("[");
      const items = [];
      while (!peek("]")) items.push(valueOf());
      take("]");
      return { kind: "list", items };
    }
    if (token?.value === "{") {
      take("{");
      const fields = {};
      while (!peek("}")) {
        const name = take();
        take(":");
        fields[name] = valueOf();
      }
      take("}");
      return { kind: "object", fields };
    }
    take();
    if (token.kind === "name") return ["true", "false", "null"].includes(token.value) ? { kind: "literal", value: token.value } : { kind: "enum", value: token.value };
    return { kind: "literal", value: token.value };
  };
  const selectionsOf = () => {
    const selections = [];
    take("{");
    while (!peek("}")) {
      let name = take();
      let alias = null;
      if (peek(":")) {
        take(":");
        alias = name;
        name = take();
      }
      const args = [];
      if (peek("(")) {
        take("(");
        while (!peek(")")) {
          const arg = take();
          take(":");
          args.push({ name: arg, value: valueOf() });
        }
        take(")");
      }
      selections.push({ name, alias, args, selections: peek("{") ? selectionsOf() : [] });
    }
    take("}");
    return selections;
  };
  const operation = take();
  if (!["query", "mutation"].includes(operation)) throw new Error(`a document starts with query or mutation, not ${operation}`);
  const name = peek("(") || peek("{") ? null : take();
  const variables = [];
  if (peek("(")) {
    take("(");
    while (!peek(")")) {
      take("$");
      const variable = take();
      take(":");
      variables.push({ name: variable, type: typeOf() });
      if (peek("=")) {
        take("=");
        valueOf();
      }
    }
    take(")");
  }
  const selections = selectionsOf();
  if (at !== tokens.length) throw new Error(`${name ?? operation} has more than one operation`);
  return { operation, name, variables, selections };
}

/** schema: checks every call against Railway's live API, which needs no token; --save writes the part used, for the tests. */
async function schemaCommand() {
  const schema = await checkSchema({ stopOnProblem: false });
  if (!schema) {
    process.exitCode = 1;
    return;
  }
  const { problems, used } = checkDocuments(schema);
  if (problems.length) process.exitCode = 1;
  if (!options.save) return;
  if (problems.length) throw new Stop(`not saved: Railway's API lacks what the script uses (above)`);
  // The types the script names, with only the fields it uses, and every argument and input field of those, so the
  // tests' stand-in answers the schema query as Railway does for this script's calls.
  const wanted = new Set(used.keys());
  for (let grew = true; grew;) {
    grew = false;
    for (const type of schema.raw.types) {
      if (!wanted.has(type.name)) continue;
      const refs = [
        ...(type.fields ?? []).filter((field) => used.get(type.name)?.has(field.name)).flatMap((field) => field.args.map((arg) => arg.type)),
        ...(type.inputFields ?? []).map((field) => field.type),
      ];
      for (const ref of refs) {
        let named = ref;
        while (named.ofType) named = named.ofType;
        if (!wanted.has(named.name)) {
          wanted.add(named.name);
          grew = true;
        }
      }
    }
  }
  const types = schema.raw.types.filter((type) => wanted.has(type.name)).map((type) => ({
    ...type,
    fields: type.fields ? type.fields.filter((field) => used.get(type.name)?.has(field.name)) : null,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const lines = types.map((type) => `    ${JSON.stringify(type)}`).join(",\n");
  const text = `{\n  "fetched": "${new Date().toISOString().slice(0, 10)}",\n  "__schema": {\n  "queryType": ${JSON.stringify(schema.raw.queryType)},\n  "mutationType": ${JSON.stringify(schema.raw.mutationType)},\n  "types": [\n${lines}\n  ]\n  }\n}\n`;
  fs.writeFileSync(options.save, text);
  console.log(`Wrote the part of Railway's API the script uses to ${options.save}: ${types.length} types.`);
}

// ---------------------------------------------------------------- Railway's and Cloudflare's APIs

let railwayAuth = null;

/** A read is tried again after a network error, a 429 or a 5xx; Railway reports a refusal as errors in a 200 answer. */
async function gql(query, variables = {}, { anonymous = false } = {}) {
  const mutation = /^\s*mutation\b/.test(query);
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(URLS.railway, {
        method: "POST",
        headers: { ...(anonymous ? {} : railwayAuth), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      // A change that timed out may have landed, so only reads are tried again.
      if (!mutation && attempt < 4) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(`couldn't reach Railway (${error.cause?.code ?? error.message})`);
    }
    if (response.status === 429) {
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
    if (body?.errors?.length) {
      const message = body.errors.map((error) => error.message).join("; ");
      if (/not authorized/i.test(message)) throw new Stop(`Railway refused ${operationName(query)} (${message}). The token has to reach both projects: an account token, or a token of their workspace (railway.com/account/tokens)`);
      throw new Error(`Railway refused ${operationName(query)}: ${message}`);
    }
    if (!response.ok || !body?.data) throw new Error(`Railway answered ${response.status}: ${text.slice(0, 300)}`);
    return body.data;
  }
}

const operationName = (query) => query.match(/^\s*(?:query|mutation) (\w+)/)?.[1] ?? "the call";

async function cloudflare(token, pathname) {
  let response;
  try {
    response = await fetch(`${URLS.cloudflare}${pathname}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`couldn't reach Cloudflare (${error.cause?.code ?? error.message})`);
  }
  const body = parseJson(await response.text());
  if (!response.ok || body?.success === false) throw new Error(`Cloudflare refused ${pathname.split("?")[0]}: ${body?.errors?.map((item) => item.message).join("; ") || `HTTP ${response.status}`}`);
  return body?.result;
}

/** A read the run can go on without: its answer, or { error } with the reason. A token Railway refuses still stops the run. */
async function attempt(read) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Stop) throw error;
    return { error: error.message };
  }
}

// ---------------------------------------------------------------- the command line

function parseArgs(argv) {
  const parsed = { command: "", target: "", backup: "", save: "" };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let value;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (equals > 0) [arg, value] = [arg.slice(0, equals), arg.slice(equals + 1)];
    if (arg === "--help" || arg === "-h") help();
    else if (arg === "--backup" || arg === "--save") {
      value ??= argv[++index];
      if (!value || value.startsWith("--")) usage(`${arg} needs a value.`);
      parsed[arg.slice(2)] = value;
    } else if (arg.startsWith("-")) usage(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  [parsed.command, parsed.target] = positional;
  if (parsed.command === "schema") {
    if (positional.length > 1) usage("schema takes no settings file.");
  } else if (parsed.command === "status") {
    if (!parsed.target || positional.length > 2) usage("status takes the settings file, or the deployment's address.");
    if (parsed.save) usage("--save goes with schema.");
  } else usage(parsed.command ? `Unknown command ${parsed.command}.` : "Give a command.");
  return parsed;
}

function help() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split(/\r?\n/);
  const end = text.findIndex((line) => line.startsWith("import "));
  consoleOriginal.log(text.slice(1, end).map((line) => line.replace(/^\/\/ ?/, "")).join("\n").trim());
  process.exit(0);
}

function usage(problem) {
  consoleOriginal.error(`${problem}\n\nUsage: node devops/redeploy.mjs status <settings file or address> [--backup <folder>]\n       node devops/redeploy.mjs schema [--save <file>]\nRun it with --help for more, and see devops/redeploy.md.`);
  process.exit(2);
}

// One reader for every question, so answers piped in on separate lines all arrive.
function ask(question, { hidden: hide = false } = {}) {
  prompter ??= createPrompter();
  return prompter.ask(question, hide);
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
    // Input that ended while a question waited answers it with nothing.
    if (current?.resolve) {
      const { resolve } = current;
      current = null;
      process.stdout.write("\n");
      resolve("");
    }
  });
  rl.on("SIGINT", () => {
    current = null;
    rl.close();
    process.stdout.write("\nStopped.\n");
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
    ask(question, muted) {
      if (waiting.length) {
        process.stdout.write(`${question}\n`);
        return Promise.resolve(waiting.shift().trim());
      }
      if (closed) {
        process.stdout.write(`${question}\n`);
        return Promise.resolve("");
      }
      return new Promise((resolve) => {
        current = { question, muted: false, resolve };
        rl.question(question, (answer) => {
          const wasMuted = current?.muted;
          current = null;
          if (wasMuted) process.stdout.write("\n");
          resolve(answer.trim());
        });
        current.muted = muted && terminal;
      });
    },
    close() {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------- words and numbers

function count(number, noun, plural = `${noun}s`) {
  return `${Number(number).toLocaleString("en-US")} ${number === 1 ? noun : plural}`;
}

function megabytes(mb) {
  const value = Number(mb);
  if (!Number.isFinite(value)) return "of unknown size";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`;
}

function bytes(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return "unknown size";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} bytes`;
}

function shortTime(iso) {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC` : String(iso ?? "?");
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

// Last, so every declaration above is in place before the run starts.
options = parseArgs(process.argv.slice(2));
main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prompter?.close());
