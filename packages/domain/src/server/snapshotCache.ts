import { snapshotSchema } from "@lobbystack/contracts";
import type { BusinessContextSnapshot } from "@lobbystack/shared";

import { snapshotForReceptionist } from "../snapshot";
import type { DomainContext } from "./context";
import { loadLatestBusinessSnapshot } from "./knowledge";

export const SNAPSHOT_CACHE_TTL_SECONDS = 300;
// How long a process keeps a parsed snapshot while Redis still names its
// version, and how much snapshot JSON (in characters) it keeps in all.
export const SNAPSHOT_MEMORY_MAX_AGE_MS = 60_000;
export const SNAPSHOT_MEMORY_MAX_CHARS = 16 * 1024 * 1024;

export type SnapshotCacheClient = {
  get(businessId: string): Promise<BusinessContextSnapshot | null>;
  set(businessId: string, snapshot: BusinessContextSnapshot): Promise<void>;
};

export function snapshotCacheKey(businessId: string): string {
  return `${process.env.REDIS_PREFIX ?? "lobbystack"}:widget:snapshot:${businessId}`;
}

/** The version of the snapshot under snapshotCacheKey, written after it. */
export function snapshotVersionKey(businessId: string): string {
  return `${process.env.REDIS_PREFIX ?? "lobbystack"}:widget:snapshot-version:${businessId}`;
}

export function deserializeSnapshot(raw: string | null | undefined): BusinessContextSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = snapshotSchema.loose().safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as BusinessContextSnapshot) : null;
  } catch {
    return null;
  }
}

/** The slice of an ioredis client the snapshot cache uses. */
export type SnapshotRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
};

/** Freezes a parsed snapshot all the way down, since every reader shares it. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

/**
 * A snapshot cache over Redis. `redis` is resolved on every call; a missing
 * client or a Redis error reads as a miss and drops the write.
 *
 * Every chat message and call start reads the business's snapshot, which
 * grows with its receptionists (2.3 MB and 7 ms to parse for 50), so the
 * cache keeps each parsed snapshot in memory and, while Redis names the same
 * version, reads only the version: a refresh shows as soon as Redis has it,
 * as before. A kept snapshot is frozen, since every reader shares it. It goes
 * when the snapshots kept pass SNAPSHOT_MEMORY_MAX_CHARS, least recently read
 * first, and after SNAPSHOT_MEMORY_MAX_AGE_MS, which bounds how long one
 * shows after an older release, which writes no version, replaced it. With
 * no version in Redis every read parses the snapshot, as before. Keep one
 * cache per process: the memory is the instance's.
 */
export function redisSnapshotCache(
  redis: () => SnapshotRedis | undefined,
  options: { maxAgeMs?: number; maxChars?: number; now?: () => number } = {},
): SnapshotCacheClient {
  const maxAgeMs = options.maxAgeMs ?? SNAPSHOT_MEMORY_MAX_AGE_MS;
  const maxChars = options.maxChars ?? SNAPSHOT_MEMORY_MAX_CHARS;
  const now = options.now ?? Date.now;
  // In the order they were last read, so the first is the one to drop.
  const kept = new Map<string, { snapshot: BusinessContextSnapshot; chars: number; keptAt: number }>();
  let keptChars = 0;
  const forget = (businessId: string) => {
    const entry = kept.get(businessId);
    if (!entry) return;
    kept.delete(businessId);
    keptChars -= entry.chars;
  };
  return {
    async get(businessId) {
      const client = redis();
      if (!client) return null;
      const entry = kept.get(businessId);
      if (entry && now() - entry.keptAt < maxAgeMs) {
        const version = await client.get(snapshotVersionKey(businessId)).catch(() => null);
        if (version === entry.snapshot.version) {
          if (kept.get(businessId) === entry) {
            kept.delete(businessId);
            kept.set(businessId, entry);
          }
          return entry.snapshot;
        }
      }
      const raw = await client.get(snapshotCacheKey(businessId)).catch(() => null);
      const snapshot = deserializeSnapshot(raw);
      forget(businessId);
      if (!snapshot || !raw || raw.length > maxChars) return snapshot;
      kept.set(businessId, { snapshot: deepFreeze(snapshot), chars: raw.length, keptAt: now() });
      keptChars += raw.length;
      for (const [oldest] of kept) {
        if (keptChars <= maxChars) break;
        forget(oldest);
      }
      return snapshot;
    },
    async set(businessId, snapshot) {
      const client = redis();
      if (!client) return;
      // The version only once the snapshot is stored, so Redis never names a
      // version it hasn't got.
      const stored = await client.set(snapshotCacheKey(businessId), JSON.stringify(snapshot), "EX", SNAPSHOT_CACHE_TTL_SECONDS).then(() => true, () => false);
      if (stored) await client.set(snapshotVersionKey(businessId), snapshot.version, "EX", SNAPSHOT_CACHE_TTL_SECONDS).catch(() => undefined);
    },
  };
}

export async function getCachedBusinessSnapshot(
  context: DomainContext,
  input: { businessId: string },
): Promise<BusinessContextSnapshot | null> {
  const cache = context.snapshotCache;
  if (!cache) {
    return await loadLatestBusinessSnapshot(context, { businessId: input.businessId });
  }
  const cached = await cache.get(input.businessId).catch(() => null);
  if (cached) return cached;
  const snapshot = await loadLatestBusinessSnapshot(context, { businessId: input.businessId });
  if (snapshot) {
    await cache.set(input.businessId, snapshot).catch(() => undefined);
  }
  return snapshot;
}

/**
 * One receptionist's view of the business's snapshot, from the cache like
 * getCachedBusinessSnapshot: its own settings and the articles it may use
 * (snapshotForReceptionist). Null, or a receptionist that is paused, archived
 * or unknown, gets the default receptionist's view; the view's `receptionist`
 * says which one answers, for the call or chat's record.
 */
export async function getCachedReceptionistSnapshot(
  context: DomainContext,
  input: { businessId: string; receptionistId?: string | null | undefined },
): Promise<BusinessContextSnapshot | null> {
  const snapshot = await getCachedBusinessSnapshot(context, { businessId: input.businessId });
  return snapshot ? snapshotForReceptionist(snapshot, input.receptionistId) : null;
}
