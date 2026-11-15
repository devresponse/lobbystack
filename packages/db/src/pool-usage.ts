import type { Pool } from "pg";

import { getMeter } from "@lobbystack/telemetry/node";

import { connectionBudget, type DatabaseService } from "./pool-budget";

// How many connections each of this process's pools holds right now, for the
// fleet heartbeat and for metrics. The numbers are counters node-postgres
// already keeps, so reading them costs nothing a query would notice.

type TrackedPool = { pool: Pool; role: string };

// The admin's start-up hook and its routes are bundled apart, so each can load
// its own copy of this module. The list lives on globalThis, where every copy
// finds the same one.
const POOLS = Symbol.for("lobbystack.db.pools");

function tracked(): Set<TrackedPool> {
  const holder = globalThis as { [POOLS]?: Set<TrackedPool> };
  return (holder[POOLS] ??= new Set());
}

/** Lists a pool that createDatabaseClient made. One that has ended drops off by itself. */
export function trackPool(pool: Pool, role: string): void {
  tracked().add({ pool, role });
}

export type PoolUsage = {
  role: string;
  /** Connections the pool holds open: these count against PostgreSQL's max_connections. */
  open: number;
  /** Connections lent to a query or a transaction. */
  inUse: number;
  /** Callers waiting for a connection, because the pool is full. */
  waiting: number;
  /** The most the pool may open: `<ROLE>_POOL_MAX`. */
  max: number;
};

/** Each database role's connections in this process right now. */
export function poolUsage(): PoolUsage[] {
  const pools = tracked();
  const byRole = new Map<string, PoolUsage>();
  for (const entry of pools) {
    if (entry.pool.ended) {
      pools.delete(entry);
      continue;
    }
    const usage = byRole.get(entry.role) ?? { role: entry.role, open: 0, inUse: 0, waiting: 0, max: 0 };
    usage.open += entry.pool.totalCount;
    usage.inUse += entry.pool.totalCount - entry.pool.idleCount;
    usage.waiting += entry.pool.waitingCount;
    usage.max += entry.pool.options.max ?? 0;
    byRole.set(entry.role, usage);
  }
  return [...byRole.values()];
}

/** All of this process's pools added up, as the fleet heartbeat carries them. */
export function totalPoolUsage(): Omit<PoolUsage, "role"> {
  return poolUsage().reduce(
    (sum, usage) => ({ open: sum.open + usage.open, inUse: sum.inUse + usage.inUse, waiting: sum.waiting + usage.waiting, max: sum.max + usage.max }),
    { open: 0, inUse: 0, waiting: 0, max: 0 },
  );
}

/**
 * A service's connections as the fleet heartbeat carries them: what this
 * copy's pools hold now, against the most one copy may hold, its connection
 * budget (pool-budget.ts). A pool is made when it is first used, so the pools'
 * own limits add up slowly after a start; the budget is the same from the
 * first beat, and it is the number the scale script counts copies with.
 */
export function serviceConnections(service: DatabaseService, source: Record<string, string | undefined> = process.env): Omit<PoolUsage, "role"> {
  const usage = totalPoolUsage();
  try {
    return { ...usage, max: connectionBudget(service, source) };
  } catch {
    // A pool size that can't be read stops that pool with its own error. Here the pools made so far stand in.
    return usage;
  }
}

/**
 * Sends each pool's connections with every metrics export, as `db.pool.open`,
 * `db.pool.in_use`, `db.pool.waiting` and `db.pool.max`, by `role`. A service
 * calls it once, after telemetry has started: before that, OpenTelemetry would
 * hand out gauges that are never read. Returns a function that stops it.
 */
export function registerPoolMetrics(): () => void {
  const meter = getMeter("lobbystack-db");
  const open = meter.createObservableGauge("db.pool.open", { unit: "{connection}", description: "PostgreSQL connections a pool holds open" });
  const inUse = meter.createObservableGauge("db.pool.in_use", { unit: "{connection}", description: "PostgreSQL connections a pool has lent out" });
  const waiting = meter.createObservableGauge("db.pool.waiting", { unit: "{request}", description: "Callers waiting for a PostgreSQL pool connection" });
  const max = meter.createObservableGauge("db.pool.max", { unit: "{connection}", description: "The most connections a PostgreSQL pool may open" });
  const gauges = [open, inUse, waiting, max];
  const callback: Parameters<typeof meter.addBatchObservableCallback>[0] = (result) => {
    for (const usage of poolUsage()) {
      const attributes = { role: usage.role };
      result.observe(open, usage.open, attributes);
      result.observe(inUse, usage.inUse, attributes);
      result.observe(waiting, usage.waiting, attributes);
      result.observe(max, usage.max, attributes);
    }
  };
  meter.addBatchObservableCallback(callback, gauges);
  return () => meter.removeBatchObservableCallback(callback, gauges);
}
