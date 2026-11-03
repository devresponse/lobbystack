import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobEnvelope } from "@lobbystack/contracts";
import { backfillReceptionistRecords } from "@lobbystack/domain";

vi.mock("@lobbystack/domain", async (importOriginal) => ({
  ...await importOriginal<typeof import("@lobbystack/domain")>(),
  backfillReceptionistRecords: vi.fn(),
}));

import { handleJob } from "./handlers";

const domain = { db: {} as never };

function job(businessId: string | null): JobEnvelope {
  return { jobId: randomUUID(), type: "receptionists.backfillRecords", queue: "maintenance", businessId, payload: {}, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: true, recurring: true };
}

const logLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("filling in the receptionist of old records", () => {
  it("fills the business's records and logs how many of each it filled", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const businessId = randomUUID();
    vi.mocked(backfillReceptionistRecords).mockResolvedValueOnce({ filled: { calls: 7_000, conversations: 12, inbox_items: 3 }, passes: 3, finished: true });
    await expect(handleJob(job(businessId), { domain })).resolves.toEqual({ status: "completed", entityId: "7015" });
    expect(backfillReceptionistRecords).toHaveBeenCalledWith(domain, { businessId });
    expect(logLines(info).find((line) => line.message === "receptionists.backfill")).toMatchObject({ businessId, calls: 7_000, conversations: 12, inbox_items: 3, passes: 3, finished: true });
  });

  it("skips quietly once nothing is left to fill", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.mocked(backfillReceptionistRecords).mockResolvedValueOnce({ filled: { calls: 0, conversations: 0, inbox_items: 0 }, passes: 1, finished: true });
    await expect(handleJob(job(randomUUID()), { domain })).resolves.toEqual({ status: "skipped", entityId: "0" });
    expect(logLines(info).some((line) => line.message === "receptionists.backfill")).toBe(false);
  });

  it("logs a run that stopped before the end, which the next run carries on", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.mocked(backfillReceptionistRecords).mockResolvedValueOnce({ filled: { calls: 1_000_000, conversations: 0, inbox_items: 0 }, passes: 200, finished: false });
    await expect(handleJob(job(randomUUID()), { domain })).resolves.toMatchObject({ status: "completed" });
    expect(logLines(info).find((line) => line.message === "receptionists.backfill")).toMatchObject({ passes: 200, finished: false });
  });

  it("needs a business", async () => {
    await expect(handleJob(job(null), { domain })).rejects.toThrow();
    expect(backfillReceptionistRecords).not.toHaveBeenCalled();
  });
});
