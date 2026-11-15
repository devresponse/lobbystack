import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetRecord } from "@lobbystack/jobs";

const mocks = vi.hoisted(() => ({ readFleet: vi.fn(), logEvent: vi.fn() }));

vi.mock("@lobbystack/jobs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@lobbystack/jobs")>()), readFleet: mocks.readFleet }));
vi.mock("@lobbystack/telemetry/node", async (importOriginal) => ({ ...(await importOriginal<typeof import("@lobbystack/telemetry/node")>()), logEvent: mocks.logEvent }));

import { fleetStatus, fleetStatusToken, fleetStatusTokenProblem } from "./fleet-status";

const TOKEN = "fleet-status-token-of-32-characters";
const NOW = Date.parse("2026-11-15T20:00:00.000Z");
const env = { FLEET_STATUS_TOKEN: TOKEN, RAILWAY_REPLICA_ID: "admin-replica-1" };

function copy(overrides: Partial<FleetRecord> & Pick<FleetRecord, "service" | "replica">): FleetRecord {
  return { release: "abc1234", deployment: "dep-1", region: "us-west2", startedAt: NOW - 3_600_000, seenAt: NOW - 4_000, draining: false, busy: 0.12, rssBytes: 300_000_000, heapUsedBytes: 150_000_000, ...overrides };
}

const queues = { critical: { waiting: 2, active: 1, delayed: 0, failed: 0 } };
const healthy = (): FleetRecord[] => [
  copy({ service: "admin", replica: "admin-replica-1", db: { open: 3, inUse: 1, waiting: 0, max: 24 } }),
  copy({ service: "worker", replica: "worker-replica-1", ready: true, activeJobs: 2, liveCalls: 1, queues }),
];
const ask = (path = "/api/internal/fleet", headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, variables: Record<string, string | undefined> = env) =>
  fleetStatus(new Request(`https://app.example.com${path}`, { headers }), variables);

afterEach(() => {
  mocks.readFleet.mockReset();
  mocks.logEvent.mockReset();
  vi.useRealTimers();
});

describe("the fleet status address", () => {
  it("is off until FLEET_STATUS_TOKEN is set, and stays off for a token too short to trust", async () => {
    expect(await ask(undefined, undefined, {})).toEqual({ status: 404, body: "Not found" });
    expect(await ask(undefined, { authorization: "Bearer short" }, { FLEET_STATUS_TOKEN: "short" })).toEqual({ status: 404, body: "Not found" });
    expect(mocks.readFleet).not.toHaveBeenCalled();

    expect(fleetStatusToken({ FLEET_STATUS_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
    expect(fleetStatusToken({ FLEET_STATUS_TOKEN: "  " })).toBeUndefined();
    expect(fleetStatusTokenProblem({})).toBeNull();
    expect(fleetStatusTokenProblem({ FLEET_STATUS_TOKEN: TOKEN })).toBeNull();
    const problem = fleetStatusTokenProblem({ FLEET_STATUS_TOKEN: "short-token" });
    expect(problem).toContain("11 characters long and needs at least 32");
    expect(problem).not.toContain("short-token");
  });

  it("takes only its own token, in the header or in the address", async () => {
    mocks.readFleet.mockResolvedValue({ now: NOW, records: healthy() });

    expect(await ask(undefined, {})).toEqual({ status: 401, body: "Unauthorized" });
    expect(await ask(undefined, { authorization: "Bearer another-services-token-of-32-chars" })).toEqual({ status: 401, body: "Unauthorized" });
    expect(await ask("/api/internal/fleet?token=wrong")).toMatchObject({ status: 200 });
    expect(await ask("/api/internal/fleet?token=wrong", {})).toEqual({ status: 401, body: "Unauthorized" });
    expect(mocks.readFleet).toHaveBeenCalledTimes(1);

    expect((await ask(`/api/internal/fleet?token=${TOKEN}`, {})).status).toBe(200);
    expect((await ask(undefined, { authorization: `bearer ${TOKEN}` })).status).toBe(200);
  });

  it("lists every copy with what it holds, and each queue's jobs", async () => {
    mocks.readFleet.mockResolvedValue({ now: NOW, records: healthy() });

    expect(await ask()).toEqual({
      status: 200,
      body: {
        ok: true,
        service: "lobbystack-admin",
        answeredBy: "admin-replica-1",
        checkedAt: "2026-11-15T20:00:00.000Z",
        problems: [],
        services: {
          admin: { running: 1, notReady: 0, draining: 0, silent: 0, died: 0, expected: 1 },
          worker: { running: 1, notReady: 0, draining: 0, silent: 0, died: 0, expected: 1 },
        },
        copies: [
          { service: "admin", replica: "admin-replica-1", state: "running", release: "abc1234", deployment: "dep-1", region: "us-west2", startedAt: "2026-11-15T19:00:00.000Z", lastSeenSecondsAgo: 4, busy: 0.12, rssBytes: 300_000_000, heapUsedBytes: 150_000_000, db: { open: 3, inUse: 1, waiting: 0, max: 24 } },
          { service: "worker", replica: "worker-replica-1", state: "running", release: "abc1234", deployment: "dep-1", region: "us-west2", startedAt: "2026-11-15T19:00:00.000Z", lastSeenSecondsAgo: 4, busy: 0.12, rssBytes: 300_000_000, heapUsedBytes: 150_000_000, ready: true, activeJobs: 2, liveCalls: 1 },
        ],
        died: [],
        queues,
        queuesCountedSecondsAgo: 4,
      },
    });
  });

  it("lists a copy that died for 24 hours with its last beat, and raises no alarm once another took its place", async () => {
    const backlog = { critical: { waiting: 40, active: 5, delayed: 0, failed: 3 } };
    mocks.readFleet.mockResolvedValue({ now: NOW, records: [
      ...healthy(),
      // It stopped 5 hours ago without saying it was shutting down, after running for 2 hours.
      copy({ service: "worker", replica: "9b8d7c6a-1f2e-4d3c-8b7a-000000000002", startedAt: NOW - 7 * 3_600_000, seenAt: NOW - 5 * 3_600_000, busy: 0.97, rssBytes: 1_900_000_000, ready: true, activeJobs: 5, liveCalls: 3, db: { open: 12, inUse: 12, waiting: 4, max: 12 }, queues: backlog }),
      // One that said it was shutting down is forgotten after 10 minutes, and one that died after 24 hours.
      copy({ service: "worker", replica: "worker-left", draining: true, seenAt: NOW - 11 * 60_000 }),
      copy({ service: "admin", replica: "admin-long-ago", seenAt: NOW - 25 * 3_600_000 }),
    ] });

    const answer = await ask();
    expect(answer.status).toBe(200);
    const body = answer.body as { ok: boolean; problems: string[]; services: Record<string, Record<string, number>>; copies: Array<Record<string, unknown>>; died: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.problems).toEqual([]);
    expect(body.services.worker).toMatchObject({ running: 1, silent: 0, died: 1 });
    expect(body.services.admin).toMatchObject({ running: 1, died: 0 });
    expect(body.copies.map((item) => item.replica)).toEqual(["admin-replica-1", "worker-replica-1"]);
    expect(body.died).toEqual([{
      service: "worker", replica: "9b8d7c6a-1f2e-4d3c-8b7a-000000000002", state: "died", release: "abc1234", deployment: "dep-1", region: "us-west2",
      startedAt: "2026-11-15T13:00:00.000Z", lastSeenSecondsAgo: 18_000, busy: 0.97, rssBytes: 1_900_000_000, heapUsedBytes: 150_000_000,
      db: { open: 12, inUse: 12, waiting: 4, max: 12 }, ready: true, activeJobs: 5, liveCalls: 3,
      lastSeenAt: "2026-11-15T15:00:00.000Z", ranForSeconds: 7_200, queues: backlog,
    }]);
  });

  it("answers 503 when a worker went silent, which the admin's own health checks can't see", async () => {
    // Railway names a copy by a UUID, and a problem names it by the UUID's first eight characters.
    mocks.readFleet.mockResolvedValue({ now: NOW, records: [...healthy(), copy({ service: "worker", replica: "9b8d7c6a-1f2e-4d3c-8b7a-000000000002", seenAt: NOW - 95_000 })] });

    const answer = await ask();
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({
      ok: false,
      problems: ["worker copy 9b8d7c6a stopped reporting 95 s ago without shutting down, and no newer copy took its place."],
      services: { worker: { running: 1, silent: 1 } },
    });
  });

  it("answers 503 when no worker runs at all", async () => {
    mocks.readFleet.mockResolvedValue({ now: NOW, records: healthy().slice(0, 1) });

    const answer = await ask();
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ ok: false, problems: ["No worker copy is running."], queues: null, queuesCountedSecondsAgo: null });
  });

  it("shows a copy that is shutting down, with how long, and raises no alarm for it", async () => {
    mocks.readFleet.mockResolvedValue({ now: NOW, records: [...healthy(), copy({ service: "worker", replica: "worker-old", draining: true, drainingForMs: 56_000, liveCalls: 1, ready: true })] });

    const answer = await ask();
    expect(answer.status).toBe(200);
    expect((answer.body as { copies: Array<Record<string, unknown>> }).copies.find((item) => item.replica === "worker-old")).toMatchObject({ state: "draining", drainingForSeconds: 60, liveCalls: 1 });
  });

  it("holds the fleet to the copies the address asks for", async () => {
    mocks.readFleet.mockResolvedValue({ now: NOW, records: healthy() });

    const short = await ask("/api/internal/fleet?admin=1&worker=2");
    expect(short.status).toBe(503);
    expect(short.body).toMatchObject({ problems: ["1 worker copy is running, and 2 are expected."], services: { worker: { expected: 2 } } });

    for (const query of ["worker=0", "worker=two", "admin=1.5", "admin=51", "worker=-1", "worker="]) {
      const answer = await ask(`/api/internal/fleet?${query}`);
      expect(answer.status, query).toBe(400);
      expect((answer.body as { error: string }).error, query).toMatch(/takes the number of running copies to expect, a whole number from 1 to 50\.$/);
    }
  });

  it("answers 503 when Redis can't be read, and says so in the log without failing", async () => {
    mocks.readFleet.mockRejectedValue(new Error("Reached the max retries per request limit"));

    expect(await ask()).toEqual({ status: 503, body: { ok: false, service: "lobbystack-admin", answeredBy: "admin-replica-1", problems: ["The copies' heartbeats can't be read from Redis."] } });
    expect(mocks.logEvent).toHaveBeenCalledWith("warn", "fleet.status_unreadable", { error: expect.any(Error) });
  });

  it("gives up on a Redis that doesn't answer after 3 seconds, so the uptime check gets its 503", async () => {
    vi.useFakeTimers();
    mocks.readFleet.mockReturnValue(new Promise(() => undefined));

    const pending = ask();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({ status: 503, body: { ok: false, problems: ["The copies' heartbeats can't be read from Redis."] } });
  });
});
