import { NextResponse } from "next/server";

import { listReceptionistChoicesInTransaction, readListedReceptionists, setListedReceptionistsInTransaction } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Sets which receptionists the business page lists under "You're talking
 * to" from receptionistIds, in one step: those and no other besides the
 * default, which always stays. Gives the pickers' list back.
 * Owners and admins.
 */
export async function PUT(request: Request) {
  try {
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw jsonError("A JSON object is required.", 400, "invalid_listed");
    const receptionistIds = readListedReceptionists((body as { receptionistIds?: unknown }).receptionistIds);
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      await setListedReceptionistsInTransaction(tx, { businessId, actorUserId: session.user.id, receptionistIds });
      return { receptionists: await listReceptionistChoicesInTransaction(tx, { businessId }) };
    }, { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
