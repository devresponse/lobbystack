import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessContextSnapshot } from "@lobbystack/shared";

const mocks = vi.hoisted(() => ({
  readJson: vi.fn(),
  recordAiTrace: vi.fn(async (..._args: unknown[]) => null),
  resolveWidgetSessionAccess: vi.fn(),
  enforceWidgetRateLimits: vi.fn(),
  requestIpHash: vi.fn(),
  registerWidgetVisitor: vi.fn(),
  getOrCreateWidgetConversation: vi.fn(),
  returnQuietTeamChat: vi.fn(),
  announceLateWidgetReply: vi.fn(),
  appendMessage: vi.fn(),
  queueOperatorAlert: vi.fn(),
  getCachedBusinessSnapshot: vi.fn(),
  loadWidgetChatHistory: vi.fn(),
  recordAiGenerationEvent: vi.fn(),
  withBusinessTransaction: vi.fn(),
  reserveWidgetChatUsageInTransaction: vi.fn(),
  getWorkerDatabase: vi.fn(),
  createAgentModel: vi.fn(),
  createReceptionistAgent: vi.fn(),
  reportServerError: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("@lobbystack/domain", () => ({
  announceLateWidgetReply: mocks.announceLateWidgetReply,
  recordAiTrace: mocks.recordAiTrace,
  appendMessage: mocks.appendMessage,
  getOrCreateWidgetConversation: mocks.getOrCreateWidgetConversation,
  getCachedBusinessSnapshot: mocks.getCachedBusinessSnapshot,
  loadWidgetChatHistory: mocks.loadWidgetChatHistory,
  recordAiGenerationEvent: mocks.recordAiGenerationEvent,
  registerWidgetVisitor: mocks.registerWidgetVisitor,
  reserveWidgetChatUsageInTransaction: mocks.reserveWidgetChatUsageInTransaction,
  returnQuietTeamChat: mocks.returnQuietTeamChat,
  queueOperatorAlert: mocks.queueOperatorAlert,
}));

vi.mock("@lobbystack/db", () => ({
  withBusinessTransaction: mocks.withBusinessTransaction,
}));

vi.mock("@lobbystack/agent-core/model", () => ({
  createAgentModel: mocks.createAgentModel,
  describeAgentUsage: (raw: { inputTokens?: number; outputTokens?: number } | undefined, latencyMs: number) => ({ provider: "test", model: "test", latencyMs, ...raw }),
}));

vi.mock("@lobbystack/agent-core/agent", () => ({
  createReceptionistAgent: mocks.createReceptionistAgent,
  receptionistInstructions: () => "Chat instructions",
  toAiTraceSteps: (steps: unknown[]) => steps,
}));

function agentStreaming(textStream: AsyncIterable<string>, finishReason = "stop") {
  return { stream: vi.fn().mockResolvedValue({ textStream, totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }), finishReason: Promise.resolve(finishReason), steps: Promise.resolve([]) }) };
}

/**
 * An agent whose request to the model provider fails, as the SDK reports it:
 * the error goes to onError, the text ends empty, and the result's promises
 * reject.
 */
function agentFailingWith(error: unknown) {
  return {
    stream: vi.fn(async (options: { onError?: (event: { error: unknown }) => void }) => {
      options.onError?.({ error });
      const noOutput = Promise.reject(new Error("No output generated. Check the stream for errors."));
      noOutput.catch(() => undefined);
      return { textStream: (async function* () {})(), totalUsage: noOutput, finishReason: noOutput, steps: noOutput };
    }),
  };
}

/** The JSON lines logEvent printed at this level, by their message. */
function logLines(spy: { mock: { calls: unknown[][] } }, message: string): Array<Record<string, unknown>> {
  return spy.mock.calls.map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown>; } catch { return {}; } }).filter((line) => line.message === message);
}

/** An agent whose reply streams word by word, each once its gate opens. */
function agentReplyingIn(words: string[], gates: Array<Promise<void>> = []) {
  mocks.loadWidgetChatHistory.mockResolvedValue([{ id: "m1", direction: "inbound", body: "Are you open on Sunday?", createdAt: new Date() }]);
  return {
    stream: vi.fn(async (options: { abortSignal?: AbortSignal }) => ({
      textStream: (async function* () {
        for (const [index, word] of words.entries()) {
          await gates[index];
          // Like the request to the model provider, an aborted signal ends the reply.
          options.abortSignal?.throwIfAborted();
          yield word;
        }
      })(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      finishReason: Promise.resolve("stop"),
      steps: Promise.resolve([]),
    })),
  };
}

vi.mock("@/lib/api-helpers", () => ({
  getWorkerDatabase: mocks.getWorkerDatabase,
  readJson: mocks.readJson,
}));

vi.mock("@/lib/domain-context", () => ({
  createWorkerDomainContext: () => ({ db: {} }),
}));

vi.mock("@/lib/error-reporting", () => ({
  reportServerError: mocks.reportServerError,
}));

vi.mock("@/lib/widget-access", () => ({
  resolveWidgetSessionAccess: mocks.resolveWidgetSessionAccess,
}));

vi.mock("@/lib/widget-keys", () => ({
  requestIpHash: mocks.requestIpHash,
}));

vi.mock("@/lib/widget-policy", () => ({
  enforceWidgetRateLimits: mocks.enforceWidgetRateLimits,
}));

import { POST } from "../../app/api/widget/chat/route";

const businessId = "00000000-0000-4000-8000-000000000001";
const widgetKeyId = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003";
const visitorId = "00000000-0000-4000-8000-000000000004";
const inboundMessageId = "00000000-0000-4000-8000-000000000005";

const session = {
  businessId,
  widgetKeyId,
  keyHash: "hash",
  origin: "https://example.com",
  key: { status: "active", allowedOrigins: ["https://example.com"] },
  businessName: "Maple Family Clinic",
  businessSlug: "maple-clinic",
  defaultLocale: "en" as const,
  config: {},
  visitorId,
};

function widgetRequest(overrides: Record<string, unknown> = {}, signal?: AbortSignal): Request {
  mocks.readJson.mockResolvedValue({
    visitorId,
    messageId: "00000000-0000-4000-8000-000000000006",
    content: "Hi, I would like to book a checkup.",
    ...overrides,
  });
  return new Request("https://app.example.test/api/widget/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    ...(signal ? { signal } : {}),
  });
}

function savedReplies() {
  return mocks.appendMessage.mock.calls.map(([, message]) => message as { direction: string; body: string }).filter((message) => message.direction === "outbound");
}

async function readSse(response: Response): Promise<string> {
  return await response.text();
}

/** The stream's parts, as the widget reads them. */
function streamParts(body: string): Array<Record<string, unknown>> {
  return body.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveWidgetSessionAccess.mockResolvedValue({ ok: true, session });
  mocks.enforceWidgetRateLimits.mockResolvedValue({ allowed: true });
  mocks.requestIpHash.mockReturnValue("ip-hash");
  mocks.getOrCreateWidgetConversation.mockResolvedValue({ conversationId, automationState: "ai_active" });
  mocks.returnQuietTeamChat.mockResolvedValue("human_handoff");
  mocks.announceLateWidgetReply.mockResolvedValue(undefined);
  mocks.appendMessage.mockResolvedValue(inboundMessageId);
  mocks.queueOperatorAlert.mockResolvedValue(undefined);
  mocks.recordAiGenerationEvent.mockResolvedValue("event-id");
  mocks.getWorkerDatabase.mockReturnValue({ db: {} });
  mocks.withBusinessTransaction.mockImplementation(async (_db, _ctx, callback) => await callback({}));
  mocks.reserveWidgetChatUsageInTransaction.mockResolvedValue({ allowed: true, plan: "scale" });
  mocks.createAgentModel.mockReturnValue({ modelId: "test" });
  mocks.createReceptionistAgent.mockReturnValue(agentStreaming((async function* () { yield "Thanks"; })()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/widget/chat", () => {
  it("rejects when the widget key cannot be resolved", async () => {
    mocks.resolveWidgetSessionAccess.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "nope" }), { status: 401, headers: { "content-type": "application/json" } }),
    });
    const response = await POST(widgetRequest());
    expect(response.status).toBe(401);
    expect(mocks.appendMessage).not.toHaveBeenCalled();
  });

  it("rejects when the widget rate limit is exceeded", async () => {
    mocks.enforceWidgetRateLimits.mockResolvedValue({ allowed: false, status: 429, code: "widget_rate_limited", reason: "rate_limit" });
    const response = await POST(widgetRequest());
    expect(response.status).toBe(429);
  });

  it("suppresses the AI reply and alerts when the conversation is on human handoff", async () => {
    mocks.getOrCreateWidgetConversation.mockResolvedValue({ conversationId, automationState: "human_handoff" });
    const response = await POST(widgetRequest());
    const body = await readSse(response);
    expect(response.status).toBe(200);
    expect(mocks.appendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.appendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ direction: "inbound", channel: "web_chat" }));
    expect(mocks.queueOperatorAlert).toHaveBeenCalled();
    expect(mocks.createAgentModel).not.toHaveBeenCalled();
    expect(body).toContain("human_handoff");
    // The team is still in the chat.
    expect(mocks.returnQuietTeamChat).toHaveBeenCalledWith(expect.anything(), { businessId, conversationId });
  });

  it("answers in a chat the team took over and then went quiet in", async () => {
    mocks.getOrCreateWidgetConversation.mockResolvedValue({ conversationId, automationState: "human_handoff" });
    mocks.returnQuietTeamChat.mockResolvedValue("ai_active");
    mocks.createReceptionistAgent.mockReturnValue(agentReplyingIn(["We're open Sunday."]));

    const body = await readSse(await POST(widgetRequest()));

    expect(body).toContain("We're open Sunday.");
    expect(body).toContain('"messageMetadata":{"automationState":"ai_active"}');
    expect(savedReplies()).toEqual([expect.objectContaining({ body: "We're open Sunday.", aiGenerated: true })]);
  });

  it("doesn't check on the team in a chat the receptionist has", async () => {
    await readSse(await POST(widgetRequest()));
    expect(mocks.returnQuietTeamChat).not.toHaveBeenCalled();
  });

  it("saves the visitor's message without saving the visitor, which its session did", async () => {
    await readSse(await POST(widgetRequest()));
    expect(mocks.appendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId, direction: "inbound", channel: "web_chat" }));
    expect(mocks.registerWidgetVisitor).not.toHaveBeenCalled();
  });

  it("finishes and saves the reply when the visitor moves to another page mid-reply", async () => {
    mocks.appendMessage.mockImplementation(async (_context: unknown, message: { direction: string }) => message.direction === "outbound" ? "reply-1" : inboundMessageId);
    let openRest!: () => void;
    const rest = new Promise<void>((resolve) => { openRest = resolve; });
    mocks.createReceptionistAgent.mockReturnValue(agentReplyingIn(["We're open ", "Sunday 10 to 4."], [Promise.resolve(), rest]));
    const connection = new AbortController();

    const response = await POST(widgetRequest({}, connection.signal));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("We're open")) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`The reply ended before its first words: ${received}`);
      received += decoder.decode(value, { stream: true });
    }

    // The visitor clicks a link on the site: the browser drops the request.
    connection.abort();
    await reader.cancel();
    openRest();

    await vi.waitFor(() => expect(savedReplies()).toEqual([expect.objectContaining({ body: "We're open Sunday 10 to 4.", aiGenerated: true })]));
    // The widget on the next page hears about the reply, in case it loaded the chat first.
    await vi.waitFor(() => expect(mocks.announceLateWidgetReply).toHaveBeenCalledWith(expect.anything(), { businessId, conversationId, messageId: "reply-1" }));
  });

  it("doesn't announce a reply the visitor stayed for", async () => {
    mocks.createReceptionistAgent.mockReturnValue(agentReplyingIn(["We're open ", "Sunday 10 to 4."]));
    const body = await readSse(await POST(widgetRequest()));
    expect(body).toContain("Sunday 10 to 4.");
    expect(savedReplies()).toEqual([expect.objectContaining({ body: "We're open Sunday 10 to 4." })]);
    expect(mocks.announceLateWidgetReply).not.toHaveBeenCalled();
  });

  it("queues one operator alert per conversation and day, not one per message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T15:00:00Z"));
    mocks.getOrCreateWidgetConversation.mockResolvedValue({ conversationId, automationState: "human_handoff" });
    await POST(widgetRequest());
    await POST(widgetRequest({ content: "Can someone call me?" }));
    vi.useRealTimers();
    const keys = mocks.queueOperatorAlert.mock.calls.map(([, input]) => (input as { eventKey: string }).eventKey);
    expect(keys).toEqual([`widget-chat:${conversationId}:2026-10-09`, `widget-chat:${conversationId}:2026-10-09`]);
  });

  it("returns HTTP 402 without calling the model when chat allowance is spent", async () => {
    mocks.reserveWidgetChatUsageInTransaction.mockResolvedValue({ allowed: false, plan: "starter" });
    const response = await POST(widgetRequest());
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "chat_ai_limit_reached" });
    expect(mocks.createAgentModel).toHaveBeenCalled();
  });

  it("returns a configuration error before reserving chat allowance", async () => {
    mocks.createAgentModel.mockReturnValue(undefined);
    const response = await POST(widgetRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ai_provider_unavailable" });
    expect(mocks.reserveWidgetChatUsageInTransaction).not.toHaveBeenCalled();
  });

  it("streams an AI reply and persists the outbound message when automation is active", async () => {
    vi.stubEnv("AI_CHAT_API_KEY", "test-api-key");
    mocks.getCachedBusinessSnapshot.mockResolvedValue({ businessId } as BusinessContextSnapshot);
    mocks.loadWidgetChatHistory.mockResolvedValue([]);
    mocks.createReceptionistAgent.mockReturnValue(agentStreaming((async function* () {
      yield "Thanks";
      yield " for reaching out!";
    })()));

    const response = await POST(widgetRequest());
    const body = await readSse(response);
    expect(response.status).toBe(200);
    expect(body).toContain("text-delta");
    expect(body).toContain("Thanks");
    expect(body).toContain("for reaching out!");
    expect(mocks.appendMessage).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ direction: "outbound", channel: "web_chat", aiGenerated: true }));
    expect(mocks.createReceptionistAgent).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ channel: "web_chat", conversationId }) }));
    await vi.waitFor(() => expect(mocks.recordAiGenerationEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      businessId,
      conversationId,
      isStreaming: true,
      provider: "test",
      model: "test",
    })));
  });

  it("hands each reply's instructions, history, steps and text to the AI debug trace", async () => {
    vi.stubEnv("AI_CHAT_API_KEY", "test-api-key");
    mocks.getCachedBusinessSnapshot.mockResolvedValue({ businessId, version: "v7" } as BusinessContextSnapshot);
    mocks.loadWidgetChatHistory.mockResolvedValue([{ direction: "inbound", body: "Who is the president?" }]);
    const steps = [{ text: "", toolCalls: [{ toolName: "searchKnowledge", input: { query: "council president" } }], toolResults: [{ toolName: "searchKnowledge", output: { outcome: "found" } }] }];
    mocks.createReceptionistAgent.mockReturnValue({ stream: vi.fn().mockResolvedValue({ textStream: (async function* () { yield "Richard Anderson."; })(), totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 3, totalTokens: 8 }), finishReason: Promise.resolve("stop"), steps: Promise.resolve(steps) }) });

    await readSse(await POST(widgetRequest()));
    await vi.waitFor(() => expect(mocks.recordAiTrace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      businessId,
      kind: "chat_reply",
      channel: "web_chat",
      conversationId,
      snapshot: { businessId, version: "v7" },
      instructions: "Chat instructions",
      input: "Visitor: Who is the president?",
      steps,
      output: "Richard Anderson.",
      usage: { inputTokens: 5, outputTokens: 3 },
    })));
  });

  it("lets a visitor ask for someone from the team when the widget has live chat on, and tells the widget the chat waits for them", async () => {
    mocks.resolveWidgetSessionAccess.mockResolvedValue({ ok: true, session: { ...session, config: { liveChat: { enabled: true } } } });
    mocks.getCachedBusinessSnapshot.mockResolvedValue({ businessId } as BusinessContextSnapshot);
    mocks.loadWidgetChatHistory.mockResolvedValue([]);
    mocks.createReceptionistAgent.mockImplementation((input: { context: { liveChat?: { onTeamRequested?: () => void } } }) => ({
      stream: vi.fn(async () => {
        input.context.liveChat?.onTeamRequested?.();
        return { textStream: (async function* () { yield "I've let the team know."; })(), totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }), finishReason: Promise.resolve("stop"), steps: Promise.resolve([]) };
      }),
    }));

    const body = await readSse(await POST(widgetRequest({ locale: "fr" })));

    expect(mocks.createReceptionistAgent).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ liveChat: expect.objectContaining({ locale: "fr" }) }) }));
    expect(body).toContain('"messageMetadata":{"automationState":"human_handoff","waitingForTeam":true}');
    expect(mocks.appendMessage).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ body: "I've let the team know.", direction: "outbound", aiGenerated: true }));
  });

  it.each([
    ["en", "Reply in English unless"],
    ["fr", "Reply in French unless"],
    ["es", "Reply in Spanish unless"],
    ["sr", "Reply in Serbian in Latin script (not Cyrillic) unless"],
  ])("replies in the widget's language, %s, and says so if nobody from the team joins", async (locale, instruction) => {
    mocks.resolveWidgetSessionAccess.mockResolvedValue({ ok: true, session: { ...session, defaultLocale: "fr", config: { liveChat: { enabled: true } } } });
    mocks.getCachedBusinessSnapshot.mockResolvedValue({ businessId } as BusinessContextSnapshot);
    mocks.loadWidgetChatHistory.mockResolvedValue([]);

    await readSse(await POST(widgetRequest({ locale })));

    const agent = mocks.createReceptionistAgent.mock.calls[0]![0] as { extraInstructions: string; context: { liveChat?: { locale: string } } };
    expect(agent.extraInstructions).toContain(instruction);
    expect(agent.context.liveChat?.locale).toBe(locale);
  });

  it("uses the widget's settings, then the business's language, for a widget that sends none", async () => {
    mocks.getCachedBusinessSnapshot.mockResolvedValue({ businessId } as BusinessContextSnapshot);
    mocks.loadWidgetChatHistory.mockResolvedValue([]);
    mocks.resolveWidgetSessionAccess.mockResolvedValue({ ok: true, session: { ...session, defaultLocale: "fr", config: { localeOverride: "es" } } });
    await readSse(await POST(widgetRequest()));
    mocks.resolveWidgetSessionAccess.mockResolvedValue({ ok: true, session: { ...session, defaultLocale: "fr", config: {} } });
    await readSse(await POST(widgetRequest()));

    expect(mocks.createReceptionistAgent.mock.calls.map(([input]) => (input as { extraInstructions: string }).extraInstructions)).toEqual([
      expect.stringContaining("Reply in Spanish unless"),
      expect.stringContaining("Reply in French unless"),
    ]);
  });

  it("offers no live chat when the widget has it off", async () => {
    mocks.getCachedBusinessSnapshot.mockResolvedValue({ businessId } as BusinessContextSnapshot);
    mocks.loadWidgetChatHistory.mockResolvedValue([]);

    const body = await readSse(await POST(widgetRequest()));

    expect(mocks.createReceptionistAgent.mock.calls[0]![0].context).not.toHaveProperty("liveChat");
    expect(body).toContain('"messageMetadata":{"automationState":"ai_active"}');
  });

  it("does not expose provider error details in the UI stream", async () => {
    // eslint-disable-next-line require-yield -- mock generator must throw before yielding.
    mocks.createReceptionistAgent.mockReturnValue(agentStreaming((async function* () { throw new Error("secret provider token"); })(), "error"));
    const body = await readSse(await POST(widgetRequest()));
    expect(body).toContain("The chat could not be processed.");
    expect(body).not.toContain("secret provider token");
    await vi.waitFor(() => expect(mocks.recordAiGenerationEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      businessId,
      conversationId,
      isError: true,
      error: "generation_failed",
      provider: "test",
      model: "test",
    })));
  });

  it("reports why the model provider refused a reply, under the Error ID the widget shows", async () => {
    const refusal = new APICallError({
      message: "Project does not have access to model gpt-6-luna.",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: { input: "Hi, I would like to book a checkup." },
      statusCode: 403,
      isRetryable: false,
      data: { error: { message: "Project does not have access to model gpt-6-luna.", type: "invalid_request_error", param: null, code: "model_not_found" } },
    });
    mocks.createReceptionistAgent.mockReturnValue(agentFailingWith(refusal));

    const body = await readSse(await POST(widgetRequest()));

    // The widget gets the Error ID, never the provider's explanation.
    const shown = JSON.parse(String(streamParts(body).find((part) => part.type === "error")?.errorText)) as { code: string; errorId: string };
    expect(shown).toMatchObject({ code: "chat_reply_failed", errorId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(body).not.toContain("does not have access");
    expect(mocks.reportServerError).toHaveBeenCalledExactlyOnceWith(refusal, expect.objectContaining({
      operation: "widget.chat_reply",
      route: "/api/widget/chat",
      errorId: shown.errorId,
      conversationId,
      stage: "generate",
      category: "provider_auth",
      providerErrorStatus: 403,
      providerErrorCode: "model_not_found",
      providerErrorKind: "invalid_request_error",
      retryable: false,
    }));
    await vi.waitFor(() => expect(mocks.recordAiGenerationEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isError: true, error: "provider_auth", provider: "test" })));
    expect(savedReplies()).toEqual([]);
  });

  it("says why a reply came back without text", async () => {
    mocks.createReceptionistAgent.mockReturnValue(agentStreaming((async function* () {})(), "length"));

    await readSse(await POST(widgetRequest()));

    expect(mocks.reportServerError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "EmptyReplyError" }), expect.objectContaining({ operation: "widget.chat_reply", category: "output_limit", finishReason: "length", stage: "generate" }));
    expect(savedReplies()).toEqual([]);
  });

  it("logs each reply's timing, steps and tools with the business, but not its text", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const steps = [{ text: "", toolCalls: [{ toolName: "searchKnowledge", input: { query: "checkup" } }], toolResults: [] }];
    mocks.createReceptionistAgent.mockReturnValue({ stream: vi.fn().mockResolvedValue({ textStream: (async function* () { yield "We can book you in on Tuesday."; })(), totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 3, totalTokens: 8 }), finishReason: Promise.resolve("stop"), steps: Promise.resolve(steps) }) });

    await readSse(await POST(widgetRequest()));

    const [line] = logLines(info, "widget.chat_reply");
    expect(line).toMatchObject({ level: "info", businessId, conversationId, modelSteps: 1, tools: ["searchKnowledge"], finishReason: "stop", inputTokens: 5, outputTokens: 3, teamRequested: false });
    expect(line?.timeToFirstTokenMs).toEqual(expect.any(Number));
    expect(JSON.stringify(line)).not.toContain("Tuesday");
    expect(mocks.reportServerError).not.toHaveBeenCalled();
  });

  it("logs why a message got no reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.enforceWidgetRateLimits.mockResolvedValue({ allowed: false, status: 429, code: "widget_rate_limited", reason: "rate_limit_visitor_hour" });

    await POST(widgetRequest());

    expect(logLines(warn, "widget.chat_refused")).toEqual([expect.objectContaining({ level: "warn", businessId, status: 429, code: "widget_rate_limited", reason: "rate_limit_visitor_hour" })]);
  });

  it("answers a message that fails the schema with 400, naming the field but not its value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await POST(widgetRequest({ content: "x".repeat(4_001) }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "widget_chat_input_invalid" });
    expect(logLines(warn, "widget.chat_refused")).toEqual([expect.objectContaining({ status: 400, code: "widget_chat_input_invalid", invalid: "content" })]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("xxxx");
    expect(mocks.appendMessage).not.toHaveBeenCalled();
    expect(mocks.reportServerError).not.toHaveBeenCalled();
  });

  it("reports a failure before the reply starts, and gives the widget its Error ID", async () => {
    const failure = new Error("connection terminated unexpectedly");
    mocks.appendMessage.mockRejectedValue(failure);

    const response = await POST(widgetRequest());

    expect(response.status).toBe(500);
    const body = await response.json() as { code: string; errorId: string };
    expect(body).toMatchObject({ code: "chat_failed", errorId: expect.any(String) });
    expect(response.headers.get("x-error-id")).toBe(body.errorId);
    await vi.waitFor(() => expect(mocks.reportServerError).toHaveBeenCalledExactlyOnceWith(failure, { operation: "widget.chat", route: "/api/widget/chat", errorId: body.errorId }));
  });
});
