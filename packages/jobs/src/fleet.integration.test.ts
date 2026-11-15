import { randomUUID } from "node:crypto";

import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FLEET_DIED_MAX, FLEET_DIED_MS, FLEET_FORGET_MS, FLEET_LIST_MAX, FLEET_STALE_MS, readFleet, startFleetHeartbeat, summarizeFleet } from "./fleet";

// The heartbeat against a real Redis, as CI's database job runs it (REDIS_TEST_URL).
const testUrl = process.env.REDIS_TEST_URL;
const prefix = `lobbystack:fleet-test:${randomUUID()}`;
const seenKey = `${prefix}:fleet:seen`;
const beatsKey = `${prefix}:fleet:beats`;
const diedKey = `${prefix}:fleet:died`;
let inspector: Redis;

describe.runIf(Boolean(testUrl))("the fleet heartbeat in Redis", () => {
  beforeAll(() => {
    process.env.REDIS_URL = testUrl;
    process.env.REDIS_PREFIX = prefix;
    inspector = new Redis(testUrl!);
  });

  // A copy's last beat stays on the list after it stops, so each test starts from an empty one.
  beforeEach(async () => {
    await inspector.del(seenKey, beatsKey, diedKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await inspector.del(seenKey, beatsKey, diedKey);
    inspector.disconnect();
  });

  // Redis's time now, and a last beat written as a copy that stopped at `seenAt` left it.
  const redisNow = async () => Number((await inspector.time())[0]) * 1000;
  const lastBeat = (replica: string, draining: boolean, startedAt: number) => JSON.stringify({ service: "worker", replica, release: "abc1234", startedAt, draining, busy: 0.4, rssBytes: 1, heapUsedBytes: 1, ready: true, liveCalls: 2 });
  const put = async (member: string, seenAt: number, value: string) => {
    await inspector.zadd(seenKey, seenAt, member);
    await inspector.hset(beatsKey, member, value);
  };
  const members = async (key: string) => (await inspector.zrange(key, 0, "-1")).sort();

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

  it("reports a copy whose beats stopped, forgets one that left after 10 minutes, and keeps one that died for 24 hours", async () => {
    const now = await redisNow();
    const started = now - 3 * FLEET_DIED_MS;
    // A copy that died without a word a moment ago: its last beat is older than three beats.
    await put("worker:silent", now - FLEET_STALE_MS - 20_000, lastBeat("silent", false, started));
    // One that died 11 minutes ago, and one that died yesterday, a minute short of 24 hours ago.
    await put("worker:died", now - FLEET_FORGET_MS - 60_000, lastBeat("died", false, started));
    await put("worker:yesterday", now - FLEET_DIED_MS + 60_000, lastBeat("yesterday", false, started));
    // One that died over 24 hours ago, and one that said it was shutting down 11 minutes ago.
    await put("worker:long-ago", now - FLEET_DIED_MS - 60_000, lastBeat("long-ago", false, started));
    await put("worker:left", now - FLEET_FORGET_MS - 60_000, lastBeat("left", true, started));
    // A status nothing can read is left out, and goes after 10 minutes like a copy that left.
    await put("worker:garbled", now, "{not json");
    await put("worker:garbled-old", now - FLEET_FORGET_MS - 60_000, "{not json");

    // Nothing beats, as when every copy is down: the read alone tells the same story.
    const before = summarizeFleet(await readFleet());
    expect(before.copies.map((item) => `${item.replica}:${item.state}`)).toEqual(["silent:silent"]);
    expect(before.died.map((item) => item.replica)).toEqual(["died", "yesterday"]);
    expect(before.ok).toBe(false);
    expect(before.problems).toEqual([
      "No admin copy is running.",
      expect.stringMatching(/^worker copy silent stopped reporting \d+ s ago without shutting down/),
      "No worker copy is running.",
    ]);

    const admin = startFleetHeartbeat({ service: "admin", replica: "a1", release: "abc1234" }, undefined, { intervalMs: 3_600_000 });
    await admin.beat();
    // The beat tidied up. The copy that left, the old status nothing reads and the copy that died over a day ago
    // are gone, and the two that died within the day moved to their own list with their last beats.
    const beating = expect.stringMatching(/^admin:a1:\d+$/);
    expect(await members(seenKey)).toEqual([beating, "worker:garbled", "worker:silent"]);
    expect(await members(diedKey)).toEqual(["worker:died", "worker:yesterday"]);
    expect((await inspector.hkeys(beatsKey)).sort()).toEqual([beating, "worker:died", "worker:garbled", "worker:silent", "worker:yesterday"]);
    // They are still listed, each with what it held at its last beat and when that was.
    const after = summarizeFleet(await readFleet());
    expect(after.died.map((item) => item.replica)).toEqual(["died", "yesterday"]);
    expect(after.died[0]).toMatchObject({ state: "died", liveCalls: 2, busy: 0.4, seenAt: now - FLEET_FORGET_MS - 60_000 });
    expect(after.services.worker).toMatchObject({ silent: 1, died: 2 });
    // Every key expires by itself once every copy is gone, a day after the last beat.
    for (const key of [seenKey, beatsKey, diedKey]) {
      expect(await inspector.pttl(key)).toBeGreaterThan(FLEET_DIED_MS);
      expect(await inspector.pttl(key)).toBeLessThanOrEqual(FLEET_DIED_MS + FLEET_FORGET_MS);
    }

    // The next beats leave them where they are, until one is a day old: then it goes, with its last beat.
    await admin.beat();
    expect(await members(diedKey)).toEqual(["worker:died", "worker:yesterday"]);
    await inspector.zadd(diedKey, (await redisNow()) - FLEET_DIED_MS - 60_000, "worker:yesterday");
    await admin.beat();
    expect(await members(diedKey)).toEqual(["worker:died"]);
    expect((await inspector.hkeys(beatsKey)).sort()).toEqual([beating, "worker:died", "worker:garbled", "worker:silent"]);
    expect(summarizeFleet(await readFleet()).died.map((item) => item.replica)).toEqual(["died"]);
    await admin.stop();
  });

  it("keeps the last beat of a process that died when the host starts the copy again under the same name", async () => {
    // Two processes, one after the other, under one name: each knows when it started.
    const uptime = vi.spyOn(process, "uptime");
    uptime.mockReturnValue(3_600);
    const first = startFleetHeartbeat({ service: "worker", replica: "w1", release: "abc1234" }, () => ({ ready: true, liveCalls: 3 }), { intervalMs: 3_600_000 });
    await first.beat();
    // The first dies without a word: it writes nothing more, and the host starts the copy again.
    uptime.mockReturnValue(2);
    const second = startFleetHeartbeat({ service: "worker", replica: "w1", release: "abc1234" }, () => ({ ready: true, liveCalls: 0 }), { intervalMs: 3_600_000 });
    await second.beat();
    await second.beat();

    expect(await inspector.hlen(beatsKey)).toBe(2);
    const { now, records } = await readFleet();
    expect(records.map((record) => record.liveCalls).sort()).toEqual([0, 3]);
    // Three missed beats later the first reads as a copy that died, with the calls it held, and the second runs.
    const later = summarizeFleet({ now: now + FLEET_STALE_MS + 1_000, records: records.map((record) => (record.liveCalls === 0 ? { ...record, seenAt: now + FLEET_STALE_MS } : record)) });
    expect(later.copies.map((item) => `${item.replica}:${item.state}:${item.liveCalls}`)).toEqual(["w1:running:0"]);
    expect(later.died.map((item) => `${item.replica}:${item.state}:${item.liveCalls}`)).toEqual(["w1:died:3"]);
    expect(later.problems).toEqual(["No admin copy is running."]);
    await second.stop();
  });

  it("takes a copy off the list of copies that died when it reports again", async () => {
    // A copy that couldn't reach Redis for a while, or stood still, and then goes on: it never died.
    const worker = startFleetHeartbeat({ service: "worker", replica: "w1", release: "abc1234" }, () => ({ ready: true }), { intervalMs: 3_600_000 });
    await worker.beat();
    const [member] = await members(seenKey);
    await inspector.zadd(seenKey, (await redisNow()) - FLEET_FORGET_MS - 60_000, member!);
    const admin = startFleetHeartbeat({ service: "admin", replica: "a1", release: "abc1234" }, undefined, { intervalMs: 3_600_000 });
    await admin.beat();
    expect(await members(diedKey)).toEqual([member]);
    expect(summarizeFleet(await readFleet()).died.map((item) => item.replica)).toEqual(["w1"]);

    await worker.beat();
    expect(await members(diedKey)).toEqual([]);
    expect(await members(seenKey)).toEqual([expect.stringMatching(/^admin:a1:\d+$/), member]);
    const summary = summarizeFleet(await readFleet());
    expect(summary.copies.map((item) => `${item.replica}:${item.state}`)).toEqual(["a1:running", "w1:running"]);
    expect(summary.died).toEqual([]);
    expect(summary.ok).toBe(true);
    await Promise.all([admin.stop(), worker.stop()]);
  });

  it("keeps the newest 50 copies that died, and never more than 1,000 copies heard from lately, whatever restarts how often", async () => {
    const now = await redisNow();
    // 60 copies that died within the day, each a minute before the one before.
    const dead = inspector.pipeline();
    for (let index = 0; index < FLEET_DIED_MAX + 10; index += 1) {
      dead.zadd(seenKey, now - FLEET_FORGET_MS - (index + 1) * 60_000, `worker:dead-${index}`);
      dead.hset(beatsKey, `worker:dead-${index}`, lastBeat(`dead-${index}`, false, now - 2 * FLEET_DIED_MS));
    }
    await dead.exec();
    const admin = startFleetHeartbeat({ service: "admin", replica: "a1", release: "abc1234" }, undefined, { intervalMs: 3_600_000 });
    await admin.beat();

    const kept = await members(diedKey);
    expect(kept).toHaveLength(FLEET_DIED_MAX);
    expect(kept).toContain("worker:dead-0");
    expect(kept).toContain(`worker:dead-${FLEET_DIED_MAX - 1}`);
    expect(kept).not.toContain(`worker:dead-${FLEET_DIED_MAX}`);
    expect(await members(seenKey)).toEqual([expect.stringMatching(/^admin:a1:\d+$/)]);
    expect(await inspector.hlen(beatsKey)).toBe(FLEET_DIED_MAX + 1);

    // A process that starts again without end, each time long enough to beat once: 1,200 within 10 minutes.
    const loop = inspector.pipeline();
    for (let index = 0; index < FLEET_LIST_MAX + 200; index += 1) {
      loop.zadd(seenKey, now - 300_000 + index * 100, `worker:loop:${index}`);
      loop.hset(beatsKey, `worker:loop:${index}`, lastBeat("loop", false, now - 300_000 + index * 100 - 1_000));
    }
    await loop.exec();
    // The list is checked whenever a process joins it, as each of those would have.
    const joining = startFleetHeartbeat({ service: "admin", replica: "a2", release: "abc1234" }, undefined, { intervalMs: 3_600_000 });
    await joining.beat();

    expect(await inspector.zcard(seenKey)).toBe(FLEET_LIST_MAX);
    expect(await inspector.zcard(diedKey)).toBe(FLEET_DIED_MAX);
    expect(await inspector.hlen(beatsKey)).toBe(FLEET_LIST_MAX + FLEET_DIED_MAX);
    // The oldest went: the loop's first processes. The copies that beat stay, and so do the ones that died earlier.
    const left = await inspector.zrange(seenKey, 0, "-1");
    expect(left).not.toContain("worker:loop:0");
    expect(left).not.toContain("worker:loop:201");
    expect(left[0]).toBe("worker:loop:202");
    expect(left).toContain(`worker:loop:${FLEET_LIST_MAX + 199}`);
    expect(left.slice(-2)).toEqual([expect.stringMatching(/^admin:a1:\d+$/), expect.stringMatching(/^admin:a2:\d+$/)]);
    // The answer still lists 50 at most, counts them all, and reports the one process nothing replaced.
    const summary = summarizeFleet(await readFleet());
    expect(summary.died).toHaveLength(FLEET_DIED_MAX);
    expect(summary.died.every((item) => item.replica === "loop")).toBe(true);
    expect(summary.services.worker.died).toBe(FLEET_LIST_MAX - 3 + FLEET_DIED_MAX);
    expect(summary.services.worker.silent).toBe(1);
    await Promise.all([admin.stop(), joining.stop()]);
  });

  it("looks at 100 old copies a beat at most, and at each of them once", async () => {
    const now = await redisNow();
    // A large fleet's deploy, 11 minutes ago: 250 copies that left, and 5 that died.
    const old = inspector.pipeline();
    for (let index = 0; index < 255; index += 1) {
      old.zadd(seenKey, now - FLEET_FORGET_MS - 60_000 - index, `worker:old-${index}`);
      old.hset(beatsKey, `worker:old-${index}`, lastBeat(`old-${index}`, index >= 5, now - FLEET_DIED_MS));
    }
    await old.exec();
    const admin = startFleetHeartbeat({ service: "admin", replica: "a1", release: "abc1234" }, undefined, { intervalMs: 3_600_000 });
    await admin.beat();
    // The oldest 100 are dealt with, and the rest wait for the next beats. A read never shows the wait.
    expect(await inspector.zcard(seenKey)).toBe(255 - 100 + 1);
    const during = summarizeFleet(await readFleet());
    expect(during.copies.map((item) => item.replica)).toEqual(["a1"]);
    expect(during.died.map((item) => item.replica)).toEqual(["old-0", "old-1", "old-2", "old-3", "old-4"]);

    await admin.beat();
    await admin.beat();
    expect(await members(seenKey)).toEqual([expect.stringMatching(/^admin:a1:\d+$/)]);
    expect(await members(diedKey)).toEqual(["worker:old-0", "worker:old-1", "worker:old-2", "worker:old-3", "worker:old-4"]);
    expect(await inspector.hlen(beatsKey)).toBe(6);
    const after = summarizeFleet(await readFleet());
    expect(after.died.map((item) => item.replica)).toEqual(during.died.map((item) => item.replica));
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
