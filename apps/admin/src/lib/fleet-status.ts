import { createHash, timingSafeEqual } from "node:crypto";

import { FLEET_SERVICES, readFleet, summarizeFleet, type FleetCopy, type FleetService } from "@lobbystack/jobs";
import { logEvent, serviceInstance } from "@lobbystack/telemetry/node";

/**
 * The fleet status address, `GET /api/internal/fleet`
 * (docs/features/observability.md, "Watch every copy"). It lists every copy of
 * the admin and the worker from their heartbeats in Redis, with each queue's
 * jobs, and answers 503 when a copy went silent, a worker stays unready, or a
 * service has fewer running copies than the check expects. An uptime check
 * that watches it sees the worker too, which has no public address. A copy
 * that died stays listed under `died` for 24 hours with its last beat, so
 * what it was doing can still be read the next day.
 *
 * It is off, a 404, until FLEET_STATUS_TOKEN is set on the admin, and takes
 * only that token: as `Authorization: Bearer <token>`, or as `?token=<token>`
 * for an uptime check that can't send a header.
 */

type Env = Record<string, string | undefined>;

export const FLEET_STATUS_TOKEN_MIN_LENGTH = 32;
// The most copies Railway runs of one service.
const MAX_EXPECTED_COPIES = 50;
const READ_TIMEOUT_MS = 3_000;

/** The token that opens the address, or undefined while it is off: unset, or too short to trust. */
export function fleetStatusToken(env: Env = process.env): string | undefined {
  const token = env.FLEET_STATUS_TOKEN?.trim();
  return token && token.length >= FLEET_STATUS_TOKEN_MIN_LENGTH ? token : undefined;
}

/** Why a FLEET_STATUS_TOKEN that is set opens nothing, for a line as the admin starts. Never with the token. */
export function fleetStatusTokenProblem(env: Env = process.env): string | null {
  const token = env.FLEET_STATUS_TOKEN?.trim();
  return token && token.length < FLEET_STATUS_TOKEN_MIN_LENGTH
    ? `FLEET_STATUS_TOKEN is ${token.length} characters long and needs at least ${FLEET_STATUS_TOKEN_MIN_LENGTH}, so the fleet status address stays off. Use ${FLEET_STATUS_TOKEN_MIN_LENGTH} or more random letters and digits.`
    : null;
}

function offeredToken(request: Request, url: URL): string | null {
  return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? url.searchParams.get("token");
}

// Hashing both sides first compares in the same time whatever their lengths.
function tokensMatch(offered: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(offered).digest(), createHash("sha256").update(expected).digest());
}

/** `?admin=2&worker=2`: how many running copies the check expects of each service. A sentence when one can't be read. */
function expectedCopies(url: URL): Partial<Record<FleetService, number>> | string {
  const expected: Partial<Record<FleetService, number>> = {};
  for (const service of FLEET_SERVICES) {
    const raw = url.searchParams.get(service);
    if (raw === null) continue;
    const count = Number(raw);
    if (!/^\d+$/.test(raw) || count < 1 || count > MAX_EXPECTED_COPIES) {
      return `${service} takes the number of running copies to expect, a whole number from 1 to ${MAX_EXPECTED_COPIES}.`;
    }
    expected[service] = count;
  }
  return expected;
}

function describeCopy(copy: FleetCopy) {
  return {
    service: copy.service,
    replica: copy.replica,
    state: copy.state,
    release: copy.release,
    ...(copy.deployment ? { deployment: copy.deployment } : {}),
    ...(copy.region ? { region: copy.region } : {}),
    startedAt: new Date(copy.startedAt).toISOString(),
    lastSeenSecondsAgo: Math.round(copy.lastSeenMsAgo / 1000),
    ...(copy.draining ? { drainingForSeconds: Math.round(((copy.drainingForMs ?? 0) + copy.lastSeenMsAgo) / 1000) } : {}),
    busy: copy.busy,
    rssBytes: copy.rssBytes,
    heapUsedBytes: copy.heapUsedBytes,
    ...(copy.db ? { db: copy.db } : {}),
    ...(copy.ready === undefined ? {} : { ready: copy.ready }),
    ...(copy.activeJobs === undefined ? {} : { activeJobs: copy.activeJobs }),
    ...(copy.liveCalls === undefined ? {} : { liveCalls: copy.liveCalls }),
  };
}

/** A copy that died: its last beat, when that was, and how long the process had run by then. */
function describeDied(copy: FleetCopy) {
  return {
    ...describeCopy(copy),
    lastSeenAt: new Date(copy.seenAt).toISOString(),
    ranForSeconds: Math.max(0, Math.round((copy.seenAt - copy.startedAt) / 1000)),
    ...(copy.queues ? { queues: copy.queues } : {}),
  };
}

export type FleetStatusAnswer = { status: number; body: string | Record<string, unknown> };

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis didn't answer within ${ms} ms.`)), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

export async function fleetStatus(request: Request, env: Env = process.env): Promise<FleetStatusAnswer> {
  const token = fleetStatusToken(env);
  if (!token) return { status: 404, body: "Not found" };
  const url = new URL(request.url);
  const offered = offeredToken(request, url);
  if (!offered || !tokensMatch(offered, token)) return { status: 401, body: "Unauthorized" };
  const expected = expectedCopies(url);
  if (typeof expected === "string") return { status: 400, body: { error: expected } };

  const answeredBy = serviceInstance(env).id;
  let fleet: Awaited<ReturnType<typeof readFleet>>;
  try {
    fleet = await withTimeout(readFleet(), READ_TIMEOUT_MS);
  } catch (error) {
    logEvent("warn", "fleet.status_unreadable", { error });
    return { status: 503, body: { ok: false, service: "lobbystack-admin", answeredBy, problems: ["The copies' heartbeats can't be read from Redis."] } };
  }
  const summary = summarizeFleet(fleet, expected);
  return {
    status: summary.ok ? 200 : 503,
    body: {
      ok: summary.ok,
      service: "lobbystack-admin",
      answeredBy,
      checkedAt: new Date(fleet.now).toISOString(),
      problems: summary.problems,
      services: summary.services,
      copies: summary.copies.map(describeCopy),
      died: summary.died.map(describeDied),
      queues: summary.queues,
      queuesCountedSecondsAgo: summary.queuesCountedMsAgo === null ? null : Math.round(summary.queuesCountedMsAgo / 1000),
    },
  };
}
