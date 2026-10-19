import { createHash } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { aiTraceContexts, aiTraces, businesses, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import type { ApiAiTrace, ApiAiTraceDetail, BusinessContextSnapshot } from "@lobbystack/shared";

import type { DomainContext } from "./context";
import { contentExpiryForPlan, resolveBusinessBillingPlan } from "./contentRetentionPolicy";
import { afterCursor, decodeCursor, newestFirst, pageSize, toPage, type Page, type PageRequest } from "./publicApi/resources";

// AI debug traces (ADR 0009). They hold what callers and visitors said and
// what the business's documents returned, so they stay in this database, under
// its tenancy and retention: never in logs, spans or product events.

export type AiTraceKind = "chat_reply" | "voice_session" | "voice_delegation";

/** One model step: its text, the tools it called with their input, and what they returned. */
export type AiTraceStep = {
  text?: string | undefined;
  toolCalls: Array<{ toolName: string; input: unknown }>;
  toolResults: Array<{ toolName: string; output: unknown }>;
};

export type AiTraceInput = {
  businessId: string;
  kind: AiTraceKind;
  channel: string;
  callId?: string | undefined;
  conversationId?: string | undefined;
  messageId?: string | undefined;
  delegationId?: string | undefined;
  model?: string | undefined;
  snapshot?: BusinessContextSnapshot | undefined;
  instructions?: string | undefined;
  input?: string | undefined;
  steps?: AiTraceStep[] | undefined;
  output?: string | undefined;
  directAnswer?: boolean | undefined;
  failed?: boolean | undefined;
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
  durationMs?: number | undefined;
};

/** Long text is cut to this many characters, so one turn can't grow a row without bound. */
export const AI_TRACE_TEXT_LIMIT = 50_000;
/** Each tool input or output is kept as JSON up to this many characters. */
export const AI_TRACE_VALUE_LIMIT = 20_000;

function cut(value: string | undefined, limit = AI_TRACE_TEXT_LIMIT): string | null {
  if (value === undefined) return null;
  return value.length > limit ? `${value.slice(0, limit)}… [cut, ${value.length} characters in all]` : value;
}

/** A tool value as it was, or as cut JSON when it is too long to keep whole. */
function boundedValue(value: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return "[not serializable]";
  }
  if (json === undefined) return null;
  return json.length > AI_TRACE_VALUE_LIMIT ? `${json.slice(0, AI_TRACE_VALUE_LIMIT)}… [cut, ${json.length} characters in all]` : value;
}

export function boundAiTraceSteps(steps: AiTraceStep[]): AiTraceStep[] {
  return steps.map((step) => ({
    ...(step.text ? { text: cut(step.text) ?? undefined } : {}),
    toolCalls: step.toolCalls.map((call) => ({ toolName: call.toolName, input: boundedValue(call.input) })),
    toolResults: step.toolResults.map((result) => ({ toolName: result.toolName, output: boundedValue(result.output) })),
  }));
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Stores text once per business and kind, and keeps it until the newest trace using it expires. */
async function upsertContext(tx: DatabaseTransaction, businessId: string, kind: "snapshot" | "instructions", content: string, expiresAt: Date): Promise<string> {
  const [row] = await tx.insert(aiTraceContexts)
    .values({ businessId, kind, hash: sha256(content), content, expiresAt })
    .onConflictDoUpdate({ target: [aiTraceContexts.businessId, aiTraceContexts.kind, aiTraceContexts.hash], set: { expiresAt: sql`greatest(${aiTraceContexts.expiresAt}, excluded.expires_at)` } })
    .returning({ id: aiTraceContexts.id });
  if (!row) throw new Error("The AI trace context was not saved.");
  return row.id;
}

/**
 * Saves one AI turn when the business keeps AI debug traces, and returns its
 * id, or null when traces are off. Callers run it after the reply is on its
 * way, and a failure must never fail the turn.
 */
export async function recordAiTrace(context: DomainContext, input: AiTraceInput): Promise<string | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [business] = await tx.select({ enabled: businesses.aiTracesEnabled }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
    if (!business?.enabled) return null;
    const expiresAt = contentExpiryForPlan(await resolveBusinessBillingPlan(tx, input.businessId), "ai_traces");
    const snapshotContextId = input.snapshot ? await upsertContext(tx, input.businessId, "snapshot", JSON.stringify(input.snapshot), expiresAt) : null;
    const instructionsContextId = input.instructions ? await upsertContext(tx, input.businessId, "instructions", input.instructions, expiresAt) : null;
    const [row] = await tx.insert(aiTraces).values({
      businessId: input.businessId,
      kind: input.kind,
      channel: input.channel,
      callId: input.callId ?? null,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      delegationId: input.delegationId ?? null,
      model: input.model ?? null,
      snapshotVersion: input.snapshot?.version ?? null,
      snapshotContextId,
      instructionsContextId,
      input: cut(input.input),
      steps: boundAiTraceSteps(input.steps ?? []),
      output: cut(input.output),
      directAnswer: input.directAnswer ?? false,
      failed: input.failed ?? false,
      usage: input.usage ? { inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens } : null,
      durationMs: input.durationMs === undefined ? null : Math.round(input.durationMs),
      expiresAt,
    }).returning({ id: aiTraces.id });
    return row?.id ?? null;
  });
}

type TraceRow = typeof aiTraces.$inferSelect;

function toolNames(steps: unknown): string[] {
  return Array.isArray(steps) ? (steps as AiTraceStep[]).flatMap((step) => (step.toolCalls ?? []).map((call) => call.toolName)) : [];
}

function serializeAiTrace(row: TraceRow): ApiAiTrace {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    call_id: row.callId,
    conversation_id: row.conversationId,
    message_id: row.messageId,
    delegation_id: row.delegationId,
    model: row.model,
    snapshot_version: row.snapshotVersion,
    tools: toolNames(row.steps),
    output: row.output,
    direct_answer: row.directAnswer,
    failed: row.failed,
    duration_ms: row.durationMs,
    input_tokens: typeof row.usage?.inputTokens === "number" ? row.usage.inputTokens : null,
    output_tokens: typeof row.usage?.outputTokens === "number" ? row.usage.outputTokens : null,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
  };
}

const notExpired = (now: Date) => sql`${aiTraces.expiresAt} > ${now}`;

export async function listAiTraceResources(tx: DatabaseTransaction, businessId: string, request: PageRequest & { callId?: string | undefined; conversationId?: string | undefined }): Promise<Page<ApiAiTrace>> {
  const limit = pageSize(request.limit);
  const rows = await tx.select().from(aiTraces).where(and(
    eq(aiTraces.businessId, businessId),
    notExpired(new Date()),
    request.callId ? eq(aiTraces.callId, request.callId) : undefined,
    request.conversationId ? eq(aiTraces.conversationId, request.conversationId) : undefined,
    afterCursor(aiTraces.createdAt, aiTraces.id, decodeCursor(request.cursor)),
  )).orderBy(...newestFirst(aiTraces.createdAt, aiTraces.id)).limit(limit + 1);
  return toPage(rows, limit, serializeAiTrace, (row) => ({ at: row.createdAt, id: row.id }));
}

export async function loadAiTraceResource(tx: DatabaseTransaction, businessId: string, traceId: string): Promise<ApiAiTraceDetail | null> {
  const [row] = await tx.select().from(aiTraces).where(and(eq(aiTraces.businessId, businessId), eq(aiTraces.id, traceId), notExpired(new Date()))).limit(1);
  if (!row) return null;
  const contextIds = [row.snapshotContextId, row.instructionsContextId].filter((value): value is string => value !== null);
  const contexts = contextIds.length ? await tx.select({ id: aiTraceContexts.id, content: aiTraceContexts.content }).from(aiTraceContexts).where(and(eq(aiTraceContexts.businessId, businessId), inArray(aiTraceContexts.id, contextIds))).orderBy(asc(aiTraceContexts.createdAt)) : [];
  const contentOf = (id: string | null) => (id ? contexts.find((item) => item.id === id)?.content ?? null : null);
  const steps = Array.isArray(row.steps) ? (row.steps as AiTraceStep[]) : [];
  return {
    ...serializeAiTrace(row),
    input: row.input,
    steps: steps.map((step) => ({
      text: step.text ?? null,
      tool_calls: (step.toolCalls ?? []).map((call) => ({ tool: call.toolName, input: call.input })),
      tool_results: (step.toolResults ?? []).map((result) => ({ tool: result.toolName, output: result.output })),
    })),
    instructions: contentOf(row.instructionsContextId),
    snapshot: contentOf(row.snapshotContextId),
  };
}
