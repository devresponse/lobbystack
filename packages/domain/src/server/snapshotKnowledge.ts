import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { knowledgeDocuments, knowledgeSnippets, receptionistProfiles, type DatabaseTransaction } from "@lobbystack/db";
import {
  normalizeBookingMode,
  normalizeRuntimeLocale,
  normalizeTransferMode,
  MAX_DIGEST_DOCUMENTS_PER_RECEPTIONIST,
  MAX_SNIPPETS_PER_RECEPTIONIST,
  type KnowledgeSnippet,
  type ReceptionistKnowledgeScope,
  type SnapshotKnowledgeDocument,
  type SnapshotReceptionist,
} from "@lobbystack/shared";

import { channelInstructions } from "../snapshot";
import { liveAudienceLinks, rankArticlesForReceptionists, type RankedReceptionist } from "./knowledgeAudience";

// What the snapshot keeps of a business's knowledge for its receptionists:
// each receptionist's best text entries and newest documents among the ones
// it may use, stored once however many receptionists use them. The default
// receptionist's are the snapshot's own fields, as before receptionists;
// snapshotForReceptionist cuts any other receptionist's view.

type ProfileRow = typeof receptionistProfiles.$inferSelect;

export type SnapshotKnowledge = {
  /** The default receptionist's text entries, best first. */
  defaultSnippets: KnowledgeSnippet[];
  /** Entries other receptionists use that the default's leave out. */
  extraSnippets: KnowledgeSnippet[];
  /** The default receptionist's digest documents, newest first. */
  defaultDocuments: SnapshotKnowledgeDocument[];
  /** Every receptionist's digest documents, newest first; left out when every receptionist's are the default's. */
  documents?: SnapshotKnowledgeDocument[];
  /** Each answering receptionist's text entries, best first. */
  snippetIds: Map<string, string[]>;
};

/** The business's receptionists that aren't archived, in list order: the default first, then the Receptionists page's order. */
export async function loadSnapshotReceptionistRows(tx: DatabaseTransaction, businessId: string): Promise<ProfileRow[]> {
  const rows = await tx.select().from(receptionistProfiles)
    .where(eq(receptionistProfiles.businessId, businessId))
    .orderBy(desc(receptionistProfiles.isDefault), asc(receptionistProfiles.sortOrder), asc(receptionistProfiles.name), asc(receptionistProfiles.id));
  return rows.filter((row) => row.archivedAt === null);
}

/** A stored receptionist as the ranking reads it. The default receptionist always answers: it can't be paused. */
export function rankedReceptionistOf(row: ProfileRow): RankedReceptionist {
  return { id: row.id, isDefault: row.isDefault, status: row.isDefault ? "active" : row.status, knowledgeScope: row.knowledgeScope as ReceptionistKnowledgeScope };
}

/**
 * Each answering receptionist's text entries and digest documents, from the
 * business's receptionists that aren't archived, the default among them. A
 * business from before receptionists passes one that sees every article.
 */
export async function loadSnapshotKnowledge(tx: DatabaseTransaction, input: { businessId: string; receptionists: RankedReceptionist[] }): Promise<SnapshotKnowledge> {
  const { businessId, receptionists } = input;
  const defaultId = receptionists.find((receptionist) => receptionist.isDefault)?.id;
  const snippetIds = await rankArticlesForReceptionists(tx, { businessId, kind: "snippets", limit: MAX_SNIPPETS_PER_RECEPTIONIST, receptionists });
  const documentIds = await rankArticlesForReceptionists(tx, { businessId, kind: "documents", limit: MAX_DIGEST_DOCUMENTS_PER_RECEPTIONIST, receptionists });

  // Text entries, each once. Each receptionist's list names its own, so they
  // need no audience.
  const defaultSnippetIds = (defaultId ? snippetIds.get(defaultId) : undefined) ?? [];
  const allSnippetIds = [...new Set([...defaultSnippetIds, ...[...snippetIds.values()].flat()])];
  const snippetRows = allSnippetIds.length
    ? await tx.select({ id: knowledgeSnippets.id, title: knowledgeSnippets.title, content: knowledgeSnippets.content, tags: knowledgeSnippets.tags, priority: knowledgeSnippets.priority })
      .from(knowledgeSnippets).where(and(eq(knowledgeSnippets.businessId, businessId), inArray(knowledgeSnippets.id, allSnippetIds)))
    : [];
  const snippets = new Map<string, KnowledgeSnippet>(snippetRows.map((row) => [row.id, row]));
  const pick = (ids: string[]) => ids.flatMap((id) => { const entry = snippets.get(id); return entry ? [entry] : []; });
  const defaultSet = new Set(defaultSnippetIds);

  // Digest documents, each once, in the ranking's order (newest first). A
  // receptionist's digest is then the first of them it may use, which needs
  // each chosen document's receptionists.
  const allDocumentIds = [...new Set([...documentIds.values()].flat())];
  const documentRows = allDocumentIds.length
    ? await tx.select({ id: knowledgeDocuments.id, title: knowledgeDocuments.title, sourceUrl: knowledgeDocuments.sourceUrl, tags: knowledgeDocuments.tags, revision: knowledgeDocuments.revision, audience: knowledgeDocuments.audience })
      .from(knowledgeDocuments).where(and(eq(knowledgeDocuments.businessId, businessId), inArray(knowledgeDocuments.id, allDocumentIds)))
      .orderBy(desc(knowledgeDocuments.updatedAt), asc(knowledgeDocuments.id))
    : [];
  const documentLinks = await liveAudienceLinks(tx, { businessId, kind: "documents", articleIds: documentRows.filter((row) => row.audience === "chosen").map((row) => row.id) });
  const documents = new Map(documentRows.map((row) => [row.id, {
    title: row.title,
    sourceUrl: row.sourceUrl,
    tags: row.tags,
    revision: row.revision,
    ...(row.audience === "chosen" ? { audience: "chosen" as const, receptionistIds: documentLinks.get(row.id) ?? [] } : {}),
  }]));
  const defaultDocuments = ((defaultId ? documentIds.get(defaultId) : undefined) ?? []).flatMap((id) => { const entry = documents.get(id); return entry ? [entry] : []; });
  // Receptionists that see every article share one view; only several views need the documents' audiences.
  const views = new Set(receptionists.filter((receptionist) => receptionist.status === "active" || receptionist.isDefault).map((receptionist) => receptionist.knowledgeScope === "all" ? "all" : receptionist.id));

  return {
    defaultSnippets: pick(defaultSnippetIds),
    extraSnippets: pick(allSnippetIds.filter((id) => !defaultSet.has(id))),
    defaultDocuments,
    ...(views.size > 1 ? { documents: documentRows.flatMap((row) => { const entry = documents.get(row.id); return entry ? [entry] : []; }) } : {}),
    snippetIds,
  };
}

/** A receptionist as the snapshot keeps it, its instructions written out as calls read them. */
export function snapshotReceptionistOf(row: ProfileRow, input: { displayName: string; timezone: string; publicPageUrl?: string | undefined; snippetIds: string[] }): SnapshotReceptionist {
  const locale = normalizeRuntimeLocale(row.locale);
  // The default receptionist's page is the business page; another's is a handle under it.
  const pageUrl = input.publicPageUrl ? (row.isDefault ? input.publicPageUrl : row.handle ? `${input.publicPageUrl}/${row.handle}` : undefined) : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ...(pageUrl ? { pageUrl } : {}),
    isDefault: row.isDefault,
    status: row.isDefault || row.status !== "paused" ? "active" : "paused",
    listed: row.isDefault || row.listed,
    order: row.sortOrder,
    ...(locale ? { locale } : {}),
    knowledgeScope: row.knowledgeScope as ReceptionistKnowledgeScope,
    greeting: row.greeting,
    ...channelInstructions({
      displayName: input.displayName,
      timezone: input.timezone,
      tone: row.tone,
      voiceInstructions: row.voiceInstructions || undefined,
      smsInstructions: row.smsInstructions || undefined,
      chatInstructions: row.chatInstructions || undefined,
    }),
    bookingPolicy: row.bookingPolicy,
    bookingMode: normalizeBookingMode(row.bookingMode),
    transferPolicy: { mode: normalizeTransferMode(row.transferMode), ...(row.transferNumber ? { transferNumber: row.transferNumber } : {}) },
    snippetIds: input.snippetIds,
  };
}
