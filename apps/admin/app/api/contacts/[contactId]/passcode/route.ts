import { NextResponse } from "next/server";

import { removeContactPasscode, setContactPasscode } from "@lobbystack/domain";
import { isContactPasscode, isGuessableContactPasscode } from "@lobbystack/shared";
import { asApiResponse, jsonError, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

// The contact's keypad PIN for appointment changes. Responses say whether one
// is set, never the PIN.
export async function PUT(request: Request, context: { params: Promise<{ contactId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const body = await readJson(request);
    const passcode = typeof body === "object" && body !== null ? (body as { passcode?: unknown }).passcode : undefined;
    if (typeof passcode !== "string" || !isContactPasscode(passcode)) return jsonError("passcode must be 4 to 8 digits.", 400, "invalid_passcode");
    if (isGuessableContactPasscode(passcode)) return jsonError("passcode is too easy to guess.", 400, "guessable_passcode");
    const { contactId } = await context.params;
    const status = await setContactPasscode(createDomainContext(), { userId: session.user.id, businessId, contactId, passcode });
    return status ? NextResponse.json({ contactId, passcode: status }) : jsonError("Contact not found.", 404);
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ contactId: string }> }) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const { contactId } = await context.params;
    const removed = await removeContactPasscode(createDomainContext(), { userId: session.user.id, businessId, contactId });
    return removed ? NextResponse.json({ contactId, passcode: null }) : jsonError("Contact not found.", 404);
  } catch (error) {
    return asApiResponse(error);
  }
}
