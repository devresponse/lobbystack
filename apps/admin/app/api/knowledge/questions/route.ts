import { NextResponse } from "next/server";

import { listOpenUnansweredQuestions } from "@lobbystack/domain";
import { asApiResponse, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { receptionistIdFromRequest } from "@/lib/receptionist-filter";

export const dynamic = "force-dynamic";

/** The open questions, each with who heard it. ?receptionist=<id> keeps the ones that receptionist heard. */
export async function GET(request: Request) {
  try {
    const receptionistId = receptionistIdFromRequest(request);
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json(await listOpenUnansweredQuestions(createDomainContext(), { userId: session.user.id, businessId, ...(receptionistId ? { receptionistId } : {}) }));
  } catch (error) { return asApiResponse(error); }
}
