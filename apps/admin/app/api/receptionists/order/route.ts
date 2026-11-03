import { NextResponse } from "next/server";

import { listReceptionistChoicesInTransaction, readReceptionistOrder, reorderReceptionistsInTransaction } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Sets the order pickers and the business page list receptionists in, from
 * receptionistIds: every receptionist that isn't archived, once each. "Sort
 * A–Z" on the Receptionists page sends them by name. Owners and admins.
 */
export async function PUT(request: Request) {
  try {
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw jsonError("A JSON object is required.", 400, "invalid_order");
    const receptionistIds = readReceptionistOrder((body as { receptionistIds?: unknown }).receptionistIds);
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      await reorderReceptionistsInTransaction(tx, { businessId, receptionistIds });
      return { receptionists: await listReceptionistChoicesInTransaction(tx, { businessId }) };
    }, { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
