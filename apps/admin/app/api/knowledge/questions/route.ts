import { NextResponse } from "next/server";

import { listOpenUnansweredQuestions } from "@lobbystack/domain";
import { asApiResponse, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json(await listOpenUnansweredQuestions(createDomainContext(), { userId: session.user.id, businessId }));
  } catch (error) { return asApiResponse(error); }
}
