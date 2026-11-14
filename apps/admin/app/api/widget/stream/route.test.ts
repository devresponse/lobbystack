import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RealtimeListener } from "@/lib/realtime-hub";

const businessId = "00000000-0000-4000-8000-000000000001";
const visitorId = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003";
const otherConversationId = "00000000-0000-4000-8000-000000000004";

const mocks = vi.hoisted(() => ({
  listeners: [] as RealtimeListener[],
  unlisten: vi.fn(),
  configured: true,
  conversationId: null as string | null,
  rateAllowed: true,
  // While set, finding the visitor's chat waits for it, as a slow database would.
  lookup: null as Promise<void> | null,
}));

vi.mock("@/lib/widget-access", () => ({
  resolveWidgetSessionAccess: async () => ({ ok: true, session: { businessId, widgetKeyId: "key-1", visitorId } }),
}));
vi.mock("@/lib/widget-policy", () => ({
  enforceWidgetRateLimits: async () => (mocks.rateAllowed ? { allowed: true } : { allowed: false, status: 429, code: "widget_rate_limited" }),
}));
vi.mock("@/lib/widget-keys", () => ({ requestIpHash: () => "ip-hash" }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({}) }));
vi.mock("@lobbystack/domain", () => ({ findWidgetConversationId: async () => { await mocks.lookup; return mocks.conversationId; } }));
vi.mock("@/lib/widget-receptionist", () => ({ loadWidgetReceptionist: async () => ({ snapshot: null, receptionistId: undefined }) }));
vi.mock("@/lib/realtime-hub", () => ({
  realtimeConfigured: () => mocks.configured,
  listenToBusinessRealtime: async (_businessId: string, listener: RealtimeListener) => {
    mocks.listeners.push(listener);
    return mocks.unlisten;
  },
}));
vi.mock("@/lib/api-helpers", () => ({
  jsonError: (error: string, status: number, code?: string) => Response.json({ error, code }, { status }),
  asApiResponse: (error: unknown) => { throw error; },
}));

import { GET } from "./route";

function request(signal?: AbortSignal) {
  return new Request("http://localhost/api/widget/stream", { headers: { authorization: "Bearer token" }, ...(signal ? { signal } : {}) });
}

function realtime(type: string, fields: { entityId?: string; payload?: Record<string, unknown> } = {}) {
  return { id: crypto.randomUUID(), type, businessId, occurredAt: new Date().toISOString(), trace: {}, payload: {}, ...fields } as never;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  let text = "";
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text;
}

beforeEach(() => {
  mocks.listeners.length = 0;
  mocks.unlisten.mockClear();
  mocks.configured = true;
  mocks.conversationId = conversationId;
  mocks.rateAllowed = true;
  mocks.lookup = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("website chat live updates", () => {
  it("tells the widget about a team member's reply and a take-over in its own chat, and nothing else", async () => {
    const response = await GET(request());
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(await readUntil(reader, "event: ready")).toContain("event: ready");

    const listener = mocks.listeners[0]!;
    // The visitor's own message, the AI's reply and another visitor's chat stay quiet.
    listener.event(realtime("message.upserted", { entityId: crypto.randomUUID(), payload: { conversationId, direction: "inbound", aiGenerated: false } }));
    listener.event(realtime("message.upserted", { entityId: crypto.randomUUID(), payload: { conversationId, direction: "outbound", aiGenerated: true } }));
    listener.event(realtime("message.upserted", { entityId: crypto.randomUUID(), payload: { conversationId: otherConversationId, direction: "outbound", aiGenerated: false } }));
    listener.event(realtime("conversation.updated", { entityId: otherConversationId }));
    listener.event(realtime("call.updated", { entityId: conversationId }));
    // A team member's reply, then the take-over it caused.
    listener.event(realtime("message.upserted", { entityId: crypto.randomUUID(), payload: { conversationId, direction: "outbound", aiGenerated: false } }));
    listener.event(realtime("conversation.updated", { entityId: conversationId }));

    const text = await readUntil(reader, "event: conversation");
    expect(text).toBe("event: message\ndata: {}\n\nevent: conversation\ndata: {}\n\n");
    await reader.cancel();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("ends the stream when Redis drops, so the widget reconnects and reloads its history", async () => {
    const response = await GET(request());
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    mocks.listeners[0]!.reset();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("stops listening when the visitor leaves", async () => {
    const leave = new AbortController();
    const response = await GET(request(leave.signal));
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    leave.abort();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("closes a stream after ten minutes so the widget opens a fresh one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const response = await GET(request());
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const rest = await readUntil(reader, "never");
    expect(rest).toContain(": keepalive");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("ends each stream up to a minute before the ten minutes, so streams closed together don't all come back together", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const response = await GET(request());
    const reader = response.body!.getReader();
    await readUntil(reader, "event: ready");
    vi.mocked(Math.random).mockRestore();
    await vi.advanceTimersByTimeAsync(9 * 60_000 + 1_000);
    await readUntil(reader, "never");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("holds no more streams than its limit when a burst of them arrives at once", async () => {
    let finishLookups!: () => void;
    mocks.lookup = new Promise((resolve) => { finishLookups = resolve; });
    // A thousand streams are still looking up their chats when one more arrives.
    const opening = Array.from({ length: 1_000 }, () => GET(request()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const extra = await GET(request());
    expect(extra.status).toBe(503);
    finishLookups();
    const opened = await Promise.all(opening);
    expect(opened.every((response) => response.status === 200)).toBe(true);
    await Promise.all(opened.map((response) => response.body!.cancel()));
    // Closed streams give their places back.
    const reader = (await GET(request())).body!.getReader();
    expect(await readUntil(reader, "event: ready")).toContain("event: ready");
    await reader.cancel();
  });

  it("gives back the place of a request that found no chat or failed", async () => {
    mocks.conversationId = null;
    for (let index = 0; index < 1_001; index += 1) expect((await GET(request())).status).toBe(404);
    mocks.conversationId = conversationId;
    mocks.lookup = Promise.reject(new Error("database unavailable"));
    mocks.lookup.catch(() => undefined);
    for (let index = 0; index < 1_001; index += 1) await expect(GET(request())).rejects.toThrow("database unavailable");
    mocks.lookup = null;
    const reader = (await GET(request())).body!.getReader();
    expect(await readUntil(reader, "event: ready")).toContain("event: ready");
    await reader.cancel();
  });

  it("turns the widget away when there is no chat to follow, live updates are off, or it asks too often", async () => {
    mocks.conversationId = null;
    expect((await GET(request())).status).toBe(404);
    mocks.conversationId = conversationId;
    mocks.configured = false;
    expect((await GET(request())).status).toBe(503);
    mocks.configured = true;
    mocks.rateAllowed = false;
    expect((await GET(request())).status).toBe(429);
    expect(mocks.listeners).toHaveLength(0);
  });
});
