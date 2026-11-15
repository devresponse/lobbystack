import { afterEach, describe, expect, it, vi } from "vitest";

import { FLEET_FORGET_MS, FLEET_HANDOVER_MS, FLEET_STALE_MS, startFleetHeartbeat, summarizeFleet, type FleetRecord } from "./fleet";

const NOW = 1_800_000_000_000;

function copy(overrides: Partial<FleetRecord> & Pick<FleetRecord, "service" | "replica">): FleetRecord {
  return {
    release: "abc1234", deployment: "dep-1", startedAt: NOW - 3_600_000, seenAt: NOW - 4_000, draining: false,
    busy: 0.1, rssBytes: 300_000_000, heapUsedBytes: 150_000_000, ...overrides,
  };
}

const admin = (replica: string, overrides: Partial<FleetRecord> = {}) => copy({ service: "admin", replica, ...overrides });
const worker = (replica: string, overrides: Partial<FleetRecord> = {}) => copy({ service: "worker", replica, ready: true, activeJobs: 0, liveCalls: 0, ...overrides });
const summarize = (records: FleetRecord[], expected = {}) => summarizeFleet({ now: NOW, records }, expected);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("what the heartbeats say about the fleet", () => {
  it("is fine with every copy beating, and names each queue's jobs from the worker that counted last", () => {
    const queues = { critical: { waiting: 0, active: 1, delayed: 2, failed: 0 } };
    const summary = summarize([
      admin("a1"), admin("a2"),
      worker("w1", { seenAt: NOW - 9_000, queues: { critical: { waiting: 7, active: 0, delayed: 0, failed: 0 } } }),
      worker("w2", { seenAt: NOW - 2_000, queues }),
    ]);

    expect(summary.ok).toBe(true);
    expect(summary.problems).toEqual([]);
    expect(summary.services).toEqual({
      admin: { running: 2, notReady: 0, draining: 0, silent: 0, expected: 1 },
      worker: { running: 2, notReady: 0, draining: 0, silent: 0, expected: 1 },
    });
    expect(summary.copies.map((item) => `${item.service}:${item.replica}:${item.state}`)).toEqual(["admin:a1:running", "admin:a2:running", "worker:w1:running", "worker:w2:running"]);
    expect(summary.queues).toEqual(queues);
    expect(summary.queuesCountedMsAgo).toBe(2_000);
  });

  it("reports a copy that stopped beating without shutting down, which an uptime check on the admin alone can't see", () => {
    const summary = summarize([admin("a1"), worker("w1"), worker("0f9e8d7c-6b5a-4c3d-2e1f-000000000000", { seenAt: NOW - FLEET_STALE_MS - 15_000 })]);

    expect(summary.ok).toBe(false);
    expect(summary.problems).toEqual(["worker copy 0f9e8d7c stopped reporting 45 s ago without shutting down, and no newer copy took its place."]);
    expect(summary.services.worker).toMatchObject({ running: 1, silent: 1 });

    // Off Railway a copy is named by its host, and the whole name is what tells two copies apart.
    const onAServer = summarize([admin("a1"), worker("w1"), worker("lobbystack-worker-2", { seenAt: NOW - FLEET_STALE_MS - 15_000 })]);
    expect(onAServer.problems).toEqual(["worker copy lobbystack-worker-2 stopped reporting 45 s ago without shutting down, and no newer copy took its place."]);
  });

  it("reports that no worker runs when the only one died", () => {
    const summary = summarize([admin("a1"), worker("w1", { seenAt: NOW - 60_000 })]);

    expect(summary.ok).toBe(false);
    expect(summary.problems).toEqual([
      "worker copy w1 stopped reporting 60 s ago without shutting down, and no newer copy took its place.",
      "No worker copy is running.",
    ]);
  });

  it("reports that no worker runs when none ever reported", () => {
    const summary = summarize([admin("a1")]);

    expect(summary.ok).toBe(false);
    expect(summary.problems).toEqual(["No worker copy is running."]);
    expect(summary.queues).toBeNull();
    expect(summary.queuesCountedMsAgo).toBeNull();
  });

  it("raises no alarm for a deploy: the old copies say they are shutting down, then stop beating", () => {
    const old = { deployment: "dep-1", startedAt: NOW - 3_600_000 };
    const next = { deployment: "dep-2", startedAt: NOW - 90_000 };
    const during = summarize([admin("a1", { ...old, draining: true, drainingForMs: 20_000 }), admin("a2", next), worker("w1", { ...old, draining: true, drainingForMs: 20_000, liveCalls: 1 }), worker("w2", next)]);
    expect(during.ok).toBe(true);
    expect(during.services.worker).toMatchObject({ running: 1, draining: 1 });

    const after = summarize([admin("a1", { ...old, draining: true, seenAt: NOW - 120_000 }), admin("a2", next), worker("w1", { ...old, draining: true, seenAt: NOW - 120_000 }), worker("w2", next)]);
    expect(after.ok).toBe(true);
    expect(after.copies.filter((item) => item.state === "left").map((item) => item.replica)).toEqual(["a1", "w1"]);
  });

  it("raises no alarm for a deploy whose old copy was cut off before it could say it was shutting down", () => {
    const summary = summarize([
      admin("a1", { deployment: "dep-1", startedAt: NOW - 3_600_000, seenAt: NOW - 50_000 }),
      admin("a2", { deployment: "dep-2", startedAt: NOW - 90_000 }),
      worker("w1"),
    ]);

    expect(summary.ok).toBe(true);
    expect(summary.copies.find((item) => item.replica === "a1")?.state).toBe("left");
  });

  it("raises no alarm once a crashed copy's replacement has started, under a new name", () => {
    const summary = summarize([admin("a1"), worker("w1", { seenAt: NOW - 100_000 }), worker("w2", { startedAt: NOW - 80_000 })]);

    expect(summary.ok).toBe(true);
    expect(summary.copies.find((item) => item.replica === "w1")?.state).toBe("left");
  });

  it("still reports a copy of a newer deployment that died while the older one serves", () => {
    const summary = summarize([
      admin("a1"),
      worker("w1", { deployment: "dep-1", startedAt: NOW - 3_600_000 }),
      worker("w2", { deployment: "dep-2", startedAt: NOW - 200_000, seenAt: NOW - 100_000 }),
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.problems).toEqual(["worker copy w2 stopped reporting 100 s ago without shutting down, and no newer copy took its place."]);
  });

  it("allows a short gap while the only copy hands over, and reports a long one", () => {
    const handingOver = summarize([admin("a1"), worker("w1", { draining: true, drainingForMs: 30_000 })]);
    expect(handingOver.ok).toBe(true);

    const starting = summarize([admin("a1"), worker("w2", { ready: false, startedAt: NOW - 20_000 })]);
    expect(starting.ok).toBe(true);
    expect(starting.services.worker).toMatchObject({ running: 0, notReady: 1 });

    const stuck = summarize([admin("a1"), worker("w1", { draining: true, drainingForMs: FLEET_HANDOVER_MS + 60_000, liveCalls: 1 })]);
    expect(stuck.ok).toBe(false);
    expect(stuck.problems).toEqual(["No worker copy is running."]);
  });

  it("allows the gap of a restart: the only copy left on purpose, and the next one hasn't reported yet", () => {
    // As a server's `docker compose up -d` does: the old worker stops, then the new one starts.
    const gone = summarize([admin("a1"), worker("w1", { draining: true, drainingForMs: 5_000, seenAt: NOW - 45_000 })]);
    expect(gone.ok).toBe(true);
    expect(gone.copies.find((item) => item.replica === "w1")?.state).toBe("left");
    expect(gone.services.worker).toMatchObject({ running: 0, draining: 0, silent: 0 });

    // Two minutes after it said it was shutting down, nothing took its place: no worker runs.
    const stayedGone = summarize([admin("a1"), worker("w1", { draining: true, drainingForMs: 5_000, seenAt: NOW - FLEET_HANDOVER_MS })]);
    expect(stayedGone.ok).toBe(false);
    expect(stayedGone.problems).toEqual(["No worker copy is running."]);

    // A copy that died gets no such time: it never said it was shutting down.
    const died = summarize([admin("a1"), worker("w1", { seenAt: NOW - 45_000 })]);
    expect(died.problems).toEqual(["worker copy w1 stopped reporting 45 s ago without shutting down, and no newer copy took its place.", "No worker copy is running."]);

    // One of two that was taken away counts for those two minutes too, then shows as missing.
    const takenAway = [admin("a1"), worker("w1"), worker("w2", { draining: true, drainingForMs: 5_000, seenAt: NOW - 45_000 })];
    expect(summarize(takenAway, { worker: 2 }).ok).toBe(true);
    takenAway[2] = worker("w2", { draining: true, drainingForMs: 5_000, seenAt: NOW - FLEET_HANDOVER_MS });
    expect(summarize(takenAway, { worker: 2 }).problems).toEqual(["1 worker copy is running, and 2 are expected."]);
  });

  it("reports a worker that stays unready", () => {
    const summary = summarize([admin("a1"), worker("w1"), worker("w2", { ready: false })]);

    expect(summary.ok).toBe(false);
    expect(summary.problems).toEqual(["worker copy w2 reports that it isn't ready: it can't reach the database, the files or Redis."]);
  });

  it("holds each service to the number of copies the check expects", () => {
    const records = [admin("a1"), admin("a2"), worker("w1")];
    expect(summarize(records, { admin: 2 }).ok).toBe(true);

    const short = summarize(records, { admin: 2, worker: 2 });
    expect(short.ok).toBe(false);
    expect(short.problems).toEqual(["1 worker copy is running, and 2 are expected."]);
    expect(short.services.worker.expected).toBe(2);
    expect(summarize([admin("a1"), worker("w1"), worker("w2"), worker("w3")], { worker: 4 }).problems).toEqual(["3 worker copies are running, and 4 are expected."]);
    // Nothing below one of each is ever accepted.
    expect(summarize([admin("a1")], { worker: 0 }).problems).toEqual(["No worker copy is running."]);
  });

  it("forgets a copy 10 minutes after its last beat", () => {
    const summary = summarize([admin("a1"), worker("w1"), worker("w2", { seenAt: NOW - FLEET_FORGET_MS - 1 })]);

    expect(summary.ok).toBe(true);
    expect(summary.copies.map((item) => item.replica)).toEqual(["a1", "w1"]);
  });
});

describe("the heartbeat without Redis", () => {
  it("does nothing when REDIS_URL isn't set, as on a developer's admin without Redis", async () => {
    vi.stubEnv("REDIS_URL", "");
    const sample = vi.fn(() => ({}));
    const heartbeat = startFleetHeartbeat({ service: "admin", replica: "a1", release: "abc1234" }, sample);

    await heartbeat.beat();
    await heartbeat.drain();
    await heartbeat.stop();

    expect(sample).not.toHaveBeenCalled();
  });
});
