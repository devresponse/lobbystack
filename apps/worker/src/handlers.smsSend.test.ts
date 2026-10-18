import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobEnvelope } from "@lobbystack/contracts";
import { claimSmsDelivery, loadSmsDeliveryTarget, markSmsFailed, markSmsSent, releaseSmsDelivery } from "@lobbystack/domain";

vi.mock("@lobbystack/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lobbystack/domain")>()),
  claimSmsDelivery: vi.fn(),
  loadSmsDeliveryTarget: vi.fn(),
  markSmsFailed: vi.fn(),
  markSmsSent: vi.fn(),
  releaseSmsDelivery: vi.fn(),
}));

import { handleJob } from "./handlers";

afterEach(() => {
  vi.clearAllMocks();
});

const domain = { db: undefined as never };

function sendJob(businessId: string, messageId: string): JobEnvelope {
  return { jobId: randomUUID(), type: "sms.send", queue: "critical", businessId, payload: { messageId }, trace: {}, idempotencyKey: randomUUID(), scheduled: false };
}

describe("sms.send", () => {
  it("fails a text the contact can't get now, with the reason, instead of leaving it queued", async () => {
    const businessId = randomUUID();
    const messageId = randomUUID();
    const twilio = { sendSms: vi.fn() };
    vi.mocked(claimSmsDelivery).mockResolvedValue(true);
    vi.mocked(loadSmsDeliveryTarget).mockResolvedValue({ ok: false, reason: "opted_out" });

    await expect(handleJob(sendJob(businessId, messageId), { domain, twilio })).resolves.toEqual({ status: "skipped", entityId: messageId });

    expect(markSmsFailed).toHaveBeenCalledWith(domain, { businessId, messageId, failure: { held: "opted_out" } });
    expect(twilio.sendSms).not.toHaveBeenCalled();
    expect(releaseSmsDelivery).not.toHaveBeenCalled();
  });

  it("fails a text Twilio refuses on every attempt, and retries any other failure", async () => {
    const businessId = randomUUID();
    const messageId = randomUUID();
    const twilio = { sendSms: vi.fn().mockRejectedValueOnce(Object.assign(new Error("Attempt to send to unsubscribed recipient"), { code: 21610, status: 400 })).mockRejectedValueOnce(new Error("socket hang up")) };
    vi.mocked(claimSmsDelivery).mockResolvedValue(true);
    vi.mocked(loadSmsDeliveryTarget).mockResolvedValue({ ok: true, to: "+14165550134", from: "+14375550100", body: "We're open 9 to 5." });

    await expect(handleJob(sendJob(businessId, messageId), { domain, twilio })).resolves.toEqual({ status: "skipped", entityId: messageId });
    expect(markSmsFailed).toHaveBeenCalledWith(domain, { businessId, messageId, failure: { rejected: 21610 } });
    expect(releaseSmsDelivery).not.toHaveBeenCalled();

    await expect(handleJob(sendJob(businessId, messageId), { domain, twilio })).rejects.toThrow("socket hang up");
    expect(releaseSmsDelivery).toHaveBeenCalledWith(domain, { businessId, messageId });
    expect(markSmsFailed).toHaveBeenCalledTimes(1);
    expect(markSmsSent).not.toHaveBeenCalled();
  });

  it("fails a text after its last try when Twilio keeps refusing it for another reason, but never one that went out", async () => {
    const businessId = randomUUID();
    const messageId = randomUUID();
    const tooLong = Object.assign(new Error("The concatenated message body exceeds the 1600 character limit"), { code: 21617, status: 400 });
    const twilio = { sendSms: vi.fn().mockRejectedValueOnce(tooLong).mockRejectedValueOnce(tooLong).mockResolvedValueOnce({ providerMessageId: "SM123" }) };
    vi.mocked(claimSmsDelivery).mockResolvedValue(true);
    vi.mocked(loadSmsDeliveryTarget).mockResolvedValue({ ok: true, to: "+14165550134", from: "+14375550100", body: "We're open 9 to 5." });

    await expect(handleJob(sendJob(businessId, messageId), { domain, twilio }, { isFinalAttempt: false })).rejects.toThrow("1600 character limit");
    expect(releaseSmsDelivery).toHaveBeenCalledTimes(1);
    expect(markSmsFailed).not.toHaveBeenCalled();

    await expect(handleJob(sendJob(businessId, messageId), { domain, twilio }, { isFinalAttempt: true })).rejects.toThrow("1600 character limit");
    expect(markSmsFailed).toHaveBeenCalledWith(domain, { businessId, messageId, failure: { unsent: 21617 } });
    expect(releaseSmsDelivery).toHaveBeenCalledTimes(1);

    // Twilio took it but saving that failed: it's released as before, not failed.
    vi.mocked(markSmsSent).mockRejectedValueOnce(new Error("connection terminated"));
    await expect(handleJob(sendJob(businessId, messageId), { domain, twilio }, { isFinalAttempt: true })).rejects.toThrow("connection terminated");
    expect(markSmsFailed).toHaveBeenCalledTimes(1);
    expect(releaseSmsDelivery).toHaveBeenCalledTimes(2);
  });

  it("sends a text that can go out", async () => {
    const businessId = randomUUID();
    const messageId = randomUUID();
    const twilio = { sendSms: vi.fn().mockResolvedValue({ providerMessageId: "SM123" }) };
    vi.mocked(claimSmsDelivery).mockResolvedValue(true);
    vi.mocked(loadSmsDeliveryTarget).mockResolvedValue({ ok: true, to: "+14165550134", from: "+14375550100", body: "We're open 9 to 5." });

    await expect(handleJob(sendJob(businessId, messageId), { domain, twilio })).resolves.toEqual({ status: "completed", entityId: messageId });

    expect(twilio.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: "+14165550134", from: "+14375550100", body: "We're open 9 to 5." }));
    expect(markSmsSent).toHaveBeenCalledWith(domain, { businessId, messageId, providerMessageId: "SM123" });
    expect(markSmsFailed).not.toHaveBeenCalled();
  });
});
