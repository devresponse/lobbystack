import Redis from "ioredis";

/**
 * One Redis subscriber per admin process, shared by every open stream (AUDIT-011).
 *
 * Each stream used to open its own connection, so connections grew with the
 * number of open dashboard tabs rather than with the number of servers. The
 * same Redis holds sessions, rate limits and the job queues, so tabs approaching
 * its connection limit would have taken sign-in and the queues down with them.
 *
 * Here one connection carries every channel this process listens to: it
 * subscribes on a channel's first listener and unsubscribes on its last, and
 * closes once nothing is listening at all.
 */

export type RealtimeListener = {
  /** A message on the listener's channel, as Redis delivered it. */
  message: (raw: string) => void;
  /** The shared connection dropped: end the stream, and the browser opens a new one. */
  dropped: () => void;
};

const PING_TIMEOUT_MS = 5_000;
const PING_INTERVAL_MS = 15_000;
/** Streams one account may hold open on one admin process. A person needs a handful of tabs, not a hundred. */
export const MAX_STREAMS_PER_USER = 12;

type Shared = {
  redis: Redis;
  ready: Promise<void>;
  channels: Map<string, Set<RealtimeListener>>;
  ping: ReturnType<typeof setInterval>;
};

let shared: Shared | undefined;
const streamsPerUser = new Map<string, number>();

/** The channel a business's events travel on. */
export function realtimeChannel(businessId: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return `${env.REDIS_PREFIX ?? "lobbystack"}:realtime:${businessId}`;
}

/** Ends every open stream and forgets the connection, so the next listener opens a new one. */
function dropShared(current: Shared): void {
  if (shared !== current) return;
  shared = undefined;
  clearInterval(current.ping);
  const listeners = [...current.channels.values()].flatMap((set) => [...set]);
  current.channels.clear();
  current.redis.removeAllListeners("message");
  current.redis.disconnect(false);
  for (const listener of listeners) listener.dropped();
}

function openShared(redisUrl: string): Shared {
  const redis = new Redis(redisUrl, {
    protocol: 2,
    maxRetriesPerRequest: 1,
    // A connection that died without closing never answers: its ping fails instead of waiting forever.
    commandTimeout: PING_TIMEOUT_MS,
    lazyConnect: true,
    connectionName: "lobbystack:sse",
  });
  const current: Shared = {
    redis,
    ready: redis.connect(),
    channels: new Map(),
    // Pub/Sub keeps no backlog and ioredis resubscribes silently, so a drop ends
    // every stream on this connection: each browser reconnects and refetches.
    ping: setInterval(() => { void redis.ping().catch(() => dropShared(current)); }, PING_INTERVAL_MS),
  };
  current.ping.unref?.();
  redis.on("message", (channel: string, raw: string) => {
    for (const listener of current.channels.get(channel) ?? []) listener.message(raw);
  });
  redis.once("close", () => dropShared(current));
  return current;
}

/**
 * Listens to one channel. Returns the function that stops listening, which
 * also leaves the channel and closes the connection when nothing else needs it.
 */
export async function subscribeToRealtime(redisUrl: string, channel: string, listener: RealtimeListener): Promise<() => void> {
  const current = shared ?? (shared = openShared(redisUrl));
  await current.ready;
  if (shared !== current) throw new Error("The realtime connection closed while this stream was opening.");
  const listeners = current.channels.get(channel);
  if (listeners) {
    listeners.add(listener);
  } else {
    current.channels.set(channel, new Set([listener]));
    try {
      await current.redis.subscribe(channel);
    } catch (error) {
      current.channels.delete(channel);
      throw error;
    }
  }
  return () => {
    const open = current.channels.get(channel);
    if (!open?.delete(listener)) return;
    if (open.size) return;
    current.channels.delete(channel);
    if (shared === current) void current.redis.unsubscribe(channel).catch(() => undefined);
    // Nothing is listening on this process, so it holds no connection either.
    if (shared === current && current.channels.size === 0) {
      shared = undefined;
      clearInterval(current.ping);
      current.redis.removeAllListeners("message");
      current.redis.removeAllListeners("close");
      current.redis.disconnect(false);
    }
  };
}

/**
 * Counts one more stream for this account, or refuses when it already holds
 * MAX_STREAMS_PER_USER on this process. Returns the function that gives it back.
 */
export function holdStreamForUser(userId: string): (() => void) | null {
  const open = streamsPerUser.get(userId) ?? 0;
  if (open >= MAX_STREAMS_PER_USER) return null;
  streamsPerUser.set(userId, open + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (streamsPerUser.get(userId) ?? 1) - 1;
    if (left > 0) streamsPerUser.set(userId, left); else streamsPerUser.delete(userId);
  };
}

/** What this process holds, for tests and for the fleet status. */
export function realtimeState(): { connections: number; channels: number; listeners: number } {
  const channels = shared ? [...shared.channels.values()] : [];
  return { connections: shared ? 1 : 0, channels: channels.length, listeners: channels.reduce((total, set) => total + set.size, 0) };
}
