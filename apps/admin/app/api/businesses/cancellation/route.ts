import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { users } from "@lobbystack/db";
import { previewBusinessCancellation, requestBusinessCancellation } from "@lobbystack/domain";
import { normalizeInterfaceLocale } from "@lobbystack/shared";
import { logEvent } from "@lobbystack/telemetry/node";
import { asApiResponse, businessIdFromRequest, jsonError, readJson, requireApiSession } from "@/lib/api-helpers";
import { getAuthDatabase } from "@/lib/auth";
import { rateLimitedResponse } from "@/lib/business-cancellation-limit";
import { createDomainContext } from "@/lib/domain-context";
import { enforceFixedWindow, fixedWindowLimit } from "@/lib/fixed-window-limit";

export const dynamic = "force-dynamic";

/** What the confirmation page shows for its link. Whoever holds the link may see it, as with an invitation's. */
export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token")?.trim();
    if (!token) return NextResponse.json({ cancellation: null });
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return NextResponse.json({ cancellation: await previewBusinessCancellation(createDomainContext(), { tokenHash }) });
  } catch (error) {
    return asApiResponse(error);
  }
}

/**
 * Asks to cancel the business the query names, for its owner, once it's the
 * only business they own (requestBusinessCancellation says who may). The
 * request confirms with its typed name. The owner gets an email with a link
 * to confirm, in their dashboard language, and the inbox the business's
 * details. Each try can send two emails, so 5 an hour per person.
 */
export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const businessId = businessIdFromRequest(request);
    if (!businessId) return jsonError("A businessId is required.", 400, "business_required");
    const body = await readJson(request) as { confirmName?: unknown } | null;
    if (typeof body?.confirmName !== "string" || !body.confirmName.trim()) return jsonError("Type the business's name to confirm.", 400, "confirmation_required");
    const limit = await enforceFixedWindow([fixedWindowLimit("business-cancel-request", "user-hour", session.user.id, 5, 60 * 60, "rate_limit_user_hour")]);
    if (!limit.allowed) return rateLimitedResponse(limit.status);
    // Only the auth role can read the person's language.
    const [owner] = await getAuthDatabase().db.select({ locale: users.preferredLocale }).from(users).where(eq(users.id, session.user.id)).limit(1);
    const requested = await requestBusinessCancellation(createDomainContext(), { userId: session.user.id, businessId, confirmName: body.confirmName, locale: normalizeInterfaceLocale(owner?.locale) ?? undefined });
    logEvent("info", "business.cancellation_requested", { businessId, userId: session.user.id });
    if (!requested.inboxNotified) logEvent("warn", "business.cancellation_inbox_missing", { businessId, message: "No inbox heard about this cancellation request: set the brand's contactEmail or FEEDBACK_TO_EMAIL." });
    return NextResponse.json({ email: requested.email, expiresAt: requested.expiresAt.toISOString() });
  } catch (error) {
    return asApiResponse(error);
  }
}
