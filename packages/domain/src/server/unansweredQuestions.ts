import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { unansweredQuestions, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { isUuid } from "@lobbystack/shared";

import { requireBusinessAdmin, requireBusinessMembership } from "../authz";
import type { DomainContext } from "./context";
import { contentExpiryForPlan, isContentRetentionEnabled, resolveBusinessBillingPlan } from "./contentRetentionPolicy";
import { createKnowledgeSnippetInTransaction } from "./knowledge";
import { readKnowledgeAudienceChoice, setKnowledgeArticleAudienceInTransaction, type KnowledgeAudienceChoice } from "./knowledgeAudience";
import { failure } from "./requestHelpers";

/** The longest question kept, in characters. Longer lookups are cut, so an answered question fits as a text entry's title. */
export const MAX_UNANSWERED_QUESTION_LENGTH = 300;
/** The longest answer saved as a text entry, in characters. */
export const MAX_UNANSWERED_ANSWER_LENGTH = 5_000;
/** The most open questions the dashboard lists at once. */
// The most open questions a list returns, and how many it returns without a limit.
const OPEN_QUESTIONS_LIMIT = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type UnansweredQuestionChannel = "voice" | "web_voice" | "web_chat";

/** A receptionist that heard a question, how often and when last. */
export type UnansweredQuestionAsker = {
  receptionistId: string;
  name: string;
  /** Archived since: the question still shows it asked. */
  archived: boolean;
  timesAsked: number;
  lastAskedAt: Date;
};

export type OpenUnansweredQuestion = {
  id: string;
  question: string;
  timesAsked: number;
  firstAskedAt: Date;
  lastAskedAt: Date;
  lastChannel: string;
  lastCallId: string | null;
  lastConversationId: string | null;
  /** Who heard it, most often first. A chain hears one question at many stores; it stays one question. */
  askedOf: UnansweredQuestionAsker[];
};

/**
 * Who an answer is for: everyone, the receptionists chosen, or only the ones
 * that heard the question ("asked"), read when the answer is saved.
 */
export type UnansweredAnswerAudience = KnowledgeAudienceChoice | { audience: "asked" };

function cleanQuestion(question: string): string {
  return question.replace(/\s+/gu, " ").trim().slice(0, MAX_UNANSWERED_QUESTION_LENGTH).trim();
}

/**
 * The form two questions are compared in: case, accents' composed forms,
 * punctuation and spacing don't count, so "Do you have parking?" and
 * "do you have  parking" are the same question.
 */
export function normalizeUnansweredQuestion(question: string): string {
  return question.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, MAX_UNANSWERED_QUESTION_LENGTH).trim();
}

/**
 * Saves a question the receptionist found no knowledge for. Asked again while
 * its row is open or dismissed, it counts there instead of adding a row, so a
 * dismissed question stays dismissed until it expires with other caller
 * content; asked after that, it opens a new row. The call and conversation it came from
 * are kept only while they belong to the business. Null when the question has
 * no words to save. Calls and chats record these as the worker.
 */
export async function recordUnansweredQuestion(
  context: DomainContext,
  input: {
    businessId: string;
    question: string;
    channel: UnansweredQuestionChannel;
    callId?: string | undefined;
    conversationId?: string | undefined;
    /** The receptionist that heard it, when the call or chat doesn't say; the default one when nothing does. */
    receptionistId?: string | null | undefined;
    now?: Date;
  },
): Promise<{ id: string; timesAsked: number; status: string } | null> {
  const question = cleanQuestion(input.question);
  const normalizedQuestion = normalizeUnansweredQuestion(question);
  if (!normalizedQuestion) return null;
  const now = input.now ?? new Date();
  const { businessId } = input;
  return await withBusinessTransaction(context.db, { businessId, actorType: "worker" }, async (tx) => {
    // The question repeats what a caller said, so it expires like a follow-up made from their call.
    const retentionPlan = isContentRetentionEnabled() ? await resolveBusinessBillingPlan(tx, businessId) : null;
    const contentExpiresAt = retentionPlan ? contentExpiryForPlan(retentionPlan, "follow_ups", now) : null;
    const lastCallId = input.callId && UUID.test(input.callId) ? sql`(select c.id from public.calls c where c.id = ${input.callId}::uuid and c.business_id = ${businessId}::uuid)` : null;
    const lastConversationId = input.conversationId && UUID.test(input.conversationId) ? sql`(select c.id from public.conversations c where c.id = ${input.conversationId}::uuid and c.business_id = ${businessId}::uuid)` : null;
    const [row] = await tx.insert(unansweredQuestions).values({
      businessId,
      question,
      normalizedQuestion,
      lastChannel: input.channel,
      lastCallId,
      lastConversationId,
      firstAskedAt: now,
      lastAskedAt: now,
      contentExpiresAt,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [unansweredQuestions.businessId, unansweredQuestions.normalizedQuestion],
      targetWhere: sql`${unansweredQuestions.status} in ('open', 'dismissed')`,
      set: {
        timesAsked: sql`${unansweredQuestions.timesAsked} + 1`,
        lastAskedAt: now,
        lastChannel: sql`excluded.last_channel`,
        lastCallId: sql`excluded.last_call_id`,
        lastConversationId: sql`excluded.last_conversation_id`,
        contentExpiresAt: sql`excluded.content_expires_at`,
        updatedAt: now,
      },
    }).returning({ id: unansweredQuestions.id, timesAsked: unansweredQuestions.timesAsked, status: unansweredQuestions.status });
    if (!row) return null;
    // Who heard it: the receptionist the call or chat records, else the one
    // named, else the default, which every business has (migration 0143), so
    // every question has someone who asked it. The same question at another
    // store counts on the same question, under that store's receptionist.
    const named = input.receptionistId && isUuid(input.receptionistId) ? input.receptionistId : null;
    const asker = sql`coalesce(
      ${lastCallId ? sql`(select c.receptionist_id from public.calls c where c.id = ${input.callId}::uuid and c.business_id = ${businessId}::uuid)` : sql`null::uuid`},
      ${lastConversationId ? sql`(select c.receptionist_id from public.conversations c where c.id = ${input.conversationId}::uuid and c.business_id = ${businessId}::uuid)` : sql`null::uuid`},
      ${named ? sql`(select p.id from public.receptionist_profiles p where p.business_id = ${businessId}::uuid and p.id = ${named}::uuid)` : sql`null::uuid`},
      (select p.id from public.receptionist_profiles p where p.business_id = ${businessId}::uuid and p.is_default)
    )`;
    await tx.execute(sql`
      insert into public.unanswered_question_receptionists (business_id, question_id, receptionist_id, times_asked, last_asked_at)
      select ${businessId}::uuid, ${row.id}::uuid, asker.id, 1, ${now.toISOString()}::timestamptz
      from (select ${asker} as id) as asker
      on conflict (question_id, receptionist_id) do update
        set times_asked = unanswered_question_receptionists.times_asked + 1,
            last_asked_at = greatest(unanswered_question_receptionists.last_asked_at, excluded.last_asked_at)
    `);
    return row;
  });
}

/** Questions some receptionist heard. Every question records who asked it, from its first ask. */
function askedOfReceptionist(businessId: string, receptionistId: string): SQL {
  return sql`exists (select 1 from public.unanswered_question_receptionists l where l.business_id = ${businessId}::uuid and l.question_id = ${unansweredQuestions.id} and l.receptionist_id = ${receptionistId}::uuid)`;
}

/** Who heard each question, most often first. */
async function loadAskers(tx: DatabaseTransaction, businessId: string, questionIds: string[]): Promise<Map<string, UnansweredQuestionAsker[]>> {
  const byQuestion = new Map<string, UnansweredQuestionAsker[]>();
  if (!questionIds.length) return byQuestion;
  const result = await tx.execute<{ question_id: string; receptionist_id: string; name: string; archived: boolean; times_asked: number; last_asked_at: Date | string }>(sql`
    select l.question_id, p.id as receptionist_id, p.name, p.archived_at is not null as archived, l.times_asked, l.last_asked_at
    from public.unanswered_question_receptionists l
    inner join public.receptionist_profiles p on p.business_id = l.business_id and p.id = l.receptionist_id
    where l.business_id = ${businessId}::uuid and l.question_id = any(${sql.param(questionIds)}::uuid[])
    order by l.times_asked desc, l.last_asked_at desc, p.name, p.id
  `);
  for (const row of result.rows) {
    const askers = byQuestion.get(row.question_id) ?? [];
    askers.push({ receptionistId: row.receptionist_id, name: row.name, archived: row.archived, timesAsked: Number(row.times_asked), lastAskedAt: new Date(row.last_asked_at) });
    byQuestion.set(row.question_id, askers);
  }
  return byQuestion;
}

/** How many open questions each receptionist heard, for the filter's list. */
async function countOpenByReceptionist(tx: DatabaseTransaction, businessId: string): Promise<Record<string, number>> {
  const result = await tx.execute<{ receptionist_id: string; open: number }>(sql`
    select l.receptionist_id, count(*)::int as open
    from public.unanswered_question_receptionists l
    inner join public.unanswered_questions q on q.business_id = l.business_id and q.id = l.question_id
    where l.business_id = ${businessId}::uuid and q.status = 'open'
    group by l.receptionist_id
  `);
  return Object.fromEntries(result.rows.map((row) => [row.receptionist_id, Number(row.open)]));
}

/**
 * The business's open questions, most asked first, and how many are open,
 * each with who heard it. receptionistId keeps the questions that
 * receptionist heard, and the count counts those. `openByReceptionist` counts
 * every receptionist's open questions, for the filter. limit (1 to 50, 50
 * without one) and offset pick a page of them. Anyone on the team reads them.
 */
export async function listOpenUnansweredQuestions(
  context: DomainContext,
  input: { userId: string; businessId: string; receptionistId?: string | null | undefined; limit?: number | undefined; offset?: number | undefined },
): Promise<UnansweredQuestionsPage> {
  const { userId, businessId } = input;
  return await withBusinessTransaction(context.db, { userId, businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, { userId, businessId });
    return await listOpenUnansweredQuestionsInTransaction(tx, input);
  });
}

export type UnansweredQuestionsPage = { questions: OpenUnansweredQuestion[]; openCount: number; openByReceptionist: Record<string, number> };

/**
 * listOpenUnansweredQuestions in a transaction whose caller may read the
 * business: the dashboard's members, or an API key. counts: false leaves
 * openByReceptionist empty, for a caller that shows no filter.
 */
export async function listOpenUnansweredQuestionsInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; receptionistId?: string | null | undefined; limit?: number | undefined; offset?: number | undefined; counts?: boolean | undefined },
): Promise<UnansweredQuestionsPage> {
  const { businessId } = input;
  const limit = Number.isFinite(input.limit) ? Math.min(Math.max(Math.trunc(input.limit!), 1), OPEN_QUESTIONS_LIMIT) : OPEN_QUESTIONS_LIMIT;
  const offset = Number.isFinite(input.offset) ? Math.max(Math.trunc(input.offset!), 0) : 0;
  if (input.receptionistId && !isUuid(input.receptionistId)) throw failure("receptionist must be a receptionist id.", 400, "invalid_receptionist");
  const open = and(
    eq(unansweredQuestions.businessId, businessId),
    eq(unansweredQuestions.status, "open"),
    input.receptionistId ? askedOfReceptionist(businessId, input.receptionistId) : undefined,
  );
  const rows = await tx.select({
    id: unansweredQuestions.id,
    question: unansweredQuestions.question,
    timesAsked: unansweredQuestions.timesAsked,
    firstAskedAt: unansweredQuestions.firstAskedAt,
    lastAskedAt: unansweredQuestions.lastAskedAt,
    lastChannel: unansweredQuestions.lastChannel,
    lastCallId: unansweredQuestions.lastCallId,
    lastConversationId: unansweredQuestions.lastConversationId,
  }).from(unansweredQuestions).where(open)
    .orderBy(desc(unansweredQuestions.timesAsked), desc(unansweredQuestions.lastAskedAt), desc(unansweredQuestions.id))
    .limit(limit)
    .offset(offset);
  const [count] = await tx.select({ value: sql<number>`count(*)::int` }).from(unansweredQuestions).where(open);
  const askers = await loadAskers(tx, businessId, rows.map((row) => row.id));
  return {
    questions: rows.map((row) => ({ ...row, askedOf: askers.get(row.id) ?? [] })),
    openCount: count?.value ?? 0,
    openByReceptionist: input.counts === false ? {} : await countOpenByReceptionist(tx, businessId),
  };
}

/**
 * Who an answer is for, from a request body's audience and receptionistIds:
 * everyone when it names none, as before receptionists. Throws a 400 for
 * anything else.
 */
export function readUnansweredAnswerAudience(body: unknown): UnansweredAnswerAudience {
  const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (value.audience === undefined || value.audience === null) return { audience: "everyone" };
  if (value.audience === "asked") return { audience: "asked" };
  return readKnowledgeAudienceChoice(value);
}

/** The receptionists that heard the question and aren't archived, for an answer only they use. */
async function liveAskers(tx: DatabaseTransaction, businessId: string, questionId: string): Promise<string[]> {
  const askers = (await loadAskers(tx, businessId, [questionId])).get(questionId) ?? [];
  return askers.filter((asker) => !asker.archived).map((asker) => asker.receptionistId);
}

async function lockOpenQuestion(tx: DatabaseTransaction, input: { businessId: string; questionId: string }) {
  if (!UUID.test(input.questionId)) throw failure("Question not found.", 404, "not_found");
  const [question] = await tx.select({ id: unansweredQuestions.id, question: unansweredQuestions.question, status: unansweredQuestions.status })
    .from(unansweredQuestions)
    .where(and(eq(unansweredQuestions.id, input.questionId), eq(unansweredQuestions.businessId, input.businessId)))
    .limit(1)
    .for("update");
  if (!question) throw failure("Question not found.", 404, "not_found");
  if (question.status !== "open") throw failure("This question was already answered or dismissed.", 409, "question_resolved");
  return question;
}

/**
 * Saves the answer as a text entry titled with the question, which refreshes
 * the receptionists' snapshot like any new entry, and marks the question
 * answered. The entry is for everyone unless `audience` says otherwise: the
 * receptionists chosen, or only those that heard the question and aren't
 * archived ("asked"), so the other stores of a chain don't start giving one
 * store's answer. Owners and admins answer.
 */
export async function answerUnansweredQuestion(
  context: DomainContext,
  input: { userId: string; businessId: string; questionId: string; answer: string; audience?: UnansweredAnswerAudience | undefined },
): Promise<UnansweredQuestionAnswered> {
  readAnswer(input.answer);
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    return await answerUnansweredQuestionInTransaction(tx, { businessId: input.businessId, actorUserId: input.userId, questionId: input.questionId, answer: input.answer, audience: input.audience });
  });
}

export type UnansweredQuestionAnswered = { snippetId: string; audience: "everyone" | "chosen"; receptionistIds: string[] };

/** An answer as it's saved: trimmed, and refused when it's empty or too long. */
function readAnswer(value: string): string {
  const answer = value.trim();
  if (!answer) throw failure("Write an answer first.", 400, "answer_required");
  if (answer.length > MAX_UNANSWERED_ANSWER_LENGTH) throw failure(`Answers can be up to ${MAX_UNANSWERED_ANSWER_LENGTH} characters.`, 400, "answer_too_long");
  return answer;
}

/** answerUnansweredQuestion in a transaction whose caller may change the business's knowledge. actorUserId resolves it, when a person did. */
export async function answerUnansweredQuestionInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; questionId: string; answer: string; audience?: UnansweredAnswerAudience | undefined },
): Promise<UnansweredQuestionAnswered> {
  const answer = readAnswer(input.answer);
  const question = await lockOpenQuestion(tx, input);
  let choice: KnowledgeAudienceChoice = input.audience?.audience === "chosen" ? input.audience : { audience: "everyone" };
  if (input.audience?.audience === "asked") {
    const receptionistIds = await liveAskers(tx, input.businessId, question.id);
    if (!receptionistIds.length) throw failure("No receptionist that asked is left to answer. Choose who the answer is for.", 409, "no_receptionists_asked");
    choice = { audience: "chosen", receptionistIds };
  }
  const snippet = await createKnowledgeSnippetInTransaction(tx, { businessId: input.businessId, title: question.question, content: answer });
  if (choice.audience === "chosen") {
    await setKnowledgeArticleAudienceInTransaction(tx, { businessId: input.businessId, actorUserId: input.actorUserId, kind: "snippet", articleId: snippet.id, choice });
  }
  const now = new Date();
  await tx.update(unansweredQuestions)
    .set({ status: "answered", answeredAt: now, knowledgeSnippetId: snippet.id, resolvedByUserId: input.actorUserId, updatedAt: now })
    .where(and(eq(unansweredQuestions.id, question.id), eq(unansweredQuestions.businessId, input.businessId)));
  return { snippetId: snippet.id, audience: choice.audience, receptionistIds: choice.audience === "chosen" ? choice.receptionistIds : [] };
}

/** Takes an open question off the list. Asked again, it counts on its dismissed row and stays off until it expires with other caller content. Owners and admins dismiss. */
export async function dismissUnansweredQuestion(
  context: DomainContext,
  input: { userId: string; businessId: string; questionId: string },
): Promise<void> {
  await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    await dismissUnansweredQuestionInTransaction(tx, { businessId: input.businessId, actorUserId: input.userId, questionId: input.questionId });
  });
}

/** dismissUnansweredQuestion in a transaction whose caller may change the business's knowledge. */
export async function dismissUnansweredQuestionInTransaction(tx: DatabaseTransaction, input: { businessId: string; actorUserId: string | null; questionId: string }): Promise<void> {
  const question = await lockOpenQuestion(tx, input);
  const now = new Date();
  await tx.update(unansweredQuestions)
    .set({ status: "dismissed", dismissedAt: now, resolvedByUserId: input.actorUserId, updatedAt: now })
    .where(and(eq(unansweredQuestions.id, question.id), eq(unansweredQuestions.businessId, input.businessId)));
}
