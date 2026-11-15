import { randomUUID } from "node:crypto";

import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FLEET_FORGET_MS, FLEET_STALE_MS, readFleet, startFleetHeartbeat, summarizeFleet } from "./fleet";

// The heartbeat against a real Redis, as CI's database job runs it (REDIS_TEST_URL).
const testUrl = process.env.REDIS_TEST_URL;
const prefix = `lobbystack:fleet-test:${randomUUID()}`;
const seenKey = `${prefix}:fleet:seen`;
const beatsKey = `${prefix}:fleet:beats`;
let inspector: Redis;

describe.runIf(Boolean(testUrl))("the fleet heartbeat in Redis", () => {
  beforeAll(() => {
    process.env.REDIS_URL = testUrl;
    process.env.REDIS_PREFIX = prefix;
    inspector = new Redis(testUrl!);
  });

  // A copy's last beat stays on the list after it stops, so each test starts from an empty one.
  beforeEach(async () => {
    await inspector.del(seenKey, beatsKey);
  });

  afterAll(async () => {
    await inspector.del(seenKey, beatsKey);
    inspector.disconnect();
  });

  it("lists every copy's beat, marks one that is shutting down, and keeps the last word of one that stopped", async () => {
    const queues = { critical: { waiting: 3, active: 1, delayed: 0, failed: 0 } };
    let calls = 0;
    // An hour between beats: only the first one and the ones asked for are written.
    const admin = startFleetHeartbeat({ service: "admin", replica: "a1", release: "abc1234", deployment: "dep-1", region: "us-west2" }, () => ({ db: { open: 3, inUse: 1, waiting: 0, max: 24 } }), { intervalMs: 3_600_000 });
    const worker = startFleetHeartbeat({ service: "worker", replica: "w1", release: "abc1234" }, () => ({ ready: true, activeJobs: 2, liveCalls: (calls += 1), queues }), { intervalMs: 3_600_000 });
    await Promise.all([admin.beat(), worker.beat()]);

    const first = await readFleet();
    expect(first.records.map((record) => `${record.service}:${record.replica}`).sort()).toEqual(["admin:a1", "worker:w1"]);
    const seenAdmin = first.records.find((record) => record.service === "admin")!;
    expect(seenAdmin).toMatchObject({ release: "abc1234", deployment: "dep-1", region: "us-west2", draining: false, db: { open: 3, inUse: 1, waiting: 0, max: 24 } });
    expect(seenAdmin.busy).toBeGreaterThanOrEqual(0);
    expect(seenAdmin.busy).toBeLessThanOrEqual(1);
    expect(seenAdmin.rssBytes).toBeGreaterThan(0);
    // The start is this process's, and the beat's time is Redis's: both are near now.
    expect(Math.abs(first.now - seenAdmin.seenAt)).toBeLessThan(5_000);
    expect(seenAdmin.startedAt).toBeLessThanOrEqual(Date.now());
    expect(first.records.find((record) => record.service === "worker")).toMatchObject({ ready: true, activeJobs: 2, liveCalls: 1, queues });
    const healthy = summarizeFleet(first);
    expect(healthy.ok).toBe(true);
    expect(healthy.queues).toEqual(queues);

    // A beat is one round trip that replaces the copy's last one.
    await worker.beat();
    expect((await readFleet()).records.find((record) => record.service === "worker")).toMatchObject({ liveCalls: 2 });
    expect(await inspector.hlen(beatsKey)).toBe(2);

    await worker.drain();
    const draining = await readFleet();
    expect(draining.records.find((record) => record.service === "worker")).toMatchObject({ draining: true });
    expect(summarizeFleet(draining).copies.find((item) => item.service === "worker")?.state).toBe("draining");

    await worker.stop();
    const stopped = await readFleet();
    // Its last beat stays: it was shutting down, so it left on purpose and is handing over to the next copy.
    expect(stopped.records.find((record) => record.service === "worker")).toMatchObject({ draining: true });
    expect(summarizeFleet(stopped).ok).toBe(true);
    // Stopped for good: a late beat writes nothing, and doesn't even read what the copy holds.
    const sampled = calls;
    await worker.beat();
    expect(calls).toBe(sampled);
    expect((await readFleet()).records.find((record) => record.service === "worker")).toMatchObject({ liveCalls: sampled });

    // A copy that is only told to stop says it is shutting down in the same breath.
    expect((await readFleet()).records.find((record) => record.service === "admin")).toMatchObject({ draining: false });
    await admin.stop();
    const both = await readFleet();
    expect(both.records.find((record) => record.service === "admin")).toMatchObject({ draining: true });
    expect(await inspector.hlen(beatsKey)).toBe(2);
    // Once their beats are 30 seconds old, both read as copies that left, never as copies that died.
    const later = summarizeFleet({ now: both.now + FLEET_STALE_MS + 1_000, records: both.records });
    expect(later.copies.map((item) => `${item.replica}:${item.state}`)).toEqual(["a1:left", "w1:left"]);
    expect(later.services).toMatchObject({ admin: { silent: 0 }, worker: { silent: 0 } });
  });

  it("reports a copy whose beats stopped, then forgets it when another copy beats 10 minutes later", async () => {
    const [seconds] = await inspector.time();
    const now = Number(seconds) * 1000;
    const dead = JSON.stringify({ service: "worker", replica: "dead", release: "abc1234", startedAt: now - 3_600_000, draining: false, busy: 0, rssBytes: 1, heapUsedBytes: 1 });
    // A copy that died without a word: its last beat is older than three beats.
    await inspector.zadd(seenKey, now - FLEET_STALE_MS - 20_000, "worker:dead");
    await inspector.hset(beatsKey, "worker:dead", dead);
    // Left over from long ago, such as from before a restart of every copy.
    await inspector.zadd(seenKey, now - FLEET_FORGET_MS - 60_000, "worker:forgotten");
    await inspector.hset(beatsKey, "worker:forgotten", dead.replace('"dead"', '"forgotten"'));
    // A status nothing can read is left out.
    await inspector.zadd(seenKey, now, "worker:garbled");
    await inspector.hset(beatsKey, "worker:garbled", "{not json");

    const before = summarizeFleet(await readFleet());
    expect(before.copies.map((item) => `${item.replica}:${item.state}`)).toEqual(["dead:silent"]);
    expect(before.ok).toBe(false);
    expect(before.problems).toEqual([
      "No admin copy is running.",
      expect.stringMatching(/^worker copy dead stopped reporting \d+ s ago without shutting down/),
      "No worker copy is running.",
    ]);

    const admin = startFleetHeartbeat({ service: "admin", replica: "a1", release: "abc1234" }, undefined, { intervalMs: 3_600_000 });
    await admin.beat();
    // The beat cleaned up after the copy that was past 10 minutes.
    expect((await inspector.hkeys(beatsKey)).sort()).toEqual(["admin:a1", "worker:dead", "worker:garbled"]);
    expect(await inspector.zscore(seenKey, "worker:forgotten")).toBeNull();
    // Both keys expire by themselves once every copy is gone.
    expect(await inspector.pttl(seenKey)).toBeGreaterThan(FLEET_FORGET_MS);
    expect(await inspector.pttl(beatsKey)).toBeLessThanOrEqual(2 * FLEET_FORGET_MS);
    await admin.stop();
  });

  it("keeps a failed beat from stopping the next one, and reports it once", async () => {
    const errors: unknown[] = [];
    let fail = true;
    const heartbeat = startFleetHeartbeat({ service: "admin", replica: "flaky", release: "abc1234" }, () => {
      if (fail) throw new Error("the sample broke");
      return {};
    }, { intervalMs: 3_600_000, onError: (error) => errors.push(error) });

    await heartbeat.beat();
    await heartbeat.beat();
    expect(errors).toHaveLength(1);
    expect((await readFleet()).records.some((record) => record.replica === "flaky")).toBe(false);

    fail = false;
    await heartbeat.beat();
    expect((await readFleet()).records.some((record) => record.replica === "flaky")).toBe(true);
    await heartbeat.stop();
  });
});
