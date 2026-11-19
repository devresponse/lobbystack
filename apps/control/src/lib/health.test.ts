import { describe, expect, it } from "vitest";

import type { FleetCopy, FleetReport, FleetResult, ReadinessResult } from "./admin-service";
import { assessHealth, LIMITS } from "./health";
import type { DatabaseHealth, RecentActivity } from "./queries";

const NOW = Date.parse("2026-11-19T08:00:00Z");

const READY: ReadinessResult = { kind: "answered", ok: true, checks: { database: true, storage: true, redis: true }, release: "d533e698" };

function copy(overrides: Partial<FleetCopy> = {}): FleetCopy {
  return {
    service: "worker", replica: "9b1d3c47-1111-4222-8333-444455556666", state: "running", release: "d533e698", region: null, startedAt: "2026-11-19T06:00:00Z",
    lastSeenSecondsAgo: 3, drainingForSeconds: null, busy: 0.2, rssBytes: 400_000_000, heapUsedBytes: 150_000_000,
    db: { open: 4, inUse: 1, waiting: 0, max: 10 }, ready: true, activeJobs: 0, liveCalls: 0, ...overrides,
  };
}

function fleet(overrides: Partial<FleetReport> = {}): FleetResult {
  return {
    kind: "report",
    report: {
      ok: true, checkedAt: "2026-11-19T08:00:00Z", problems: [],
      services: { admin: { running: 1, notReady: 0, draining: 0, silent: 0, died: 0, expected: 1 }, worker: { running: 1, notReady: 0, draining: 0, silent: 0, died: 0, expected: 1 } },
      copies: [copy({ service: "admin", replica: "4f1c2a9e-1111-4222-8333-444455556666", ready: null, activeJobs: null, liveCalls: null }), copy()],
      died: [], queues: { calls: { waiting: 0, active: 1, delayed: 0, failed: 3 } }, queuesCountedSecondsAgo: 5, ...overrides,
    },
  };
}

const DATABASE: DatabaseHealth = {
  sizeBytes: 50_000_000, connections: 20, maxConnections: 100, reservedConnections: 3, byRole: [{ role: "lobbystack_app", connections: 12 }],
  startedAt: new Date("2026-11-01T00:00:00Z"), version: "16.4", commits: 1000, rollbacks: 5, blocksHit: 990, blocksRead: 10, deadlocks: 0, tempBytes: 0,
  countedSince: new Date("2026-11-01T00:00:00Z"),
};

const ACTIVITY: RecentActivity = { calls: 40, failedCalls: 1, openCalls: 2, stuckCalls: 0, texts: 30, failedTexts: 1, stuckTexts: 0, chats: 5 };

const healthy = { fleet: fleet(), readiness: READY, database: DATABASE, activity: ACTIVITY, now: NOW };

describe("the System health page's verdict", () => {
  it("is all good when every number is", () => {
    expect(assessHealth(healthy)).toEqual({ tone: "good", label: "All good", findings: [] });
  });

  it("passes on the fleet status address's own problems as critical", () => {
    const problem = "worker copy 9b1d3c47 stopped reporting 42 s ago without shutting down, and no newer copy took its place.";
    const verdict = assessHealth({ ...healthy, fleet: fleet({ ok: false, problems: [problem] }) });
    expect(verdict).toMatchObject({ tone: "critical", label: "Problem" });
    expect(verdict.findings).toEqual([{ severity: "critical", area: "Services", text: problem }]);
  });

  it("names a copy that is too busy or short of database connections, a long queue, and copies that died", () => {
    const verdict = assessHealth({
      ...healthy,
      fleet: fleet({
        copies: [copy({ busy: LIMITS.busyShare }), copy({ replica: "my-laptop", db: { open: 10, inUse: 10, waiting: 3, max: 10 } }), copy({ replica: "gone", state: "left", busy: 1 })],
        queues: { "knowledge-ingest": { waiting: LIMITS.queueWaiting, active: 1, delayed: 0, failed: 0 } },
        died: [{ ...copy({ state: "died" }), lastSeenAt: "2026-11-19T03:00:00Z", ranForSeconds: 600 }],
      }),
    });
    expect(verdict.tone).toBe("warning");
    expect(verdict.findings.map((finding) => finding.text)).toEqual([
      "worker copy 9b1d3c47 was busy 85% of the time since its last beat: it may be falling behind.",
      "worker copy my-laptop has 3 queries waiting for a database connection: all 10 of its connections are in use.",
      "100 jobs are waiting in the knowledge-ingest queue.",
      "1 copy stopped in the last 24 hours without shutting down (a crash, a kill or running out of memory). Their last beats are under Copies that died.",
    ]);
  });

  it("says what the panel can't see, and how far it got", () => {
    expect(assessHealth({ ...healthy, fleet: { kind: "off" } }).findings).toEqual([expect.objectContaining({ severity: "warning", text: expect.stringContaining("FLEET_STATUS_TOKEN") as string })]);
    expect(assessHealth({ ...healthy, fleet: { kind: "refused" } }).findings).toEqual([expect.objectContaining({ severity: "warning", text: expect.stringContaining("isn't the admin's") as string })]);
    expect(assessHealth({ ...healthy, fleet: { kind: "not_set_up", reason: "CONTROL_ADMIN_URL isn't set." } }).tone).toBe("warning");
    expect(assessHealth({ ...healthy, fleet: { kind: "unreachable", reason: "no answer within 5 seconds" } }).findings)
      .toEqual([{ severity: "critical", area: "Services", text: "The fleet status address didn't answer: no answer within 5 seconds." }]);
  });

  it("puts an admin that can't reach what it needs first, and doesn't repeat that it didn't answer", () => {
    const missing = assessHealth({ ...healthy, readiness: { ...READY, ok: false, checks: { database: false, storage: true, redis: false } } });
    expect(missing.findings).toEqual([{ severity: "critical", area: "Admin", text: "The admin can't reach the database or Redis." }]);
    const down = assessHealth({ ...healthy, readiness: { kind: "unreachable", reason: "the connection was refused" }, fleet: { kind: "unreachable", reason: "the connection was refused" } });
    expect(down.findings).toEqual([{ severity: "critical", area: "Admin", text: "The admin didn't answer the panel: the connection was refused." }]);
  });

  it("warns about a database close to its connection limit or just restarted", () => {
    const verdict = assessHealth({ ...healthy, database: { ...DATABASE, connections: 80, startedAt: new Date(NOW - 20 * 60_000) } });
    expect(verdict.findings.map((finding) => finding.text)).toEqual([
      "80 of the 97 connections the services may open are open (82%).",
      "PostgreSQL started 20 minutes ago: it restarted.",
    ]);
  });

  it("warns about failing calls and texts only once there are enough to tell, and about stuck ones at once", () => {
    expect(assessHealth({ ...healthy, activity: { ...ACTIVITY, calls: 9, failedCalls: 9 } }).findings).toEqual([]);
    const verdict = assessHealth({ ...healthy, activity: { ...ACTIVITY, calls: 10, failedCalls: 2, texts: 20, failedTexts: 5, stuckCalls: 1, stuckTexts: 4 } });
    expect(verdict.findings.map((finding) => [finding.area, finding.text])).toEqual([
      ["Calls", "2 of the last 24 hours' 10 calls failed (20%)."],
      ["Calls", "1 call has been open for more than 2 hours: the worker may not have closed it."],
      ["Texts", "5 of the last 24 hours' 20 texts failed or weren't delivered (25%)."],
      ["Texts", "4 texts have waited more than 15 minutes to go out."],
    ]);
  });

  it("calls a database the panel can't read a problem, first of all", () => {
    const verdict = assessHealth({ ...healthy, database: null, activity: null, databaseProblem: "connect ECONNREFUSED", fleet: { kind: "off" } });
    expect(verdict.tone).toBe("critical");
    expect(verdict.findings[0]).toEqual({ severity: "critical", area: "Database", text: "The panel can't read the database: connect ECONNREFUSED" });
    expect(verdict.findings).toHaveLength(2);
  });
});
