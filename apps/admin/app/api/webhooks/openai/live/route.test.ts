import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const mocks = vi.hoisted(() => ({ unwrap: vi.fn(), reject: vi.fn(), accept: vi.fn(), hangup: vi.fn(), execute: vi.fn(), snapshot: vi.fn(), startLivePhoneCall: vi.fn(), finishLiveCall: vi.fn(), attach: vi.fn(), sessionConfig: vi.fn((..._args: unknown[]) => ({ model: "gpt-live-1", instructions: "Answer calls." })), recordedGreeting: vi.fn() }));

vi.mock("@lobbystack/agent-core/live/session", () => ({ buildPhoneSessionConfig: mocks.sessionConfig }));
// The cut of the business's snapshot for one receptionist is the domain's own.
vi.mock("@lobbystack/domain", async () => ({
  finishLiveCall: mocks.finishLiveCall,
  getCachedBusinessSnapshot: mocks.snapshot,
  recordAiTrace: vi.fn(async () => null),
  snapshotForReceptionist: (await import("../../../../../../../packages/domain/src/snapshot")).snapshotForReceptionist,
  startLivePhoneCall: mocks.startLivePhoneCall,
}));
vi.mock("@/lib/api-helpers", () => ({ getAppDatabase: () => ({ db: { execute: mocks.execute } }) }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({}) }));
vi.mock("@/lib/live-greeting", () => ({ recordedGreetingFor: mocks.recordedGreeting }));
vi.mock("@/lib/live-prototype", () => ({
  attachWorkerToLiveSession: mocks.attach,
  getLiveClient: () => ({ webhooks: { unwrap: mocks.unwrap }, live: { sessions: { reject: mocks.reject, accept: mocks.accept, hangup: mocks.hangup } } }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
  // Error reports go no further than the log.
  for (const key of ["POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "POSTHOG_API_KEY"]) vi.stubEnv(key, undefined);
  mocks.reject.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue({ rows: [{ business_id: null, position: 1 }] });
  // No recording plays unless a test says otherwise.
  mocks.recordedGreeting.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// The admin's `live.incoming` lines. A line waits for the work after the response, such as the worker's attach.
function incomingLines(info: MockInstance<typeof console.info>): Record<string, unknown>[] {
  return info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((line) => line.message === "live.incoming");
}

describe("POST /api/webhooks/openai/live", () => {
  it("leaves a call to an unknown number for the other deployment, without logging the caller's number", async () => {
    const warn = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.unwrap.mockResolvedValue({
      type: "live.transport.incoming",
      data: {
        session_id: "live_1",
        sip_headers: [
          { name: "To", value: "<sip:proj_1@sip.api.openai.com>" },
          { name: "Diversion", value: "<sip:+15815550100@example.com>" },
          { name: "From", value: "\"Sam Lee\" <sip:+14165550134@example.com>" },
        ],
      },
    });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("+15815550100");
    expect(logged).not.toContain("4165550134");
    expect(logged).not.toContain("Sam Lee");
  });

  it("turns away a call to a canceled business's number, which is still this deployment's", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: null, closed: true, position: 1 }] });
    mocks.unwrap.mockResolvedValue({
      type: "live.transport.incoming",
      data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "From", value: "<sip:+14165550134@example.com>" }] },
    });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.reject).toHaveBeenCalledWith("live_1", { status_code: 404 });
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.startLivePhoneCall).not.toHaveBeenCalled();
    expect(new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]![0] as SQL).sql).toContain("app.is_closed_business_phone(phone)");
    expect(info.mock.calls.flat().join(" ")).toContain("live.incoming_closed_business");
  });

  it("answers a forwarded call for an open business even when an earlier number belonged to a canceled one", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ business_id: null, closed: true, position: 1 }, { business_id: "biz_1", closed: false, position: 2 }] });
    mocks.snapshot.mockResolvedValue(null);
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false, maxDurationMs: 500_000 });
    mocks.unwrap.mockResolvedValue({
      type: "live.transport.incoming",
      data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "Diversion", value: "<sip:+15815550122@example.com>" }] },
    });

    await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    // It reaches the business, and fails there only for want of a snapshot: never the 404 a canceled number gets.
    expect(mocks.reject).not.toHaveBeenCalledWith("live_1", { status_code: 404 });
    expect(mocks.snapshot).toHaveBeenCalled();
  });

  it("finishes answering a retried call without touching its record", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: true, blocked: false, maxDurationMs: 500_000 });
    // The first delivery already accepted it, so accepting again fails.
    mocks.accept.mockRejectedValue(new Error("already accepted"));
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({
      type: "live.transport.incoming",
      data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "From", value: "<sip:+14165550134@example.com>" }] },
    });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    // It keeps the limit the first delivery reserved, and the worker continues the saved transcript.
    await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "live_1", callId: "call_1", channel: "voice", maxDurationMs: 500_000, resume: true })));
    expect(mocks.finishLiveCall).not.toHaveBeenCalled();
  });

  // The first delivery may already be playing it, and a call under way gets no greeting.
  it("doesn't open a retried delivery's call with the recording", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.recordedGreeting.mockResolvedValue({ text: "Hi", play: true });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: true, blocked: false });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(mocks.sessionConfig).toHaveBeenCalledWith({ businessId: "biz_1", greeting: "Hi" });
    await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    expect(mocks.attach.mock.calls[0]![0]).not.toHaveProperty("recordedGreeting");
  });

  // OpenAI's guide recommends a recording for predictable greeting playback.
  it("opens a call with the recording of its opening once the worker has made one", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const snapshot = { businessId: "biz_1", greeting: "Hi" };
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue(snapshot);
    mocks.recordedGreeting.mockResolvedValue({ text: "Hi. You're speaking with an AI assistant.", play: true });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(mocks.recordedGreeting).toHaveBeenCalledWith(snapshot, { phone: true });
    // The session starts with the opening as already said, and the worker plays it.
    expect(mocks.sessionConfig).toHaveBeenCalledWith(snapshot, { greetingRecorded: true });
    await vi.waitFor(() => expect(incomingLines(info)).toEqual([expect.objectContaining({ greetingRecording: true })]));
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ callId: "call_1", recordedGreeting: { text: "Hi. You're speaking with an AI assistant.", play: true } }));
  });

  it("opens a call as before until the recording is made, and has the worker make it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.recordedGreeting.mockResolvedValue({ text: "Hi", play: false });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(mocks.sessionConfig).toHaveBeenCalledWith(expect.anything(), { greetingRecorded: false });
    await vi.waitFor(() => expect(incomingLines(info)).toEqual([expect.objectContaining({ greetingRecording: false })]));
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ recordedGreeting: { text: "Hi", play: false } }));
  });

  it("opens a call as before when the recording check fails or the setting is off", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    mocks.recordedGreeting.mockRejectedValueOnce(new Error("Connection is closed."));
    const failed = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));
    await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(failed.status).toBe(200);
    expect(mocks.sessionConfig.mock.calls).toEqual([[expect.anything(), { greetingRecorded: false }], [expect.anything(), { greetingRecorded: false }]]);
    await vi.waitFor(() => expect(incomingLines(info)).toHaveLength(2));
    expect(incomingLines(info).map((line) => line.greetingRecording)).toEqual([undefined, undefined]);
    expect(mocks.attach).toHaveBeenCalledTimes(2);
    for (const [attached] of mocks.attach.mock.calls) expect(attached).not.toHaveProperty("recordedGreeting");
  });

  it("accepts a call, hands it to the worker, and logs how long each step took", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", created_at: Math.floor(Date.now() / 1000), data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.accept).toHaveBeenCalledWith("live_1", expect.anything());
    await vi.waitFor(() => expect(incomingLines(info)).toEqual([expect.objectContaining({ level: "info", sessionId: "live_1", businessId: "biz_1", callId: "call_1", eventAgeMs: expect.any(Number), lookupMs: expect.any(Number), recordMs: expect.any(Number), acceptMs: expect.any(Number), attachMs: expect.any(Number) })]));
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "live_1", callId: "call_1", channel: "voice" }));
    // A first delivery's attach isn't a resume, so the worker reads nothing extra.
    expect(mocks.attach.mock.calls[0]![0]).not.toHaveProperty("resume");
    expect(incomingLines(info)[0]).not.toHaveProperty("decisionAlreadyMade");
  });

  // OpenAI delivers the webhook again when it isn't answered within a few seconds.
  it("answers the webhook once the call is accepted, without waiting for the worker", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.accept.mockResolvedValue(undefined);
    // The worker answers once it has loaded the business.
    let workerAnswers!: () => void;
    mocks.attach.mockReturnValueOnce(new Promise<void>((resolve) => { workerAnswers = resolve; }));
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.accept).toHaveBeenCalledWith("live_1", expect.anything());
    await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    // The line waits for the attach, so that it has the attach's time too.
    expect(incomingLines(info)).toEqual([]);
    workerAnswers();
    await vi.waitFor(() => expect(incomingLines(info)).toEqual([expect.objectContaining({ acceptMs: expect.any(Number), attachMs: expect.any(Number) })]));
    expect(mocks.finishLiveCall).not.toHaveBeenCalled();
  });

  it("answers a retried delivery without waiting for the worker", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: true, blocked: false });
    mocks.accept.mockRejectedValue(new Error("already accepted"));
    let workerAnswers!: () => void;
    mocks.attach.mockReturnValueOnce(new Promise<void>((resolve) => { workerAnswers = resolve; }));
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ resume: true })));
    workerAnswers();
  });

  it("leaves the call to a retried delivery whose accept came first", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.recordedGreeting.mockResolvedValue({ text: "Hi", play: true });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false, maxDurationMs: 300_000 });
    // OpenAI keeps the first decision on a call, here the retried delivery's accept.
    mocks.accept.mockRejectedValue(Object.assign(new Error("409 The call already has a decision."), { status: 409, code: "decision_already_made" }));
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    // The call goes on, so its record stays open for the worker to finish.
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.finishLiveCall).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(incomingLines(info)).toEqual([expect.objectContaining({ callId: "call_1", decisionAlreadyMade: true, greetingRecording: false })]));
    // The retried delivery opened the call with the greeting command, so the worker attaches as it would for that delivery.
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "live_1", callId: "call_1", maxDurationMs: 300_000, resume: true }));
    expect(mocks.attach.mock.calls[0]![0]).not.toHaveProperty("recordedGreeting");
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects a call it couldn't accept for another reason, and closes its record", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.accept.mockRejectedValue(Object.assign(new Error("500 The server had an error."), { status: 500 }));
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.finishLiveCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call_1", seconds: 0, end: "setup_failed" }));
    expect(mocks.reject).toHaveBeenCalledWith("live_1", { status_code: 503 });
    expect(mocks.attach).not.toHaveBeenCalled();
    const reported = error.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(reported).toEqual([expect.objectContaining({ operation: "live.incoming", callId: "call_1", error: "500 The server had an error." })]);
  });

  it("saves Twilio's call SID from the INVITE and tags the call's logs with it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "X-Twilio-CallSid", value: "CA0123456789abcdef0123456789abcdef" }] } });

    await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(mocks.startLivePhoneCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "live_1", twilioCallSid: "CA0123456789abcdef0123456789abcdef" }));
    await vi.waitFor(() => expect(incomingLines(info)).toEqual([expect.objectContaining({ sessionId: "live_1", twilioCallSid: "CA0123456789abcdef0123456789abcdef", callId: "call_1" })]));
  });

  it("ignores a Twilio call SID header that isn't a call SID", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "x-twilio-callsid", value: "+14165550134" }] } });

    await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(mocks.startLivePhoneCall.mock.calls[0]![1]).not.toHaveProperty("twilioCallSid");
  });

  it("reports a call the worker couldn't take with the call's IDs, and hangs up", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockRejectedValue(new Error("worker unavailable"));
    mocks.hangup.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(mocks.hangup).toHaveBeenCalledWith("live_1");
    expect(mocks.finishLiveCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call_1", end: "setup_failed" }));
    const reported = error.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(reported).toEqual([expect.objectContaining({ level: "error", message: "[admin] exception: worker unavailable", operation: "live.incoming", sessionId: "live_1", businessId: "biz_1", callId: "call_1", error: "worker unavailable" })]);
  });

  it("routes a forwarded call by the first candidate number that belongs to a business", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    // The business's old line is the first Diversion and isn't one of our numbers.
    mocks.execute.mockResolvedValue({ rows: [{ business_id: null, position: 1 }, { business_id: null, position: 2 }, { business_id: "biz_1", position: 3 }, { business_id: "biz_2", position: 4 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false, maxDurationMs: 1_800_000 });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({
      type: "live.transport.incoming",
      data: {
        session_id: "live_1",
        sip_headers: [
          { name: "To", value: "<sip:proj_1@sip.api.openai.com>" },
          { name: "P-Called-Party-ID", value: "<sip:+15815550122@example.com>" },
          { name: "Diversion", value: "<sip:+14185550199@carrier.example>;reason=unconditional" },
          { name: "Diversion", value: "<sip:+14185550111@carrier.example>;reason=unconditional, <sip:+15815550100@twilio.example>" },
          { name: "From", value: "<sip:+14165550134@example.com>" },
        ],
      },
    });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    // One lookup, with every Diversion entry in order, then To, then P-Called-Party-ID.
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]![0] as SQL).params).toEqual(["+14185550199", "+14185550111", "+15815550100", "+15815550122"]);
    expect(mocks.startLivePhoneCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ businessId: "biz_1", to: "+15815550100", from: "+14165550134" }));
    await vi.waitFor(() => expect(incomingLines(info)).toEqual([expect.objectContaining({ routedBy: "Diversion" })]));
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ callerPhone: "+14165550134", maxDurationMs: 1_800_000 }));
  });

  it("records a withheld caller ID without a number and without a limit on an unlimited plan", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue({ businessId: "biz_1", greeting: "Hi" });
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false, maxDurationMs: undefined });
    mocks.accept.mockResolvedValue(undefined);
    mocks.attach.mockResolvedValue(undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "From", value: "\"Anonymous\" <sip:anonymous@anonymous.invalid>" }] } });

    await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(mocks.startLivePhoneCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ from: undefined }));
    await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    const attached = mocks.attach.mock.calls[0]![0] as Record<string, unknown>;
    expect(attached).not.toHaveProperty("callerPhone");
    expect(attached).not.toHaveProperty("maxDurationMs");
  });

  it("rejects a call to a business with no published snapshot and closes its record", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockResolvedValue(null);
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", created_at: Math.floor(Date.now() / 1000), data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(200);
    expect(mocks.reject).toHaveBeenCalledWith("live_1", { status_code: 503 });
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.finishLiveCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call_1", end: "setup_failed" }));
  });

  it("leaves an already answered call alone when a retried delivery can't load the snapshot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", position: 1 }] });
    mocks.snapshot.mockRejectedValue(new Error("cache unavailable"));
    mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: true, blocked: false });
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", created_at: Math.floor(Date.now() / 1000), data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });

    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    expect(response.status).toBe(503);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.finishLiveCall).not.toHaveBeenCalled();
  });

  it("leaves the call alone when the number lookup fails", async () => {
    mocks.execute.mockRejectedValue(new Error("connection terminated"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });
    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));
    expect(response.status).toBe(503);
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  describe("a number a receptionist answers", () => {
    const frontDeskId = "00000000-0000-4000-8000-0000000000a1";
    const kitsilanoId = "00000000-0000-4000-8000-0000000000a2";
    const receptionist = (id: string, overrides: Record<string, unknown> = {}) => ({
      id, name: id === frontDeskId ? "Front desk" : "Kitsilano", description: id === frontDeskId ? "Everything about the shop." : "The Kitsilano store.",
      isDefault: id === frontDeskId, status: "active", listed: true, order: id === frontDeskId ? 0 : 1, knowledgeScope: "all",
      greeting: id === frontDeskId ? "Hi, the shop." : "Hi, Kitsilano store.", voiceInstructions: "", smsInstructions: "", chatInstructions: "",
      bookingPolicy: "", bookingMode: "direct", transferPolicy: { mode: "never" }, snippetIds: [], ...overrides,
    });
    const stored = (kitsilano: Record<string, unknown> = {}) => ({ businessId: "biz_1", greeting: "Hi, the shop.", knowledgeSnippets: [], receptionists: [receptionist(frontDeskId), receptionist(kitsilanoId, kitsilano)] });
    const ring = () => POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));

    beforeEach(() => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      mocks.startLivePhoneCall.mockResolvedValue({ callId: "call_1", conversationId: "conv_1", duplicate: false, blocked: false });
      mocks.accept.mockResolvedValue(undefined);
      mocks.attach.mockResolvedValue(undefined);
      mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }] } });
    });

    it("looks up the receptionist with the business, in the same query", async () => {
      mocks.execute.mockResolvedValue({ rows: [{ business_id: null, position: 1 }] });
      await ring();
      expect(mocks.execute).toHaveBeenCalledTimes(1);
      expect(new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]![0] as SQL).sql).toContain("app.resolve_receptionist_by_phone(phone) as receptionist_id");
    });

    it("answers as the number's receptionist, and the call's record and the worker name it", async () => {
      mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", receptionist_id: kitsilanoId, position: 1 }] });
      mocks.snapshot.mockResolvedValue(stored());
      await ring();
      expect(mocks.startLivePhoneCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ businessId: "biz_1", receptionistId: kitsilanoId }));
      expect(mocks.sessionConfig).toHaveBeenCalledWith(expect.objectContaining({ greeting: "Hi, Kitsilano store.", receptionist: { id: kitsilanoId, name: "Kitsilano", description: "The Kitsilano store.", isDefault: false } }), expect.anything());
      // The session gets the receptionist's view, never the list of every receptionist's settings.
      expect(mocks.sessionConfig.mock.calls[0]![0]).not.toHaveProperty("receptionists");
      expect(mocks.recordedGreeting).toHaveBeenCalledWith(expect.objectContaining({ greeting: "Hi, Kitsilano store." }), { phone: true });
      await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ callId: "call_1", receptionistId: kitsilanoId })));
    });

    it("answers as the default receptionist when the snapshot has the number's one paused", async () => {
      // The lookup already gives the default for a paused receptionist; a snapshot a moment older may not know yet.
      mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", receptionist_id: kitsilanoId, position: 1 }] });
      mocks.snapshot.mockResolvedValue(stored({ status: "paused" }));
      await ring();
      expect(mocks.sessionConfig).toHaveBeenCalledWith(expect.objectContaining({ greeting: "Hi, the shop.", receptionist: expect.objectContaining({ id: frontDeskId, isDefault: true }) }), expect.anything());
      // The call's record names the receptionist the caller hears, as the worker does.
      expect(mocks.startLivePhoneCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ receptionistId: frontDeskId }));
      // The worker answers as the receptionist the caller hears.
      await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ receptionistId: frontDeskId })));
    });

    it("answers a number from before receptionists as the default one", async () => {
      mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", receptionist_id: null, position: 1 }] });
      mocks.snapshot.mockResolvedValue(stored());
      await ring();
      // The record names the default receptionist, which the database would give it anyway.
      expect(mocks.startLivePhoneCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ receptionistId: frontDeskId }));
      expect(mocks.sessionConfig).toHaveBeenCalledWith(expect.objectContaining({ greeting: "Hi, the shop.", receptionist: expect.objectContaining({ id: frontDeskId }) }), expect.anything());
      await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ receptionistId: frontDeskId })));
    });

    it("answers with the business's snapshot as it is when it has no receptionists yet", async () => {
      // A snapshot published by the release before.
      const legacy = { businessId: "biz_1", greeting: "Hi" };
      mocks.execute.mockResolvedValue({ rows: [{ business_id: "biz_1", receptionist_id: kitsilanoId, position: 1 }] });
      mocks.snapshot.mockResolvedValue(legacy);
      await ring();
      expect(mocks.sessionConfig).toHaveBeenCalledWith(legacy, expect.anything());
      expect(mocks.startLivePhoneCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ receptionistId: kitsilanoId }));
      // The worker still learns which receptionist the number has, for the call's record.
      await vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ receptionistId: kitsilanoId })));
    });

    it("leaves the receptionist of a canceled business's earlier number out", async () => {
      mocks.execute.mockResolvedValue({ rows: [{ business_id: null, receptionist_id: null, closed: true, position: 1 }, { business_id: "biz_1", receptionist_id: kitsilanoId, closed: false, position: 2 }] });
      mocks.snapshot.mockResolvedValue(stored());
      mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "Diversion", value: "<sip:+15815550100@example.com>" }, { name: "Diversion", value: "<sip:+15815550122@example.com>" }] } });
      await ring();
      expect(mocks.startLivePhoneCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: "+15815550122", receptionistId: kitsilanoId }));
    });
  });

  it("rejects a call with no dialled number", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.unwrap.mockResolvedValue({ type: "live.transport.incoming", data: { session_id: "live_1", sip_headers: [{ name: "To", value: "<sip:proj_1@sip.api.openai.com>" }] } });
    const response = await POST(new Request("https://admin.lobbystack.test/api/webhooks/openai/live", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect(mocks.reject).toHaveBeenCalledWith("live_1", { status_code: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
