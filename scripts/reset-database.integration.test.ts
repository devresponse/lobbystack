import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { createDatabaseClient, type DatabaseClient } from "@lobbystack/db";
import { createRedisConnection } from "@lobbystack/jobs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// devops/reset-database.mjs against databases of its own: one migrated from scratch, filled,
// then reset, which must leave it as the fresh migration left it. CI's database job opts in with
// a superuser URL on its local server, where the test may create and drop databases. Never set it
// anywhere else.
const adminUrl = process.env.LOBBYSTACK_RESET_TEST_DATABASE_URL;
if (adminUrl && (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(adminUrl).hostname))) {
  throw new Error("The reset test needs a superuser on a local PostgreSQL server.");
}
const redisUrl = process.env.REDIS_TEST_URL;
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("../devops/reset-database.mjs", import.meta.url));
const suffix = randomBytes(4).toString("hex");
const database = `reset_check_${suffix}`;
const foreignDatabase = `reset_foreign_${suffix}`;
const redisPrefix = `reset-check-${suffix}`;

function databaseUrl(name: string, credentials?: { user: string; password: string }): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

function reset(url: string, args: string[], input = "") {
  const run = spawnSync(process.execPath, [script, url, ...args], { cwd: root, encoding: "utf8", input, timeout: 60_000 });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

/** The script run without blocking, so a stand-in server in this process can answer it. */
function resetAsync(url: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, url, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });
}

// Every table's row count, every sequence's state, both migration histories and the database's
// own settings: what a reset must give back exactly as a fresh migration left it.
async function fingerprint(client: DatabaseClient): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const tables = await client.pool.query<{ schema: string; name: string }>(`
    select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'
    order by 1, 2
  `);
  for (const { schema, name } of tables.rows) {
    const count = await client.pool.query<{ n: string }>(`select count(*)::text as n from "${schema}"."${name}"`);
    result[`table ${schema}.${name}`] = count.rows[0]!.n;
  }
  const sequences = await client.pool.query<{ schema: string; name: string }>(`
    select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'S' and n.nspname not like 'pg\\_%'
    order by 1, 2
  `);
  for (const { schema, name } of sequences.rows) {
    const state = await client.pool.query<{ state: string }>(`select last_value || ',' || is_called as state from "${schema}"."${name}"`);
    result[`sequence ${schema}.${name}`] = state.rows[0]!.state;
  }
  const histories = await client.pool.query<{ lobbystack: string; drizzle: string; settings: string }>(`
    select
      (select string_agg(name || ':' || checksum || ':' || applied_at, ',' order by name) from public.__lobbystack_migrations) as lobbystack,
      (select string_agg(id || ':' || hash || ':' || created_at, ',' order by id) from drizzle.__drizzle_migrations) as drizzle,
      (select coalesce(string_agg(array_to_string(s.setconfig, ';'), '|'), '') from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase where d.datname = current_database()) as settings
  `);
  Object.assign(result, histories.rows[0]);
  return result;
}

// Rows across the tables an account, a business and its work touch, as the app writes them.
const FILL = `
  insert into public.businesses (id, slug, name, timezone, business_type) values
    ('11111111-1111-4111-8111-111111111111', 'reset-plumbing', 'Reset Plumbing', 'America/Toronto', 'service_company'),
    ('22222222-2222-4222-8222-222222222222', 'reset-salon', 'Reset Salon', 'America/Toronto', 'service_company');
  insert into public.users (id, email, normalized_email, email_verified) values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'reset-owner@example.invalid', 'reset-owner@example.invalid', true),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'reset-viewer@example.invalid', 'reset-viewer@example.invalid', false);
  insert into public.accounts (user_id, provider_id, account_id, password) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'credential', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'hash');
  insert into public.sessions (token, user_id, expires_at) values ('reset-session', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now() + interval '30 days');
  insert into public.verifications (identifier, value, expires_at) values ('reset-verification', 'code', now() + interval '1 hour');
  insert into public.business_memberships (business_id, user_id, role) values
    ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'business_owner'),
    ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'business_owner'),
    ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'viewer');
  insert into public.services (business_id, name, slug, duration_minutes) values ('11111111-1111-4111-8111-111111111111', 'Drain cleaning', 'drain-cleaning', 60);
  insert into public.contacts (business_id) values ('11111111-1111-4111-8111-111111111111');
  insert into public.conversations (id, business_id, channel) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111', 'sms');
  insert into public.messages (business_id, conversation_id, direction, channel, body) values ('11111111-1111-4111-8111-111111111111', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'inbound', 'sms', 'Hello');
  insert into public.calls (business_id, provider_call_id, transport, started_at) values ('11111111-1111-4111-8111-111111111111', 'CA-reset', 'twilio', now());
  insert into public.phone_numbers (business_id, e164, status) values ('11111111-1111-4111-8111-111111111111', '+15145550100', 'active');
  insert into public.billing_accounts (business_id, billing_key, customer_id, subscription_id, subscription_state) values ('11111111-1111-4111-8111-111111111111', 'reset-billing-key', 'cus_reset', 'sub_reset', 'active');
  insert into public.billing_accounts (business_id, billing_key, source, customer_id, subscription_id, subscription_state, overage_subscription_id) values ('22222222-2222-4222-8222-222222222222', 'reset-stripe-key', 'stripe', 'cus_stripereset', 'sub_stripeplan', 'active', 'sub_stripeoverage');
  insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account) values ('verify', 'passed', 'alloplace', 1, repeat('a', 64), '{}', 'polar', 'sandbox', 'org_reset');
  insert into public.deployment_branding (id, app_name, saved_by_user_id) values (1, 'Reset Brand', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  insert into public.storage_objects (business_id, object_key, purpose, file_name, content_type) values ('11111111-1111-4111-8111-111111111111', 'reset/doc.pdf', 'knowledge_document', 'doc.pdf', 'application/pdf');
  insert into public.audit_logs (business_id, event_type, entity_type) values ('11111111-1111-4111-8111-111111111111', 'business.created', 'business');
  insert into public.knowledge_documents (business_id, source_type, title) values ('11111111-1111-4111-8111-111111111111', 'text', 'Hours');
`;

describe.skipIf(!adminUrl)("devops/reset-database.mjs", () => {
  let admin: DatabaseClient;
  let target: DatabaseClient;
  let fresh: Record<string, string>;
  const businesses = async () => Number((await target.pool.query<{ n: string }>("select count(*) as n from public.businesses")).rows[0]!.n);

  beforeAll(async () => {
    admin = createDatabaseClient("lobbystack_migrator", { DATABASE_URL: adminUrl! });
    await admin.pool.query(`create database "${database}"`);
    await admin.pool.query(`create database "${foreignDatabase}"`);
    const migrate = spawnSync("pnpm", ["--filter", "@lobbystack/db", "db:migrate"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl(database), LOBBYSTACK_MIGRATOR_DATABASE_URL: databaseUrl(database), LOBBYSTACK_SKIP_ENV_FILES: "true" },
    });
    expect(migrate.status, `${migrate.stdout}${migrate.stderr}`).toBe(0);
    target = createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl(database) });
    fresh = await fingerprint(target);
    await target.pool.query(FILL);
  }, 180_000);

  afterAll(async () => {
    await target?.pool.end();
    if (admin) {
      await admin.pool.query(`drop database if exists "${database}" with (force)`);
      await admin.pool.query(`drop database if exists "${foreignDatabase}" with (force)`);
      await admin.pool.end();
    }
  });

  it("shows what a dry run would delete, and deletes nothing", async () => {
    const run = reset(databaseUrl(database), ["--dry-run"]);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("2 businesses: Reset Plumbing, Reset Salon");
    expect(run.out).toContain("1 phone number bought in Twilio: +15145550100");
    expect(run.out).toContain("1 live Polar subscription");
    // The script wraps its lines at 100 characters.
    const text = run.out.replace(/\s+/g, " ");
    expect(text).toContain("1 live Stripe subscription by this database's records");
    expect(text).toContain("Set STRIPE_READ_KEY to a key that reads subscriptions, and the script lists them.");
    expect(run.out).toContain("Dry run: nothing was deleted.");
    expect(await businesses()).toBe(2);
  });

  it("lists the subscriptions Stripe still bills, with STRIPE_READ_KEY", async () => {
    const asked: string[] = [];
    const stripe = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://stripe.test");
      asked.push(`${request.headers.authorization} ${url.pathname} ${url.searchParams.get("customer")} ${url.searchParams.get("status")}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", has_more: false, data: [{ id: "sub_stripeplan", status: "active" }, { id: "sub_stripeoverage", status: "active" }, { id: "sub_old", status: "canceled" }] }));
    });
    await new Promise<void>((resolve) => stripe.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = stripe.address() as AddressInfo;
      const run = await resetAsync(databaseUrl(database), ["--dry-run"], { STRIPE_READ_KEY: "rk_test_resetreadkey", RESET_STRIPE_API_URL: `http://127.0.0.1:${port}/v1` });
      expect(run.status, run.out).toBe(0);
      const text = run.out.replace(/\s+/g, " ");
      expect(text).toContain("2 subscriptions Stripe still bills: sub_stripeplan (cus_stripereset, active), sub_stripeoverage (cus_stripereset, active).");
      expect(text).not.toContain("by this database's records");
      expect(run.out).not.toContain("sub_old");
      expect(run.out).not.toContain("rk_test_resetreadkey");
      expect(asked).toEqual(["Bearer rk_test_resetreadkey /v1/subscriptions cus_stripereset all"]);
    } finally {
      await new Promise((resolve) => stripe.close(resolve));
    }
  });

  it("deletes nothing unless the database's name is given", async () => {
    const typed = reset(databaseUrl(database), [], "railway\n");
    expect(typed.status, typed.out).toBe(1);
    expect(typed.out).toContain(`"railway" isn't ${database}.`);
    const flag = reset(databaseUrl(database), ["--confirm", "railway"]);
    expect(flag.status, flag.out).toBe(1);
    expect(flag.out).toContain(`--confirm names railway, but this database is ${database}.`);
    expect(await businesses()).toBe(2);
  });

  it("refuses a protected database until the protection is taken off", async () => {
    expect(reset(databaseUrl(database), ["--protect"]).status).toBe(0);
    const refused = reset(databaseUrl(database), ["--confirm", database]);
    expect(refused.status, refused.out).toBe(1);
    expect(refused.out).toContain("is protected against resets");
    expect(await businesses()).toBe(2);
    const unprotected = reset(databaseUrl(database), ["--unprotect", "--confirm", database]);
    expect(unprotected.status, unprotected.out).toBe(0);
    expect((await fingerprint(target)).settings).toBe("");
  });

  it("refuses a database linked to Polar's live organization", async () => {
    await target.pool.query("insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account) values ('verify', 'passed', 'alloplace', 1, repeat('b', 64), '{}', 'polar', 'live', 'org_live')");
    try {
      const run = reset(databaseUrl(database), ["--confirm", database]);
      expect(run.status, run.out).toBe(1);
      expect(run.out).toContain("--allow-live-payments");
      expect(await businesses()).toBe(2);
    } finally {
      await target.pool.query("delete from public.billing_runs where provider = 'polar' and provider_env = 'live'");
    }
  });

  it("refuses a database linked to Stripe's live mode", async () => {
    await target.pool.query("insert into public.billing_runs (kind, status, brand, ver, hash, profile, provider, provider_env, provider_account) values ('verify', 'passed', 'alloplace', 1, repeat('c', 64), '{}', 'stripe', 'live', 'acct_live')");
    try {
      const run = reset(databaseUrl(database), ["--confirm", database]);
      expect(run.status, run.out).toBe(1);
      expect(run.out).toContain("a billing provider's live account");
      expect(await businesses()).toBe(2);
    } finally {
      await target.pool.query("delete from public.billing_runs where provider = 'stripe'");
    }
  });

  it.skipIf(!process.env.LOBBYSTACK_APP_PASSWORD)("refuses a user that row level security limits", async () => {
    const run = reset(databaseUrl(database, { user: "lobbystack_app", password: process.env.LOBBYSTACK_APP_PASSWORD! }), ["--confirm", database]);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("isn't a superuser");
    expect(await businesses()).toBe(2);
  });

  it("refuses a database without LobbyStack's migration history", () => {
    const run = reset(databaseUrl(foreignDatabase), ["--confirm", foreignDatabase]);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("isn't a LobbyStack database");
  });

  it("leaves the database as a fresh migration leaves it, and only the deployment's Redis keys go", async () => {
    const redis = redisUrl ? createRedisConnection({ url: redisUrl }) : undefined;
    try {
      if (redis) {
        await redis.connect();
        await redis.set(`${redisPrefix}:better-auth:reset-session`, "{}");
        await redis.hset(`${redisPrefix}:jobs:meta`, "paused", "0");
        await redis.set(`${redisPrefix}-other:keep`, "1");
      }
      const run = reset(databaseUrl(database), ["--confirm", database, ...(redis ? ["--redis", redisUrl!, "--redis-prefix", redisPrefix] : [])]);
      expect(run.status, run.out).toBe(0);
      expect(run.out).toContain("Emptied");
      expect(await fingerprint(target)).toEqual(fresh);
      if (redis) {
        expect(run.out).toContain(`Deleted 2 Redis keys under ${redisPrefix}:.`);
        expect(await redis.exists(`${redisPrefix}:better-auth:reset-session`, `${redisPrefix}:jobs:meta`)).toBe(0);
        expect(await redis.get(`${redisPrefix}-other:keep`)).toBe("1");
      }
    } finally {
      await redis?.del(`${redisPrefix}-other:keep`);
      redis?.disconnect();
    }
  });
});
