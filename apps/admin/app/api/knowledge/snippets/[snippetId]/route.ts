import { NextResponse } from "next/server";

import { deleteKnowledgeSnippet, readKnowledgeAudienceChoice, updateKnowledgeSnippet } from "@lobbystack/domain";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

/** Changes a text entry; audience, when given, changes who it is for in the same save. */
export async function PATCH(request: Request, { params }: { params: Promise<{ snippetId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const { audience: audienceField, receptionistIds, ...body } = await readJson(request) as { title?: string; content?: string; tags?: string[]; priority?: number; active?: boolean; audience?: unknown; receptionistIds?: unknown };
    const audience = audienceField === undefined ? undefined : readKnowledgeAudienceChoice({ audience: audienceField, receptionistIds });
    const { snippetId } = await params;
    await updateKnowledgeSnippet(createDomainContext(), { ...body, userId: session.user.id, businessId, snippetId, ...(audience ? { audience } : {}) });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ snippetId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const { snippetId } = await params;
    await deleteKnowledgeSnippet(createDomainContext(), { userId: session.user.id, businessId, snippetId });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}
