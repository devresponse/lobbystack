import { redisSnapshotCache, type SnapshotCacheClient } from "@lobbystack/domain";

import { getRedis } from "./redis";

// One for the process, since it keeps the snapshots it parsed in memory.
const cache = redisSnapshotCache(getRedis);

export const getAdminSnapshotCache = (): SnapshotCacheClient => cache;
