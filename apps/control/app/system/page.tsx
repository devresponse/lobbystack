import type { Metadata } from "next";

import { Badge, Empty, Panel, StatTile, type Tone } from "@/components/ui";
import { shortRelease, shortReplica, type FleetCopy, type FleetResult, type ReadinessResult } from "@/lib/admin-service";
import { displayVersion } from "@/lib/config";
import { database } from "@/lib/db";
import { ago, bytes, count, dateTime, percent, span } from "@/lib/format";
import { STUCK_CALL_MINUTES, STUCK_TEXT_MINUTES, type DatabaseHealth, type RecentActivity } from "@/lib/queries";
import { currentAdmin } from "@/lib/session";
import { readSystemHealth } from "@/lib/system-health";

export const metadata: Metadata = { title: "System health" };

const STATES: Record<string, { tone: Tone; words: string }> = {
  running: { tone: "good", words: "running" },
  not_ready: { tone: "warning", words: "not ready" },
  draining: { tone: "neutral", words: "shutting down" },
  silent: { tone: "critical", words: "silent" },
  left: { tone: "neutral", words: "left" },
  died: { tone: "serious", words: "died" },
};

function CopyState({ state }: { state: string }) {
  const known = STATES[state];
  return <Badge tone={known?.tone ?? "neutral"}>{known?.words ?? state.replaceAll("_", " ")}</Badge>;
}

/** What a copy holds: a worker's calls and jobs, or nothing to say for the admin. */
function work(copy: FleetCopy): string {
  const parts = [
    copy.liveCalls === null ? null : `${count(copy.liveCalls)} ${copy.liveCalls === 1 ? "call" : "calls"}`,
    copy.activeJobs === null ? null : `${count(copy.activeJobs)} ${copy.activeJobs === 1 ? "job" : "jobs"}`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "-";
}

function pool(copy: FleetCopy) {
  if (!copy.db) return "-";
  return (
    <>
      {count(copy.db.inUse)} in use of {count(copy.db.max)}
      {copy.db.waiting ? <span className="sub">{count(copy.db.waiting)} waiting</span> : null}
    </>
  );
}

/** Why the copies can't be listed, and what sets it right. */
function fleetMissing(fleet: Exclude<FleetResult, { kind: "report" }>): string {
  switch (fleet.kind) {
    case "not_set_up":
      return `${fleet.reason} The bootstrap script gives the control service CONTROL_ADMIN_URL and FLEET_STATUS_TOKEN: run its up with the settings file, and the panel deploys again with them.`;
    case "off":
      return "The admin has no FLEET_STATUS_TOKEN, so its fleet status address is off. The bootstrap script's fleet.token step gives the admin one (redo the settings file's fleet.token, then up), and the control service uses the admin's.";
    case "refused":
      return "The admin refused the token: FLEET_STATUS_TOKEN on the control service isn't the admin's. The bootstrap script sets it to ${{admin.FLEET_STATUS_TOKEN}}, which Railway reads when the control service deploys, so deploy it again after the admin's token changes.";
    case "unreachable":
      return `The admin didn't answer: ${fleet.reason}.`;
  }
}

function AdminFacts({ readiness, panelVersion }: { readiness: ReadinessResult; panelVersion: string }) {
  if (readiness.kind !== "answered") return <Empty>{readiness.kind === "not_set_up" ? readiness.reason : `The admin didn't answer: ${readiness.reason}.`}</Empty>;
  const check = (ok: boolean, what: string) => <Badge tone={ok ? "good" : "critical"}>{ok ? "reached" : `can't reach ${what}`}</Badge>;
  return (
    <dl className="facts">
      <dt>Ready</dt>
      <dd><Badge tone={readiness.ok ? "good" : "critical"}>{readiness.ok ? "yes" : "no"}</Badge></dd>
      <dt>Database</dt>
      <dd>{check(readiness.checks.database, "it")}</dd>
      <dt>File storage</dt>
      <dd>{check(readiness.checks.storage, "it")}</dd>
      <dt>Redis</dt>
      <dd>{check(readiness.checks.redis, "it")}</dd>
      <dt>Release</dt>
      <dd>
        {shortRelease(readiness.release)}
        {readiness.release && panelVersion !== "development" && !readiness.release.startsWith(panelVersion) ? <span className="sub">the panel runs {panelVersion}</span> : null}
      </dd>
    </dl>
  );
}

function DatabaseFacts({ health, problem }: { health: DatabaseHealth | null; problem: string | null }) {
  if (!health) return <Empty>The panel can't read the database: {problem ?? "no answer"}</Empty>;
  const usable = Math.max(1, health.maxConnections - health.reservedConnections);
  const reads = health.blocksHit + health.blocksRead;
  const transactions = health.commits + health.rollbacks;
  return (
    <dl className="facts">
      <dt>Size</dt>
      <dd>{bytes(health.sizeBytes)}</dd>
      <dt>Connections</dt>
      <dd>
        {count(health.connections)} open of the {count(usable)} the services may open
        <span className="sub">{health.byRole.map((row) => `${row.role} ${row.connections}`).join(", ") || "none"}</span>
      </dd>
      <dt>Reads from memory</dt>
      <dd>{reads ? percent(health.blocksHit / reads) : "-"}</dd>
      <dt>Rolled back</dt>
      <dd>{transactions ? `${percent(health.rollbacks / transactions)} of ${count(transactions)} transactions` : "-"}</dd>
      <dt>Deadlocks</dt>
      <dd>{count(health.deadlocks)}</dd>
      <dt>Temporary files</dt>
      <dd>{bytes(health.tempBytes)}<span className="sub">written by queries too big for memory</span></dd>
      <dt>Started</dt>
      <dd>{dateTime(health.startedAt)}<span className="sub">{ago(health.startedAt)}</span></dd>
      <dt>Counted since</dt>
      <dd>{dateTime(health.countedSince)}</dd>
      <dt>Version</dt>
      <dd>PostgreSQL {health.version || "-"}</dd>
    </dl>
  );
}

function ActivityFacts({ activity }: { activity: RecentActivity }) {
  return (
    <dl className="facts">
      <dt>Calls</dt>
      <dd>{count(activity.calls)} started<span className="sub">{count(activity.failedCalls)} failed</span></dd>
      <dt>Calls open now</dt>
      <dd>
        {count(activity.openCalls)} started in the last {STUCK_CALL_MINUTES / 60} hours
        {activity.stuckCalls ? <span className="sub">{count(activity.stuckCalls)} open longer, never closed</span> : null}
      </dd>
      <dt>Texts sent</dt>
      <dd>{count(activity.texts)}<span className="sub">{count(activity.failedTexts)} failed or not delivered</span></dd>
      <dt>Texts waiting</dt>
      <dd>{count(activity.stuckTexts)} for more than {STUCK_TEXT_MINUTES} minutes</dd>
      <dt>Website chats</dt>
      <dd>{count(activity.chats)} started</dd>
    </dl>
  );
}

export default async function SystemHealthPage() {
  await currentAdmin();
  // The services' heartbeats still show when the database can't be reached.
  const db = await database().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  const { fleet, readiness, database: numbers, activity, databaseProblem, verdict, checkedAt } = await readSystemHealth(db);
  const report = fleet.kind === "report" ? fleet.report : null;
  const services = report?.services ?? {};
  // A silent copy's last calls may be gone with it, so only the copies that still report count.
  const workers = report?.copies.filter((copy) => copy.service === "worker" && (copy.state === "running" || copy.state === "not_ready" || copy.state === "draining")) ?? [];
  const liveCalls = workers.reduce((total, copy) => total + (copy.liveCalls ?? 0), 0);
  const queues = Object.entries(report?.queues ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const waiting = queues.reduce((total, [, counts]) => total + counts.waiting, 0);
  const failed = queues.reduce((total, [, counts]) => total + counts.failed, 0);
  const usable = numbers ? Math.max(1, numbers.maxConnections - numbers.reservedConnections) : null;
  // The panel asks the address without the number of copies Railway runs, so the address expects one of each: the
  // tiles count what reports, and say nothing of what's expected.
  const copiesTile = (service: string) => {
    const counts = services[service];
    const others = counts ? [[counts.notReady, "not ready"], [counts.draining, "shutting down"], [counts.silent, "silent"], [counts.died, "died in 24 hours"]] as const : [];
    const note = ["running", ...others.filter(([n]) => n > 0).map(([n, what]) => `${count(n)} ${what}`)].join(", ");
    return counts
      ? <StatTile label={`${service === "admin" ? "Admin" : "Worker"} copies`} value={count(counts.running)} note={note} />
      : <StatTile label={`${service === "admin" ? "Admin" : "Worker"} copies`} value="-" note="the heartbeats can't be read" />;
  };

  return (
    <>
      <h1>System health</h1>
      <p className="lead">
        How the deployment&apos;s services are doing: every copy of the admin and the worker from their heartbeats, the worker&apos;s queues, what the admin reaches,
        PostgreSQL&apos;s own numbers, and the last 24 hours&apos; calls and texts. Read at {dateTime(checkedAt)} UTC; reload the page to read again.
      </p>

      <section className={`panel verdict ${verdict.tone}`} aria-label="Verdict">
        <h2>
          <Badge tone={verdict.tone}>{verdict.label}</Badge>
          <small>{verdict.findings.length ? `${count(verdict.findings.length)} to look at` : "nothing to look at"}</small>
        </h2>
        {verdict.findings.length ? (
          <ul className="findings">
            {verdict.findings.map((finding) => (
              <li key={`${finding.area}:${finding.text}`}>
                <Badge tone={finding.severity === "critical" ? "critical" : "warning"}>{finding.area}</Badge>
                {/* The dot repeats the severity; the words say it. */}
                <span>{finding.severity === "critical" ? <strong>Problem: </strong> : null}{finding.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>Every copy reports, the admin reaches the database, the file storage and Redis, and nothing is piling up.</p>
        )}
      </section>

      <div className="tiles">
        {copiesTile("admin")}
        {copiesTile("worker")}
        <StatTile label="Live calls" value={report ? count(liveCalls) : "-"} note="on the worker copies that report" />
        <StatTile label="Jobs waiting" value={report?.queues ? count(waiting) : "-"} note={report?.queues ? `${count(failed)} failed jobs kept` : "no worker counted them"} />
        <StatTile label="Database connections" value={numbers ? count(numbers.connections) : "-"} note={usable ? `of the ${count(usable)} the services may open` : undefined} />
        <StatTile label="Calls, last 24 hours" value={activity ? count(activity.calls) : "-"} note={activity ? `${count(activity.failedCalls)} failed` : undefined} />
      </div>

      <Panel title="Copies" aside={report?.checkedAt ? `heartbeats as of ${dateTime(report.checkedAt)} UTC` : undefined}>
        {report ? (
          report.copies.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Copy</th>
                    <th>State</th>
                    <th>Release</th>
                    <th>Started</th>
                    <th className="num">Last beat</th>
                    <th className="num">Busy</th>
                    <th className="num">Memory</th>
                    <th>Database pool</th>
                    <th>Holding</th>
                  </tr>
                </thead>
                <tbody>
                  {report.copies.map((copy) => (
                    <tr key={`${copy.service}:${copy.replica}:${copy.startedAt ?? ""}`}>
                      <td>{copy.service}</td>
                      <td>
                        {shortReplica(copy.replica)}
                        {copy.region ? <span className="sub">{copy.region}</span> : null}
                      </td>
                      <td>
                        <CopyState state={copy.state} />
                        {copy.drainingForSeconds !== null ? <span className="sub">for {span(copy.drainingForSeconds)}</span> : null}
                      </td>
                      <td>{shortRelease(copy.release)}</td>
                      <td className="when">{ago(copy.startedAt)}</td>
                      <td className="num">{span(copy.lastSeenSecondsAgo)} ago</td>
                      <td className="num">{percent(copy.busy)}</td>
                      <td className="num">
                        {bytes(copy.rssBytes)}
                        <span className="sub">heap {bytes(copy.heapUsedBytes)}</span>
                      </td>
                      <td>{pool(copy)}</td>
                      <td>{work(copy)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No copy has reported in the last 10 minutes.</Empty>
          )
        ) : (
          <Empty>{fleetMissing(fleet as Exclude<FleetResult, { kind: "report" }>)}</Empty>
        )}
      </Panel>

      <Panel title="Queues" aside={report?.queuesCountedSecondsAgo !== null && report?.queuesCountedSecondsAgo !== undefined ? `counted by a worker ${span(report.queuesCountedSecondsAgo)} ago` : undefined}>
        {queues.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Queue</th>
                  <th className="num">Waiting</th>
                  <th className="num">Running</th>
                  <th className="num">Delayed</th>
                  <th className="num">Failed, kept</th>
                </tr>
              </thead>
              <tbody>
                {queues.map(([name, counts]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="num">{count(counts.waiting)}</td>
                    <td className="num">{count(counts.active)}</td>
                    <td className="num">{count(counts.delayed)}</td>
                    <td className="num">{count(counts.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{report ? "No worker has counted its queues yet." : "The queues come from the workers' heartbeats, which can't be read."}</Empty>
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="Admin" aside="its readiness check">
          <AdminFacts readiness={readiness} panelVersion={displayVersion()} />
        </Panel>
        <Panel title="Database" aside="PostgreSQL's own numbers">
          <DatabaseFacts health={numbers} problem={databaseProblem} />
        </Panel>
      </div>

      <Panel title="Last 24 hours" aside="calls, texts and chats on every business">
        {activity ? <ActivityFacts activity={activity} /> : <Empty>The panel can&apos;t read the database: {databaseProblem ?? "no answer"}</Empty>}
      </Panel>

      <Panel title="Copies that died" aside="last 24 hours, newest first">
        {report?.died.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Copy</th>
                  <th>Release</th>
                  <th>Last beat</th>
                  <th className="num">Ran for</th>
                  <th className="num">Busy</th>
                  <th className="num">Memory</th>
                  <th>Database pool</th>
                  <th>Holding</th>
                </tr>
              </thead>
              <tbody>
                {report.died.map((copy) => (
                  <tr key={`${copy.service}:${copy.replica}:${copy.lastSeenAt ?? ""}`}>
                    <td>{copy.service}</td>
                    <td>{shortReplica(copy.replica)}</td>
                    <td>{shortRelease(copy.release)}</td>
                    <td className="when">
                      {dateTime(copy.lastSeenAt)}
                      <span className="sub">{ago(copy.lastSeenAt)}</span>
                    </td>
                    <td className="num">{span(copy.ranForSeconds)}</td>
                    <td className="num">{percent(copy.busy)}</td>
                    <td className="num">{bytes(copy.rssBytes)}</td>
                    <td>{pool(copy)}</td>
                    <td>{work(copy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{report ? "None: every copy that stopped in the last 24 hours said it was shutting down." : "The list comes from the heartbeats, which can't be read."}</Empty>
        )}
      </Panel>
    </>
  );
}
