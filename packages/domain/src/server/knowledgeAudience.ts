import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  auditLogs,
  enqueueOutbox,
  knowledgeDocumentReceptionists,
  knowledgeDocuments,
  knowledgeSnippetReceptionists,
  knowledgeSnippets,
  knowledgeWebsiteRules,
  receptionistProfiles,
  websiteIngestionJobs,
  type DatabaseTransaction,
} from "@lobbystack/db";
import {
  isUuid,
  knowledgeAudiences,
  normalizeWebsiteRulePath,
  websitePageUnderRule,
  MAX_ARTICLES_PER_AUDIENCE_CHANGE,
  MAX_RECEPTIONISTS_PER_REQUEST,
  type KnowledgeAudience,
  type ReceptionistKnowledgeScope,
} from "@lobbystack/shared";

import { enqueueKnowledgeDerivedRefresh } from "./businessHours";

// Who may use each article. Every file, website page and text entry is for
// everyone, the default, or for the receptionists chosen for it (a link row
// each). A receptionist whose knowledge scope is "audience" uses the articles
// for everyone and those chosen for it; one whose scope is "all", as the
// default receptionist's is, uses every article. An article chosen only for
// archived receptionists, or for none, is left to the default receptionist
// (receptionistMayUse in @lobbystack/shared, and the same rule in SQL here and
// in searchKnowledgeEvidence). A website rule gives a crawled site's pages
// under a path to one receptionist, on every crawl. Callers authorize: every
// change here is for owners and admins.

/** Who an article is for, as a change asks: everyone, or the receptionists chosen. */
export type KnowledgeAudienceChoice = { audience: "everyone" } | { audience: "chosen"; receptionistIds: string[] };

/**
 * A change to the articles selected on the Knowledge page. Everyone opens
 * them to every receptionist. Chosen adds receptionists to the articles
 * already chosen for some, removes receptionists (an article for everyone
 * becomes chosen for every other receptionist that isn't archived), or
 * replaces who they are for.
 */
export type KnowledgeAudienceChange = { documentIds: string[]; snippetIds: string[] }
  & ({ audience: "everyone" } | { audience: "chosen"; mode: KnowledgeAudienceMode; receptionistIds: string[] });

export const knowledgeAudienceModes = ["add", "remove", "replace"] as const;
export type KnowledgeAudienceMode = (typeof knowledgeAudienceModes)[number];

export type KnowledgeArticleKind = "document" | "snippet";

/** A website rule as the Knowledge page lists it. */
export type WebsiteRule = {
  id: string;
  rootDocumentId: string;
  /** The site's address, as it was added. */
  siteUrl: string;
  pathPrefix: string;
  receptionistId: string;
  createdAt: Date;
  /** Pages the rule gave to its receptionist. */
  pages: number;
};

export type WebsiteRuleInput = { rootDocumentId: string; pathPrefix: string; receptionistId: string };

/** The receptionists each chosen article is for; articles for everyone have no entry. */
export type KnowledgeAudienceLinks = {
  documents: Record<string, Array<{ receptionistId: string; websiteRuleId: string | null }>>;
  snippets: Record<string, string[]>;
};

function failure(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIds(value: unknown, field: string, max: number, code: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !isUuid(id))) throw failure(`${field} must be a list of ids.`, 400, code);
  const ids = [...new Set(value as string[])];
  if (ids.length > max) throw failure(`${field} can name up to ${max}.`, 400, code);
  return ids;
}

function readChosenReceptionists(value: unknown): string[] {
  const ids = readIds(value, "receptionistIds", MAX_RECEPTIONISTS_PER_REQUEST, "invalid_audience");
  if (!ids.length) throw failure("Choose at least one receptionist.", 400, "invalid_audience");
  return ids;
}

/** Who one article is for, from a request body's audience and receptionistIds. Throws a 400 for anything else. */
export function readKnowledgeAudienceChoice(value: unknown): KnowledgeAudienceChoice {
  if (!isRecord(value) || !(knowledgeAudiences as readonly unknown[]).includes(value.audience)) throw failure("audience must be everyone or chosen.", 400, "invalid_audience");
  if (value.audience === "everyone") return { audience: "everyone" };
  return { audience: "chosen", receptionistIds: readChosenReceptionists(value.receptionistIds) };
}

/** A bulk change from a request body. Throws a 400 for anything it can't make. */
export function readKnowledgeAudienceChange(body: unknown): KnowledgeAudienceChange {
  if (!isRecord(body)) throw failure("A JSON object is required.", 400, "invalid_audience");
  const documentIds = readIds(body.documentIds, "documentIds", MAX_ARTICLES_PER_AUDIENCE_CHANGE, "invalid_articles");
  const snippetIds = readIds(body.snippetIds, "snippetIds", MAX_ARTICLES_PER_AUDIENCE_CHANGE, "invalid_articles");
  const count = documentIds.length + snippetIds.length;
  if (!count) throw failure("Select at least one article.", 400, "invalid_articles");
  if (count > MAX_ARTICLES_PER_AUDIENCE_CHANGE) throw failure(`Change up to ${MAX_ARTICLES_PER_AUDIENCE_CHANGE} articles at once.`, 400, "invalid_articles");
  if (body.audience === "everyone") return { documentIds, snippetIds, audience: "everyone" };
  if (body.audience !== "chosen") throw failure("audience must be everyone or chosen.", 400, "invalid_audience");
  if (!(knowledgeAudienceModes as readonly unknown[]).includes(body.mode)) throw failure("mode must be add, remove or replace.", 400, "invalid_audience");
  return { documentIds, snippetIds, audience: "chosen", mode: body.mode as KnowledgeAudienceMode, receptionistIds: readChosenReceptionists(body.receptionistIds) };
}

/** A website rule from a request body: a website source, a path on it and a receptionist. */
export function readWebsiteRuleInput(body: unknown): WebsiteRuleInput {
  if (!isRecord(body)) throw failure("A JSON object is required.", 400, "invalid_website_rule");
  if (typeof body.rootDocumentId !== "string" || !isUuid(body.rootDocumentId)) throw failure("rootDocumentId must be a website's id.", 400, "invalid_website_rule");
  if (typeof body.receptionistId !== "string" || !isUuid(body.receptionistId)) throw failure("receptionistId must be a receptionist's id.", 400, "invalid_website_rule");
  const pathPrefix = typeof body.pathPrefix === "string" ? normalizeWebsiteRulePath(body.pathPrefix) : null;
  if (!pathPrefix) throw failure("Enter a path on the site, such as /stores/kitsilano/.", 400, "invalid_website_rule");
  return { rootDocumentId: body.rootDocumentId, pathPrefix, receptionistId: body.receptionistId };
}

/**
 * Checks that every receptionist named is the business's, and isn't archived
 * unless allowArchived (removing one from an article is fine).
 */
async function requireReceptionists(tx: DatabaseTransaction, businessId: string, ids: string[], options: { allowArchived: boolean }): Promise<void> {
  if (!ids.length) return;
  const rows = await tx.select({ id: receptionistProfiles.id, archivedAt: receptionistProfiles.archivedAt }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, businessId), inArray(receptionistProfiles.id, ids)));
  const found = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = found.get(id);
    if (!row) throw failure("Receptionist not found.", 404, "receptionist_not_found");
    if (row.archivedAt && !options.allowArchived) throw failure("An archived receptionist can't be chosen. Restore it first.", 409, "receptionist_archived");
  }
}

/** The business's receptionists that aren't archived. */
async function liveReceptionistIds(tx: DatabaseTransaction, businessId: string): Promise<string[]> {
  const rows = await tx.select({ id: receptionistProfiles.id }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, businessId), isNull(receptionistProfiles.archivedAt)))
    .orderBy(asc(receptionistProfiles.id));
  return rows.map((row) => row.id);
}

const articleTables = {
  document: { table: knowledgeDocuments, links: knowledgeDocumentReceptionists, linkColumn: knowledgeDocumentReceptionists.documentId, entityType: "knowledge_document", notFound: "Knowledge document not found." },
  snippet: { table: knowledgeSnippets, links: knowledgeSnippetReceptionists, linkColumn: knowledgeSnippetReceptionists.snippetId, entityType: "knowledge_snippet", notFound: "Knowledge snippet not found." },
} as const;

/** Locks the business's articles named, in id order so two changes never wait on each other. */
async function lockArticles(tx: DatabaseTransaction, businessId: string, kind: KnowledgeArticleKind, ids: string[]): Promise<Array<{ id: string; audience: KnowledgeAudience }>> {
  if (!ids.length) return [];
  const { table } = articleTables[kind];
  return await tx.select({ id: table.id, audience: table.audience }).from(table)
    .where(and(eq(table.businessId, businessId), inArray(table.id, ids)))
    .orderBy(asc(table.id))
    .for("update");
}

/**
 * Links every article to every receptionist given, as someone's choice. One
 * statement, whatever the count. A link a website rule made becomes a choice,
 * so it stays when the rule goes.
 */
async function linkArticles(tx: DatabaseTransaction, businessId: string, kind: KnowledgeArticleKind, articleIds: string[], receptionistIds: string[]): Promise<void> {
  if (!articleIds.length || !receptionistIds.length) return;
  const articles = sql`unnest(${sql.param(articleIds)}::uuid[])`;
  const receptionists = sql`unnest(${sql.param(receptionistIds)}::uuid[])`;
  if (kind === "document") {
    await tx.execute(sql`insert into knowledge_document_receptionists (business_id, document_id, receptionist_id)
      select ${businessId}::uuid, article.id, receptionist.id from ${articles} as article(id) cross join ${receptionists} as receptionist(id)
      on conflict (document_id, receptionist_id) do update set website_rule_id = null
      where knowledge_document_receptionists.website_rule_id is not null`);
  } else {
    await tx.execute(sql`insert into knowledge_snippet_receptionists (business_id, snippet_id, receptionist_id)
      select ${businessId}::uuid, article.id, receptionist.id from ${articles} as article(id) cross join ${receptionists} as receptionist(id)
      on conflict (snippet_id, receptionist_id) do nothing`);
  }
}

async function unlinkArticles(tx: DatabaseTransaction, businessId: string, kind: KnowledgeArticleKind, articleIds: string[], receptionistIds?: string[]): Promise<void> {
  if (!articleIds.length) return;
  const { links, linkColumn } = articleTables[kind];
  await tx.delete(links).where(and(eq(links.businessId, businessId), inArray(linkColumn, articleIds), receptionistIds ? inArray(links.receptionistId, receptionistIds) : undefined));
}

async function setAudience(tx: DatabaseTransaction, businessId: string, kind: KnowledgeArticleKind, articleIds: string[], audience: KnowledgeAudience): Promise<void> {
  if (!articleIds.length) return;
  const { table } = articleTables[kind];
  await tx.update(table).set({ audience }).where(and(eq(table.businessId, businessId), inArray(table.id, articleIds)));
}

/** Calls and chats read audiences from the snapshot; the summary and hours read only articles for everyone. */
async function refreshAfterAudienceChange(tx: DatabaseTransaction, businessId: string, reason: string): Promise<void> {
  await enqueueOutbox(tx, {
    topic: "snapshot.refresh",
    businessId,
    aggregateType: "business",
    aggregateId: businessId,
    dedupeKey: `knowledge-audience:${businessId}:${reason}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    payload: { businessId, reason },
  });
  await enqueueKnowledgeDerivedRefresh(tx, { businessId, reason });
}

/**
 * Sets who one article is for: everyone, or exactly the receptionists chosen,
 * which must be the business's and not archived. A 404 for an article the
 * business doesn't have.
 */
export async function setKnowledgeArticleAudienceInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; kind: KnowledgeArticleKind; articleId: string; choice: KnowledgeAudienceChoice },
): Promise<{ audience: KnowledgeAudience; receptionistIds: string[] }> {
  const { businessId, kind, choice } = input;
  const [article] = await lockArticles(tx, businessId, kind, [input.articleId]);
  if (!article) throw failure(articleTables[kind].notFound, 404, "knowledge_not_found");
  const receptionistIds = choice.audience === "chosen" ? choice.receptionistIds : [];
  await requireReceptionists(tx, businessId, receptionistIds, { allowArchived: false });
  await setAudience(tx, businessId, kind, [article.id], choice.audience);
  await unlinkArticles(tx, businessId, kind, [article.id]);
  await linkArticles(tx, businessId, kind, [article.id], receptionistIds);
  await tx.insert(auditLogs).values({
    businessId,
    actorUserId: input.actorUserId,
    eventType: "knowledge.audience_changed",
    entityType: articleTables[kind].entityType,
    entityId: article.id,
    payload: { audience: choice.audience, receptionistIds },
  });
  await refreshAfterAudienceChange(tx, businessId, "knowledge_audience_changed");
  return { audience: choice.audience, receptionistIds };
}

/**
 * Applies a bulk Available to change to the business's articles named; ones
 * deleted meanwhile are skipped. Chosen receptionists must be the business's
 * and, except to remove one, not archived. One audit entry covers the change.
 * Returns how many files and pages, and text entries, it covered.
 */
export async function changeKnowledgeAudienceInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; change: KnowledgeAudienceChange },
): Promise<{ documents: number; snippets: number }> {
  const { businessId, change } = input;
  const receptionistIds = change.audience === "chosen" ? change.receptionistIds : [];
  await requireReceptionists(tx, businessId, receptionistIds, { allowArchived: change.audience === "chosen" && change.mode === "remove" });
  const others = change.audience === "chosen" && change.mode === "remove"
    ? (await liveReceptionistIds(tx, businessId)).filter((id) => !receptionistIds.includes(id))
    : [];
  const covered: Record<KnowledgeArticleKind, string[]> = { document: [], snippet: [] };
  for (const kind of ["document", "snippet"] as const) {
    const articles = await lockArticles(tx, businessId, kind, kind === "document" ? change.documentIds : change.snippetIds);
    const ids = articles.map((article) => article.id);
    covered[kind] = ids;
    if (!ids.length) continue;
    const chosen = articles.filter((article) => article.audience === "chosen").map((article) => article.id);
    const forEveryone = articles.filter((article) => article.audience !== "chosen").map((article) => article.id);
    if (change.audience === "everyone") {
      await setAudience(tx, businessId, kind, ids, "everyone");
      await unlinkArticles(tx, businessId, kind, ids);
    } else if (change.mode === "replace") {
      await setAudience(tx, businessId, kind, ids, "chosen");
      await unlinkArticles(tx, businessId, kind, ids);
      await linkArticles(tx, businessId, kind, ids, receptionistIds);
    } else if (change.mode === "add") {
      // Everyone already includes them, so articles for everyone stay as they are.
      await linkArticles(tx, businessId, kind, chosen, receptionistIds);
    } else {
      await unlinkArticles(tx, businessId, kind, chosen, receptionistIds);
      // Everyone but these receptionists: the others that aren't archived.
      await setAudience(tx, businessId, kind, forEveryone, "chosen");
      await linkArticles(tx, businessId, kind, forEveryone, others);
    }
  }
  await tx.insert(auditLogs).values({
    businessId,
    actorUserId: input.actorUserId,
    eventType: "knowledge.audience_changed",
    entityType: "knowledge",
    payload: {
      audience: change.audience,
      ...(change.audience === "chosen" ? { mode: change.mode, receptionistIds } : {}),
      documentIds: covered.document,
      snippetIds: covered.snippet,
    },
  });
  if (covered.document.length || covered.snippet.length) await refreshAfterAudienceChange(tx, businessId, "knowledge_audience_changed");
  return { documents: covered.document.length, snippets: covered.snippet.length };
}

/** Every link from a chosen article to its receptionists, archived ones too, for the Knowledge page. */
export async function knowledgeAudienceLinksInTransaction(tx: DatabaseTransaction, input: { businessId: string }): Promise<KnowledgeAudienceLinks> {
  const documentRows = await tx.select({ documentId: knowledgeDocumentReceptionists.documentId, receptionistId: knowledgeDocumentReceptionists.receptionistId, websiteRuleId: knowledgeDocumentReceptionists.websiteRuleId })
    .from(knowledgeDocumentReceptionists).where(eq(knowledgeDocumentReceptionists.businessId, input.businessId))
    .orderBy(asc(knowledgeDocumentReceptionists.createdAt), asc(knowledgeDocumentReceptionists.receptionistId));
  const snippetRows = await tx.select({ snippetId: knowledgeSnippetReceptionists.snippetId, receptionistId: knowledgeSnippetReceptionists.receptionistId })
    .from(knowledgeSnippetReceptionists).where(eq(knowledgeSnippetReceptionists.businessId, input.businessId))
    .orderBy(asc(knowledgeSnippetReceptionists.createdAt), asc(knowledgeSnippetReceptionists.receptionistId));
  const documents: KnowledgeAudienceLinks["documents"] = {};
  for (const row of documentRows) (documents[row.documentId] ??= []).push({ receptionistId: row.receptionistId, websiteRuleId: row.websiteRuleId });
  const snippets: KnowledgeAudienceLinks["snippets"] = {};
  for (const row of snippetRows) (snippets[row.snippetId] ??= []).push(row.receptionistId);
  return { documents, snippets };
}

// Website rules

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    const value = current as { code?: unknown; constraint?: unknown };
    if (value.code === "23505" && value.constraint === constraint) return true;
  }
  return false;
}

/** The business's website rules, by site and path. */
export async function listWebsiteRulesInTransaction(tx: DatabaseTransaction, input: { businessId: string }): Promise<WebsiteRule[]> {
  const rows = await tx.select({
    id: knowledgeWebsiteRules.id,
    rootDocumentId: knowledgeWebsiteRules.rootDocumentId,
    siteUrl: knowledgeDocuments.sourceUrl,
    pathPrefix: knowledgeWebsiteRules.pathPrefix,
    receptionistId: knowledgeWebsiteRules.receptionistId,
    createdAt: knowledgeWebsiteRules.createdAt,
    // Written out by name: a correlated subquery in a select (see receptionists.ts).
    pages: sql<number>`(select count(*)::int from "knowledge_document_receptionists" as "rule_pages" where "rule_pages"."business_id" = ${input.businessId} and "rule_pages"."website_rule_id" = "knowledge_website_rules"."id")`,
  }).from(knowledgeWebsiteRules)
    .innerJoin(knowledgeDocuments, and(eq(knowledgeDocuments.businessId, knowledgeWebsiteRules.businessId), eq(knowledgeDocuments.id, knowledgeWebsiteRules.rootDocumentId)))
    .where(eq(knowledgeWebsiteRules.businessId, input.businessId))
    .orderBy(asc(knowledgeDocuments.sourceUrl), asc(knowledgeWebsiteRules.pathPrefix), asc(knowledgeWebsiteRules.createdAt));
  return rows.map((row) => ({ ...row, siteUrl: row.siteUrl ?? "" }));
}

/**
 * Gives the pages of a crawled site under the rules' paths to the rules'
 * receptionists: each page becomes chosen and gains a link that names its
 * rule. Links someone chose stay as they are, and rules for archived
 * receptionists wait until they are restored. documentIds narrows it to some
 * pages (a page just crawled), ruleIds to some rules (a rule just made).
 * Returns how many pages fall under a rule.
 */
export async function applyWebsiteRulesInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; rootDocumentId: string; documentIds?: string[]; ruleIds?: string[] },
): Promise<number> {
  const { businessId } = input;
  if (input.documentIds?.length === 0 || input.ruleIds?.length === 0) return 0;
  const [site] = await tx.select({ sourceUrl: knowledgeDocuments.sourceUrl }).from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.businessId, businessId), eq(knowledgeDocuments.id, input.rootDocumentId), eq(knowledgeDocuments.sourceType, "website")))
    .limit(1);
  if (!site?.sourceUrl) return 0;
  const rules = await tx.select({ id: knowledgeWebsiteRules.id, pathPrefix: knowledgeWebsiteRules.pathPrefix, receptionistId: knowledgeWebsiteRules.receptionistId })
    .from(knowledgeWebsiteRules)
    .innerJoin(receptionistProfiles, and(eq(receptionistProfiles.businessId, knowledgeWebsiteRules.businessId), eq(receptionistProfiles.id, knowledgeWebsiteRules.receptionistId)))
    .where(and(
      eq(knowledgeWebsiteRules.businessId, businessId),
      eq(knowledgeWebsiteRules.rootDocumentId, input.rootDocumentId),
      isNull(receptionistProfiles.archivedAt),
      input.ruleIds ? inArray(knowledgeWebsiteRules.id, input.ruleIds) : undefined,
    ));
  if (!rules.length) return 0;
  const pages = await tx.select({ id: knowledgeDocuments.id, sourceUrl: knowledgeDocuments.sourceUrl }).from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.businessId, businessId), eq(knowledgeDocuments.sourceType, "website"), input.documentIds ? inArray(knowledgeDocuments.id, input.documentIds) : undefined));
  const matches = pages.flatMap((page) => rules
    .filter((rule) => page.sourceUrl !== null && websitePageUnderRule(page.sourceUrl, site.sourceUrl!, rule.pathPrefix))
    .map((rule) => ({ businessId, documentId: page.id, receptionistId: rule.receptionistId, websiteRuleId: rule.id })));
  if (!matches.length) return 0;
  for (let start = 0; start < matches.length; start += 1_000) {
    await tx.insert(knowledgeDocumentReceptionists).values(matches.slice(start, start + 1_000)).onConflictDoNothing();
  }
  const documentIds = [...new Set(matches.map((match) => match.documentId))];
  await tx.update(knowledgeDocuments).set({ audience: "chosen" })
    .where(and(eq(knowledgeDocuments.businessId, businessId), inArray(knowledgeDocuments.id, documentIds), eq(knowledgeDocuments.audience, "everyone")));
  return documentIds.length;
}

/**
 * Adds a rule giving a website source's pages under a path to a receptionist
 * that isn't archived, and applies it to the pages already crawled. A 404 for
 * a source or receptionist the business doesn't have, a 400 for a source that
 * isn't a website it added, and a 409 for a rule it already has.
 */
export async function createWebsiteRuleInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; rule: WebsiteRuleInput },
): Promise<WebsiteRule> {
  const { businessId, rule } = input;
  const [site] = await tx.select({ id: knowledgeDocuments.id, sourceType: knowledgeDocuments.sourceType, sourceUrl: knowledgeDocuments.sourceUrl, crawled: websiteIngestionJobs.id })
    .from(knowledgeDocuments)
    .leftJoin(websiteIngestionJobs, and(eq(websiteIngestionJobs.businessId, knowledgeDocuments.businessId), eq(websiteIngestionJobs.rootDocumentId, knowledgeDocuments.id)))
    .where(and(eq(knowledgeDocuments.businessId, businessId), eq(knowledgeDocuments.id, rule.rootDocumentId)))
    .limit(1);
  if (!site) throw failure("Website not found.", 404, "knowledge_not_found");
  if (site.sourceType !== "website" || !site.crawled || !site.sourceUrl) throw failure("Rules apply to a website you added to Knowledge.", 400, "invalid_website_rule");
  await requireReceptionists(tx, businessId, [rule.receptionistId], { allowArchived: false });
  let created: typeof knowledgeWebsiteRules.$inferSelect | undefined;
  try {
    // A savepoint, so a duplicate leaves the transaction usable for the 409.
    [created] = await tx.transaction(async (inner) => await inner.insert(knowledgeWebsiteRules).values({ businessId, rootDocumentId: site.id, pathPrefix: rule.pathPrefix, receptionistId: rule.receptionistId, createdByUserId: input.actorUserId }).returning());
  } catch (error) {
    if (isUniqueViolation(error, "knowledge_website_rules_unique")) throw failure("This site already gives that path to that receptionist.", 409, "website_rule_exists");
    throw error;
  }
  if (!created) throw new Error("Website rule could not be created.");
  const pages = await applyWebsiteRulesInTransaction(tx, { businessId, rootDocumentId: site.id, ruleIds: [created.id] });
  await tx.insert(auditLogs).values({
    businessId,
    actorUserId: input.actorUserId,
    eventType: "website_rule.created",
    entityType: "knowledge_website_rule",
    entityId: created.id,
    payload: { rootDocumentId: site.id, pathPrefix: created.pathPrefix, receptionistId: created.receptionistId, pages },
  });
  if (pages) await refreshAfterAudienceChange(tx, businessId, "website_rule_created");
  return { id: created.id, rootDocumentId: site.id, siteUrl: site.sourceUrl, pathPrefix: created.pathPrefix, receptionistId: created.receptionistId, createdAt: created.createdAt, pages };
}

/**
 * Deletes a rule and the links it made. A page it left chosen for nobody goes
 * back to everyone; a page someone also chose receptionists for keeps them.
 * False when the business has no such rule.
 */
export async function deleteWebsiteRuleInTransaction(tx: DatabaseTransaction, input: { businessId: string; actorUserId: string | null; ruleId: string }): Promise<boolean> {
  const { businessId } = input;
  const [rule] = await tx.select().from(knowledgeWebsiteRules)
    .where(and(eq(knowledgeWebsiteRules.businessId, businessId), eq(knowledgeWebsiteRules.id, input.ruleId)))
    .limit(1)
    .for("update");
  if (!rule) return false;
  const pages = (await tx.select({ documentId: knowledgeDocumentReceptionists.documentId }).from(knowledgeDocumentReceptionists)
    .where(and(eq(knowledgeDocumentReceptionists.businessId, businessId), eq(knowledgeDocumentReceptionists.websiteRuleId, rule.id))))
    .map((row) => row.documentId);
  // The links go with the rule (ON DELETE CASCADE).
  await tx.delete(knowledgeWebsiteRules).where(and(eq(knowledgeWebsiteRules.businessId, businessId), eq(knowledgeWebsiteRules.id, rule.id)));
  if (pages.length) {
    await tx.update(knowledgeDocuments).set({ audience: "everyone" }).where(and(
      eq(knowledgeDocuments.businessId, businessId),
      inArray(knowledgeDocuments.id, pages),
      eq(knowledgeDocuments.audience, "chosen"),
      sql`not exists (select 1 from "knowledge_document_receptionists" as "remaining" where "remaining"."business_id" = ${businessId} and "remaining"."document_id" = "knowledge_documents"."id")`,
    ));
  }
  await tx.insert(auditLogs).values({
    businessId,
    actorUserId: input.actorUserId,
    eventType: "website_rule.deleted",
    entityType: "knowledge_website_rule",
    entityId: rule.id,
    payload: { rootDocumentId: rule.rootDocumentId, pathPrefix: rule.pathPrefix, receptionistId: rule.receptionistId, pages: pages.length },
  });
  if (pages.length) await refreshAfterAudienceChange(tx, businessId, "website_rule_deleted");
  return true;
}

// The snapshot's audiences

/** A receptionist that isn't archived, as the snapshot's ranking reads it. */
export type RankedReceptionist = { id: string; isDefault: boolean; status: string; knowledgeScope: ReceptionistKnowledgeScope };

const rankedArticles = {
  snippets: {
    table: sql.raw("knowledge_snippets"),
    links: sql.raw("knowledge_snippet_receptionists"),
    linkColumn: sql.raw("snippet_id"),
    filter: sql.raw("a.active"),
    columns: sql.raw("a.id, a.priority, a.updated_at"),
    order: sql.raw("a.priority desc, a.updated_at desc, a.id"),
  },
  documents: {
    table: sql.raw("knowledge_documents"),
    links: sql.raw("knowledge_document_receptionists"),
    linkColumn: sql.raw("document_id"),
    filter: sql.raw("a.active and a.status = 'indexed'"),
    columns: sql.raw("a.id, a.updated_at"),
    order: sql.raw("a.updated_at desc, a.id"),
  },
} as const;

/** Receptionists that see every article share one ranking; each other one has its own. */
function rankingViewOf(receptionist: RankedReceptionist): string {
  return receptionist.knowledgeScope === "all" ? "all" : receptionist.id;
}

/**
 * The first `limit` articles each answering receptionist may use, in the
 * order its prompt reads them: text entries by priority, documents newest
 * first. Receptionists that see every article share one ranking. Links to
 * paused receptionists count, links to archived ones don't, as in
 * receptionistMayUse. Keyed by receptionist id; a paused receptionist doesn't
 * answer and gets none (the default receptionist always answers). The
 * receptionists given need not be stored: a business from before
 * receptionists ranks as one that sees every article.
 */
export async function rankArticlesForReceptionists(
  tx: DatabaseTransaction,
  input: { businessId: string; kind: keyof typeof rankedArticles; limit: number; receptionists: RankedReceptionist[] },
): Promise<Map<string, string[]>> {
  // The default receptionist always answers: it can't be paused.
  const active = input.receptionists.filter((receptionist) => receptionist.status === "active" || receptionist.isDefault);
  if (!active.length || input.limit <= 0) return new Map();
  const views = new Map<string, RankedReceptionist>();
  for (const receptionist of active) if (!views.has(rankingViewOf(receptionist))) views.set(rankingViewOf(receptionist), receptionist);
  const entries = [...views.entries()];
  const { table, links, linkColumn, filter, columns, order } = rankedArticles[input.kind];
  // Each view takes the first articles it may use in its prompt's order, then
  // numbers just those; the links' primary keys answer both lookups.
  const rows = (await tx.execute<{ view: string; article_id: string }>(sql`
    select views.view, picked.id::text as article_id
    from unnest(
      ${sql.param(entries.map(([view]) => view))}::text[],
      ${sql.param(entries.map(([, receptionist]) => receptionist.id))}::uuid[],
      ${sql.param(entries.map(([, receptionist]) => receptionist.isDefault))}::boolean[],
      ${sql.param(entries.map(([, receptionist]) => receptionist.knowledgeScope))}::text[]
    ) with ordinality as views(view, id, is_default, knowledge_scope, position)
    cross join lateral (
      select a.id, row_number() over (order by ${order}) as rank
      from (
        select ${columns} from ${table} as a
        where a.business_id = ${input.businessId} and ${filter}
          and (
            views.knowledge_scope = 'all'
            or a.audience = 'everyone'
            or exists (select 1 from ${links} as l where l.${linkColumn} = a.id and l.receptionist_id = views.id)
            or (views.is_default and not exists (
              select 1 from ${links} as l
              inner join receptionist_profiles as p on p.business_id = l.business_id and p.id = l.receptionist_id and p.archived_at is null
              where l.${linkColumn} = a.id
            ))
          )
        order by ${order}
        limit ${input.limit}
      ) as a
    ) as picked
    order by views.position, picked.rank`)).rows;
  const byView = new Map<string, string[]>();
  for (const row of rows) {
    const list = byView.get(row.view);
    if (list) list.push(row.article_id);
    else byView.set(row.view, [row.article_id]);
  }
  return new Map(active.map((receptionist) => [receptionist.id, byView.get(rankingViewOf(receptionist)) ?? []]));
}

/** The receptionists that aren't archived each article named is chosen for. */
export async function liveAudienceLinks(tx: DatabaseTransaction, input: { businessId: string; kind: keyof typeof rankedArticles; articleIds: string[] }): Promise<Map<string, string[]>> {
  if (!input.articleIds.length) return new Map();
  const { links, linkColumn } = rankedArticles[input.kind];
  const rows = (await tx.execute<{ article_id: string; receptionist_id: string }>(sql`
    select l.${linkColumn}::text as article_id, l.receptionist_id::text as receptionist_id from ${links} as l
    inner join receptionist_profiles as p on p.business_id = l.business_id and p.id = l.receptionist_id and p.archived_at is null
    where l.business_id = ${input.businessId} and l.${linkColumn} = any(${sql.param(input.articleIds)}::uuid[])
    order by l.created_at, l.receptionist_id`)).rows;
  const byArticle = new Map<string, string[]>();
  for (const row of rows) {
    const list = byArticle.get(row.article_id);
    if (list) list.push(row.receptionist_id);
    else byArticle.set(row.article_id, [row.receptionist_id]);
  }
  return byArticle;
}
