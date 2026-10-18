import type { Job } from "bullmq";

import type { JobEnvelope } from "@lobbystack/contracts";
import { redactOtelExceptionText } from "@lobbystack/telemetry/node";

import { jobCallContext } from "./jobCallContext";

type FailedJob = Pick<Job<JobEnvelope>, "id" | "data" | "attemptsMade" | "opts" | "finishedOn">;

/**
 * The deploy log line for a failed job attempt: which job, which attempt,
 * whether BullMQ will retry it, and why. One JSON line, so the log viewer
 * shows the message and can filter on the rest, including the call's IDs
 * when the job works on a call.
 */
export function jobFailureLogLine(queue: string, job: FailedJob | undefined, error: Error): string {
  const attempt = job ? ` (attempt ${job.attemptsMade} of ${job.opts.attempts ?? 1})` : "";
  const call = job ? jobCallContext(job.data) : undefined;
  return JSON.stringify({
    event: "job.failed",
    queue,
    type: job?.data.type,
    jobId: job?.id,
    businessId: job?.data.businessId ?? undefined,
    callId: call?.callId,
    sessionId: call?.sessionId,
    attempt: job?.attemptsMade,
    // BullMQ sets finishedOn only once it stops retrying.
    willRetry: job ? !job.finishedOn : false,
    message: `${job?.data.type ?? "Job"} failed${attempt}: ${redactOtelExceptionText(error.message)}`,
  });
}
