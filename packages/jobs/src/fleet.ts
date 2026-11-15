// The fleet: every running copy of the admin and the worker. Each copy writes
// a short status to Redis every 10 seconds, its heartbeat, and the admin's
// fleet status address reads them all (docs/features/observability.md,
// "Watch every copy"). The host shows a copy's processor and memory but not
// what it is doing, and an uptime check can't reach the worker, which has no
// public address.
import { performance } from "node:perf_hooks";

import { presenceStore } from "./presenceStore";

export const FLEET_BEAT_MS = 10_000;
/** A copy whose last beat is older than this, three beats, no longer counts as running. */
export const FLEET_STALE_MS = 30_000;
/** How long a copy that stopped writing stays on the list. */
export const FLEET_FORGET_MS = 10 * 60_000;
/**
 * How long a service may go without a running copy while one hands over to
 * the next: from the moment a copy says it is shutting down, whether it is
 * still finishing or already gone, and from the start of a copy that isn't
 * ready yet.
 */
export const FLEET_HANDOVER_MS = 2 * 60_000;
// A copy's own clock and Redis's can differ by a little.
const CLOCK_SLACK_MS = 5_000;

export const FLEET_SERVICES = ["admin", "worker"] as const;
export type FleetService = (typeof FLEET_SERVICES)[number];

export type FleetQueueCounts = { waiting: number; active: number; delayed: number; failed: number };

/** Who a copy is. */
export type FleetIdentity = {
  service: FleetService;
  /** Which copy: Railway's replica ID, or the host name. */
  replica: string;
  /** The release it runs. */
  release: string;
  /** The host's deployment. Copies of one deployment share it, and every deploy makes a new one. */
  deployment?: string;
  region?: string;
};

/** What a copy says about its work at each beat. */
export type FleetSample = {
  /** False while the worker can't reach the database, the files or Redis. */
  ready?: boolean;
  activeJobs?: number;
  liveCalls?: number;
  /** Database connections over all of the copy's pools. */
  db?: { open: number; inUse: number; waiting: number; max: number };
  /** Jobs in each queue, as the worker last counted them. */
  queues?: Record<string, FleetQueueCounts>;
};

export type FleetBeat = FleetIdentity & FleetSample & {
  /** When the process started, in milliseconds since 1970. */
  startedAt: number;
  /** Shutting down: it finishes what it holds and takes nothing new. */
  draining: boolean;
  /** How long it has been shutting down. */
  drainingForMs?: number;
  /** The share of the time since its last beat that its one thread was busy, from 0 to 1. The first beat's is since the process started. */
  busy: number;
  rssBytes: number;
  heapUsedBytes: number;
};

/** A beat, with when Redis got it, by Redis's clock. */
export type FleetRecord = FleetBeat & { seenAt: number };

export type FleetHeartbeat = {
  /** Writes a beat now. The timer does this every 10 seconds. */
  beat(): Promise<void>;
  /** Marks the copy as shutting down, and says so at once. It keeps beating until it exits. */
  drain(): Promise<void>;
  /**
   * Stops the beats, after a last one that says the copy is shutting down. That beat stays on the list, which is
   * how the fleet tells a copy that left on purpose from one that died.
   */
  stop(): Promise<void>;
};

// One round trip a beat: note the time, keep the status, and forget copies
// that stopped writing long ago. Redis's clock orders every copy's beats.
const BEAT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
local old = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[3]))
if #old > 0 then
  redis.call('ZREM', KEYS[1], unpack(old))
  redis.call('HDEL', KEYS[2], unpack(old))
end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return now`;
const READ = `
local time = redis.call('TIME')
return { time[1] * 1000 + math.floor(time[2] / 1000), redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES'), redis.call('HGETALL', KEYS[2]) }`;

const FAILURE_LOG_INTERVAL_MS = 60_000;

function seenKey(): string {
  return `${process.env.REDIS_PREFIX ?? "lobbystack"}:fleet:seen`;
}

function beatsKey(): string {
  return `${process.env.REDIS_PREFIX ?? "lobbystack"}:fleet:beats`;
}

/**
 * Starts this copy's heartbeat: one beat now, then one every 10 seconds, each
 * a single Redis round trip. `sample` is read at each beat and must be cheap.
 * A beat that fails is reported at most once a minute and tried again at the
 * next one. Without REDIS_URL there is nowhere to write, and it does nothing.
 */
export function startFleetHeartbeat(
  identity: FleetIdentity,
  sample: () => FleetSample = () => ({}),
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): FleetHeartbeat {
  if (!process.env.REDIS_URL) return { beat: async () => undefined, drain: async () => undefined, stop: async () => undefined };
  const member = `${identity.service}:${identity.replica}`;
  const startedAt = Math.round(Date.now() - process.uptime() * 1000);
  let utilization: ReturnType<typeof performance.eventLoopUtilization> | undefined;
  let drainingSince: number | undefined;
  let stopped = false;
  let writing: Promise<void> | undefined;
  let failureReportedAt = 0;

  const report = (error: unknown) => {
    const now = Date.now();
    if (now - failureReportedAt < FAILURE_LOG_INTERVAL_MS) return;
    failureReportedAt = now;
    if (options.onError) options.onError(error);
    else console.warn(JSON.stringify({ level: "warn", message: "fleet.heartbeat_failed", error: error instanceof Error ? error.message : String(error) }));
  };
  const write = async () => {
    const current = performance.eventLoopUtilization();
    // Since the beat before. The first beat has none, and says how busy the process was since it started.
    const busy = utilization ? performance.eventLoopUtilization(current, utilization).utilization : current.utilization;
    utilization = current;
    const memory = process.memoryUsage();
    const beat: FleetBeat = {
      ...identity,
      ...sample(),
      startedAt,
      draining: drainingSince !== undefined,
      ...(drainingSince !== undefined ? { drainingForMs: Math.round(performance.now() - drainingSince) } : {}),
      busy: Math.round(busy * 1000) / 1000,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    };
    await presenceStore("The fleet heartbeat").eval(BEAT, 2, seenKey(), beatsKey(), member, JSON.stringify(beat), FLEET_FORGET_MS, 2 * FLEET_FORGET_MS);
  };
  const beat = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    // A beat still on its way, when Redis is slow, isn't sent twice.
    writing ??= write().catch(report).finally(() => { writing = undefined; });
    return writing;
  };
  const timer = setInterval(() => void beat(), options.intervalMs ?? FLEET_BEAT_MS);
  // The heartbeat never keeps a process alive that is otherwise done.
  timer.unref();
  void beat();

  return {
    beat,
    async drain() {
      if (stopped) return;
      drainingSince ??= performance.now();
      // Sent at once, even behind a beat still on its way: Redis takes them in order, and a process
      // that is exiting may not get another turn.
      await write().catch(report);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (writing) await writing;
      // Its last word, even when nothing told it to drain first: it is shutting down.
      drainingSince ??= performance.now();
      await write().catch(report);
    },
  };
}

function isBeat(value: unknown): value is FleetBeat {
  const beat = value as Partial<FleetBeat> | null;
  return typeof beat === "object" && beat !== null
    && (FLEET_SERVICES as readonly string[]).includes(String(beat.service))
    && typeof beat.replica === "string" && typeof beat.release === "string"
    && typeof beat.startedAt === "number" && typeof beat.draining === "boolean" && typeof beat.busy === "number";
}

/** Every copy's last beat, with Redis's time now. Copies that stopped writing stay listed for 10 minutes. */
export async function readFleet(): Promise<{ now: number; records: FleetRecord[] }> {
  const [now, seen, beats] = await presenceStore("The fleet status").eval(READ, 2, seenKey(), beatsKey()) as [number, string[], string[]];
  const seenAt = new Map<string, number>();
  for (let index = 0; index < seen.length; index += 2) seenAt.set(seen[index]!, Number(seen[index + 1]));
  const records: FleetRecord[] = [];
  for (let index = 0; index < beats.length; index += 2) {
    const at = seenAt.get(beats[index]!);
    if (at === undefined) continue;
    try {
      const beat: unknown = JSON.parse(beats[index + 1]!);
      if (isBeat(beat)) records.push({ ...beat, seenAt: at });
    } catch { /* A status that can't be read is left out. */ }
  }
  return { now: Number(now), records };
}

/**
 * - `running`: beating, and taking work.
 * - `not_ready`: beating, but the worker can't reach the database, the files or Redis, or is still starting.
 * - `draining`: beating, and shutting down.
 * - `silent`: it stopped beating without shutting down, and no newer copy took its place.
 * - `left`: it stopped beating after it shut down, or a newer copy took its place.
 */
export type FleetCopyState = "running" | "not_ready" | "draining" | "silent" | "left";

export type FleetCopy = FleetRecord & { state: FleetCopyState; lastSeenMsAgo: number };

export type FleetSummary = {
  /** False when a copy went silent, a worker stays unready, or a service has fewer running copies than expected. */
  ok: boolean;
  problems: string[];
  services: Record<FleetService, { running: number; notReady: number; draining: number; silent: number; expected: number }>;
  copies: FleetCopy[];
  /** Each queue's jobs, from the worker that counted them last, and how long ago that was. Null when no worker beats. */
  queues: Record<string, FleetQueueCounts> | null;
  queuesCountedMsAgo: number | null;
};

/** Railway's replica IDs are UUIDs, which their first eight characters tell apart. Any other name, such as a host's, stays whole. */
function shortId(replica: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(replica) ? replica.slice(0, 8) : replica;
}

/**
 * What the heartbeats say about the fleet. `expected` is how many running
 * copies each service must have, 1 unless given.
 *
 * A copy that stops beating is a problem only when it didn't say it was
 * shutting down and nothing replaced it: a copy that started after its last
 * beat (a restart), or a copy of a newer deployment (a deploy).
 */
export function summarizeFleet(input: { now: number; records: FleetRecord[] }, expected: Partial<Record<FleetService, number>> = {}): FleetSummary {
  const { now } = input;
  const records = input.records.filter((record) => now - record.seenAt <= FLEET_FORGET_MS);
  const fresh = (record: FleetRecord) => now - record.seenAt <= FLEET_STALE_MS;
  const replaced = (record: FleetRecord) => records.some((other) => other !== record && other.service === record.service && fresh(other) && (
    other.startedAt > record.seenAt - CLOCK_SLACK_MS
    || (Boolean(other.deployment) && Boolean(record.deployment) && other.deployment !== record.deployment && other.startedAt > record.startedAt)
  ));
  const stateOf = (record: FleetRecord): FleetCopyState => {
    if (fresh(record)) return record.draining ? "draining" : record.ready === false ? "not_ready" : "running";
    return record.draining || replaced(record) ? "left" : "silent";
  };
  const copies: FleetCopy[] = records
    .map((record) => ({ ...record, state: stateOf(record), lastSeenMsAgo: Math.max(0, now - record.seenAt) }))
    .sort((a, b) => a.service.localeCompare(b.service) || a.startedAt - b.startedAt || a.replica.localeCompare(b.replica));

  const problems: string[] = [];
  const services = {} as FleetSummary["services"];
  for (const service of FLEET_SERVICES) {
    const own = copies.filter((copy) => copy.service === service);
    const count = (state: FleetCopyState) => own.filter((copy) => copy.state === state).length;
    const wanted = Math.max(1, Math.floor(expected[service] ?? 1));
    services[service] = { running: count("running"), notReady: count("not_ready"), draining: count("draining"), silent: count("silent"), expected: wanted };
    for (const copy of own.filter((item) => item.state === "silent")) {
      problems.push(`${service} copy ${shortId(copy.replica)} stopped reporting ${Math.round(copy.lastSeenMsAgo / 1000)} s ago without shutting down, and no newer copy took its place.`);
    }
    // A copy that just started isn't ready yet, and one that said it was shutting down a moment ago is handing
    // over to the next, whether it is still finishing or already gone.
    const starting = own.filter((copy) => copy.state === "not_ready" && now - copy.startedAt <= FLEET_HANDOVER_MS);
    const handingOver = own.filter((copy) => copy.draining && (copy.state === "draining" || copy.state === "left") && (copy.drainingForMs ?? 0) + copy.lastSeenMsAgo <= FLEET_HANDOVER_MS);
    for (const copy of own.filter((item) => item.state === "not_ready" && !starting.includes(item))) {
      problems.push(`${service} copy ${shortId(copy.replica)} reports that it isn't ready: it can't reach the database, the files or Redis.`);
    }
    const running = services[service].running;
    if (running + starting.length + handingOver.length < wanted) {
      problems.push(running === 0
        ? `No ${service} copy is running${wanted > 1 ? `, and ${wanted} are expected` : ""}.`
        : `${running} ${service} ${running === 1 ? "copy is" : "copies are"} running, and ${wanted} are expected.`);
    }
  }

  // Every worker counts the same queues, so the newest count stands for all.
  const counted = copies.filter((copy) => copy.queues && (copy.state === "running" || copy.state === "not_ready" || copy.state === "draining"))
    .sort((a, b) => b.seenAt - a.seenAt)[0];
  return {
    ok: problems.length === 0,
    problems,
    services,
    copies,
    queues: counted?.queues ?? null,
    queuesCountedMsAgo: counted ? counted.lastSeenMsAgo : null,
  };
}
