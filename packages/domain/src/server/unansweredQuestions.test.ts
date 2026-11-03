import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), requireAdmin: vi.fn(), requireMember: vi.fn(), createSnippet: vi.fn(), setAudience: vi.fn() }));
vi.mock("@lobbystack/db", async (original) => ({ ...(await original<typeof import("@lobbystack/db")>()), withBusinessTransaction: mocks.transaction }));
vi.mock("../authz", () => ({ requireBusinessAdmin: mocks.requireAdmin, requireBusinessMembership: mocks.requireMember }));
vi.mock("./knowledge", () => ({ createKnowledgeSnippetInTransaction: mocks.createSnippet }));
vi.mock("./knowledgeAudience", async (original) => ({ ...(await original<typeof import("./knowledgeAudience")>()), setKnowledgeArticleAudienceInTransaction: mocks.setAudience }));

import { unansweredQuestions } from "@lobbystack/db";
import { apiKnowledgeEntryCreateSchema } from "@lobbystack/shared";
import { answerUnansweredQuestion, dismissUnansweredQuestion, normalizeUnansweredQuestion, readUnansweredAnswerAudience, recordUnansweredQuestion } from "./unansweredQuestions";

type Values = Record<string, unknown>;
const context = { db: {} as never };
const now = new Date("2030-01-01T00:00:00Z");
const businessId = "11111111-1111-4111-8111-111111111111";
const questionId = "22222222-2222-4222-8222-222222222222";
const callId = "33333333-3333-4333-8333-333333333333";
const conversationId = "44444444-4444-4444-8444-444444444444";
const kitsilanoId = "55555555-5555-4555-8555-555555555555";
const gastownId = "66666666-6666-4666-8666-666666666666";
type Conflict = { target: unknown; targetWhere: SQL; set: Values };
let inserted: { values?: Values; conflict?: Conflict };
let updates: Values[];
let locked: Array<{ id: string; question: string; status: string }>;
let executed: SQL[];
// The receptionists that heard the question, as loadAskers reads them.
let askers: Array<{ question_id: string; receptionist_id: string; name: string; archived: boolean; times_asked: number; last_asked_at: Date }>;

beforeEach(() => {
  vi.stubEnv("CONTENT_RETENTION_ENABLED", "true");
  vi.stubEnv("CONTENT_RETENTION_POLICY_JSON", "");
  inserted = {}; updates = []; executed = []; askers = []; locked = [{ id: questionId, question: "Do you validate parking?", status: "open" }];
  // A billing lookup finds no account, which is the free plan.
  const chain = { from: () => chain, innerJoin: () => chain, leftJoin: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain, for: async () => locked, then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
  const tx = {
    select: () => chain,
    insert: () => ({ values: (values: Values) => {
      inserted.values = values;
      return { onConflictDoUpdate: (conflict: Conflict) => { inserted.conflict = conflict; return { returning: async () => [{ id: questionId, timesAsked: 1, status: "open" }] }; } };
    } }),
    update: () => ({ set: (values: Values) => ({ where: async () => { updates.push(values); } }) }),
    execute: async (statement: SQL) => { executed.push(statement); return { rows: new PgDialect().sqlToQuery(statement).sql.includes("from public.unanswered_questions q") ? askers : [], rowCount: 1 }; },
  };
  mocks.transaction.mockImplementation(async (_db, _scope, run) => run(tx));
  mocks.createSnippet.mockResolvedValue({ id: "snippet_1" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("normalizeUnansweredQuestion", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeUnansweredQuestion("  Do you VALIDATE   parking?! ")).toBe("do you validate parking");
    expect(normalizeUnansweredQuestion("Où est le stationnement ?")).toBe(normalizeUnansweredQuestion("où est le STATIONNEMENT"));
    expect(normalizeUnansweredQuestion("¿Cuánto cuesta?")).toBe("cuánto cuesta");
    expect(normalizeUnansweredQuestion(" ?! ")).toBe("");
  });
});

describe("recordUnansweredQuestion", () => {
  it("saves the question as the worker, expiring like a follow-up, and counts a repeat on its open or dismissed row", async () => {
    await expect(recordUnansweredQuestion(context, { businessId, question: "  Do you validate\nparking? ", channel: "voice", callId, now })).resolves.toEqual({ id: questionId, timesAsked: 1, status: "open" });
    expect(mocks.transaction).toHaveBeenCalledWith(context.db, { businessId, actorType: "worker" }, expect.any(Function));
    expect(inserted.values).toMatchObject({ businessId, question: "Do you validate parking?", normalizedQuestion: "do you validate parking", lastChannel: "voice", lastConversationId: null, firstAskedAt: now, lastAskedAt: now, contentExpiresAt: new Date("2030-01-31T00:00:00Z") });
    // The call is kept only while the business has it.
    const call = new PgDialect().sqlToQuery(inserted.values!.lastCallId as SQL);
    expect(call.sql).toContain("from public.calls c where c.id =");
    expect(call.params).toEqual([callId, businessId]);
    expect(inserted.conflict?.target).toEqual([unansweredQuestions.businessId, unansweredQuestions.normalizedQuestion]);
    expect(new PgDialect().sqlToQuery(inserted.conflict!.targetWhere).sql).toContain("in ('open', 'dismissed')");
    expect(Object.keys(inserted.conflict!.set).sort()).toEqual(["contentExpiresAt", "lastAskedAt", "lastCallId", "lastChannel", "lastConversationId", "timesAsked", "updatedAt"]);
    // Who heard it: the call's receptionist, else the default one, counted on the question.
    const asked = new PgDialect().sqlToQuery(executed[0]!);
    expect(asked.sql).toContain("insert into public.unanswered_question_receptionists");
    expect(asked.sql).toContain("select c.receptionist_id from public.calls c where c.id =");
    expect(asked.sql).toContain("p.is_default");
    expect(asked.sql).toContain("on conflict (question_id, receptionist_id) do update");
    expect(asked.params).toEqual([businessId, questionId, now.toISOString(), callId, businessId, businessId]);
  });

  it("counts who asked from the call, then the chat, then the receptionist named, then the default", async () => {
    await recordUnansweredQuestion(context, { businessId, question: "Can I bring my dog?", channel: "web_chat", callId, conversationId, receptionistId: kitsilanoId, now });
    const asked = new PgDialect().sqlToQuery(executed[0]!);
    const order = ["from public.calls c", "from public.conversations c", "p.id = $", "p.is_default"].map((part) => asked.sql.indexOf(part));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(asked.params).toEqual([businessId, questionId, now.toISOString(), callId, businessId, conversationId, businessId, businessId, kitsilanoId, businessId]);
    // A named receptionist that isn't an id is left out.
    executed = [];
    await recordUnansweredQuestion(context, { businessId, question: "Can I bring my dog?", channel: "web_chat", receptionistId: "kitsilano", now });
    expect(new PgDialect().sqlToQuery(executed[0]!).params).toEqual([businessId, questionId, now.toISOString(), businessId]);
  });

  it("keeps no expiry when content retention is off, and skips ids that aren't ids", async () => {
    vi.stubEnv("CONTENT_RETENTION_ENABLED", "false");
    await recordUnansweredQuestion(context, { businessId, question: "Can I bring my dog?", channel: "web_chat", callId: "call_1", conversationId: "chat_1", now });
    expect(inserted.values).toMatchObject({ contentExpiresAt: null, lastCallId: null, lastConversationId: null });
  });

  it("saves nothing for a lookup with no words, and cuts a long one", async () => {
    await expect(recordUnansweredQuestion(context, { businessId, question: " ... ", channel: "web_chat" })).resolves.toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
    await recordUnansweredQuestion(context, { businessId, question: "parking ".repeat(100), channel: "web_chat" });
    // Short enough to become a text entry's title when it's answered, as templates and the API check.
    const question = inserted.values!.question as string;
    expect(apiKnowledgeEntryCreateSchema.safeParse({ type: "text", title: question, content: "Yes." }).success).toBe(true);
    expect(apiKnowledgeEntryCreateSchema.safeParse({ type: "text", title: `${question}x`, content: "Yes." }).success).toBe(false);
  });
});

describe("answering and dismissing", () => {
  const operator = { userId: "user_1", businessId, questionId };

  it("saves the answer as a text entry titled with the question and marks the question answered", async () => {
    await expect(answerUnansweredQuestion(context, { ...operator, answer: "  Two hours free at the front desk. " })).resolves.toEqual({ snippetId: "snippet_1", audience: "everyone", receptionistIds: [] });
    expect(mocks.requireAdmin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "user_1", businessId }));
    expect(mocks.createSnippet).toHaveBeenCalledWith(expect.anything(), { businessId, title: "Do you validate parking?", content: "Two hours free at the front desk." });
    expect(updates).toEqual([expect.objectContaining({ status: "answered", knowledgeSnippetId: "snippet_1", resolvedByUserId: "user_1" })]);
    // An answer for everyone keeps the entry's default audience.
    expect(mocks.setAudience).not.toHaveBeenCalled();
  });

  it("gives the answer to the receptionists that asked, leaving out archived ones", async () => {
    const lastAskedAt = new Date("2029-12-31T00:00:00Z");
    askers = [
      { question_id: questionId, receptionist_id: kitsilanoId, name: "Kitsilano", archived: false, times_asked: 3, last_asked_at: lastAskedAt },
      { question_id: questionId, receptionist_id: gastownId, name: "Gastown", archived: true, times_asked: 1, last_asked_at: lastAskedAt },
    ];
    await expect(answerUnansweredQuestion(context, { ...operator, answer: "Yes.", audience: { audience: "asked" } })).resolves.toEqual({ snippetId: "snippet_1", audience: "chosen", receptionistIds: [kitsilanoId] });
    expect(mocks.setAudience).toHaveBeenCalledWith(expect.anything(), { businessId, actorUserId: "user_1", kind: "snippet", articleId: "snippet_1", choice: { audience: "chosen", receptionistIds: [kitsilanoId] } });
  });

  it("gives the answer to the receptionists chosen", async () => {
    await expect(answerUnansweredQuestion(context, { ...operator, answer: "Yes.", audience: { audience: "chosen", receptionistIds: [gastownId] } })).resolves.toEqual({ snippetId: "snippet_1", audience: "chosen", receptionistIds: [gastownId] });
    expect(mocks.setAudience).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ articleId: "snippet_1", choice: { audience: "chosen", receptionistIds: [gastownId] } }));
  });

  it("refuses an answer for the receptionists that asked when every one of them is archived", async () => {
    askers = [{ question_id: questionId, receptionist_id: gastownId, name: "Gastown", archived: true, times_asked: 1, last_asked_at: now }];
    await expect(answerUnansweredQuestion(context, { ...operator, answer: "Yes.", audience: { audience: "asked" } })).rejects.toMatchObject({ status: 409, code: "no_receptionists_asked" });
    expect(mocks.createSnippet).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("refuses an empty answer, a question already resolved, and one the business doesn't have", async () => {
    await expect(answerUnansweredQuestion(context, { ...operator, answer: "   " })).rejects.toMatchObject({ status: 400 });
    locked = [{ id: questionId, question: "Do you validate parking?", status: "dismissed" }];
    await expect(answerUnansweredQuestion(context, { ...operator, answer: "Yes." })).rejects.toMatchObject({ status: 409 });
    await expect(dismissUnansweredQuestion(context, operator)).rejects.toMatchObject({ status: 409 });
    locked = [];
    await expect(dismissUnansweredQuestion(context, operator)).rejects.toMatchObject({ status: 404 });
    await expect(dismissUnansweredQuestion(context, { ...operator, questionId: "not-an-id" })).rejects.toMatchObject({ status: 404 });
    expect(mocks.createSnippet).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("dismisses an open question for owners and admins only", async () => {
    await dismissUnansweredQuestion(context, operator);
    expect(updates).toEqual([expect.objectContaining({ status: "dismissed", resolvedByUserId: "user_1" })]);
    mocks.requireAdmin.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    await expect(dismissUnansweredQuestion(context, operator)).rejects.toMatchObject({ status: 403 });
    expect(updates).toHaveLength(1);
  });
});

describe("readUnansweredAnswerAudience", () => {
  it("answers for everyone unless the body says otherwise", () => {
    expect(readUnansweredAnswerAudience({ answer: "Yes." })).toEqual({ audience: "everyone" });
    expect(readUnansweredAnswerAudience({ audience: null })).toEqual({ audience: "everyone" });
    expect(readUnansweredAnswerAudience(null)).toEqual({ audience: "everyone" });
    expect(readUnansweredAnswerAudience({ audience: "everyone", receptionistIds: [kitsilanoId] })).toEqual({ audience: "everyone" });
  });

  it("reads the receptionists that asked, or those chosen", () => {
    expect(readUnansweredAnswerAudience({ audience: "asked", receptionistIds: [kitsilanoId] })).toEqual({ audience: "asked" });
    expect(readUnansweredAnswerAudience({ audience: "chosen", receptionistIds: [kitsilanoId, gastownId] })).toEqual({ audience: "chosen", receptionistIds: [kitsilanoId, gastownId] });
  });

  it("refuses an audience it doesn't know, and a choice of nobody", () => {
    expect(() => readUnansweredAnswerAudience({ audience: "some" })).toThrow(expect.objectContaining({ status: 400, code: "invalid_audience" }));
    expect(() => readUnansweredAnswerAudience({ audience: "chosen", receptionistIds: [] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => readUnansweredAnswerAudience({ audience: "chosen", receptionistIds: ["kitsilano"] })).toThrow(expect.objectContaining({ status: 400 }));
  });
});
