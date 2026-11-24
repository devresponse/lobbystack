#!/usr/bin/env node
// redeploy.mjs: moves a deployment that devops/bootstrap.mjs made to a new Railway project on PostgreSQL 18, the way
// devops/redeploy.md describes, and carries its step numbers. The new project is built from a copy of the deployment's
// settings files, its data and its bucket's files are copied at a quiet hour, the address moves to it, and the old
// project stays a week for going back.
//
//   node devops/redeploy.mjs status <settings file or address>    where the move stands; changes nothing
//   node devops/redeploy.mjs prepare <settings file or address>   steps 1 to 17: backups, notes, the new project
//   node devops/redeploy.mjs trial <settings file or address>     steps 18 to 20: the bucket, the address rehearsal,
//                                                                 and a trial copy of the database, a day ahead
//   node devops/redeploy.mjs cutover <settings file or address>   steps 22 to 33, at the hour picked: production
//                                                                 offline, its data copied, the address moved
//   node devops/redeploy.mjs check <settings file or address>     step 34: the checks, the last ones by you
//   node devops/redeploy.mjs back <settings file or address>      G1 to G9: production back on the old project
//   node devops/redeploy.mjs recover <settings file or address>   R1: the -pg18 files back from the backup folder
//   node devops/redeploy.mjs finish <settings file or address>    steps 35 to 39, after the cutover and its checks
//   node devops/redeploy.mjs retire <settings file or address>    step 40, a week later: deletes the old project
//   node devops/redeploy.mjs schema                               whether Railway's API still has every call it makes
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
// prepare, trial, cutover, check, back, finish and retire each run their steps in order, record each one in
// <settings file>.redeploy.json as it finishes, and skip what's recorded, so a command that stopped is finished by
// running it again. Each says what it will change and asks first, except check, which changes nothing, and each stops
// at the first check that fails. They run bootstrap.mjs and scale.mjs for what those already do, PostgreSQL 18's
// tools in Docker for the databases, and the AWS CLI for the buckets. Outside Railway, cutover's address move (step
// 30, through bootstrap's up) and back's (G5) change the address's DNS records in Cloudflare, each asking before it
// points the address's CNAME elsewhere. back finds where the cutover got to and goes back from there; recover puts
// the copy's files back when they're lost or broken. Each run is written to <settings file>.redeploy.log, secrets
// hidden.
//
// Options:
//   --backup <folder>     the backup folder, when it isn't lobbystack-backups/<the address's first part>-before-pg18
//                         beside this checkout
//   --dry-run             say what the command would do, and change nothing
//   --temporary <host>    with prepare: the new project's address until the switch, instead of <first part>-new.<rest>
//   --rehearse <host>     with trial: the throwaway address for the rehearsal, instead of move-test.<zone>
//   --no-rehearsal        with trial: leave the address rehearsal (step 19) out
//   --same-version        with prepare, trial and cutover: allow an old database that's already on 18, to rehearse
//                         the move
//   --save <file>         with schema: write the part of Railway's API the script uses into <file>, for its tests
//
// It needs a Railway account or workspace token (railway.com/account/tokens), which it reads as bootstrap.mjs does:
// RAILWAY_API_TOKEN from the environment, else from the settings file's .secrets file, else it asks. Cloudflare's
// token comes from CLOUDFLARE_API_TOKEN, the same way, and isn't asked for. Neither is saved or printed. The database's
// password comes from both state files, which must agree, and goes to Docker only. Every run first checks each call
// the script makes against Railway's API schema, which Railway gives without a token, and a command that changes
// something stops before it does if one is gone. Node 18 or later, nothing to install.

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
    customDomains { id domain status { verified verificationDnsHost verificationToken dnsRecords { recordType fqdn requiredValue currentValue status } } }
    serviceDomains { id domain }
  }
}`,
  tcpProxies: `query TcpProxies($environmentId: String!, $serviceId: String!) {
  tcpProxies(environmentId: $environmentId, serviceId: $serviceId) { id domain proxyPort applicationPort syncStatus deletedAt }
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
  // Step 5: Railway makes a backup in a workflow, so the script waits for it, finds the backup by its name and locks
  // it, which takes its end date away so the schedule never deletes it.
  backupCreate: `mutation BackupCreate($volumeInstanceId: String!, $name: String) {
  volumeInstanceBackupCreate(volumeInstanceId: $volumeInstanceId, name: $name) { workflowId }
}`,
  workflow: `query WorkflowStatus($workflowId: String!) {
  workflowStatus(workflowId: $workflowId) { status error }
}`,
  backupLock: `mutation BackupLock($volumeInstanceBackupId: String!, $volumeInstanceId: String!) {
  volumeInstanceBackupLock(volumeInstanceBackupId: $volumeInstanceBackupId, volumeInstanceId: $volumeInstanceId)
}`,
  // Step 37: the new database's backups, as guide 5.2's step 16 sets them.
  backupSchedule: `mutation BackupScheduleUpdate($volumeInstanceId: String!, $kinds: [VolumeInstanceBackupScheduleKind!]!) {
  volumeInstanceBackupScheduleUpdate(volumeInstanceId: $volumeInstanceId, kinds: $kinds)
}`,
  // Steps 6 and 18: a bucket's keys, which go to the AWS CLI's sync only, through its environment.
  bucketKeys: `query BucketCredentials($bucketId: String!, $environmentId: String!, $projectId: String!) {
  bucketS3Credentials(bucketId: $bucketId, environmentId: $environmentId, projectId: $projectId) { accessKeyId secretAccessKey endpoint bucketName region urlStyle }
}`,
  // Step 10.
  rename: `mutation ProjectRename($id: String!, $name: String!) {
  projectUpdate(id: $id, input: { name: $name }) { id name }
}`,
  // Step 15: the new database's own words about its version. Step 34: the new worker's errors.
  logs: `query Logs($deploymentId: String!, $filter: String, $limit: Int) {
  deploymentLogs(deploymentId: $deploymentId, filter: $filter, limit: $limit) { timestamp message severity }
}`,
  // Step 16: the variables the files don't know, onto the new services.
  upsert: `mutation VariablesUpsert($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}`,
  // Steps 17, 23 and 24: removing a deployment stops the service, and every copy of it.
  removeDeployment: `mutation DeploymentRemove($id: String!) {
  deploymentRemove(id: $id)
}`,
  // Steps 30, G2 and G7: a stopped service started again from the deployment that was removed, on the image it ran.
  redeployDeployment: `mutation DeploymentRedeploy($id: String!, $usePreviousImageTag: Boolean) {
  deploymentRedeploy(id: $id, usePreviousImageTag: $usePreviousImageTag) { id status }
}`,
  // Steps 29, G3 and G8: Railway's Redeploy, which runs migrate's pre-deploy again.
  redeployService: `mutation ServiceRedeploy($environmentId: String!, $serviceId: String!) {
  serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)
}`,
  // A stopped service whose removed deployment Railway won't deploy again: a new deployment from its source.
  deployService: `mutation ServiceDeploy($environmentId: String!, $serviceId: String!) {
  serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId)
}`,
  // Steps 19, 30, 38 and G5: an address on an admin.
  domainCreate: `mutation DomainCreate($input: CustomDomainCreateInput!) {
  customDomainCreate(input: $input) { id domain }
}`,
  domainDelete: `mutation DomainDelete($id: String!) {
  customDomainDelete(id: $id)
}`,
  domainAvailable: `query DomainAvailable($domain: String!) {
  customDomainAvailable(domain: $domain) { available message }
}`,
  // Steps 20, 22 and 39: a TCP proxy, set in the environment's settings, the way Railway's CLI sets the copies, and sent
  // without a deploy, so the database doesn't restart. TcpProxyDelete is for one that the settings didn't take away.
  patch: `mutation EnvironmentPatch($environmentId: String!, $patch: EnvironmentConfig, $commitMessage: String, $skipDeploys: Boolean) {
  environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage, skipDeploys: $skipDeploys)
}`,
  proxyDelete: `mutation TcpProxyDelete($id: String!) {
  tcpProxyDelete(id: $id)
}`,
  // Step 36: the old services no longer build from the repository, so a sync of the branch can't start them.
  disconnect: `mutation ServiceDisconnect($id: String!) {
  serviceDisconnect(id: $id) { id }
}`,
  // Step 40: Railway deletes the project after a grace period of 48 hours.
  scheduleDelete: `mutation ProjectScheduleDelete($id: String!) {
  projectScheduleDelete(id: $id)
}`,
};

// The SQL the copy runs, written into the backup folder (step 4), where psql reads it with -f: pasted into psql's
// prompt, a block can arrive as one line, and a leading command then swallows the rest (dev2's run, 2026-11-23).
const SQL = {
  // One line: the tables, the rows in all, and a fingerprint of every table's name and row count.
  "count.sql": `with t as (
  select table_schema || '.' || table_name as tbl,
    (xpath('/row/c/text()', query_to_xml(format(
      'select count(*) as c from %I.%I', table_schema, table_name),
      false, true, '')))[1]::text::bigint as n
  from information_schema.tables
  where table_type = 'BASE TABLE'
    and table_schema not in ('pg_catalog', 'information_schema')
)
select format('tables %s, rows %s, fingerprint %s',
  count(*), sum(n),
  md5(string_agg(tbl || '=' || n, ',' order by tbl collate "C")))
from t;
`,
  // Stops the app's roles from connecting, ends the sessions still open, and shows the database's own settings.
  "freeze.sql": `revoke connect on database lobbystack from public;
select count(pg_terminate_backend(pid)) as sessions_ended
from pg_stat_activity
where datname = 'lobbystack' and pid <> pg_backend_pid();
select coalesce(string_agg(s, ', '), 'none') as database_settings
from pg_db_role_setting, unnest(setconfig) as s
where setrole = 0 and setdatabase =
  (select oid from pg_database where datname = 'lobbystack');
`,
  // Every table with its rows, to find where two counts differ.
  "tables.sql": `select table_schema || '.' || table_name || ' ' ||
  (xpath('/row/c/text()', query_to_xml(format(
    'select count(*) as c from %I.%I', table_schema, table_name),
    false, true, '')))[1]::text
from information_schema.tables
where table_type = 'BASE TABLE'
  and table_schema not in ('pg_catalog', 'information_schema')
order by (table_schema || '.' || table_name) collate "C";
`,
  // Calls in each hour of the day over four weeks, in this computer's time zone, to pick the hour (step 21).
  "hours.sql": `select to_char(started_at at time zone :'tz', 'HH24') || ' ' || count(*)
from calls
where started_at > now() - interval '28 days'
group by 1
order by 1;
`,
};

// How often a wait asks again, and so how long it waits: a wait of n minutes asks n * 12 times. Tests shorten it.
const POLL_MS = Number(process.env.REDEPLOY_POLL_MS ?? 5000);
const polls = (minutes) => Math.ceil((minutes * 60_000) / 5000);
// The new admin's address, reached for its health checks. Tests point it at a stand-in ({host} is the address).
const SITE_URL = process.env.REDEPLOY_SITE_URL ?? "https://{host}";
// What a change command runs: bootstrap.mjs and scale.mjs beside this script. Tests give stand-ins.
const BOOTSTRAP = process.env.REDEPLOY_BOOTSTRAP ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "bootstrap.mjs");
const SCALE = process.env.REDEPLOY_SCALE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "scale.mjs");
// The services that make up a deployment, in the order step 15 waits for them.
const RUNNING = ["Postgres", "Redis", "migrate", "admin", "worker", "control", "cloudflared"];

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
const INPUT_FIELDS = {
  VariableCollectionUpsertInput: ["projectId", "environmentId", "serviceId", "variables"],
  CustomDomainCreateInput: ["domain", "environmentId", "projectId", "serviceId", "targetPort"],
};

class Stop extends Error {}

const hidden = new Set();
const consoleOriginal = { log: console.log.bind(console), error: console.error.bind(console) };
// Everything printed goes to the change commands' log too, secrets hidden the same way.
let logFile = null;
for (const level of ["log", "error"]) {
  console[level] = (...args) => {
    const text = redact(args.join(" "));
    consoleOriginal[level](text);
    if (logFile) {
      try {
        fs.appendFileSync(logFile, `${text}\n`, { mode: 0o600 });
      } catch {
        // A log that can't be written doesn't stop the run.
      }
    }
  };
}

let prompter = null;
let options;

async function main() {
  if (typeof fetch !== "function") throw new Error("this script needs Node 18 or later");
  if (options.command === "schema") return schemaCommand();
  const run = loadRun(options.target);
  if (options.command === "status") return status(run);
  if (options.command === "recover") return recoverCommand(run);
  return changeCommand(run);
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
  return fs.existsSync(`${file}.state.json`) ? readBootstrapState(file).values : null;
}

/** bootstrap.mjs's state file: the steps it has done, and the values it keeps. Empty when there's none. */
function readBootstrapState(file) {
  const stateFile = `${file}.state.json`;
  if (!fs.existsSync(stateFile)) return { done: {}, values: {} };
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return { done: state?.done ?? {}, values: state?.values ?? {} };
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
  let copy = null;
  if (fs.existsSync(copyFile)) {
    try {
      copy = { file: copyFile, settings: readSettings(copyFile), values: readBootstrapValues(copyFile) ?? {} };
    } catch (error) {
      // recover (R1) is for a copy that's lost or broken.
      if (options.command !== "recover") throw error;
      copy = { file: copyFile, settings: {}, values: {}, broken: error.message };
    }
  }
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

  await signIn(run);
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
  printProgress(run);
  console.log(`\nThe steps, and what's still done by hand: devops/redeploy.md.`);
}

/** Each command's steps as the state file records them, and what's next. */
function printProgress(run) {
  const { done, values } = run.state;
  console.log("\nThe steps, as the state file records them:");
  for (const [name, steps] of [["prepare", PREPARE], ["trial", TRIAL], ["cutover", CUTOVER], ["check", CHECK], ["finish", FINISH], ["retire", RETIRE]]) {
    const finished = steps.filter((step) => done[step.n]);
    const next = steps.find((step) => !done[step.n]);
    const range = steps.length > 1 ? `steps ${steps[0].n} to ${steps.at(-1).n}` : `step ${steps[0].n}`;
    const state = !finished.length ? "not started" : next ? `${finished.length} of ${steps.length} done, step ${next.n} next` : `done, ${shortTime(done[steps.at(-1).n])}`;
    console.log(`  ${name.padEnd(8)} ${range.padEnd(17)} ${state}`);
  }
  if (values.backPath) {
    const steps = values.backPath === "before" ? BACK_BEFORE : BACK_AFTER;
    const next = steps.find((step) => !done[step.n]);
    console.log(`  back     ${`${steps[0].n} to ${steps.at(-1).n}`.padEnd(17)} stopped halfway${next ? `, ${next.n} next` : ""}: run back again to finish it`);
  }
  for (const item of values.wentBack ?? []) {
    console.log(`  went back ${shortTime(item.at)}, ${item.path === "before" ? "before the address moved" : "after the address moved"}${item.aside ? `; what customers wrote after the switch is in the new server's ${item.aside}` : ""}`);
  }
}

function printFiles(run) {
  console.log(`${run.host || run.label}: the move to a new Railway project on PostgreSQL ${TARGET_MAJOR} (devops/redeploy.md)`);
  console.log(`  settings file: ${run.file} (${run.how})`);
  const copyLine = !run.copy ? "not made yet (step 8)"
    : run.copy.broken ? `${run.copy.file}, which can't be read: ${run.copy.broken}`
    : `${run.copy.file}${settingsHost(run.copy.settings) && settingsHost(run.copy.settings) !== run.host ? `, at the address ${settingsHost(run.copy.settings)}` : ""}`;
  console.log(`  the new project's copy: ${copyLine}`);
  console.log(`  backup folder: ${run.backup}${fs.existsSync(run.backup) ? "" : " (not made yet: step 4)"}`);
  const holder = lockHolder(run);
  if (holder) console.log(`  another run (${holder.command ?? "a command"}, process ${holder.pid}, since ${holder.started ?? "?"}) is using ${run.stateFile}`);
  // A change command holds the lock itself.
  else if (!run.locked && fs.existsSync(`${run.stateFile}.lock`)) console.log(`  a lock left by a run that's gone: ${run.stateFile}.lock, which the next run takes over (R2)`);
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
  else fix(missingTool(aws) ? "no AWS CLI, version 2: the bucket's files are copied with it (guide 7.7)" : `aws --version failed: ${firstLine(aws)}`);
}

/**
 * Runs a command-line tool and returns spawnSync's result. It never goes through a shell, so no argument, such as a
 * folder's name or an address Railway gives, can become part of a command. The tools it runs, docker, aws, git and
 * icacls, are programs of their own on Windows too; the AWS CLI's version 2 is (aws.exe), its version 1 from pip is
 * a .cmd file, which only a shell starts.
 */
function runTool(command, args, settings = {}) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...settings, shell: false });
}

/** Whether a runTool result means the tool isn't installed, or on Windows is only a .cmd file. */
function missingTool(result) {
  return Boolean(result.error);
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
  printComparison(run, await compareVariables(run, old, fresh));
}

/**
 * The variables of migrate, the admin, the worker and the control panel, old against new, in the groups step 16 acts
 * on. Each role's old values are kept for copying, and hidden from what's printed.
 */
async function compareVariables(run, old, fresh) {
  const sealedOld = await sealedNames(old);
  const sealedNew = await sealedNames(fresh);
  const roles = [];
  let oldAdmin = null;
  for (const role of COMPARED) {
    const a = old.service(role);
    const b = fresh.service(role);
    if (!a && !b) continue;
    if (!a || !b) {
      roles.push({ role, only: a ? "old" : "new" });
      continue;
    }
    const left = await variablesOf(old, a);
    const right = await variablesOf(fresh, b);
    if (left.error || right.error) {
      roles.push({ role, error: left.error ?? right.error });
      continue;
    }
    if (role === "admin") oldAdmin = left.values;
    const sealed = new Set([...(sealedOld.get(a.id) ?? []), ...(sealedNew.get(b.id) ?? [])]);
    const compared = (values) => Object.keys(values).filter((name) => !sealed.has(name) && (!name.startsWith("RAILWAY_") || RAILWAY_SETTABLE.has(name)));
    const oldNames = compared(left.values);
    const newNames = new Set(compared(right.values));
    const onlyOld = oldNames.filter((name) => !newNames.has(name)).sort();
    const differ = oldNames.filter((name) => newNames.has(name) && String(left.values[name]) !== String(right.values[name])).sort();
    const connect = onlyOld.filter((name) => role === "admin" && CONNECT_VARIABLES.has(name));
    const address = differ.filter((name) => ADDRESS_VARIABLES.has(name));
    const keys = differ.filter((name) => !ADDRESS_VARIABLES.has(name) && KEY_NAME.test(name));
    roles.push({
      role,
      oldService: a,
      newService: b,
      oldValues: left.values,
      newValues: right.values,
      connect,
      byHand: onlyOld.filter((name) => !connect.includes(name)),
      address,
      keys,
      other: differ.filter((name) => !address.includes(name) && !keys.includes(name)),
      onlyNew: [...newNames].filter((name) => !(name in left.values)).sort(),
      sealed: [...sealed].sort(),
    });
  }
  let webhook = null;
  const secret = run.copy && secretFromFile(`${run.copy.file}.secrets`, "OPENAI_WEBHOOK_SECRET");
  if (secret) {
    hide(secret);
    webhook = !oldAdmin ? "unread" : oldAdmin.OPENAI_WEBHOOK_SECRET === secret ? "same" : "differs";
  }
  return { roles, webhook };
}

function printComparison(run, { roles, webhook }) {
  console.log("\nVariables, old against new (names only; no value is shown)");
  for (const item of roles) {
    if (item.only) {
      console.log(`  ${item.role}: only in the ${item.only} project`);
      continue;
    }
    if (item.error) {
      console.log(`  ${item.role}: couldn't read its variables (${item.error})`);
      continue;
    }
    const lines = [];
    if (item.connect.length) lines.push(`only in the old project, set by connect: ${item.connect.join(", ")}. connect runs after the switch (step 32): copy them to the new admin now, so it answers calls and Polar from the first minute (step 16)`);
    if (item.byHand.length) lines.push(`only in the old project, so added in Railway by hand: ${item.byHand.join(", ")}. Copy them to the new ${item.role} (step 16)`);
    if (item.address.length) lines.push(`different: ${item.address.join(", ")}, the address, which the cutover sets back (step 30)`);
    if (item.keys.length) lines.push(`different: ${item.keys.join(", ")}, ${item.keys.length === 1 ? "a key" : "keys"} changed in Railway since the files were written. Bring the copy's files up to date first, since every variables run puts the files' value back: the key in ${run.copy.file}.secrets, then redo its step and up (step 16)`);
    if (item.other.length) lines.push(`different: ${item.other.join(", ")}. The new ${item.other.length === 1 ? "value is" : "values are"} the script's own; keep ${item.other.length === 1 ? "it" : "them"}, unless production's was set by hand on purpose (step 16)`);
    if (item.onlyNew.length) lines.push(`only in the new project: ${item.onlyNew.join(", ")}`);
    if (item.sealed.length) lines.push(`sealed, so Railway shows no value to compare: ${item.sealed.join(", ")}. Check ${item.sealed.length === 1 ? "it" : "them"} by hand`);
    console.log(`  ${item.role}:${lines.length ? "" : " the same in both"}`);
    for (const line of lines) console.log(`    ${line}`);
  }
  if (webhook) {
    const said = { unread: "not compared, since the old admin's variables couldn't be read", same: "the same as the old admin's", differs: "differs from the old admin's. Put the old admin's there before connect runs (step 16)" };
    console.log(`  OPENAI_WEBHOOK_SECRET in ${run.copy.file}.secrets, which connect puts on the admin: ${said[webhook]}`);
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
  // A change command holds the lock already.
  const release = run.locked ? () => undefined : tryLock(run);
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
  const fromRailway = () => recordsOf(admin?.domains?.customDomains?.find((item) => item.domain === host), host);
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

// ---------------------------------------------------------------- the change commands

// Each step carries its number in devops/redeploy.md. A step whose work is found done already says so, and is recorded
// like the others.
const PREPARE = [
  { n: "1", what: "Check the tools: Docker running, and the AWS CLI for the bucket", run: checkTools },
  { n: "2", what: `Get PostgreSQL ${TARGET_MAJOR}'s tools: docker pull postgres:${TARGET_MAJOR}`, run: pullImage },
  { n: "3", what: `Check the checkout: its bootstrap.mjs makes the database on PostgreSQL ${TARGET_MAJOR}`, run: checkCheckout },
  { n: "4", what: "The backup folder, with the three files and the SQL the copy runs", run: makeBackupFolder },
  { n: "5", what: "A Railway backup of the old database, locked so the schedule keeps it", run: backupDatabase },
  { n: "6", what: "The old bucket's files, copied into the backup folder", run: (ctx) => copyBucket(ctx, false) },
  { n: "7", what: "The notes for going back: the address's DNS records, and the copies", run: keepNotes },
  { n: "8", what: `The copy of the three files, ${COPY_SUFFIX}, made where none exists yet`, run: copySettings },
  { n: "9", what: "The copy's temporary address", run: temporaryAddress },
  { n: "10", what: "The old Railway project renamed, so up can't find it by its name", run: renameOld },
  { n: "11", what: "The copy forgets the old project: bootstrap's redo railway.project, once", run: forgetOld },
  { n: "12", what: "bootstrap's doctor and up --dry-run on the copy", run: checkCopy },
  { n: "13", what: `The new project, built by bootstrap's up from the copy, on PostgreSQL ${TARGET_MAJOR}`, run: buildNew },
  { n: "14", what: "The copy's files, backed up to after-stage-1 in the backup folder", run: (ctx) => backupCopy(ctx, "after-stage-1") },
  { n: "15", what: `The new services running, migrate done, the database on ${TARGET_MAJOR}, the admin answering`, run: checkNew },
  { n: "16", what: "What the files don't know, copied from the old services' variables to the new ones", run: copyVariables },
  { n: "17", what: "The new cloudflared stopped, so the control panel answers only from the old project", run: stopNewTunnel },
];

const TRIAL = [
  { n: "18", what: "The bucket's files, copied into the new bucket too", run: (ctx) => copyBucket(ctx, true) },
  { n: "19", what: "The address move, rehearsed with a throwaway name", run: rehearseAddress },
  { n: "20", what: "A trial copy of the database into lobbystack_trial on the new server, timed, then cleaned up", run: trialCopy },
];

const FINISH = [
  { n: "35", what: "The copies of the admin and the worker, set again as step 7 noted them", run: setCopies },
  { n: "36", what: "The old services disconnected from the repository, so a sync can't start them", run: disconnectOld },
  { n: "37", what: "The new database's Railway backups, on the old one's schedule", run: scheduleBackups },
  { n: "38", what: "The temporary address, removed from the new admin and from Cloudflare", run: removeTemporary },
  { n: "39", what: "Both databases' TCP proxies deleted", run: closeProxies },
];

const RETIRE = [
  { n: "40", what: "The old project deleted, with 48 hours' grace, and its files moved into the backup folder", run: retireOld },
];

const CUTOVER = [
  { n: "22", what: `Both databases opened to this computer through TCP proxies, the new one on PostgreSQL ${TARGET_MAJOR}`, run: openDatabases },
  { n: "23", what: "The new admin, worker and control panel stopped", run: stopNew },
  { n: "24", what: "Once no call is in progress, the old admin stopped, the old worker two minutes later, then the old cloudflared: production is offline from here", run: stopOld },
  { n: "25", what: "The old database frozen, counted, and dumped into the backup folder", run: dumpOld },
  { n: "26", what: `The dump restored into the new database, on PostgreSQL ${TARGET_MAJOR} only`, run: restoreNew },
  { n: "27", what: "The new database counted and compared with the old one, and given the old one's reset-protection mark", run: compareNew },
  { n: "28", what: "The bucket's newest files, copied into the new bucket", run: (ctx) => copyBucket(ctx, true) },
  { n: "29", what: "The new migrate deployed again, on the copied data", run: migrateNew },
  { n: "30", what: "The address moved: off the old admin, then bootstrap's up on the copy, which asks before pointing its CNAME at the new project", run: moveAddress },
  { n: "31", what: "The copy's files, backed up to after-cutover in the backup folder", run: (ctx) => backupCopy(ctx, "after-cutover") },
  { n: "32", what: "bootstrap's connect on the copy, whose billing plan you read before you type yes", run: connectNew },
  { n: "33", what: "Production back: the address answers from the new project", run: productionBack },
];

const CHECK = [
  { n: "34", what: "The checks: health, the copies, the worker's log and the control panel, then a sign-in, files, a call, a text and Polar, by you", run: checks },
];

// Going back before step 30, while the old admin still has the address, and after it.
const BACK_BEFORE = [
  { n: "G1", what: "The old database opened to the app's roles again", run: openOld },
  { n: "G2", what: "The old admin, worker and cloudflared started again", run: startOld },
  { n: "G3", what: `The new database emptied, on PostgreSQL ${TARGET_MAJOR} only, and the new migrate deployed again`, run: emptyNew },
];

const BACK_AFTER = [
  { n: "G4", what: "The new services stopped, and the address taken off the new admin", run: stopNewAll },
  { n: "G5", what: "The address given back to the old admin, with its DNS records", run: addressBack },
  { n: "G6", what: "The old database opened to the app's roles again", run: openOld },
  { n: "G7", what: "The old admin, worker and cloudflared started again", run: startOld },
  { n: "G8", what: `The new database set aside as lobbystack_after_switch, on PostgreSQL ${TARGET_MAJOR} only, and the new migrate deployed again`, run: asideNew },
  { n: "G9", what: "Polar: a webhook for the temporary address, if connect ever made one", run: polarNote },
];

const COMMANDS = {
  prepare: {
    title: "prepare: steps 1 to 17, while production runs",
    steps: PREPARE,
    check: checkPrepare,
    changes: prepareChanges,
    next: () => "Next, a day or so before the cutover: node devops/redeploy.mjs trial, steps 18 to 20.",
  },
  trial: {
    title: "trial: steps 18 to 20, a day or so before the cutover, while production runs",
    steps: TRIAL,
    check: checkTrial,
    changes: trialChanges,
    next: () => "Next: pick the hour (step 21), from the calls by hour above, then at that hour: node devops/redeploy.mjs cutover, steps 22 to 33.",
  },
  finish: {
    title: "finish: steps 35 to 39, once the cutover's checks have passed",
    steps: FINISH,
    check: checkFinish,
    changes: finishChanges,
    question: () => "Have all of step 34's checks passed on the new project?",
    next: () => "Next, in a week, if nothing needed going back: node devops/redeploy.mjs retire, step 40.",
  },
  retire: {
    title: "retire: step 40, a week after the cutover",
    steps: RETIRE,
    check: checkRetire,
    changes: retireChanges,
    question: (ctx) => `Railway deletes the old project, "${ctx.old.project.name}", and its backups 48 hours from now, and going back is then impossible.`,
    answer: (ctx) => ctx.old.project.name,
    after: moveOldFiles,
    next: () => `The move is over. From now on, bootstrap and the scale script run with the ${COPY_SUFFIX} files.`,
  },
  cutover: {
    title: "cutover: steps 22 to 33, at the hour picked. Production is offline from step 24 to step 33",
    steps: CUTOVER,
    check: checkCutover,
    changes: cutoverChanges,
    question: (ctx) => (ctx.run.state.done["24"]
      ? `Production has been offline since ${shortTime(ctx.run.state.values.cutover?.offline ?? ctx.run.state.done["24"])} (step 24). Go on with the cutover?`
      : "Production goes offline at step 24, until step 33. Is it the hour you picked, with the customers who need notice told?"),
    next: () => "Next, right away: node devops/redeploy.mjs check, step 34. If a check fails and can't be fixed quickly, go back: node devops/redeploy.mjs back.",
  },
  check: {
    title: "check: step 34, right after the cutover",
    steps: CHECK,
    check: checkCheck,
    changes: () => ["change nothing: it reads the new project, has the scale script list the copies, and asks you about the checks only a person can do"],
    ask: false,
    next: () => "Next, once you're happy with the new project: node devops/redeploy.mjs finish, steps 35 to 39.",
  },
  back: {
    title: (ctx) => (ctx.path === "before" ? "back: G1 to G3, going back before the address moved" : "back: G4 to G9, going back after the address moved"),
    steps: (ctx) => (ctx.path === "before" ? BACK_BEFORE : BACK_AFTER),
    check: checkBack,
    changes: backChanges,
    question: backQuestion,
    begin: (ctx) => {
      ctx.run.state.values.backPath = ctx.path;
      keepState(ctx.run);
    },
    after: wentBack,
    afterAlways: true,
    next: () => "To try again, run cutover from step 22, at another quiet hour.",
  },
};

/**
 * Every command but status, recover and schema: each checks Railway's API and both projects first, says what it will
 * change and asks, then runs its steps in order, holding the state file's lock throughout. A step is recorded in the
 * state file as soon as it finishes, and a recorded step is skipped, so a command that stopped is finished by running
 * it again.
 */
async function changeCommand(run) {
  const release = options.dryRun ? () => undefined : tryLock(run);
  if (!release) {
    const holder = lockHolder(run);
    throw new Stop(`another run${holder ? ` (${holder.command ?? "a command"}, process ${holder.pid})` : ""} is using ${run.stateFile}. Let it finish; if none is running, delete ${run.stateFile}.lock (R2)`);
  }
  run.locked = !options.dryRun;
  try {
    if (!options.dryRun) {
      logFile = `${run.file}.redeploy.log`;
      logOnly(`\n==== ${options.command} ${path.basename(run.file)} | ${new Date().toISOString()} | node ${process.version} on ${process.platform}`);
    }
    const command = COMMANDS[options.command];
    printFiles(run);
    console.log("");
    await checkSchema({ stopOnProblem: !options.dryRun });
    await signIn(run);
    const ctx = await readBoth(run);
    await command.check(ctx);
    const steps = typeof command.steps === "function" ? command.steps(ctx) : command.steps;
    console.log(`\n${typeof command.title === "function" ? command.title(ctx) : command.title}`);
    for (const step of steps) console.log(`  ${run.state.done[step.n] ? "done" : "    "} ${step.n.padStart(2)}. ${step.what}`);
    const left = steps.filter((step) => !run.state.done[step.n]);
    if (!left.length) {
      if (command.afterAlways && !options.dryRun) await command.after(ctx);
      console.log(`\nEvery step of ${options.command} is done. ${command.next(ctx)}`);
      return;
    }
    console.log(`\n${options.command} ${options.dryRun ? "would" : "will"}:`);
    for (const line of command.changes(ctx, new Set(left.map((step) => step.n)))) console.log(`  - ${line}`);
    if (options.dryRun) {
      console.log("\nA dry run: nothing was changed.");
      return;
    }
    if (command.ask !== false) await confirm(command.question?.(ctx) ?? "", command.answer?.(ctx));
    command.begin?.(ctx);
    await runSteps(ctx, steps);
    if (command.after) await command.after(ctx);
    console.log(`\n${command.next(ctx)}`);
  } finally {
    release();
    run.locked = false;
  }
}

async function runSteps(ctx, steps) {
  const { run } = ctx;
  for (const step of steps) {
    if (run.state.done[step.n]) continue;
    console.log(`\n${step.n}. ${step.what}`);
    const started = Date.now();
    try {
      await step.run(ctx);
    } catch (error) {
      try {
        keepState(run);
      } catch {
        // The step's own error says more.
      }
      const message = `step ${step.n}: ${error.message}`;
      throw error instanceof Stop ? new Stop(message) : new Error(message);
    }
    run.state.done[step.n] = new Date().toISOString();
    (run.state.values.seconds ??= {})[step.n] = Math.round((Date.now() - started) / 1000);
    keepState(run);
  }
}

function keepState(run) {
  if (!save(run)) throw new Stop(`another program changed ${run.stateFile} while this run held its lock, so this run's record wasn't saved. Look at the file, then run again`);
}

/** Goes on only when the answer is the one asked for: yes, or for retire the old project's name. */
async function confirm(question, expected = "yes") {
  const answer = await ask(`${question ? `${question} ` : ""}Type ${expected === "yes" ? "yes" : `"${expected}"`} to go on: `);
  if (expected === "yes" ? answer.toLowerCase() !== "yes" : answer !== expected) throw new Stop("stopped at your answer. Nothing more was changed");
}

/** A line for the log only, such as the command a child ran; the child's own output went to the terminal. */
function logOnly(text) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${redact(text)}\n`, { mode: 0o600 });
  } catch {
    // A log that can't be written doesn't stop the run.
  }
}

let railwayToken = "";

async function signIn(run) {
  railwayToken = secretOf(run, "RAILWAY_API_TOKEN") || hide(await ask("Railway account or workspace token (typing is hidden): ", { hidden: true }));
  if (!railwayToken) throw new Stop("no Railway token given");
  railwayAuth = { Authorization: `Bearer ${railwayToken}` };
}

/** Both projects as Railway has them now: the old one from the original's state file, the new one from the copy's once it names one. */
async function readBoth(run) {
  reloadCopy(run);
  const old = await readProject(run.old, "old");
  await loadDomains(old);
  const id = run.copy?.values?.RAILWAY_PROJECT_ID;
  const fresh = id && id !== run.old.RAILWAY_PROJECT_ID ? await readProject(run.copy.values, "new") : null;
  if (fresh) await loadDomains(fresh);
  return { run, old, fresh };
}

function reloadCopy(run) {
  const file = `${run.file}${COPY_SUFFIX}`;
  if (!fs.existsSync(file)) {
    run.copy = null;
    return;
  }
  const state = readBootstrapState(file);
  run.copy = { file, settings: readSettings(file), values: state.values, done: state.done };
}

/** The admin's addresses, which the steps that move or check an address need. */
async function loadDomains(where) {
  const admin = where.service("admin");
  if (admin) admin.domains = (await gql(Q.domains, { projectId: where.project.id, environmentId: where.environment.id, serviceId: admin.id })).domains;
}

const hasAddress = (where, host) => Boolean(where?.service("admin")?.domains?.customDomains?.some((item) => item.domain === host));

/** The new project, checked against both state files before the script changes anything in it. */
function assertNew(ctx) {
  const { run, fresh } = ctx;
  if (!fresh) throw new Stop("the new project isn't built yet: run prepare first");
  if (fresh.project.id === run.old.RAILWAY_PROJECT_ID || fresh.project.id !== run.copy?.values?.RAILWAY_PROJECT_ID) throw new Stop("the new project doesn't check out against the two state files, so nothing was changed in it");
  return fresh;
}

/** The name bootstrap's up gives the new project, and finds a project by: the name the state files recorded. */
const projectName = (run) => run.copy?.values?.RAILWAY_PROJECT_NAME || run.old.RAILWAY_PROJECT_NAME || run.host;

/** The address the new project has until the switch (step 9). */
function temporaryHost(run) {
  const given = hostOf(options.temporary);
  if (given) return given;
  if (run.state.values.temporary) return run.state.values.temporary;
  const copyHost = run.copy && settingsHost(run.copy.settings);
  if (copyHost && copyHost !== run.host) return copyHost;
  const [first, ...rest] = run.host.split(".");
  return [`${first}-new`, ...rest].join(".");
}

// ---------------------------------------------------------------- prepare (steps 1 to 17)

function checkPrepare(ctx) {
  const { run, old, fresh } = ctx;
  if (!run.host) throw new Stop("the settings name no address (APP_BASE_URL). The move takes the deployment's address to the new project at step 30, so it needs one");
  const postgres = old.service("Postgres");
  if (!postgres) throw new Stop("the old project has no Postgres service");
  const image = postgres.instance?.source?.image;
  if (pgMajor(image) === TARGET_MAJOR && !options.sameVersion) throw new Stop(`the old database runs PostgreSQL ${TARGET_MAJOR} already (${image}), so there's nothing to move. To rehearse the move on it anyway, add --same-version`);
  if (hasAddress(fresh, run.host)) throw new Stop(`the new project has ${run.host} already: the cutover has run, so prepare has nothing left to do`);
  if (options.temporary && run.state.done["9"] && hostOf(options.temporary) !== run.state.values.temporary) throw new Stop(`step 9 gave the copy ${run.state.values.temporary} already. Leave --temporary out`);
}

function prepareChanges(ctx, todo) {
  const { run, old } = ctx;
  const lines = [];
  if (todo.has("5")) lines.push("make a Railway backup of the old database and lock it (step 5)");
  if (todo.has("6") && old.buckets.length) lines.push(`copy the old bucket's files into ${run.backup} (step 6)`);
  if (todo.has("10") && old.project.name === projectName(run)) lines.push(`rename the old Railway project to "${oldName(ctx)}" (step 10)`);
  if (todo.has("13")) lines.push(`build a new Railway project named "${projectName(run)}" at ${temporaryHost(run)} with bootstrap's up, which asks its own questions; Railway charges for it from then on (steps 11 to 13)`);
  if (todo.has("16")) lines.push("copy the variables the old services have and the files don't to the new services (step 16)");
  if (todo.has("17") && old.service("cloudflared")) lines.push("stop the new cloudflared (step 17)");
  lines.push("Production keeps running throughout, and nothing changes at OpenAI, Twilio, Resend or Polar.");
  return lines;
}

const oldName = (ctx) => `${projectName(ctx.run)} (old, PostgreSQL ${pgMajor(ctx.old.service("Postgres")?.instance?.source?.image) ?? 16})`;

async function checkTools(ctx) {
  const problems = [];
  const docker = runTool("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (docker.status === 0) console.log("  ok  Docker is running");
  else problems.push(missingTool(docker) ? `no Docker: PostgreSQL ${TARGET_MAJOR}'s tools run in it (Docker Desktop on Windows and Mac)` : "Docker isn't running: start Docker Desktop");
  if (ctx.old.buckets.length) {
    const aws = runTool("aws", ["--version"]);
    if (aws.status === 0) console.log(`  ok  AWS CLI ${aws.stdout.match(/aws-cli\/([\w.]+)/)?.[1] ?? firstLine(aws)}`);
    else problems.push(missingTool(aws) ? "no AWS CLI, version 2: it copies the bucket's files (guide 7.7)" : `aws --version failed: ${firstLine(aws)}`);
  }
  console.log(`  ok  Node.js ${process.version}, and the token reads the old project, "${ctx.old.project.name}"`);
  if (problems.length) throw new Stop(`${problems.join("; ")}. Then run ${options.command} again`);
}

async function pullImage() {
  const image = `postgres:${TARGET_MAJOR}`;
  if (runTool("docker", ["image", "inspect", image, "--format", "{{.Id}}"]).status !== 0) {
    console.log(`  docker pull ${image}: a few hundred MB, once`);
    handOver();
    const pulled = runTool("docker", ["pull", image], { stdio: "inherit" });
    if (pulled.status !== 0) throw new Stop(`docker pull ${image} failed${pulled.error ? `: ${pulled.error.message}` : " (above)"}`);
  }
  const version = runTool("docker", ["run", "--rm", image, "pg_dump", "--version"]);
  if (Number(version.stdout?.match(/\(PostgreSQL\)\s+(\d+)/)?.[1]) !== TARGET_MAJOR) throw new Stop(`${image}'s pg_dump says "${firstLine(version)}", not PostgreSQL ${TARGET_MAJOR}`);
  console.log(`  ok  ${version.stdout.trim()}`);
}

async function checkCheckout() {
  let text;
  try {
    text = fs.readFileSync(BOOTSTRAP, "utf8");
  } catch (error) {
    throw new Stop(`couldn't read ${BOOTSTRAP} (${error.code ?? error.message})`);
  }
  const image = text.match(/const POSTGRES_IMAGE = "([^"]+)"/)?.[1];
  if (pgMajor(image) !== TARGET_MAJOR) throw new Stop(`this checkout's devops/bootstrap.mjs makes the database from ${image ?? "an image it doesn't name"}, not PostgreSQL ${TARGET_MAJOR}. Update the checkout to develop/r2, or releases/r2 with fork PR #223 (git pull --ff-only, then pnpm install), then run prepare again`);
  console.log(`  ok  devops/bootstrap.mjs makes Postgres from ${image}`);
  const git = runTool("git", ["-C", REPO_ROOT, "log", "-1", "--format=%h %cs%d"]);
  if (git.status === 0) console.log(`  the checkout: ${git.stdout.trim()}`);
  if (!fs.existsSync(path.join(REPO_ROOT, "node_modules"))) console.log("  note: pnpm install hasn't run in this checkout, and connect needs it at step 32");
}

async function makeBackupFolder(ctx) {
  const { run } = ctx;
  const folder = run.backup;
  const inside = path.relative(REPO_ROOT, folder);
  if (inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside))) throw new Stop(`the backup folder ${folder} is inside the checkout, where Git doesn't ignore it: name another with --backup`);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  restrict(folder, true);
  for (const end of ["", ".secrets", ".state.json"]) {
    const from = `${run.file}${end}`;
    if (fs.existsSync(from)) console.log(`  ${keepCopy(from, path.join(folder, path.basename(from)))}`);
  }
  for (const [name, text] of Object.entries(SQL)) fs.writeFileSync(path.join(folder, name), text, { mode: 0o600 });
  console.log(`  wrote ${Object.keys(SQL).join(", ")} in ${folder}`);
  run.state.backup = folder;
}

/** Keeps a file and its folder to this computer's account: chmod, or on Windows icacls, as the step-by-step guides do. */
function restrict(target, folder = false) {
  if (process.platform !== "win32") {
    fs.chmodSync(target, folder ? 0o700 : 0o600);
    return;
  }
  const user = process.env.USERNAME;
  const result = user ? runTool("icacls", [target, "/inheritance:r", "/grant:r", `${user}:${folder ? "(OI)(CI)F" : "F"}`]) : null;
  if (result?.status !== 0) console.log(`  note: couldn't keep ${target} to your account${result ? ` (${firstLine(result)})` : ""}. Do it in its Properties > Security`);
}

/** Copies a file into the backup folder, never over another: one already there stays, and a different copy gets the time in its name. */
function keepCopy(from, to) {
  if (fs.existsSync(to)) {
    if (fs.readFileSync(to).equals(fs.readFileSync(from))) return `= ${to} is there already`;
    const stamped = `${to}.${new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}`;
    copyPrivate(from, stamped);
    return `${to} is there and differs, so this copy is ${stamped}`;
  }
  copyPrivate(from, to);
  return `copied ${from} to ${to}`;
}

function copyPrivate(from, to) {
  fs.copyFileSync(from, to);
  restrict(to);
}

async function backupDatabase(ctx) {
  const { run, old } = ctx;
  const volume = old.service("Postgres")?.volume;
  if (!volume) throw new Stop("the old Postgres has no volume to back up");
  const volumeInstanceId = volume.id;
  const list = async () => (await gql(Q.backups, { volumeInstanceId })).volumeInstanceBackupList ?? [];
  const name = `before-pg${TARGET_MAJOR}-${new Date().toISOString().slice(0, 10)}`;
  const kept = run.state.values.backup;
  let backup = (await list()).find((item) => (kept?.id ? item.id === kept.id : item.name === name));
  if (!backup) {
    console.log(`  making the backup "${name}" of the old database's volume; production keeps running`);
    const made = (await gql(Q.backupCreate, { volumeInstanceId, name })).volumeInstanceBackupCreate;
    await waitForWorkflow(made?.workflowId, "the backup", 60);
    backup = await waitUntil(5, "Railway to list the backup", async () => (await list()).filter((item) => item.name === name).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]);
  }
  run.state.values.backup = { id: backup.id, name: backup.name, createdAt: backup.createdAt, volumeInstanceId };
  if (backup.expiresAt) {
    await gql(Q.backupLock, { volumeInstanceBackupId: backup.id, volumeInstanceId });
    backup = (await list()).find((item) => item.id === backup.id) ?? backup;
  }
  if (backup.expiresAt) console.log(`  the backup "${backup.name}" is made, but Railway still gives it an end date, ${shortTime(backup.expiresAt)}: lock it by hand, in the old Postgres's Backups`);
  else console.log(`  the backup "${backup.name}", ${shortTime(backup.createdAt)}, locked: the schedule never deletes it`);
}

/** Steps 6 and 18: the old bucket into the backup folder, and for 18 the folder into the new bucket. Nothing is deleted on either side. */
async function copyBucket(ctx, intoNew) {
  const { run, old } = ctx;
  const [from] = old.buckets;
  if (!from) {
    console.log("  the old project has no bucket: nothing to copy");
    return;
  }
  const folder = path.join(run.backup, `${run.label}-files`);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const oldKeys = await bucketKeys(old, from);
  console.log(`  the old ${from.name} into ${folder}, which can take a while`);
  awsSync(`s3://${oldKeys.bucketName}`, folder, oldKeys);
  const files = folderFiles(folder);
  console.log(`  the folder has ${count(files.count, "file")}, ${bytes(files.bytes)}`);
  if (!intoNew) return bucketSays(old, from);
  const fresh = assertNew(ctx);
  const [to] = fresh.buckets;
  if (!to) throw new Stop("the new project has no bucket. bootstrap's up makes it with the Railway CLI, else says to make it by hand: do that, then run again");
  const newKeys = await bucketKeys(fresh, to);
  if (to.id === from.id || (newKeys.bucketName === oldKeys.bucketName && newKeys.endpoint === oldKeys.endpoint)) throw new Stop("the new project's bucket is the old one's, so nothing was copied into it");
  console.log(`  ${folder} into the new ${to.name}`);
  awsSync(folder, `s3://${newKeys.bucketName}`, newKeys);
  await bucketSays(fresh, to);
}

async function bucketKeys(where, bucket) {
  const list = (await gql(Q.bucketKeys, { bucketId: bucket.id, environmentId: where.environment.id, projectId: where.project.id })).bucketS3Credentials ?? [];
  const keys = list.find((item) => item?.accessKeyId && item.secretAccessKey && item.bucketName && item.endpoint);
  if (!keys) throw new Stop(`Railway gave no keys for the ${where.which} bucket, ${bucket.name}`);
  hide(keys.accessKeyId);
  hide(keys.secretAccessKey);
  return keys;
}

/** aws s3 sync with one bucket's keys, given to it through its environment only, as guide 7.7 sets the AWS CLI up for Railway. */
function awsSync(from, to, keys) {
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: keys.accessKeyId,
    AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
    AWS_DEFAULT_REGION: keys.region || "auto",
    AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED",
  };
  // A profile or session token of this computer's would be sent with the bucket's keys.
  for (const name of ["AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE"]) delete env[name];
  const result = runTool("aws", ["s3", "sync", from, to, "--endpoint-url", keys.endpoint, "--only-show-errors", "--no-progress"], { env, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`aws s3 sync stopped: ${firstLine(result)}`);
}

function folderFiles(folder) {
  let found = 0;
  let size = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        found += 1;
        size += fs.statSync(full).size;
      }
    }
  };
  walk(folder);
  return { count: found, bytes: size };
}

async function bucketSays(where, bucket) {
  const details = await attempt(() => gql(Q.bucket, { bucketId: bucket.id, environmentId: where.environment.id }));
  const said = details?.bucketInstanceDetails;
  if (said) console.log(`  Railway says the ${where.which} ${bucket.name} has ${count(Number(said.objectCount), "file")}, ${bytes(said.sizeBytes)}; its count can lag a few minutes`);
}

async function keepNotes(ctx) {
  const { run, old, fresh } = ctx;
  await notes(run, old, fresh);
  if (run.state.values.noted?.project !== old.project.id) throw new Stop("the notes for going back weren't kept (above)");
}

async function copySettings(ctx) {
  const { run } = ctx;
  for (const end of ["", ".secrets", ".state.json"]) {
    const from = `${run.file}${end}`;
    const to = `${run.file}${COPY_SUFFIX}${end}`;
    if (fs.existsSync(to)) console.log(`  = kept ${to}, which exists`);
    else if (fs.existsSync(from)) {
      copyPrivate(from, to);
      console.log(`  copied ${from} to ${to}`);
    }
  }
  reloadCopy(run);
}

async function temporaryAddress(ctx) {
  const { run } = ctx;
  const temporary = temporaryHost(run);
  const zone = String(run.settings.CLOUDFLARE_ZONE ?? "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(temporary)) throw new Stop(`${temporary} isn't an address such as app-new.example.com`);
  if (temporary === run.host || run.host.endsWith(`.${temporary}`) || temporary === zone) throw new Stop(`the temporary address must be a name of its own, not ${temporary}: give one with --temporary`);
  if (zone && !temporary.endsWith(`.${zone}`)) throw new Stop(`${temporary} isn't in CLOUDFLARE_ZONE (${zone}), where bootstrap writes its CNAME: give one that is, with --temporary`);
  if (settingsHost(run.copy.settings) !== temporary || "CUSTOM_HOST" in run.copy.settings) {
    setAddress(run.copy.file, `https://${temporary}`);
    reloadCopy(run);
  }
  console.log(`  ${run.copy.file}: APP_BASE_URL=https://${temporary}, and no CUSTOM_HOST`);
  run.state.values.temporary = temporary;
}

/** Sets APP_BASE_URL in a settings file and takes out CUSTOM_HOST, its older name, leaving every other line as it is. */
function setAddress(file, url) {
  const text = fs.readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out = [];
  let set = false;
  for (const line of text.split(/\r?\n/)) {
    const key = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim())?.[1];
    if (key === "CUSTOM_HOST") continue;
    if (key === "APP_BASE_URL") {
      if (!set) out.push(`APP_BASE_URL=${url}`);
      set = true;
      continue;
    }
    out.push(line);
  }
  if (!set) out.splice(out.at(-1) === "" ? out.length - 1 : out.length, 0, `APP_BASE_URL=${url}`);
  fs.writeFileSync(file, out.join(eol));
}

async function renameOld(ctx) {
  const { run, old } = ctx;
  if (old.project.name !== projectName(run)) console.log(`  = the old project is named "${old.project.name}" already`);
  else {
    const name = oldName(ctx);
    await gql(Q.rename, { id: old.project.id, name });
    old.project.name = name;
    console.log(`  the old project is now "${name}"`);
  }
  run.state.values.oldName = old.project.name;
  await checkNameFree(ctx);
}

/**
 * Before bootstrap runs on the copy: it finds the project by its name, so the old project mustn't have that name any
 * more, and no other project but the new one may have it. Otherwise up would build into that project.
 */
async function checkNameFree(ctx, { quiet = false } = {}) {
  const { run } = ctx;
  const name = projectName(run);
  const recorded = run.copy?.values?.RAILWAY_PROJECT_ID;
  const allowed = recorded && recorded !== run.old.RAILWAY_PROJECT_ID ? recorded : null;
  const { project } = await gql(Q.project, { id: run.old.RAILWAY_PROJECT_ID });
  if (project?.name === name) throw new Stop(`the old project still has the name "${name}", which up finds the new project by: it would build into production. Rename the old project (step 10), then run again`);
  const named = new Set();
  for (const workspaceId of new Set([run.settings.RAILWAY_WORKSPACE_ID || null, project?.workspaceId || null])) {
    const { projects } = await gql(Q.projects, { workspaceId });
    for (const { node } of projects.edges) if (node.name === name && !node.deletedAt && node.id !== allowed) named.add(node.id);
  }
  if (named.size) throw new Stop(`Railway has ${named.size === 1 ? "a project" : `${named.size} projects`} named "${name}" (${[...named].join(", ")}), which up would build into. Rename ${named.size === 1 ? "it" : "them"}, then run again`);
  if (!quiet) console.log(allowed ? `  ok  only the new project has the name "${name}"` : `  ok  no project has the name "${name}" now, which up gives the new one`);
}

// Steps of bootstrap's that act at OpenAI, Twilio, Resend and Polar: the copy's state file must keep them done.
const PROVIDER_STEP = /^(openai|twilio|resend|polar)\./;

async function forgetOld(ctx) {
  const { run } = ctx;
  reloadCopy(run);
  const id = run.copy.values.RAILWAY_PROJECT_ID;
  if (!id) return console.log("  = the copy names no project already");
  if (id !== run.old.RAILWAY_PROJECT_ID) return console.log(`  = the copy names the new project, ${id}: this never runs again`);
  // Without an address, redo would also take twilio.tollfree off, and up would point production's texts at the new project.
  if (!settingsHost(run.copy.settings)) throw new Stop(`${run.copy.file} has no APP_BASE_URL (step 9)`);
  await checkNameFree(ctx, { quiet: true });
  const result = bootstrap(["redo", run.copy.file, "railway.project"], { capture: true });
  for (const line of result.output.split(/\r?\n/).filter(Boolean)) console.log(`  | ${line}`);
  if (result.status !== 0) throw new Stop(`bootstrap's redo stopped (exit code ${result.status})`);
  reloadCopy(run);
  if (run.copy.values.RAILWAY_PROJECT_ID) throw new Stop(`${run.copy.file}.state.json still names a project after redo`);
  providerStepsKept(run);
}

/** The copy's state file still marks every OpenAI, Twilio, Resend and Polar step the original's has done, so up repeats none. */
function providerStepsKept(run) {
  const original = readBootstrapState(run.file).done;
  const lost = Object.keys(original).filter((key) => PROVIDER_STEP.test(key) && !run.copy.done[key]);
  if (lost.length) throw new Stop(`${run.copy.file}.state.json no longer marks ${lost.join(", ")} done, so up would do ${lost.length === 1 ? "it" : "them"} again outside Railway. Don't run up on the copy: make the copy again from the original files (delete the three ${COPY_SUFFIX} files, and steps 8 to 11 in ${run.stateFile})`);
}

async function checkCopy(ctx) {
  const { run } = ctx;
  providerStepsKept(run);
  await checkNameFree(ctx, { quiet: true });
  if (bootstrap(["doctor", run.copy.file]).status !== 0) throw new Stop(`bootstrap's doctor found something to fix in the copy (above). Fix it in ${run.copy.file} or its .secrets file, then run prepare again`);
  if (bootstrap(["up", run.copy.file, "--dry-run"]).status !== 0) throw new Stop("bootstrap's up --dry-run stopped (above)");
  console.log(`\n  The dry run above builds a new project named "${projectName(run)}" at ${temporaryHost(run)}. Every OpenAI, Twilio, Resend and Polar step stays done in the copy's state file, so up does none of them.`);
}

async function buildNew(ctx) {
  const { run } = ctx;
  providerStepsKept(run);
  await checkNameFree(ctx, { quiet: true });
  const up = bootstrap(["up", run.copy.file]);
  reloadCopy(run);
  if (up.status !== 0) throw new Stop("bootstrap's up stopped (above). Do what it says, then run prepare again: up carries on where it stopped");
  const id = run.copy.values.RAILWAY_PROJECT_ID;
  if (!id || id === run.old.RAILWAY_PROJECT_ID) throw new Stop(`up finished, but ${run.copy.file}.state.json names ${id ? "the old project" : "no project"}`);
  ctx.fresh = await readProject(run.copy.values, "new");
  await loadDomains(ctx.fresh);
  console.log(`  the new project: "${ctx.fresh.project.name}" (${id})`);
}

/** Runs devops/bootstrap.mjs: what it prints goes to the terminal, and the person answers its questions there. */
function bootstrap(args, { capture = false } = {}) {
  return child(BOOTSTRAP, args, capture);
}

function child(script, args, capture = false) {
  handOver();
  logOnly(`ran: node ${path.basename(script)} ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, RAILWAY_API_TOKEN: railwayToken },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`couldn't run ${script}: ${result.error.message}`);
  logOnly(`  exit code ${result.status}`);
  return { status: result.status, output: capture ? redact(`${result.stdout ?? ""}${result.stderr ?? ""}`) : "" };
}

async function backupCopy(ctx, name) {
  const { run } = ctx;
  const folder = path.join(run.backup, name);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const end of ["", ".secrets", ".state.json"]) {
    const from = `${run.copy.file}${end}`;
    if (fs.existsSync(from)) copyPrivate(from, path.join(folder, path.basename(from)));
  }
  console.log(`  copied the three ${COPY_SUFFIX} files to ${folder}`);
}

async function checkNew(ctx) {
  const { run, old } = ctx;
  assertNew(ctx);
  // The control panel's two services only where the old project has them.
  const wanted = RUNNING.filter((role) => !["control", "cloudflared"].includes(role) || old.service(role));
  let fresh;
  await waitUntil(20, "every new service to be running and migrate to be done", async () => {
    fresh = await readProject(run.copy.values, "new");
    const states = wanted.map((role) => [role, fresh.service(role) ? fresh.service(role).instance?.latestDeployment?.status ?? "none" : "missing"]);
    const failed = states.filter(([, state]) => ["missing", "FAILED", "CRASHED", "REMOVED"].includes(state));
    if (failed.length) throw new Stop(`the new ${failed.map(([role, state]) => `${role} is ${String(state).toLowerCase()}`).join(", ")}: see its deployment in Railway, fix it, then run prepare again`);
    return states.every(([, state]) => state === "SUCCESS");
  });
  console.log(`  ok  ${wanted.join(", ")}: running, and migrate done`);
  const postgres = fresh.service("Postgres");
  const image = postgres.instance?.source?.image;
  if (pgMajor(image) !== TARGET_MAJOR) throw new Stop(`the new Postgres runs ${image}, not PostgreSQL ${TARGET_MAJOR}`);
  const logs = await attempt(() => gql(Q.logs, { deploymentId: postgres.instance.latestDeployment.id, filter: "PostgreSQL", limit: 50 }));
  const said = (logs?.deploymentLogs ?? []).map((item) => String(item.message)).find((message) => /PostgreSQL \d+\.\d+/.test(message));
  const major = Number(said?.match(/PostgreSQL (\d+)\./)?.[1]);
  if (said && major !== TARGET_MAJOR) throw new Stop(`the new Postgres's log says PostgreSQL ${major}`);
  console.log(`  ok  the new Postgres runs ${image}${said ? `, and its log says PostgreSQL ${major}` : ""}`);
  const temporary = temporaryHost(run);
  await waitUntil(15, `https://${temporary}/api/health/ready to answer "ok":true (Railway gives the address its certificate a few minutes after up)`, async () => (await health(temporary, "/api/health/ready")).body?.ok === true);
  console.log(`  ok  https://${temporary}/api/health/ready answers "ok":true. Don't sign up there: the cutover replaces its data`);
  ctx.fresh = fresh;
  await loadDomains(fresh);
}

async function health(host, pathname) {
  try {
    const response = await fetch(`${SITE_URL.replace("{host}", host)}${pathname}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: parseJson(await response.text()) };
  } catch (error) {
    return { error: error.cause?.code ?? error.message };
  }
}

async function copyVariables(ctx) {
  const { run, old } = ctx;
  const fresh = assertNew(ctx);
  const comparison = await compareVariables(run, old, fresh);
  printComparison(run, comparison);
  const unread = comparison.roles.filter((item) => item.error);
  if (unread.length) throw new Stop(`the variables of ${unread.map((item) => item.role).join(", ")} couldn't be read`);
  if (comparison.webhook === "differs") {
    replaceSecret(`${run.copy.file}.secrets`, "OPENAI_WEBHOOK_SECRET", comparison.roles.find((item) => item.role === "admin").oldValues.OPENAI_WEBHOOK_SECRET);
    console.log(`  OPENAI_WEBHOOK_SECRET in ${run.copy.file}.secrets is the old admin's now, which connect puts on the new admin (step 32)`);
    // R1 puts the files back from after-stage-1 (step 14): they must hold this value too.
    await backupCopy(ctx, "after-stage-1");
  }
  const keys = comparison.roles.filter((item) => item.keys?.length);
  if (keys.length) await confirm(`\n  The old project has other values than the copy's files for ${keys.map((item) => `${item.keys.join(", ")} on the ${item.role}`).join("; ")}. Each variables run puts the files' values back, so the new project keeps the files' values unless you bring the files up to date first (devops/redeploy.md, step 16). Keep the files' values?`);
  for (const item of comparison.roles) {
    const names = [...(item.connect ?? []), ...(item.byHand ?? [])];
    if (!names.length) continue;
    const variables = Object.fromEntries(names.map((name) => [name, String(item.oldValues[name])]));
    await gql(Q.upsert, { input: { projectId: fresh.project.id, environmentId: fresh.environment.id, serviceId: item.newService.id, variables } });
    console.log(`  copied to the new ${item.role}: ${names.join(", ")}. Railway deploys it again with them`);
  }
  const after = await compareVariables(run, old, fresh);
  const left = after.roles.filter((item) => item.connect?.length || item.byHand?.length);
  if (left.length) throw new Stop(`Railway doesn't show ${left.map((item) => `${[...item.connect, ...item.byHand].join(", ")} on the new ${item.role}`).join("; ")} yet. Run prepare again`);
  const sealed = after.roles.filter((item) => item.sealed?.length);
  if (sealed.length) console.log(`  Compare by hand, since Railway shows no value of a sealed variable: ${sealed.map((item) => `${item.sealed.join(", ")} on the ${item.role}`).join("; ")}`);
}

/** Puts a value on a key's one line in a secrets file, leaving the other lines as they are. */
function replaceSecret(file, key, value) {
  const text = fs.readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let found = 0;
  const lines = text.split(/\r?\n/).map((line) => {
    if (/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim())?.[1] !== key) return line;
    found += 1;
    return `${key}=${value}`;
  });
  if (found !== 1) throw new Stop(`${file} has ${found} ${key} lines: put the old admin's value on one, by hand`);
  fs.writeFileSync(file, lines.join(eol), { mode: 0o600 });
}

async function stopNewTunnel(ctx) {
  const { run } = ctx;
  const fresh = assertNew(ctx);
  const tunnel = fresh.service("cloudflared");
  if (!tunnel) return console.log("  the deployment has no control panel, so no cloudflared: nothing to stop");
  const deployment = tunnel.instance?.latestDeployment;
  if (!deployment || ["REMOVED", "REMOVING"].includes(deployment.status)) return console.log("  = the new cloudflared is stopped already");
  await gql(Q.removeDeployment, { id: deployment.id });
  await waitUntil(3, "Railway to stop the new cloudflared", async () => {
    const now = (await readProject(run.copy.values, "new")).service("cloudflared")?.instance?.latestDeployment;
    return !now || now.status === "REMOVED";
  });
  console.log("  the new cloudflared is stopped: the control panel's address answers from the old project until the switch");
}

// ---------------------------------------------------------------- trial (steps 18 to 20)

function checkTrial(ctx) {
  const { run, fresh } = ctx;
  const next = PREPARE.find((step) => !run.state.done[step.n]);
  if (next) throw new Stop(`prepare hasn't finished: step ${next.n} is next. Run prepare first`);
  assertNew(ctx);
  if (hasAddress(fresh, run.host)) throw new Stop(`the new project has ${run.host} already: trial is for before the cutover`);
  if (!run.state.done["19"] && !options.noRehearsal) rehearsal(run);
}

function trialChanges(ctx, todo) {
  const { run } = ctx;
  const lines = [];
  if (todo.has("18") && ctx.old.buckets.length) lines.push(`copy the old bucket's files into the new bucket, through ${path.join(run.backup, `${run.label}-files`)} (step 18)`);
  if (todo.has("19") && !options.noRehearsal) lines.push(`add ${rehearsal(run).name} to the old admin with its records in Cloudflare, move it to the new admin, then remove it and its records; ${run.host} isn't touched (step 19)`);
  if (todo.has("20")) lines.push("open each database to the internet through a TCP proxy, dump production while it runs, restore the dump into lobbystack_trial on the new server and count both, then drop lobbystack_trial, delete the dump and close the proxies it opened (step 20)");
  lines.push("Production keeps running throughout.");
  return lines;
}

/** Step 19's throwaway name, and what writing its records in Cloudflare needs. */
function rehearsal(run) {
  const zone = String(run.settings.CLOUDFLARE_ZONE ?? "").toLowerCase();
  const name = hostOf(options.rehearse) || (zone ? `move-test.${zone}` : "");
  if (!name) throw new Stop("step 19 needs a throwaway address in the deployment's zone, and the settings name no CLOUDFLARE_ZONE. Rehearse by hand (devops/redeploy.md, step 19), then run trial with --no-rehearsal");
  const taken = [run.host, run.state.values.temporary, hostOf(run.settings.CONTROL_HOST), hostOf(run.old.CONTROL_HOST), zone].filter(Boolean);
  if (taken.includes(name) || taken.some((host) => host.endsWith(`.${name}`))) throw new Stop(`${name} is the deployment's own: give a throwaway name with --rehearse`);
  if (!zone || !name.endsWith(`.${zone}`)) throw new Stop(`${name} isn't in CLOUDFLARE_ZONE (${zone || "none"}), where the script writes its records. Give one that is with --rehearse, or rehearse by hand and use --no-rehearsal`);
  const token = secretOf(run, "CLOUDFLARE_API_TOKEN");
  if (!token) throw new Stop("step 19 writes the throwaway name's records in Cloudflare, and there's no CLOUDFLARE_API_TOKEN in the environment or the secrets files. Add it, or rehearse by hand and use --no-rehearsal");
  return { name, zone, token };
}

const REHEARSAL_NOTE = "redeploy.mjs step 19, a throwaway name";

/** Step 19: a throwaway name added to the old admin, moved to the new one, timed both times, then removed with its records. */
async function rehearseAddress(ctx) {
  const { run, old } = ctx;
  const fresh = assertNew(ctx);
  if (options.noRehearsal) return console.log("  left out (--no-rehearsal)");
  const { name, zone, token } = rehearsal(run);
  const zoneId = await cloudflareZone(token, zone);
  const sides = [["old", old], ["new", fresh]];
  const made = new Set();
  const seconds = {};
  try {
    // A run that stopped halfway may have left the name on an admin.
    for (const [, where] of sides) await removeName(where, name);
    const free = async () => (await gql(Q.domainAvailable, { domain: name })).customDomainAvailable ?? {};
    const available = await free();
    if (available.available === false) throw new Stop(`Railway says ${name} isn't free (${available.message || "no reason given"}): give another with --rehearse`);
    for (const [which, where] of sides) {
      const admin = where.service("admin");
      if (which === "new") {
        // How soon a name taken off one project is free for another is part of what the address move takes.
        const started = Date.now();
        await waitUntil(5, `${name} to be free in Railway again`, async () => (await free()).available !== false);
        seconds.free = Math.round((Date.now() - started) / 1000);
      }
      await gql(Q.domainCreate, { input: { domain: name, environmentId: where.environment.id, projectId: where.project.id, serviceId: admin.id, targetPort: 3000 } });
      const records = await waitUntil(2, `Railway's DNS records for ${name}`, async () => {
        const list = recordsOf(await domainOn(where, name), name);
        return list.length ? list : null;
      });
      await putRecords(token, zoneId, name, records, made);
      const started = Date.now();
      await waitUntil(15, `Railway to verify ${name} on the ${which} admin`, async () => (await domainOn(where, name))?.status?.verified === true);
      seconds[which] = Math.round((Date.now() - started) / 1000);
      console.log(`  ${name}: verified on the ${which} admin after ${duration(seconds[which])}`);
      await removeName(where, name);
    }
  } finally {
    for (const [which, where] of sides) {
      const left = await attempt(() => removeName(where, name));
      if (left?.error) console.log(`  couldn't remove ${name} from the ${which} admin (${left.error}): remove it by hand, in its Settings > Networking`);
    }
    for (const id of made) {
      const gone = await attempt(() => cloudflare(token, `/zones/${zoneId}/dns_records/${id}`, { method: "DELETE" }));
      if (gone?.error) console.log(`  couldn't delete a record of ${name} in Cloudflare (${gone.error}): delete it by hand`);
    }
    if (made.size) console.log(`  deleted ${name}'s records in Cloudflare`);
  }
  run.state.values.rehearsal = { name, ...seconds };
  console.log(`  Railway took ${duration(seconds.new)} to verify the name on the new admin: the address move at step 30 takes about as long, while production is offline`);
}

async function domainOn(where, name) {
  const admin = where.service("admin");
  const { domains } = await gql(Q.domains, { projectId: where.project.id, environmentId: where.environment.id, serviceId: admin.id });
  return domains.customDomains.find((item) => item.domain === name) ?? null;
}

async function removeName(where, name) {
  const found = await domainOn(where, name);
  if (found) await gql(Q.domainDelete, { id: found.id });
  return found;
}

/**
 * The records Railway asks for an address, as Cloudflare names them: the CNAME, and until the address is verified, the
 * TXT record that proves it's ours, which Railway names relative to the zone's apex, as bootstrap.mjs reads it.
 */
function recordsOf(domain, host) {
  const list = (domain?.status?.dnsRecords ?? []).filter((record) => record.fqdn && record.requiredValue)
    .map((record) => ({ type: String(record.recordType).replace("DNS_RECORD_TYPE_", ""), name: String(record.fqdn).replace(/\.$/, "").toLowerCase(), content: String(record.requiredValue) }));
  const { verified, verificationDnsHost, verificationToken } = domain?.status ?? {};
  const check = String(verificationDnsHost ?? "").toLowerCase().replace(/\.$/, "");
  const rest = check.replace(/^_railway-verify\.?/, "");
  const name = check === host || check.endsWith(`.${host}`) ? check : check.startsWith("_railway-verify") && (!rest || host.startsWith(`${rest}.`)) ? `_railway-verify.${host}` : check;
  if (!verified && name && verificationToken && !list.some((record) => record.type === "TXT" && record.name === name)) {
    list.push({ type: "TXT", name, content: `railway-verify=${String(verificationToken).replace(/^(railway-verify=)+/, "")}` });
  }
  return list;
}

/** Writes the throwaway name's records, DNS only. A record of that name this script didn't make stops it. */
async function putRecords(token, zoneId, name, records, made) {
  for (const record of records) {
    if (record.name !== name && !record.name.endsWith(`.${name}`)) throw new Stop(`Railway asked for a record of ${record.name}, which isn't ${name}'s, so it wasn't written`);
    const existing = ((await cloudflare(token, `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`)) ?? []).filter((item) => item.name === record.name);
    const theirs = existing.filter((item) => !made.has(item.id) && item.comment !== REHEARSAL_NOTE);
    if (theirs.length) throw new Stop(`Cloudflare already has ${record.type} ${record.name}, which this script didn't make: give another name with --rehearse`);
    const body = { type: record.type, name: record.name, content: record.content, ttl: 1, proxied: false, comment: REHEARSAL_NOTE };
    if (existing[0]) {
      made.add(existing[0].id);
      await cloudflare(token, `/zones/${zoneId}/dns_records/${existing[0].id}`, { method: "PATCH", body });
    } else made.add((await cloudflare(token, `/zones/${zoneId}/dns_records`, { method: "POST", body })).id);
    console.log(`  Cloudflare: ${record.type} ${record.name}  ${record.content}`);
  }
}

async function cloudflareZone(token, zone) {
  const zones = await cloudflare(token, `/zones?name=${encodeURIComponent(zone)}`);
  if (!zones?.length) throw new Stop(`the Cloudflare token can't see the zone ${zone}`);
  return zones[0].id;
}

/** Step 20: production dumped while it runs, restored into lobbystack_trial on the new server, both counted, then cleaned up. */
async function trialCopy(ctx) {
  const { run, old } = ctx;
  const fresh = assertNew(ctx);
  const password = databasePassword(run);
  dockerReady();
  const opened = [];
  const dumpFile = path.join(run.backup, "trial.dump");
  let servers = null;
  let made = false;
  try {
    const onOld = await openProxy(run, old, opened);
    const onNew = await openProxy(run, fresh, opened);
    servers = checkServers(run, password, onOld, onNew);
    const before = tally(run, password, onOld, "lobbystack");
    console.log(`  old: ${before.line}`);
    let started = Date.now();
    console.log("  dumping production into the backup folder, while it runs");
    pgOrStop(run, password, ["pg_dump", ...at(onOld), "-d", "lobbystack", "-Fc", "-f", "trial.dump.part"], "pg_dump");
    fs.renameSync(`${dumpFile}.part`, dumpFile);
    const dumpSeconds = Math.round((Date.now() - started) / 1000);
    const dumpBytes = fs.statSync(dumpFile).size;
    console.log(`  the dump: ${bytes(dumpBytes)} in ${duration(dumpSeconds)}`);
    sameServer(run, password, onNew, servers.new);
    pgOrStop(run, password, ["dropdb", ...at(onNew), "--if-exists", "lobbystack_trial"], "dropdb");
    pgOrStop(run, password, ["createdb", ...at(onNew), "lobbystack_trial"], "createdb");
    made = true;
    started = Date.now();
    console.log("  restoring it into lobbystack_trial on the new server");
    pgOrStop(run, password, ["pg_restore", ...at(onNew), "-d", "lobbystack_trial", "-O", "-1", "-e", "trial.dump"], "pg_restore");
    const restoreSeconds = Math.round((Date.now() - started) / 1000);
    const after = tally(run, password, onNew, "lobbystack_trial");
    console.log(`  RESTORE OK in ${duration(restoreSeconds)}`);
    console.log(`  trial: ${after.line}`);
    if (before.tables !== after.tables) {
      console.log(`  The number of tables differs. Lines only the old database has (<) or only the trial copy has (>):`);
      const a = tableLines(run, password, onOld, "lobbystack");
      const b = tableLines(run, password, onNew, "lobbystack_trial");
      for (const line of a.filter((item) => !b.includes(item))) console.log(`    < ${line}`);
      for (const line of b.filter((item) => !a.includes(item))) console.log(`    > ${line}`);
      throw new Stop("the trial copy has other tables than production. Find out why before the cutover");
    }
    console.log(before.fingerprint === after.fingerprint ? "  SAME: the trial copy has every table, with the same rows" : `  the same tables; ${count(Math.abs(after.rows - before.rows), "row")} apart, since production kept writing during the dump`);
    printHours(run, password, onOld);
    run.state.values.trial = { at: new Date().toISOString(), dumpSeconds, restoreSeconds, dumpBytes, tables: before.tables, rows: before.rows };
    console.log(`  On the day, the dump and the restore should take about ${duration(dumpSeconds + restoreSeconds)}, while production is offline`);
  } finally {
    if (made && servers) {
      const dropped = await attempt(async () => {
        const onNew = (await liveProxies(fresh))[0];
        if (!onNew) throw new Error("its TCP proxy is gone");
        sameServer(run, password, onNew, servers.new);
        pgOrStop(run, password, ["dropdb", ...at(onNew), "--if-exists", "lobbystack_trial"], "dropdb");
      });
      console.log(dropped?.error ? `  couldn't drop lobbystack_trial (${dropped.error}): drop it on the new server by hand` : "  dropped lobbystack_trial");
    }
    for (const file of [dumpFile, `${dumpFile}.part`]) fs.rmSync(file, { force: true });
    for (const where of opened) {
      const closed = await attempt(() => closeProxy(run, where));
      if (closed?.error) console.log(`  couldn't close the ${where.which} database's TCP proxy (${closed.error}): delete it by hand, in Postgres > Settings > Networking`);
    }
  }
}

/** The database password, from both state files, which must hold the same one: the copy's came from the original. */
function databasePassword(run) {
  const a = run.old.POSTGRES_PASSWORD;
  const b = run.copy ? readBootstrapState(run.copy.file).values.POSTGRES_PASSWORD : undefined;
  if (!a || !b) throw new Stop(`${!a ? `${run.file}.state.json` : `${run.copy?.file}.state.json`} has no POSTGRES_PASSWORD`);
  if (a !== b) throw new Stop("the two state files hold different database passwords. The copy's must be the original's (step 8)");
  return hide(a);
}

function dockerReady() {
  const docker = runTool("docker", ["image", "inspect", `postgres:${TARGET_MAJOR}`, "--format", "{{.Id}}"]);
  if (docker.status !== 0) throw new Stop(missingTool(docker) ? "no Docker on this computer (step 1)" : `Docker isn't running, or has no postgres:${TARGET_MAJOR} image: start Docker Desktop (step 2)`);
}

/** One of PostgreSQL 18's tools in Docker, as postgres, in the backup folder. The password reaches it through the environment only. */
function pg(run, password, args) {
  const result = runTool("docker", ["run", "--rm", "-e", "PGPASSWORD", "-e", "PGUSER=postgres", "-e", "PGCONNECT_TIMEOUT=20", "-v", `${run.backup}:/backup`, "-w", "/backup", `postgres:${TARGET_MAJOR}`, ...args], {
    env: { ...process.env, PGPASSWORD: password },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`docker didn't start: ${result.error.message}`);
  return result;
}

function pgOrStop(run, password, args, what) {
  const result = pg(run, password, args);
  if (result.status !== 0) throw new Stop(`${what} failed: ${redact(`${result.stderr || result.stdout}`.trim().split(/\r?\n/).slice(0, 5).join(" | ")) || `exit code ${result.status}`}`);
  return result.stdout;
}

const at = (proxy) => ["-h", proxy.domain, "-p", String(proxy.proxyPort)];

/** A server's PostgreSQL version and its system identifier, which tells two servers apart. */
function serverOf(run, password, proxy, which) {
  const result = pg(run, password, ["psql", "-X", ...at(proxy), "-d", "postgres", "-Atc", "select current_setting('server_version_num') || ' ' || system_identifier from pg_control_system()"]);
  if (result.status !== 0) throw new Stop(`couldn't sign in to the ${which} database through ${proxy.domain}:${proxy.proxyPort}: ${redact(firstLine(result))}`);
  const [number, id] = result.stdout.trim().split(/\s+/);
  return { major: Math.floor(Number(number) / 10_000), id };
}

function checkServers(run, password, onOld, onNew) {
  const servers = { old: serverOf(run, password, onOld, "old"), new: serverOf(run, password, onNew, "new") };
  console.log(`  old: PostgreSQL ${servers.old.major}, new: PostgreSQL ${servers.new.major}`);
  if (servers.old.id === servers.new.id) throw new Stop("both TCP proxies reach the same server, so nothing was copied");
  if (servers.new.major !== TARGET_MAJOR) throw new Stop(`the new server runs PostgreSQL ${servers.new.major}, not ${TARGET_MAJOR}, so nothing was copied`);
  if (servers.old.major === TARGET_MAJOR && !options.sameVersion) throw new Stop(`the old server runs PostgreSQL ${TARGET_MAJOR} already. To rehearse on it anyway, add --same-version`);
  return servers;
}

/** Before each change on the new server: still the server checked first, still on PostgreSQL 18. */
function sameServer(run, password, proxy, expected) {
  const now = serverOf(run, password, proxy, "new");
  if (now.id !== expected.id || now.major !== TARGET_MAJOR) throw new Stop("the new database's address no longer reaches the server checked at the start, so nothing was changed there");
}

function tally(run, password, proxy, database) {
  const line = pgOrStop(run, password, ["psql", "-X", ...at(proxy), "-d", database, "-At", "-f", "count.sql"], `the count of ${database}`).trim();
  const match = /tables (\d+), rows (\d+), fingerprint (\w+)/.exec(line);
  if (!match) throw new Stop(`the count of ${database} printed "${line}"`);
  return { line, tables: Number(match[1]), rows: Number(match[2]), fingerprint: match[3] };
}

function tableLines(run, password, proxy, database) {
  return pgOrStop(run, password, ["psql", "-X", ...at(proxy), "-d", database, "-At", "-f", "tables.sql"], `the tables of ${database}`).trim().split(/\r?\n/).filter(Boolean);
}

/** For step 21: production's calls in each hour of the day over four weeks, in this computer's time zone. */
function printHours(run, password, proxy) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const result = pg(run, password, ["psql", "-X", ...at(proxy), "-d", "lobbystack", "-At", "-v", `tz=${zone}`, "-f", "hours.sql"]);
  if (result.status !== 0) return console.log(`  calls by hour: unknown (${redact(firstLine(result))})`);
  const calls = new Map(result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(" ")).map(([hour, n]) => [hour, Number(n)]));
  const hours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
  const fewest = Math.min(...hours.map((hour) => calls.get(hour) ?? 0));
  console.log(`  For step 21, calls in each hour over the last four weeks (${zone}):`);
  for (let row = 0; row < 24; row += 8) console.log(`    ${hours.slice(row, row + 8).map((hour) => `${hour}h ${String(calls.get(hour) ?? 0).padStart(5)}`).join("  ")}`);
  const quiet = hours.filter((hour) => (calls.get(hour) ?? 0) === fewest).map((hour) => `${hour}h`);
  console.log(`    fewest, ${fewest}: ${quiet.slice(0, 8).join(", ")}${quiet.length > 8 ? `, and ${quiet.length - 8} more` : ""}`);
}

const liveProxies = async (where) => ((await gql(Q.tcpProxies, { environmentId: where.environment.id, serviceId: where.service("Postgres").id })).tcpProxies ?? []).filter((item) => !item.deletedAt);

// A TCP proxy is set in the environment's settings, without a deploy, so the database doesn't restart.
const proxyPatch = (serviceId, value) => ({ services: { [serviceId]: { networking: { tcpProxies: { 5432: value } } } } });

/**
 * A database's TCP proxy: the one it has, else a new one. One this script opened, in this run or in one that was
 * interrupted, as the state file records, goes into opened, to be closed again; one opened by hand stays. quiet leaves
 * out the line about one that's there already, for the cutover's steps after step 22, which opened it.
 */
async function openProxy(run, where, opened, { quiet = false } = {}) {
  const mine = (run.state.values.proxies ??= []);
  const ready = async () => (await liveProxies(where)).find((item) => item.domain && item.proxyPort) ?? null;
  const existing = await ready();
  if (existing) {
    if (mine.includes(where.which)) opened.push(where);
    if (!quiet) console.log(`  the ${where.which} database's TCP proxy is there already${mine.includes(where.which) ? ", left open by an earlier run of this script" : ""}: ${existing.domain}:${existing.proxyPort}`);
    return existing;
  }
  const workflow = (await gql(Q.patch, { environmentId: where.environment.id, patch: proxyPatch(where.service("Postgres").id, {}), commitMessage: "redeploy.mjs: a TCP proxy for the database copy", skipDeploys: true })).environmentPatchCommit;
  opened.push(where);
  if (!mine.includes(where.which)) mine.push(where.which);
  keepState(run);
  await waitForWorkflow(workflow, `the ${where.which} database's TCP proxy`, 5);
  const proxy = await waitUntil(5, `Railway to open the ${where.which} database's TCP proxy (if it never does, add it by hand: Postgres > Settings > Networking > TCP Proxy, port 5432, then run again)`, ready);
  console.log(`  opened the ${where.which} database to the internet: ${proxy.domain}:${proxy.proxyPort}`);
  return proxy;
}

async function closeProxy(run, where) {
  const workflow = (await gql(Q.patch, { environmentId: where.environment.id, patch: proxyPatch(where.service("Postgres").id, null), commitMessage: "redeploy.mjs: the TCP proxy closed", skipDeploys: true })).environmentPatchCommit;
  await waitForWorkflow(workflow, `closing the ${where.which} database's TCP proxy`, 5);
  for (const proxy of await liveProxies(where)) await gql(Q.proxyDelete, { id: proxy.id });
  await waitUntil(3, `Railway to close the ${where.which} database's TCP proxy`, async () => !(await liveProxies(where)).length);
  run.state.values.proxies = (run.state.values.proxies ?? []).filter((which) => which !== where.which);
  keepState(run);
  console.log(`  closed the ${where.which} database's TCP proxy`);
}

// ---------------------------------------------------------------- finish (steps 35 to 39)

function checkFinish(ctx) {
  const { run, old, fresh } = ctx;
  assertNew(ctx);
  if (run.state.values.backPath) throw new Stop("going back stopped halfway: run back again to finish it");
  // A cutover this script ran must have finished and passed its checks. One done by hand recorded nothing here.
  const next = [...CUTOVER, ...CHECK].find((step) => !run.state.done[step.n]);
  if (next && CUTOVER.some((step) => run.state.done[step.n])) throw new Stop(CHECK.includes(next) ? "the cutover's checks haven't passed yet: run check (step 34)" : `the cutover hasn't finished: step ${next.n} is next. Run cutover`);
  if (!hasAddress(fresh, run.host)) throw new Stop(`the new admin doesn't have ${run.host} yet: finish comes after the cutover (steps 22 to 34)`);
  if (hasAddress(old, run.host)) throw new Stop(`the old admin still has ${run.host}`);
}

function finishChanges(ctx, todo) {
  const { run } = ctx;
  const copies = run.state.values.noted?.copies ?? {};
  const lines = [];
  if (todo.has("35") && (copies.admin > 1 || copies.worker > 1)) lines.push(`run ${copies.admin} admin and ${copies.worker} worker copies with devops/scale.mjs, which asks its own yes (step 35)`);
  const built = ["migrate", "admin", "worker", "control"].filter((role) => ctx.old.service(role)?.instance?.source?.repo).map((role) => (role === "control" ? "control panel" : role));
  if (todo.has("36") && built.length) lines.push(`disconnect the old ${built.length > 1 ? `${built.slice(0, -1).join(", ")} and ${built.at(-1)}` : built[0]} from the repository (step 36)`);
  if (todo.has("37")) lines.push("turn on the new database's Railway backups, as the old one had them (step 37)");
  if (todo.has("38")) lines.push(`remove ${run.state.values.temporary ?? "the temporary address"} from the new admin, and its records from Cloudflare (step 38)`);
  if (todo.has("39")) lines.push("delete both databases' TCP proxies (step 39)");
  return lines;
}

async function setCopies(ctx) {
  const { run } = ctx;
  assertNew(ctx);
  const copies = run.state.values.noted?.copies;
  if (!copies) throw new Stop(`${run.stateFile} has no notes from step 7: set the copies with devops/scale.mjs by hand (devops/redeploy.md, step 35)`);
  const admin = Number(copies.admin) || 1;
  const worker = Number(copies.worker) || 1;
  if (admin <= 1 && worker <= 1) return console.log("  the old project ran one admin and one worker: nothing to set");
  const args = [`admin=${admin}`, `worker=${worker}`, "--max-connections", "200", "--bootstrap", run.copy.file];
  if (child(SCALE, [...args, "--dry-run"]).status !== 0) throw new Stop("scale.mjs --dry-run stopped (above)");
  if (child(SCALE, args).status !== 0) throw new Stop("scale.mjs stopped (above). Run finish again once that's settled");
  console.log(`  scale.mjs set ${admin} admin and ${worker} worker copies`);
}

async function disconnectOld(ctx) {
  const { old } = ctx;
  for (const role of ["migrate", "admin", "worker", "control"]) {
    const item = old.service(role);
    if (!item) continue;
    const repo = item.instance?.source?.repo;
    if (!repo) {
      console.log(`  = the old ${role} builds from no repository`);
      continue;
    }
    await gql(Q.disconnect, { id: item.id });
    console.log(`  the old ${role} no longer builds from ${repo}`);
  }
}

async function scheduleBackups(ctx) {
  const { old } = ctx;
  const fresh = assertNew(ctx);
  const volume = fresh.service("Postgres")?.volume;
  if (!volume) throw new Stop("the new Postgres has no volume");
  const before = old.service("Postgres")?.volume;
  const kinds = before ? [...new Set(((await gql(Q.schedules, { volumeInstanceId: before.id })).volumeInstanceBackupScheduleList ?? []).map((item) => String(item.kind)))].filter((kind) => ["DAILY", "WEEKLY", "MONTHLY"].includes(kind)) : [];
  if (!kinds.length) console.log("  the old database had no backup schedule, so none was set. Guide 5.2, step 16, sets one");
  else {
    await gql(Q.backupSchedule, { volumeInstanceId: volume.id, kinds });
    const now = ((await gql(Q.schedules, { volumeInstanceId: volume.id })).volumeInstanceBackupScheduleList ?? []).map((item) => String(item.kind).toLowerCase());
    console.log(`  the new database's backups: ${now.join(", ") || "none, as Railway shows them"}`);
  }
  const others = old.services.filter((item) => !SERVICE_ORDER.includes(item.role));
  if (others.length) console.log(`  The old project also has ${others.map((item) => item.name).join(", ")}. If one is the nightly copy (guide 5.2, steps 17 to 22), set it up in the new project with PG_VERSION=${TARGET_MAJOR}, and stop the old one`);
}

async function removeTemporary(ctx) {
  const { run } = ctx;
  const fresh = assertNew(ctx);
  const temporary = run.state.values.temporary;
  if (!temporary) return console.log("  no temporary address was noted (step 9): nothing to remove");
  if (temporary === run.host || run.host.endsWith(`.${temporary}`)) throw new Stop(`the noted temporary address, ${temporary}, is the deployment's own`);
  if (await removeName(fresh, temporary)) console.log(`  removed ${temporary} from the new admin`);
  else console.log(`  = the new admin doesn't have ${temporary}`);
  const zone = String(run.settings.CLOUDFLARE_ZONE ?? "").toLowerCase();
  const token = secretOf(run, "CLOUDFLARE_API_TOKEN");
  if (!zone || !token) return console.log(`  Delete ${temporary}'s CNAME and _railway-verify.${temporary}'s TXT record at the DNS provider by hand`);
  const zoneId = await cloudflareZone(token, zone);
  for (const name of [temporary, `_railway-verify.${temporary}`]) {
    for (const record of (await cloudflare(token, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`)) ?? []) {
      if (record.name !== name) continue;
      await cloudflare(token, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
      console.log(`  deleted ${record.type} ${record.name} in Cloudflare`);
    }
  }
}

async function closeProxies(ctx) {
  const fresh = assertNew(ctx);
  for (const where of [ctx.old, fresh]) {
    if (!(await liveProxies(where)).length) console.log(`  = the ${where.which} database has no TCP proxy`);
    else await closeProxy(ctx.run, where);
  }
  console.log("  Keep the dump in the backup folder until the old project is gone");
}

// ---------------------------------------------------------------- retire (step 40)

function checkRetire(ctx) {
  const { run, fresh } = ctx;
  const next = FINISH.find((step) => !run.state.done[step.n]);
  if (next) throw new Stop(`finish hasn't run to the end: step ${next.n} is next. Run finish first`);
  assertNew(ctx);
  if (!hasAddress(fresh, run.host)) throw new Stop(`the new admin doesn't have ${run.host}, so the old project may still be needed`);
}

function retireChanges(ctx) {
  const { run, old } = ctx;
  const days = (Date.now() - Date.parse(run.state.done["39"])) / 86_400_000;
  const lines = [`delete the old Railway project, "${old.project.name}" (${old.project.id}), with its backups: Railway waits 48 hours, during which its Settings can cancel that`];
  lines.push(`move ${run.file}, its .secrets, .state.json and logs, and this script's notes, into ${path.join(run.backup, "old-project-files")}`);
  if (days < 7) lines.push(`finish ran ${days < 1 ? "less than a day" : count(Math.floor(days), "day")} ago. The move keeps the old project a week, for going back`);
  return lines;
}

async function retireOld(ctx) {
  const { old } = ctx;
  assertNew(ctx);
  if (old.project.deletedAt) return console.log(`  = Railway is deleting "${old.project.name}" already`);
  await gql(Q.scheduleDelete, { id: old.project.id });
  console.log(`  Railway deletes "${old.project.name}" in 48 hours; until then, its Settings can cancel that`);
}

/** After step 40 is recorded: the old project's files, and this script's notes and log, into the backup folder. */
async function moveOldFiles(ctx) {
  const { run } = ctx;
  const folder = path.join(run.backup, "old-project-files");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const moved = [];
  for (const end of ["", ".secrets", ".state.json", ".vars", ".log", ".redeploy.json", ".redeploy.log"]) {
    const from = `${run.file}${end}`;
    if (!fs.existsSync(from)) continue;
    let to = path.join(folder, path.basename(from));
    if (fs.existsSync(to)) to = `${to}.${Date.now()}`;
    if (end === ".redeploy.log") logFile = to;
    try {
      fs.renameSync(from, to);
    } catch {
      // Another drive: copied, then deleted.
      fs.copyFileSync(from, to);
      fs.rmSync(from);
    }
    moved.push(path.basename(from));
  }
  console.log(`  moved ${moved.join(", ")} into ${folder}`);
}

// ---------------------------------------------------------------- cutover (steps 22 to 33)

function checkCutover(ctx) {
  const { run, old, fresh } = ctx;
  const next = [...PREPARE, ...TRIAL].find((step) => !run.state.done[step.n]);
  if (next) throw new Stop(`${PREPARE.includes(next) ? "prepare" : "trial"} hasn't finished: step ${next.n} is next. Run it first; trial runs a day or so before the cutover`);
  assertNew(ctx);
  if (run.state.values.backPath) throw new Stop("going back stopped halfway: run back again to finish it, before another cutover");
  const moving = run.state.done["30"] || run.state.values.cutover?.addressLeftOld;
  if (!moving && hasAddress(fresh, run.host)) throw new Stop(`the new admin has ${run.host}, but the cutover didn't move it there. Find out how before going on (devops/redeploy.md, step 30)`);
  if (!moving && !hasAddress(old, run.host)) throw new Stop(`the old admin doesn't have ${run.host}, and the cutover hasn't moved it. Give it back to the old admin before you start (devops/redeploy.md, G5)`);
}

function cutoverChanges(ctx, todo) {
  const { run, old } = ctx;
  const trial = run.state.values.trial;
  const lines = [];
  if (todo.has("22")) lines.push("open each database to the internet through a TCP proxy, for this computer's PostgreSQL 18 tools (step 22)");
  if (todo.has("23")) lines.push("stop the new admin, worker and control panel (step 23)");
  if (todo.has("24")) lines.push(`stop the old admin once no call is in progress, the old worker two minutes later, then the old cloudflared. Production is offline from then until step 33${trial ? `; the trial's dump and restore took ${duration(trial.dumpSeconds + trial.restoreSeconds)}` : ""} (step 24)`);
  if (todo.has("25")) lines.push("freeze the old database, so the app can't write to it again, count it and dump it into the backup folder (step 25)");
  if (todo.has("26") || todo.has("27")) lines.push("replace the new database with the dump, count it and compare it with the old one (steps 26 and 27)");
  if (todo.has("28") && old.buckets.length) lines.push("copy the bucket's newest files into the new bucket (step 28)");
  if (todo.has("29")) lines.push("deploy the new migrate again (step 29)");
  if (todo.has("30")) lines.push(`take ${run.host} off the old admin, put it back in ${path.basename(run.copy.file)}, and run bootstrap's redo and up on the copy, which asks before pointing ${run.host}'s CNAME at the new project (step 30)`);
  if (todo.has("32")) lines.push("run bootstrap's connect on the copy, whose billing plan you read before you type yes: it should make nothing in Polar (step 32)");
  lines.push("Outside Railway, only step 30 changes anything: the address's DNS records, and Turnstile's list of the admin's addresses. If a step fails, run cutover again, or go back: node devops/redeploy.mjs back.");
  return lines;
}

/**
 * Both databases, through their TCP proxies, opened when they're missing. Each server is checked against the one
 * step 22 recorded, so a proxy that reaches another server never gets a change, and the new one must be on 18.
 */
async function databases(ctx, { versions = true } = {}) {
  const { run, old } = ctx;
  const fresh = assertNew(ctx);
  const password = databasePassword(run);
  dockerReady();
  const recorded = run.state.values.servers;
  const quiet = Boolean(recorded);
  const on = { old: await openProxy(run, old, [], { quiet }), new: await openProxy(run, fresh, [], { quiet }) };
  const servers = { old: serverOf(run, password, on.old, "old"), new: serverOf(run, password, on.new, "new") };
  if (servers.old.id === servers.new.id) throw new Stop("both TCP proxies reach the same server, so nothing was changed");
  for (const which of ["old", "new"]) {
    if (recorded?.[which] && recorded[which] !== servers[which].id) throw new Stop(`the ${which} database's TCP proxy reaches another server than at step 22, so nothing was changed. Check both projects' Postgres in Railway`);
  }
  if (servers.new.major !== TARGET_MAJOR) throw new Stop(`the new server runs PostgreSQL ${servers.new.major}, not ${TARGET_MAJOR}, so nothing was changed`);
  if (versions && servers.old.major === TARGET_MAJOR && !options.sameVersion) throw new Stop(`the old server runs PostgreSQL ${TARGET_MAJOR} already. To rehearse on it anyway, add --same-version`);
  if (!recorded) {
    run.state.values.servers = { old: servers.old.id, new: servers.new.id };
    keepState(run);
  }
  return { password, on, servers };
}

async function openDatabases(ctx) {
  const { servers } = await databases(ctx);
  console.log(`  old: PostgreSQL ${servers.old.major}, new: PostgreSQL ${servers.new.major}`);
}

const roleName = (role) => (role === "control" ? "control panel" : role);
const joined = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "");
const stoppedNow = (where, role) => ["REMOVED", "REMOVING"].includes(where.service(role)?.instance?.latestDeployment?.status);

/** Removes each service's running deployment, which stops every copy of it, and records which, for going back. */
async function stopServices(ctx, where, roles, { quiet = false } = {}) {
  const { run } = ctx;
  const removed = ((run.state.values.removed ??= {})[where.which] ??= {});
  const stopping = [];
  for (const role of roles) {
    if (!where.service(role)) continue;
    const deployment = where.service(role).instance?.latestDeployment;
    if (!deployment || ["REMOVED", "REMOVING"].includes(deployment.status)) {
      if (!quiet) console.log(`  = the ${where.which} ${roleName(role)} is stopped already`);
      continue;
    }
    await gql(Q.removeDeployment, { id: deployment.id });
    removed[role] = { id: deployment.id, at: new Date().toISOString() };
    keepState(run);
    stopping.push(role);
  }
  if (!stopping.length) return;
  await waitUntil(3, `Railway to stop the ${where.which} ${joined(stopping.map(roleName))}`, async () => {
    const now = await readProject(where.values, where.which);
    return stopping.every((role) => [undefined, "REMOVED"].includes(now.service(role)?.instance?.latestDeployment?.status));
  });
  console.log(`  stopped the ${where.which} ${joined(stopping.map(roleName))}`);
}

/** Starts a stopped service again: the deployment that was removed, on the image it ran, else a new one from its source. */
async function startService(ctx, where, role) {
  const item = where.service(role);
  const removedId = ctx.run.state.values.removed?.[where.which]?.[role]?.id ?? item.instance?.latestDeployment?.id;
  const again = removedId ? await attempt(() => gql(Q.redeployDeployment, { id: removedId, usePreviousImageTag: true })) : null;
  if (again && !again.error) return console.log(`  started the ${where.which} ${roleName(role)} again, on the image it ran`);
  const fresh = await attempt(() => gql(Q.deployService, { environmentId: where.environment.id, serviceId: item.id }));
  if (fresh?.error) throw new Stop(`Railway wouldn't start the ${where.which} ${roleName(role)} again (${again?.error ?? "no deployment to deploy again"}; ${fresh.error}). Start it by hand: in Railway, its Deployments, the newest one's menu, Redeploy. Then run ${options.command} again`);
  console.log(`  started the ${where.which} ${roleName(role)} again, from its source${again?.error ? ` (Railway wouldn't deploy the removed deployment again: ${again.error})` : ""}`);
}

/** Deploys a service again from its source, as Railway's Redeploy does, and waits for that deployment to succeed. */
async function deployAgain(where, role) {
  const item = where.service(role);
  if (!item) throw new Stop(`the ${where.which} project has no ${role}`);
  const before = item.instance?.latestDeployment?.id ?? null;
  await gql(Q.redeployService, { environmentId: where.environment.id, serviceId: item.id });
  console.log(`  deploying the ${where.which} ${roleName(role)} again${role === "migrate" ? ": its pre-deploy runs the migrations, sets the roles' passwords and checks row level security" : ""}`);
  await deployed(where, role, before);
  console.log(`  the ${where.which} ${roleName(role)}'s deployment succeeded`);
}

/** Waits for a service's newest deployment after the one given to succeed, and stops when it fails. */
async function deployed(where, role, before, minutes = 20) {
  await waitUntil(minutes, `the ${where.which} ${roleName(role)}'s deployment to succeed`, async () => {
    const latest = (await readProject(where.values, where.which)).service(role)?.instance?.latestDeployment;
    const mine = latest && latest.id !== before ? latest : null;
    if (["FAILED", "CRASHED", "REMOVED"].includes(mine?.status)) throw new Stop(`the ${where.which} ${roleName(role)}'s deployment ended ${String(mine.status).toLowerCase()}: its log in Railway says why`);
    return mine?.status === "SUCCESS";
  });
}

async function stopNew(ctx) {
  await stopServices(ctx, assertNew(ctx), ["admin", "worker", "control"]);
}

async function stopOld(ctx) {
  const { run, old } = ctx;
  const cutover = (run.state.values.cutover ??= {});
  if (!stoppedNow(old, "admin")) {
    const meta = metaOf(old.service("admin")?.instance?.latestDeployment);
    if (typeof meta?.commitHash === "string") cutover.release ??= meta.commitHash;
    await noCallsInProgress(ctx);
    await stopServices(ctx, old, ["admin"]);
    cutover.offline ??= new Date().toISOString();
    keepState(run);
    console.log(`  Production is offline from now, ${shortTime(cutover.offline)}`);
  } else console.log("  = the old admin is stopped already");
  if (old.service("worker") && !stoppedNow(old, "worker")) {
    // The old worker finishes the jobs already handed to the old Redis, which doesn't come along. Tests shorten it.
    const since = Date.parse(run.state.values.removed?.old?.admin?.at ?? "");
    const left = Number.isFinite(since) ? since + 120_000 - Date.now() : 120_000;
    if (left > 0) {
      console.log(`  waiting ${duration(left / 1000)}, so the old worker finishes the jobs it was handed`);
      await sleep((left * POLL_MS) / 5000);
    }
    await stopServices(ctx, old, ["worker"]);
  }
  if (old.service("cloudflared")) await stopServices(ctx, old, ["cloudflared"]);
}

/**
 * Step 24 starts when no call is in progress: the old workers say how many they hold through the old admin's fleet
 * status address, when it has a FLEET_STATUS_TOKEN, else the old database counts the calls that haven't ended.
 */
async function noCallsInProgress(ctx) {
  const { run, old } = ctx;
  const admin = old.service("admin");
  const variables = (await gql(Q.variables, { projectId: old.project.id, environmentId: old.environment.id, serviceId: admin.id })).variables ?? {};
  const raw = variables.FLEET_STATUS_TOKEN;
  const token = typeof raw === "string" && raw.trim().length >= 32 && !raw.includes("${{") ? hide(raw.trim()) : "";
  const fromFleet = async () => {
    try {
      const response = await fetch(`${SITE_URL.replace("{host}", run.host)}/api/internal/fleet`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      const copies = parseJson(await response.text())?.copies;
      return Array.isArray(copies) ? copies.filter((copy) => copy?.service === "worker").reduce((sum, copy) => sum + (Number(copy.liveCalls) || 0), 0) : null;
    } catch {
      return null;
    }
  };
  let calls = token ? await fromFleet() : null;
  let from = "the old workers, through the old admin's fleet status address";
  let read = fromFleet;
  if (calls === null) {
    const { password, on } = await databases(ctx);
    from = "the old database: calls started in the last half hour that haven't ended";
    read = async () => Number(pgOrStop(run, password, ["psql", "-X", ...at(on.old), "-d", "lobbystack", "-Atc", "select count(*) from calls where ended_at is null and started_at > now() - interval '30 minutes'"], "the count of calls in progress").trim());
    calls = await read();
  }
  let said = null;
  for (let tries = 0; calls > 0 && tries < polls(20); tries += 1) {
    if (calls !== said) console.log(`  ${count(calls, "call")} in progress, from ${from}: waiting for ${calls === 1 ? "it" : "them"} to end`);
    said = calls;
    await sleep(POLL_MS);
    calls = (await read()) ?? calls;
  }
  if (calls > 0) await confirm(`  ${count(calls, "call")} still in progress after 20 minutes, which stopping the old admin cuts off. Stop it anyway?`);
  else console.log(`  no call in progress, from ${from}`);
}

async function dumpOld(ctx) {
  const { run } = ctx;
  const { password, on } = await databases(ctx);
  const cutover = (run.state.values.cutover ??= {});
  // Quiet and unaligned: the sessions it ended, then the database's own settings, or none. An error stops it, so the
  // dump never follows a freeze that didn't happen.
  const [ended = "?", settings = "none"] = pgOrStop(run, password, ["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...at(on.old), "-d", "lobbystack", "-f", "freeze.sql"], "the freeze").trim().split(/\r?\n/);
  cutover.mark = /lobbystack\.reset_protection\s*=\s*on/i.test(settings);
  keepState(run);
  console.log(`  froze the old database: the app's roles can't connect any more, and ${count(Number(ended) || 0, "session")} ended. Its own settings: ${settings}`);
  const before = tally(run, password, on.old, "lobbystack");
  cutover.count = before.line;
  keepState(run);
  fs.writeFileSync(path.join(run.backup, "count-old.txt"), `${before.line}\n`, { mode: 0o600 });
  console.log(`  old: ${before.line}`);
  const dump = `${run.label}.dump`;
  for (const file of [dump, `${dump}.part`]) fs.rmSync(path.join(run.backup, file), { force: true });
  const started = Date.now();
  pgOrStop(run, password, ["pg_dump", ...at(on.old), "-d", "lobbystack", "-Fc", "-f", `${dump}.part`], "pg_dump");
  fs.renameSync(path.join(run.backup, `${dump}.part`), path.join(run.backup, dump));
  cutover.dump = { file: dump, bytes: fs.statSync(path.join(run.backup, dump)).size, seconds: Math.round((Date.now() - started) / 1000) };
  console.log(`  the dump: ${path.join(run.backup, dump)}, ${bytes(cutover.dump.bytes)} in ${duration(cutover.dump.seconds)}`);
}

async function restoreNew(ctx) {
  const { run } = ctx;
  const dump = run.state.values.cutover?.dump?.file ?? `${run.label}.dump`;
  if (!fs.existsSync(path.join(run.backup, dump))) {
    delete run.state.done["25"];
    keepState(run);
    throw new Stop(`${dump} isn't in ${run.backup}, so nothing was restored. Run cutover again, which dumps the old database again (step 25)`);
  }
  // A sync of the branch may have started a new service again since step 23: it mustn't run on what's restored.
  await stopServices(ctx, await readProject(run.copy.values, "new"), ["admin", "worker", "control"], { quiet: true });
  const { password, on } = await databases(ctx);
  const started = Date.now();
  // --force ends the sessions still open on the new, empty database, such as a dashboard's, which the stop above left.
  pgOrStop(run, password, ["dropdb", ...at(on.new), "--if-exists", "--force", "lobbystack"], "dropdb");
  pgOrStop(run, password, ["createdb", ...at(on.new), "lobbystack"], "createdb");
  pgOrStop(run, password, ["pg_restore", ...at(on.new), "-d", "lobbystack", "-O", "-1", "-e", dump], "pg_restore");
  pgOrStop(run, password, ["vacuumdb", ...at(on.new), "-d", "lobbystack", "--analyze-only"], "vacuumdb");
  console.log(`  RESTORE OK in ${duration((Date.now() - started) / 1000)}, with the statistics a restore doesn't bring`);
}

async function compareNew(ctx) {
  const { run } = ctx;
  const { password, on } = await databases(ctx);
  const cutover = (run.state.values.cutover ??= {});
  const was = cutover.count ?? tally(run, password, on.old, "lobbystack").line;
  const now = tally(run, password, on.new, "lobbystack");
  console.log(`  old: ${was}`);
  console.log(`  new: ${now.line}`);
  if (now.line !== was) {
    console.log("  DIFFERENT. Lines only the old database has (<) or only the new one has (>):");
    const a = tableLines(run, password, on.old, "lobbystack");
    const b = tableLines(run, password, on.new, "lobbystack");
    for (const line of a.filter((item) => !b.includes(item))) console.log(`    < ${line}`);
    for (const line of b.filter((item) => !a.includes(item))) console.log(`    > ${line}`);
    delete run.state.done["26"];
    keepState(run);
    throw new Stop("the new database isn't the old one's copy. Run cutover again, which restores it again (step 26); if it differs again, go back: node devops/redeploy.mjs back");
  }
  console.log("  SAME: every table arrived, with every row");
  if (cutover.mark) {
    pgOrStop(run, password, ["psql", "-X", ...at(on.new), "-d", "postgres", "-c", "alter database lobbystack set lobbystack.reset_protection = 'on'"], "the reset-protection mark");
    console.log("  set the reset-protection mark on the new database, as the old one had it (guide 7.28)");
  }
}

async function migrateNew(ctx) {
  await deployAgain(assertNew(ctx), "migrate");
}

/** Step 30: the address off the old admin, back in the copy's settings, then bootstrap's address steps on the copy. */
async function moveAddress(ctx) {
  const { run, old } = ctx;
  const fresh = assertNew(ctx);
  const host = run.host;
  const cutover = (run.state.values.cutover ??= {});
  if (await removeName(old, host)) console.log(`  took ${host} off the old admin: it reaches neither project until up gives it to the new one`);
  else console.log(`  = the old admin doesn't have ${host}`);
  cutover.addressLeftOld ??= new Date().toISOString();
  keepState(run);
  reloadCopy(run);
  if (settingsHost(run.copy.settings) !== host || "CUSTOM_HOST" in run.copy.settings) {
    setAddress(run.copy.file, `https://${host}`);
    reloadCopy(run);
  }
  console.log(`  ${run.copy.file}: APP_BASE_URL=https://${host} again`);
  if (!(await domainOn(fresh, host))) {
    // Railway lets another project have a name a short while after it's taken off (step 19 timed it).
    await waitUntil(10, `${host} to be free in Railway`, async () => (await gql(Q.domainAvailable, { domain: host })).customDomainAvailable?.available !== false);
  }
  if (!cutover.redo) {
    const result = bootstrap(["redo", run.copy.file, "railway.domain", "railway.custom", "turnstile", "variables", "post.*"], { capture: true });
    for (const line of result.output.split(/\r?\n/).filter(Boolean)) console.log(`  | ${line}`);
    if (result.status !== 0) throw new Stop(`bootstrap's redo stopped (exit code ${result.status})`);
    cutover.redo = new Date().toISOString();
    keepState(run);
  }
  const up = bootstrap(["up", run.copy.file]);
  reloadCopy(run);
  if (up.status !== 0) throw new Stop("bootstrap's up stopped (above). Do what it says, then run cutover again, which runs up again; production stays offline until then. To go back instead: node devops/redeploy.mjs back");
  // up deploys the admin and the worker with their new variables; the control panel and cloudflared start here.
  const now = await readProject(run.copy.values, "new");
  for (const role of ["admin", "worker", "control", "cloudflared"]) if (stoppedNow(now, role)) await startService(ctx, now, role);
  await loadDomains(now);
  if (!hasAddress(now, host)) throw new Stop(`up finished, but the new admin doesn't have ${host}. Run cutover again`);
  ctx.fresh = now;
  console.log(`  the new admin has ${host}`);
}

/** Before connect: the copy's OPENAI_WEBHOOK_SECRET, if it has one, must be production's, which connect puts on the admin. */
async function webhookSecretFromOld(ctx) {
  const { run, old } = ctx;
  const admin = old.service("admin");
  const value = (await gql(Q.variables, { projectId: old.project.id, environmentId: old.environment.id, serviceId: admin.id })).variables?.OPENAI_WEBHOOK_SECRET;
  const file = `${run.copy.file}.secrets`;
  const mine = secretFromFile(file, "OPENAI_WEBHOOK_SECRET");
  if (typeof value !== "string" || !value || value.includes("${{")) return;
  hide(value);
  if (mine && mine !== value) {
    replaceSecret(file, "OPENAI_WEBHOOK_SECRET", value);
    console.log(`  OPENAI_WEBHOOK_SECRET in ${file} is the old admin's now, as step 16 makes it`);
  }
}

async function connectNew(ctx) {
  const { run } = ctx;
  assertNew(ctx);
  await webhookSecretFromOld(ctx);
  const cutover = (run.state.values.cutover ??= {});
  if (!cutover.connectRedo) {
    // connect then takes the webhook's secret and the platform keys from the new admin, where step 16 put production's.
    const result = bootstrap(["redo", run.copy.file, "connect.webhook", "connect.platformKey"], { capture: true });
    for (const line of result.output.split(/\r?\n/).filter(Boolean)) console.log(`  | ${line}`);
    if (result.status !== 0) throw new Stop(`bootstrap's redo stopped (exit code ${result.status})`);
    cutover.connectRedo = new Date().toISOString();
    keepState(run);
  }
  console.log("  bootstrap's connect: read what pnpm billing plan prints before you type yes. It should make nothing in Polar; if it lists something to make, answer no");
  if (bootstrap(["connect", run.copy.file]).status !== 0) throw new Stop("bootstrap's connect stopped (above). Do what it says, then run cutover again, which runs connect again");
}

async function productionBack(ctx) {
  const { run } = ctx;
  const host = run.host;
  await waitUntil(15, `https://${host}/api/health/ready to answer "ok":true (Railway gives the address its certificate a few minutes after its CNAME changes)`, async () => (await health(host, "/api/health/ready")).body?.ok === true);
  const version = String((await health(host, "/api/health/live")).body?.version ?? "");
  const before = String(run.state.values.cutover?.release ?? "");
  console.log(`  https://${host} answers "ok":true, from the new project${/^[0-9a-f]{7,40}$/i.test(version) ? `, running ${version.slice(0, 7)}` : ""}`);
  if (before && /^[0-9a-f]{7,40}$/i.test(version) && version.slice(0, 7) !== before.slice(0, 7)) console.log(`  The old project ran ${before.slice(0, 7)}: the branch moved since it was built. Check that's what you want`);
  const offline = Date.parse(run.state.values.cutover?.offline ?? "");
  if (Number.isFinite(offline)) console.log(`  Production was offline for about ${duration((Date.now() - offline) / 1000)}`);
}

// ---------------------------------------------------------------- check (step 34)

function checkCheck(ctx) {
  const { run, fresh } = ctx;
  const next = CUTOVER.find((step) => !run.state.done[step.n]);
  if (next) throw new Stop(`the cutover hasn't finished: step ${next.n} is next. Run cutover`);
  assertNew(ctx);
  if (!hasAddress(fresh, run.host)) throw new Stop(`the new admin doesn't have ${run.host}`);
}

/** Step 34: what the script can read, then the checks only a person can do, each answered yes or no. */
async function checks(ctx) {
  const { run } = ctx;
  const fresh = assertNew(ctx);
  const host = run.host;
  const failed = [];
  const ready = await health(host, "/api/health/ready");
  if (ready.body?.ok === true) console.log(`  ok  https://${host}/api/health/ready answers "ok":true`);
  else {
    failed.push("health");
    console.log(`  FIX https://${host}/api/health/ready: ${ready.error ?? `HTTP ${ready.status}${ready.body ? `, ${JSON.stringify(ready.body).slice(0, 200)}` : ""}`}`);
  }
  console.log("  The copies, as devops/scale.mjs lists them:");
  if (child(SCALE, ["--bootstrap", run.copy.file]).status !== 0) {
    failed.push("copies");
    console.log("  FIX scale.mjs couldn't list the copies (above)");
  }
  const worker = fresh.service("worker")?.instance?.latestDeployment;
  if (worker) {
    const logs = await attempt(() => gql(Q.logs, { deploymentId: worker.id, limit: 500 }));
    const lines = logs?.deploymentLogs ?? [];
    const errors = lines.filter((line) => /^(err|error|fatal|critical)$/i.test(String(line.severity ?? "")));
    if (logs?.error) console.log(`  the new worker's log: unknown (${logs.error})`);
    else console.log(`  the new worker's log: ${count(lines.length, "line")} since it started${errors.length ? `, ${count(errors.length, "error")}; the newest:` : ", no error"}`);
    for (const line of errors.slice(-3)) console.log(`    ${shortTime(line.timestamp)}  ${String(line.message).slice(0, 200)}`);
  }
  const control = fresh.service("control") ? run.copy.values.CONTROL_HOST ?? run.old.CONTROL_HOST : null;
  if (control) {
    const answer = await attempt(async () => (await fetch(SITE_URL.replace("{host}", control), { redirect: "manual", signal: AbortSignal.timeout(15_000) })).status);
    if (typeof answer === "number" && answer < 500) console.log(`  ok  https://${control} answers (HTTP ${answer}), through the new cloudflared`);
    else {
      failed.push("control panel");
      console.log(`  FIX https://${control}: ${typeof answer === "number" ? `HTTP ${answer}` : answer?.error}. Is the new cloudflared running?`);
    }
  }
  if (run.copy.done["connect.billing.verify"]) console.log("  ok  pnpm billing verify passed at the end of connect (step 32)");
  console.log("\n  Now the checks only you can do. Answer each yes, or no if it fails:");
  const questions = [
    ["sign-in", "Sign in with the emailed code: does the dashboard show the businesses, calls and messages?"],
    ["files", "Open a knowledge document or a call recording, then upload a small file: did both work?"],
    ["call", "Call a business's number: did the receptionist answer?"],
    ["text", "Text that number: does the text show in the dashboard? (yes too if it takes no texts)"],
    ...(run.copy.settings.POLAR ? [["Polar", `In Polar, Settings > Webhooks: is there one endpoint, for https://${host}/api/webhooks/polar, with its newest deliveries answered 200, and does a business's billing portal open?`]] : []),
    ["worker", "Does the new worker's log in Railway show jobs running, without errors?"],
    ...(control ? [["control panel", `Does https://${control} open and show the businesses?`]] : []),
  ];
  for (const [label, question] of questions) {
    if ((await ask(`  ${question} `)).toLowerCase() !== "yes") failed.push(label);
  }
  run.state.values.checks = { at: new Date().toISOString(), failed };
  keepState(run);
  if (failed.length) throw new Stop(`${joined(failed)} didn't pass. Fix ${failed.length === 1 ? "it" : "them"} if it's quick, then run check again; if not, go back within the first hour, before real traffic builds up on the new database: node devops/redeploy.mjs back`);
  console.log("  Every check passed");
}

// ---------------------------------------------------------------- back (G1 to G9)

/** Whether the address had left the old admin: going back then moves it back too (G4 to G9). */
const switched = ({ run, old, fresh }) => Boolean(run.state.done["30"] || run.state.values.cutover?.addressLeftOld || !hasAddress(old, run.host) || hasAddress(fresh, run.host));

function checkBack(ctx) {
  const { run, old } = ctx;
  assertNew(ctx);
  if (old.project.deletedAt) throw new Stop(`Railway is deleting the old project, "${old.project.name}" (step 40), so there's nothing to go back to. Its Settings can cancel the deletion within 48 hours of retire`);
  const started = run.state.values.backPath || CUTOVER.some((step) => run.state.done[step.n]) || run.state.values.cutover || ["admin", "worker"].some((role) => stoppedNow(old, role)) || !hasAddress(old, run.host);
  if (!started) throw new Stop("the cutover hasn't started: production runs on the old project, so there's nothing to go back from");
  ctx.path = run.state.values.backPath ?? (switched(ctx) ? "after" : "before");
}

function backChanges(ctx, todo) {
  const { run } = ctx;
  const lines = [];
  if (ctx.path === "before") {
    if (todo.has("G1")) lines.push("let the app's roles connect to the old database again (G1)");
    if (todo.has("G2")) lines.push("start the old admin, worker and cloudflared again, with their copies (G2)");
    if (todo.has("G3")) lines.push("empty the new database and deploy the new migrate again, so a sync of the branch can't start a new worker on production's data (G3)");
    lines.push(`${run.host} stayed on the old admin, so nothing outside Railway changes. The new project stays, for another try from step 22`);
  } else {
    if (todo.has("G4")) lines.push(`stop the new admin, worker, control panel and cloudflared, and take ${run.host} off the new admin (G4)`);
    if (todo.has("G5")) lines.push(`give ${run.host} back to the old admin, and point its records in Cloudflare at the old project, asking first for the CNAME (G5)`);
    if (todo.has("G6") || todo.has("G7")) lines.push("let the app's roles connect to the old database again, and start the old admin, worker and cloudflared (G6 and G7)");
    if (todo.has("G8")) lines.push("rename the new database lobbystack_after_switch, which keeps what customers wrote since the switch, make an empty one, and deploy the new migrate again (G8)");
    lines.push("What was written to the new database since the switch doesn't come back to the old one. The new project stays, for another try from step 22");
  }
  if (FINISH.some((step) => run.state.done[step.n])) lines.push("finish has run, so the old services start from the image they last ran: step 36 disconnected them from the repository");
  return lines;
}

function backQuestion(ctx) {
  return ctx.path === "before"
    ? "Production goes back to the old project, as it was before the cutover."
    : `Production goes back to the old project, and ${ctx.run.host} with it; what customers wrote since the switch stays behind in the new project.`;
}

async function openOld(ctx) {
  const { run } = ctx;
  const { password, on } = await databases(ctx, { versions: false });
  pgOrStop(run, password, ["psql", "-X", ...at(on.old), "-d", "postgres", "-c", "grant connect on database lobbystack to public"], "the grant");
  console.log("  the app's roles can connect to the old database again");
}

/** G2 and G7: the old services started again, and production answering from them once the address is theirs. */
async function startOld(ctx) {
  const { run } = ctx;
  const old = await readProject(run.old, "old");
  const roles = ["admin", "worker", "cloudflared"].filter((role) => stoppedNow(old, role));
  if (!roles.length) console.log("  = the old admin, worker and cloudflared are running");
  for (const role of roles) {
    const before = old.service(role).instance.latestDeployment.id;
    await startService(ctx, old, role);
    await deployed(old, role, before);
  }
  if (roles.length) console.log(`  the old ${joined(roles.map(roleName))} ${roles.length === 1 ? "runs" : "run"} again`);
  await loadDomains(old);
  if (!hasAddress(old, run.host)) return;
  await waitUntil(15, `https://${run.host}/api/health/ready to answer "ok":true from the old project`, async () => (await health(run.host, "/api/health/ready")).body?.ok === true);
  console.log(`  https://${run.host} answers "ok":true, from the old project`);
}

/** G3: the new database emptied, so a new worker that a sync starts finds nothing to act on. */
async function emptyNew(ctx) {
  const { run } = ctx;
  const fresh = await readProject(run.copy.values, "new");
  await stopServices(ctx, fresh, ["admin", "worker", "control"], { quiet: true });
  const { password, on } = await databases(ctx, { versions: false });
  pgOrStop(run, password, ["dropdb", ...at(on.new), "--if-exists", "--force", "lobbystack"], "dropdb");
  pgOrStop(run, password, ["createdb", ...at(on.new), "lobbystack"], "createdb");
  console.log("  emptied the new database");
  await deployAgain(fresh, "migrate");
}

async function stopNewAll(ctx) {
  const { run } = ctx;
  const fresh = assertNew(ctx);
  if (await removeName(fresh, run.host)) console.log(`  took ${run.host} off the new admin`);
  else console.log(`  = the new admin doesn't have ${run.host}`);
  await stopServices(ctx, fresh, ["admin", "worker", "control", "cloudflared"]);
}

/** G5: the address on the old admin again, with the records Railway asks for, which are step 7's unless Railway says otherwise. */
async function addressBack(ctx) {
  const { run, old } = ctx;
  const host = run.host;
  if (await domainOn(old, host)) console.log(`  = the old admin has ${host}`);
  else {
    await waitUntil(10, `${host} to be free in Railway`, async () => (await gql(Q.domainAvailable, { domain: host })).customDomainAvailable?.available !== false);
    await gql(Q.domainCreate, { input: { domain: host, environmentId: old.environment.id, projectId: old.project.id, serviceId: old.service("admin").id, targetPort: 3000 } });
    console.log(`  gave ${host} back to the old admin`);
  }
  const records = await waitUntil(2, `Railway's DNS records for ${host}`, async () => {
    const found = recordsOf(await domainOn(old, host), host);
    return found.length ? found : null;
  });
  for (const record of records) {
    const noted = (run.state.values.noted?.records ?? []).find((item) => item.type === record.type && item.name === record.name);
    if (noted && unquote(noted.content) !== record.content) console.log(`  Railway asks for ${record.type} ${record.name} ${record.content}, where step 7 noted ${unquote(noted.content)}: Railway's is used`);
  }
  const zone = String(run.settings.CLOUDFLARE_ZONE ?? "").toLowerCase();
  const token = secretOf(run, "CLOUDFLARE_API_TOKEN");
  if (!zone || !token) {
    console.log(`  ${zone ? "There's no CLOUDFLARE_API_TOKEN" : "The settings name no CLOUDFLARE_ZONE"}, so set these at the DNS provider now, DNS only:`);
    for (const record of records) console.log(`    ${record.type.padEnd(5)} ${record.name}  ${record.content}`);
    await confirm("  Are they set?");
    return;
  }
  const zoneId = await cloudflareZone(token, zone);
  for (const record of records) {
    const existing = ((await cloudflare(token, `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`)) ?? []).filter((item) => item.name === record.name);
    const same = existing.find((item) => unquote(item.content).toLowerCase() === record.content.toLowerCase());
    const replace = record.type === "CNAME" ? existing[0] : existing.find((item) => unquote(item.content).startsWith("railway-verify="));
    if (same) console.log(`  = Cloudflare: ${record.type} ${record.name}`);
    else if (replace) {
      if (record.type === "CNAME") await confirm(`  ${record.name} points to ${replace.content} now. Point it to ${record.content}, the old project, again?`);
      await cloudflare(token, `/zones/${zoneId}/dns_records/${replace.id}`, { method: "PATCH", body: { content: record.content, ttl: 1, proxied: false } });
      console.log(`  Cloudflare: ${record.type} ${record.name}  ${record.content} (changed)`);
    } else {
      await cloudflare(token, `/zones/${zoneId}/dns_records`, { method: "POST", body: { type: record.type, name: record.name, content: record.content, ttl: 1, proxied: false } });
      console.log(`  Cloudflare: ${record.type} ${record.name}  ${record.content} (made)`);
    }
  }
}

const unquote = (text) => String(text ?? "").replace(/^"|"$/g, "");

/** G8: the new database renamed, keeping what customers wrote since the switch, and an empty one made in its place. */
async function asideNew(ctx) {
  const { run } = ctx;
  const fresh = await readProject(run.copy.values, "new");
  await stopServices(ctx, fresh, ["admin", "worker", "control"], { quiet: true });
  const { password, on } = await databases(ctx, { versions: false });
  const names = pgOrStop(run, password, ["psql", "-X", ...at(on.new), "-d", "postgres", "-Atc", "select datname from pg_database"], "the list of databases").trim().split(/\r?\n/);
  const kept = run.state.values.aside;
  if (kept && names.includes(kept)) console.log(`  = the new database was set aside as ${kept} already`);
  else if (names.includes("lobbystack")) {
    const aside = names.includes("lobbystack_after_switch") ? `lobbystack_after_switch_${new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "_")}` : "lobbystack_after_switch";
    pgOrStop(run, password, ["psql", "-X", ...at(on.new), "-d", "postgres",
      "-c", "select count(pg_terminate_backend(pid, 5000)) from pg_stat_activity where datname = 'lobbystack' and pid <> pg_backend_pid()",
      "-c", `alter database lobbystack rename to ${aside}`], "the rename");
    run.state.values.aside = aside;
    keepState(run);
    console.log(`  the new database is ${aside} now: what customers wrote since the switch, to look things up in. Nothing reads it`);
  }
  if (!pgOrStop(run, password, ["psql", "-X", ...at(on.new), "-d", "postgres", "-Atc", "select datname from pg_database"], "the list of databases").trim().split(/\r?\n/).includes("lobbystack")) {
    pgOrStop(run, password, ["createdb", ...at(on.new), "lobbystack"], "createdb");
  }
  await deployAgain(fresh, "migrate");
}

async function polarNote(ctx) {
  const { run } = ctx;
  const temporary = run.state.values.temporary ?? "the temporary address";
  console.log(`  Nothing changes at Twilio, OpenAI or Polar: their webhooks go to https://${run.host}, which is the old project's again. If connect ever ran on the copy while it had ${temporary}, delete Polar's webhook to https://${temporary}/api/webhooks/polar (Polar: Settings > Webhooks)`);
}

/**
 * Once every step of going back is done: the TCP proxies step 22 opened are closed, and the cutover's record is
 * cleared, so another try starts again from step 22.
 */
async function wentBack(ctx) {
  const { run, old, fresh } = ctx;
  const values = run.state.values;
  for (const where of [old, fresh]) {
    if (!where || !(values.proxies ?? []).includes(where.which)) continue;
    const closed = await attempt(() => closeProxy(run, where));
    if (closed?.error) console.log(`  couldn't close the ${where.which} database's TCP proxy (${closed.error}): delete it by hand, in Postgres > Settings > Networking`);
  }
  (values.wentBack ??= []).push({ at: new Date().toISOString(), path: values.backPath ?? ctx.path, ...(values.aside ? { aside: values.aside } : {}) });
  for (const step of [...CUTOVER, ...CHECK, ...BACK_BEFORE, ...BACK_AFTER]) delete run.state.done[step.n];
  for (const key of ["backPath", "cutover", "removed", "servers", "checks", "aside"]) delete values[key];
  keepState(run);
  console.log(`\n  Production runs on the old project again. ${run.file} still describes it; the copy, ${path.basename(run.copy.file)}, the new project`);
}

// ---------------------------------------------------------------- recover (R1)

/** R1: the -pg18 files put back from their newest copy in the backup folder, the ones there now kept aside. */
async function recoverCommand(run) {
  const release = options.dryRun ? () => undefined : tryLock(run);
  if (!release) {
    const holder = lockHolder(run);
    throw new Stop(`another run${holder ? ` (${holder.command ?? "a command"}, process ${holder.pid})` : ""} is using ${run.stateFile}. Let it finish; if none is running, delete ${run.stateFile}.lock (R2)`);
  }
  run.locked = !options.dryRun;
  try {
    if (!options.dryRun) {
      logFile = `${run.file}.redeploy.log`;
      logOnly(`\n==== recover ${path.basename(run.file)} | ${new Date().toISOString()} | node ${process.version} on ${process.platform}`);
    }
    printFiles(run);
    const copy = `${run.file}${COPY_SUFFIX}`;
    const from = ["after-cutover", "after-stage-1"].map((folder) => path.join(run.backup, folder)).find((folder) => fs.existsSync(path.join(folder, path.basename(copy))));
    if (!from) throw new Stop(`the backup folder has no copy of ${path.basename(copy)}: neither after-cutover (step 31) nor after-stage-1 (step 14). Make the copy again from the original files (devops/redeploy.md, "If a run stops")`);
    // What the copy's state file learned after the backup was made runs again.
    const again = (path.basename(from) === "after-cutover" ? ["32", "33"] : ["30", "31", "32", "33"]).filter((n) => run.state.done[n]);
    const aside = path.join(run.backup, `replaced-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}`);
    const ends = ["", ".secrets", ".state.json"];
    const here = ends.map((end) => `${copy}${end}`).filter((file) => fs.existsSync(file));
    console.log(`\nrecover (R1) ${options.dryRun ? "would" : "will"}:`);
    if (here.length) console.log(`  - move ${here.map((file) => path.basename(file)).join(", ")} into ${aside}`);
    console.log(`  - copy the three ${COPY_SUFFIX} files back from ${from}`);
    if (again.length) console.log(`  - record steps ${joined(again)} as not done, so cutover runs ${again.length === 1 ? "it" : "them"} again`);
    if (options.dryRun) return console.log("\nA dry run: nothing was changed.");
    await confirm("");
    if (here.length) {
      fs.mkdirSync(aside, { recursive: true, mode: 0o700 });
      for (const file of here) fs.renameSync(file, path.join(aside, path.basename(file)));
    }
    for (const end of ends) {
      const saved = path.join(from, `${path.basename(copy)}${end}`);
      if (fs.existsSync(saved)) copyPrivate(saved, `${copy}${end}`);
    }
    for (const n of again) delete run.state.done[n];
    if (again.includes("30")) delete run.state.values.cutover?.redo;
    if (again.includes("32")) delete run.state.values.cutover?.connectRedo;
    keepState(run);
    console.log(`\nPut the ${COPY_SUFFIX} files back from ${from}.${here.length ? ` The ones that were here are in ${aside}.` : ""} Next: node devops/redeploy.mjs status ${path.basename(run.file)}, then the command whose step is next.`);
  } finally {
    release();
    run.locked = false;
  }
}

// ---------------------------------------------------------------- waiting

/** Asks again every few seconds until check gives something, for at most the minutes given. */
async function waitUntil(minutes, what, check) {
  for (let tries = 0; ; tries += 1) {
    const found = await check();
    if (found) return found;
    if (tries >= polls(minutes)) throw new Stop(`waited ${minutes} minutes for ${what}`);
    if (tries === 0) console.log(`  waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

/** Railway's changes that answer with a workflow: waits while it runs, and stops when it fails. An unknown one isn't waited for. */
async function waitForWorkflow(workflowId, what, minutes) {
  if (typeof workflowId !== "string" || !workflowId) return;
  await waitUntil(minutes, `Railway to finish ${what}`, async () => {
    const result = (await gql(Q.workflow, { workflowId })).workflowStatus;
    if (result?.status === "Error") throw new Stop(`Railway couldn't finish ${what}: ${result.error || "it gave no reason"}`);
    return result?.status !== "Running";
  });
}

function duration(seconds) {
  if (!Number.isFinite(seconds)) return "an unknown time";
  if (seconds < 90) return count(Math.max(1, Math.round(seconds)), "second");
  return count(Math.round(seconds / 60), "minute");
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

async function cloudflare(token, pathname, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`${URLS.cloudflare}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`couldn't reach Cloudflare (${error.cause?.code ?? error.message})`);
  }
  const answer = parseJson(await response.text());
  if (!response.ok || answer?.success === false) throw new Error(`Cloudflare refused ${method === "GET" ? "" : `${method} `}${pathname.split("?")[0]}: ${answer?.errors?.map((item) => item.message).join("; ") || `HTTP ${response.status}`}`);
  return answer?.result;
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

const CHANGE_COMMANDS = ["prepare", "trial", "cutover", "check", "back", "recover", "finish", "retire"];

function parseArgs(argv) {
  const parsed = { command: "", target: "", backup: "", save: "", temporary: "", rehearse: "", dryRun: false, noRehearsal: false, sameVersion: false };
  const positional = [];
  const flags = { "--dry-run": "dryRun", "--no-rehearsal": "noRehearsal", "--same-version": "sameVersion" };
  const valued = { "--backup": "backup", "--save": "save", "--temporary": "temporary", "--rehearse": "rehearse" };
  const given = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let value;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (equals > 0) [arg, value] = [arg.slice(0, equals), arg.slice(equals + 1)];
    if (arg === "--help" || arg === "-h") help();
    else if (flags[arg]) {
      parsed[flags[arg]] = true;
      given.add(arg);
    } else if (valued[arg]) {
      value ??= argv[++index];
      if (!value || value.startsWith("--")) usage(`${arg} needs a value.`);
      parsed[valued[arg]] = value;
      given.add(arg);
    } else if (arg.startsWith("-")) usage(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  [parsed.command, parsed.target] = positional;
  const only = (option, commands) => {
    if (given.has(option) && !commands.includes(parsed.command)) usage(`${option} goes with ${commands.join(" or ")}.`);
  };
  if (parsed.command === "schema") {
    if (positional.length > 1) usage("schema takes no settings file.");
  } else if (parsed.command === "status" || CHANGE_COMMANDS.includes(parsed.command)) {
    if (!parsed.target || positional.length > 2) usage(`${parsed.command} takes the settings file, or the deployment's address.`);
  } else usage(parsed.command ? `Unknown command ${parsed.command}.` : "Give a command.");
  only("--save", ["schema"]);
  only("--dry-run", CHANGE_COMMANDS);
  only("--temporary", ["prepare"]);
  for (const option of ["--rehearse", "--no-rehearsal"]) only(option, ["trial"]);
  only("--same-version", ["prepare", "trial", "cutover"]);
  return parsed;
}

function help() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split(/\r?\n/);
  const end = text.findIndex((line) => line.startsWith("import "));
  consoleOriginal.log(text.slice(1, end).map((line) => line.replace(/^\/\/ ?/, "")).join("\n").trim());
  process.exit(0);
}

function usage(problem) {
  consoleOriginal.error(`${problem}\n\nUsage: node devops/redeploy.mjs status <settings file or address> [--backup <folder>]\n       node devops/redeploy.mjs prepare|trial|cutover|check|back|recover|finish|retire <settings file or address> [--dry-run]\n       node devops/redeploy.mjs schema [--save <file>]\nRun it with --help for more, and see devops/redeploy.md.`);
  process.exit(2);
}

// One reader for every question, so answers piped in on separate lines all arrive. Lines read ahead wait here, across
// a child that had the terminal meanwhile.
const waiting = [];

function ask(question, { hidden: hide = false } = {}) {
  prompter ??= createPrompter();
  return prompter.ask(question, hide);
}

/** Lets a child process have the terminal: the reader lets go of it, and the next question makes a new one. */
function handOver() {
  prompter?.close();
  prompter = null;
}

function createPrompter() {
  const terminal = process.stdin.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
  // Input that ended before this reader was made, as after a child, answers every question with nothing.
  let closed = process.stdin.readableEnded === true;
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
      current = null;
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
