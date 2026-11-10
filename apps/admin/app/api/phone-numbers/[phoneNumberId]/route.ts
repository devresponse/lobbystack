import { NextResponse } from "next/server";

import { readEntryPointReceptionist, setPhoneNumberReceptionistInTransaction } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Chooses who answers one of the business's numbers: receptionistId's
 * receptionist takes its calls and texts from the next one on. A paused one
 * may be chosen; the default receptionist answers for it until it resumes.
 * Owners and admins.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ phoneNumberId: string }> }) {
  try {
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw jsonError("A JSON object is required.", 400, "invalid_body");
    const receptionistId = readEntryPointReceptionist((body as { receptionistId?: unknown }).receptionistId);
    const { phoneNumberId } = await params;
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => ({
      phoneNumber: await setPhoneNumberReceptionistInTransaction(tx, { businessId, actorUserId: session.user.id, phoneNumberId, receptionistId }),
    }), { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
