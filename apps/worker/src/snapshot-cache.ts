import { redisSnapshotCache, type SnapshotCacheClient } from "@lobbystack/domain";

import { createRedisConnection } from "@lobbystack/jobs";

let cache: SnapshotCacheClient | undefined;

// One for the process, shared by calls and jobs, since it keeps the snapshots
// it parsed in memory.
export function getWorkerSnapshotCache(): SnapshotCacheClient {
  if (!cache) {
    const connection = createRedisConnection({ prefix: process.env.REDIS_PREFIX ?? "lobbystack" });
    connection.on("error", () => undefined);
    cache = redisSnapshotCache(() => connection);
  }
  return cache;
}
