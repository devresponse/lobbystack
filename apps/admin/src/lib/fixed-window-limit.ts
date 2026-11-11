import { createHash } from "node:crypto";

import { readyRedis } from "./redis";

export type FixedWindowLimit = {
  name: string;
  key: string;
  limit: number;
  windowSeconds: number;
  reason: string;
};

export type FixedWindowResult =
  | { allowed: true }
  | { allowed: false; status: 429 | 503; reason: string };

/**
 * One counter in `namespace`, named by `key` and the current window. The key
 * goes into Redis as it is: ids (a user's, a business's, an API key's) name
 * their counters directly, as the public API's per-key limit does, and an IP
 * address goes in as its `clientIpDigest`, so Redis never holds an address.
 */
export function fixedWindowLimit(namespace: string, name: string, key: string, maximum: number, windowSeconds: number, reason: string): FixedWindowLimit {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1_000));
  return {
    name,
    key: `${process.env.REDIS_PREFIX ?? "lobbystack"}:${namespace}:${name}:${key}:${bucket}`,
    limit: maximum,
    windowSeconds,
    reason,
  };
}

// Check every counter first, then count the request against all of them, so a
// rejected request consumes no quota.
const script = `
  for index, key in ipairs(KEYS) do
    local count = tonumber(redis.call('GET', key) or '0')
    if count >= tonumber(ARGV[index * 2 - 1]) then return index end
  end
  for index, key in ipairs(KEYS) do
    local count = redis.call('INCR', key)
    if count == 1 then redis.call('EXPIRE', key, tonumber(ARGV[index * 2])) end
  end
  return 0
`;

/**
 * Counts one request against every limit, or reports the first exhausted one.
 * Without REDIS_URL outside production every request is allowed; in
 * production a missing or failing Redis rejects with 503.
 */
export async function enforceFixedWindow(limits: FixedWindowLimit[]): Promise<FixedWindowResult> {
  try {
    const store = await readyRedis();
    if (!store) throw new Error("REDIS_URL is required for rate limiting.");
    if (limits.length === 0) return { allowed: true };
    const args = limits.flatMap((entry) => [String(entry.limit), String(entry.windowSeconds + 1)]);
    const blockedIndex = Number(await store.eval(script, limits.length, ...limits.map((entry) => entry.key), ...args));
    if (blockedIndex > 0) return { allowed: false, status: 429, reason: limits[blockedIndex - 1]?.reason ?? "rate_limit" };
    return { allowed: true };
  } catch {
    if (process.env.NODE_ENV !== "production" && !process.env.REDIS_URL) return { allowed: true };
    return { allowed: false, status: 503, reason: "rate_limit_unavailable" };
  }
}

/** The SHA-256 digest that stands in for a client's IP address in a counter's key. */
export function clientIpDigest(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}
