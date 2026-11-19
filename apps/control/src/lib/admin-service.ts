/**
 * What the admin says about the deployment's services, for the System health
 * page (docs/features/control-panel.md, "Read the System health page"). The
 * panel asks the admin over Railway's private network:
 *
 * - `GET /api/internal/fleet`, the fleet status address: every copy of the
 *   admin and the worker from their heartbeats in Redis, the worker's queues,
 *   and the copies that died in the last 24 hours (docs/features/observability.md,
 *   "Watch every copy"). It takes the admin's FLEET_STATUS_TOKEN, which the
 *   bootstrap script gives the control service too.
 * - `GET /api/health/ready` and `GET /api/health/live`: whether the admin
 *   reaches the database, the file storage and Redis, and which release it runs.
 *
 * Nothing here changes anything, and the token never leaves the server: the
 * pages that use it are server components.
 */

type Environment = Record<string, string | undefined>;

export const FLEET_TOKEN_MIN_LENGTH = 32;
/** How long the panel waits for the admin. The admin gives Redis 3 seconds to answer the fleet question. */
export const ADMIN_TIMEOUT_MS = 5_000;

export type AdminServiceSettings = {
  /** The admin's address, such as http://admin.railway.internal:3000, with no path. */
  baseUrl: string;
  /** The fleet status address's token, or null while the panel has none it could use. */
  fleetToken: string | null;
};

/**
 * Where the admin is, from CONTROL_ADMIN_URL, else APP_BASE_URL (a developer's
 * .env names the admin there), and the fleet token from FLEET_STATUS_TOKEN.
 */
export function adminServiceSettings(env: Environment = process.env): AdminServiceSettings | { problem: string } {
  const raw = (env.CONTROL_ADMIN_URL || env.APP_BASE_URL || "").trim();
  if (!raw) return { problem: "CONTROL_ADMIN_URL isn't set on the control service, so the panel doesn't know where the admin is." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: "CONTROL_ADMIN_URL must be the admin's address, such as http://admin.railway.internal:3000." };
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return { problem: "CONTROL_ADMIN_URL must be the admin's http or https address, with no user name or password in it." };
  }
  const token = env.FLEET_STATUS_TOKEN?.trim() ?? "";
  return { baseUrl: url.origin, fleetToken: token.length >= FLEET_TOKEN_MIN_LENGTH ? token : null };
}

export type FleetQueueCounts = { waiting: number; active: number; delayed: number; failed: number };

export type FleetCopy = {
  service: string;
  replica: string;
  /** running, not_ready, draining, silent or left; died for the copies under `died`. */
  state: string;
  release: string;
  region: string | null;
  startedAt: string | null;
  lastSeenSecondsAgo: number;
  drainingForSeconds: number | null;
  /** The share of the time since its last beat that its one thread was busy, from 0 to 1. */
  busy: number;
  rssBytes: number;
  heapUsedBytes: number;
  db: { open: number; inUse: number; waiting: number; max: number } | null;
  ready: boolean | null;
  activeJobs: number | null;
  liveCalls: number | null;
};

export type FleetDiedCopy = FleetCopy & { lastSeenAt: string | null; ranForSeconds: number };

export type FleetServiceCounts = { running: number; notReady: number; draining: number; silent: number; died: number; expected: number };

export type FleetReport = {
  /** False when a copy went silent, a worker stays unready, a service has too few copies, or Redis can't be read. */
  ok: boolean;
  checkedAt: string | null;
  problems: string[];
  services: Record<string, FleetServiceCounts>;
  copies: FleetCopy[];
  died: FleetDiedCopy[];
  queues: Record<string, FleetQueueCounts> | null;
  queuesCountedSecondsAgo: number | null;
};

export type FleetResult =
  | { kind: "report"; report: FleetReport }
  /** The panel has no address or no token for it. */
  | { kind: "not_set_up"; reason: string }
  /** The admin answered 404: it has no FLEET_STATUS_TOKEN, so the address is off. */
  | { kind: "off" }
  /** The admin answered 401: the panel's token isn't the admin's. */
  | { kind: "refused" }
  | { kind: "unreachable"; reason: string };

export type AdminChecks = { database: boolean; storage: boolean; redis: boolean };

export type ReadinessResult =
  | { kind: "answered"; ok: boolean; checks: AdminChecks; release: string | null }
  | { kind: "not_set_up"; reason: string }
  | { kind: "unreachable"; reason: string };

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const textOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function queueCounts(value: unknown): Record<string, FleetQueueCounts> | null {
  const queues = record(value);
  if (!queues) return null;
  return Object.fromEntries(Object.entries(queues).flatMap(([name, counts]) => {
    const row = record(counts);
    return row ? [[name, { waiting: number(row.waiting), active: number(row.active), delayed: number(row.delayed), failed: number(row.failed) }]] : [];
  }));
}

function copyOf(value: unknown): FleetCopy | null {
  const copy = record(value);
  if (!copy || !text(copy.service) || !text(copy.replica)) return null;
  const db = record(copy.db);
  return {
    service: text(copy.service),
    replica: text(copy.replica),
    state: text(copy.state) || "unknown",
    release: text(copy.release),
    region: textOrNull(copy.region),
    startedAt: textOrNull(copy.startedAt),
    lastSeenSecondsAgo: number(copy.lastSeenSecondsAgo),
    drainingForSeconds: numberOrNull(copy.drainingForSeconds),
    busy: Math.min(1, Math.max(0, number(copy.busy))),
    rssBytes: number(copy.rssBytes),
    heapUsedBytes: number(copy.heapUsedBytes),
    db: db ? { open: number(db.open), inUse: number(db.inUse), waiting: number(db.waiting), max: number(db.max) } : null,
    ready: typeof copy.ready === "boolean" ? copy.ready : null,
    activeJobs: numberOrNull(copy.activeJobs),
    liveCalls: numberOrNull(copy.liveCalls),
  };
}

/** The fleet status address's answer, read without trusting its shape, or null when it isn't one. */
export function parseFleetReport(value: unknown): FleetReport | null {
  const body = record(value);
  if (!body || typeof body.ok !== "boolean" || !Array.isArray(body.problems)) return null;
  const services = record(body.services) ?? {};
  return {
    ok: body.ok,
    checkedAt: textOrNull(body.checkedAt),
    problems: body.problems.filter((problem): problem is string => typeof problem === "string"),
    services: Object.fromEntries(Object.entries(services).flatMap(([name, counts]) => {
      const row = record(counts);
      return row ? [[name, { running: number(row.running), notReady: number(row.notReady), draining: number(row.draining), silent: number(row.silent), died: number(row.died), expected: number(row.expected) }]] : [];
    })),
    copies: (Array.isArray(body.copies) ? body.copies : []).map(copyOf).filter((copy): copy is FleetCopy => copy !== null),
    died: (Array.isArray(body.died) ? body.died : []).flatMap((value) => {
      const copy = copyOf(value);
      const row = record(value);
      return copy && row ? [{ ...copy, lastSeenAt: textOrNull(row.lastSeenAt), ranForSeconds: number(row.ranForSeconds) }] : [];
    }),
    queues: queueCounts(body.queues),
    queuesCountedSecondsAgo: numberOrNull(body.queuesCountedSecondsAgo),
  };
}

/** Why a request to the admin failed, in words, never with the token. */
function failure(error: unknown, timeoutMs: number): string {
  const problem = error as { name?: string; message?: string; cause?: { code?: string } } | null;
  if (problem?.name === "TimeoutError" || problem?.name === "AbortError") return `no answer within ${timeoutMs / 1000} seconds`;
  const code = problem?.cause?.code;
  if (code === "ECONNREFUSED") return "the connection was refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "its address doesn't resolve";
  return code ?? "the request failed";
}

async function getJson(fetcher: Fetcher, url: string, { token, timeoutMs }: { token?: string; timeoutMs: number }): Promise<{ status: number; body: unknown } | { error: string }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      cache: "no-store",
      // The token goes to the admin's own address only, never to wherever a redirect points.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { error: failure(error, timeoutMs) };
  }
  if (response.status >= 300 && response.status < 400) return { error: `it answered ${response.status} and pointed elsewhere` };
  const raw = await response.text().catch(() => "");
  try {
    return { status: response.status, body: raw ? (JSON.parse(raw) as unknown) : null };
  } catch {
    return { status: response.status, body: null };
  }
}

/** The fleet status address's answer, or why there is none. */
export async function fetchFleet(
  settings: AdminServiceSettings | { problem: string },
  { fetcher = fetch, timeoutMs = ADMIN_TIMEOUT_MS }: { fetcher?: Fetcher; timeoutMs?: number | undefined } = {},
): Promise<FleetResult> {
  if ("problem" in settings) return { kind: "not_set_up", reason: settings.problem };
  if (!settings.fleetToken) {
    return { kind: "not_set_up", reason: `FLEET_STATUS_TOKEN isn't set on the control service, or is shorter than ${FLEET_TOKEN_MIN_LENGTH} characters, so the panel can't read the fleet status address.` };
  }
  const answer = await getJson(fetcher, `${settings.baseUrl}/api/internal/fleet`, { token: settings.fleetToken, timeoutMs });
  if ("error" in answer) return { kind: "unreachable", reason: answer.error };
  if (answer.status === 404) return { kind: "off" };
  if (answer.status === 401) return { kind: "refused" };
  // 200 when all is well and 503 with the problems: both carry the report.
  const report = answer.status === 200 || answer.status === 503 ? parseFleetReport(answer.body) : null;
  return report ? { kind: "report", report } : { kind: "unreachable", reason: `it answered ${answer.status} without a fleet report` };
}

/** The admin's readiness checks and release, or why there are none. */
export async function fetchReadiness(
  settings: AdminServiceSettings | { problem: string },
  { fetcher = fetch, timeoutMs = ADMIN_TIMEOUT_MS }: { fetcher?: Fetcher; timeoutMs?: number | undefined } = {},
): Promise<ReadinessResult> {
  if ("problem" in settings) return { kind: "not_set_up", reason: settings.problem };
  const [ready, live] = await Promise.all([
    getJson(fetcher, `${settings.baseUrl}/api/health/ready`, { timeoutMs }),
    getJson(fetcher, `${settings.baseUrl}/api/health/live`, { timeoutMs }),
  ]);
  if ("error" in ready) return { kind: "unreachable", reason: ready.error };
  const checks = record(record(ready.body)?.checks);
  if (!checks || (ready.status !== 200 && ready.status !== 503)) return { kind: "unreachable", reason: `it answered ${ready.status} without its checks` };
  const release = "error" in live ? null : textOrNull(record(live.body)?.version);
  return {
    kind: "answered",
    ok: ready.status === 200 && record(ready.body)?.ok === true,
    checks: { database: checks.database === "ok", storage: checks.storage === "ok", redis: checks.redis === "ok" },
    release,
  };
}

/** A replica ID as the fleet status address writes it in its problems: a UUID's first eight characters, any other name whole. */
export function shortReplica(replica: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(replica) ? replica.slice(0, 8) : replica;
}

/** A release as a short commit when it is one, else as it is. */
export function shortRelease(release: string | null | undefined): string {
  if (!release) return "-";
  return /^[0-9a-f]{12,40}$/i.test(release) ? release.slice(0, 7) : release;
}
