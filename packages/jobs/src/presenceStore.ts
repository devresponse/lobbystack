import Redis from "ioredis";

import { logRedisErrors } from "./redisErrors";

let redis: Redis | undefined;

/**
 * The Redis connection that live-call presence and the fleet heartbeat share.
 * Both send one short script at a time. A command fails after one retry
 * instead of waiting for Redis to come back, so nothing piles up during an
 * outage.
 */
export function presenceStore(purpose: string): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error(`${purpose} requires REDIS_URL.`);
  redis ??= logRedisErrors(new Redis(url, {
    protocol: 2,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectionName: "lobbystack:voice-presence",
  }), "lobbystack:voice-presence");
  return redis;
}
