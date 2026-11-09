import { randomUUID } from "node:crypto";
import { claimBillingUsageSync, confirmBillingUsageSync, loadBillingUsageEvent, recordProductEvent } from "@lobbystack/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));

import { handleJob } from "../handlers";
import { brand, billingJob } from "./testing";
import { polarFake } from "./polarFake";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  brand.appBaseUrl = null;
});

describe("billing jobs: usage", () => {
  it("does not recreate usage work when Polar is not configured", async () => {
    const result = await handleJob(billingJob({ usageEventId: randomUUID() }), {
      domain: { db: undefined as never },
    });

    expect(result.status).toBe("skipped");
  });

  it("skips malformed usage jobs without touching the database", async () => {
    const result = await handleJob(billingJob({}), {
      domain: { db: undefined as never },
      billing: polarFake({ recordUsage: async () => undefined }),
    });

    expect(result.status).toBe("skipped");
  });

  it("never sends a managed enterprise plan's usage to Polar", async () => {
    const job = billingJob({ usageEventId: randomUUID() });
    vi.mocked(loadBillingUsageEvent).mockResolvedValue({ id: String(job.payload.usageEventId), sourceKey: "voice:call-1", isFinal: true, plan: "enterprise", businessId: job.businessId!, usageKind: "voice_seconds", quantity: 120, billableQuantity: null, billingIntervalAtRecordTime: null, createdAt: new Date("2026-01-01T00:00:00.000Z"), syncStatus: "pending", billingKey: "business-key", customerId: "polar-customer-id", periodStart: null, periodEnd: null });
    const recordUsage = vi.fn();

    expect(await handleJob(job, { domain: { db: undefined as never }, billing: polarFake({ recordUsage }) })).toEqual({ status: "skipped", entityId: String(job.payload.usageEventId) });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("sends a usage row to Polar as numbered events, a correction as its difference", async () => {
    const job = billingJob({ usageEventId: randomUUID() });
    const domain = { db: undefined as never };
    vi.mocked(loadBillingUsageEvent).mockResolvedValue({
      id: String(job.payload.usageEventId),
      sourceKey: "alert_sms:operator_notification:delivery-1",
      isFinal: true,
      plan: "starter",
      businessId: job.businessId!,
      usageKind: "alert_sms_segments",
      quantity: 2,
      billableQuantity: null,
      billingIntervalAtRecordTime: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      syncStatus: "pending",
      billingKey: "business-key",
      customerId: "polar-customer-id",
      periodStart: null,
      periodEnd: null,
    });
    vi.mocked(claimBillingUsageSync).mockResolvedValue({ externalId: "alert_sms:operator_notification:delivery-1", quantity: 2, seq: 0, rateCents: null, sentAt: new Date(), expired: false });
    vi.mocked(confirmBillingUsageSync).mockResolvedValue(true);
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const usage = { businessId: job.businessId, usageEventId: String(job.payload.usageEventId) };

    const result = await handleJob(job, { domain, billing: polarFake({ recordUsage }) });

    expect(result).toEqual({ status: "completed", entityId: String(job.payload.usageEventId) });
    expect(claimBillingUsageSync).toHaveBeenCalledWith(domain, usage);
    expect(recordUsage).toHaveBeenCalledWith({
      eventName: "billing.alert_sms_segments",
      externalCustomerId: "business-key",
      quantity: 2,
      timestamp: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "alert_sms:operator_notification:delivery-1",
      businessId: job.businessId,
      usageKind: "alert_sms_segments",
    });
    expect(confirmBillingUsageSync).toHaveBeenCalledWith(domain, { ...usage, seq: 0 });

    // A correction after Polar took the first event: one segment fewer, under the row's next number.
    vi.mocked(claimBillingUsageSync).mockResolvedValue({ externalId: "alert_sms:operator_notification:delivery-1:2", quantity: -1, seq: 2, rateCents: null, sentAt: new Date(), expired: false });
    await handleJob(job, { domain, billing: polarFake({ recordUsage }) });
    expect(recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: -1, idempotencyKey: "alert_sms:operator_notification:delivery-1:2", timestamp: "2026-01-01T00:00:00.000Z" }));
    expect(confirmBillingUsageSync).toHaveBeenLastCalledWith(domain, { ...usage, seq: 2 });

    const event = vi.mocked(loadBillingUsageEvent).mock.results[0]!.value;
    const original = await event;
    vi.mocked(loadBillingUsageEvent).mockResolvedValue({ ...original!, usageKind: "voice_seconds", quantity: 180, billableQuantity: 30, billingIntervalAtRecordTime: "annual" });
    vi.mocked(claimBillingUsageSync).mockResolvedValue({ externalId: "voice:call-1", quantity: 30, seq: 0, rateCents: null, sentAt: new Date(), expired: false });
    await handleJob(job, { domain, billing: polarFake({ recordUsage }) });
    expect(recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({ eventName: "billing.voice_minutes", quantity: 0.5, externalCustomerId: "business-key" }));

    // Nothing left to send, as when a correction came back to what Polar has.
    recordUsage.mockClear();
    vi.mocked(confirmBillingUsageSync).mockClear();
    vi.mocked(claimBillingUsageSync).mockResolvedValue(null);
    expect(await handleJob(job, { domain, billing: polarFake({ recordUsage }) })).toEqual({ status: "completed", entityId: String(job.payload.usageEventId) });
    expect(recordUsage).not.toHaveBeenCalled();
    expect(confirmBillingUsageSync).not.toHaveBeenCalled();

    for (const change of [{ isFinal: false }, { customerId: null }, { syncStatus: "skipped" }, { plan: "free_cloud" }]) {
      vi.mocked(claimBillingUsageSync).mockClear();
      vi.mocked(loadBillingUsageEvent).mockResolvedValue({ ...original!, ...change });
      expect((await handleJob(job, { domain, billing: polarFake({ recordUsage }) })).status).toBe("skipped");
      expect(claimBillingUsageSync).not.toHaveBeenCalled();
      expect(recordUsage).not.toHaveBeenCalled();
    }
  });

  it("emits ops.billing.usage_sync_failed without fabricating a recovery event", async () => {
    const job = billingJob({ usageEventId: randomUUID() });
    const domain = { db: undefined as never };
    vi.mocked(loadBillingUsageEvent).mockResolvedValue({
      id: String(job.payload.usageEventId),
      sourceKey: "voice:call_1",
      isFinal: true,
      plan: "starter",
      businessId: job.businessId!,
      usageKind: "voice_seconds",
      quantity: 120,
      billableQuantity: null,
      billingIntervalAtRecordTime: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      syncStatus: "pending",
      billingKey: "business-key",
      customerId: "polar-customer-id",
      periodStart: null,
      periodEnd: null,
    });
    vi.mocked(claimBillingUsageSync).mockResolvedValue({ externalId: "voice:call_1", quantity: 120, seq: 0, rateCents: null, sentAt: new Date(), expired: false });
    const error = new Error("polar unavailable");
    const recordUsage = vi.fn().mockRejectedValue(error);

    await expect(handleJob(job, { domain, billing: polarFake({ recordUsage }) })).rejects.toThrow(error);

    expect(recordProductEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: "ops.billing.usage_sync_failed",
      businessId: job.businessId,
      properties: { provider: "polar" },
    }));
    expect(recordProductEvent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "ops.billing.usage_sync_recovered" }));
    expect(confirmBillingUsageSync).not.toHaveBeenCalled();
  });
});
