import { NextResponse } from "next/server";

import { endedCallIdsInTransaction } from "@lobbystack/domain";

import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";
import { countActiveVoiceCalls, getVoicePresenceCallIds, removeCompletedVoicePresence } from "@/lib/voice-presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const callIds = await getVoicePresenceCallIds(businessId);
      const ended = await endedCallIdsInTransaction(tx, { businessId, callIds });
      await Promise.all(ended.map((id) => removeCompletedVoicePresence({ businessId, callId: id })));
      return { active: await countActiveVoiceCalls(businessId) };
    }));
  } catch (error) {
    return asApiResponse(error);
  }
}
