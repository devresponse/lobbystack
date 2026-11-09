// A business's prepaid packs: their end dates, the owners' reminders and the number's release.
import type { JobEnvelope } from "@lobbystack/contracts";
import { expireBusinessPacks } from "@lobbystack/domain";
import type { JobResult, WorkerDependencies } from "../handlers";
import { businessIdOrThrow } from "../jobInput";

/**
 * billing.expirePacks: ends the business's packs whose end date has come, settles each pack that ended
 * once, sends the reminders due, and sets its number's release once its last pack ended. It runs daily
 * and whenever a call, a refund or a dispute that ends a pack queues it; every run does the same, so the payload is
 * ignored. No billing provider is needed: a pack's end is LobbyStack's to keep.
 */
export async function expireBillingPacks(job: JobEnvelope, dependencies: WorkerDependencies): Promise<JobResult> {
  const businessId = businessIdOrThrow(job);
  const done = await expireBusinessPacks(dependencies.domain, { businessId, appUrl: process.env.APP_BASE_URL ?? "http://localhost:3000" });
  return { status: done.expired + done.settled + done.emails > 0 ? "completed" : "skipped", entityId: `${businessId}:${done.expired}:${done.settled}:${done.emails}` };
}
