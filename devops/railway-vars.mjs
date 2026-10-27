// railway-vars.mjs: sets variables on Railway services from a file, so they don't
// have to be typed into the dashboard one by one.
//
// The file lists variables under the services that get them:
//
//   [lobbystack-admin, worker]
//   POLAR_ORGANIZATION_ID=7c1d2e3f-...
//   POLAR_ACCESS_TOKEN=?
//
//   [lobbystack-admin]
//   POLAR_WEBHOOK_SECRET=polar_whs_...
//
// A [...] line names one or more services as Railway names them, and the KEY=value
// lines under it go on each of them. A value of ? means the script asks for it while
// it runs, with typing hidden, so a secret needn't sit in the file. Lines starting
// with # are comments. Quotes around a value are optional, and a reference such as
// ${{Postgres.DATABASE_URL}} goes to Railway as written. polar-setup.mjs writes a
// file like this when given --railway-file.
//
// Run it with Node 18 or later:
//   node railway-vars.mjs <file>
// Options:
//   --dry-run        show what would change and change nothing
//   --skip-deploys   set the variables without redeploying the services
//   --yes            skip the confirmation question
//
// It needs a Railway project token, which belongs to one environment of one project
// (in Railway, open the project, then Settings > Tokens). It asks for the token, or
// reads RAILWAY_TOKEN, and never saves or prints it. It never prints a value either.
//
// It adds and changes variables but never deletes one, and it leaves sealed variables
// alone. Railway redeploys each service whose variables changed, unless --skip-deploys
// is given. Running it again is safe: values Railway already has are left as they are.
//
// The API calls match the ones Railway's own CLI makes (railwayapp/cli master 05ed159,
// 2026-10-16: ProjectToken, Project, ServiceVariablesForEdit, VariableCollectionUpsert).

import fs from "node:fs";
import readline from "node:readline";

const ENDPOINT = "https://backboard.railway.com/graphql/v2";

const PROJECT_TOKEN_QUERY = `query ProjectToken {
  projectToken {
    project { id name }
    environment { id name }
  }
}`;

const PROJECT_QUERY = `query Project($id: String!) {
  project(id: $id) {
    name
    services { edges { node { id name } } }
  }
}`;

// Unrendered, so a reference reads back as ${{...}} and compares with the file. A
// sealed variable reads back as null; the environment's list says which ones are sealed.
const VARIABLES_QUERY = `query ServiceVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
  environment(id: $environmentId, projectId: $projectId) {
    variables(first: 10000) { edges { node { name serviceId isSealed } } }
  }
}`;

const UPSERT_MUTATION = `mutation VariableCollectionUpsert($projectId: String!, $environmentId: String!, $serviceId: String!, $variables: EnvironmentVariables!, $skipDeploys: Boolean) {
  variableCollectionUpsert(input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, variables: $variables, skipDeploys: $skipDeploys })
}`;

const STATUS = {
  new: ["+", "new"],
  changed: ["~", "changes"],
  same: ["=", "already has this value"],
  sealed: ["=", "sealed in Railway, so it's left alone"],
  unknown: ["?", "already set; a real run asks for the value and compares it"],
};

const options = parseArgs(process.argv.slice(2));
let token = "";
let prompter = null;
let changedSomething = false;

main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    console.error(changedSomething
      ? "Some variables were set before this. Fix the problem and run the same command again; values Railway already has are left as they are."
      : "Nothing was changed.");
    process.exitCode = 1;
  })
  .finally(() => prompter?.close());

async function main() {
  if (typeof fetch !== "function") throw new Error("this script needs Node 18 or later");
  const sections = readSections(options.file);

  token = (process.env.RAILWAY_TOKEN ?? "").trim() || (await ask("Railway project token (typing is hidden): ", { hidden: true }));
  if (!token) throw new Error("no token given");
  const { projectToken } = await gql(PROJECT_TOKEN_QUERY);
  const projectId = projectToken.project.id;
  const environment = projectToken.environment;
  const { project } = await gql(PROJECT_QUERY, { id: projectId });
  console.log(`Railway project ${project.name}, environment ${environment.name}`);
  const targets = resolveServices(sections, project);

  if (!options.dryRun) await askForValues(sections);

  const seen = new Set();
  for (const target of targets) {
    const { current, sealed } = await readVariables(projectId, environment.id, target.service.id);
    target.changes = Object.create(null);
    console.log(`\n${target.service.name}`);
    const width = Math.max(...[...target.entries.keys()].map((key) => key.length));
    for (const [key, entry] of target.entries) {
      const status = compare(key, entry, current, sealed);
      seen.add(status);
      if (status === "new" || status === "changed") target.changes[key] = entry.value;
      const [symbol, label] = STATUS[status];
      console.log(`  ${symbol} ${key.padEnd(width)}  ${label}`);
    }
  }
  const changed = targets.filter((target) => Object.keys(target.changes).length > 0);
  const count = changed.reduce((sum, target) => sum + Object.keys(target.changes).length, 0);
  console.log("");
  if (seen.has("sealed")) console.log("A sealed variable can't be read back, so change one in the dashboard if it needs a new value.");

  if (!count && !seen.has("unknown")) {
    console.log("Nothing to change: Railway already has these values.");
    return;
  }
  if (options.dryRun) {
    console.log("Dry run: nothing was changed. Run the same command without --dry-run to set them.");
    return;
  }
  const names = listNames(changed.map((target) => target.service.name));
  if (!options.yes) {
    const question = options.skipDeploys
      ? `Set ${plural(count, "variable")} on ${names} in ${project.name} (${environment.name}), without redeploying? Type yes to continue: `
      : `Set ${plural(count, "variable")} on ${names} in ${project.name} (${environment.name})? Railway then redeploys ${changed.length > 1 ? "them" : "it"}. Type yes to continue: `;
    const answer = await ask(question);
    if (answer.toLowerCase() !== "yes") {
      console.log("Nothing changed.");
      return;
    }
  }

  for (const target of changed) {
    const keys = Object.keys(target.changes);
    const data = await gql(UPSERT_MUTATION, {
      projectId,
      environmentId: environment.id,
      serviceId: target.service.id,
      variables: target.changes,
      skipDeploys: options.skipDeploys ? true : null,
    }, { mutation: true });
    if (data.variableCollectionUpsert !== true) throw new Error(`Railway didn't confirm the variables for ${target.service.name}`);
    changedSomething = true;
    console.log(`Done: ${plural(keys.length, "variable")} on ${target.service.name}`);
  }

  // Read the values back, so a change Railway didn't keep doesn't go unnoticed.
  for (const target of changed) {
    const { current } = await readVariables(projectId, environment.id, target.service.id);
    const different = Object.keys(target.changes).filter((key) => !Object.hasOwn(current, key) || current[key] !== target.changes[key]);
    if (different.length) {
      console.warn(`Railway shows other values for ${different.join(", ")} on ${target.service.name}. Check them in the dashboard.`);
      process.exitCode = 1;
    }
  }
  console.log(options.skipDeploys
    ? `\nRailway hasn't redeployed. Deploy ${names} from the dashboard when you're ready.`
    : `\nRailway redeploys ${names} with the new values; their Deployments tab shows the progress.`);
}

function compare(key, entry, current, sealed) {
  if (sealed.has(key)) return "sealed";
  const value = Object.hasOwn(current, key) ? current[key] : null;
  if (value === null) return "new";
  if (entry.value === undefined) return "unknown";
  return value === entry.value ? "same" : "changed";
}

async function readVariables(projectId, environmentId, serviceId) {
  const data = await gql(VARIABLES_QUERY, { projectId, environmentId, serviceId });
  const sealed = new Set((data.environment?.variables?.edges ?? [])
    .map((edge) => edge.node)
    .filter((node) => node.serviceId === serviceId && node.isSealed)
    .map((node) => node.name));
  return { current: data.variables ?? {}, sealed };
}

// Each section is a [...] line with the variables under it. Problems are collected
// and reported together, before anything is sent to Railway.
function readSections(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`couldn't read ${file} (${error.code ?? error.message})`);
  }
  const sections = [];
  const problems = [];
  const seen = new Map();
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const header = line.match(/^\[(.*)\]$/);
    if (header) {
      const names = header[1].split(",").map((name) => name.trim()).filter(Boolean);
      if (!names.length) problems.push(`line ${number} names no service`);
      sections.push({ line: number, names, entries: [] });
      return;
    }
    // Values are never quoted back, since a stray line can be a pasted secret.
    const equals = line.indexOf("=");
    const key = equals > 0 ? line.slice(0, equals).trim().replace(/^export\s+/, "") : "";
    if (!key) {
      problems.push(`line ${number} isn't a [service] line, a KEY=value line or a # comment`);
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push(`line ${number} doesn't start with a variable name (letters, digits and _)`);
      return;
    }
    const section = sections.at(-1);
    if (!section) {
      problems.push(`line ${number}: put a [service] line above the first variable`);
      return;
    }
    let value = line.slice(equals + 1).trim();
    const quoted = value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) {
      value = value.slice(1, -1);
    } else if (value === "") {
      problems.push(`line ${number}: ${key} has no value. Put it after the =, or ? to be asked for it`);
      return;
    } else if (/^<[^>]*>$/.test(value)) {
      problems.push(`line ${number}: ${key} still holds a placeholder. Put the real value after the =, or ? to be asked for it`);
      return;
    }
    for (const name of section.names) {
      const id = `${name.toLowerCase()}\n${key}`;
      if (seen.has(id)) problems.push(`${key} is listed twice for ${name}, on lines ${seen.get(id)} and ${number}`);
      else seen.set(id, number);
    }
    const askLater = !quoted && value === "?";
    section.entries.push({ key, line: number, ask: askLater, value: askLater ? undefined : value });
  });
  if (!problems.length && !sections.some((section) => section.entries.length)) problems.push("it has no variables");
  if (problems.length) throw new Error(`${file} needs fixing:\n  ${problems.join("\n  ")}`);
  for (const section of sections) {
    if (!section.entries.length) console.warn(`Note: [${section.names.join(", ")}] on line ${section.line} has no variables under it.`);
  }
  return sections;
}

function resolveServices(sections, project) {
  const services = project.services.edges.map((edge) => edge.node);
  const find = (name) => services.find((service) => service.name.toLowerCase() === name.toLowerCase());
  const missing = [...new Set(sections.flatMap((section) => section.names).filter((name) => !find(name)))];
  if (missing.length) {
    const known = services.length ? `Its services are ${services.map((service) => `"${service.name}"`).join(", ")}.` : "It has no services.";
    throw new Error(`${project.name} has no service named ${missing.map((name) => `"${name}"`).join(" or ")}. ${known} Change the [...] line in ${options.file} to match.`);
  }
  const targets = new Map();
  for (const section of sections) {
    for (const name of section.names) {
      const service = find(name);
      if (!targets.has(service.id)) targets.set(service.id, { service, entries: new Map() });
      for (const entry of section.entries) targets.get(service.id).entries.set(entry.key, entry);
    }
  }
  return [...targets.values()].filter((target) => target.entries.size > 0);
}

// One question per ? line: a section naming two services asks once for both.
async function askForValues(sections) {
  for (const section of sections) {
    for (const entry of section.entries) {
      if (!entry.ask) continue;
      entry.value = await ask(`${entry.key} for ${listNames(section.names)} (typing is hidden): `, { hidden: true });
      if (!entry.value) throw new Error(`no value given for ${entry.key}`);
    }
  }
}

async function gql(query, variables = {}, { mutation = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "project-access-token": token, "content-type": "application/json", accept: "application/json" },
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
    if (body?.errors?.length) throw new Error(describeErrors(body.errors));
    if (!response.ok || !body?.data) throw new Error(`Railway answered ${response.status}: ${text.slice(0, 300)}`);
    return body.data;
  }
}

function describeErrors(errors) {
  const message = errors.map((error) => error.message).join("; ");
  if (/project token not found/i.test(message)) {
    return "Railway doesn't know this token. Use a project token: in Railway, open the project, then Settings > Tokens. Account and workspace tokens don't work here.";
  }
  if (/not authorized/i.test(message)) {
    return `Railway refused the request (${message}). The token has to be a project token, from the project's Settings > Tokens.`;
  }
  return `Railway answered: ${message}`;
}

function parseArgs(argv) {
  const parsed = { file: "", dryRun: false, skipDeploys: false, yes: false };
  for (const arg of argv) {
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--skip-deploys") parsed.skipDeploys = true;
    else if (arg === "--yes") parsed.yes = true;
    else if (arg.startsWith("-")) usage(`Unknown option ${arg}.`);
    else if (parsed.file) usage("Give only one file.");
    else parsed.file = arg;
  }
  if (!parsed.file) usage("Name the file that holds the variables.");
  return parsed;
}

function usage(problem) {
  console.error(`${problem}\n\nUsage: node railway-vars.mjs <file> [--dry-run] [--skip-deploys] [--yes]`);
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
    process.stdout.write(`\n${changedSomething ? "Stopped." : "Nothing changed."}\n`);
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

function listNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
