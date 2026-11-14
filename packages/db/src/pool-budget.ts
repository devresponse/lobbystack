import type { DatabaseRole } from "./client";

// Every copy of a service opens its own pools, and during a release the old copies
// keep theirs while they finish. So the sum over all copies, old and new, must stay
// under PostgreSQL's max_connections (100 unless raised; 3 are kept for superusers).
// A deployment that runs copies sets the pools smaller with `<ROLE>_POOL_MAX`
// (docs/deployment/guide/part-7-operations.md, 7.24).

/** Each role's pool size when `<ROLE>_POOL_MAX` doesn't set it. */
export const DEFAULT_POOL_MAX = 12;
export const DEFAULT_DISPATCHER_POOL_MAX = 4;

/**
 * The pools each long-running service opens, one per role: the admin's through
 * getDatabase (apps/admin/src/lib/databases.ts), which takes only these, and the
 * worker's in apps/worker/src/index.ts.
 */
export const SERVICE_DATABASE_ROLES = {
  admin: ["lobbystack_app", "lobbystack_auth", "lobbystack_worker", "lobbystack_dispatcher", "lobbystack_finance_export"],
  worker: ["lobbystack_worker", "lobbystack_dispatcher"],
} as const satisfies Record<string, readonly DatabaseRole[]>;

export type DatabaseService = keyof typeof SERVICE_DATABASE_ROLES;
export type AdminDatabaseRole = (typeof SERVICE_DATABASE_ROLES.admin)[number];

type Environment = Record<string, string | undefined>;

/**
 * How many connections a role's pool may open: `<ROLE>_POOL_MAX`, such as
 * LOBBYSTACK_APP_POOL_MAX, or the default. A value that isn't a whole number of
 * 1 or more throws as the pool is made (for most pools, as the service starts)
 * rather than leaving a pool that never connects.
 */
export function poolMax(role: DatabaseRole, source: Environment = process.env): number {
  const name = `${role.toUpperCase()}_POOL_MAX`;
  const raw = source[name]?.trim();
  if (!raw) return role === "lobbystack_dispatcher" ? DEFAULT_DISPATCHER_POOL_MAX : DEFAULT_POOL_MAX;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a whole number of connections, 1 or more, not "${raw}".`);
  return value;
}

/** The most connections one copy of a service can hold open at once: the sum of its pools. */
export function connectionBudget(service: DatabaseService, source: Environment = process.env): number {
  return SERVICE_DATABASE_ROLES[service].reduce((sum, role) => sum + poolMax(role, source), 0);
}
