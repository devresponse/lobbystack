import { adminServiceSettings, fetchFleet, fetchReadiness, type FleetResult, type ReadinessResult } from "./admin-service";
import type { Queryable } from "./db";
import { assessHealth, type Verdict } from "./health";
import { databaseHealth, recentActivity, type DatabaseHealth, type RecentActivity } from "./queries";

type Environment = Record<string, string | undefined>;

export type SystemHealth = {
  fleet: FleetResult;
  readiness: ReadinessResult;
  database: DatabaseHealth | null;
  activity: RecentActivity | null;
  /** Why the database's numbers are missing, when they are. */
  databaseProblem: string | null;
  verdict: Verdict;
  checkedAt: Date;
};

/** A database error in a sentence, without the query or its values. */
function databaseFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.slice(0, 300) || "the query failed";
}

/**
 * Everything the System health page shows, read at once: the admin's answers
 * and the database's numbers side by side, so a database the panel can't reach
 * still leaves the services' heartbeats to read, and the other way round.
 */
export async function readSystemHealth(
  db: Queryable | Error,
  { env = process.env, timeoutMs }: { env?: Environment; timeoutMs?: number } = {},
): Promise<SystemHealth> {
  const settings = adminServiceSettings(env);
  const fromDatabase: Promise<[DatabaseHealth, RecentActivity]> = db instanceof Error
    ? Promise.reject(db)
    : Promise.all([databaseHealth(db), recentActivity(db)]);
  const [fleet, readiness, numbers] = await Promise.all([
    fetchFleet(settings, { timeoutMs }),
    fetchReadiness(settings, { timeoutMs }),
    fromDatabase.then((value) => ({ value }), (error: unknown) => ({ error: databaseFailure(error) })),
  ]);
  const [database, activity] = "value" in numbers ? numbers.value : [null, null];
  const databaseProblem = "error" in numbers ? numbers.error : null;
  const verdict = assessHealth({ fleet, readiness, database, activity, databaseProblem });
  return { fleet, readiness, database, activity, databaseProblem, verdict, checkedAt: new Date() };
}
