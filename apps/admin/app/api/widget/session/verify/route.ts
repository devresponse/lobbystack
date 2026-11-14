import { NextResponse } from "next/server";

import { bearerToken } from "@lobbystack/domain";
import { widgetSessionResponseSchema, widgetSessionVerifyRequestSchema } from "@lobbystack/shared";
import { logEvent } from "@lobbystack/telemetry/node";

import { runAfterResponse } from "@/lib/after-response";
import { readJson } from "@/lib/api-helpers";
import { reportServerError } from "@/lib/error-reporting";
import { trustedClientIp } from "@/lib/trusted-client-ip";
import { TurnstileError, verifyTurnstile } from "@/lib/turnstile";
import { resolveWidgetSessionAccess } from "@/lib/widget-access";
import { widgetChallengeRequired } from "@/lib/widget-challenge";
import { createWidgetSessionToken, requestIpHash, verifyWidgetSessionToken } from "@/lib/widget-keys";
import { enforceWidgetRateLimits } from "@/lib/widget-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/widget/session/verify";
const NO_STORE = { "cache-control": "no-store" };

// The chat only says that the check didn't pass; the log line says why.
function refused(status: number, code: string, error: string, fields: Record<string, string | undefined> = {}): NextResponse {
  logEvent("warn", "widget.verify_refused", { status, code, ...fields });
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

/**
 * The website chat's Turnstile check (AUDIT-004). The chat's frame, on the
 * deployment's own address, sends the token Turnstile gave it with the
 * session the loader got, and gets the same session back, signed as checked.
 * The chat route wants that before the receptionist answers, so a script
 * that makes up visitors gets nowhere without passing Turnstile for each one.
 */
export async function POST(request: Request) {
  try {
    if (!widgetChallengeRequired()) return refused(404, "widget_challenge_off", "This chat has no check to pass.");
    const parsed = widgetSessionVerifyRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return refused(400, "widget_challenge_input_invalid", "A Turnstile token is required.");
    const access = await resolveWidgetSessionAccess(request);
    if (!access.ok) return access.response;
    // The new session keeps exactly what the old one signed, the page's receptionist included.
    const payload = verifyWidgetSessionToken(bearerToken(request.headers.get("authorization")) ?? "");
    if (!payload) return refused(401, "widget_session_invalid", "The widget session is invalid or expired.");
    const ipHash = requestIpHash(request);
    const rate = await enforceWidgetRateLimits({ businessId: payload.businessId, widgetKeyId: payload.widgetKeyId, visitorId: payload.visitorId, ...(ipHash ? { ipHash } : {}), operation: "verify" });
    if (!rate.allowed) return refused(rate.status, rate.code, "Too many checks. Try again later.", { reason: rate.reason });
    try {
      await verifyTurnstile({ token: parsed.data.turnstileToken, remoteIp: trustedClientIp(request) ?? null });
    } catch (error) {
      if (!(error instanceof TurnstileError) || error.reason === "not_configured") throw error;
      // Cloudflare couldn't be asked: the chat tries again with a new token.
      if (error.reason === "unavailable") return refused(503, "widget_challenge_unavailable", "The check couldn't be confirmed. Try again.");
      return refused(403, "widget_challenge_failed", "The check didn't pass.");
    }
    const minted = createWidgetSessionToken({
      widgetKeyId: payload.widgetKeyId,
      businessId: payload.businessId,
      visitorId: payload.visitorId,
      origin: payload.origin,
      ...(payload.receptionistId ? { receptionistId: payload.receptionistId } : {}),
      verifiedAt: Math.floor(Date.now() / 1000),
    });
    return NextResponse.json(widgetSessionResponseSchema.parse({ token: minted.token, expiresAt: minted.expiresAt, expiresIn: minted.expiresIn, visitorId: payload.visitorId }), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof Response) return error;
    // The visitor only learns that the check couldn't finish; the report says why.
    const errorId = crypto.randomUUID();
    runAfterResponse(() => reportServerError(error, { operation: "widget_session_verify", errorId, route: ROUTE }));
    return NextResponse.json({ error: "The check could not be completed.", code: "widget_challenge_error", errorId }, { status: 500, headers: { ...NO_STORE, "x-error-id": errorId } });
  }
}
