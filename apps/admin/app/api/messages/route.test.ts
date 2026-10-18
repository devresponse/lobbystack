import { beforeEach, describe, expect, it, vi } from "vitest";

const businessId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const newerConversationId = "00000000-0000-4000-8000-000000000003";

const mocks = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  setAutomationState: vi.fn(),
  findNewerWidgetChatInTransaction: vi.fn(),
  loadSmsReachInTransaction: vi.fn(),
  /** What the thread query returns, newest first as the database does. */
  rows: [] as Array<Record<string, unknown>>,
}));

/** A transaction whose select chain ends with the thread's rows. */
function threadTransaction() {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "innerJoin", "leftJoin", "where", "orderBy"]) chain[method] = () => chain;
  chain.limit = async () => mocks.rows;
  return chain;
}

vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireApiSession: async () => ({ user: { id: "user_1" } }),
  withOperatorTransaction: async (_request: Request, callback: (input: { session: unknown; businessId: string; tx: unknown }) => Promise<unknown>) => await callback({ session: { user: { id: "user_1" } }, businessId, tx: threadTransaction() }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", () => ({ appendMessage: mocks.appendMessage, setAutomationState: mocks.setAutomationState, findNewerWidgetChatInTransaction: mocks.findNewerWidgetChatInTransaction, loadSmsReachInTransaction: mocks.loadSmsReachInTransaction }));

import { GET, PATCH, POST } from "./route";

const closedChat = Object.assign(new Error("This website chat is closed, so the visitor won't see a reply here. They started a new chat: reply there."), { status: 409, code: "chat_closed" });

function request(method: "POST" | "PATCH", body: Record<string, unknown>): Request {
  return new Request(`http://localhost/api/messages?businessId=${businessId}`, { method, body: JSON.stringify(body) });
}

function row(overrides: Record<string, unknown>) {
  return { id: "m1", conversationId, contactName: null, contactPhone: null, visitorName: "Ada", visitorEmail: null, channel: "web_chat", conversationStatus: "open", automationState: "ai_active", teamRequestedAt: null, messageChannel: "web_chat", body: "Hi", direction: "inbound", status: "received", providerStatus: null, createdAt: new Date("2026-10-14T21:00:00.000Z"), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.loadSmsReachInTransaction.mockResolvedValue({ ok: true, to: "+14165550134", from: "+14375550100" });
});

describe("POST /api/messages", () => {
  it("refuses a reply in a website chat that closed, saying the visitor started a new one", async () => {
    mocks.appendMessage.mockRejectedValue(closedChat);

    const response = await POST(request("POST", { conversationId, body: "Yes, from 10 to 4.", channel: "web_chat" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: closedChat.message, code: "chat_closed" });
    expect(mocks.appendMessage).toHaveBeenCalledWith({ db: "app" }, { businessId, conversationId, body: "Yes, from 10 to 4.", direction: "outbound", channel: "web_chat", userId: "user_1" });
  });

  it("refuses a text that can't reach the contact, saying why", async () => {
    const noConsent = Object.assign(new Error("This contact hasn't texted you or agreed to texts, so you can't text them."), { status: 409, code: "sms_no_consent" });
    mocks.appendMessage.mockRejectedValue(noConsent);

    const response = await POST(request("POST", { conversationId, body: "We can see you Friday at 3.", channel: "sms" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: noConsent.message, code: "sms_no_consent" });
  });
});

describe("PATCH /api/messages", () => {
  it("refuses taking over a website chat that closed", async () => {
    mocks.setAutomationState.mockRejectedValue(closedChat);

    const response = await PATCH(request("PATCH", { conversationId, automationState: "human_handoff" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "chat_closed" });
    expect(mocks.setAutomationState).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId, conversationId, state: "human_handoff" });
  });
});

describe("GET /api/messages?conversationId=", () => {
  it("shows a website chat's status, and points from a closed one to the visitor's newer chat", async () => {
    mocks.rows = [row({ conversationStatus: "closed" })];
    mocks.findNewerWidgetChatInTransaction.mockResolvedValue(newerConversationId);

    const response = await GET(new Request(`http://localhost/api/messages?conversationId=${conversationId}`));

    expect(await response.json()).toEqual({ messages: [expect.objectContaining({ conversationStatus: "closed" })], newerConversationId, smsReplyHold: null });
    expect(mocks.findNewerWidgetChatInTransaction).toHaveBeenCalledWith(expect.anything(), { businessId, conversationId });
    expect(mocks.loadSmsReachInTransaction).not.toHaveBeenCalled();
  });

  it("shows why a text never went out, and why a reply can't be texted now", async () => {
    const voice = { channel: "voice", conversationStatus: "closed", visitorName: null, contactPhone: "+14165550134" };
    mocks.rows = [
      row({ ...voice, id: "m3", messageChannel: "sms", direction: "outbound", status: "failed", providerStatus: "failed", body: "Are you free at 4?" }),
      row({ ...voice, id: "m2", messageChannel: "sms", direction: "outbound", status: "failed", providerStatus: "held:opted_out", body: "We can see you Friday at 3." }),
      row({ ...voice, id: "m1", messageChannel: "dashboard", body: "Please call me back about Friday." }),
    ];
    mocks.loadSmsReachInTransaction.mockResolvedValue({ ok: false, reason: "opted_out" });

    const response = await GET(new Request(`http://localhost/api/messages?conversationId=${conversationId}`));
    const body = await response.json() as { messages: Array<Record<string, unknown>>; smsReplyHold: string | null };

    expect(body.messages.map(({ id, status, failureReason }) => ({ id, status, failureReason }))).toEqual([
      { id: "m1", status: "received", failureReason: null },
      { id: "m2", status: "failed", failureReason: "opted_out" },
      // The carrier failed this one: its status is all there is to say.
      { id: "m3", status: "failed", failureReason: null },
    ]);
    expect(body.messages[1]).not.toHaveProperty("providerStatus");
    expect(body.smsReplyHold).toBe("opted_out");
    expect(mocks.loadSmsReachInTransaction).toHaveBeenCalledWith(expect.anything(), { businessId, conversationId });
  });

  it("looks for no newer chat while a chat is open, or for a conversation that isn't a website chat", async () => {
    for (const thread of [row({}), row({ channel: "voice", conversationStatus: "closed" })]) {
      mocks.rows = [thread];
      const response = await GET(new Request(`http://localhost/api/messages?conversationId=${conversationId}`));
      expect(await response.json()).toMatchObject({ newerConversationId: null, smsReplyHold: null });
    }
    expect(mocks.findNewerWidgetChatInTransaction).not.toHaveBeenCalled();
  });
});
