import { describe, expect, it } from "vitest";

import { jobFailureLogLine } from "./jobFailureLog";

const businessId = "7b0f8a9e-4c1d-4e2a-9b3c-1d2e3f4a5b6c";

function failedJob(input: { attemptsMade: number; finishedOn?: number }) {
  return {
    id: "42",
    data: { jobId: "0c9d8e7f-6a5b-4c3d-8e1f-2a3b4c5d6e7f", type: "phoneNumber.provision" as const, queue: "critical" as const, businessId, payload: { claimId: "claim-1" }, trace: {}, idempotencyKey: "claim:claim-1", scheduled: false },
    opts: { attempts: 5 },
    ...input,
  };
}

describe("jobFailureLogLine", () => {
  it("names the job, the attempt and the reason on one JSON line", () => {
    const line = jobFailureLogLine("critical", failedJob({ attemptsMade: 1 }), new Error("TWILIO_SIP_TRUNK_SID is required to provision a phone number."));

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      event: "job.failed",
      queue: "critical",
      type: "phoneNumber.provision",
      jobId: "42",
      businessId,
      attempt: 1,
      willRetry: true,
      message: "phoneNumber.provision failed (attempt 1 of 5): TWILIO_SIP_TRUNK_SID is required to provision a phone number.",
    });
  });

  it("names the call a failed job worked on", () => {
    const job = { ...failedJob({ attemptsMade: 2 }), data: { ...failedJob({ attemptsMade: 2 }).data, type: "call.saveRecording" as const, queue: "default" as const, payload: { callId: "call_1", sessionId: "rtc_1", durationMs: 60_000 } } };
    expect(JSON.parse(jobFailureLogLine("default", job, new Error("Storage unavailable")))).toMatchObject({ type: "call.saveRecording", businessId, callId: "call_1", sessionId: "rtc_1", attempt: 2 });
  });

  it("says when BullMQ has stopped retrying", () => {
    expect(JSON.parse(jobFailureLogLine("critical", failedJob({ attemptsMade: 5, finishedOn: Date.now() }), new Error("boom")))).toMatchObject({ attempt: 5, willRetry: false });
  });

  it("redacts the reason", () => {
    expect(JSON.parse(jobFailureLogLine("critical", failedJob({ attemptsMade: 1 }), new Error("Could not text owner@example.com"))).message).toBe("phoneNumber.provision failed (attempt 1 of 5): Could not text [redacted-email]");
  });

  it("still logs a failure BullMQ reports without its job", () => {
    expect(JSON.parse(jobFailureLogLine("critical", undefined, new Error("stalled")))).toEqual({ event: "job.failed", queue: "critical", willRetry: false, message: "Job failed: stalled" });
  });
});
