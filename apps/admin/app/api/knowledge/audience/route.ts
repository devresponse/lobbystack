import { NextResponse } from "next/server";

import { changeKnowledgeAudienceInTransaction, knowledgeAudienceLinksInTransaction, readKnowledgeAudienceChange } from "@lobbystack/domain";
import { asApiResponse, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

// Who each article is for, on the Knowledge page. GET gives the receptionists
// each chosen article is for (articles for everyone have no entry), with the
// website rule that chose a page, if one did; anyone on the team reads them.
// POST changes "Available to" for the articles selected, one or many: to
// everyone, or for chosen receptionists added to, removed from or replacing
// who they are for. Owners and admins.

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => (
      await knowledgeAudienceLinksInTransaction(tx, { businessId })
    )));
  } catch (error) { return asApiResponse(error); }
}

/** Returns how many files and pages, and text entries, the change covered; ones deleted meanwhile are skipped. */
export async function POST(request: Request) {
  try {
    const change = readKnowledgeAudienceChange(await readJson(request));
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => (
      await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: session.user.id, change })
    ), { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
