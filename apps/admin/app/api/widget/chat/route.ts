import { randomUUID } from "node:crypto";

import { createUIMessageStream, createUIMessageStreamResponse, type StepResult, type ToolSet } from "ai";
import { NextResponse } from "next/server";

import { createReceptionistAgent, receptionistInstructions, toAiTraceSteps, type ReceptionistStreamOptions } from "@lobbystack/agent-core/agent";
import { describeAgentFailure, EmptyReplyError } from "@lobbystack/agent-core/failure";
import { createAgentModel, describeAgentUsage } from "@lobbystack/agent-core/model";
import { announceLateWidgetReply, appendMessage, getCachedBusinessSnapshot, getOrCreateWidgetConversation, loadWidgetChatHistory, recordAiGenerationEvent, recordAiTrace, reserveWidgetChatUsageInTransaction, returnQuietTeamChat, type AiTraceInput } from "@lobbystack/domain";
import { withBusinessTransaction } from "@lobbystack/db";
import { normalizeInterfaceLocale, widgetChatRequestSchema, type BusinessContextSnapshot, type InterfaceLocale } from "@lobbystack/shared";
import { addToCallContext, logEvent, withCallContext } from "@lobbystack/telemetry/node";

import { runAfterResponse } from "@/lib/after-response";
import { getWorkerDatabase, readJson } from "@/lib/api-helpers";
import { createWorkerDomainContext } from "@/lib/domain-context";
import { reportServerError } from "@/lib/error-reporting";
import { resolveWidgetSessionAccess, type WidgetSession } from "@/lib/widget-access";
import { requestIpHash } from "@/lib/widget-keys";
import { enforceWidgetRateLimits } from "@/lib/widget-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ROUTE = "/api/widget/chat";
const SAFE_CHAT_ERROR = "The chat could not be processed.";

/** The language the receptionist replies in, for each language the widget shows. */
const REPLY_LANGUAGES: Record<InterfaceLocale, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  sr: "Serbian in Latin script (not Cyrillic)",
};

// The widget only says that the message couldn't be sent, so the log line is
// where an operator sees why. A rate limit's `reason` names the count that ran out.
function refused(status: number, code: string, error: string, fields: Record<string, string | undefined> = {}): NextResponse {
  logEvent("warn", "widget.chat_refused", { status, code, ...fields });
  return NextResponse.json({ error, code }, { status });
}

/**
 * What a failed reply ends with. The widget shows the Error ID, and the
 * admin's log line and error report with that `errorId` say why.
 */
function replyFailedText(errorId: string): string {
  return JSON.stringify({ error: SAFE_CHAT_ERROR, code: "chat_reply_failed", errorId });
}

// Saving the reply's telemetry never fails the chat. Only the error's type is
// logged: a database error can carry the values it was given.
function logUnsaved(message: string) {
  return (cause: unknown) => logEvent("warn", message, { errorType: cause instanceof Error ? cause.name : typeof cause });
}

function toolNames(steps: ReadonlyArray<StepResult<ToolSet>>): string[] {
  return steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
}

function fallbackSnapshot(session: WidgetSession): BusinessContextSnapshot {
  return {
    businessId: session.businessId,
    version: "widget-fallback",
    generatedAt: new Date().toISOString(),
    displayName: session.businessName,
    timezone: "UTC",
    defaultLocale: session.defaultLocale,
    businessType: "other",
    greeting: session.config.greeting ?? "Welcome!",
    voiceInstructions: "",
    smsInstructions: "",
    chatInstructions: "Be friendly and concise in the chat widget.",
    summary: session.businessName,
    bookingPolicy: "Confirm availability before booking.",
    knowledgeDigest: "",
    transferPolicy: { mode: "never" },
    hours: [],
    closures: [],
    services: [],
    contactChannels: {},
  };
}

export async function POST(request: Request) {
  // Logs and error reports carry the business once the session names it,
  // those from the receptionist's tools included.
  return await withCallContext({}, () => answerChat(request));
}

async function answerChat(request: Request) {
  try {
    const parsed = widgetChatRequestSchema.safeParse(await readJson(request));
    // Only the names of the fields that failed are logged, never their values.
    if (!parsed.success) return refused(400, "widget_chat_input_invalid", "The chat message is invalid.", { invalid: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))].join(",") });
    const body = parsed.data;
    const access = await resolveWidgetSessionAccess(request);
    if (!access.ok) {
      const { code } = await access.response.clone().json().catch(() => ({})) as { code?: string };
      logEvent("warn", "widget.chat_refused", { status: access.response.status, code });
      return access.response;
    }
    const { session } = access;
    addToCallContext({ businessId: session.businessId });
    if (session.visitorId !== body.visitorId) return refused(403, "widget_visitor_mismatch", "The visitor does not match the widget session.");
    const rate = await enforceWidgetRateLimits({ businessId: session.businessId, widgetKeyId: session.widgetKeyId, visitorId: body.visitorId, ...(requestIpHash(request) ? { ipHash: requestIpHash(request) } : {}), operation: "chat" });
    if (!rate.allowed) return refused(rate.status, rate.code, "Chat rate limit reached.", { reason: rate.reason });

    const context = createWorkerDomainContext();
    const conversation = await getOrCreateWidgetConversation(context, { businessId: session.businessId, widgetVisitorId: body.visitorId });
    const { conversationId } = conversation;
    // A chat the team has, but went quiet in, goes back to the receptionist.
    const automationState = conversation.automationState === "human_handoff" ? await returnQuietTeamChat(context, { businessId: session.businessId, conversationId }) : conversation.automationState;
    await appendMessage(context, { businessId: session.businessId, conversationId, body: body.content, direction: "inbound", channel: "web_chat" });
    const { queueOperatorAlert } = await import("@lobbystack/domain");
    await queueOperatorAlert(context, {
      businessId: session.businessId,
      eventKind: "widgetChat",
      // One alert per chat per day: the unique event key drops the rest.
      eventKey: `widget-chat:${conversationId}:${new Date().toISOString().slice(0, 10)}`,
      subject: "New website chat message",
      body: body.content.slice(0, 240) || "A website visitor sent a chat message.",
    });
    const model = automationState === "ai_active" ? createAgentModel() : undefined;
    if (automationState === "ai_active" && !model) {
      return refused(503, "ai_provider_unavailable", "The AI chat provider is not configured.", { conversationId });
    }
    if (automationState === "ai_active") {
      const reservation = await withBusinessTransaction(getWorkerDatabase().db, { businessId: session.businessId, actorType: "worker" }, async (tx) => await reserveWidgetChatUsageInTransaction(tx, { businessId: session.businessId, conversationId }));
      if (!reservation.allowed) return refused(402, "chat_ai_limit_reached", "This month's chat session limit has been reached.", { conversationId, plan: reservation.plan });
    }
    const assistantMessageId = randomUUID();
    const traceId = randomUUID();
    const generationStartedAt = performance.now();
    // Set when the receptionist asks the team to join: the chat then waits for them.
    let teamRequested = false;
    // What this reply's AI debug trace keeps (ADR 0009), filled in as the reply is built.
    let trace: Omit<AiTraceInput, "kind" | "channel" | "businessId"> | undefined;
    const replyMetadata = () => teamRequested ? { automationState: "human_handoff", waitingForTeam: true } : { automationState: "ai_active" };
    const stream = createUIMessageStream({
      onError: () => SAFE_CHAT_ERROR,
      execute: async ({ writer }) => {
        writer.write({ type: "start", messageId: assistantMessageId });
        // How far the reply got, and the model steps it finished, for the report when it fails.
        let stage: "load_context" | "generate" | "save_reply" = "load_context";
        const finishedSteps: Array<StepResult<ToolSet>> = [];
        try {
          if (automationState === "human_handoff") {
            writer.write({ type: "finish", finishReason: "stop", messageMetadata: { automationState: "human_handoff" } });
            return;
          }

          const snapshot = await getCachedBusinessSnapshot(context, { businessId: session.businessId });
          const activeSnapshot = snapshot ?? fallbackSnapshot(session);
          const history = await loadWidgetChatHistory(context, { businessId: session.businessId, conversationId });
          // The widget's language, which the visitor reads the chat in. A widget
          // from before it sent one shows its settings' language, or the business's.
          const locale: InterfaceLocale = body.locale ?? normalizeInterfaceLocale(session.config.localeOverride) ?? session.defaultLocale;
          const agentInput = {
            model: model!,
            context: {
              domain: context,
              snapshot: activeSnapshot,
              channel: "web_chat" as const,
              conversationId,
              // With live chat on, a visitor who asks for a person can get someone from the team here.
              ...(session.config.liveChat?.enabled ? { liveChat: { locale, onTeamRequested: () => { teamRequested = true; } } } : {}),
            },
            extraInstructions: `Reply in ${REPLY_LANGUAGES[locale]} unless the visitor clearly asks to switch languages.`,
          };
          const agent = createReceptionistAgent(agentInput);
          const chatHistory = history.slice(-20);
          trace = {
            conversationId,
            snapshot: activeSnapshot,
            instructions: receptionistInstructions(agentInput),
            input: chatHistory.map((row) => `${row.direction === "inbound" ? "Visitor" : "Receptionist"}: ${row.body}`).join("\n"),
          };
          writer.write({ type: "text-start", id: assistantMessageId });
          const text: string[] = [];
          let timeToFirstTokenMs: number | undefined;
          let streamError: unknown;
          stage = "generate";
          // The history already ends with the visitor's new message. The reply
          // isn't tied to the visitor's connection: one who moves to another
          // page mid-reply finds it saved in the chat there.
          const options: ReceptionistStreamOptions = {
            messages: chatHistory.map((row) => ({ role: row.direction === "inbound" ? "user" as const : "assistant" as const, content: row.body })),
            onStepEnd: (step) => { finishedSteps.push(step); },
            // A request the model provider refuses ends the text without an
            // error of its own: this is where its reason arrives.
            onError: ({ error }) => { streamError ??= error; },
          };
          const generation = await agent.stream(options);
          for await (const part of generation.textStream) {
            timeToFirstTokenMs ??= Math.round(performance.now() - generationStartedAt);
            text.push(part);
            writer.write({ type: "text-delta", id: assistantMessageId, delta: part });
          }
          if (streamError !== undefined) throw streamError;
          const reply = text.join("");
          if (!reply.trim()) throw new EmptyReplyError(await Promise.resolve(generation.finishReason).catch(() => undefined));
          const [rawUsage, finishReason] = await Promise.all([generation.totalUsage, generation.finishReason]);
          const usage = describeAgentUsage(rawUsage, performance.now() - generationStartedAt);
          stage = "save_reply";
          const persistedAssistantMessageId = await appendMessage(context, { businessId: session.businessId, conversationId, body: reply, direction: "outbound", channel: "web_chat", aiGenerated: true });
          // The widget on the visitor's next page may have loaded the chat before the reply was saved.
          if (request.signal.aborted) await announceLateWidgetReply(context, { businessId: session.businessId, conversationId, messageId: persistedAssistantMessageId });
          void recordAiGenerationEvent(context, {
            businessId: session.businessId,
            operation: "widget.chat",
            conversationId,
            messageId: persistedAssistantMessageId,
            traceId,
            isStreaming: true,
            ...usage,
          }).catch(logUnsaved("widget.ai_generation_unrecorded"));
          writer.write({ type: "text-end", id: assistantMessageId });
          writer.write({ type: "message-metadata", messageMetadata: replyMetadata() });
          writer.write({ type: "finish", finishReason });
          const steps = await generation.steps;
          logEvent("info", "widget.chat_reply", { conversationId, durationMs: Math.round(usage.latencyMs), timeToFirstTokenMs, modelSteps: steps.length, tools: toolNames(steps), finishReason, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens, teamRequested });
          void recordAiTrace(context, { ...trace, businessId: session.businessId, kind: "chat_reply", channel: "web_chat", messageId: persistedAssistantMessageId, model: usage.model, steps: toAiTraceSteps(steps), output: reply, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, durationMs: usage.latencyMs }).catch(logUnsaved("widget.ai_trace_unsaved"));
        } catch (cause) {
          const errorId = randomUUID();
          const latencyMs = performance.now() - generationStartedAt;
          const { error, ...failure } = describeAgentFailure(cause);
          // The report has the provider's status, code and explanation, never
          // the chat's content. The visitor sees its Error ID.
          void reportServerError(error, {
            operation: "widget.chat_reply",
            route: ROUTE,
            errorId,
            conversationId,
            stage,
            ...failure,
            modelSteps: finishedSteps.length,
            tools: toolNames(finishedSteps).join(",") || undefined,
            durationMs: Math.round(latencyMs),
          });
          void recordAiGenerationEvent(context, {
            businessId: session.businessId,
            operation: "widget.chat",
            conversationId,
            traceId,
            ...describeAgentUsage(undefined, latencyMs),
            isStreaming: true,
            isError: true,
            error: failure.category,
          }).catch(logUnsaved("widget.ai_generation_unrecorded"));
          if (trace) void recordAiTrace(context, { ...trace, businessId: session.businessId, kind: "chat_reply", channel: "web_chat", failed: true, steps: toAiTraceSteps(finishedSteps), durationMs: latencyMs }).catch(logUnsaved("widget.ai_trace_unsaved"));
          writer.write({ type: "error", errorText: replyFailedText(errorId) });
          writer.write({ type: "message-metadata", messageMetadata: replyMetadata() });
          writer.write({ type: "finish", finishReason: "error" });
        }
      },
    });

    return createUIMessageStreamResponse({
      stream,
      headers: {
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof NextResponse) {
      logEvent("warn", "widget.chat_refused", { status: error.status });
      return error;
    }
    const status = error !== null && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    if (status < 500) {
      logEvent("warn", "widget.chat_refused", { status, error });
      return NextResponse.json({ error: error instanceof Error ? error.message : "Request failed." }, { status });
    }
    // Before the reply starts, such as when the visitor's message can't be
    // saved. The widget shows the Error ID; the report says what failed.
    const errorId = randomUUID();
    runAfterResponse(() => reportServerError(error, { operation: "widget.chat", route: ROUTE, errorId }));
    return NextResponse.json({ error: "Request failed.", code: "chat_failed", errorId }, { status, headers: { "x-error-id": errorId } });
  }
}
