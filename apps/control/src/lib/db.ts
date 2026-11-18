import { Pool, type PoolConfig } from "pg";

/**
 * The panel's only way into the database: a small pool signed in as
 * lobbystack_control, which can read and nothing else (migration 0153,
 * docs/features/control-panel.md). Before its first query the panel checks
 * that the connection really is that role, unprivileged and read-only, and
 * refuses to show anything otherwise.
 */
export const CONTROL_ROLE = "lobbystack_control";

type Environment = Record<string, string | undefined>;

/**
 * The connection string: LOBBYSTACK_CONTROL_DATABASE_URL when set; else
 * DATABASE_URL with lobbystack_control's name and LOBBYSTACK_CONTROL_PASSWORD
 * when that is set, as the other services build each role's; else DATABASE_URL
 * as it is, which the bootstrap script sets to the role's own.
 */
export function controlDatabaseUrl(env: Environment = process.env): string {
  const explicit = env.LOBBYSTACK_CONTROL_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const base = env.DATABASE_URL?.trim();
  if (!base) throw new Error("Set DATABASE_URL, or LOBBYSTACK_CONTROL_DATABASE_URL, to reach the database as lobbystack_control.");
  const password = env.LOBBYSTACK_CONTROL_PASSWORD;
  if (!password) return base;
  const url = new URL(base);
  url.username = CONTROL_ROLE;
  url.password = password;
  return url.toString();
}

/** LOBBYSTACK_CONTROL_POOL_MAX, else 3: the role takes 6 connections at most, and a release runs two copies for a moment. */
export function controlPoolMax(env: Environment = process.env): number {
  const raw = env.LOBBYSTACK_CONTROL_POOL_MAX?.trim();
  if (!raw) return 3;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error(`LOBBYSTACK_CONTROL_POOL_MAX must be a whole number from 1 to 6, not "${raw}".`);
  return value;
}

export function controlPoolConfig(env: Environment = process.env): PoolConfig {
  return {
    connectionString: controlDatabaseUrl(env),
    application_name: "lobbystack:control",
    max: controlPoolMax(env),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    // Months and days are counted in UTC, which the pages say.
    options: "-c TimeZone=UTC",
  };
}

/** Anything that runs a query: the pool, or one of its connections. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

type RoleRow = { role: string; privileged: boolean; read_only: string };

/** Why this connection must not serve the panel, or null when it may. */
export function roleProblem(row: RoleRow | undefined): string | null {
  if (!row) return "the database didn't say which role the panel signed in as";
  if (row.role !== CONTROL_ROLE) return `the panel signed in as ${row.role}, and it reads the database only as ${CONTROL_ROLE}`;
  if (row.privileged) return `${CONTROL_ROLE} has a privilege it must not have (superuser, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION)`;
  if (row.read_only !== "on") return `${CONTROL_ROLE}'s sessions don't start read-only; run the migrations (0153)`;
  return null;
}

export async function checkRole(db: Queryable): Promise<void> {
  const { rows } = await db.query(`
    select current_user as role,
      (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication) as privileged,
      current_setting('transaction_read_only') as read_only
    from pg_roles r where r.rolname = current_user
  `);
  const problem = roleProblem(rows[0] as RoleRow | undefined);
  if (problem) throw new Error(`The control panel won't read the database: ${problem}.`);
}

type Holder = { pool?: Pool; checked?: Promise<void> | undefined };
// One pool per process, kept across the development server's reloads.
const holder = ((globalThis as { __lobbystackControl?: Holder }).__lobbystackControl ??= {});

/** The pool, once its role checks out. A failed check is tried again on the next request. */
export async function database(): Promise<Queryable> {
  holder.pool ??= new Pool(controlPoolConfig());
  holder.checked ??= checkRole(holder.pool).catch((error: unknown) => {
    holder.checked = undefined;
    throw error;
  });
  await holder.checked;
  return holder.pool;
}
