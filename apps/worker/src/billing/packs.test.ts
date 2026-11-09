import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@lobbystack/contracts";
import { expireBusinessPacks } from "@lobbystack/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));

import { handleJob } from "../handlers";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("billing jobs: prepaid packs", () => {
  function expirePacks(payload: Record<string, unknown> = {}) {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.expirePacks", queue: "default", businessId, payload, trace: {}, idempotencyKey: `pack-expiry:${businessId}`, scheduled: true, recurring: true };
    // No billing provider: a pack's end is LobbyStack's alone.
    return { businessId, domain, run: handleJob(job, { domain }) };
  }

  it("ends the business's due packs with the deployment's dashboard link for the owners' emails, and says what it did", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.example");
    vi.mocked(expireBusinessPacks).mockResolvedValue({ expired: 1, settled: 1, emails: 2, releaseAt: new Date("2026-12-31T00:00:00Z") });
    const { businessId, domain, run } = expirePacks();
    await expect(run).resolves.toEqual({ status: "completed", entityId: `${businessId}:1:1:2` });
    expect(expireBusinessPacks).toHaveBeenCalledWith(domain, { businessId, appUrl: "https://app.example" });
  });

  it("counts a run that only sent reminders, or only settled a refunded pack, as done", async () => {
    vi.mocked(expireBusinessPacks).mockResolvedValueOnce({ expired: 0, settled: 0, emails: 1, releaseAt: null });
    const reminded = expirePacks({ reason: "low" });
    await expect(reminded.run).resolves.toEqual({ status: "completed", entityId: `${reminded.businessId}:0:0:1` });
    vi.mocked(expireBusinessPacks).mockResolvedValueOnce({ expired: 0, settled: 1, emails: 0, releaseAt: null });
    const settled = expirePacks();
    await expect(settled.run).resolves.toEqual({ status: "completed", entityId: `${settled.businessId}:0:1:0` });
  });

  it("skips a business with nothing due, as every business without a pack is, and falls back to the local dashboard link", async () => {
    vi.stubEnv("APP_BASE_URL", undefined);
    vi.mocked(expireBusinessPacks).mockResolvedValue({ expired: 0, settled: 0, emails: 0, releaseAt: null });
    const { businessId, domain, run } = expirePacks();
    await expect(run).resolves.toEqual({ status: "skipped", entityId: `${businessId}:0:0:0` });
    expect(expireBusinessPacks).toHaveBeenCalledWith(domain, { businessId, appUrl: "http://localhost:3000" });
  });

  it("needs the business it runs for", async () => {
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.expirePacks", queue: "default", businessId: null, payload: {}, trace: {}, idempotencyKey: "pack-expiry", scheduled: false };
    await expect(handleJob(job, { domain: { db: undefined as never } })).rejects.toThrow("requires a business context");
    expect(expireBusinessPacks).not.toHaveBeenCalled();
  });
});
