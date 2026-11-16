import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { getMeter, getTracer, recordException } from "@lobbystack/telemetry/node";

import { rlsContextStatement, type RlsContext } from "./rls/context";
import { schema } from "./schema";
import { instrumentPool } from "./instrumentation";
import { poolMax } from "./pool-budget";
import { trackPool } from "./pool-usage";

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type DatabaseRole =
  | "lobbystack_migrator"
  | "lobbystack_auth"
  | "lobbystack_app"
  | "lobbystack_worker"
  | "lobbystack_dispatcher"
  | "lobbystack_readonly"
  | "lobbystack_finance_export";

export type DatabaseClient = {
  pool: Pool;
  db: Database;
  role: DatabaseRole;
};

const poolWaitHistogram = getMeter("lobbystack-db").createHistogram("db.pool.wait_ms", {
  unit: "ms",
  description: "Time spent waiting for a PostgreSQL pool connection",
});
const queryDurationHistogram = getMeter("lobbystack-db").createHistogram("db.query.duration_ms", {
  unit: "ms",
  description: "PostgreSQL query duration without bind values",
});
const transactionDurationHistogram = getMeter("lobbystack-db").createHistogram("db.transaction.duration_ms", {
  unit: "ms",
  description: "PostgreSQL transaction duration",
});

function databaseUrl(source: Record<string, string | undefined> = process.env): string {
  const value = source.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required for PostgreSQL access.");
  }
  return value;
}

// Resolves a role's connection string: an explicit `<ROLE>_DATABASE_URL` wins; otherwise, when
// `<ROLE>_PASSWORD` is set, reuse DATABASE_URL's host and database with that role's credentials.
// The migrator never derives: the migrate job holds every role password for `bootstrap`, but it must
// connect with DATABASE_URL as given (the superuser on fresh installs).
export function roleDatabaseUrl(role: DatabaseRole, source: Record<string, string | undefined> = process.env): string {
  const explicit = source[`${role.toUpperCase()}_DATABASE_URL`];
  if (explicit) return explicit;
  const base = databaseUrl(source);
  const password = role === "lobbystack_migrator" ? undefined : source[`${role.toUpperCase()}_PASSWORD`];
  if (!password) return base;
  const url = new URL(base);
  url.username = role;
  url.password = password;
  return url.toString();
}

function poolConfig(role: DatabaseRole, source: Record<string, string | undefined>): PoolConfig {
  return {
    connectionString: roleDatabaseUrl(role, source),
    application_name: `lobbystack:${role}`,
    max: poolMax(role, source),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
  };
}

export function createDatabaseClient(
  role: DatabaseRole,
  source: Record<string, string | undefined> = process.env,
): DatabaseClient {
  const pool = new Pool(poolConfig(role, source));
  instrumentPool(pool, role, { query: queryDurationHistogram, wait: poolWaitHistogram });
  trackPool(pool, role);
  pool.on("error", (error) => {
    recordException(error, { service: "database", operation: "pool_error", role });
  });

  const db = drizzle(pool, { schema });
  return { pool, db, role };
}

/** 10, 20 and 40 ms, plus up to half of each again, chosen per attempt. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = 10 * 2 ** attempt;
  return Math.round(base + random() * base * 0.5);
}

/**
 * The errors PostgreSQL raises when it gave up on a transaction rather than on
 * the work it was doing, so re-running the callback is the right answer
 * (AUDIT-016).
 *
 * 40P01 is a deadlock: two transactions each waiting for a lock the other
 * holds, and PostgreSQL ends one of them. Eighty-four explicit row and
 * advisory locks keep that rare, but it does happen, and it used to reach the
 * caller as a 500.
 *
 * 40001 is a serialization failure. No transaction here sets an isolation
 * level, so all run at READ COMMITTED, where it isn't raised for ordinary
 * write conflicts. It stays because it costs nothing and is what a stricter
 * isolation level would raise.
 *
 * Re-running is safe: the callback runs again in full, and the work it leaves
 * behind for other services goes through the outbox, which is written in the
 * same transaction and so is rolled back with it.
 */
const RETRYABLE_TRANSACTION_ERRORS = new Set(["40001", "40P01"]);

export async function withBusinessTransaction<T>(
  db: Database,
  context: RlsContext,
  callback: (tx: DatabaseTransaction) => Promise<T>,
  // "read only" makes PostgreSQL refuse any write, for a read that must change nothing.
  options: { accessMode?: "read only" | "read write" } = {},
): Promise<T> {
  const maxRetries = 3;
  const tracer = getTracer("lobbystack-db");

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const startedAt = Date.now();
    const span = tracer.startSpan("db.transaction", {
      attributes: {
        "db.system": "postgresql",
        "db.operation.name": "transaction",
        "lobbystack.actor_type": context.actorType,
        "lobbystack.retry_attempt": attempt,
      },
    });


    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(rlsContextStatement(context));
        return await callback(tx);
      }, options.accessMode ? { accessMode: options.accessMode } : undefined);
      span.end();
      transactionDurationHistogram.record(Date.now() - startedAt, {
        actor_type: context.actorType,
        outcome: "success",
      });
      return result;
    } catch (error) {
      recordException(error, {
        service: "database",
        operation: "transaction",
        actorType: context.actorType,
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      // A deadlock that was retried away leaves no other trace; the SQLSTATE on
      // the span is how it can be counted.
      if (code !== undefined) span.setAttribute("db.response.status_code", code);
      span.end();
      if (code === undefined || !RETRYABLE_TRANSACTION_ERRORS.has(code) || attempt >= maxRetries) {
        transactionDurationHistogram.record(Date.now() - startedAt, {
          actor_type: context.actorType,
          outcome: "error",
        });
        throw error;
      }
      // Spread the wait. Both transactions in a deadlock are told at the same
      // moment, and the one that was ended would otherwise come straight back
      // into the same order of locks.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }

  throw new Error("PostgreSQL transaction retry loop exhausted.");
}

export async function withDispatcherTransaction<T>(
  db: Database,
  callback: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return await withBusinessTransaction(db, { actorType: "dispatcher" }, callback);
}

export async function assertDatabaseRole(
  client: DatabaseClient,
  source: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (source.NODE_ENV !== "production" || client.role === "lobbystack_migrator") return;
  const result = await client.pool.query<{ role: string; privileged: boolean }>(`
    select current_user as role,
      (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb) as privileged
    from pg_roles where rolname = current_user
  `);
  const effective = result.rows[0];
  if (!effective || effective.role !== client.role || effective.privileged) {
    throw new Error(`Database role assertion failed: expected unprivileged ${client.role}.`);
  }
}

export async function databaseHealthCheck(client: DatabaseClient): Promise<{
  ok: boolean;
  latencyMs: number;
  role: DatabaseRole;
}> {
  const startedAt = Date.now();
  const span = getTracer("lobbystack-db").startSpan("db.health_check", {
    attributes: { "db.system": "postgresql", "db.operation.name": "health_check" },
  });
  try {
    await client.db.execute(sql`select 1`);
    const latencyMs = Date.now() - startedAt;
    span.end();
    return { ok: true, latencyMs, role: client.role };
  } catch (error) {
    recordException(error, { service: "database", operation: "health_check", role: client.role });
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.end();
    return { ok: false, latencyMs: Date.now() - startedAt, role: client.role };
  }
}
