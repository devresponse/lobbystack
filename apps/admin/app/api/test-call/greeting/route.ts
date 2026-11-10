import { NextResponse } from "next/server";

import { snapshotForReceptionist } from "@lobbystack/domain";
import { isUuid, type BusinessContextSnapshot } from "@lobbystack/shared";
import { logEvent } from "@lobbystack/telemetry/node";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { loadValidBusinessSnapshot } from "@/lib/business-snapshot";
import { greetingRecordingStatus, type GreetingRecordingStatus } from "@/lib/live-greeting";
import { requestGreetingRecording } from "@/lib/live-prototype";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Gets the dashboard's test call ready to open with a recording of its
 * opening. GPT-Live skips the spoken greeting on about one call in three,
 * and a call opens with the recording only once the worker has made one, so
 * the test call asks as the dashboard opens, when its receptionist changes,
 * and again when the owner clicks, and waits a little while one is being
 * recorded. Answers `{ status }` (GreetingRecordingStatus): a missing
 * recording is asked for and answers `recording`, `off` when the worker
 * records none, or `missing` when it can't be reached; `off` too while
 * GPT-Live is off. Body:
 * `{ receptionistId? }`, the default receptionist without one, or for a
 * paused or archived one, as the call itself. Owners and admins, who can
 * make test calls.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const value = body && typeof body === "object" ? (body as Record<string, unknown>).receptionistId : undefined;
    if (value !== undefined && value !== null && (typeof value !== "string" || !isUuid(value))) throw jsonError("receptionistId must be an ID.", 400, "invalid_receptionist");
    const receptionistId = typeof value === "string" ? value.toLowerCase() : undefined;
    const businessId = await withOperatorTransaction(request, async ({ businessId }) => businessId, { minimumRole: "business_admin" });
    // The dashboard asks on every page, so with GPT-Live off this answers off,
    // not the other GPT-Live routes' 404, an error in the browser's console.
    if (process.env.LIVE_PROTOTYPE_ENABLED !== "true") return NextResponse.json({ status: "off" satisfies GreetingRecordingStatus });
    const stored = await loadValidBusinessSnapshot(businessId) as BusinessContextSnapshot | null;
    if (!stored) return NextResponse.json({ status: "off" satisfies GreetingRecordingStatus });
    let status = await greetingRecordingStatus(snapshotForReceptionist(stored, receptionistId));
    if (status === "missing") {
      // A worker that records none, as with LIVE_RECORDED_GREETING=false there, makes the call open without one.
      status = await requestGreetingRecording({ businessId, ...(receptionistId ? { receptionistId } : {}) }).then(
        (recording) => (recording ? "recording" as const : "off" as const),
        (error: unknown) => {
          logEvent("warn", "live.greeting_recording_unrequested", { error });
          return "missing" as const;
        },
      );
    }
    return NextResponse.json({ status });
  } catch (error) {
    return asApiResponse(error);
  }
}
