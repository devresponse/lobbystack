import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ valid: vi.fn(), execute: vi.fn(), inbound: vi.fn(), shared: vi.fn(), isShared: vi.fn(), report: vi.fn() }));
vi.mock("@lobbystack/db", () => ({}));
vi.mock("@lobbystack/domain", () => ({ receiveInboundSms: mocks.inbound, receiveSharedSenderSms: mocks.shared, isSharedSmsSender: mocks.isShared }));
vi.mock("@lobbystack/providers/twilio/webhookSecurity", () => ({ resolveTwilioWebhookUrl: (url: string) => url, validateTwilioSignature: mocks.valid }));
vi.mock("@/lib/api-helpers", () => ({ getAppDatabase: () => ({ db: { execute: mocks.execute } }) }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({}) }));
vi.mock("@/lib/error-reporting", () => ({ reportServerError: mocks.report }));
import { POST } from "./route";

const SHARED = "+18446562290";
const SID = `SM${"0123456789abcdef".repeat(2)}`;
const ENDPOINT = "https://admin.example.invalid/api/webhooks/twilio/sms";
const request = (fields: Record<string, string>) => new Request(ENDPOINT, { method: "POST", body: new URLSearchParams({ MessageSid: SID, From: "+14165550100", ...fields }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.valid.mockReturnValue(true);
  mocks.execute.mockResolvedValue({ rows: [{ business_id: null }] });
  mocks.isShared.mockImplementation((to: string) => to === SHARED);
  mocks.shared.mockResolvedValue({ reply: null, contactsChanged: 0 });
});

it("hands a text to the shared sender to the shared-sender handler and replies with its answer", async () => {
  mocks.shared.mockResolvedValue({ reply: "LobbyStack: Help & info <here>.", contactsChanged: 0 });
  const response = await POST(request({ To: SHARED, Body: "HELP", OptOutType: "HELP" }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Message>LobbyStack: Help &amp; info &lt;here&gt;.</Message></Response>");
  expect(mocks.shared).toHaveBeenCalledWith({}, { from: "+14165550100", body: "HELP", optOutType: "HELP" });
  expect(mocks.inbound).not.toHaveBeenCalled();
});

it("sends no reply to a STOP, and ignores a number no business owns that isn't the shared sender", async () => {
  expect(await (await POST(request({ To: SHARED, Body: "STOP" }))).text()).toBe("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  expect(mocks.shared).toHaveBeenCalledWith({}, { from: "+14165550100", body: "STOP" });
  mocks.shared.mockClear();
  expect((await POST(request({ To: "+14165550999", Body: "STOP" }))).status).toBe(200);
  expect(mocks.shared).not.toHaveBeenCalled();
  expect(mocks.inbound).not.toHaveBeenCalled();
});

it("keeps a business's own number on its conversation path", async () => {
  mocks.execute.mockResolvedValue({ rows: [{ business_id: "business" }] });
  await POST(request({ To: "+14165550123", Body: "Hi" }));
  expect(mocks.inbound).toHaveBeenCalledWith({}, expect.objectContaining({ businessId: "business", to: "+14165550123", body: "Hi" }));
  expect(mocks.shared).not.toHaveBeenCalled();
});

it("answers 503 with an error ID when the opt-out can't be saved, so the number's fallback tries again, and reports it by message SID", async () => {
  const failure = new Error("database unavailable");
  mocks.shared.mockRejectedValue(failure);
  const response = await POST(request({ To: SHARED, Body: "STOP" }));
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("60");
  const body = await response.json() as { ok: boolean; error: string; errorId: string };
  expect(body).toEqual({ ok: false, error: "Temporary webhook failure.", errorId: expect.any(String) });
  expect(response.headers.get("x-error-id")).toBe(body.errorId);
  // The report names the message, never the text or the phones.
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "twilio.sms", errorId: body.errorId, route: "/api/webhooks/twilio/sms", messageSid: SID }));
});

it("leaves out a message SID that doesn't look like one", async () => {
  const failure = new Error("database unavailable");
  mocks.shared.mockRejectedValue(failure);
  const response = await POST(request({ To: SHARED, Body: "STOP", MessageSid: "SM<not a sid>" }));
  const { errorId } = await response.json() as { errorId: string };
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "twilio.sms", errorId, route: "/api/webhooks/twilio/sms" }));
});

it("answers 400 to a signed text the schema refuses, naming the fields refused but never their values", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    // No To, so no business can be found: sending it again changes nothing.
    const response = await POST(new Request(ENDPOINT, { method: "POST", body: new URLSearchParams({ MessageSid: SID, From: "+14165550100", Body: "Hi, call me at +14165550177" }) }));
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string; errorId: string };
    expect(body).toEqual({ ok: false, error: "Invalid Twilio webhook.", errorId: expect.any(String) });
    expect(response.headers.get("x-error-id")).toBe(body.errorId);
    const lines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("ops.twilio.webhook_invalid"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", message: "ops.twilio.webhook_invalid", route: "/api/webhooks/twilio/sms", errorId: body.errorId, fields: ["To"], messageSid: SID });
    for (const secret of ["+14165550100", "+14165550177", "call me"]) expect(lines[0]).not.toContain(secret);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.inbound).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();

    // A text with no message SID at all can't be stored once.
    warn.mockClear();
    const noSid = await POST(new Request(ENDPOINT, { method: "POST", body: new URLSearchParams({ From: "+14165550100", To: SHARED, Body: "STOP" }) }));
    expect(noSid.status).toBe(400);
    const line = JSON.parse(String(warn.mock.calls.find(([value]) => String(value).includes("ops.twilio.webhook_invalid"))?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({ fields: ["MessageSid"] });
    expect(line).not.toHaveProperty("messageSid");
    expect(mocks.shared).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

it("refuses an unsigned request with no warning or report", async () => {
  mocks.valid.mockReturnValue(false);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect((await POST(new Request(ENDPOINT, { method: "POST", body: new URLSearchParams({ From: "x" }) }))).status).toBe(401);
    expect(warn).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
