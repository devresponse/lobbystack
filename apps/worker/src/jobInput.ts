import type { JobEnvelope } from "@lobbystack/contracts";

export function businessIdOrThrow(job: JobEnvelope): string {
  if (!job.businessId) {
    throw new Error(`Job ${job.type} requires a business context.`);
  }
  return job.businessId;
}
