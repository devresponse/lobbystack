import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const meter = vi.hoisted(() => {
  const callbacks: Array<{ callback: (result: { observe: (gauge: { name: string }, value: number, attributes: Record<string, string>) => void }) => void; gauges: Array<{ name: string }> }> = [];
  return {
    callbacks,
    createObservableGauge: (name: string) => ({ name }),
    addBatchObservableCallback: (callback: (typeof callbacks)[number]["callback"], gauges: Array<{ name: string }>) => { callbacks.push({ callback, gauges }); },
    removeBatchObservableCallback: (callback: (typeof callbacks)[number]["callback"]) => {
      const index = callbacks.findIndex((entry) => entry.callback === callback);
      if (index >= 0) callbacks.splice(index, 1);
    },
  };
});
vi.mock("@lobbystack/telemetry/node", () => ({ getMeter: () => meter }));

import { poolUsage, registerPoolMetrics, serviceConnections, totalPoolUsage, trackPool } from "./pool-usage";

type FakePool = { totalCount: number; idleCount: number; waitingCount: number; ended: boolean; options: { max: number } };
const made: FakePool[] = [];

function pool(role: string, counts: Partial<FakePool> & { max: number }): FakePool {
  const fake: FakePool = { totalCount: 0, idleCount: 0, waitingCount: 0, ended: false, options: { max: counts.max }, ...counts };
  made.push(fake);
  trackPool(fake as unknown as Pool, role);
  return fake;
}

afterEach(() => {
  // The list is shared by the whole process, so each test ends its pools.
  for (const fake of made.splice(0)) fake.ended = true;
  poolUsage();
});

describe("a process's database connections", () => {
  it("counts each role's open, lent and waited-for connections against its limit", () => {
    pool("lobbystack_app", { totalCount: 4, idleCount: 1, waitingCount: 0, max: 6 });
    pool("lobbystack_worker", { totalCount: 12, idleCount: 0, waitingCount: 3, max: 12 });

    expect(poolUsage()).toEqual([
      { role: "lobbystack_app", open: 4, inUse: 3, waiting: 0, max: 6 },
      { role: "lobbystack_worker", open: 12, inUse: 12, waiting: 3, max: 12 },
    ]);
    expect(totalPoolUsage()).toEqual({ open: 16, inUse: 15, waiting: 3, max: 18 });
  });

  it("adds up two pools of one role, and drops a pool that has ended", () => {
    pool("lobbystack_worker", { totalCount: 2, idleCount: 2, max: 10 });
    const second = pool("lobbystack_worker", { totalCount: 5, idleCount: 1, max: 10 });
    expect(poolUsage()).toEqual([{ role: "lobbystack_worker", open: 7, inUse: 4, waiting: 0, max: 20 }]);

    second.ended = true;
    expect(poolUsage()).toEqual([{ role: "lobbystack_worker", open: 2, inUse: 0, waiting: 0, max: 10 }]);
  });

  it("sets a service's connections against its budget, which is the same before and after its pools are made", () => {
    const shares = { LOBBYSTACK_APP_POOL_MAX: "6", LOBBYSTACK_AUTH_POOL_MAX: "2", LOBBYSTACK_WORKER_POOL_MAX: "12", LOBBYSTACK_DISPATCHER_POOL_MAX: "2", LOBBYSTACK_FINANCE_EXPORT_POOL_MAX: "2" };
    expect(serviceConnections("admin", shares)).toEqual({ open: 0, inUse: 0, waiting: 0, max: 24 });

    // One pool so far, made at its first query: the copy may still hold 24.
    pool("lobbystack_app", { totalCount: 3, idleCount: 1, waitingCount: 2, max: 6 });
    expect(serviceConnections("admin", shares)).toEqual({ open: 3, inUse: 2, waiting: 2, max: 24 });
    expect(serviceConnections("worker", shares)).toMatchObject({ max: 14 });
    // The code's defaults, where no share is set.
    expect(serviceConnections("admin", {})).toMatchObject({ max: 52 });
    expect(serviceConnections("worker", {})).toMatchObject({ max: 16 });
    // A share that can't be read stops its pool with its own error; the beat carries the pools made so far.
    expect(serviceConnections("admin", { LOBBYSTACK_APP_POOL_MAX: "lots" })).toEqual({ open: 3, inUse: 2, waiting: 2, max: 6 });
  });

  it("reads zero with no pool", () => {
    expect(poolUsage()).toEqual([]);
    expect(totalPoolUsage()).toEqual({ open: 0, inUse: 0, waiting: 0, max: 0 });
  });

  it("sends the four gauges by role at each metrics export, until it is stopped", () => {
    pool("lobbystack_dispatcher", { totalCount: 2, idleCount: 1, waitingCount: 1, max: 4 });
    const stop = registerPoolMetrics();
    expect(meter.callbacks).toHaveLength(1);
    expect(meter.callbacks[0]!.gauges.map((gauge) => gauge.name)).toEqual(["db.pool.open", "db.pool.in_use", "db.pool.waiting", "db.pool.max"]);

    const observe = vi.fn();
    meter.callbacks[0]!.callback({ observe });
    expect(observe.mock.calls.map(([gauge, value, attributes]) => [gauge.name, value, attributes])).toEqual([
      ["db.pool.open", 2, { role: "lobbystack_dispatcher" }],
      ["db.pool.in_use", 1, { role: "lobbystack_dispatcher" }],
      ["db.pool.waiting", 1, { role: "lobbystack_dispatcher" }],
      ["db.pool.max", 4, { role: "lobbystack_dispatcher" }],
    ]);

    stop();
    expect(meter.callbacks).toHaveLength(0);
  });
});
