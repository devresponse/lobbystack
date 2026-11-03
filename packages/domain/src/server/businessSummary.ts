import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";

import { countKnowledgeTokens } from "../knowledgeRanking";
import { businesses, enqueueOutbox, knowledgeChunks, knowledgeDocuments, knowledgeSnippets, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";

import type { DomainContext } from "./context";
import { copySharedSettingsToDefaultReceptionist } from "./receptionistProfile";

// The worker writes the business summary with AI from the business's knowledge
// sources: its text entries, uploaded documents and website pages. The
// summary is the business's, shared by every receptionist, so it is written
// from the articles for everyone only. Knowledge
// often changes in bursts (a website import indexes up to 50 pages), so a
// change schedules one regeneration a few minutes later instead of one per
// page. All changes inside the same five-minute window share one job.
const SUMMARY_WINDOW_MS = 5 * 60_000;
const SUMMARY_DELAY_MS = 2 * 60_000;
// What the summarizer reads: the start of each source, within a token budget.
const SUMMARY_SOURCE_TOKENS = 6_000;
const SUMMARY_MAX_DOCUMENTS = 30;
const SUMMARY_CHUNKS_PER_DOCUMENT = 2;
const SUMMARY_MAX_SNIPPETS = 20;

export type BusinessSummarySource = { title: string; text: string };
export type SummarySource = "placeholder" | "generated" | "operator";

/** Schedules a summary regeneration after knowledge changed. Call it in the same transaction as the change. */
export async function enqueueBusinessSummaryRefresh(tx: DatabaseTransaction, input: { businessId: string; reason: string; now?: number }): Promise<void> {
  const now = input.now ?? Date.now();
  const window = Math.floor(now / SUMMARY_WINDOW_MS);
  await enqueueOutbox(tx, {
    topic: "business.generateSummary",
    businessId: input.businessId,
    aggregateType: "business",
    aggregateId: input.businessId,
    dedupeKey: `business-summary:${input.businessId}:${window}`,
    availableAt: new Date((window + 1) * SUMMARY_WINDOW_MS + SUMMARY_DELAY_MS),
    payload: { businessId: input.businessId, reason: input.reason },
  });
}

export type BusinessSummaryInput = {
  businessName: string;
  locale: string;
  summarySource: SummarySource;
  /** Identifies the sources, so an unchanged knowledge base isn't summarized twice. */
  fingerprint: string;
  currentFingerprint: string | null;
  sources: BusinessSummarySource[];
};

/**
 * The knowledge to summarize: text entries first, then the start of each
 * indexed document, within a token budget. The summary describes the whole
 * business to every receptionist, so it reads only articles for everyone:
 * an article chosen for some receptionists, such as one store's page, stays
 * theirs.
 */
export async function loadBusinessSummaryInput(context: DomainContext, input: { businessId: string }): Promise<BusinessSummaryInput | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [business] = await tx.select({ name: businesses.name, defaultLocale: businesses.defaultLocale, summarySource: businesses.summarySource, summaryFingerprint: businesses.summaryFingerprint }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
    if (!business) return null;
    const snippets = await tx.select({ title: knowledgeSnippets.title, content: knowledgeSnippets.content }).from(knowledgeSnippets)
      .where(and(eq(knowledgeSnippets.businessId, input.businessId), eq(knowledgeSnippets.active, true), eq(knowledgeSnippets.audience, "everyone")))
      .orderBy(desc(knowledgeSnippets.priority), asc(knowledgeSnippets.createdAt)).limit(SUMMARY_MAX_SNIPPETS);
    // Uploads first, then website pages in the order they were imported, which
    // puts the home page near the front.
    const documents = await tx.select({ id: knowledgeDocuments.id, title: knowledgeDocuments.title }).from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.businessId, input.businessId), eq(knowledgeDocuments.active, true), eq(knowledgeDocuments.status, "indexed"), eq(knowledgeDocuments.audience, "everyone")))
      .orderBy(sql`case when ${knowledgeDocuments.sourceType} = 'upload' then 0 else 1 end`, asc(knowledgeDocuments.createdAt)).limit(SUMMARY_MAX_DOCUMENTS);
    const chunks = documents.length
      ? await tx.select({ documentId: knowledgeChunks.documentId, content: knowledgeChunks.content }).from(knowledgeChunks)
        .where(and(eq(knowledgeChunks.businessId, input.businessId), inArray(knowledgeChunks.documentId, documents.map((document) => document.id)), lt(knowledgeChunks.sequence, SUMMARY_CHUNKS_PER_DOCUMENT)))
        .orderBy(asc(knowledgeChunks.sequence))
      : [];
    const candidates: BusinessSummarySource[] = [
      ...snippets.map((snippet) => ({ title: snippet.title, text: snippet.content.trim() })),
      ...documents.map((document) => ({ title: document.title, text: chunks.filter((chunk) => chunk.documentId === document.id).map((chunk) => chunk.content.trim()).join("\n") })),
    ].filter((source) => source.text);
    const sources: BusinessSummarySource[] = [];
    let budget = SUMMARY_SOURCE_TOKENS;
    for (const source of candidates) {
      const cost = countKnowledgeTokens(`${source.title}\n${source.text}\n`);
      if (cost > budget) continue;
      sources.push(source);
      budget -= cost;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify([business.name, business.defaultLocale, sources])).digest("hex");
    return {
      businessName: business.name,
      locale: business.defaultLocale,
      summarySource: business.summarySource,
      fingerprint,
      currentFingerprint: business.summaryFingerprint,
      sources,
    };
  });
}

/**
 * Puts the placeholder back when a generated summary has no sources left, so
 * GPT-Live stops describing knowledge the business removed.
 */
export async function resetGeneratedBusinessSummary(context: DomainContext, input: { businessId: string; businessName: string }): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const values = { summary: input.businessName.trim(), summarySource: "placeholder" as const, summaryFingerprint: null, summaryGeneratedAt: null };
    const updated = await tx.update(businesses)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(businesses.id, input.businessId), eq(businesses.summarySource, "generated")))
      .returning({ id: businesses.id });
    if (!updated[0]) return false;
    await copySharedSettingsToDefaultReceptionist(tx, input.businessId, values);
    await enqueueOutbox(tx, {
      topic: "snapshot.refresh",
      businessId: input.businessId,
      aggregateType: "business",
      aggregateId: input.businessId,
      dedupeKey: `business-summary:${input.businessId}:snapshot:reset:${Date.now()}`,
      payload: { businessId: input.businessId, reason: "summary_reset" },
    });
    return true;
  });
}

/** Saves a generated summary unless an operator wrote one meanwhile, and refreshes the snapshot. */
export async function saveGeneratedBusinessSummary(context: DomainContext, input: { businessId: string; summary: string; fingerprint: string }): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const values = { summary: input.summary, summarySource: "generated" as const, summaryFingerprint: input.fingerprint, summaryGeneratedAt: new Date() };
    const updated = await tx.update(businesses)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(businesses.id, input.businessId), ne(businesses.summarySource, "operator")))
      .returning({ id: businesses.id });
    if (!updated[0]) return false;
    await copySharedSettingsToDefaultReceptionist(tx, input.businessId, values);
    await enqueueOutbox(tx, {
      topic: "snapshot.refresh",
      businessId: input.businessId,
      aggregateType: "business",
      aggregateId: input.businessId,
      dedupeKey: `business-summary:${input.businessId}:snapshot:${input.fingerprint}:${Date.now()}`,
      payload: { businessId: input.businessId, reason: "summary_generated" },
    });
    return true;
  });
}
