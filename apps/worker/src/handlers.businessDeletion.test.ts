import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobEnvelope, JobType } from "@lobbystack/contracts";
import { claimBillingSubscription, isBusinessDeleted, recordDeletedBusinessPlanEnded, releaseBillingSubscription } from "@lobbystack/domain";
import { PolarRequestError, type PolarSubscription } from "@lobbystack/providers/polar/polarBilling";
import { reportWarning } from "@lobbystack/telemetry/node";

vi.mock("@lobbystack/domain", async (importOriginal) => ({
  ...await importOriginal<typeof import("@lobbystack/domain")>(),
  claimBillingSubscription: vi.fn(),
  releaseBillingSubscription: vi.fn(),
  isBusinessDeleted: vi.fn(),
  recordDeletedBusinessPlanEnded: vi.fn(),
  recordProductEvent: vi.fn(),
}));
vi.mock("@lobbystack/telemetry/node", async (importOriginal) => ({ ...await importOriginal<typeof import("@lobbystack/telemetry/node")>(), reportWarning: vi.fn() }));

import { handleJob, type WorkerDependencies } from "./handlers";

const domain = { db: {} as never };

beforeEach(() => {
  vi.mocked(claimBillingSubscription).mockResolvedValue({ claimId: "subscription-claim" });
  vi.mocked(isBusinessDeleted).mockResolvedValue(true);
  vi.mocked(recordDeletedBusinessPlanEnded).mockResolvedValue(true);
});
afterEach(() => { vi.clearAllMocks(); });

function job(type: JobType, payload: Record<string, unknown>, businessId: string | null = null): JobEnvelope {
  return { jobId: randomUUID(), type, queue: "maintenance", businessId, payload, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
}

function subscription(overrides: Partial<PolarSubscription>): PolarSubscription {
  return { id: "sub_1", status: "active", productId: "product_pro", cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null, discountId: null, currentPeriodEnd: "2026-11-30T00:00:00Z", ...overrides };
}

const warnings = () => vi.mocked(reportWarning).mock.calls.map(([error]) => (error as Error).message);

describe("ending a deleted business's paid plan", () => {
  function polar(after: PolarSubscription | null, revoke = vi.fn(async () => undefined)) {
    return { recordUsage: vi.fn(), revokeSubscription: revoke, getSubscription: vi.fn(async () => after) } satisfies WorkerDependencies["polar"];
  }

  it("ends the subscription in Polar now and records it, so the delete can go ahead", async () => {
    const businessId = randomUUID();
    const provider = polar(subscription({ status: "canceled", endedAt: "2026-10-30T08:00:00Z" }));
    expect(await handleJob(job("billing.revokeSubscription", { subscriptionId: "sub_1" }, businessId), { domain, polar: provider })).toEqual({ status: "completed", entityId: businessId });
    expect(provider.revokeSubscription).toHaveBeenCalledWith("sub_1");
    expect(recordDeletedBusinessPlanEnded).toHaveBeenCalledWith(domain, { businessId, subscriptionId: "sub_1" });
    expect(releaseBillingSubscription).toHaveBeenCalledWith(domain, { businessId, claimId: "subscription-claim" });
  });

  it("counts a subscription Polar has set to end with its period as ended, since nothing renews it", async () => {
    const businessId = randomUUID();
    const provider = polar(subscription({ cancelAtPeriodEnd: true }));
    expect(await handleJob(job("billing.revokeSubscription", { subscriptionId: "sub_1" }, businessId), { domain, polar: provider })).toMatchObject({ status: "completed" });
    expect(recordDeletedBusinessPlanEnded).toHaveBeenCalledTimes(1);
  });

  it("counts a subscription Polar no longer has as ended", async () => {
    const businessId = randomUUID();
    expect(await handleJob(job("billing.revokeSubscription", { subscriptionId: "sub_1" }, businessId), { domain, polar: polar(null) })).toMatchObject({ status: "completed" });
    expect(recordDeletedBusinessPlanEnded).toHaveBeenCalledTimes(1);
  });

  it("fails the try, recording nothing, while Polar still shows the plan live", async () => {
    const businessId = randomUUID();
    await expect(handleJob(job("billing.revokeSubscription", { subscriptionId: "sub_1" }, businessId), { domain, polar: polar(subscription({ status: "past_due" })) })).rejects.toThrow("Polar still shows the subscription live after ending it.");
    expect(recordDeletedBusinessPlanEnded).not.toHaveBeenCalled();
    expect(releaseBillingSubscription).toHaveBeenCalledWith(domain, { businessId, claimId: "subscription-claim" });
  });

  it("waits while a plan change holds the subscription", async () => {
    const retryAt = new Date("2026-10-30T08:10:00Z");
    vi.mocked(claimBillingSubscription).mockResolvedValueOnce({ retryAt });
    const provider = polar(null);
    expect(await handleJob(job("billing.revokeSubscription", { subscriptionId: "sub_1" }, randomUUID()), { domain, polar: provider })).toMatchObject({ status: "deferred", retryAt });
    expect(provider.revokeSubscription).not.toHaveBeenCalled();
    expect(recordDeletedBusinessPlanEnded).not.toHaveBeenCalled();
  });

  it("tells the operator, and stops trying, when the worker's token can't end plans", async () => {
    const businessId = randomUUID();
    const provider = polar(null, vi.fn(async () => { throw new PolarRequestError(403, "insufficient_scope"); }));
    expect(await handleJob(job("billing.revokeSubscription", { subscriptionId: "sub_1" }, businessId), { domain, polar: provider })).toMatchObject({ status: "skipped" });
    expect(warnings()).toEqual([expect.stringContaining("needs subscriptions:write")]);
    expect(recordDeletedBusinessPlanEnded).not.toHaveBeenCalled();
    expect(releaseBillingSubscription).toHaveBeenCalledTimes(1);
  });

  it("tries again after any other failure", async () => {
    const provider = polar(null, vi.fn(async () => { throw new PolarRequestError(502, null); }));
    await expect(handleJob(job("billing.revokeSubscription", { subscriptionId: "sub_1" }, randomUUID()), { domain, polar: provider })).rejects.toMatchObject({ status: 502 });
    expect(recordDeletedBusinessPlanEnded).not.toHaveBeenCalled();
    expect(releaseBillingSubscription).toHaveBeenCalledTimes(1);
  });

  it("tells the operator when the worker has no Polar token to end the plan with", async () => {
    expect(await handleJob(job("billing.revokeSubscription", { subscriptionId: "sub_1" }, randomUUID()), { domain })).toMatchObject({ status: "skipped" });
    expect(warnings()).toEqual([expect.stringContaining("Set POLAR_ACCESS_TOKEN and POLAR_ORGANIZATION_ID on the worker")]);
    expect(claimBillingSubscription).not.toHaveBeenCalled();
  });

  it("skips a job that names no subscription", async () => {
    const provider = polar(null);
    expect(await handleJob(job("billing.revokeSubscription", {}, randomUUID()), { domain, polar: provider })).toMatchObject({ status: "skipped" });
    expect(provider.revokeSubscription).not.toHaveBeenCalled();
  });
});

describe("releasing a deleted business's phone number", () => {
  const twilio = (release = vi.fn(async () => undefined)) => ({ sendSms: vi.fn(), releasePhoneNumber: release });

  it("gives the number back to Twilio once its business is gone", async () => {
    const businessId = randomUUID();
    const provider = twilio();
    expect(await handleJob(job("phoneNumber.releaseDeleted", { businessId, providerPhoneId: "PN1" }), { domain, twilio: provider as never })).toEqual({ status: "completed", entityId: "PN1" });
    expect(isBusinessDeleted).toHaveBeenCalledWith(domain, businessId);
    expect(provider.releasePhoneNumber).toHaveBeenCalledWith({ providerPhoneId: "PN1" });
  });

  it("leaves the number alone while its business still exists, as for a job made up to release a live business's number", async () => {
    vi.mocked(isBusinessDeleted).mockResolvedValueOnce(false);
    const provider = twilio();
    expect(await handleJob(job("phoneNumber.releaseDeleted", { businessId: randomUUID(), providerPhoneId: "PN1" }), { domain, twilio: provider as never })).toMatchObject({ status: "skipped" });
    expect(provider.releasePhoneNumber).not.toHaveBeenCalled();
  });

  it.each([{ status: 404 }, { code: 20404 }])("counts a number Twilio no longer has as released (%o)", async (refusal) => {
    const provider = twilio(vi.fn(async () => { throw Object.assign(new Error("Not found"), refusal); }));
    expect(await handleJob(job("phoneNumber.releaseDeleted", { businessId: randomUUID(), providerPhoneId: "PN1" }), { domain, twilio: provider as never })).toMatchObject({ status: "skipped" });
    expect(reportWarning).not.toHaveBeenCalled();
  });

  it("tries a failed release again, and tells the operator on the last try", async () => {
    const provider = twilio(vi.fn(async () => { throw new Error("Twilio timed out"); }));
    const release = () => job("phoneNumber.releaseDeleted", { businessId: randomUUID(), providerPhoneId: "PN1" });
    await expect(handleJob(release(), { domain, twilio: provider as never })).rejects.toThrow("Twilio timed out");
    expect(reportWarning).not.toHaveBeenCalled();
    await expect(handleJob(release(), { domain, twilio: provider as never }, { isFinalAttempt: true })).rejects.toThrow("Twilio timed out");
    expect(warnings()).toEqual([expect.stringContaining("(PN1) couldn't be released. Release it in Twilio's console.")]);
  });

  it("fails while Twilio isn't configured, so the number isn't forgotten", async () => {
    await expect(handleJob(job("phoneNumber.releaseDeleted", { businessId: randomUUID(), providerPhoneId: "PN1" }), { domain })).rejects.toThrow("Twilio phone-number release is not configured.");
  });

  it("skips a job missing its business or its number", async () => {
    const provider = twilio();
    expect(await handleJob(job("phoneNumber.releaseDeleted", { providerPhoneId: "PN1" }), { domain, twilio: provider as never })).toMatchObject({ status: "skipped" });
    expect(await handleJob(job("phoneNumber.releaseDeleted", { businessId: randomUUID() }), { domain, twilio: provider as never })).toMatchObject({ status: "skipped" });
    expect(isBusinessDeleted).not.toHaveBeenCalled();
    expect(provider.releasePhoneNumber).not.toHaveBeenCalled();
  });
});

describe("deleting a deleted business's stored files", () => {
  const storage = (deleteObject = vi.fn<(input: { key: string }) => Promise<void>>(async () => undefined)) => ({ deleteObject });

  it("deletes each of the business's files", async () => {
    const businessId = randomUUID();
    const provider = storage();
    const keys = [`${businessId}/recordings/call-1.wav`, `${businessId}/documents/menu.pdf`];
    expect(await handleJob(job("privacy.deleteStoredObjects", { businessId, objectKeys: keys }), { domain, storage: provider as never })).toEqual({ status: "completed", entityId: `${businessId}:2` });
    expect(provider.deleteObject.mock.calls).toEqual([[{ key: keys[0] }], [{ key: keys[1] }]]);
    expect(isBusinessDeleted).toHaveBeenCalledWith(domain, businessId);
  });

  it("deletes only keys in the business's own folder, and says it skipped the rest", async () => {
    const businessId = randomUUID();
    const other = randomUUID();
    const provider = storage();
    await handleJob(job("privacy.deleteStoredObjects", { businessId, objectKeys: [`${businessId}/uploads/logo.png`, `${other}/uploads/logo.png`, `${businessId}-copy/uploads/logo.png`, 42] }), { domain, storage: provider as never });
    expect(provider.deleteObject.mock.calls).toEqual([[{ key: `${businessId}/uploads/logo.png` }]]);
    expect(warnings()).toEqual(["A deleted business's file cleanup skipped 2 keys outside its folder."]);
  });

  it("leaves the files alone while the business still exists", async () => {
    vi.mocked(isBusinessDeleted).mockResolvedValueOnce(false);
    const businessId = randomUUID();
    const provider = storage();
    expect(await handleJob(job("privacy.deleteStoredObjects", { businessId, objectKeys: [`${businessId}/recordings/call-1.wav`] }), { domain, storage: provider as never })).toMatchObject({ status: "skipped" });
    expect(provider.deleteObject).not.toHaveBeenCalled();
  });

  it("tries every file before failing the try, and tells the operator on the last one", async () => {
    const businessId = randomUUID();
    const provider = storage(vi.fn(async ({ key }: { key: string }) => { if (key.endsWith("call-1.wav")) throw new Error("Storage refused"); }));
    const cleanup = () => job("privacy.deleteStoredObjects", { businessId, objectKeys: [`${businessId}/recordings/call-1.wav`, `${businessId}/documents/menu.pdf`] });
    await expect(handleJob(cleanup(), { domain, storage: provider as never })).rejects.toThrow("Storage refused");
    expect(provider.deleteObject).toHaveBeenCalledTimes(2);
    expect(reportWarning).not.toHaveBeenCalled();
    await expect(handleJob(cleanup(), { domain, storage: provider as never }, { isFinalAttempt: true })).rejects.toThrow("Storage refused");
    expect(warnings()).toEqual(["1 of a deleted business's stored files couldn't be deleted."]);
  });

  it("fails while storage isn't configured, so the files aren't forgotten", async () => {
    const businessId = randomUUID();
    await expect(handleJob(job("privacy.deleteStoredObjects", { businessId, objectKeys: [`${businessId}/recordings/call-1.wav`] }), { domain })).rejects.toThrow("Storage is not configured.");
  });
});
