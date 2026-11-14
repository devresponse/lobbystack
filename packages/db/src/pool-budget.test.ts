import { describe, expect, it } from "vitest";

import { createDatabaseClient } from "./client";
import { connectionBudget, DEFAULT_DISPATCHER_POOL_MAX, DEFAULT_POOL_MAX, poolMax, SERVICE_DATABASE_ROLES } from "./pool-budget";

const DATABASE_URL = "postgresql://postgres:superuser@postgres.internal:5432/lobbystack";

describe("poolMax", () => {
  it("uses 12 connections per pool, and 4 for the dispatcher, unless <ROLE>_POOL_MAX says otherwise", () => {
    expect(poolMax("lobbystack_app", {})).toBe(DEFAULT_POOL_MAX);
    expect(DEFAULT_POOL_MAX).toBe(12);
    expect(poolMax("lobbystack_dispatcher", {})).toBe(DEFAULT_DISPATCHER_POOL_MAX);
    expect(DEFAULT_DISPATCHER_POOL_MAX).toBe(4);
    expect(poolMax("lobbystack_app", { LOBBYSTACK_APP_POOL_MAX: "8" })).toBe(8);
    expect(poolMax("lobbystack_dispatcher", { LOBBYSTACK_DISPATCHER_POOL_MAX: " 2 " })).toBe(2);
    // Another role's setting doesn't count.
    expect(poolMax("lobbystack_auth", { LOBBYSTACK_APP_POOL_MAX: "8" })).toBe(12);
  });

  it("treats an empty setting as unset", () => {
    expect(poolMax("lobbystack_worker", { LOBBYSTACK_WORKER_POOL_MAX: "" })).toBe(12);
    expect(poolMax("lobbystack_worker", { LOBBYSTACK_WORKER_POOL_MAX: "  " })).toBe(12);
  });

  it.each(["0", "-3", "2.5", "eight", "8 connections", "Infinity"])("refuses %j rather than make a pool that never connects", (value) => {
    expect(() => poolMax("lobbystack_worker", { LOBBYSTACK_WORKER_POOL_MAX: value })).toThrow(
      `LOBBYSTACK_WORKER_POOL_MAX must be a whole number of connections, 1 or more, not "${value}".`,
    );
  });
});

describe("createDatabaseClient", () => {
  it("sizes each role's pool with poolMax", async () => {
    const source = { DATABASE_URL, LOBBYSTACK_APP_POOL_MAX: "8" };
    const app = createDatabaseClient("lobbystack_app", source);
    const dispatcher = createDatabaseClient("lobbystack_dispatcher", source);
    try {
      // A pool connects only when it's used, so nothing here reaches a database.
      expect(app.pool.options.max).toBe(8);
      expect(dispatcher.pool.options.max).toBe(4);
    } finally {
      await Promise.all([app.pool.end(), dispatcher.pool.end()]);
    }
    expect(() => createDatabaseClient("lobbystack_app", { DATABASE_URL, LOBBYSTACK_APP_POOL_MAX: "0" })).toThrow("LOBBYSTACK_APP_POOL_MAX must be a whole number");
  });
});

describe("connectionBudget", () => {
  // Postgres's default max_connections, less the 3 it keeps for superusers, and the limit
  // devops/bootstrap.mjs gives a new database (guide 7.24).
  const DEFAULT_USABLE = 100 - 3;
  const RAISED_USABLE = 200 - 3;
  // The pool sizes devops/bootstrap.mjs gives each copy (POOLS there; scripts/bootstrap.test.ts checks they match).
  const SMALLER = {
    LOBBYSTACK_APP_POOL_MAX: "8", LOBBYSTACK_AUTH_POOL_MAX: "4", LOBBYSTACK_WORKER_POOL_MAX: "8", LOBBYSTACK_DISPATCHER_POOL_MAX: "2", LOBBYSTACK_FINANCE_EXPORT_POOL_MAX: "2",
  };
  const SMALLER_WORKER = { LOBBYSTACK_WORKER_POOL_MAX: "10", LOBBYSTACK_DISPATCHER_POOL_MAX: "2" };
  // While a release replaces every copy, the old ones keep their pools as they finish: the admin's for up to a
  // minute, the worker's for as long as its calls last. So twice the copies hold connections at once.
  const duringRelease = (admins: number, workers: number, admin: number, worker: number) => 2 * (admins * admin + workers * worker);

  it("counts every pool one copy of the admin or the worker can open", () => {
    expect(SERVICE_DATABASE_ROLES.admin).toEqual(["lobbystack_app", "lobbystack_auth", "lobbystack_worker", "lobbystack_dispatcher", "lobbystack_finance_export"]);
    expect(SERVICE_DATABASE_ROLES.worker).toEqual(["lobbystack_worker", "lobbystack_dispatcher"]);
    expect(connectionBudget("admin", {})).toBe(52);
    expect(connectionBudget("worker", {})).toBe(16);
    expect(connectionBudget("admin", SMALLER)).toBe(24);
    expect(connectionBudget("worker", SMALLER_WORKER)).toBe(12);
  });

  it("shows why copies need smaller pools and a higher limit", () => {
    const defaults = { admin: connectionBudget("admin", {}), worker: connectionBudget("worker", {}) };
    const smaller = { admin: connectionBudget("admin", SMALLER), worker: connectionBudget("worker", SMALLER_WORKER) };
    // Two admins and two workers at the code's defaults don't fit Postgres's default limit even outside a release.
    expect(2 * defaults.admin + 2 * defaults.worker).toBeGreaterThan(DEFAULT_USABLE);
    // An admin that gets a minute to finish overlaps its replacement, so the defaults don't fit one of each either:
    // the minute comes only with the smaller pools.
    expect(duringRelease(1, 1, defaults.admin, defaults.worker)).toBeGreaterThan(DEFAULT_USABLE);
    // With the smaller pools one of each fits the default limit during a release, so a deployment can take them
    // before its database's limit is raised.
    expect(duringRelease(1, 1, smaller.admin, smaller.worker)).toBeLessThanOrEqual(DEFAULT_USABLE);
    // Two of each fit it outside a release, but not during one; a limit of 200 holds them then, and three
    // admins with two workers too.
    expect(2 * smaller.admin + 2 * smaller.worker).toBeLessThanOrEqual(DEFAULT_USABLE);
    const twoAndTwo = duringRelease(2, 2, smaller.admin, smaller.worker);
    expect(twoAndTwo).toBe(144);
    expect(twoAndTwo).toBeGreaterThan(DEFAULT_USABLE);
    expect(twoAndTwo).toBeLessThanOrEqual(RAISED_USABLE);
    const threeAndTwo = duringRelease(3, 2, smaller.admin, smaller.worker);
    expect(threeAndTwo).toBe(192);
    expect(threeAndTwo).toBeLessThanOrEqual(RAISED_USABLE);
  });
});
