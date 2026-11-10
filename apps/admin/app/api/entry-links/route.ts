import { NextResponse } from "next/server";

import { createEntryLinkInTransaction, listEntryLinksInTransaction, readEntryLinkCreateInput } from "@lobbystack/domain";
import { entryLinkStatuses, type EntryLinkStatus } from "@lobbystack/shared";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { receptionistIdFromRequest } from "@/lib/receptionist-filter";

export const dynamic = "force-dynamic";

// The QR links on the QR code page: short /q/<code> addresses that printed
// signs carry, each opening one receptionist's page. GET lists a page of 10,
// newest first, optionally one receptionist's (?receptionist=<id>), by status
// and a search of the label and code. Anyone on the team reads them; owners
// and admins add one with POST.

function pageNumber(value: string | null): number {
  const page = Number(value ?? 1);
  return Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
}

function statusFrom(value: string | null): EntryLinkStatus | undefined {
  if (!value) return undefined;
  if (!(entryLinkStatuses as readonly string[]).includes(value)) throw jsonError("status must be active or paused.", 400, "invalid_status");
  return value as EntryLinkStatus;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const receptionistId = receptionistIdFromRequest(request);
    const status = statusFrom(url.searchParams.get("status"));
    const search = url.searchParams.get("search")?.trim() || undefined;
    const page = pageNumber(url.searchParams.get("page"));
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => (
      await listEntryLinksInTransaction(tx, { businessId, receptionistId: receptionistId ?? undefined, status, search, page })
    )));
  } catch (error) { return asApiResponse(error); }
}

/** Adds a link with a new code for receptionistId's receptionist, labelled with where its sign hangs. */
export async function POST(request: Request) {
  try {
    const link = readEntryLinkCreateInput(await readJson(request));
    const created = await withOperatorTransaction(request, async ({ session, businessId, tx }) => (
      await createEntryLinkInTransaction(tx, { businessId, actorUserId: session.user.id, link })
    ), { minimumRole: "business_admin" });
    return NextResponse.json({ link: created }, { status: 201 });
  } catch (error) { return asApiResponse(error); }
}
