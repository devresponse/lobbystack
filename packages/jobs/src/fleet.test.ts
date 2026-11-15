import { afterEach, describe, expect, it, vi } from "vitest";

import { FLEET_DIED_MAX, FLEET_DIED_MS, FLEET_FORGET_MS, FLEET_HANDOVER_MS, FLEET_STALE_MS, startFleetHeartbeat, summarizeFleet, type FleetRecord } from "./fleet";

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
      admin: { running: 2, notReady: 0, draining: 0, silent: 0, died: 0, expected: 1 },
      worker: { running: 2, notReady: 0, draining: 0, silent: 0, died: 0, expected: 1 },
    });
    expect(summary.died).toEqual([]);
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
    // It never said it was shutting down, so it counts as a copy that died, and its last beat is kept.
    expect(summary.copies.map((item) => item.replica)).toEqual(["a2", "w1"]);
    expect(summary.died.map((item) => `${item.replica}:${item.state}`)).toEqual(["a1:died"]);
  });

  it("raises no alarm once a crashed copy's replacement has started, under a new name", () => {
    const summary = summarize([admin("a1"), worker("w1", { seenAt: NOW - 100_000, liveCalls: 2, activeJobs: 1 }), worker("w2", { startedAt: NOW - 80_000 })]);

    expect(summary.ok).toBe(true);
    expect(summary.copies.map((item) => `${item.replica}:${item.state}`)).toEqual(["a1:running", "w2:running"]);
    // The copy that died is listed with its last beat: what it held when it stopped.
    expect(summary.died).toEqual([expect.objectContaining({ replica: "w1", state: "died", lastSeenMsAgo: 100_000, liveCalls: 2, activeJobs: 1 })]);
    expect(summary.services.worker).toMatchObject({ running: 1, silent: 0, died: 1 });
  });

  it("raises no alarm once the host has started a crashed copy again under the same name, and keeps the process that died", () => {
    // As a server's Docker does: the container keeps its name, and the process in it is new.
    const records = [
      admin("a1"),
      worker("w1", { startedAt: NOW - 3_600_000, seenAt: NOW - 50_000, liveCalls: 3, rssBytes: 900_000_000 }),
      worker("w1", { startedAt: NOW - 45_000, liveCalls: 0 }),
    ];
    const summary = summarize(records);

    expect(summary.ok).toBe(true);
    expect(summary.services.worker).toMatchObject({ running: 1, silent: 0, died: 1 });
    expect(summary.copies.filter((item) => item.service === "worker")).toEqual([expect.objectContaining({ replica: "w1", state: "running", startedAt: NOW - 45_000 })]);
    expect(summary.died).toEqual([expect.objectContaining({ replica: "w1", state: "died", startedAt: NOW - 3_600_000, liveCalls: 3, rssBytes: 900_000_000 })]);

    // Until three beats are missed the process that died still reads as running, as any copy that just died does.
    const justNow = summarize([admin("a1"), worker("w1", { startedAt: NOW - 3_600_000, seenAt: NOW - 12_000 }), worker("w1", { startedAt: NOW - 8_000, ready: false })]);
    expect(justNow.ok).toBe(true);
    expect(justNow.services.worker).toMatchObject({ running: 1, notReady: 1, died: 0 });
  });

  it("reports only the last process of a copy that kept crashing until the host gave up", () => {
    const summary = summarize([
      admin("a1"),
      worker("w1", { startedAt: NOW - 300_000, seenAt: NOW - 240_000 }),
      worker("w1", { startedAt: NOW - 230_000, seenAt: NOW - 170_000 }),
      worker("w1", { startedAt: NOW - 160_000, seenAt: NOW - 100_000 }),
    ]);

    expect(summary.problems).toEqual([
      "worker copy w1 stopped reporting 100 s ago without shutting down, and no newer copy took its place.",
      "No worker copy is running.",
    ]);
    expect(summary.services.worker).toMatchObject({ running: 0, silent: 1, died: 2 });
    expect(summary.died.map((item) => item.lastSeenMsAgo)).toEqual([170_000, 240_000]);
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

    // Once the host has started it again under the same name, the new process counts for itself: one that
    // isn't ready after its two minutes is reported, whatever the process before it said.
    const startedAgain = summarize([admin("a1"), worker("w1", { draining: true, drainingForMs: 5_000, seenAt: NOW - 45_000, startedAt: NOW - 3_600_000 }), worker("w1", { startedAt: NOW - 40_000 })]);
    expect(startedAgain.ok).toBe(true);
    expect(startedAgain.copies.filter((item) => item.service === "worker").map((item) => item.state)).toEqual(["left", "running"]);
    const stuckAgain = summarize([admin("a1"), worker("w1", { draining: true, drainingForMs: 5_000, seenAt: NOW - 45_000, startedAt: NOW - 3_600_000 }), worker("w1", { startedAt: NOW - 40_000, seenAt: NOW - 35_000 })]);
    expect(stuckAgain.problems).toEqual(["worker copy w1 stopped reporting 35 s ago without shutting down, and no newer copy took its place.", "No worker copy is running."]);

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

  it("forgets a copy that left 10 minutes after its last beat", () => {
    const summary = summarize([admin("a1"), worker("w1"), worker("w2", { draining: true, seenAt: NOW - FLEET_FORGET_MS - 1 })]);

    expect(summary.ok).toBe(true);
    expect(summary.copies.map((item) => item.replica)).toEqual(["a1", "w1"]);
    expect(summary.died).toEqual([]);
  });

  it("stops reporting a copy that died after 10 minutes, and keeps its last beat for 24 hours", () => {
    const dead = (seenAt: number) => worker("w2", { seenAt, startedAt: NOW - 2 * FLEET_DIED_MS, liveCalls: 4, busy: 0.97 });

    // Nothing took its place: a problem for 10 minutes, as before.
    const early = summarize([admin("a1"), worker("w1", { startedAt: NOW - 2 * FLEET_DIED_MS }), dead(NOW - FLEET_FORGET_MS + 1_000)]);
    expect(early.problems).toEqual(["worker copy w2 stopped reporting 599 s ago without shutting down, and no newer copy took its place."]);
    expect(early.copies.find((item) => item.replica === "w2")?.state).toBe("silent");
    expect(early.died).toEqual([]);

    // Then no problem by itself, and only the number of running copies still tells.
    const later = [admin("a1"), worker("w1", { startedAt: NOW - 2 * FLEET_DIED_MS }), dead(NOW - FLEET_FORGET_MS - 1)];
    expect(summarize(later).ok).toBe(true);
    expect(summarize(later, { worker: 2 }).problems).toEqual(["1 worker copy is running, and 2 are expected."]);
    expect(summarize(later).copies.map((item) => item.replica)).toEqual(["a1", "w1"]);
    expect(summarize(later).died).toEqual([expect.objectContaining({ replica: "w2", state: "died", liveCalls: 4, busy: 0.97 })]);

    // Still there the next day, and gone after 24 hours.
    expect(summarize([admin("a1"), worker("w1"), dead(NOW - FLEET_DIED_MS + 60_000)]).died.map((item) => item.replica)).toEqual(["w2"]);
    const forgotten = summarize([admin("a1"), worker("w1"), dead(NOW - FLEET_DIED_MS - 1)]);
    expect(forgotten.died).toEqual([]);
    expect(forgotten.services.worker.died).toBe(0);
  });

  it("lists the newest 50 of the copies that died, and counts them all", () => {
    const dead = Array.from({ length: FLEET_DIED_MAX + 7 }, (_, index) => worker(`gone-${index}`, { seenAt: NOW - 3_600_000 - index * 1_000 }));
    const summary = summarize([admin("a1"), worker("w1"), ...dead]);

    expect(summary.ok).toBe(true);
    expect(summary.services.worker.died).toBe(FLEET_DIED_MAX + 7);
    expect(summary.died).toHaveLength(FLEET_DIED_MAX);
    expect(summary.died[0]?.replica).toBe("gone-0");
    expect(summary.died.at(-1)?.replica).toBe(`gone-${FLEET_DIED_MAX - 1}`);
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
