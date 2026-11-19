import { shortReplica, type FleetResult, type ReadinessResult } from "./admin-service";
import type { DatabaseHealth, RecentActivity } from "./queries";
import { STUCK_CALL_MINUTES, STUCK_TEXT_MINUTES } from "./queries";

/**
 * What the System health page makes of the numbers it reads
 * (docs/features/control-panel.md, "Read the System health page"): each thing
 * that needs a look, and one verdict for the deployment. The limits are
 * starting points, the same ones the monitoring research suggested for an
 * alert, not measured.
 */

export const LIMITS = {
  /** A copy whose one thread was busy more than this share of the time since its last beat. */
  busyShare: 0.85,
  /** Jobs waiting in one queue. */
  queueWaiting: 100,
  /** Connections open against the most the services may open. */
  connectionShare: 0.8,
  /** Failed calls or texts, of the last 24 hours', once there are enough to tell. */
  failedShare: 0.2,
  failedSample: 10,
  /** A PostgreSQL start this recent is a restart worth knowing about. */
  restartHours: 1,
} as const;

export type Severity = "critical" | "warning";

export type Finding = { severity: Severity; area: string; text: string };

export type Verdict = {
  tone: "good" | "warning" | "critical";
  /** A few words for the verdict: All good, Needs a look, or Problem. */
  label: string;
  findings: Finding[];
};

export type HealthInput = {
  fleet: FleetResult;
  readiness: ReadinessResult;
  /** Null when the panel couldn't read them, and then why. */
  database: DatabaseHealth | null;
  activity: RecentActivity | null;
  databaseProblem?: string | null;
  now?: number;
};

const percent = (share: number) => `${Math.round(share * 100)}%`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function adminFindings(readiness: ReadinessResult): Finding[] {
  if (readiness.kind === "not_set_up") return [{ severity: "warning", area: "Admin", text: readiness.reason }];
  if (readiness.kind === "unreachable") return [{ severity: "critical", area: "Admin", text: `The admin didn't answer the panel: ${readiness.reason}.` }];
  const missing = [
    readiness.checks.database ? null : "the database",
    readiness.checks.storage ? null : "the file storage",
    readiness.checks.redis ? null : "Redis",
  ].filter((name): name is string => name !== null);
  if (missing.length) return [{ severity: "critical", area: "Admin", text: `The admin can't reach ${missing.join(", ").replace(/, ([^,]*)$/, " or $1")}.` }];
  return readiness.ok ? [] : [{ severity: "critical", area: "Admin", text: "The admin says it isn't ready." }];
}

function fleetFindings(fleet: FleetResult, adminAnswered: boolean): Finding[] {
  switch (fleet.kind) {
    case "not_set_up":
      return [{ severity: "warning", area: "Services", text: fleet.reason }];
    case "off":
      return [{ severity: "warning", area: "Services", text: "The fleet status address is off: the admin has no FLEET_STATUS_TOKEN, so the copies of the admin and the worker can't be seen." }];
    case "refused":
      return [{ severity: "warning", area: "Services", text: "The admin refused the panel's fleet token: FLEET_STATUS_TOKEN on the control service isn't the admin's." }];
    case "unreachable":
      // When the admin doesn't answer at all, its readiness check already says so.
      return adminAnswered ? [{ severity: "critical", area: "Services", text: `The fleet status address didn't answer: ${fleet.reason}.` }] : [];
    case "report":
      break;
  }
  const { report } = fleet;
  const findings: Finding[] = report.problems.map((text) => ({ severity: "critical", area: "Services", text }));
  for (const copy of report.copies) {
    if (copy.state !== "running" && copy.state !== "not_ready" && copy.state !== "draining") continue;
    const name = `${copy.service} copy ${shortReplica(copy.replica)}`;
    if (copy.busy >= LIMITS.busyShare) findings.push({ severity: "warning", area: "Services", text: `${name} was busy ${percent(copy.busy)} of the time since its last beat: it may be falling behind.` });
    if (copy.db && copy.db.waiting > 0) findings.push({ severity: "warning", area: "Services", text: `${name} has ${plural(copy.db.waiting, "query", "queries")} waiting for a database connection: all ${copy.db.max} of its connections are in use.` });
  }
  for (const [queue, counts] of Object.entries(report.queues ?? {})) {
    if (counts.waiting >= LIMITS.queueWaiting) findings.push({ severity: "warning", area: "Queues", text: `${plural(counts.waiting, "job is", "jobs are")} waiting in the ${queue} queue.` });
  }
  const died = report.died.length;
  if (died) findings.push({ severity: "warning", area: "Services", text: `${plural(died, "copy", "copies")} stopped in the last 24 hours without shutting down (a crash, a kill or running out of memory). Their last beats are under Copies that died.` });
  return findings;
}

function databaseFindings(database: DatabaseHealth, now: number): Finding[] {
  const findings: Finding[] = [];
  const usable = Math.max(1, database.maxConnections - database.reservedConnections);
  if (database.connections / usable >= LIMITS.connectionShare) {
    findings.push({ severity: "warning", area: "Database", text: `${database.connections} of the ${usable} connections the services may open are open (${percent(database.connections / usable)}).` });
  }
  if (database.startedAt && now - database.startedAt.getTime() < LIMITS.restartHours * 3_600_000) {
    findings.push({ severity: "warning", area: "Database", text: `PostgreSQL started ${Math.max(1, Math.round((now - database.startedAt.getTime()) / 60_000))} minutes ago: it restarted.` });
  }
  return findings;
}

function activityFindings(activity: RecentActivity): Finding[] {
  const findings: Finding[] = [];
  if (activity.calls >= LIMITS.failedSample && activity.failedCalls / activity.calls >= LIMITS.failedShare) {
    findings.push({ severity: "warning", area: "Calls", text: `${activity.failedCalls} of the last 24 hours' ${activity.calls} calls failed (${percent(activity.failedCalls / activity.calls)}).` });
  }
  if (activity.stuckCalls) {
    findings.push({ severity: "warning", area: "Calls", text: `${plural(activity.stuckCalls, "call has", "calls have")} been open for more than ${STUCK_CALL_MINUTES / 60} hours: the worker may not have closed ${activity.stuckCalls === 1 ? "it" : "them"}.` });
  }
  if (activity.texts >= LIMITS.failedSample && activity.failedTexts / activity.texts >= LIMITS.failedShare) {
    findings.push({ severity: "warning", area: "Texts", text: `${activity.failedTexts} of the last 24 hours' ${activity.texts} texts failed or weren't delivered (${percent(activity.failedTexts / activity.texts)}).` });
  }
  if (activity.stuckTexts) {
    findings.push({ severity: "warning", area: "Texts", text: `${plural(activity.stuckTexts, "text has", "texts have")} waited more than ${STUCK_TEXT_MINUTES} minutes to go out.` });
  }
  return findings;
}

/** Everything that needs a look, the critical first, and the verdict. */
export function assessHealth({ fleet, readiness, database, activity, databaseProblem = null, now = Date.now() }: HealthInput): Verdict {
  const findings = [
    ...(databaseProblem ? [{ severity: "critical", area: "Database", text: `The panel can't read the database: ${databaseProblem}` } satisfies Finding] : []),
    ...adminFindings(readiness),
    ...fleetFindings(fleet, readiness.kind === "answered"),
    ...(database ? databaseFindings(database, now) : []),
    ...(activity ? activityFindings(activity) : []),
  ].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
  if (findings.some((finding) => finding.severity === "critical")) return { tone: "critical", label: "Problem", findings };
  if (findings.length) return { tone: "warning", label: "Needs a look", findings };
  return { tone: "good", label: "All good", findings };
}
