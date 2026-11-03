import { NextResponse } from "next/server";

import { listReceptionistChoicesInTransaction } from "@lobbystack/domain";
import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * The business's receptionists that aren't archived, for every dropdown,
 * multiselect and filter: the default first, then the Receptionists page's
 * order. Anyone on the team reads them.
 */
export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => ({
      receptionists: await listReceptionistChoicesInTransaction(tx, { businessId }),
    })));
  } catch (error) { return asApiResponse(error); }
}
