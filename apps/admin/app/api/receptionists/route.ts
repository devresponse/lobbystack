import { NextResponse } from "next/server";

import { createReceptionistInTransaction, listReceptionistsInTransaction, readReceptionistCreateInput, readReceptionistStatus, receptionistAllowanceInTransaction } from "@lobbystack/domain";
import { asApiResponse, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

// The Receptionists page. GET lists a page, 10 rows unless pageSize asks for
// up to 50: the receptionists that aren't archived, or with view=archived the
// archived ones, optionally by status (active or paused) and a search of the
// name and "What it helps with", with the plan's allowance. Anyone on the team
// reads it; owners and admins add receptionists with POST.

function pageNumber(value: string | null): number {
  const page = Number(value ?? 1);
  return Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
}

function pageSizeFrom(value: string | null): number {
  const size = Number(value ?? 10);
  return Number.isInteger(size) && size >= 1 && size <= 50 ? size : 10;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const view = url.searchParams.get("view") === "archived" ? "archived" : "current";
    const statusParam = url.searchParams.get("status");
    const status = statusParam ? readReceptionistStatus(statusParam) : undefined;
    const search = url.searchParams.get("search")?.trim() || undefined;
    const page = pageNumber(url.searchParams.get("page"));
    const pageSize = pageSizeFrom(url.searchParams.get("pageSize"));
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const list = await listReceptionistsInTransaction(tx, { businessId, view, status, search, page, pageSize });
      const allowance = await receptionistAllowanceInTransaction(tx, { businessId });
      return { ...list, allowance };
    }));
  } catch (error) { return asApiResponse(error); }
}

/** Adds a receptionist with the settings of copyFromId's receptionist, or the default one's. */
export async function POST(request: Request) {
  try {
    const receptionist = readReceptionistCreateInput(await readJson(request));
    const created = await withOperatorTransaction(request, async ({ session, businessId, tx }) => (
      await createReceptionistInTransaction(tx, { businessId, actorUserId: session.user.id, receptionist })
    ), { minimumRole: "business_admin" });
    return NextResponse.json({ receptionist: created }, { status: 201 });
  } catch (error) { return asApiResponse(error); }
}
