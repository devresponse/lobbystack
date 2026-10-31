import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CallSummarizer } from "@lobbystack/agent-core";
import type { JobEnvelope } from "@lobbystack/contracts";
import { finalizeConversationSession, loadCallSummaryInput, recordAiGenerationEvent, recordUnansweredQuestion, type CallSummaryInput } from "@lobbystack/domain";

vi.mock("@lobbystack/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lobbystack/domain")>();
  return {
    ...actual,
    finalizeConversationSession: vi.fn(),
    loadCallSummaryInput: vi.fn(),
    recordAiGenerationEvent: vi.fn(),
    recordUnansweredQuestion: vi.fn(),
  };
});

import { handleJob } from "./handlers";

afterEach(() => {
  vi.clearAllMocks();
});

const domain = { db: undefined as never };

function finalizeJob(businessId: string, callId: string): JobEnvelope {
  return { jobId: randomUUID(), type: "conversation.finalizeSession", queue: "default", businessId, payload: { callId }, trace: {}, idempotencyKey: `call:${callId}:finalize`, scheduled: false };
}

function summaryInput(overrides: Partial<CallSummaryInput> = {}): CallSummaryInput {
  return {
    conversationId: randomUUID(),
    locale: "en",
    disposition: "caller_finished",
    transcript: [
      { speaker: "assistant", text: "Thanks for calling, how can I help?" },
      { speaker: "caller", text: "Hi, this is Marie. Are you open on Friday?" },
      { speaker: "assistant", text: "Yes, from 9 to 5." },
    ],
    needsSummary: true,
    needsCallerName: true,
    needsUnansweredQuestions: true,
    channel: "voice",
    ...overrides,
  };
}

function summarizer(summarize: CallSummarizer["summarize"]): CallSummarizer {
  return { modelId: { provider: "openai", model: "gpt-6-luna" }, summarize: vi.fn(summarize) };
}

const usage = { provider: "openai", model: "gpt-6-luna", latencyMs: 900, inputTokens: 420, outputTokens: 30, totalTokens: 450 };

describe("conversation.finalizeSession call summaries", () => {
  it("passes the model summary and caller name into finalization and records the generation", async () => {
    const businessId = randomUUID();
    const callId = randomUUID();
    const input = summaryInput();
    vi.mocked(loadCallSummaryInput).mockResolvedValue(input);
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: true });
    vi.mocked(recordAiGenerationEvent).mockResolvedValue("event");
    const callSummarizer = summarizer(async () => ({ summary: "Asked about Friday hours; told the office is open 9 to 5.", callerName: "Marie", unansweredQuestions: [], usage }));

    await expect(handleJob(finalizeJob(businessId, callId), { domain, callSummarizer })).resolves.toEqual({ status: "completed", entityId: "session" });

    expect(callSummarizer.summarize).toHaveBeenCalledWith({ transcript: input.transcript, locale: "en", disposition: "caller_finished" });
    expect(finalizeConversationSession).toHaveBeenCalledWith(domain, { businessId, callId, generated: { summary: "Asked about Friday hours; told the office is open 9 to 5.", callerName: "Marie" } });
    expect(recordAiGenerationEvent).toHaveBeenCalledWith(domain, expect.objectContaining({ ...usage, businessId, callId, conversationId: input.conversationId, operation: "call.summary" }));
  });

  it("summarizes in the business locale", async () => {
    vi.mocked(loadCallSummaryInput).mockResolvedValue(summaryInput({ locale: "fr", transcript: [{ speaker: "caller", text: "Bonjour, êtes-vous ouverts vendredi?" }] }));
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: true });
    const callSummarizer = summarizer(async () => ({ summary: "A demandé les heures du vendredi.", callerName: null, unansweredQuestions: [], usage }));

    await handleJob(finalizeJob(randomUUID(), randomUUID()), { domain, callSummarizer });

    expect(callSummarizer.summarize).toHaveBeenCalledWith(expect.objectContaining({ locale: "fr" }));
    expect(finalizeConversationSession).toHaveBeenCalledWith(domain, expect.objectContaining({ generated: { summary: "A demandé les heures du vendredi.", callerName: null } }));
  });

  it("falls back to the heuristic and records a redacted error when the model fails", async () => {
    const businessId = randomUUID();
    const callId = randomUUID();
    vi.mocked(loadCallSummaryInput).mockResolvedValue(summaryInput());
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: true });
    vi.mocked(recordAiGenerationEvent).mockRejectedValue(new Error("analytics down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const callSummarizer = summarizer(async () => { throw new Error("provider echoed: Hi, this is Marie"); });

    await expect(handleJob(finalizeJob(businessId, callId), { domain, callSummarizer })).resolves.toEqual({ status: "completed", entityId: "session" });

    expect(finalizeConversationSession).toHaveBeenCalledWith(domain, { businessId, callId });
    expect(recordAiGenerationEvent).toHaveBeenCalledWith(domain, expect.objectContaining({ operation: "call.summary", isError: true, error: "generation_failed", model: "gpt-6-luna" }));
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ level: "warn", message: "call.summary_failed", businessId, callId, error: "generation_failed" }]);
    expect(recordUnansweredQuestion).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("labels timeouts separately", async () => {
    vi.mocked(loadCallSummaryInput).mockResolvedValue(summaryInput());
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: true });
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const callSummarizer = summarizer(async () => { throw timeout; });

    await handleJob(finalizeJob(randomUUID(), randomUUID()), { domain, callSummarizer });

    expect(recordAiGenerationEvent).toHaveBeenCalledWith(domain, expect.objectContaining({ isError: true, error: "generation_timeout" }));
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ message: "call.summary_failed", error: "generation_timeout" }));
    warn.mockRestore();
  });

  it("does not call the model when no summarizer is configured", async () => {
    const businessId = randomUUID();
    const callId = randomUUID();
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: true });

    await handleJob(finalizeJob(businessId, callId), { domain });

    expect(loadCallSummaryInput).not.toHaveBeenCalled();
    expect(finalizeConversationSession).toHaveBeenCalledWith(domain, { businessId, callId });
  });

  it("skips the model for finalized calls and near-empty transcripts", async () => {
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: false });
    const callSummarizer = summarizer(async () => ({ summary: "unused", callerName: null, unansweredQuestions: [], usage }));

    vi.mocked(loadCallSummaryInput).mockResolvedValueOnce(undefined);
    await expect(handleJob(finalizeJob(randomUUID(), randomUUID()), { domain, callSummarizer })).resolves.toEqual({ status: "skipped", entityId: "session" });
    vi.mocked(loadCallSummaryInput).mockResolvedValueOnce(summaryInput({ transcript: [{ speaker: "caller", text: "Yeah" }] }));
    await handleJob(finalizeJob(randomUUID(), randomUUID()), { domain, callSummarizer });

    expect(callSummarizer.summarize).not.toHaveBeenCalled();
    expect(recordAiGenerationEvent).not.toHaveBeenCalled();
  });

  it("keeps factual outcomes by passing only the caller name", async () => {
    const businessId = randomUUID();
    const callId = randomUUID();
    vi.mocked(loadCallSummaryInput).mockResolvedValue(summaryInput({ needsSummary: false }));
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: true });
    const callSummarizer = summarizer(async () => ({ summary: "Booked a cleaning.", callerName: "Marie", unansweredQuestions: [], usage }));

    await handleJob(finalizeJob(businessId, callId), { domain, callSummarizer });

    expect(finalizeConversationSession).toHaveBeenCalledWith(domain, { businessId, callId, generated: { callerName: "Marie" } });
  });

  it("saves the questions the receptionist couldn't answer once the call is finalized", async () => {
    const businessId = randomUUID();
    const callId = randomUUID();
    const input = summaryInput({ channel: "web_voice" });
    vi.mocked(loadCallSummaryInput).mockResolvedValue(input);
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: true });
    vi.mocked(recordUnansweredQuestion).mockResolvedValue({ id: "question", timesAsked: 1, status: "open" });
    const callSummarizer = summarizer(async () => ({ summary: "Asked for the support number; not on file.", callerName: "Marie", unansweredQuestions: ["What is your support phone number?", "Do you validate parking?"], usage }));

    await expect(handleJob(finalizeJob(businessId, callId), { domain, callSummarizer })).resolves.toEqual({ status: "completed", entityId: "session" });

    expect(recordUnansweredQuestion).toHaveBeenCalledTimes(2);
    expect(recordUnansweredQuestion).toHaveBeenNthCalledWith(1, domain, { businessId, question: "What is your support phone number?", channel: "web_voice", callId, conversationId: input.conversationId });
    expect(recordUnansweredQuestion).toHaveBeenNthCalledWith(2, domain, { businessId, question: "Do you validate parking?", channel: "web_voice", callId, conversationId: input.conversationId });
    expect(vi.mocked(finalizeConversationSession).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(recordUnansweredQuestion).mock.invocationCallOrder[0]!);
  });

  it("doesn't save them again when another run already finalized the call", async () => {
    vi.mocked(loadCallSummaryInput).mockResolvedValue(summaryInput());
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: false });
    const callSummarizer = summarizer(async () => ({ summary: "Asked for the support number.", callerName: null, unansweredQuestions: ["What is your support phone number?"], usage }));

    await handleJob(finalizeJob(randomUUID(), randomUUID()), { domain, callSummarizer });

    expect(recordUnansweredQuestion).not.toHaveBeenCalled();
  });

  it("saves nothing from a prospect demo", async () => {
    vi.mocked(loadCallSummaryInput).mockResolvedValue(summaryInput({ needsUnansweredQuestions: false }));
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: true });
    const callSummarizer = summarizer(async () => ({ summary: "Asked for the support number.", callerName: null, unansweredQuestions: ["What is your support phone number?"], usage }));

    await handleJob(finalizeJob(randomUUID(), randomUUID()), { domain, callSummarizer });

    expect(recordUnansweredQuestion).not.toHaveBeenCalled();
  });

  it("logs a question it couldn't save and still saves the rest", async () => {
    const businessId = randomUUID();
    const callId = randomUUID();
    vi.mocked(loadCallSummaryInput).mockResolvedValue(summaryInput());
    vi.mocked(finalizeConversationSession).mockResolvedValue({ sessionId: "session", finalized: true });
    vi.mocked(recordUnansweredQuestion).mockRejectedValueOnce(new Error("database down")).mockResolvedValueOnce({ id: "question", timesAsked: 1, status: "open" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const callSummarizer = summarizer(async () => ({ summary: "Asked two things.", callerName: null, unansweredQuestions: ["What is your support phone number?", "Do you validate parking?"], usage }));

    await expect(handleJob(finalizeJob(businessId, callId), { domain, callSummarizer })).resolves.toEqual({ status: "completed", entityId: "session" });

    expect(recordUnansweredQuestion).toHaveBeenCalledTimes(2);
    const logged = warn.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return undefined; } });
    expect(logged).toContainEqual(expect.objectContaining({ message: "knowledge.unanswered_question_failed", businessId, callId }));
    warn.mockRestore();
  });
});
