import { APIError } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  rateLimit: vi.fn(),
  allowance: vi.fn(),
  snapshot: vi.fn(),
  startLiveWebCall: vi.fn(),
  finishLiveCall: vi.fn(),
  recordProspectDemoCallStarted: vi.fn(),
  recordProspectDemoCallError: vi.fn(),
  recordVoiceSnapshotLoaded: vi.fn(),
  attach: vi.fn(),
  create: vi.fn(),
  hangup: vi.fn(),
  openaiHangup: vi.fn(async () => undefined),
  sessionConfig: vi.fn((..._args: unknown[]) => ({ model: "gpt-live-1" })),
  recordedGreeting: vi.fn(async (..._args: unknown[]): Promise<{ text: string; play: boolean } | undefined> => undefined),
}));

vi.mock("@lobbystack/domain", () => ({
  finishLiveCall: mocks.finishLiveCall,
  recordAiTrace: vi.fn(async () => null),
  getWebVoiceBillingAllowance: mocks.allowance,
  recordProspectDemoCallError: mocks.recordProspectDemoCallError,
  recordProspectDemoCallStarted: mocks.recordProspectDemoCallStarted,
  recordVoiceSnapshotLoaded: mocks.recordVoiceSnapshotLoaded,
  startLiveWebCall: mocks.startLiveWebCall,
}));
vi.mock("@/lib/live-web-call", async (original) => ({ ...(await original<typeof import("@/lib/live-web-call")>()), resolveLiveWebCallAccess: mocks.access, liveSessionEndToken: (sessionId: string) => `token-for-${sessionId}` }));
vi.mock("@/lib/web-voice-policy", () => ({ enforceWebVoiceRateLimits: mocks.rateLimit }));
vi.mock("@/lib/business-snapshot", () => ({ loadValidBusinessSnapshot: mocks.snapshot }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({ db: {} }) }));
vi.mock("@/lib/live-prototype", () => ({
  requireLivePrototype: vi.fn(),
  attachWorkerToLiveSession: mocks.attach,
  endLiveBrowserSession: mocks.hangup,
  getLiveClient: () => ({ live: { create: mocks.create, sessions: { hangup: mocks.openaiHangup } } }),
}));
vi.mock("@lobbystack/agent-core/live/session", () => ({ buildBrowserSessionConfig: mocks.sessionConfig }));
vi.mock("@/lib/live-greeting", () => ({ recordedGreetingFor: mocks.recordedGreeting }));

import { POST } from "./route";

const snapshot = { businessId: "biz_1", greeting: "Hi", contactChannels: { phoneNumber: "+15815020392" } };

function start(widgetId: string, extra: Record<string, string> = {}) {
  return POST(new Request("https://admin.lobbystack.test/api/voice/live/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sdp: "v=0\r\n", widgetId, ...extra }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({ allowed: true });
  mocks.allowance.mockResolvedValue({ allowed: true });
  mocks.snapshot.mockResolvedValue(snapshot);
  mocks.create.mockResolvedValue({ session: { id: "live_1" }, transport: { sdp: "answer" } });
  mocks.startLiveWebCall.mockResolvedValue({ callId: "call_1", maxDurationMs: 120_000 });
  mocks.hangup.mockResolvedValue(undefined);
  mocks.finishLiveCall.mockResolvedValue(true);
  mocks.recordProspectDemoCallError.mockResolvedValue(undefined);
  mocks.recordProspectDemoCallStarted.mockResolvedValue(undefined);
  mocks.attach.mockResolvedValue(undefined);
  mocks.recordedGreeting.mockResolvedValue(undefined);
});

const widget = { businessId: "biz_1", origin: "https://client.example", widgetId: "lobbystack-widget", dashboardTestCall: false };

describe("POST /api/voice/live/session", () => {
  it("records a prospect demo call as intake-only and unbilled", async () => {
    mocks.access.mockResolvedValue({ businessId: "biz_1", origin: "https://admin.lobbystack.test", widgetId: "lobbystack-prospect-demo", prospectDemoId: "demo_1", dashboardTestCall: false });
    const response = await start("lobbystack-prospect-demo", { businessSlug: "acme", prospectDemoToken: "secret" });
    expect(response.status).toBe(201);
    expect(mocks.allowance).not.toHaveBeenCalled();
    expect(mocks.startLiveWebCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "live_1", billable: false, sessionPurpose: "prospect_demo", prospectDemoId: "demo_1" }));
    expect(mocks.recordProspectDemoCallStarted).toHaveBeenCalledWith(expect.anything(), { businessId: "biz_1", prospectDemoId: "demo_1", callId: "call_1", channel: "web_voice", provider: "openai_live" });
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "live_1", callId: "call_1", channel: "web_voice", intakeOnly: true, maxDurationMs: 120_000 }));
  });

  it("stops before creating a session when the plan is out of minutes", async () => {
    mocks.access.mockResolvedValue({ businessId: "biz_1", origin: "https://admin.lobbystack.test", widgetId: "lobbystack-dashboard-test-call", dashboardTestCall: true });
    mocks.allowance.mockResolvedValue({ allowed: false, errorCode: "voice_limit_reached" });
    const response = await start("lobbystack-dashboard-test-call");
    expect(response.status).toBe(402);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps rate-limited callers away from the database", async () => {
    mocks.access.mockResolvedValue({ businessId: "biz_1", origin: "https://client.example", widgetId: "lobbystack-widget", dashboardTestCall: false });
    mocks.rateLimit.mockResolvedValue({ allowed: false, status: 429, code: "web_voice_rate_limited" });
    const response = await start("lobbystack-widget");
    expect(response.status).toBe(429);
    expect(mocks.allowance).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("logs which count refused a call, and keeps it from the browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue(widget);
    mocks.rateLimit.mockResolvedValue({ allowed: false, status: 429, code: "web_voice_rate_limited", reason: "rate_limit_ip_day" });
    const response = await start("lobbystack-widget");
    const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ message: "live.browser_refused", businessId: "biz_1", widgetId: "lobbystack-widget", status: 429, code: "web_voice_rate_limited", reason: "rate_limit_ip_day" }));
    await expect(response.json()).resolves.toEqual({ code: "web_voice_rate_limited", error: "The call couldn't start." });
    warn.mockRestore();
  });

  it("logs every other refusal with the code the browser got", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue(widget);
    mocks.snapshot.mockResolvedValue({ ...snapshot, contactChannels: {} });
    const response = await start("lobbystack-widget");
    expect(response.status).toBe(403);
    const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ message: "live.browser_refused", businessId: "biz_1", status: 403, code: "voice_unavailable" }));
    warn.mockRestore();
  });

  it("closes the session and records OpenAI's setup charge when the worker can't take it", async () => {
    mocks.access.mockResolvedValue({ businessId: "biz_1", origin: "https://admin.lobbystack.test", widgetId: "lobbystack-prospect-demo", prospectDemoId: "demo_1", dashboardTestCall: false });
    mocks.attach.mockRejectedValue(new Error("Worker attach failed with status 500."));
    const response = await start("lobbystack-prospect-demo", { businessSlug: "acme", prospectDemoToken: "secret" });
    expect(response.status).toBe(500);
    expect(mocks.hangup).toHaveBeenCalledWith("live_1");
    expect(mocks.openaiHangup).not.toHaveBeenCalled();
    // OpenAI bills 15 seconds for creating the WebRTC session; the caller heard nothing.
    expect(mocks.finishLiveCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call_1", seconds: 15, measuredSeconds: 0, end: "setup_failed", channel: "web_voice" }));
    expect(mocks.recordProspectDemoCallError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prospectDemoId: "demo_1", callId: "call_1", reason: "web_call_start_failed" }));
  });

  it("reports a failed start with the call's IDs", async () => {
    for (const key of ["POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "POSTHOG_API_KEY"]) vi.stubEnv(key, undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue({ businessId: "biz_1", origin: "https://admin.lobbystack.test", widgetId: "lobbystack-dashboard-test-call", dashboardTestCall: true });
    mocks.attach.mockRejectedValue(new Error("Worker attach failed with status 500."));
    const response = await start("lobbystack-dashboard-test-call");
    expect(response.status).toBe(500);
    const lines = () => error.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    await vi.waitFor(() => expect(lines()).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/^\[admin\] exception: /), operation: "api_response", errorId: response.headers.get("x-error-id"), businessId: "biz_1", sessionId: "live_1", callId: "call_1" })));
    error.mockRestore();
    vi.unstubAllEnvs();
  });

  // A 429 out of credit would otherwise read as our own call limit.
  it("reports OpenAI refusing the session, and answers 502 instead of OpenAI's status", async () => {
    for (const key of ["POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "POSTHOG_API_KEY"]) vi.stubEnv(key, undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue(widget);
    mocks.create.mockRejectedValue(APIError.generate(429, { error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } }, undefined, new Headers()));
    const response = await start("lobbystack-widget");
    expect(response.status).toBe(502);
    expect(mocks.startLiveWebCall).not.toHaveBeenCalled();
    const lines = () => error.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    await vi.waitFor(() => expect(lines()).toContainEqual(expect.objectContaining({ message: "[admin] exception: OpenAI refused to create the live session (insufficient_quota): 429 You exceeded your current quota.", errorId: response.headers.get("x-error-id"), businessId: "biz_1" })));
    error.mockRestore();
    vi.unstubAllEnvs();
  });

  it("falls back to OpenAI's hangup when the worker can't close the session either", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue({ businessId: "biz_1", origin: "https://admin.lobbystack.test", widgetId: "lobbystack-prospect-demo", prospectDemoId: "demo_1", dashboardTestCall: false });
    mocks.attach.mockRejectedValue(new Error("Worker attach failed with status 500."));
    mocks.hangup.mockRejectedValue(new Error("Worker end failed with status 500."));
    const response = await start("lobbystack-prospect-demo", { businessSlug: "acme", prospectDemoToken: "secret" });
    expect(response.status).toBe(500);
    expect(mocks.openaiHangup).toHaveBeenCalledWith("live_1");
  });

  it("refuses widget voice for a business without a phone number", async () => {
    mocks.access.mockResolvedValue({ businessId: "biz_1", origin: "https://client.example", widgetId: "lobbystack-widget", dashboardTestCall: false });
    mocks.snapshot.mockResolvedValue({ ...snapshot, contactChannels: {} });
    const response = await start("lobbystack-widget");
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes the WebRTC offer to OpenAI unchanged", async () => {
    mocks.access.mockResolvedValue({ businessId: "biz_1", origin: "https://admin.lobbystack.test", widgetId: "lobbystack-dashboard-test-call", dashboardTestCall: true });
    await start("lobbystack-dashboard-test-call");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ transport: { type: "webrtc", sdp: "v=0\r\n" } }));
  });

  it("returns the end token only the starting browser gets", async () => {
    mocks.access.mockResolvedValue({ businessId: "biz_1", origin: "https://admin.lobbystack.test", widgetId: "lobbystack-dashboard-test-call", dashboardTestCall: true });
    const response = await start("lobbystack-dashboard-test-call");
    await expect(response.json()).resolves.toMatchObject({ sessionId: "live_1", endToken: "token-for-live_1", sdp: "answer" });
  });

  // GPT-Live hears the greeting as already said, and the worker plays its recording.
  it("opens the call with the greeting's recording once the worker has made one", async () => {
    mocks.access.mockResolvedValue(widget);
    mocks.recordedGreeting.mockResolvedValue({ text: "Hi", play: true });
    const response = await start("lobbystack-widget");
    expect(response.status).toBe(201);
    expect(mocks.recordedGreeting).toHaveBeenCalledWith(snapshot);
    expect(mocks.sessionConfig).toHaveBeenCalledWith(snapshot, { greetingRecorded: true });
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ recordedGreeting: { text: "Hi", play: true } }));
    // GPT-Live writes no transcript for the recording, so the browser's captions get its words here.
    await expect(response.json()).resolves.toMatchObject({ sessionId: "live_1", greeting: "Hi" });
  });

  it("opens the call as before when LIVE_RECORDED_GREETING is off or the recording isn't made yet", async () => {
    mocks.access.mockResolvedValue(widget);
    const off = await start("lobbystack-widget");
    expect(mocks.sessionConfig).toHaveBeenLastCalledWith(snapshot, { greetingRecorded: false });
    expect(mocks.attach.mock.lastCall![0]).not.toHaveProperty("recordedGreeting");
    expect(await off.json()).not.toHaveProperty("greeting");
    // The worker records it for the next call.
    mocks.recordedGreeting.mockResolvedValue({ text: "Hi", play: false });
    const unrecorded = await start("lobbystack-widget");
    expect(mocks.sessionConfig).toHaveBeenLastCalledWith(snapshot, { greetingRecorded: false });
    expect(mocks.attach).toHaveBeenLastCalledWith(expect.objectContaining({ recordedGreeting: { text: "Hi", play: false } }));
    // GPT-Live says the greeting itself, so its own transcript captions it.
    expect(await unrecorded.json()).not.toHaveProperty("greeting");
  });

  // The Server-Timing header only reaches the caller's browser.
  it("logs how long each stage of the start took", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue(widget);
    mocks.recordedGreeting.mockResolvedValue({ text: "Hi", play: true });
    const response = await start("lobbystack-widget");
    const lines = info.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    const stage = expect.any(Number);
    expect(lines).toContainEqual(expect.objectContaining({ message: "live.browser_start", businessId: "biz_1", sessionId: "live_1", callId: "call_1", widgetId: "lobbystack-widget", accessMs: stage, checksMs: stage, greetingMs: stage, openaiMs: stage, recordMs: stage, attachMs: stage, greetingRecording: true }));
    expect(response.headers.get("server-timing")).toMatch(/^access;dur=[\d.]+, checks;dur=[\d.]+, greeting;dur=[\d.]+, openai;dur=[\d.]+, record;dur=[\d.]+, attach;dur=[\d.]+$/);
    info.mockRestore();
  });

  it("rejects unknown callers", async () => {
    const response = await start("somebody-else");
    expect(response.status).toBe(400);
    expect(mocks.access).not.toHaveBeenCalled();
  });
});
