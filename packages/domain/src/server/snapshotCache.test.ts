import { beforeEach, describe, expect, it, vi } from "vitest";

import { demoSnapshot, type BusinessContextSnapshot } from "@lobbystack/shared";

import type { DomainContext } from "./context";
import { deserializeSnapshot, getCachedBusinessSnapshot, redisSnapshotCache, snapshotCacheKey, snapshotVersionKey, SNAPSHOT_CACHE_TTL_SECONDS, type SnapshotCacheClient } from "./snapshotCache";

vi.mock("./knowledge", () => ({
  loadLatestBusinessSnapshot: vi.fn(),
}));

import { loadLatestBusinessSnapshot } from "./knowledge";

const businessId = "00000000-0000-4000-8000-000000000001";

const loadMock = vi.mocked(loadLatestBusinessSnapshot);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REDIS_PREFIX", "lobbystack");
  loadMock.mockResolvedValue({ ...demoSnapshot, displayName: "Loaded" });
});

function memoryCache(): SnapshotCacheClient {
  const store = new Map<string, BusinessContextSnapshot>();
  return { get: async (id) => store.get(id) ?? null, set: async (id, snapshot) => { store.set(id, snapshot); } };
}

const validSnapshot = {
  ...demoSnapshot,
  businessId,
  services: demoSnapshot.services.map((service, index) => ({ ...service, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` })),
};

function makeContext(snapshotCache: DomainContext["snapshotCache"] | null): DomainContext {
  return snapshotCache ? { db: {} as never, snapshotCache } : { db: {} as never };
}

describe("snapshot cache contract", () => {
  it("keys by business under a stable shared prefix", () => {
    expect(snapshotCacheKey(businessId)).toBe(`lobbystack:widget:snapshot:${businessId}`);
  });

  it("deserializes a snapshot through zod", () => {
    const parsed = deserializeSnapshot(JSON.stringify(validSnapshot));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      businessId,
      displayName: demoSnapshot.displayName,
      chatInstructions: demoSnapshot.chatInstructions,
      hours: demoSnapshot.hours,
    });
    expect(deserializeSnapshot("garbage")).toBeNull();
    expect(deserializeSnapshot(null)).toBeNull();
    expect(deserializeSnapshot(undefined)).toBeNull();
  });
});

describe("redisSnapshotCache", () => {
  it("stores JSON under the shared key with the TTL and reads it back", async () => {
    const store = new Map<string, string>();
    const set = vi.fn(async (key: string, value: string) => { store.set(key, value); return "OK"; });
    const cache = redisSnapshotCache(() => ({ get: async (key) => store.get(key) ?? null, set }));
    await cache.set(businessId, validSnapshot);
    expect(set).toHaveBeenCalledWith(snapshotCacheKey(businessId), JSON.stringify(validSnapshot), "EX", SNAPSHOT_CACHE_TTL_SECONDS);
    await expect(cache.get(businessId)).resolves.toMatchObject({ businessId, displayName: demoSnapshot.displayName });
  });

  it("writes the snapshot's version after it, and no version when the snapshot couldn't be stored", async () => {
    const store = new Map<string, string>();
    const set = vi.fn(async (key: string, value: string) => { store.set(key, value); return "OK"; });
    const cache = redisSnapshotCache(() => ({ get: async (key) => store.get(key) ?? null, set }));
    await cache.set(businessId, { ...validSnapshot, version: "1700000000001" });
    expect(set.mock.calls.map(([key]) => key)).toEqual([snapshotCacheKey(businessId), snapshotVersionKey(businessId)]);
    expect(set).toHaveBeenLastCalledWith(snapshotVersionKey(businessId), "1700000000001", "EX", SNAPSHOT_CACHE_TTL_SECONDS);
    expect(snapshotVersionKey(businessId)).toBe(`lobbystack:widget:snapshot-version:${businessId}`);

    const refused = vi.fn(async (key: string) => { if (key === snapshotCacheKey(businessId)) throw new Error("full"); return "OK"; });
    await redisSnapshotCache(() => ({ get: async () => null, set: refused })).set(businessId, validSnapshot);
    expect(refused.mock.calls.map(([key]) => key)).toEqual([snapshotCacheKey(businessId)]);
  });

  it("reads a miss and drops the write when Redis is missing or failing", async () => {
    const failing = redisSnapshotCache(() => ({ get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); } }));
    await expect(failing.get(businessId)).resolves.toBeNull();
    await expect(failing.set(businessId, validSnapshot)).resolves.toBeUndefined();
    const missing = redisSnapshotCache(() => undefined);
    await expect(missing.get(businessId)).resolves.toBeNull();
    await expect(missing.set(businessId, validSnapshot)).resolves.toBeUndefined();
  });
});

describe("snapshots kept in memory", () => {
  const otherId = "00000000-0000-4000-8000-000000000002";
  const thirdId = "00000000-0000-4000-8000-000000000003";
  // A fake Redis that counts the reads of each key.
  function fakeRedis() {
    const store = new Map<string, string>();
    const reads = new Map<string, number>();
    const client = {
      get: async (key: string) => { reads.set(key, (reads.get(key) ?? 0) + 1); return store.get(key) ?? null; },
      set: async (key: string, value: string) => { store.set(key, value); return "OK"; },
    };
    const snapshotReads = (id: string) => reads.get(snapshotCacheKey(id)) ?? 0;
    return { store, client, snapshotReads };
  }
  const version = (id: string, value: string, displayName = "Clinic") => ({ ...validSnapshot, businessId: id, version: value, displayName });

  it("parses a snapshot once and then reads only its version, sharing one frozen copy", async () => {
    const redis = fakeRedis();
    const cache = redisSnapshotCache(() => redis.client);
    await cache.set(businessId, version(businessId, "1"));
    const first = await cache.get(businessId);
    const second = await cache.get(businessId);
    expect(first).toMatchObject({ version: "1", displayName: "Clinic" });
    expect(second).toBe(first);
    expect(redis.snapshotReads(businessId)).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.services)).toBe(true);
    expect(Object.isFrozen(first?.services[0])).toBe(true);
    expect(() => { (first as { displayName: string }).displayName = "Changed"; }).toThrow(TypeError);
  });

  it("shows a refresh as soon as Redis has its version", async () => {
    const redis = fakeRedis();
    const cache = redisSnapshotCache(() => redis.client);
    await cache.set(businessId, version(businessId, "1"));
    await cache.get(businessId);
    // Another process refreshes the snapshot.
    await redisSnapshotCache(() => redis.client).set(businessId, version(businessId, "2", "Refreshed"));
    await expect(cache.get(businessId)).resolves.toMatchObject({ version: "2", displayName: "Refreshed" });
    await expect(cache.get(businessId)).resolves.toMatchObject({ version: "2" });
    expect(redis.snapshotReads(businessId)).toBe(2);
  });

  it("parses every read of a snapshot Redis has no version for, as an older release writes it", async () => {
    const redis = fakeRedis();
    redis.store.set(snapshotCacheKey(businessId), JSON.stringify(version(businessId, "1")));
    const cache = redisSnapshotCache(() => redis.client);
    const first = await cache.get(businessId);
    const second = await cache.get(businessId);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(redis.snapshotReads(businessId)).toBe(2);
  });

  it("parses a kept snapshot again once it is older than the most it is kept", async () => {
    const redis = fakeRedis();
    let clock = 0;
    const cache = redisSnapshotCache(() => redis.client, { maxAgeMs: 60_000, now: () => clock });
    await cache.set(businessId, version(businessId, "1"));
    await cache.get(businessId);
    clock = 59_999;
    await cache.get(businessId);
    expect(redis.snapshotReads(businessId)).toBe(1);
    clock = 60_000;
    await cache.get(businessId);
    expect(redis.snapshotReads(businessId)).toBe(2);
  });

  it("drops the least recently read snapshot when the ones kept pass the size they may take", async () => {
    const redis = fakeRedis();
    const chars = JSON.stringify(version(businessId, "1")).length;
    const cache = redisSnapshotCache(() => redis.client, { maxChars: chars * 2 + 10 });
    for (const id of [businessId, otherId, thirdId]) await cache.set(id, version(id, "1"));
    await cache.get(businessId);
    await cache.get(otherId);
    await cache.get(businessId);
    // Room for two: the third drops the one read longest ago.
    await cache.get(thirdId);
    await cache.get(businessId);
    await cache.get(thirdId);
    expect([redis.snapshotReads(businessId), redis.snapshotReads(thirdId)]).toEqual([1, 1]);
    await cache.get(otherId);
    expect(redis.snapshotReads(otherId)).toBe(2);
  });

  it("never keeps a snapshot bigger than the size they may take", async () => {
    const redis = fakeRedis();
    const cache = redisSnapshotCache(() => redis.client, { maxChars: 100 });
    await cache.set(businessId, version(businessId, "1"));
    await cache.get(businessId);
    await cache.get(businessId);
    expect(redis.snapshotReads(businessId)).toBe(2);
  });
});

describe("getCachedBusinessSnapshot", () => {
  it("serves a cache hit without reading the database", async () => {
    const cache = memoryCache();
    await cache.set(businessId, { ...demoSnapshot, displayName: "Clinic" });
    const result = await getCachedBusinessSnapshot(makeContext(cache), { businessId });
    expect(result?.displayName).toBe("Clinic");
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("loads and backfills the cache on a miss", async () => {
    const cache = memoryCache();
    const result = await getCachedBusinessSnapshot(makeContext(cache), { businessId });
    expect(result?.displayName).toBe("Loaded");
    expect(loadMock).toHaveBeenCalledTimes(1);
    await expect(cache.get(businessId)).resolves.toEqual(expect.objectContaining({ displayName: "Loaded" }));
  });

  it("does not cache a null snapshot across turns", async () => {
    loadMock.mockResolvedValue(null as BusinessContextSnapshot | null);
    const cache = memoryCache();
    await getCachedBusinessSnapshot(makeContext(cache), { businessId });
    await getCachedBusinessSnapshot(makeContext(cache), { businessId });
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a direct read when no cache is configured", async () => {
    const result = await getCachedBusinessSnapshot(makeContext(null), { businessId });
    expect(result?.displayName).toBe("Loaded");
    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});
