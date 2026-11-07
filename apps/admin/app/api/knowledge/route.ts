import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { knowledgeDocuments } from "@lobbystack/db";
import { createKnowledgeDocument, readWebsiteImportRules } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, requireApiSession, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => ({ documents: await tx.select({ ...getTableColumns(knowledgeDocuments), websiteImport: sql<{ id: string; status: string; websiteUrl: string; importedCount: number; indexedCount: number; documentCount: number; crawlFinishedCount: number | null; crawlTotalCount: number | null } | null>`(select json_build_object('id', ingestion.id, 'status', ingestion.status, 'websiteUrl', ingestion.website_url, 'importedCount', ingestion.imported_count, 'indexedCount', ingestion.indexed_count, 'documentCount', ingestion.indexed_count, 'crawlFinishedCount', nullif(ingestion.imported_count, 0), 'crawlTotalCount', nullif(ingestion.imported_count, 0)) from website_ingestion_jobs ingestion where ingestion.root_document_id = knowledge_documents.id and ingestion.business_id = knowledge_documents.business_id limit 1)`, textContent: sql<string>`coalesce((select left(preview.content, 500) from knowledge_chunks as preview where preview.document_id = knowledge_documents.id and preview.business_id = knowledge_documents.business_id order by preview.sequence limit 1), '')` }).from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, businessId)).orderBy(asc(knowledgeDocuments.title)) }))); } catch (error) { return asApiResponse(error); }
}

/**
 * Adds a website to Knowledge and starts its crawl. websiteRules, a list of
 * { pathPrefix, receptionistId }, give the site's pages under each path to a
 * receptionist, made with the source so the crawl follows them from its first
 * page.
 */
export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const body = await readJson(request) as { businessId?: string; title?: string; sourceType?: string; sourceUrl?: string; onboarding?: boolean; websiteRules?: unknown };
    if (!body || !body.businessId || !body.title || !body.sourceType) return jsonError("businessId, title, and sourceType are required.", 400);
    const websiteRules = readWebsiteImportRules(body.websiteRules);
    return NextResponse.json({ documentId: await createKnowledgeDocument(createDomainContext(), { userId: session.user.id, businessId: body.businessId, title: body.title, sourceType: body.sourceType, onboarding: body.onboarding === true, ...(body.sourceUrl ? { sourceUrl: body.sourceUrl } : {}), ...(websiteRules.length ? { websiteRules } : {}) }) }, { status: 201 });
  } catch (error) { return asApiResponse(error); }
}
