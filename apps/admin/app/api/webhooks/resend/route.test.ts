import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ verify: vi.fn(), execute: vi.fn(), dispatcher: vi.fn(), business: vi.fn(), enqueue: vi.fn(), report: vi.fn() }));
vi.mock("@lobbystack/db", () => ({ enqueueOutbox: mocks.enqueue, providerEvents: { id: "id" }, withBusinessTransaction: mocks.business, withDispatcherTransaction: mocks.dispatcher }));
vi.mock("@lobbystack/providers", () => ({ verifyResendWebhookSignature: mocks.verify }));
vi.mock("@/lib/api-helpers", () => ({
  getAppDatabase: () => ({ db: { execute: mocks.execute } }),
  getDispatcherDatabase: () => ({ db: {} }),
  getWorkerDatabase: () => ({ db: {} }),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));
vi.mock("@/lib/error-reporting", () => ({ reportServerError: mocks.report }));
import { POST } from "./route";

const ENDPOINT = "https://admin.example.invalid/api/webhooks/resend";
const event = { type: "email.bounced", created_at: "2026-11-15T04:00:00.000Z", data: { to: ["jane@example.com"], subject: "Your appointment", reason: "mailbox full" } };
const request = (body: string) => new Request(ENDPOINT, { method: "POST", body, headers: { "svix-id": "msg_1", "svix-timestamp": "1763179200", "svix-signature": "v1,fixture" } });
/** A transaction whose provider_events insert stores the row. */
const tx = { insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: "event-1" }] }) }) }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_fixture");
  mocks.verify.mockReturnValue(true);
  mocks.dispatcher.mockImplementation(async (_db: unknown, persist: (value: typeof tx) => Promise<boolean>) => await persist(tx));
});
afterEach(() => vi.unstubAllEnvs());

function warnings(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("ops.resend.webhook_invalid")).map((line) => JSON.parse(line) as Record<string, unknown>);
}

it("stores a signed event and refuses an unsigned one", async () => {
  const stored = await POST(request(JSON.stringify(event)));
  expect(stored.status).toBe(200);
  expect(await stored.json()).toEqual({ accepted: true, duplicate: false, eventId: "msg_1" });
  mocks.verify.mockReturnValue(false);
  expect((await POST(request(JSON.stringify(event)))).status).toBe(401);
  expect(mocks.dispatcher).toHaveBeenCalledOnce();
});

it("answers 400 with an error ID to a signed delivery that isn't JSON or that the schema refuses, naming only the fields", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const notJson = await POST(request("jane@example.com bounced"));
    expect(notJson.status).toBe(400);
    const body = await notJson.json() as { error: string; errorId: string };
    expect(body).toEqual({ error: "Invalid Resend webhook.", errorId: expect.any(String) });
    expect(notJson.headers.get("x-error-id")).toBe(body.errorId);
    expect(warnings(warn)).toEqual([expect.objectContaining({ level: "warn", route: "/api/webhooks/resend", errorId: body.errorId, fields: ["(payload)"], webhookId: "msg_1" })]);

    warn.mockClear();
    const noData = await POST(request(JSON.stringify({ type: "email.bounced", subject: "Your appointment", to: "jane@example.com" })));
    expect(noData.status).toBe(400);
    expect(warnings(warn)).toEqual([expect.objectContaining({ fields: ["data"] })]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/jane@example\.com|Your appointment/);
    expect(mocks.dispatcher).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

it("answers 500 with an error ID when the event can't be stored, and reports it by svix-id", async () => {
  const failure = new Error("connection unavailable");
  mocks.dispatcher.mockRejectedValue(failure);
  const response = await POST(request(JSON.stringify(event)));
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).not.toContain("connection unavailable");
  const { errorId } = JSON.parse(text) as { errorId: string };
  expect(response.headers.get("x-error-id")).toBe(errorId);
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "resend.webhook", errorId, route: "/api/webhooks/resend", eventType: "email.bounced", webhookId: "msg_1" }));
});
