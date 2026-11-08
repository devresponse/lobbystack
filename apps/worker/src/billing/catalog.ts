// The daily check of the billing catalog against Polar.
import type { JobEnvelope } from "@lobbystack/contracts";
import { currentBrand } from "@lobbystack/shared";
import { runDailyBillingVerify, type DailyBillingVerifyOutcome } from "@lobbystack/domain";
import { logEvent } from "@lobbystack/telemetry/node";
import type { JobResult, WorkerDependencies } from "../handlers";

/** billing.verifyCatalog: the daily check of the catalog against Polar. */
export async function verifyBillingCatalog(_job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  if (!dependencies.polarCatalog) return { status: "skipped" };
  const polarCatalog = dependencies.polarCatalog;
  // Without the webhook, which Polar lists with its signing secret: the worker's token goes without webhooks:read.
  const outcome = await runDailyBillingVerify(dependencies.domain, { brand: currentBrand().id, env: process.env, readPolar: () => polarCatalog.readSnapshot({ webhooks: false }) });
  if (outcome.status === "skipped") return { status: "skipped" };
  await recordBillingCatalogCheck(dependencies, outcome);
  return { status: "completed", entityId: `${outcome.runId}:${outcome.status}` };
}

/**
 * Tells PostHog about the daily billing check: a drift or a failure every day
 * it lasts, and the first pass after one. The events belong to the deployment,
 * not a business, so they go straight to PostHog instead of through
 * `recordProductEvent`. Best-effort, like the other operations events.
 */
async function recordBillingCatalogCheck(dependencies: WorkerDependencies, outcome: Exclude<DailyBillingVerifyOutcome, { status: "skipped" }>): Promise<void> {
  const recovered = outcome.status === "passed" && (outcome.previousStatus === "drift" || outcome.previousStatus === "failed");
  if (outcome.status === "passed" && !recovered) return;
  const event = recovered ? "ops.billing.profile_drift_recovered" : "ops.billing.profile_drift";
  const problemCodes = [...new Set(outcome.problems.filter((problem) => problem.level === "drift").map((problem) => problem.code))].sort();
  const properties = { status: outcome.status, problemCodes, problemCount: outcome.problems.filter((problem) => problem.level === "drift").length, polarEnv: outcome.polarEnv };
  logEvent(recovered ? "info" : "warn", event, { ...properties, problemCodes: problemCodes.join(","), runId: outcome.runId });
  if (!dependencies.productAnalytics) return;
  try {
    await dependencies.productAnalytics.capture([{ event, distinctId: "system:deployment", properties, timestamp: new Date().toISOString() }]);
  } catch {
    // The run is stored either way, and lobbystack billing catalog-runs --kind verify lists it.
  }
}
