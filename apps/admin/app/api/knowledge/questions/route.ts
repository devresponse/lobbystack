import { NextResponse } from "next/server";

import { listOpenUnansweredQuestions } from "@lobbystack/domain";
import { asApiResponse, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { receptionistIdFromRequest } from "@/lib/receptionist-filter";

export const dynamic = "force-dynamic";

/**
 * The open questions, each with who heard it. ?receptionist=<id> keeps the
 * ones that receptionist heard; ?limit= (1 to 50, 50 without it) and
 * ?offset= pick a page of them.
 */
export async function GET(request: Request) {
  try {
    const receptionistId = receptionistIdFromRequest(request);
    const url = new URL(request.url);
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json(await listOpenUnansweredQuestions(createDomainContext(), { userId: session.user.id, businessId, ...(receptionistId ? { receptionistId } : {}), ...(limit !== null ? { limit: Number(limit) } : {}), ...(offset !== null ? { offset: Number(offset) } : {}) }));
  } catch (error) { return asApiResponse(error); }
}
