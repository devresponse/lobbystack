import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { confirmBusinessCancellation } from "@lobbystack/domain";
import { logEvent } from "@lobbystack/telemetry/node";
import { asApiResponse, jsonError, readJson, requireApiSession } from "@/lib/api-helpers";
import { rateLimitedResponse } from "@/lib/business-cancellation-limit";
import { createDomainContext } from "@/lib/domain-context";
import { enforceFixedWindow, fixedWindowLimit } from "@/lib/fixed-window-limit";
import { passwordMatches } from "@/lib/password-check";

export const dynamic = "force-dynamic";

/**
 * Cancels a business from the link emailed to its owner, for that owner
 * signed in, with their password (confirmBusinessCancellation says what it
 * does and refuses). Nothing is deleted. 10 tries an hour per person.
 */
export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const body = await readJson(request) as { token?: unknown; password?: unknown } | null;
    if (typeof body?.token !== "string" || !body.token.trim()) return jsonError("The cancellation link is missing its token.", 400, "token_required");
    if (typeof body.password !== "string" || !body.password) return jsonError("Enter your password to confirm.", 400, "password_required");
    const limit = await enforceFixedWindow([fixedWindowLimit("business-cancel", "user-hour", session.user.id, 10, 60 * 60, "rate_limit_user_hour")]);
    if (!limit.allowed) return rateLimitedResponse(limit.status);
    if (!await passwordMatches(request, body.password)) return jsonError("That password isn't right.", 400, "invalid_password");
    const tokenHash = createHash("sha256").update(body.token.trim()).digest("hex");
    const canceled = await confirmBusinessCancellation(createDomainContext(), { userId: session.user.id, tokenHash });
    logEvent("info", "business.canceled", { businessId: canceled.businessId, userId: session.user.id, endsPlan: canceled.endsPlan, numbersReleasedOn: canceled.numbersReleasedOn?.toISOString() ?? null });
    return NextResponse.json({ ok: true, businessName: canceled.businessName });
  } catch (error) {
    return asApiResponse(error);
  }
}
