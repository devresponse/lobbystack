// reset-database.mjs: empties a test deployment's database so it looks freshly migrated, with no
// accounts, businesses or settings, to test the deployment from its first sign-up again.
//
// Run it from the LobbyStack folder, after `pnpm install`, with Node 18 or later:
//   node devops/reset-database.mjs [<connection string>] [options]
//
// Leave the connection string out to paste it at a prompt with typing hidden, which keeps its
// password out of the shell's history. On Railway it's the Postgres service's
// DATABASE_PUBLIC_URL; its DATABASE_URL works only inside Railway. Options:
//   --dry-run              show what would be deleted, and delete nothing
//   --redis [<url>]        also delete the deployment's keys in this Redis: sign-ins, rate limits
//                          and queued jobs. On Railway, the Redis service's REDIS_PUBLIC_URL.
//                          Without the URL it asks for it, with typing hidden
//   --redis-prefix <name>  the deployment's REDIS_PREFIX, when it isn't lobbystack
//   --confirm <database>   answer the question below with this database name, for a run where
//                          nobody can type
//   --allow-live-payments  reset a database linked to Polar's live organization anyway
//   --protect              mark the database so this script refuses to reset it, and stop
//   --unprotect            take that mark off, and stop
//
// It empties every table in the public, app and drizzle schemas except the two migration
// histories, public.__lobbystack_migrations and drizzle.__drizzle_migrations. Those are the only
// tables a fresh migration puts rows in, so afterwards the database matches one that was just
// migrated: the first sign-up picks the deployment's name and logo again, and the plans wait for
// a `pnpm billing apply`. The tables, functions, policies and grants stay, the database's roles
// and their passwords too, and so does everything outside the database: numbers bought in
// Twilio, subscriptions in Polar, files in the storage bucket, and Redis unless --redis is given.
// scripts/reset-database.integration.test.ts checks the result against a fresh migration in CI.
//
// It refuses a database without LobbyStack's migration history, a user that isn't a superuser
// (or BYPASSRLS: row level security would hide rows from what it shows), a database marked with
// --protect, and one linked to Polar's live organization, unless --allow-live-payments. Before
// it deletes anything it shows what the database holds and asks for the database's name.

import { createRequire } from "node:module";
import readline from "node:readline";

// A fresh migration leaves rows in these two tables and in no other.
const KEPT_TABLES = ["public.__lobbystack_migrations", "drizzle.__drizzle_migrations"];
// The schemas LobbyStack's migrations create. Tables elsewhere are left alone.
const APP_SCHEMAS = ["public", "app", "drizzle"];
// A database setting, so the mark stays with the database and needs no table.
const PROTECTION_SETTING = "lobbystack.reset_protection";
// packages/shared/src/billing.ts, liveSubscriptionStates.
const LIVE_SUBSCRIPTION_STATES = ["active", "trialing", "past_due"];
// The lock packages/db/src/cli.ts holds while it migrates.
const MIGRATION_LOCK = "lobbystack:migrations";
const ASK = Symbol("ask");

class Refusal extends Error {}

const options = parseArgs(process.argv.slice(2));
let prompter = null;
let databaseEmptied = false;

main()
  .catch((error) => {
    console.error(`\n${error instanceof Refusal ? "Refused" : "Stopped"}: ${error.message}`);
    console.error(databaseEmptied
      ? "The database was emptied before this; only Redis was left as it was."
      : "Nothing was deleted.");
    process.exitCode = 1;
  })
  .finally(() => prompter?.close());

async function main() {
  const pg = loadPackage("pg", "packages/db");
  const connectionString = options.url || (await ask("Connection string (typing is hidden): ", { hidden: true }));
  if (!connectionString) throw new Refusal("no connection string given.");
  if (!/^postgres(ql)?:\/\//i.test(connectionString)) {
    throw new Refusal("that isn't a connection string. It looks like postgresql://user:password@host:port/database.");
  }

  let client;
  try {
    client = new pg.Client({ connectionString, application_name: "lobbystack:reset-database", connectionTimeoutMillis: 15_000 });
  } catch (error) {
    throw new Refusal(`that connection string doesn't read right (${error.message}). It looks like postgresql://user:password@host:port/database.`);
  }
  const server = `${client.host}:${client.port}`;
  try {
    await client.connect();
  } catch (error) {
    throw new Error(connectionProblem(error, server));
  }
  // An idle connection the server drops makes an error event; the next query reports it.
  client.on("error", () => {});

  let redis = null;
  try {
    const facts = await readFacts(client);
    const database = facts.database;
    console.log(`\nDatabase  ${database} on ${server}, signed in as ${facts.user}`);
    if (!facts.lobbystack) {
      throw new Refusal(`${database} has no public.__lobbystack_migrations table, so it isn't a LobbyStack database. Check the connection string.`);
    }
    if (!facts.superuser && !facts.bypassrls) {
      throw new Refusal(`${facts.user} isn't a superuser, so row level security would hide rows from it. Use the connection string of the user that runs the migrations, postgres on Railway.`);
    }
    const history = await client.query("select count(*)::int as migrations, max(name) as latest from public.__lobbystack_migrations");
    const { migrations, latest } = history.rows[0];
    console.log(`History   ${plural(migrations, "migration")} applied${latest ? `, the latest ${latest}` : ""}`);

    if (options.protect) return await protect(client, facts);
    if (options.unprotect) return await unprotect(client, facts);
    if (facts.protected) {
      throw new Refusal(`${database} is protected against resets: someone ran this script on it with --protect. If it really is a test database, run the script with --unprotect first.`);
    }

    // A billing run against Polar production: only a deployment that takes real payments has one.
    const live = (await queryOrNull(client, "select exists (select 1 from public.billing_runs where polar_env = 'production') as live"))?.[0]?.live === true;
    if (live && !options.allowLivePayments) {
      throw new Refusal(`${database} was linked to Polar's live organization, so it takes real payments and looks like production. If it really is a test copy, run the script again with --allow-live-payments.`);
    }

    const tables = await listTables(client);
    const counts = await countRows(client, tables.emptied);
    if (options.redis) {
      const url = options.redis === ASK ? await ask("Redis URL (typing is hidden): ", { hidden: true }) : options.redis;
      if (!/^rediss?:\/\//i.test(url)) throw new Refusal("that isn't a Redis URL. It looks like redis://default:password@host:port.");
      redis = await openRedis(url);
    }
    const redisKeys = redis ? await scanKeys(redis, options.redisPrefix) : null;

    await describe(client, { tables, counts, live, redis, redisKeys });
    if (options.dryRun) {
      console.log("\nDry run: nothing was deleted.");
      return;
    }
    await confirm(database, "to delete all of this");

    await emptyTables(client, tables);
    databaseEmptied = true;
    const rowsDeleted = [...counts.values()].reduce((sum, count) => sum + count, 0);
    console.log(`\nEmptied ${plural(tables.emptied.length, "table")} (${plural(rowsDeleted, "row")} deleted) and kept the migration history.`);
    if (redis) {
      const removed = await deleteKeys(redis, options.redisPrefix);
      console.log(`Deleted ${plural(removed, "Redis key")} under ${options.redisPrefix}:.`);
    }
    printNextSteps(Boolean(redis));
  } finally {
    await client.end().catch(() => {});
    redis?.disconnect();
  }
}

async function readFacts(client) {
  const { rows } = await client.query(`
    select current_database() as database, current_user as "user",
           r.rolsuper as superuser, r.rolbypassrls as bypassrls,
           to_regclass('public.__lobbystack_migrations') is not null as lobbystack,
           exists (
             select 1 from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
             where d.datname = current_database() and s.setrole = 0 and $1 = any (s.setconfig)
           ) as protected
    from pg_roles r
    where r.rolname = current_user
  `, [`${PROTECTION_SETTING}=on`]);
  return rows[0];
}

async function protect(client, facts) {
  if (facts.protected) {
    console.log(`\n${facts.database} is already protected: this script refuses to reset it.`);
    return;
  }
  await client.query(`alter database ${quoteIdent(facts.database)} set ${PROTECTION_SETTING} = 'on'`);
  console.log(`\nProtected ${facts.database}: this script now refuses to reset it. Nothing else changed.`);
}

async function unprotect(client, facts) {
  if (!facts.protected) {
    console.log(`\n${facts.database} isn't protected, so there was nothing to take off.`);
    return;
  }
  console.log(`\n${facts.database} is protected. Taking the mark off lets this script delete everything in it.`);
  await confirm(facts.database, "to take the protection off");
  await client.query(`alter database ${quoteIdent(facts.database)} reset ${PROTECTION_SETTING}`);
  console.log(`\nTook the protection off ${facts.database}. Nothing else changed.`);
}

// Every table in LobbyStack's schemas but the migration histories, and the sequences no table
// owns: TRUNCATE's RESTART IDENTITY covers the ones that belong to an emptied table.
async function listTables(client) {
  const { rows } = await client.query(`
    select n.nspname as schema, c.relname as name, n.nspname = any ($1) as app
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not c.relispartition
      and n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
    order by 1, 2
  `, [APP_SCHEMAS]);
  const kept = [];
  const emptied = [];
  const elsewhere = [];
  for (const row of rows) {
    const table = { schema: row.schema, name: row.name, label: `${row.schema}.${row.name}` };
    if (!row.app) elsewhere.push(table);
    else if (KEPT_TABLES.includes(table.label)) kept.push(table);
    else emptied.push(table);
  }
  const sequences = await client.query(`
    select n.nspname as schema, c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'S' and n.nspname = any ($1)
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a', 'i', 'e'))
      and not exists (
        select 1
        from pg_depend d
        join pg_attrdef ad on ad.oid = d.objid
        join pg_class t on t.oid = ad.adrelid
        join pg_namespace tn on tn.oid = t.relnamespace
        where d.classid = 'pg_attrdef'::regclass and d.refobjid = c.oid and tn.nspname || '.' || t.relname = any ($2)
      )
    order by 1, 2
  `, [APP_SCHEMAS, KEPT_TABLES]);
  return { kept, emptied, elsewhere, sequences: sequences.rows.map((row) => ({ ...row, label: `${row.schema}.${row.name}` })) };
}

async function countRows(client, tables) {
  const counts = new Map();
  if (tables.length === 0) return counts;
  const { rows } = await client.query(tables
    .map((table, index) => `select ${index} as i, count(*)::bigint as n from ${qualified(table)}`)
    .join(" union all "));
  for (const row of rows) counts.set(tables[row.i].label, Number(row.n));
  return counts;
}

// What the database holds, and what outlives the reset. The detail queries name tables and
// columns; one that a later migration breaks only drops its line.
async function describe(client, { tables, counts, live, redis, redisKeys }) {
  const count = (name) => counts.get(`public.${name}`) ?? 0;
  const rows = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const filled = tables.emptied.filter((table) => counts.get(table.label) > 0);

  console.log("\nIt holds");
  const businesses = await queryOrNull(client, "select name from public.businesses order by created_at, name limit 6");
  const names = businesses?.map((row) => row.name) ?? [];
  const more = count("businesses") - names.length;
  console.log(`  ${plural(count("businesses"), "business", "businesses")}${names.length ? `: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : ""}`);
  console.log(`  ${plural(count("users"), "user")}`);
  const largest = [...filled].sort((a, b) => counts.get(b.label) - counts.get(a.label)).slice(0, 4);
  console.log(`  ${plural(rows, "row")} in ${filled.length} of ${plural(tables.emptied.length, "table")}${largest.length ? `, most in ${largest.map((table) => `${table.name} (${number(counts.get(table.label))})`).join(", ")}` : ""}`);
  if (live) console.log("  a link to Polar's live organization (--allow-live-payments was given)");
  if (redis) console.log(`  ${plural(redisKeys.length, "Redis key")} under ${options.redisPrefix}: on ${redis.options.host}:${redis.options.port}`);

  const outside = [];
  // Every number Twilio still has: being bought, in use, or being released. A released one is 'reclaimed'.
  const numbers = await queryOrNull(client, "select e164 from public.phone_numbers where status in ('provisioning', 'active', 'reclaiming') order by created_at");
  if (numbers?.length) {
    const one = numbers.length === 1;
    const shown = numbers.slice(0, 8).map((row) => row.e164).join(", ");
    outside.push(`${plural(numbers.length, "phone number")} bought in Twilio: ${shown}${numbers.length > 8 ? ` and ${numbers.length - 8} more` : ""}. ${one ? "It keeps" : "They keep"} costing money and ringing this deployment, which won't know ${one ? "it" : "them"}: release ${one ? "it" : "them"} first with pnpm lobbystack numbers release (deployment guide, 7.21), or in Twilio's console after the reset.`);
  }
  const subscriptions = await queryOrNull(client, "select count(*)::int as n from public.billing_accounts where subscription_id is not null and subscription_state = any ($1)", [LIVE_SUBSCRIPTION_STATES]);
  if (subscriptions?.[0]?.n > 0) {
    const n = subscriptions[0].n;
    outside.push(`${plural(n, "live Polar subscription")}. Cancel ${n === 1 ? "it" : "them"} in Polar's dashboard, or Polar keeps billing ${n === 1 ? "it" : "them"} (on the sandbox, with test cards).`);
  }
  if (count("storage_objects") > 0) {
    const one = count("storage_objects") === 1;
    outside.push(`${plural(count("storage_objects"), "file")} in the storage bucket: recordings, documents and uploads. Nothing will refer to ${one ? "it" : "them"}; empty the bucket to remove ${one ? "it" : "them"}.`);
  }
  if (!redis) {
    outside.push("Redis: sign-ins, rate limits and queued jobs. A browser signed in now would stay signed in as an account that's gone. Add --redis to delete them too.");
  }
  if (tables.elsewhere.length) {
    outside.push(`${plural(tables.elsewhere.length, "table")} outside the public, app and drizzle schemas: ${tables.elsewhere.slice(0, 5).map((table) => table.label).join(", ")}${tables.elsewhere.length > 5 ? " and more" : ""}.`);
  }
  if (outside.length) {
    console.log("\nThe reset leaves these as they are");
    for (const line of outside) console.log(wrap(`! ${line}`, "  ", "    "));
  }

  console.log("");
  console.log(wrap(`The reset empties ${tables.emptied.length === 1 ? "that table" : `those ${tables.emptied.length} tables`}. It keeps the tables themselves, the database's roles and the migration history, so the database looks freshly migrated: no accounts, no businesses, no settings, no plans.`, "", ""));
}

async function emptyTables(client, tables) {
  if (tables.emptied.length === 0) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query("begin");
      // Waits behind a running transaction, but not forever; a migration in progress stops the reset.
      await client.query("set local lock_timeout = '10s'");
      const lock = await client.query("select pg_try_advisory_xact_lock(hashtext($1)) as locked", [MIGRATION_LOCK]);
      if (!lock.rows[0].locked) throw new Refusal("a migration is running. Run the script again once it has finished.");
      // TRUNCATE skips row level security and CASCADE isn't needed: every table that refers to
      // an emptied table is emptied too, and Postgres refuses the statement if one isn't.
      await client.query(`truncate table ${tables.emptied.map(qualified).join(", ")} restart identity`);
      for (const sequence of tables.sequences) await client.query(`alter sequence ${qualified(sequence)} restart`);
      // Until COMMIT nothing else can write to these tables, so this proves that every table but
      // the migration histories is empty when the reset lands.
      const now = await listTables(client);
      const added = now.emptied.filter((table) => !tables.emptied.some((other) => other.label === table.label));
      if (added.length) throw new Error(`${added.map((table) => table.label).join(", ")} appeared while the script ran. Run it again.`);
      const counts = await countRows(client, now.emptied);
      const left = now.emptied.filter((table) => counts.get(table.label) > 0);
      if (left.length) throw new Error(`${left.map((table) => table.label).join(", ")} still had rows after the reset.`);
      await client.query("commit");
      return;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      const busy = error.code === "55P03" || error.code === "40P01";
      if (busy && attempt < 3) {
        console.log("A table was busy; trying again in a few seconds.");
        await sleep(3000);
        continue;
      }
      if (busy) throw new Error("the admin or the worker kept a table busy. Try again when the deployment is quiet, or stop them first.");
      throw error;
    }
  }
}

function printNextSteps(redisCleared) {
  const steps = [
    "Redeploy the admin and the worker, so neither keeps anything from before in memory.",
    ...(redisCleared ? [] : ["Sign out in every browser that was signed in, or run the script again with --redis: Redis still holds the old sign-ins."]),
    "Sign up. The first account to finish onboarding picks the deployment's name and logo.",
    "Only if the deployment sells plans: sign up with the operator key's email and enter the emailed code, then run `pnpm billing apply --brand <brand> --polar sandbox` again, which finds Polar's products by their tags.",
  ];
  console.log("\nNext");
  steps.forEach((step, index) => console.log(wrap(`${index + 1}. ${step}`, "  ", "     ")));
}

async function confirm(database, purpose) {
  if (options.confirm !== undefined) {
    if (options.confirm !== database) throw new Refusal(`--confirm names ${options.confirm}, but this database is ${database}.`);
    console.log(`\nConfirmed with --confirm ${database}.`);
    return;
  }
  const answer = await ask(`\nType the database's name, ${database}, ${purpose}: `);
  // Without the reader, Ctrl+C during the reset ends the script the usual way, and Postgres
  // undoes a reset that hadn't finished.
  prompter?.close();
  prompter = null;
  if (answer !== database) throw new Refusal(answer ? `"${answer}" isn't ${database}.` : "no name was typed.");
}

async function openRedis(url) {
  const module = loadPackage("ioredis", "packages/jobs");
  const Redis = module.Redis ?? module.default ?? module;
  // RESP2, as packages/jobs uses; one try per command, so a wrong URL fails at once.
  const redis = new Redis(url, {
    protocol: 2,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 10_000,
    retryStrategy: () => null,
    connectionName: "lobbystack:reset-database",
  });
  // ioredis reports why a connection failed as an event, and the failed command only as closed.
  let cause = null;
  redis.on("error", (error) => {
    cause = error;
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    redis.disconnect();
    throw new Error(`couldn't use Redis at ${redis.options.host}:${redis.options.port} (${(cause ?? error).message}).`);
  }
  return redis;
}

// The admin and the worker put every key under REDIS_PREFIX, so other keys in the same Redis stay.
async function scanKeys(redis, prefix) {
  const pattern = `${prefix.replace(/[*?[\]\\]/g, "\\$&")}:*`;
  const keys = new Set();
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 1000);
    for (const key of batch) keys.add(key);
    cursor = next;
  } while (cursor !== "0");
  return [...keys];
}

// Scans again, so keys written since the count go too.
async function deleteKeys(redis, prefix) {
  const keys = await scanKeys(redis, prefix);
  let removed = 0;
  for (let start = 0; start < keys.length; start += 500) {
    removed += await redis.unlink(...keys.slice(start, start + 500));
  }
  return removed;
}

async function queryOrNull(client, text, values) {
  try {
    return (await client.query(text, values)).rows;
  } catch {
    return null;
  }
}

function loadPackage(name, workspacePackage) {
  for (const base of [new URL(`../${workspacePackage}/package.json`, import.meta.url), import.meta.url]) {
    try {
      return createRequire(base)(name);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`can't find the ${name} package. Run pnpm install in the LobbyStack folder, then run this script from there: it uses the ${name} that ${workspacePackage} installs.`);
}

function connectionProblem(error, server) {
  const message = error.message ?? String(error);
  if (/self[- ]signed|certificate/i.test(message)) {
    return `couldn't check ${server}'s certificate (${message}). For a server with its own certificate, as on Railway, end the connection string with ?sslmode=no-verify.`;
  }
  if (/no encryption|SSL off|requires SSL|SSL connection is required/i.test(message)) {
    return `${server} asks for an encrypted connection (${message}). End the connection string with ?sslmode=no-verify.`;
  }
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
    return /\.railway\.internal:/i.test(server)
      ? `can't reach ${server}: a *.railway.internal address works only inside Railway. Use the Postgres service's DATABASE_PUBLIC_URL.`
      : `can't find the server ${server}. Check the connection string.`;
  }
  return `couldn't connect to ${server} (${message}).`;
}

function parseArgs(argv) {
  const parsed = { url: "", dryRun: false, redis: "", redisPrefix: "lobbystack", confirm: undefined, allowLivePayments: false, protect: false, unprotect: false };
  const takesValue = { "--redis": "redis", "--redis-prefix": "redisPrefix", "--confirm": "confirm" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flag === "--redis" && inline === undefined && !/^rediss?:\/\//i.test(argv[index + 1] ?? "")) {
      // --redis on its own asks for the URL, which holds a password, with typing hidden.
      parsed.redis = ASK;
    } else if (flag in takesValue) {
      const value = inline ?? argv[++index];
      if (value === undefined || value === "") usage(`${flag} needs a value.`);
      parsed[takesValue[flag]] = value;
    } else if (inline !== undefined) usage(`${flag} takes no value.`);
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--allow-live-payments") parsed.allowLivePayments = true;
    else if (arg === "--protect") parsed.protect = true;
    else if (arg === "--unprotect") parsed.unprotect = true;
    else if (arg === "--help" || arg === "-h") usage("", 0);
    else if (arg.startsWith("-")) usage(`Unknown option ${arg}.`);
    else if (parsed.url) usage("Give only one connection string.");
    else parsed.url = arg;
  }
  if (parsed.protect && parsed.unprotect) usage("Give --protect or --unprotect, not both.");
  if ((parsed.protect || parsed.unprotect) && (parsed.redis || parsed.dryRun || parsed.allowLivePayments)) {
    usage("--protect and --unprotect only mark the database; give them on their own.");
  }
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(parsed.redisPrefix)) usage("--redis-prefix takes letters, digits and _ . : - only.");
  return parsed;
}

function usage(problem, code = 2) {
  const text = [
    "Usage: node devops/reset-database.mjs [<connection string>] [--dry-run] [--redis [<url>]] [--redis-prefix <name>]",
    "                                      [--confirm <database>] [--allow-live-payments]",
    "       node devops/reset-database.mjs [<connection string>] --protect | --unprotect",
    "",
    "Empties a test deployment's database so it looks freshly migrated. The comments at the top of",
    "devops/reset-database.mjs, and docs/deployment/guide/part-7-operations.md, say what it keeps.",
  ].join("\n");
  (code === 0 ? console.log : console.error)(problem ? `${problem}\n\n${text}` : text);
  process.exit(code);
}

// One reader for every question, so answers piped in on separate lines all arrive. The prompter
// of devops/railway-vars.mjs, except that input ending while a question waits answers it with
// nothing instead of leaving it open, which with the database connection open would never exit.
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
    if (current) {
      const { resolve } = current;
      current = null;
      process.stdout.write("\n");
      resolve("");
    }
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.stdout.write(`\n${databaseEmptied ? "Stopped." : "Stopped. Nothing was deleted."}\n`);
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
        current = { question, muted: false, resolve };
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

function qualified(table) {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function plural(count, noun, nouns = `${noun}s`) {
  return `${number(count)} ${count === 1 ? noun : nouns}`;
}

function number(value) {
  return Number(value).toLocaleString("en-US");
}

// Wraps a paragraph at 100 columns, with its own indent on the first line and the rest.
function wrap(text, first, rest) {
  const lines = [];
  let line = first;
  for (const word of text.split(/\s+/)) {
    if (line.trim() && `${line} ${word}`.length > 100) {
      lines.push(line);
      line = rest + word;
    } else {
      line = line.trim() ? `${line} ${word}` : line + word;
    }
  }
  lines.push(line);
  return lines.join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
