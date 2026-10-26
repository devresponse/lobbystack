import { NextResponse } from "next/server";

import { hasMinimumRole, loadCallTranscriptSettingsInTransaction, requireBusinessMembership, saveCallTranscriptSettingsInTransaction } from "@lobbystack/domain";
import { isCallTranscriptContent, isCallTranscriptRecipients } from "@lobbystack/shared";

import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

// Who on the team can get an email after each call, and what it holds: every
// member can read it, and owners and admins change it.

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const membership = await requireBusinessMembership(tx, { userId: session.user.id, businessId });
      return { ...await loadCallTranscriptSettingsInTransaction(tx, { businessId }), canEdit: hasMinimumRole(membership.role, "business_admin") };
    }));
  } catch (error) { return asApiResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const body = await readJson(request);
    const { recipients, content, ...rest } = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    if (Object.keys(rest).length || (recipients === undefined && content === undefined) || (recipients !== undefined && !isCallTranscriptRecipients(recipients)) || (content !== undefined && !isCallTranscriptContent(content))) {
      return jsonError("Send recipients (nobody, owners_and_admins or team), content (summary or transcript), or both.", 400, "call_transcript_settings_invalid");
    }
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => ({
      ...await saveCallTranscriptSettingsInTransaction(tx, { businessId, change: { ...(recipients !== undefined ? { recipients } : {}), ...(content !== undefined ? { content } : {}) }, audit: { actorUserId: session.user.id } }),
      canEdit: true,
    }), { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
