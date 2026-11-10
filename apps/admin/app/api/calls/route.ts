import { NextResponse } from "next/server";

import { listCalls } from "@lobbystack/domain";
import { asApiResponse, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { receptionistIdFromRequest } from "@/lib/receptionist-filter";

export const dynamic = "force-dynamic";

/** The Calls page's list. ?receptionist=<id> keeps the calls that receptionist answered. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const receptionistId = receptionistIdFromRequest(request);
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json(await listCalls(createDomainContext(), {
      userId: session.user.id,
      businessId,
      ...(receptionistId ? { receptionistId } : {}),
      ...(url.searchParams.get("search") ? { search: url.searchParams.get("search")! } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
    }));
  } catch (error) { return asApiResponse(error); }
}
