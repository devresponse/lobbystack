import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const heartbeat = { beat: vi.fn(async () => undefined), drain: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  return {
    heartbeat,
    startFleetHeartbeat: vi.fn((..._args: unknown[]) => heartbeat),
    registerPoolMetrics: vi.fn(),
    serviceConnections: vi.fn((..._args: unknown[]) => ({ open: 5, inUse: 2, waiting: 0, max: 24 })),
    logEvent: vi.fn(),
  };
});

vi.mock("@lobbystack/jobs", () => ({ startFleetHeartbeat: mocks.startFleetHeartbeat }));
vi.mock("@lobbystack/db", () => ({ registerPoolMetrics: mocks.registerPoolMetrics, serviceConnections: mocks.serviceConnections }));
vi.mock("@lobbystack/telemetry/node", async (importOriginal) => ({ ...(await importOriginal<typeof import("@lobbystack/telemetry/node")>()), logEvent: mocks.logEvent }));

import { startAdminFleet } from "./fleet-heartbeat";

const STARTED = Symbol.for("lobbystack.admin.fleet");
const env = { RAILWAY_REPLICA_ID: "admin-replica-1", RAILWAY_REPLICA_REGION: "us-west2", RAILWAY_DEPLOYMENT_ID: "dep-1", RAILWAY_GIT_COMMIT_SHA: "abc1234" };

/** A stand-in for the process's signals: listeners, and the signals sent to it. */
function signals() {
  const emitter = new EventEmitter();
  const kill = vi.fn();
  return { emitter, kill, process: { once: emitter.once.bind(emitter), listenerCount: emitter.listenerCount.bind(emitter), kill, pid: 4242 } as unknown as NodeJS.Process };
}

afterEach(() => {
  delete (globalThis as { [STARTED]?: unknown })[STARTED];
  vi.clearAllMocks();
});

describe("the admin's heartbeat", () => {
  it("doesn't start during a build, which serves no one", () => {
    expect(startAdminFleet({ ...env, NEXT_PHASE: "phase-production-build" }, signals().process)).toBeUndefined();
    expect(mocks.startFleetHeartbeat).not.toHaveBeenCalled();
    expect(mocks.registerPoolMetrics).not.toHaveBeenCalled();
  });

  it("starts once a process, as this copy, with its database connections in each beat", () => {
    const fake = signals();
    const heartbeat = startAdminFleet(env, fake.process);
    expect(startAdminFleet(env, fake.process)).toBe(heartbeat);

    expect(mocks.startFleetHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.registerPoolMetrics).toHaveBeenCalledTimes(1);
    const [identity, sample, options] = mocks.startFleetHeartbeat.mock.calls[0] as unknown as [Record<string, string>, () => unknown, { onError: (error: unknown) => void }];
    expect(identity).toEqual({ service: "admin", replica: "admin-replica-1", release: "abc1234", deployment: "dep-1", region: "us-west2" });
    // What its pools hold now, against the admin's connection budget from the same variables.
    expect(sample()).toEqual({ db: { open: 5, inUse: 2, waiting: 0, max: 24 } });
    expect(mocks.serviceConnections).toHaveBeenCalledWith("admin", env);
    const failure = new Error("Redis is away");
    options.onError(failure);
    expect(mocks.logEvent).toHaveBeenCalledWith("warn", "fleet.heartbeat_failed", { error: failure });
  });

  it("says it is shutting down when the host stops it, and leaves the exit to Next.js", async () => {
    const fake = signals();
    startAdminFleet(env, fake.process);
    // Next.js's own listener, which closes the server and exits.
    const next = vi.fn();
    fake.emitter.on("SIGTERM", next);

    fake.emitter.emit("SIGTERM");
    // In the same turn, before anything else can run.
    expect(mocks.heartbeat.drain).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("ends the process as the signal would have, should nothing else listen for it", async () => {
    const fake = signals();
    startAdminFleet(env, fake.process);

    fake.emitter.emit("SIGINT");
    expect(mocks.heartbeat.drain).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fake.kill).toHaveBeenCalledWith(4242, "SIGINT"));
  });
});
