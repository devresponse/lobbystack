import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ valid: vi.fn(), execute: vi.fn(), update: vi.fn(), report: vi.fn() }));
vi.mock("@lobbystack/db", () => ({}));
vi.mock("@lobbystack/domain", () => ({ updateNotificationDeliveryStatus: mocks.update, updateOperatorNotificationDeliveryStatus: mocks.update, updateSmsDeliveryStatus: mocks.update }));
vi.mock("@lobbystack/providers/twilio/webhookSecurity", () => ({ resolveTwilioWebhookUrl: (url: string) => url, validateTwilioSignature: mocks.valid }));
vi.mock("@/lib/api-helpers", () => ({ getAppDatabase: () => ({ db: { execute: mocks.execute } }) }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({}) }));
vi.mock("@/lib/error-reporting", () => ({ reportServerError: mocks.report }));
import { POST } from "./route";

const SID = `SM${"0123456789abcdef".repeat(2)}`;
const request = (fields: Record<string, string> = { MessageSid: SID, MessageStatus: "delivered" }) => new Request("https://admin.example.invalid/api/webhooks/twilio/status", { method: "POST", body: new URLSearchParams(fields) });
beforeEach(() => { vi.clearAllMocks(); mocks.valid.mockReturnValue(true); mocks.execute.mockResolvedValue({ rows: [{ business_id: "business" }] }); mocks.update.mockResolvedValue(undefined); });
it("acknowledges persisted statuses and rejects invalid signatures", async () => {
  expect((await POST(request())).status).toBe(200);
  expect(mocks.update).toHaveBeenCalledOnce();
  mocks.valid.mockReturnValue(false);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.update).toHaveBeenCalledOnce();
});
it("does not acknowledge database or durable update failures, and reports each with its error ID and message SID", async () => {
  const failure = new Error("private backend error");
  mocks.update.mockRejectedValue(failure);
  const response = await POST(request());
  expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("60");
  const text = await response.text();
  expect(text).not.toContain("private backend error");
  const { errorId } = JSON.parse(text) as { errorId: string };
  expect(response.headers.get("x-error-id")).toBe(errorId);
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "twilio.status", errorId, route: "/api/webhooks/twilio/status", messageSid: SID }));
  mocks.execute.mockRejectedValue(new Error("connection unavailable"));
  expect((await POST(request())).status).toBe(503);
});
it("answers 400 to a signed status the schema refuses, naming the fields refused", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const response = await POST(request({ MessageSid: SID, To: "+14165550100" }));
    expect(response.status).toBe(400);
    const { errorId } = await response.json() as { errorId: string };
    expect(response.headers.get("x-error-id")).toBe(errorId);
    const line = String(warn.mock.calls.find(([value]) => String(value).includes("ops.twilio.webhook_invalid"))?.[0]);
    expect(JSON.parse(line)).toMatchObject({ route: "/api/webhooks/twilio/status", errorId, fields: ["MessageStatus"], messageSid: SID });
    expect(line).not.toContain("+14165550100");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
