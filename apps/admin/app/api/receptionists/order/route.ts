import { NextResponse } from "next/server";

import { listReceptionistChoicesInTransaction, readReceptionistOrder, reorderReceptionistsInTransaction, sortReceptionistsByNameInTransaction } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Sets the order pickers and the business page list receptionists in, after
 * the default. { order: "alphabetical" } lists them by name from now on, new
 * ones included ("Sort A–Z" and "Alphabetical" on the business page);
 * { receptionistIds } is a custom order: every receptionist that isn't
 * archived, once each. Owners and admins.
 */
export async function PUT(request: Request) {
  try {
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw jsonError("A JSON object is required.", 400, "invalid_order");
    const { order, receptionistIds: ids } = body as { order?: unknown; receptionistIds?: unknown };
    if (order !== undefined && order !== "alphabetical") throw jsonError("order must be alphabetical.", 400, "invalid_order");
    if (order !== undefined && ids !== undefined) throw jsonError("Send either order or receptionistIds.", 400, "invalid_order");
    const receptionistIds = order === undefined ? readReceptionistOrder(ids) : null;
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      if (receptionistIds) await reorderReceptionistsInTransaction(tx, { businessId, receptionistIds });
      else await sortReceptionistsByNameInTransaction(tx, { businessId });
      return { receptionists: await listReceptionistChoicesInTransaction(tx, { businessId }) };
    }, { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
