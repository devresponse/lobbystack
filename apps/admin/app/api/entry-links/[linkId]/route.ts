import { NextResponse } from "next/server";

import { getEntryLinkInTransaction, listEntryLinkScansInTransaction, readEntryLinkPatch, updateEntryLinkInTransaction } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

// One QR link. GET gives it with its scans per day for the chart (days
// without scans left out); anyone on the team reads it. PATCH changes its
// receptionist, label or status, for owners and admins. Its code never
// changes, and links are paused rather than deleted, so a printed sign always
// opens a page.

type Params = { params: Promise<{ linkId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const { linkId } = await params;
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const link = await getEntryLinkInTransaction(tx, { businessId, linkId });
      if (!link) throw jsonError("QR link not found.", 404, "entry_link_not_found");
      return { link, scans: await listEntryLinkScansInTransaction(tx, { businessId, linkId: link.id }) };
    }));
  } catch (error) { return asApiResponse(error); }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const patch = readEntryLinkPatch(await readJson(request));
    const { linkId } = await params;
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => ({
      link: await updateEntryLinkInTransaction(tx, { businessId, actorUserId: session.user.id, linkId, patch }),
    }), { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
