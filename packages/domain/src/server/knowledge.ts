import { createHash } from "node:crypto";

import { and, asc, desc, eq, ilike, lt, ne, sql, type SQL } from "drizzle-orm";

import { agentRules, businessContextSnapshots, businessHours, businesses, businessPublicProfiles, closures, enqueueOutbox, knowledgeChunks, knowledgeDocuments, knowledgeSnippets, phoneNumbers, services, storageObjects, websiteIngestionJobs, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { FULL_CRAWL_PAGE_LIMIT, isUuid, normalizeAppointmentChangePolicy, normalizeBookingMode, normalizeRuntimeLocale, normalizeTransferMode, ONBOARDING_CRAWL_PAGE_LIMIT, publicProfilePath, type BusinessContextSnapshot } from "@lobbystack/shared";
import { buildBusinessContextSnapshot, knowledgeDigestOf } from "../snapshot";
import { countKnowledgeTokens, KNOWLEDGE_SEARCH_TOKEN_BUDGET, knowledgeLexicalQueries, knowledgeQueryTerms, rankKnowledgeCandidates, withinKnowledgeBudget, type KnowledgePassage, type RankedKnowledgeCandidate } from "../knowledgeRanking";

import { requireBusinessAdmin, requireBusinessMembership } from "../authz";
import type { DomainContext } from "./context";
import { normalizeWebsiteSourceUrl } from "./knowledgeUrl";
import { getMeter } from "@lobbystack/telemetry/node";
import { getPostHogDistinctIdForBusinessSystem } from "@lobbystack/telemetry";
import { moveOnboardingStageInTransaction } from "./onboarding";
import { recordProductEventBestEffort } from "./productEvents";
import { enqueueKnowledgeDerivedRefresh } from "./businessHours";
import { loadBusinessPlanLimits } from "./usage";
import { resolveSmsSender } from "./smsSender";
import { addWebsiteImportRulesInTransaction, applyWebsiteRulesInTransaction, setKnowledgeArticleAudienceInTransaction, type KnowledgeAudienceChoice, type RankedReceptionist, type WebsiteImportRule } from "./knowledgeAudience";
import { loadSnapshotKnowledge, loadSnapshotReceptionistRows, rankedReceptionistOf, snapshotReceptionistOf } from "./snapshotKnowledge";

const ragMeter = getMeter("lobbystack-rag");
const searchDuration = ragMeter.createHistogram("rag.search.duration_ms", { unit: "ms" });
const searchResultCount = ragMeter.createHistogram("rag.search.result_count", { unit: "{result}" });
const snapshotRefreshDuration = ragMeter.createHistogram("rag.snapshot_refresh.duration_ms", { unit: "ms" });

export { normalizeWebsiteSourceUrl } from "./knowledgeUrl";

export function chunkText(text: string, options: { maxCharacters?: number; overlap?: number } = {}): string[] {
  const maxCharacters = options.maxCharacters ?? 1800;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 2 || (options.overlap ?? 180) < 0) throw new Error("Invalid chunk size or overlap.");
  const overlap = Math.min(options.overlap ?? 180, Math.floor(maxCharacters / 2));
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) {
    return [];
  }
  const chunks: string[] = [];
  // Keep Markdown sections separate, including headings in previously flattened imports.
  for (const section of normalized.split(/(?<=\s)(?=#{1,6} )/)) {
    const sectionText = section.trim();
    let start = 0;
    while (start < sectionText.length) {
      let end = Math.min(sectionText.length, start + maxCharacters);
      if (end < sectionText.length) {
        const boundary = sectionText.lastIndexOf("\n", end);
        const wordBoundary = sectionText.lastIndexOf(" ", end);
        if (boundary > start + maxCharacters / 2) end = boundary;
        else if (wordBoundary > start + maxCharacters / 2) end = wordBoundary;
      }
      const chunk = sectionText.slice(start, end).trim();
      if (chunk) {
        chunks.push(chunk);
      }
      if (end >= sectionText.length) {
        break;
      }
      start = Math.max(start + 1, end - overlap);
    }
  }
  return chunks;
}

export function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// The API reports a website's page limit, so its clients tell a sample from a full read by these.
export { FULL_CRAWL_PAGE_LIMIT, ONBOARDING_CRAWL_PAGE_LIMIT };

/**
 * Adds a knowledge source for an owner or admin. websiteRules, for a website,
 * give its pages under each path to a receptionist, made in the same
 * transaction so the crawl, which starts once it commits, follows them from
 * its first page.
 */
export async function createKnowledgeDocument(
  context: DomainContext,
  input: { userId: string; businessId: string; title: string; sourceType: string; sourceUrl?: string; storageObjectId?: string; onboarding?: boolean; websiteRules?: WebsiteImportRule[] },
): Promise<string> {
  if (input.websiteRules?.length && input.sourceType !== "website") throw Object.assign(new Error("Website rules apply to a website."), { status: 400, code: "invalid_website_rule" });
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const documentId = await createKnowledgeDocumentInTransaction(tx, input);
    if (input.websiteRules?.length) await addWebsiteImportRulesInTransaction(tx, { businessId: input.businessId, actorUserId: input.userId, rootDocumentId: documentId, rules: input.websiteRules });
    return documentId;
  });
}

/**
 * Adds a website or an uploaded file as a knowledge source and queues its
 * crawl or extraction. The caller checks who may do that. onboarding (or a
 * business still on its website step) also saves the URL as the business's
 * website; onboarding or sample limit the crawl to a sample of the site.
 * The dashboard's onboarding no longer sends onboarding: its website step only
 * saves the address (saveOnboardingWebsite) and reads nothing. The API and the
 * CLI still read a site here when asked to.
 * Submitting a website that is already a source returns that source.
 */
export async function createKnowledgeDocumentInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; title: string; sourceType: string; sourceUrl?: string | undefined; storageObjectId?: string | undefined; onboarding?: boolean | undefined; sample?: boolean | undefined },
): Promise<string> {
  const isWebsite = input.sourceType === "website";
  if (isWebsite && !input.sourceUrl) {
    throw new Error("A website source URL is required.");
  }
  if (!isWebsite && !input.storageObjectId) {
    throw new Error("A storage object is required for uploaded knowledge.");
  }
  const sourceUrl = isWebsite ? normalizeWebsiteSourceUrl(input.sourceUrl!) : input.sourceUrl;
  const crawlLimit = input.onboarding || input.sample ? ONBOARDING_CRAWL_PAGE_LIMIT : FULL_CRAWL_PAGE_LIMIT;
  // Serialize website submissions so retries/revisited forms reuse the same import.
  const business = isWebsite
    ? (await tx.select({ onboardingStage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1).for("update"))[0]
    : undefined;
  if (isWebsite && (input.onboarding || business?.onboardingStage === "website")) {
    await tx.update(businesses).set({ websiteUrl: sourceUrl!, updatedAt: new Date() }).where(eq(businesses.id, input.businessId));
    if (business?.onboardingStage === "website") {
      await moveOnboardingStageInTransaction(tx, { businessId: input.businessId, from: "website", to: "knowledge" });
    }
  }
  if (isWebsite) {
    const existing = (await tx.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.businessId, input.businessId), eq(knowledgeDocuments.sourceUrl, sourceUrl!))).limit(1).for("update"))[0];
    if (existing) {
      // A retry of an onboarding submission is still onboarding: without the
      // limit it would fall back to the full crawl this sampling exists to defer.
      if (["cancelled", "error"].includes(existing.status)) await queueKnowledgeDocumentRetry(tx, { businessId: input.businessId, documentId: existing.id, crawlLimit }, existing);
      return existing.id;
    }
  }
  const [document] = await tx.insert(knowledgeDocuments).values({
    businessId: input.businessId,
    title: input.title.trim(),
    sourceType: input.sourceType,
    sourceUrl,
    storageObjectId: input.storageObjectId,
    status: isWebsite ? "processing" : "pending",
  }).returning({ id: knowledgeDocuments.id });
  if (!document) {
    throw new Error("Knowledge document could not be created.");
  }
  const ingestion = isWebsite ? (await tx.insert(websiteIngestionJobs).values({ businessId: input.businessId, rootDocumentId: document.id, websiteUrl: sourceUrl!, provider: "firecrawl", status: "queued", pageLimit: crawlLimit }).returning({ id: websiteIngestionJobs.id }))[0] : undefined;
  await enqueueOutbox(tx, {
    topic: isWebsite ? "knowledge.crawlWebsite" : "knowledge.extractDocument",
    businessId: input.businessId,
    aggregateType: "knowledge_document",
    aggregateId: document.id,
    dedupeKey: isWebsite ? `knowledge:${document.id}:crawl` : `knowledge:${document.id}:extract`,
    payload: isWebsite
      ? { url: sourceUrl, documentId: document.id, revision: 0, websiteIngestionJobId: ingestion!.id, limit: crawlLimit }
      : { documentId: document.id, revision: 0 },
  });
  return document.id;
}

export async function listKnowledgeSnippets(context: DomainContext, input: { userId: string; businessId: string }) {
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, input);
    return await tx.select().from(knowledgeSnippets).where(eq(knowledgeSnippets.businessId, input.businessId)).orderBy(desc(knowledgeSnippets.priority), asc(knowledgeSnippets.title));
  });
}

async function queueKnowledgeDocumentRetry(tx: DatabaseTransaction, input: { businessId: string; documentId: string; crawlLimit?: number | undefined }, document: Pick<typeof knowledgeDocuments.$inferSelect, "id" | "sourceType" | "sourceUrl" | "revision">): Promise<void> {
    await tx.update(knowledgeDocuments).set({ status: document.sourceType === "website" ? "processing" : "pending", processingProgress: 0, error: null, revision: sql`${knowledgeDocuments.revision} + 1`, updatedAt: new Date() }).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId)));
    const retryLimit = input.crawlLimit ?? FULL_CRAWL_PAGE_LIMIT;
    const ingestion = document.sourceType === "website" && document.sourceUrl ? (await tx.insert(websiteIngestionJobs).values({ businessId: input.businessId, rootDocumentId: input.documentId, websiteUrl: document.sourceUrl, provider: "firecrawl", status: "queued", pageLimit: retryLimit }).onConflictDoUpdate({ target: websiteIngestionJobs.rootDocumentId, set: { status: "queued", importedCount: 0, indexedCount: 0, errorCount: 0, lastError: null, pageLimit: retryLimit, updatedAt: new Date() } }).returning({ id: websiteIngestionJobs.id }))[0] : undefined;
    await enqueueOutbox(tx, { topic: document.sourceType === "website" ? "knowledge.crawlWebsite" : "knowledge.extractDocument", businessId: input.businessId, aggregateType: "knowledge_document", aggregateId: input.documentId, dedupeKey: `knowledge:${input.documentId}:retry:${document.revision + 1}`, payload: document.sourceType === "website" && document.sourceUrl ? { documentId: input.documentId, url: document.sourceUrl, revision: document.revision + 1, websiteIngestionJobId: ingestion!.id, limit: retryLimit } : { documentId: input.documentId, revision: document.revision + 1 } });
}

export async function retryKnowledgeDocument(context: DomainContext, input: { userId: string; businessId: string; documentId: string }): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    if (!(await retryKnowledgeDocumentInTransaction(tx, input))) throw new Error("Knowledge document not found.");
  });
}

/**
 * Queues a source's crawl or extraction again, crawling up to crawlLimit pages
 * (the full limit by default). False when the business has no such document.
 */
export async function retryKnowledgeDocumentInTransaction(tx: DatabaseTransaction, input: { businessId: string; documentId: string; crawlLimit?: number | undefined }): Promise<boolean> {
  const document = (await tx.select({ id: knowledgeDocuments.id, sourceType: knowledgeDocuments.sourceType, sourceUrl: knowledgeDocuments.sourceUrl, revision: knowledgeDocuments.revision }).from(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId))).limit(1).for("update"))[0];
  if (!document) return false;
  await queueKnowledgeDocumentRetry(tx, input, document);
  return true;
}

/**
 * Reads the rest of a site that was only sampled, as the API's first read of
 * a site is. Re-crawling at the full limit replaces the partial import rather
 * than adding a second copy.
 */
export async function expandWebsiteCrawl(context: DomainContext, input: { userId: string; businessId: string; documentId: string }): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    await expandWebsiteCrawlInTransaction(tx, input);
  });
}

export async function expandWebsiteCrawlInTransaction(tx: DatabaseTransaction, input: { businessId: string; documentId: string }): Promise<void> {
  const document = (await tx.select({ id: knowledgeDocuments.id, sourceType: knowledgeDocuments.sourceType, sourceUrl: knowledgeDocuments.sourceUrl, revision: knowledgeDocuments.revision }).from(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId))).limit(1).for("update"))[0];
  if (!document) throw Object.assign(new Error("Knowledge document not found."), { status: 404 });
  if (document.sourceType !== "website" || !document.sourceUrl) throw Object.assign(new Error("Only a website import can be read further."), { status: 400 });
  await queueKnowledgeDocumentRetry(tx, { ...input, crawlLimit: FULL_CRAWL_PAGE_LIMIT }, document);
}

export async function setKnowledgeDocumentActive(context: DomainContext, input: { userId: string; businessId: string; documentId: string; active: boolean }): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async tx => {
    await requireBusinessAdmin(tx, input);
    if (!await setKnowledgeDocumentActiveInTransaction(tx, input)) throw Object.assign(new Error("Knowledge document not found."), { status: 404 });
  });
}

/** Turns a document on or off for the receptionist. False when the business has no such document. Callers authorize first. */
export async function setKnowledgeDocumentActiveInTransaction(tx: DatabaseTransaction, input: { businessId: string; documentId: string; active: boolean }): Promise<boolean> {
  const [document] = await tx.update(knowledgeDocuments).set({ active: input.active, updatedAt: new Date() }).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId))).returning({ id: knowledgeDocuments.id });
  if (!document) return false;
  await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "knowledge_document", aggregateId: input.documentId, dedupeKey: `knowledge:${input.documentId}:active:${Date.now()}`, payload: { businessId: input.businessId, reason: "document_activity_changed" } });
  await enqueueKnowledgeDerivedRefresh(tx, { businessId: input.businessId, reason: "document_activity_changed" });
  return true;
}

export async function cancelKnowledgeDocument(context: DomainContext, input: { userId: string; businessId: string; documentId: string }): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    await cancelKnowledgeDocumentInTransaction(tx, input);
  });
}

export async function cancelKnowledgeDocumentInTransaction(tx: DatabaseTransaction, input: { businessId: string; documentId: string }): Promise<void> {
  const [document] = await tx.update(knowledgeDocuments).set({ status: "cancelled", revision: sql`${knowledgeDocuments.revision} + 1`, error: "Cancelled by operator.", updatedAt: new Date() }).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId), eq(knowledgeDocuments.status, "processing"))).returning({ id: knowledgeDocuments.id });
  if (!document) throw Object.assign(new Error("Only a processing knowledge document can be cancelled."), { status: 409 });
  await tx.update(websiteIngestionJobs).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(websiteIngestionJobs.businessId, input.businessId), eq(websiteIngestionJobs.rootDocumentId, input.documentId)));
}

export async function getKnowledgeDocumentContent(context: DomainContext, input: { userId: string; businessId: string; documentId: string }): Promise<{ document: Record<string, unknown>; content: string } | null> {
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, input);
    const document = (await tx.select({ id: knowledgeDocuments.id, title: knowledgeDocuments.title, sourceType: knowledgeDocuments.sourceType, sourceUrl: knowledgeDocuments.sourceUrl, status: knowledgeDocuments.status, mimeType: knowledgeDocuments.mimeType, fileName: storageObjects.fileName, contentLength: storageObjects.contentLength, updatedAt: knowledgeDocuments.updatedAt }).from(knowledgeDocuments).leftJoin(storageObjects, eq(knowledgeDocuments.storageObjectId, storageObjects.id)).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId))).limit(1))[0];
    if (!document) return null;
    const chunks = await tx.select({ content: knowledgeChunks.content }).from(knowledgeChunks).where(and(eq(knowledgeChunks.documentId, input.documentId), eq(knowledgeChunks.businessId, input.businessId))).orderBy(asc(knowledgeChunks.sequence));
    return { document, content: chunks.map((chunk) => chunk.content.trim()).filter(Boolean).join("\n\n") };
  });
}

export async function deleteKnowledgeDocument(context: DomainContext, input: { userId: string; businessId: string; documentId: string }): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    if (!await deleteKnowledgeDocumentInTransaction(tx, input)) throw new Error("Knowledge document not found.");
  });
}

/** Deletes a document and its indexed text. False when the business has no such document. Callers authorize first. */
export async function deleteKnowledgeDocumentInTransaction(tx: DatabaseTransaction, input: { businessId: string; documentId: string }): Promise<boolean> {
  await tx.delete(knowledgeChunks).where(and(eq(knowledgeChunks.documentId, input.documentId), eq(knowledgeChunks.businessId, input.businessId)));
  const [document] = await tx.delete(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId))).returning({ id: knowledgeDocuments.id });
  if (!document) return false;
  await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "knowledge_document", aggregateId: document.id, dedupeKey: `knowledge:${document.id}:deleted:${Date.now()}`, payload: { businessId: input.businessId, reason: "document_deleted" } });
  await enqueueKnowledgeDerivedRefresh(tx, { businessId: input.businessId, reason: "document_deleted" });
  return true;
}

/**
 * Adds a text entry for an owner or admin: for everyone unless audience
 * chooses receptionists, set in the same transaction so the entry is never
 * for everyone by mistake.
 */
export async function createKnowledgeSnippet(
  context: DomainContext,
  input: { userId: string; businessId: string; title: string; content: string; tags?: string[]; priority?: number; active?: boolean; audience?: KnowledgeAudienceChoice | undefined },
): Promise<string> {
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const { id } = await createKnowledgeSnippetInTransaction(tx, input);
    if (input.audience?.audience === "chosen") await setKnowledgeArticleAudienceInTransaction(tx, { businessId: input.businessId, actorUserId: input.userId, kind: "snippet", articleId: id, choice: input.audience });
    return id;
  });
}

/** Inserts a snippet and refreshes the receptionist snapshot. Callers authorize first. */
export async function createKnowledgeSnippetInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; title: string; content: string; tags?: string[]; priority?: number; active?: boolean },
): Promise<typeof knowledgeSnippets.$inferSelect> {
  const [snippet] = await tx.insert(knowledgeSnippets).values({ businessId: input.businessId, title: input.title.trim(), content: input.content.trim(), tags: input.tags ?? [], priority: input.priority ?? 0, active: input.active ?? true }).returning();
  if (!snippet) throw new Error("Knowledge snippet could not be created.");
  await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "knowledge_snippet", aggregateId: snippet.id, dedupeKey: `knowledge-snippet:${snippet.id}:snapshot:${Date.now()}`, payload: { businessId: input.businessId, reason: "snippet_created" } });
  await enqueueKnowledgeDerivedRefresh(tx, { businessId: input.businessId, reason: "snippet_created" });
  return snippet;
}

/** Changes a text entry for an owner or admin, and who it is for when audience is given, in one transaction. */
export async function updateKnowledgeSnippet(
  context: DomainContext,
  input: { userId: string; businessId: string; snippetId: string; title?: string; content?: string; tags?: string[]; priority?: number; active?: boolean; audience?: KnowledgeAudienceChoice | undefined },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    if (!await updateKnowledgeSnippetInTransaction(tx, input)) throw new Error("Knowledge snippet not found.");
    if (input.audience) await setKnowledgeArticleAudienceInTransaction(tx, { businessId: input.businessId, actorUserId: input.userId, kind: "snippet", articleId: input.snippetId, choice: input.audience });
  });
}

/** Changes the fields given and refreshes the receptionist snapshot. Null when the business has no such snippet. Callers authorize first. */
export async function updateKnowledgeSnippetInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; snippetId: string; title?: string | undefined; content?: string | undefined; tags?: string[] | undefined; priority?: number | undefined; active?: boolean | undefined },
): Promise<typeof knowledgeSnippets.$inferSelect | null> {
  const [snippet] = await tx.update(knowledgeSnippets).set({ ...(input.title !== undefined ? { title: input.title.trim() } : {}), ...(input.content !== undefined ? { content: input.content.trim() } : {}), tags: input.tags, priority: input.priority, active: input.active, updatedAt: new Date() }).where(and(eq(knowledgeSnippets.id, input.snippetId), eq(knowledgeSnippets.businessId, input.businessId))).returning();
  if (!snippet) return null;
  await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "knowledge_snippet", aggregateId: snippet.id, dedupeKey: `knowledge-snippet:${snippet.id}:snapshot:${Date.now()}`, payload: { businessId: input.businessId, reason: "snippet_updated" } });
  await enqueueKnowledgeDerivedRefresh(tx, { businessId: input.businessId, reason: "snippet_updated" });
  return snippet;
}

export async function deleteKnowledgeSnippet(context: DomainContext, input: { userId: string; businessId: string; snippetId: string }): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    if (!await deleteKnowledgeSnippetInTransaction(tx, input)) throw new Error("Knowledge snippet not found.");
  });
}

/** Deletes a snippet and refreshes the receptionist snapshot. False when the business has no such snippet. Callers authorize first. */
export async function deleteKnowledgeSnippetInTransaction(tx: DatabaseTransaction, input: { businessId: string; snippetId: string }): Promise<boolean> {
  const [snippet] = await tx.delete(knowledgeSnippets).where(and(eq(knowledgeSnippets.id, input.snippetId), eq(knowledgeSnippets.businessId, input.businessId))).returning({ id: knowledgeSnippets.id });
  if (!snippet) return false;
  await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "knowledge_snippet", aggregateId: snippet.id, dedupeKey: `knowledge-snippet:${snippet.id}:snapshot:${Date.now()}`, payload: { businessId: input.businessId, reason: "snippet_deleted" } });
  await enqueueKnowledgeDerivedRefresh(tx, { businessId: input.businessId, reason: "snippet_deleted" });
  return true;
}

type IndexDocumentInput = { businessId: string; documentId: string; text: string; embeddings: number[][]; embeddingFingerprint?: string };

type IndexDocumentResult = { chunkCount: number; indexed: boolean; documentId: string };

async function recordKnowledgeDocumentIndexed(context: DomainContext, input: { businessId: string; documentId: string }): Promise<void> {
  await recordProductEventBestEffort(context, {
    name: "knowledge.document_indexed",
    businessId: input.businessId,
    distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
    actorType: "worker",
    properties: { documentId: input.documentId },
  });
}

export async function indexDocumentText(context: DomainContext, input: IndexDocumentInput): Promise<{ chunkCount: number }> {
  const result = await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, (tx) => indexDocumentTextInTransaction(tx, input));
  if (result.indexed) await recordKnowledgeDocumentIndexed(context, { businessId: input.businessId, documentId: result.documentId });
  return { chunkCount: result.chunkCount };
}

/** Rebuild stored evidence without fetching the source or overwriting a concurrent edit. */
async function indexDocumentTextInTransaction(tx: DatabaseTransaction, input: IndexDocumentInput, preserveImport = false): Promise<IndexDocumentResult> {
    const document = (await tx.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId))).limit(1).for("update"))[0];
    if (!document) {
      throw new Error("Knowledge document not found.");
    }
    if (document.status === "cancelled") return { chunkCount: 0, indexed: false, documentId: input.documentId };
    const chunks = chunkText(input.text);
    if (chunks.length === 0) {
      await markKnowledgeDocumentFailedInTransaction(tx, input, document.revision, "No readable text was extracted from the document.");
      throw new Error("No readable text was extracted from the document.");
    }
    if (input.embeddings.length !== chunks.length || input.embeddings.some((embedding) => embedding.length === 0)) {
      await markKnowledgeDocumentFailedInTransaction(tx, input, document.revision, "Knowledge embeddings are unavailable or incomplete.");
      throw new Error("Knowledge embeddings are unavailable or incomplete.");
    }
    const limit = (await loadBusinessPlanLimits(tx, input.businessId)).limits.knowledgeStorageBytes;
    if (limit !== null) {
      // A business's documents check the limit one at a time, so each counts the text the others indexed.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-storage:${input.businessId}`}, 0))`);
      const newBytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk, "utf8"), 0);
      if (await getKnowledgeStorageUsageBytes(tx, input.businessId, { excludeDocumentId: input.documentId }) + newBytes > limit) {
        // Retrying can't fit the text, so fail the document instead of throwing.
        await markKnowledgeDocumentFailedInTransaction(tx, input, document.revision, knowledgeStorageLimitMessage(limit));
        return { chunkCount: 0, indexed: false, documentId: input.documentId };
      }
    }
    await tx.delete(knowledgeChunks).where(and(eq(knowledgeChunks.documentId, input.documentId), eq(knowledgeChunks.businessId, input.businessId)));
    if (chunks.length > 0) {
      await tx.insert(knowledgeChunks).values(chunks.map((content, sequence) => ({
        businessId: input.businessId,
        documentId: input.documentId,
        sequence,
        content,
        contentHash: hashContent(content),
        embedding: input.embeddings[sequence]!,
        ...(input.embeddingFingerprint ? { embeddingFingerprint: input.embeddingFingerprint } : {}),
        embeddingStatus: input.embeddingFingerprint ? "completed" : "pending",
        embeddingError: null,
      })));
    }
    await tx.update(knowledgeDocuments).set({ status: preserveImport ? "processing" : "indexed", processingProgress: 100, contentHash: hashContent(input.text), revision: document.revision + (preserveImport ? 0 : 1), updatedAt: new Date() }).where(eq(knowledgeDocuments.id, input.documentId));
    if (!preserveImport) await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "knowledge_document", aggregateId: input.documentId, dedupeKey: `knowledge:${input.documentId}:snapshot:${document.revision + 1}`, payload: { businessId: input.businessId, reason: "document_indexed" } });
    if (!preserveImport) await enqueueKnowledgeDerivedRefresh(tx, { businessId: input.businessId, reason: "document_indexed" });
    await enqueueOutbox(tx, {
      topic: "realtime.publish",
      businessId: input.businessId,
      aggregateType: "knowledge_document",
      aggregateId: input.documentId,
      dedupeKey: `knowledge:${input.documentId}:progress:${document.revision + 1}`,
      payload: { type: "document.progressed", entityId: input.documentId, progress: 100 },
    });
    return { chunkCount: chunks.length, indexed: !preserveImport, documentId: input.documentId };
}

/** Commit a crawled page only while its originating import is still current. */
export async function indexCrawledWebsitePage(context: DomainContext, input: IndexDocumentInput & { sourceRevision: number; sourceUrl: string; title: string }): Promise<{ chunkCount: number }> {
  const result = await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx): Promise<IndexDocumentResult> => {
    const [source] = await tx.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId))).limit(1).for("update");
    if (!source || source.status !== "processing" || source.revision !== input.sourceRevision) return { chunkCount: 0, indexed: false, documentId: input.documentId };
    const sourceUrl = normalizeWebsiteSourceUrl(input.sourceUrl);
    const [page] = await tx.insert(knowledgeDocuments).values({ businessId: input.businessId, sourceType: "website", title: input.title, sourceUrl, status: "processing" }).onConflictDoUpdate({ target: [knowledgeDocuments.businessId, knowledgeDocuments.sourceUrl], set: { title: input.title, status: "processing", error: null, updatedAt: new Date() } }).returning({ id: knowledgeDocuments.id });
    if (!page) throw new Error("Website page could not be saved.");
    const indexed = await indexDocumentTextInTransaction(tx, { ...input, documentId: page.id }, page.id === source.id);
    // The site's rules give the page to their receptionists, on every crawl.
    await applyWebsiteRulesInTransaction(tx, { businessId: input.businessId, rootDocumentId: source.id, documentIds: [page.id] });
    return indexed;
  });
  if (result.indexed) await recordKnowledgeDocumentIndexed(context, { businessId: input.businessId, documentId: result.documentId });
  return { chunkCount: result.chunkCount };
}

async function markKnowledgeDocumentFailedInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; documentId: string },
  revision: number,
  error: string,
): Promise<void> {
  await tx.update(knowledgeDocuments).set({ status: "error", processingProgress: 0, error, revision: revision + 1, updatedAt: new Date() }).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId)));
  await tx.update(websiteIngestionJobs).set({ status: "failed", errorCount: 1, lastError: error, updatedAt: new Date() }).where(and(eq(websiteIngestionJobs.rootDocumentId, input.documentId), eq(websiteIngestionJobs.businessId, input.businessId)));
  await enqueueOutbox(tx, {
    topic: "realtime.publish",
    businessId: input.businessId,
    aggregateType: "knowledge_document",
    aggregateId: input.documentId,
    dedupeKey: `knowledge:${input.documentId}:error:${revision + 1}`,
    payload: { type: "document.progressed", entityId: input.documentId, progress: 0, status: "error", error },
  });
}

export async function markKnowledgeDocumentFailed(
  context: DomainContext,
  input: { businessId: string; documentId: string; error?: string; expectedRevision?: number },
): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const document = (await tx.select({ revision: knowledgeDocuments.revision, status: knowledgeDocuments.status }).from(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId))).limit(1).for("update"))[0];
    if (!document || document.status === "cancelled" || (input.expectedRevision !== undefined && document.revision !== input.expectedRevision)) return false;
    await markKnowledgeDocumentFailedInTransaction(tx, input, document.revision, input.error ?? "Knowledge indexing failed.");
    return true;
  });
}

export async function upsertWebsiteDocument(
  context: DomainContext,
  input: { businessId: string; sourceUrl: string; title: string },
): Promise<string> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [document] = await tx.insert(knowledgeDocuments).values({
      businessId: input.businessId,
      sourceType: "website",
      title: input.title.trim() || input.sourceUrl,
      sourceUrl: input.sourceUrl,
      status: "processing",
      processingProgress: 0,
      error: null,
    }).onConflictDoUpdate({
      target: [knowledgeDocuments.businessId, knowledgeDocuments.sourceUrl],
      set: { title: input.title.trim() || input.sourceUrl, status: "processing", processingProgress: 0, error: null, updatedAt: new Date() },
    }).returning({ id: knowledgeDocuments.id });
    if (!document) throw new Error("Website knowledge document could not be created.");
    return document.id;
  });
}

export async function searchKnowledge(
  context: DomainContext,
  input: { userId?: string; businessId: string; query: string; limit?: number; receptionistId?: string | null | undefined },
): Promise<Array<{ chunkId: string; title: string; content: string }>> {
  return (await searchKnowledgeEvidence(context, input)).matches;
}

type KnowledgeSearchInput = { userId?: string; businessId: string; query: string; limit?: number; callId?: string; turnId?: string; receptionistId?: string | null | undefined };

/** A knowledge search's answer: the passages the receptionist's searchKnowledge tool gets, best first. */
export type KnowledgeSearchEvidence = { matches: KnowledgePassage[]; mode: "hybrid" | "keyword"; outcome: "found" | "empty" | "unavailable"; failure?: "embedding_unavailable" | "search_unavailable"; durationMs: number };

// The values one search holds on its way to the answer. traceKnowledgeSearch reports
// them; searchKnowledgeEvidence drops them.
type KnowledgeSearchStages = {
  query: string;
  terms: string[];
  lexicalQuery: { any: string; all: string } | null;
  lexical: PromiseSettledResult<KnowledgePassage[]>;
  semantic: PromiseSettledResult<KnowledgePassage[]>;
  /** The query's embedding, once the provider returned a valid one. */
  embedding: number[] | null;
  limit: number;
  ranked: RankedKnowledgeCandidate[];
  /** null when no candidate needed the check. */
  revisionCheck: "ok" | "failed" | null;
  /** Chunks the revision recheck found current, the candidates' neighbors included. */
  current: ReadonlySet<string>;
  /** Candidates the token budget kept. */
  kept: ReadonlySet<string>;
};

/**
 * Searches the files and website pages the receptionist answering may use
 * (knowledgeSearchReach).
 */
export async function searchKnowledgeEvidence(context: DomainContext, input: KnowledgeSearchInput): Promise<KnowledgeSearchEvidence> {
  return (await runKnowledgeSearch(context, input)).result;
}

/**
 * What a knowledge search may read, as a reader CTE and filters on chunks c
 * and documents d. The reader is the receptionist answering: the one named
 * when it is active, else the default receptionist, as its entry points
 * answer as the default (receptionistMayUse in @lobbystack/shared, here in
 * SQL). It may read documents for everyone, every document when it sees them
 * all, and those chosen for it; the default also reads documents chosen only
 * for archived receptionists. A business from before receptionists has no
 * reader and reads everything.
 */
function knowledgeSearchReach(businessId: string, receptionistId: string | null | undefined): { reader: SQL; filters: SQL } {
  const named = receptionistId && isUuid(receptionistId) ? receptionistId : null;
  const reader = sql`reader AS (
    SELECT id, is_default, knowledge_scope FROM receptionist_profiles
    WHERE business_id = ${businessId} AND archived_at IS NULL AND (status = 'active' OR is_default)
    ORDER BY (id = ${named}::uuid) IS TRUE DESC, is_default DESC, id
    LIMIT 1
  )`;
  const filters = sql`c.business_id = ${businessId} AND d.business_id = ${businessId}
    AND d.active = true AND d.status = 'indexed'
    AND (d.audience = 'everyone'
      OR NOT EXISTS (SELECT 1 FROM reader WHERE reader.knowledge_scope = 'audience')
      OR EXISTS (SELECT 1 FROM reader JOIN knowledge_document_receptionists l ON l.document_id = d.id AND l.receptionist_id = reader.id)
      OR EXISTS (SELECT 1 FROM reader WHERE reader.is_default AND NOT EXISTS (
        SELECT 1 FROM knowledge_document_receptionists l
        JOIN receptionist_profiles p ON p.business_id = l.business_id AND p.id = l.receptionist_id AND p.archived_at IS NULL
        WHERE l.document_id = d.id)))`;
  return { reader, filters };
}

// The receptionist's knowledge search. Keeping its stages changes nothing about it:
// they are values the search holds anyway. source marks a search the v1 API ran, in
// its metrics and product event, so a dashboard can leave troubleshooting out.
async function runKnowledgeSearch(context: DomainContext, input: KnowledgeSearchInput & { source?: "api" }): Promise<{ result: KnowledgeSearchEvidence; stages: KnowledgeSearchStages }> {
  const startedAt = performance.now();
  const actor = { userId: input.userId, businessId: input.businessId, actorType: input.userId ? "operator" as const : "worker" as const };
  if (input.userId) await withBusinessTransaction(context.db, actor, tx => requireBusinessMembership(tx, { userId: input.userId!, businessId: input.businessId }));
  const query = input.query.trim().slice(0, 2000);
  const terms = knowledgeQueryTerms(query);
  const fields = sql`c.id AS "chunkId", c.document_id AS "documentId", d.title, c.content,
    d.source_url AS "sourceUrl", d.revision AS "sourceRevision", c.sequence`;
  const from = sql`FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id`;
  const { reader, filters } = knowledgeSearchReach(input.businessId, input.receptionistId);
  const select = sql`WITH ${reader} SELECT ${fields} ${from}`;
  const execute = (statement: ReturnType<typeof sql>) => withBusinessTransaction(context.db, actor, async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
    return (await tx.execute<KnowledgePassage>(statement)).rows;
  });
  const lexicalQueries = knowledgeLexicalQueries(terms);
  const { any: lexicalQuery, all: allTermsQuery } = lexicalQueries;
  const lexical = terms.length ? execute(sql`${select} WHERE ${filters}
    AND (to_tsvector('simple', c.content) @@ to_tsquery('simple', ${lexicalQuery})
      OR to_tsvector('simple', d.title) @@ to_tsquery('simple', ${lexicalQuery}))
    ORDER BY ts_rank_cd(to_tsvector('simple', d.title || ' ' || c.content), to_tsquery('simple', ${allTermsQuery})) DESC,
      ts_rank_cd(to_tsvector('simple', d.title || ' ' || c.content), to_tsquery('simple', ${lexicalQuery})) DESC, c.id LIMIT 12`) : Promise.resolve([]);
  let queryEmbedding: number[] | null = null;
  const semantic = (async () => {
    if (!query || !context.embeddings) throw new Error("embedding_unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [embedding] = await Promise.race([
        context.embeddings.embed([query]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("embedding_timeout")), 1800); }),
      ]);
      if (!embedding?.length || embedding.some(value => !Number.isFinite(value))) throw new Error("invalid_embedding");
      queryEmbedding = embedding;
      return await execute(sql`WITH ${reader}, eligible AS MATERIALIZED (SELECT ${fields}, c.embedding ${from} WHERE ${filters} AND c.embedding IS NOT NULL
        AND c.embedding_status = 'completed'
        ${context.embeddings.fingerprint ? sql`AND c.embedding_fingerprint = ${context.embeddings.fingerprint}` : sql``})
        SELECT "chunkId", "documentId", title, content, "sourceUrl", "sourceRevision", sequence FROM eligible
        ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector, "chunkId" LIMIT 12`);
    } finally { if (timer) clearTimeout(timer); }
  })();
  const [lexicalResult, semanticResult] = await Promise.allSettled([lexical, semantic]);
  const mode = semanticResult.status === "fulfilled" ? "hybrid" as const : "keyword" as const;
  const limit = Math.min(6, Math.max(1, input.limit ?? 6));
  const fused = rankKnowledgeCandidates([
    lexicalResult.status === "fulfilled" ? lexicalResult.value : [],
    semanticResult.status === "fulfilled" ? semanticResult.value : [],
  ]);
  const candidates = fused.slice(0, limit).map(row => row.passage);
  // Recheck revisions after parallel retrieval so an in-flight edit cannot label old chunks as current.
  let validationFailed = false;
  const current = candidates.length ? await execute(sql`${select} WHERE ${filters} AND (${sql.join(candidates.map(p => sql`(c.document_id = ${p.documentId} AND d.revision = ${p.sourceRevision} AND c.sequence BETWEEN ${p.sequence - 1} AND ${p.sequence + 1})`), sql` OR `)})`).catch(() => { validationFailed = true; return []; }) : [];
  const valid = new Map(current.map(p => [p.chunkId, p]));
  // Reserve the ranked primary passages first. Neighbors must not crowd out distinct candidates.
  const matches = withinKnowledgeBudget(candidates.filter(p => valid.has(p.chunkId)), KNOWLEDGE_SEARCH_TOKEN_BUDGET, p => JSON.stringify(p));
  const kept = new Set(matches.map(p => p.chunkId));
  for (let index = 0; index < matches.length; index += 1) {
    const p = matches[index]!;
    const neighbors = current.filter(row => row.documentId === p.documentId && row.sourceRevision === p.sourceRevision && Math.abs(row.sequence - p.sequence) <= 1).sort((a, b) => a.sequence - b.sequence);
    // A reader with less room than the whole passage, like a live call, starts at the chunk that ranked.
    const focusStart = neighbors.filter(row => row.sequence < p.sequence).reduce((offset, row) => offset + row.content.length + 2, 0);
    const ranked = neighbors.find(row => row.chunkId === p.chunkId);
    const expanded = { ...p, supportingChunkIds: neighbors.map(row => row.chunkId), content: neighbors.map(row => row.content).join("\n\n"), ...(ranked ? { focusStart, focusEnd: focusStart + ranked.content.length } : {}) };
    const proposed = matches.map((match, candidateIndex) => candidateIndex === index ? expanded : match);
    if (proposed.reduce((sum, match) => sum + countKnowledgeTokens(JSON.stringify(match) + "\n"), 0) <= KNOWLEDGE_SEARCH_TOKEN_BUDGET) matches[index] = expanded;
  }
  const failed = validationFailed || (lexicalResult.status === "rejected" && semanticResult.status === "rejected");
  const outcome = matches.length ? "found" as const : failed ? "unavailable" as const : "empty" as const;
  const durationMs = performance.now() - startedAt;
  const source = input.source ? { source: input.source } : {};
  searchDuration.record(durationMs, { operation: "knowledge.search", mode, outcome, ...source });
  searchResultCount.record(matches.length, { operation: "knowledge.search", mode, outcome, ...source });
  await recordProductEventBestEffort(context, {
    name: "knowledge.search_executed",
    businessId: input.businessId,
    distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
    properties: { mode, outcome, resultCount: matches.length, durationMs, fallbackUsed: mode === "keyword", ...source, ...(input.callId ? { callId: input.callId } : {}), ...(input.turnId ? { turnId: input.turnId } : {}) },
  });
  return {
    result: { matches, mode, outcome, durationMs, ...(failed ? { failure: "search_unavailable" as const } : semanticResult.status === "rejected" ? { failure: "embedding_unavailable" as const } : {}) },
    stages: {
      query,
      terms,
      lexicalQuery: terms.length ? lexicalQueries : null,
      lexical: lexicalResult,
      semantic: semanticResult,
      embedding: queryEmbedding,
      limit,
      ranked: fused,
      revisionCheck: candidates.length ? (validationFailed ? "failed" : "ok") : null,
      current: new Set(valid.keys()),
      kept,
    },
  };
}

/** What became of a candidate the fusion ranked. */
export type KnowledgeCandidateFate =
  /** The receptionist got it. */
  | "evidence"
  /** It ranked below the search's limit of 6. */
  | "below_limit"
  /** Its document changed or was turned off while the search ran. */
  | "stale"
  /** The revision recheck failed, so the search kept nothing. */
  | "unverified"
  /** It didn't fit the token budget the passages ranked above it left. */
  | "over_budget";

/** Why a search stage failed, as a code. The provider's and the database's own messages stay on the server. */
export type KnowledgeSearchStageError = "embedding_unavailable" | "embedding_timeout" | "invalid_embedding" | "embedding_failed" | "statement_timeout" | "failed";

/** Each stage of one knowledge search, from the query's terms to the candidates' fates. */
export type KnowledgeSearchTrace = {
  /** The query as searched: trimmed, and cut to 2,000 characters. */
  query: string;
  terms: string[];
  lexicalQuery: { any: string; all: string } | null;
  limit: number;
  tokenBudget: number;
  lexical: { status: "ok" | "skipped" | "failed"; error: KnowledgeSearchStageError | null; candidates: Array<{ chunkId: string; rank: number; scoreAllTerms: number | null; scoreAnyTerm: number | null }> };
  semantic: { status: "ok" | "failed"; error: KnowledgeSearchStageError | null; embeddingFingerprint: string | null; embeddingDimensions: number | null; candidates: Array<{ chunkId: string; rank: number; distance: number | null }> };
  revisionCheck: "ok" | "failed" | null;
  /** Every candidate, best first, with its fused score and size as the budget counts it. */
  candidates: Array<{ passage: KnowledgePassage; rank: number; score: number; lexicalRank: number | null; semanticRank: number | null; tokens: number; fate: KnowledgeCandidateFate }>;
  /** What the search can reach in the business's knowledge: the sources and chunks its receptionist may use. */
  index: { sources: number; chunks: number; embeddedChunks: number } | null;
};

/**
 * Runs the receptionist's knowledge search, the same code as searchKnowledgeEvidence,
 * and reports each stage on the way to its answer. It searches as receptionistId
 * would, or as the default receptionist when none is named (knowledgeSearchReach).
 * The lexical scores, the semantic distances and the index counts come from reads
 * after the search, so durationMs is the search's own time. Each read is best
 * effort: what it would fill stays null when it fails.
 */
export async function traceKnowledgeSearch(context: DomainContext, input: { businessId: string; query: string; limit?: number; source?: "api"; receptionistId?: string | null | undefined }): Promise<{ result: KnowledgeSearchEvidence; trace: KnowledgeSearchTrace }> {
  const { result, stages } = await runKnowledgeSearch(context, input);
  const reach = knowledgeSearchReach(input.businessId, input.receptionistId);
  const read = async <T extends Record<string, unknown>>(statement: SQL): Promise<T[]> => await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
    return (await tx.execute<T>(statement)).rows as T[];
  });
  const lexicalRows = stages.lexical.status === "fulfilled" ? stages.lexical.value : [];
  const semanticRows = stages.semantic.status === "fulfilled" ? stages.semantic.value : [];
  const chunkIds = (rows: KnowledgePassage[]) => sql.join(rows.map(row => sql`${row.chunkId}`), sql`, `);
  const searchedText = sql`to_tsvector('simple', d.title || ' ' || c.content)`;
  const fingerprint = context.embeddings?.fingerprint;
  const [scores, distances, index] = await Promise.all([
    // The lexical search's two ORDER BY values: rank for every term, then for any term.
    stages.lexicalQuery && lexicalRows.length
      ? read<{ chunkId: string; allTerms: unknown; anyTerm: unknown }>(sql`SELECT c.id AS "chunkId",
          ts_rank_cd(${searchedText}, to_tsquery('simple', ${stages.lexicalQuery.all})) AS "allTerms",
          ts_rank_cd(${searchedText}, to_tsquery('simple', ${stages.lexicalQuery.any})) AS "anyTerm"
          FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
          WHERE c.business_id = ${input.businessId} AND d.business_id = ${input.businessId} AND c.id IN (${chunkIds(lexicalRows)})`).catch(() => [])
      : [],
    // The semantic search's ORDER BY value: cosine distance, 0 for the same direction.
    stages.embedding && semanticRows.length
      ? read<{ chunkId: string; distance: unknown }>(sql`SELECT c.id AS "chunkId", c.embedding <=> ${JSON.stringify(stages.embedding)}::vector AS distance
          FROM knowledge_chunks c WHERE c.business_id = ${input.businessId} AND c.id IN (${chunkIds(semanticRows)})`).catch(() => [])
      : [],
    // Counted with the search's own reader and filters, so it counts what that receptionist may use.
    read<{ sources: unknown; chunks: unknown; embeddedChunks: unknown }>(sql`WITH ${reach.reader}
        SELECT count(DISTINCT d.id) AS sources, count(*) AS chunks,
        count(*) FILTER (WHERE c.embedding IS NOT NULL AND c.embedding_status = 'completed'
          ${fingerprint ? sql`AND c.embedding_fingerprint = ${fingerprint}` : sql``}) AS "embeddedChunks"
        FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        WHERE ${reach.filters}`)
      .then(([row]) => row ? { sources: Number(row.sources), chunks: Number(row.chunks), embeddedChunks: Number(row.embeddedChunks) } : null)
      .catch(() => null),
  ]);
  const lexicalScores = new Map(scores.map(row => [row.chunkId, row]));
  const semanticDistances = new Map(distances.map(row => [row.chunkId, finiteNumber(row.distance)]));
  const fate = (chunkId: string, rank: number): KnowledgeCandidateFate => stages.kept.has(chunkId) ? "evidence"
    : rank > stages.limit ? "below_limit"
    : stages.revisionCheck === "failed" ? "unverified"
    : stages.current.has(chunkId) ? "over_budget"
    : "stale";
  return {
    result,
    trace: {
      query: stages.query,
      terms: stages.terms,
      lexicalQuery: stages.lexicalQuery,
      limit: stages.limit,
      tokenBudget: KNOWLEDGE_SEARCH_TOKEN_BUDGET,
      lexical: {
        status: !stages.terms.length ? "skipped" : stages.lexical.status === "fulfilled" ? "ok" : "failed",
        error: stages.lexical.status === "rejected" ? searchStageError(stages.lexical.reason, true) : null,
        candidates: lexicalRows.map((row, rank) => ({ chunkId: row.chunkId, rank: rank + 1, scoreAllTerms: finiteNumber(lexicalScores.get(row.chunkId)?.allTerms), scoreAnyTerm: finiteNumber(lexicalScores.get(row.chunkId)?.anyTerm) })),
      },
      semantic: {
        status: stages.semantic.status === "fulfilled" ? "ok" : "failed",
        error: stages.semantic.status === "rejected" ? searchStageError(stages.semantic.reason, stages.embedding !== null) : null,
        embeddingFingerprint: fingerprint ?? null,
        embeddingDimensions: stages.embedding?.length ?? null,
        candidates: semanticRows.map((row, rank) => ({ chunkId: row.chunkId, rank: rank + 1, distance: semanticDistances.get(row.chunkId) ?? null })),
      },
      revisionCheck: stages.revisionCheck,
      candidates: stages.ranked.map((row, rank) => ({ passage: row.passage, rank: rank + 1, score: row.score, lexicalRank: row.ranks[0] ?? null, semanticRank: row.ranks[1] ?? null, tokens: countKnowledgeTokens(JSON.stringify(row.passage) + "\n"), fate: fate(row.passage.chunkId, rank + 1) })),
      index,
    },
  };
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

// A failed stage as a code. queried: the stage got as far as its database query, so a
// failure that isn't one of the search's own codes came from there, not the provider.
function searchStageError(reason: unknown, queried: boolean): KnowledgeSearchStageError {
  const message = reason instanceof Error ? reason.message : "";
  if (message === "embedding_unavailable" || message === "embedding_timeout" || message === "invalid_embedding") return message;
  if (!queried) return "embedding_failed";
  for (let current: unknown = reason, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    if ((current as { code?: unknown }).code === "57014") return "statement_timeout";
  }
  return "failed";
}

export async function loadLatestBusinessSnapshot(
  context: DomainContext,
  input: { businessId: string },
): Promise<BusinessContextSnapshot | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [row] = await tx
      .select({ snapshot: businessContextSnapshots.snapshot })
      .from(businessContextSnapshots)
      .where(eq(businessContextSnapshots.businessId, input.businessId))
      .orderBy(desc(businessContextSnapshots.generatedAt))
      .limit(1);

    if (!row || typeof row.snapshot !== "object" || row.snapshot === null || Array.isArray(row.snapshot)) {
      return null;
    }

    return row.snapshot as BusinessContextSnapshot;
  });
}

/** The business page's address on this deployment, when the page is published and the deployment's address is known. */
export function businessPageUrl(slug: string, published: boolean, environment: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const base = environment.APP_BASE_URL?.trim();
  if (!published || !base) return undefined;
  try {
    return new URL(publicProfilePath(slug), base).toString();
  } catch {
    return undefined;
  }
}

/** A business from before receptionists answers as one receptionist that sees every article. */
const LEGACY_RECEPTIONIST: RankedReceptionist = { id: "00000000-0000-0000-0000-000000000000", isDefault: true, status: "active", knowledgeScope: "all" };

export async function refreshBusinessSnapshot(
  context: DomainContext,
  input: { businessId: string },
): Promise<string> {
  const startedAt = performance.now();
  let builtSnapshot: BusinessContextSnapshot | undefined;
  const version = await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [found] = await tx.select({ business: businesses, published: businessPublicProfiles.published }).from(businesses)
      .leftJoin(businessPublicProfiles, eq(businessPublicProfiles.businessId, businesses.id))
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    if (!found) {
      throw new Error("Business not found.");
    }
    const { business } = found;
    // Every business has one default receptionist; should none be left, the
    // first stands in so its numbers and pages still answer.
    const loaded = await loadSnapshotReceptionistRows(tx, input.businessId);
    const profiles = loaded.length && !loaded.some((row) => row.isDefault) ? loaded.map((row, index) => index === 0 ? { ...row, isDefault: true } : row) : loaded;
    const defaultProfile = profiles.find((row) => row.isDefault);
    const hours = await tx.select().from(businessHours).where(eq(businessHours.businessId, input.businessId)).orderBy(asc(businessHours.dayOfWeek), asc(businessHours.openMinutes));
    const closureRows = await tx.select().from(closures).where(eq(closures.businessId, input.businessId)).orderBy(asc(closures.startsAt));
    const serviceRows = await tx.select().from(services).where(and(eq(services.businessId, input.businessId), eq(services.active, true))).orderBy(asc(services.name));
    const ruleRows = await tx.select().from(agentRules).where(and(eq(agentRules.businessId, input.businessId), eq(agentRules.active, true))).orderBy(asc(agentRules.sortOrder), asc(agentRules.createdAt), asc(agentRules.id));
    const knowledge = await loadSnapshotKnowledge(tx, { businessId: input.businessId, receptionists: defaultProfile ? profiles.map(rankedReceptionistOf) : [LEGACY_RECEPTIONIST] });
    const numbers = await tx.select().from(phoneNumbers).where(and(eq(phoneNumbers.businessId, input.businessId), eq(phoneNumbers.status, "active"))).orderBy(desc(phoneNumbers.createdAt), asc(phoneNumbers.id));
    const phoneNumber = numbers.find((number) => number.status === "active" && number.voiceEnabled)?.e164;
    // The number customer texts come from, so the agent offers texts only to
    // callers it can reach: the business's own SMS number, or the shared
    // sender for a cloud business without one.
    const smsNumber = await resolveSmsSender(tx, input.businessId);
    const publicPageUrl = businessPageUrl(business.slug, found.published === true);
    const receptionists = defaultProfile
      ? profiles.map((row) => snapshotReceptionistOf(row, { displayName: business.name, timezone: business.timezone, publicPageUrl, snippetIds: knowledge.snippetIds.get(row.id) ?? [] }))
      : undefined;
    const version = `${Date.now()}`;
    builtSnapshot = buildBusinessContextSnapshot({
      businessId: input.businessId,
      version,
      generatedAt: new Date().toISOString(),
      displayName: business.name,
      ...(business.legalName ? { legalName: business.legalName } : {}),
      timezone: business.timezone,
      // The fields below the shared ones are the default receptionist's, as calls read them before receptionists.
      defaultLocale: normalizeRuntimeLocale(defaultProfile?.locale) ?? normalizeRuntimeLocale(business.defaultLocale) ?? "en",
      businessType: ["clinic", "repair_shop", "salon", "service_company"].includes(business.businessType) ? business.businessType as BusinessContextSnapshot["businessType"] : "other",
      telemetryEnabled: business.telemetryEnabled,
      ...(phoneNumber ? { phoneNumber } : {}),
      ...(smsNumber ? { smsNumber } : {}),
      greeting: defaultProfile?.greeting ?? `Thank you for calling ${business.name}.`,
      // Every receptionist shares the AI notice, the summary and the appointment change rules: they are the business's.
      recordingNotice: business.recordingNotice,
      tone: defaultProfile?.tone ?? "professional",
      bookingPolicy: defaultProfile?.bookingPolicy ?? "Confirm availability before booking.",
      ...(defaultProfile?.voiceInstructions ? { voiceInstructions: defaultProfile.voiceInstructions } : {}),
      ...(defaultProfile?.smsInstructions ? { smsInstructions: defaultProfile.smsInstructions } : {}),
      ...(defaultProfile?.chatInstructions ? { chatInstructions: defaultProfile.chatInstructions } : {}),
      // A sign-up placeholder says nothing about the business, so prompts get no summary until AI or a person writes one.
      summary: business.summarySource !== "placeholder" ? business.summary : "",
      knowledgeDigest: knowledgeDigestOf(knowledge.defaultDocuments),
      hours: hours.map((row) => ({ dayOfWeek: row.dayOfWeek, openMinutes: row.openMinutes, closeMinutes: row.closeMinutes })),
      closures: closureRows.map((row) => ({ startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), reason: row.reason })),
      services: serviceRows.map((row) => ({
        id: row.id, name: row.name, durationMinutes: row.durationMinutes,
        ...(row.description ? { description: row.description } : {}),
        ...(row.localizedNames ? { localizedNames: {
          ...(typeof row.localizedNames.en === "string" ? { en: row.localizedNames.en } : {}),
          ...(typeof row.localizedNames.fr === "string" ? { fr: row.localizedNames.fr } : {}),
        } } : {}),
      })),
      rules: ruleRows.map((row) => ({ id: row.id, title: row.title, content: row.content, order: row.sortOrder })),
      snippets: knowledge.defaultSnippets,
      appointmentChangePolicy: normalizeAppointmentChangePolicy(business.appointmentChangePolicy),
      bookingMode: normalizeBookingMode(defaultProfile?.bookingMode),
      transferPolicy: { mode: normalizeTransferMode(defaultProfile?.transferMode), ...(defaultProfile?.transferNumber ? { transferNumber: defaultProfile.transferNumber } : {}) },
      ...(receptionists ? { receptionists } : {}),
      ...(knowledge.extraSnippets.length ? { extraSnippets: knowledge.extraSnippets } : {}),
      ...(knowledge.documents ? { knowledgeDocuments: knowledge.documents } : {}),
      ...(publicPageUrl ? { publicPageUrl } : {}),
    });
    await tx.insert(businessContextSnapshots).values({ businessId: input.businessId, version, snapshot: builtSnapshot as unknown as Record<string, unknown> });
    // Readers only use the newest row. now() is this transaction's start, the
    // generated_at just stored, so a newer refresh committed meanwhile is kept.
    await tx.delete(businessContextSnapshots).where(and(eq(businessContextSnapshots.businessId, input.businessId), lt(businessContextSnapshots.generatedAt, sql`now()`)));
    await enqueueOutbox(tx, {
      topic: "realtime.publish",
      businessId: input.businessId,
      aggregateType: "business_context_snapshot",
      aggregateId: input.businessId,
      dedupeKey: `snapshot:${input.businessId}:${version}`,
      payload: { type: "knowledge.progressed", entityId: input.businessId, version },
    });
    return version;
  });
  if (context.snapshotCache && builtSnapshot) {
    await context.snapshotCache.set(input.businessId, builtSnapshot).catch(() => undefined);
  }
  snapshotRefreshDuration.record(performance.now() - startedAt, { operation: "snapshot.refresh" });
  await recordProductEventBestEffort(context, {
    name: "business.snapshot_refreshed",
    businessId: input.businessId,
    distinctId: getPostHogDistinctIdForBusinessSystem(input.businessId),
    actorType: "worker",
    properties: {},
  });
  return version;
}

/**
 * Counts the indexed text the receptionist searches, in UTF-8 bytes. Uploaded
 * files don't count: a PDF's images and layout take space the agent never reads.
 */
export async function getKnowledgeStorageUsageBytes(tx: DatabaseTransaction, businessId: string, options: { excludeDocumentId?: string } = {}): Promise<number> {
  const [extracted] = await tx.select({ bytes: sql<number>`coalesce(sum(octet_length(${knowledgeChunks.content})), 0)` }).from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.businessId, businessId), ...(options.excludeDocumentId ? [ne(knowledgeChunks.documentId, options.excludeDocumentId)] : [])));
  return Number(extracted?.bytes ?? 0);
}

export function knowledgeStorageLimitMessage(limitBytes: number): string {
  return `Knowledge storage limit reached. ${Math.ceil(limitBytes / 1024 / 1024)} MB of text is included on this plan.`;
}

/** Refuses new knowledge for a business whose plan already holds all the text it includes. */
export class KnowledgeStorageLimitError extends Error {
  constructor(limitBytes: number) {
    super(knowledgeStorageLimitMessage(limitBytes));
    this.name = "KnowledgeStorageLimitError";
  }
}
