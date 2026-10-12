import { NextResponse } from "next/server";

import { getNotificationPreferences, normalizeOperatorNotificationEventPreferences, setNotificationPreferences } from "@lobbystack/domain";
import { asApiResponse, businessIdFromRequest, jsonError, readJson, requireApiSession, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { hasVerifiedPhone } from "@/lib/verified-phone";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json(await getNotificationPreferences(createDomainContext(), { userId: session.user.id, businessId, phoneVerified: await hasVerifiedPhone(session.user.id) }));
  } catch (error) { return asApiResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const session = await requireApiSession(request);
    const businessId = businessIdFromRequest(request);
    const body = await readJson(request) as Record<string, unknown>;
    if (!businessId || typeof body.emailEnabled !== "boolean" || typeof body.smsEnabled !== "boolean") return jsonError("Valid notification preferences are required.", 400);
    const eventPreferences = normalizeOperatorNotificationEventPreferences(body.eventPreferences);
    const dailySummaryEnabled = body.dailySummaryEnabled === true;
    const dailySummarySendTime = typeof body.dailySummarySendTime === "string" && body.dailySummarySendTime ? body.dailySummarySendTime : null;
    if (dailySummaryEnabled && (!dailySummarySendTime || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailySummarySendTime))) return jsonError("A valid daily summary time is required.", 400);
    if (body.smsEnabled || Object.values(eventPreferences).some(event => event.sms)) {
      const current = await getNotificationPreferences(createDomainContext(), { userId: session.user.id, businessId, phoneVerified: await hasVerifiedPhone(session.user.id) });
      if (!current.canUseSms) return NextResponse.json({ error: current.smsUnavailableReason === "sender_missing" ? "An alert SMS sender is required for SMS notifications." : "Verify your phone before enabling SMS notifications." }, { status: 400 });
    }
    await setNotificationPreferences(createDomainContext(), { userId: session.user.id, businessId, emailEnabled: body.emailEnabled, smsEnabled: body.smsEnabled, eventPreferences, dailySummaryEnabled, dailySummarySendTime, ...(typeof body.smsConsent === "boolean" ? { smsConsent: body.smsConsent } : {}) });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}
