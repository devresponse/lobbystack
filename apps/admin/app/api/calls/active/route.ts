import { NextResponse } from "next/server";

import { endedCallIdsInTransaction } from "@lobbystack/domain";
import { logEvent } from "@lobbystack/telemetry/node";

import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";
import { jsonError } from "@/lib/request-input";
import { countActiveVoiceCalls, getVoicePresenceCallIds, removeCompletedVoicePresence, VoicePresenceUnavailableError } from "@/lib/voice-presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAVAILABLE_LOG_INTERVAL_MS = 60_000;
let unavailableLoggedAt = Number.NEGATIVE_INFINITY;

/**
 * No worker is reporting in, or a call's own report has gone stale, so there
 * is no count to give and the Calls page shows "Live status unavailable".
 *
 * An open Calls page asks every 5 seconds. This used to be a plain error, so
 * each of those requests answered 500 and was reported as a server fault
 * (AUDIT-007). It is a state the route knows, so it answers 503 with a code,
 * and one log line a minute for each admin process says it is still so.
 */
function presenceUnavailable(businessId: string | undefined): NextResponse {
  const now = Date.now();
  if (now - unavailableLoggedAt >= UNAVAILABLE_LOG_INTERVAL_MS) {
    unavailableLoggedAt = now;
    logEvent("warn", "calls.live_presence_unavailable", { businessId });
  }
  return jsonError("The count of live calls is unavailable right now.", 503, "live_presence_unavailable");
}

export async function GET(request: Request) {
  let counted: string | undefined;
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      counted = businessId;
      const callIds = await getVoicePresenceCallIds(businessId);
      const ended = await endedCallIdsInTransaction(tx, { businessId, callIds });
      await Promise.all(ended.map((id) => removeCompletedVoicePresence({ businessId, callId: id })));
      return { active: await countActiveVoiceCalls(businessId) };
    }));
  } catch (error) {
    if (error instanceof VoicePresenceUnavailableError) return presenceUnavailable(counted);
    return asApiResponse(error);
  }
}
