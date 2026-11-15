import { serviceConnections } from "@lobbystack/db";
import { startFleetHeartbeat, type FleetHeartbeat, type FleetQueueCounts, type FleetSample } from "@lobbystack/jobs";
import { getMeter, logEvent, serviceInstance } from "@lobbystack/telemetry/node";

import type { WorkerHealthState } from "./health";

// What this copy of the worker says about itself: a beat in Redis every 10
// seconds, which the admin's fleet status address reads, and gauges with every
// metrics export (docs/features/observability.md, "Watch every copy").
// Everything here is read from memory: the worker's health check already
// counts the queues every 10 seconds, and this only keeps what it found.

type JobCounts = Record<string, number>;

/** BullMQ's counts for one queue, as the fleet reports them. A job that is ready but not taken is waiting, whatever BullMQ calls it. */
export function queueCounts(counts: JobCounts): FleetQueueCounts {
  return {
    waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0),
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
  };
}

export type WorkerFleetInput = {
  state: Pick<WorkerHealthState, "ready" | "activeJobs" | "draining">;
  /** The calls this copy holds. */
  liveCalls: () => number;
  /** Each queue's jobs, as the health check last counted them. */
  queues: () => Record<string, FleetQueueCounts>;
};

/** What the worker's beat carries. A copy that is shutting down no longer counts the queues, so it leaves them out. */
export function workerFleetSample(input: WorkerFleetInput): FleetSample {
  return {
    ready: input.state.ready,
    activeJobs: input.state.activeJobs,
    liveCalls: input.liveCalls(),
    db: serviceConnections("worker"),
    ...(input.state.draining ? {} : { queues: input.queues() }),
  };
}

/**
 * Sends this copy's live calls, running jobs and each queue's jobs with every
 * metrics export. Every copy counts the same queues, so chart a queue's
 * maximum over the copies, not its sum. Call it after telemetry has started.
 * Returns a function that stops it.
 */
export function registerWorkerMetrics(input: WorkerFleetInput): () => void {
  const meter = getMeter("lobbystack-worker");
  const liveCalls = meter.createObservableGauge("lobbystack.worker.live_calls", { unit: "{call}", description: "Calls this copy of the worker holds" });
  const activeJobs = meter.createObservableGauge("lobbystack.worker.active_jobs", { unit: "{job}", description: "Jobs this copy of the worker is running" });
  const queueJobs = meter.createObservableGauge("lobbystack.queue.jobs", { unit: "{job}", description: "Jobs in a queue by state, as this copy of the worker last counted them" });
  const gauges = [liveCalls, activeJobs, queueJobs];
  const callback: Parameters<typeof meter.addBatchObservableCallback>[0] = (result) => {
    result.observe(liveCalls, input.liveCalls());
    result.observe(activeJobs, input.state.activeJobs);
    if (input.state.draining) return;
    for (const [queue, counts] of Object.entries(input.queues())) {
      result.observe(queueJobs, counts.waiting, { "messaging.destination.name": queue, state: "waiting" });
      result.observe(queueJobs, counts.active, { "messaging.destination.name": queue, state: "active" });
      result.observe(queueJobs, counts.delayed, { "messaging.destination.name": queue, state: "delayed" });
    }
  };
  meter.addBatchObservableCallback(callback, gauges);
  return () => meter.removeBatchObservableCallback(callback, gauges);
}

/** Starts this copy's heartbeat. A beat that fails is logged at most once a minute, and the next one tries again. */
export function startWorkerHeartbeat(input: WorkerFleetInput): FleetHeartbeat {
  const instance = serviceInstance();
  return startFleetHeartbeat(
    { service: "worker", replica: instance.id, release: instance.release, ...(instance.deployment ? { deployment: instance.deployment } : {}), ...(instance.region ? { region: instance.region } : {}) },
    () => workerFleetSample(input),
    { onError: (error) => logEvent("warn", "fleet.heartbeat_failed", { error }) },
  );
}
