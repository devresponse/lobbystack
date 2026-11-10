import { NextResponse } from "next/server";

import {
  archiveReceptionistInTransaction,
  makeDefaultReceptionistInTransaction,
  readReceptionistIdentityPatch,
  restoreReceptionistInTransaction,
  setReceptionistStatusInTransaction,
  updateReceptionistInTransaction,
} from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

// One receptionist, for owners and admins. PATCH changes what the
// Receptionists page edits: its name, "What it helps with", page address,
// language, knowledge and whether visitors can pick it. POST takes an action:
// pause, resume, archive, restore or make_default. AI settings change the rest
// (/api/agent?receptionist=<id>).

type Params = { params: Promise<{ receptionistId: string }> };

const actions = ["pause", "resume", "archive", "restore", "make_default"] as const;
type Action = (typeof actions)[number];

export async function PATCH(request: Request, { params }: Params) {
  try {
    const patch = readReceptionistIdentityPatch(await readJson(request));
    const { receptionistId } = await params;
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => ({
      receptionist: await updateReceptionistInTransaction(tx, { businessId, actorUserId: session.user.id, receptionistId, patch }),
    }), { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const body = await readJson(request);
    const action = typeof body === "object" && body !== null ? (body as { action?: unknown }).action : undefined;
    if (!(actions as readonly unknown[]).includes(action)) throw jsonError("action must be pause, resume, archive, restore or make_default.", 400, "invalid_action");
    const { receptionistId } = await params;
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const actor = { businessId, actorUserId: session.user.id, receptionistId };
      switch (action as Action) {
        case "pause": return { receptionist: await setReceptionistStatusInTransaction(tx, { ...actor, status: "paused" }) };
        case "resume": return { receptionist: await setReceptionistStatusInTransaction(tx, { ...actor, status: "active" }) };
        case "archive": await archiveReceptionistInTransaction(tx, actor); return { receptionist: null };
        case "restore": return { receptionist: await restoreReceptionistInTransaction(tx, actor) };
        case "make_default": return { receptionist: await makeDefaultReceptionistInTransaction(tx, actor) };
      }
    }, { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
