import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@lobbystack/contracts";
import { runDailyBillingVerify } from "@lobbystack/domain";
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

describe("billing jobs: the daily catalog check", () => {
  it("runs the daily billing check for the deployment and tells PostHog about a drift, a failure and the first pass after", async () => {
    const domain = { db: undefined as never };
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.verifyCatalog", queue: "maintenance", businessId: null, payload: {}, trace: {}, idempotencyKey: "billing-verify", scheduled: true };
    const capture = vi.fn(async () => undefined);
    const readSnapshot = vi.fn(async () => { throw new Error("not read in this test"); });
    // Without a Polar token there's nothing to compare with.
    expect(await handleJob(job, { domain })).toEqual({ status: "skipped" });
    expect(runDailyBillingVerify).not.toHaveBeenCalled();

    const drift = { code: "product", pair: "file_polar", level: "drift", subject: "Product \"Pro monthly\"", message: "x" } as const;
    const warn = { code: "code_hash", pair: "file_postgres", level: "warn", subject: "code", message: "y" } as const;
    vi.mocked(runDailyBillingVerify)
      .mockResolvedValueOnce({ status: "skipped", reason: "nothing was linked yet" })
      .mockResolvedValueOnce({ status: "drift", previousStatus: "passed", problems: [drift, { ...drift, code: "linked_id", pair: "postgres_polar" }, { ...drift, subject: "Product \"Pro annual\"" }, warn], polarEnv: "sandbox", provider: "polar", providerEnv: "sandbox", runId: "run-1" })
      .mockResolvedValueOnce({ status: "failed", previousStatus: "drift", problems: [{ ...drift, code: "unreadable", subject: "Polar" }], polarEnv: "sandbox", provider: "polar", providerEnv: "sandbox", runId: "run-2" })
      .mockResolvedValueOnce({ status: "passed", previousStatus: "failed", problems: [warn], polarEnv: "sandbox", provider: "polar", providerEnv: "sandbox", runId: "run-3" })
      .mockResolvedValueOnce({ status: "passed", previousStatus: "passed", problems: [], polarEnv: "sandbox", provider: "polar", providerEnv: "sandbox", runId: "run-4" });
    const dependencies = { domain, billingCatalog: { readSnapshot }, productAnalytics: { capture } };
    expect(await handleJob(job, dependencies)).toEqual({ status: "skipped" });
    expect(runDailyBillingVerify).toHaveBeenLastCalledWith(domain, { brand: expect.any(String), env: process.env, readPolar: expect.any(Function) });
    await vi.mocked(runDailyBillingVerify).mock.calls[0]![1].readPolar().catch(() => undefined);
    // Never the webhook, whose listing carries its signing secret.
    expect(readSnapshot).toHaveBeenCalledExactlyOnceWith({ webhooks: false });

    expect(await handleJob(job, dependencies)).toEqual({ status: "completed", entityId: "run-1:drift" });
    expect(await handleJob(job, dependencies)).toEqual({ status: "completed", entityId: "run-2:failed" });
    expect(await handleJob(job, dependencies)).toEqual({ status: "completed", entityId: "run-3:passed" });
    expect(await handleJob(job, dependencies)).toEqual({ status: "completed", entityId: "run-4:passed" });
    expect(capture.mock.calls.map((call) => (call as unknown as [Array<{ event: string; distinctId: string; properties: unknown }>])[0].map(({ event, distinctId, properties }) => ({ event, distinctId, properties })))).toEqual([
      [{ event: "ops.billing.profile_drift", distinctId: "system:deployment", properties: { status: "drift", problemCodes: ["linked_id", "product"], problemCount: 3, polarEnv: "sandbox", provider: "polar", providerEnv: "sandbox" } }],
      [{ event: "ops.billing.profile_drift", distinctId: "system:deployment", properties: { status: "failed", problemCodes: ["unreadable"], problemCount: 1, polarEnv: "sandbox", provider: "polar", providerEnv: "sandbox" } }],
      [{ event: "ops.billing.profile_drift_recovered", distinctId: "system:deployment", properties: { status: "passed", problemCodes: [], problemCount: 0, polarEnv: "sandbox", provider: "polar", providerEnv: "sandbox" } }],
    ]);
  });
});
