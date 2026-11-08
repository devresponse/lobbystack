import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@lobbystack/contracts";
import { reconcileBillingProviderEvent } from "@lobbystack/domain";
import { sweepBillingWork } from "@lobbystack/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));

import { handleJob } from "../handlers";
import { brand } from "./testing";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  brand.appBaseUrl = null;
});

describe("billing jobs: reconcile and the sweep", () => {
  it("reconciles a persisted Polar provider event", async () => {
    const businessId = randomUUID();
    const providerEventId = randomUUID();
    vi.mocked(reconcileBillingProviderEvent).mockResolvedValue("processed");

    const result = await handleJob({
      jobId: randomUUID(),
      type: "billing.reconcile",
      queue: "default",
      businessId,
      payload: { providerEventId },
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: false,
    }, { domain: { db: undefined as never } });

    expect(result).toEqual({ status: "completed", entityId: providerEventId });
    expect(reconcileBillingProviderEvent).toHaveBeenCalledWith({ db: undefined as never }, { businessId, providerEventId });
  });

  it("leaves a held Polar event for the sweep to run again", async () => {
    const businessId = randomUUID();
    const providerEventId = randomUUID();
    vi.mocked(reconcileBillingProviderEvent).mockResolvedValue("held");

    const result = await handleJob({ jobId: randomUUID(), type: "billing.reconcile", queue: "default", businessId, payload: { providerEventId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false }, { domain: { db: undefined as never } });

    expect(result).toEqual({ status: "skipped", entityId: providerEventId });
  });

  describe("the billing sweep", () => {
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.sweep", queue: "maintenance", businessId: null, payload: {}, trace: {}, idempotencyKey: "billing-sweep", scheduled: true };
    const counts = (values: Partial<Record<"provider_event" | "usage_event" | "checkout_request", number>> = {}) => ({ provider_event: 0, usage_event: 0, checkout_request: 0, ...values });
    const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

    it("does nothing out loud when no billing work waits", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.mocked(sweepBillingWork).mockResolvedValue({ queued: counts(), overdue: counts(), failed: 0 });

      expect(await handleJob(job, { domain: { db: undefined as never } })).toEqual({ status: "skipped", entityId: "0:0" });
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      info.mockRestore();
      error.mockRestore();
    });

    it("logs work it queued again, and reports to PostHog only work that waited longer than it should", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.mocked(sweepBillingWork).mockResolvedValueOnce({ queued: counts({ checkout_request: 1 }), overdue: counts(), failed: 0 });

      expect(await handleJob(job, { domain: { db: undefined as never } })).toEqual({ status: "completed", entityId: "1:0" });
      expect(lines(info)).toEqual([expect.objectContaining({ level: "info", message: "ops.billing.sweep", checkoutsQueued: 1, eventsOverdue: 0 })]);
      expect(error).not.toHaveBeenCalled();

      vi.mocked(sweepBillingWork).mockResolvedValueOnce({ queued: counts({ provider_event: 2, usage_event: 1 }), overdue: counts({ provider_event: 1, checkout_request: 1 }), failed: 0 });
      expect(await handleJob(job, { domain: { db: undefined as never } })).toEqual({ status: "completed", entityId: "3:1" });
      expect(lines(warn)).toContainEqual(expect.objectContaining({ message: "ops.billing.sweep", eventsQueued: 2, usageQueued: 1, eventsOverdue: 1, checkoutsExpired: 1 }));
      // A worker without Polar's settings sends no usage and fails no job, so the report says so.
      expect(lines(error)).toContainEqual(expect.objectContaining({ level: "error", message: expect.stringMatching(/\] exception: Billing work waited longer than it should\.$/), operation: "job.billing.sweep", polarConfigured: false, eventsOverdue: 1, checkoutsExpired: 1, alertable: true }));
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    });

    it("fails the job with the first error once the rest is queued, so the next try picks up what it couldn't", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const failure = new Error("connection terminated");
      vi.mocked(sweepBillingWork).mockResolvedValue({ queued: counts({ usage_event: 3 }), overdue: counts(), failed: 1, error: failure });

      await expect(handleJob(job, { domain: { db: undefined as never } })).rejects.toBe(failure);
      expect(lines(warn)).toEqual([expect.objectContaining({ message: "ops.billing.sweep", usageQueued: 3, failed: 1 })]);
      warn.mockRestore();
    });
  });
});
