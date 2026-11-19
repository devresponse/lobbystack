import { describe, expect, it } from "vitest";

import { adminServiceSettings, fetchFleet, fetchReadiness, parseFleetReport, shortRelease, shortReplica } from "./admin-service";

const TOKEN = "t".repeat(40);
const SETTINGS = { baseUrl: "http://admin.railway.internal:3000", fleetToken: TOKEN };

/** An answer from the fleet status address as the admin writes it (apps/admin/src/lib/fleet-status.ts). */
const REPORT = {
  ok: false,
  service: "lobbystack-admin",
  answeredBy: "admin:4f1c2a9e",
  checkedAt: "2026-11-19T07:30:00.000Z",
  problems: ["worker copy 9b1d3c47 stopped reporting 42 s ago without shutting down, and no newer copy took its place."],
  services: {
    admin: { running: 2, notReady: 0, draining: 0, silent: 0, died: 0, expected: 1 },
    worker: { running: 1, notReady: 0, draining: 0, silent: 1, died: 1, expected: 1 },
  },
  copies: [
    { service: "admin", replica: "4f1c2a9e-1111-4222-8333-444455556666", state: "running", release: "d533e698f9d6e0cc33498501d5c356db6f89f6c2", region: "us-west2", startedAt: "2026-11-19T06:40:00.000Z", lastSeenSecondsAgo: 4, busy: 0.12, rssBytes: 310_000_000, heapUsedBytes: 120_000_000, db: { open: 4, inUse: 1, waiting: 0, max: 10 } },
    { service: "worker", replica: "9b1d3c47-1111-4222-8333-444455556666", state: "silent", release: "d533e698f9d6e0cc33498501d5c356db6f89f6c2", startedAt: "2026-11-19T06:41:00.000Z", lastSeenSecondsAgo: 42, busy: 0.4, rssBytes: 500_000_000, heapUsedBytes: 200_000_000, ready: true, activeJobs: 2, liveCalls: 1, extra: "ignored" },
    { service: "worker" },
    "not a copy",
  ],
  died: [
    { service: "worker", replica: "0a0b0c0d-1111-4222-8333-444455556666", state: "died", release: "abc", startedAt: "2026-11-18T10:00:00.000Z", lastSeenSecondsAgo: 3600, busy: 2, rssBytes: 900_000_000, heapUsedBytes: 1, lastSeenAt: "2026-11-19T06:30:00.000Z", ranForSeconds: 73_800, queues: { calls: { waiting: 1, active: 0, delayed: 0, failed: 0 } } },
  ],
  queues: { "knowledge-ingest": { waiting: 3, active: 1, delayed: 0, failed: 12 }, broken: "no" },
  queuesCountedSecondsAgo: 6,
};

type Call = { url: string; init: RequestInit };

/** A stand-in for fetch that answers each path with a status and a body, and keeps what it was asked. */
function fakeAdmin(answers: Record<string, { status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  const fetcher = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const answer = answers[new URL(url).pathname];
    if (!answer) return Promise.reject(new Error(`unexpected ${url}`));
    if (answer instanceof Error) return Promise.reject(answer);
    const body = answer.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return Promise.resolve(new Response(body, { status: answer.status, headers: answer.headers ?? {} }));
  };
  return { fetcher, calls };
}

describe("where the panel finds the admin", () => {
  it("reads the admin's address and the fleet token, keeping only the address's origin", () => {
    expect(adminServiceSettings({ CONTROL_ADMIN_URL: " http://admin.railway.internal:3000/some/path ", FLEET_STATUS_TOKEN: ` ${TOKEN} ` }))
      .toEqual({ baseUrl: "http://admin.railway.internal:3000", fleetToken: TOKEN });
    // A developer's .env names the admin as APP_BASE_URL.
    expect(adminServiceSettings({ APP_BASE_URL: "http://localhost:13000" })).toEqual({ baseUrl: "http://localhost:13000", fleetToken: null });
  });

  it("refuses an address it can't use, and a token too short to be the admin's", () => {
    expect(adminServiceSettings({})).toHaveProperty("problem", expect.stringContaining("CONTROL_ADMIN_URL"));
    expect(adminServiceSettings({ CONTROL_ADMIN_URL: "admin:3000" })).toHaveProperty("problem");
    expect(adminServiceSettings({ CONTROL_ADMIN_URL: "not a url" })).toHaveProperty("problem");
    expect(adminServiceSettings({ CONTROL_ADMIN_URL: "https://user:secret@admin.example.com" })).toHaveProperty("problem");
    expect(adminServiceSettings({ CONTROL_ADMIN_URL: "https://admin.example.com", FLEET_STATUS_TOKEN: "short" })).toEqual({ baseUrl: "https://admin.example.com", fleetToken: null });
  });
});

describe("the fleet status address, read by the panel", () => {
  it("asks with the token as a header, never follows a redirect, and reads the report", async () => {
    const { fetcher, calls } = fakeAdmin({ "/api/internal/fleet": { status: 503, body: REPORT } });
    const result = await fetchFleet(SETTINGS, { fetcher });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://admin.railway.internal:3000/api/internal/fleet");
    expect(calls[0]?.init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(result.kind).toBe("report");
    if (result.kind !== "report") return;
    const { report } = result;
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(REPORT.problems);
    expect(report.services.worker).toEqual(REPORT.services.worker);
    expect(report.copies.map((copy) => copy.state)).toEqual(["running", "silent"]);
    expect(report.copies[0]).toMatchObject({ region: "us-west2", db: { inUse: 1, max: 10 }, ready: null, liveCalls: null });
    expect(report.copies[1]).toMatchObject({ ready: true, activeJobs: 2, liveCalls: 1, db: null });
    expect(report.died).toEqual([expect.objectContaining({ replica: "0a0b0c0d-1111-4222-8333-444455556666", busy: 1, ranForSeconds: 73_800, lastSeenAt: "2026-11-19T06:30:00.000Z" })]);
    expect(report.queues).toEqual({ "knowledge-ingest": { waiting: 3, active: 1, delayed: 0, failed: 12 } });
    expect(report.queuesCountedSecondsAgo).toBe(6);
  });

  it("tells an address that is off from a token the admin refuses", async () => {
    expect(await fetchFleet(SETTINGS, { fetcher: fakeAdmin({ "/api/internal/fleet": { status: 404, body: "Not found" } }).fetcher })).toEqual({ kind: "off" });
    expect(await fetchFleet(SETTINGS, { fetcher: fakeAdmin({ "/api/internal/fleet": { status: 401, body: "Unauthorized" } }).fetcher })).toEqual({ kind: "refused" });
  });

  it("asks nothing without an address or a token", async () => {
    const { fetcher, calls } = fakeAdmin({});
    expect(await fetchFleet({ problem: "CONTROL_ADMIN_URL isn't set" }, { fetcher })).toEqual({ kind: "not_set_up", reason: "CONTROL_ADMIN_URL isn't set" });
    expect(await fetchFleet({ ...SETTINGS, fleetToken: null }, { fetcher })).toMatchObject({ kind: "not_set_up", reason: expect.stringContaining("FLEET_STATUS_TOKEN") as string });
    expect(calls).toEqual([]);
  });

  it("says why the admin didn't answer, without the token", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const results = [
      await fetchFleet(SETTINGS, { fetcher: fakeAdmin({ "/api/internal/fleet": refused }).fetcher }),
      await fetchFleet(SETTINGS, { fetcher: fakeAdmin({ "/api/internal/fleet": Object.assign(new Error("timed out"), { name: "TimeoutError" }) }).fetcher }),
      await fetchFleet(SETTINGS, { fetcher: fakeAdmin({ "/api/internal/fleet": { status: 302, headers: { location: "https://elsewhere.example.com/" } } }).fetcher }),
      await fetchFleet(SETTINGS, { fetcher: fakeAdmin({ "/api/internal/fleet": { status: 200, body: "<html>" } }).fetcher }),
      await fetchFleet(SETTINGS, { fetcher: fakeAdmin({ "/api/internal/fleet": { status: 500, body: { error: "boom" } } }).fetcher }),
    ];
    expect(results).toEqual([
      { kind: "unreachable", reason: "the connection was refused" },
      { kind: "unreachable", reason: "no answer within 5 seconds" },
      { kind: "unreachable", reason: "it answered 302 and pointed elsewhere" },
      { kind: "unreachable", reason: "it answered 200 without a fleet report" },
      { kind: "unreachable", reason: "it answered 500 without a fleet report" },
    ]);
    expect(JSON.stringify(results)).not.toContain(TOKEN);
  });

  it("reads only what it expects from an answer it can't trust", () => {
    expect(parseFleetReport(null)).toBeNull();
    expect(parseFleetReport({ ok: "yes", problems: [] })).toBeNull();
    expect(parseFleetReport({ ok: false, problems: ["The copies' heartbeats can't be read from Redis.", 3] })).toEqual({
      ok: false, checkedAt: null, problems: ["The copies' heartbeats can't be read from Redis."], services: {}, copies: [], died: [], queues: null, queuesCountedSecondsAgo: null,
    });
  });
});

describe("the admin's readiness, read by the panel", () => {
  it("reads the three checks and the release, with no token", async () => {
    const { fetcher, calls } = fakeAdmin({
      "/api/health/ready": { status: 503, body: { ok: false, service: "lobbystack-admin", checks: { database: "ok", storage: "ok", redis: "failed" } } },
      "/api/health/live": { status: 200, body: { ok: true, service: "lobbystack-admin", version: "d533e698f9d6e0cc33498501d5c356db6f89f6c2" } },
    });
    expect(await fetchReadiness(SETTINGS, { fetcher })).toEqual({
      kind: "answered", ok: false, checks: { database: true, storage: true, redis: false }, release: "d533e698f9d6e0cc33498501d5c356db6f89f6c2",
    });
    expect(calls.every((call) => !("authorization" in ((call.init.headers ?? {}) as Record<string, string>)))).toBe(true);
  });

  it("says when the admin doesn't answer, or answers something else", async () => {
    const down = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(await fetchReadiness(SETTINGS, { fetcher: fakeAdmin({ "/api/health/ready": down, "/api/health/live": down }).fetcher }))
      .toEqual({ kind: "unreachable", reason: "its address doesn't resolve" });
    expect(await fetchReadiness(SETTINGS, { fetcher: fakeAdmin({ "/api/health/ready": { status: 404, body: "Not found" }, "/api/health/live": { status: 404 } }).fetcher }))
      .toEqual({ kind: "unreachable", reason: "it answered 404 without its checks" });
    expect(await fetchReadiness({ problem: "CONTROL_ADMIN_URL isn't set" })).toEqual({ kind: "not_set_up", reason: "CONTROL_ADMIN_URL isn't set" });
  });
});

describe("names the fleet status address uses", () => {
  it("shortens replica IDs and commits as the admin does", () => {
    expect(shortReplica("9b1d3c47-1111-4222-8333-444455556666")).toBe("9b1d3c47");
    expect(shortReplica("my-laptop")).toBe("my-laptop");
    expect(shortRelease("d533e698f9d6e0cc33498501d5c356db6f89f6c2")).toBe("d533e69");
    expect(shortRelease("development")).toBe("development");
    expect(shortRelease("")).toBe("-");
  });
});
