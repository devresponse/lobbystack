import { NextResponse } from "next/server";

import { deleteWebsiteRuleInTransaction } from "@lobbystack/domain";
import { isUuid } from "@lobbystack/shared";
import { asApiResponse, jsonError, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Deletes a website rule and the links it made. A page it left chosen for
 * nobody goes back to everyone; one someone also chose receptionists for
 * keeps them. Owners and admins.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ ruleId: string }> }) {
  try {
    const { ruleId } = await params;
    if (!isUuid(ruleId)) throw jsonError("Website rule not found.", 404, "website_rule_not_found");
    await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      if (!await deleteWebsiteRuleInTransaction(tx, { businessId, actorUserId: session.user.id, ruleId: ruleId.toLowerCase() })) throw jsonError("Website rule not found.", 404, "website_rule_not_found");
    }, { minimumRole: "business_admin" });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}
