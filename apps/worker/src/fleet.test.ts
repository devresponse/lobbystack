import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { registerPoolMetrics } from "@lobbystack/db";
import { readFleet } from "@lobbystack/jobs";
import { forceFlushTelemetryMetrics, initializeTelemetry, shutdownTelemetry } from "@lobbystack/telemetry/node";
import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { queueCounts, registerWorkerMetrics, startWorkerHeartbeat, workerFleetSample } from "./fleet";

type OtlpPoint = { asDouble?: number; asInt?: number | string; attributes?: Array<{ key: string; value: { stringValue?: string } }> };
type OtlpMetrics = { resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeMetrics: Array<{ metrics: Array<{ name: string; gauge?: { dataPoints: OtlpPoint[] } }> }> }> };

afterEach(async () => {
  vi.unstubAllEnvs();
  await shutdownTelemetry();
});

const queues = () => ({
  critical: { waiting: 4, active: 2, delayed: 1, failed: 9 },
  bulk: { waiting: 0, active: 1, delayed: 0, failed: 0 },
});

describe("what a copy of the worker reports", () => {
  it("counts a job that is ready but not taken as waiting, whatever BullMQ calls it", () => {
    expect(queueCounts({ waiting: 3, prioritized: 2, paused: 1, active: 4, delayed: 5, failed: 6, completed: 70, "waiting-children": 8 })).toEqual({ waiting: 6, active: 4, delayed: 5, failed: 6 });
    expect(queueCounts({})).toEqual({ waiting: 0, active: 0, delayed: 0, failed: 0 });
  });

  it("carries its calls, jobs, connections and the queues in a beat, and leaves the queues out once it is shutting down", () => {
    // The shares a deployment with copies gives a worker (guide 7.24): 12 connections a copy.
    vi.stubEnv("LOBBYSTACK_WORKER_POOL_MAX", "10");
    vi.stubEnv("LOBBYSTACK_DISPATCHER_POOL_MAX", "2");
    const state = { ready: true, activeJobs: 3, draining: false };
    const input = { state, liveCalls: () => 2, queues };

    // No pool is open in this test, so the connections are none of the 12 a copy may hold.
    expect(workerFleetSample(input)).toEqual({ ready: true, activeJobs: 3, liveCalls: 2, db: { open: 0, inUse: 0, waiting: 0, max: 12 }, queues: queues() });
    state.draining = true;
    expect(workerFleetSample(input)).toEqual({ ready: true, activeJobs: 3, liveCalls: 2, db: { open: 0, inUse: 0, waiting: 0, max: 12 } });
  });

  it("sends its live calls, running jobs and each queue's jobs with the metrics, named by copy", async () => {
    vi.stubEnv("RAILWAY_REPLICA_ID", "replica-worker-1");
    const bodies: OtlpMetrics[] = [];
    const receiver = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (request.url === "/v1/metrics") bodies.push(JSON.parse(body) as OtlpMetrics);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("OTLP test receiver did not start.");
    const state = { ready: true, activeJobs: 3, draining: false };

    try {
      // As the worker starts: telemetry first, then the gauges.
      await initializeTelemetry({ endpoint: `http://127.0.0.1:${address.port}`, serviceName: "lobbystack-worker" });
      registerPoolMetrics();
      registerWorkerMetrics({ state, liveCalls: () => 2, queues });
      await forceFlushTelemetryMetrics();
    } finally {
      await shutdownTelemetry();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }

    const exported = bodies.flatMap((body) => body.resourceMetrics);
    expect(exported.length).toBeGreaterThan(0);
    for (const entry of exported) {
      expect(Object.fromEntries(entry.resource.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))).toMatchObject({ "service.name": "lobbystack-worker", "service.instance.id": "replica-worker-1" });
    }
    const metrics = exported.flatMap((entry) => entry.scopeMetrics.flatMap((scope) => scope.metrics));
    const value = (point: OtlpPoint | undefined) => point?.asDouble ?? (point?.asInt === undefined ? undefined : Number(point.asInt));
    const points = (name: string) => metrics.find((metric) => metric.name === name)?.gauge?.dataPoints ?? [];
    expect(value(points("lobbystack.worker.live_calls")[0])).toBe(2);
    expect(value(points("lobbystack.worker.active_jobs")[0])).toBe(3);
    const byQueue = Object.fromEntries(points("lobbystack.queue.jobs").map((point) => {
      const attributes = Object.fromEntries((point.attributes ?? []).map((attribute) => [attribute.key, attribute.value.stringValue]));
      return [`${attributes["messaging.destination.name"]}:${attributes.state}`, value(point)];
    }));
    // Failed jobs are kept for a week, so their count is no backlog and stays out of the gauge.
    expect(byQueue).toEqual({ "critical:waiting": 4, "critical:active": 2, "critical:delayed": 1, "bulk:waiting": 0, "bulk:active": 1, "bulk:delayed": 0 });
    expect(metrics.map((metric) => metric.name)).toContain("process.event_loop.utilization");
  });
});

const testUrl = process.env.REDIS_TEST_URL;
const prefix = `lobbystack:worker-fleet-test:${randomUUID()}`;
let inspector: Redis;

describe.runIf(Boolean(testUrl))("a worker's heartbeat in Redis", () => {
  beforeAll(() => {
    inspector = new Redis(testUrl!);
  });

  afterAll(async () => {
    await inspector.del(`${prefix}:fleet:seen`, `${prefix}:fleet:beats`);
    inspector.disconnect();
  });

  it("says which copy it is and what it holds, then that it is shutting down, and leaves that as its last word", async () => {
    vi.stubEnv("REDIS_URL", testUrl!);
    vi.stubEnv("REDIS_PREFIX", prefix);
    vi.stubEnv("RAILWAY_REPLICA_ID", "replica-worker-1");
    vi.stubEnv("RAILWAY_REPLICA_REGION", "us-west2");
    vi.stubEnv("RAILWAY_DEPLOYMENT_ID", "dep-1");
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "abc1234");
    const state = { ready: true, activeJobs: 1, draining: false };
    const heartbeat = startWorkerHeartbeat({ state, liveCalls: () => 2, queues });

    await heartbeat.beat();
    expect((await readFleet()).records).toEqual([expect.objectContaining({
      service: "worker", replica: "replica-worker-1", region: "us-west2", deployment: "dep-1", release: "abc1234",
      ready: true, activeJobs: 1, liveCalls: 2, draining: false, queues: queues(),
    })]);

    // As the worker's shutdown does: the state first, then the beat that says so.
    state.draining = true;
    await heartbeat.drain();
    const [draining] = (await readFleet()).records;
    expect(draining).toMatchObject({ draining: true, liveCalls: 2 });
    expect(draining).not.toHaveProperty("queues");

    // Its last beat stays on the list, so the fleet reads a copy that left on purpose, not one that died.
    await heartbeat.stop();
    expect((await readFleet()).records).toEqual([expect.objectContaining({ replica: "replica-worker-1", draining: true })]);
  });
});
