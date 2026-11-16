import { NextResponse } from "next/server";

import { createKnowledgeDocument, listKnowledgeDocumentsInTransaction, readWebsiteImportRules } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, requireApiSession, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => ({ documents: await listKnowledgeDocumentsInTransaction(tx, { businessId }) }))); } catch (error) { return asApiResponse(error); }
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
