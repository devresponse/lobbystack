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
/**
 * How long a copy that stopped beating stays among the copies heard from
 * lately. After it, a copy that said it was shutting down is forgotten, and
 * one that didn't is kept as a copy that died.
 */
export const FLEET_FORGET_MS = 10 * 60_000;
/**
 * How long the last beat of a copy that died is kept: one that stopped
 * beating without saying it was shutting down. It holds what the copy was
 * doing, for whoever looks into it the next day.
 */
export const FLEET_DIED_MS = 24 * 60 * 60_000;
/** The most copies that died the list keeps past those 10 minutes: the newest. */
export const FLEET_DIED_MAX = 50;
/** The most copies heard from in the last 10 minutes the list holds, whatever happens to them: past it, the oldest go. */
export const FLEET_LIST_MAX = 1_000;
// The most copies whose last beat turned 10 minutes old that one beat looks at. The next beats take the rest.
const FLEET_SWEEP_MAX = 100;
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

// One round trip a beat: note the time, keep the status, and tidy the list.
// Redis's clock orders every copy's beats.
//
// KEYS: the copies heard from lately (member → the time of its last beat),
// every listed copy's last beat (member → JSON), and the copies that died
// (member → the time of its last beat).
//
// A copy whose last beat turns 10 minutes old is looked at once, by the next
// beat from any copy. If that beat said it was shutting down, it left on
// purpose and goes. If it never said so, it died: it moves to the list of
// copies that died, which keeps the newest 50 for a day. So a beat costs the
// same however many copies died. Past 1,000 copies heard from lately the
// oldest go, and a beat looks at 100 old ones at most, so neither the list
// nor a beat's work can grow without end, whatever restarts how often.
const BEAT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local function forget(list, members)
  for from = 1, #members, 500 do
    local to = math.min(from + 499, #members)
    redis.call('ZREM', list, unpack(members, from, to))
    redis.call('HDEL', KEYS[2], unpack(members, from, to))
  end
end
local new = redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
if new == 1 then
  redis.call('ZREM', KEYS[3], ARGV[1])
  local extra = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[7])
  if extra > 0 then forget(KEYS[1], redis.call('ZRANGE', KEYS[1], 0, extra - 1)) end
end
local since = now - tonumber(ARGV[5])
local old = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[3]), 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[8]))
if #old > 0 then
  local gone = {}
  local died = false
  for index = 1, #old, 2 do
    local ok, beat = pcall(cjson.decode, redis.call('HGET', KEYS[2], old[index]) or '')
    if ok and type(beat) == 'table' and beat.draining == false and tonumber(old[index + 1]) >= since then
      redis.call('ZADD', KEYS[3], old[index + 1], old[index])
      redis.call('ZREM', KEYS[1], old[index])
      died = true
    else
      gone[#gone + 1] = old[index]
    end
  end
  forget(KEYS[1], gone)
  if died then
    local extra = redis.call('ZCARD', KEYS[3]) - tonumber(ARGV[6])
    if extra > 0 then forget(KEYS[3], redis.call('ZRANGE', KEYS[3], 0, extra - 1)) end
  end
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', since - 1)
if #expired > 0 then forget(KEYS[3], expired) end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
redis.call('PEXPIRE', KEYS[3], ARGV[4])
return now`;
const READ = `
local time = redis.call('TIME')
return {
  time[1] * 1000 + math.floor(time[2] / 1000),
  redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES'),
  redis.call('ZRANGE', KEYS[3], 0, -1, 'WITHSCORES'),
  redis.call('HGETALL', KEYS[2]),
}`;

const FAILURE_LOG_INTERVAL_MS = 60_000;

function seenKey(): string {
  return `${process.env.REDIS_PREFIX ?? "lobbystack"}:fleet:seen`;
}

function beatsKey(): string {
  return `${process.env.REDIS_PREFIX ?? "lobbystack"}:fleet:beats`;
}

function diedKey(): string {
  return `${process.env.REDIS_PREFIX ?? "lobbystack"}:fleet:died`;
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
  const startedAt = Math.round(Date.now() - process.uptime() * 1000);
  // A process, not a name: a host that starts a crashed copy again under the same name starts a new process,
  // whose beats then stand beside the last one of the process that died instead of replacing it.
  const member = `${identity.service}:${identity.replica}:${startedAt}`;
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
    // The keys outlive the last beat by as long as a copy that died is kept, then expire by themselves. Until
    // then they hold the last beats of a fleet that stopped altogether.
    await presenceStore("The fleet heartbeat").eval(
      BEAT, 3, seenKey(), beatsKey(), diedKey(), member, JSON.stringify(beat),
      FLEET_FORGET_MS, FLEET_DIED_MS + FLEET_FORGET_MS, FLEET_DIED_MS, FLEET_DIED_MAX, FLEET_LIST_MAX, FLEET_SWEEP_MAX,
    );
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

/**
 * Every copy's last beat, with Redis's time now. A copy that stopped writing
 * stays listed for 10 minutes when it said it was shutting down, and for 24
 * hours when it didn't.
 */
export async function readFleet(): Promise<{ now: number; records: FleetRecord[] }> {
  const [now, seen, died, beats] = await presenceStore("The fleet status").eval(READ, 3, seenKey(), beatsKey(), diedKey()) as [number, string[], string[], string[]];
  const seenAt = new Map<string, number>();
  for (const list of [died, seen]) {
    for (let index = 0; index < list.length; index += 2) seenAt.set(list[index]!, Number(list[index + 1]));
  }
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
 * - `left`: it stopped beating after it said it was shutting down.
 * - `silent`: it stopped beating without saying so, under 10 minutes ago, and no newer copy took its place. A problem.
 * - `died`: it stopped beating without saying so, and a newer copy took its place or 10 minutes passed. No longer
 *   a problem by itself, and kept for 24 hours with its last beat.
 */
export type FleetCopyState = "running" | "not_ready" | "draining" | "silent" | "left" | "died";

export type FleetCopy = FleetRecord & { state: FleetCopyState; lastSeenMsAgo: number };

export type FleetSummary = {
  /** False when a copy went silent, a worker stays unready, or a service has fewer running copies than expected. */
  ok: boolean;
  problems: string[];
  /** `died` counts the service's copies that died in the last 24 hours, the ones `died` below leaves out too. */
  services: Record<FleetService, { running: number; notReady: number; draining: number; silent: number; died: number; expected: number }>;
  /** The copies heard from in the last 10 minutes, without the ones that died. */
  copies: FleetCopy[];
  /** The copies that died in the last 24 hours, each with its last beat: the newest first, 50 at most. */
  died: FleetCopy[];
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
 * beat (a restart), or a copy of a newer deployment (a deploy). After 10
 * minutes it stops being a problem by itself, and only the number of running
 * copies still tells.
 *
 * A copy that never said it was shutting down died. Once it is no problem,
 * its last beat is listed under `died` for 24 hours, so that what it was
 * doing can still be read the next day.
 */
export function summarizeFleet(input: { now: number; records: FleetRecord[] }, expected: Partial<Record<FleetService, number>> = {}): FleetSummary {
  const { now } = input;
  const age = (record: FleetRecord) => now - record.seenAt;
  // The beats forget copies as they go, and nothing beats while every copy is down: the same rule here.
  const records = input.records.filter((record) => age(record) <= (record.draining ? FLEET_FORGET_MS : FLEET_DIED_MS));
  const fresh = (record: FleetRecord) => age(record) <= FLEET_STALE_MS;
  const beating = records.filter(fresh);
  const replaced = (record: FleetRecord) => beating.some((other) => other !== record && other.service === record.service && (
    other.startedAt > record.seenAt - CLOCK_SLACK_MS
    || (Boolean(other.deployment) && Boolean(record.deployment) && other.deployment !== record.deployment && other.startedAt > record.startedAt)
  ));
  // A later process under the same name: the host started the copy again. Should that one die too, only it is the
  // problem, not every process before it.
  const lastStart = new Map<string, number>();
  for (const record of records) {
    const name = `${record.service}:${record.replica}`;
    lastStart.set(name, Math.max(lastStart.get(name) ?? 0, record.startedAt));
  }
  const startedAgain = (record: FleetRecord) => (lastStart.get(`${record.service}:${record.replica}`) ?? 0) > record.startedAt;
  const stateOf = (record: FleetRecord): FleetCopyState => {
    if (fresh(record)) return record.draining ? "draining" : record.ready === false ? "not_ready" : "running";
    if (record.draining) return "left";
    return replaced(record) || startedAgain(record) || age(record) > FLEET_FORGET_MS ? "died" : "silent";
  };
  const listed: FleetCopy[] = records.map((record) => ({ ...record, state: stateOf(record), lastSeenMsAgo: Math.max(0, age(record)) }));
  const copies = listed.filter((copy) => copy.state !== "died")
    .sort((a, b) => a.service.localeCompare(b.service) || a.startedAt - b.startedAt || a.replica.localeCompare(b.replica));
  const died = listed.filter((copy) => copy.state === "died").sort((a, b) => b.seenAt - a.seenAt || a.replica.localeCompare(b.replica));

  const problems: string[] = [];
  const services = {} as FleetSummary["services"];
  for (const service of FLEET_SERVICES) {
    const own = copies.filter((copy) => copy.service === service);
    const count = (state: FleetCopyState) => own.filter((copy) => copy.state === state).length;
    const wanted = Math.max(1, Math.floor(expected[service] ?? 1));
    services[service] = {
      running: count("running"), notReady: count("not_ready"), draining: count("draining"), silent: count("silent"),
      died: died.filter((copy) => copy.service === service).length, expected: wanted,
    };
    for (const copy of own.filter((item) => item.state === "silent")) {
      problems.push(`${service} copy ${shortId(copy.replica)} stopped reporting ${Math.round(copy.lastSeenMsAgo / 1000)} s ago without shutting down, and no newer copy took its place.`);
    }
    // A copy that just started isn't ready yet, and one that said it was shutting down a moment ago is handing
    // over to the next, whether it is still finishing or already gone. Once the host has started it again under
    // the same name, the handover is over and the new process counts for itself.
    const starting = own.filter((copy) => copy.state === "not_ready" && now - copy.startedAt <= FLEET_HANDOVER_MS);
    const handingOver = own.filter((copy) => copy.draining && !startedAgain(copy) && (copy.state === "draining" || copy.state === "left") && (copy.drainingForMs ?? 0) + copy.lastSeenMsAgo <= FLEET_HANDOVER_MS);
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
    died: died.slice(0, FLEET_DIED_MAX),
    queues: counted?.queues ?? null,
    queuesCountedMsAgo: counted ? counted.lastSeenMsAgo : null,
  };
}
