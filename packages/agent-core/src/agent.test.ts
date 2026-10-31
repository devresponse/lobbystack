import { createServer } from "node:http";

import { APICallError, tool, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { demoSnapshot } from "@lobbystack/shared";
import { initializeTelemetry, injectTraceContext, shutdownTelemetry, withCallContext, withSpan } from "@lobbystack/telemetry/node";

import { createReceptionistAgent, WEB_CHAT_MAX_OUTPUT_TOKENS, withToolSpans, type ReceptionistStreamOptions } from "./agent";
import type { AgentChannel, AgentToolContext } from "./tools";

type LanguageModelV4CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

async function firstCall(channel: AgentChannel, extra: Partial<Pick<AgentToolContext, "conversationId" | "liveChat">> = {}): Promise<LanguageModelV4CallOptions> {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content: [{ type: "text", text: "We're open until 5." }],
        finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } },
        warnings: [],
      };
    },
  });
  const agent = createReceptionistAgent({ model, context: { domain: { db: {} as never }, snapshot: demoSnapshot, channel, ...extra } });
  await agent.generate({ prompt: "When do you close?" });
  return calls[0]!;
}

describe("createReceptionistAgent", () => {
  it("caps each website chat step's output so a reply can't run long", async () => {
    expect((await firstCall("web_chat")).maxOutputTokens).toBe(WEB_CHAT_MAX_OUTPUT_TOKENS);
  });

  it("leaves calls uncapped", async () => {
    expect((await firstCall("voice")).maxOutputTokens).toBeUndefined();
    expect((await firstCall("web_voice")).maxOutputTokens).toBeUndefined();
  });

  it("gives a website chat with live chat on the tool and the rule to bring the team in", async () => {
    const call = await firstCall("web_chat", { conversationId: "conv_1", liveChat: { locale: "en" } });
    expect(call.tools?.map((tool) => tool.name)).toContain("requestTeamMember");
    expect(JSON.stringify(call.prompt)).toContain("call requestTeamMember right away");
    const plain = await firstCall("web_chat", { conversationId: "conv_1" });
    expect(plain.tools?.map((tool) => tool.name)).not.toContain("requestTeamMember");
    expect(JSON.stringify(plain.prompt)).not.toContain("requestTeamMember");
  });

  it("gives only a website chat the tool and the rule to save a question it can't answer", async () => {
    const chat = await firstCall("web_chat", { conversationId: "conv_1" });
    expect(chat.tools?.map((tool) => tool.name)).toContain("noteUnansweredQuestion");
    expect(JSON.stringify(chat.prompt)).toContain("save the question with noteUnansweredQuestion");
    for (const channel of ["voice", "web_voice"] as const) {
      const call = await firstCall(channel);
      expect(call.tools?.map((tool) => tool.name)).not.toContain("noteUnansweredQuestion");
      expect(JSON.stringify(call.prompt)).not.toContain("noteUnansweredQuestion");
    }
  });

  it("hands a request the model provider refused to onError, which the SDK would otherwise print", async () => {
    const refusal = new APICallError({ message: "Project does not have access to model gpt-6-luna.", url: "https://api.openai.com/v1/responses", requestBodyValues: {}, statusCode: 403, isRetryable: false });
    const model = new MockLanguageModelV4({ doStream: async () => { throw refusal; } });
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const errors: unknown[] = [];
    const agent = createReceptionistAgent({ model, context: { domain: { db: {} as never }, snapshot: demoSnapshot, channel: "web_chat", conversationId: "conv_1" } });

    const options: ReceptionistStreamOptions = { messages: [{ role: "user", content: "Are you open on Sunday?" }], onError: ({ error }) => { errors.push(error); } };
    const result = await agent.stream(options);
    let text = "";
    for await (const part of result.textStream) text += part;

    // The text just ends: only onError hears why.
    expect(text).toBe("");
    expect(errors).toEqual([refusal]);
    expect(printed).not.toHaveBeenCalled();
  });
});

type Execute = (input: object, options: { toolCallId: string; messages: never[]; abortSignal?: AbortSignal }) => Promise<unknown>;

const lookup = (execute: () => Promise<unknown>): ToolSet => withToolSpans({ lookupBooking: tool({ description: "Looks up a booking.", inputSchema: z.object({}), execute }) });
const run = (tools: ToolSet, abortSignal?: AbortSignal) => (tools.lookupBooking!.execute as unknown as Execute)({}, { toolCallId: "call_1", messages: [], ...(abortSignal ? { abortSignal } : {}) });

beforeEach(() => {
  // Error reports go no further than the log.
  for (const key of ["POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "POSTHOG_API_KEY"]) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("withToolSpans", () => {
  it("runs each tool call in its own span under the request's, and notes a declined outcome", async () => {
    const traces: string[] = [];
    const receiver = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (request.url === "/v1/traces") traces.push(body);
      response.end("{}");
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("OTLP test receiver did not start.");
    try {
      await initializeTelemetry({ endpoint: `http://127.0.0.1:${address.port}`, serviceName: "lobbystack-test" });
      let request: string | undefined;
      let inTool: string | undefined;
      const tools = lookup(async () => {
        inTool = injectTraceContext({}).traceparent;
        return { ok: false, reason: "Ask for the name the appointment was booked under." };
      });
      await withSpan("live.delegation", {}, async () => {
        request = injectTraceContext({}).traceparent;
        await expect(run(tools)).resolves.toMatchObject({ ok: false });
      });
      // Same trace, its own span.
      expect(inTool?.slice(0, 35)).toBe(request?.slice(0, 35));
      expect(inTool).not.toBe(request);
      await shutdownTelemetry();
      const exported = traces.join("\n");
      for (const expected of ["tool.lookupBooking", "gen_ai.tool.name", "lobbystack.tool.ok"]) expect(exported).toContain(expected);
    } finally {
      await shutdownTelemetry();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });

  it("reports a tool that throws with the call's IDs, and passes the failure on to the model", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tools = lookup(async () => { throw new Error("Bookings table unavailable"); });

    await withCallContext({ callId: "call_42", sessionId: "rtc_42" }, async () => {
      await expect(run(tools)).rejects.toThrow("Bookings table unavailable");
    });

    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({ level: "error", message: expect.stringMatching(/exception: Bookings table unavailable$/), operation: "tool.lookupBooking", callId: "call_42", sessionId: "rtc_42", error: "Bookings table unavailable" }),
    ]);
  });

  it("doesn't report a tool that fails because the call ended", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ended = new AbortController();
    ended.abort();

    await expect(run(lookup(async () => { throw new Error("aborted"); }), ended.signal)).rejects.toThrow("aborted");

    expect(error).not.toHaveBeenCalled();
  });
});
