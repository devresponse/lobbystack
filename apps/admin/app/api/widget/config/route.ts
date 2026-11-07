import { NextResponse } from "next/server";

import { getCachedReceptionistSnapshot, getWebVoiceBillingAllowance, getWidgetChatAllowance } from "@lobbystack/domain";

import { asApiResponse } from "@/lib/api-helpers";
import { createWorkerDomainContext } from "@/lib/domain-context";
import { resolveWidgetSessionAccess } from "@/lib/widget-access";
import { requestIpHash } from "@/lib/widget-keys";
import { enforceWidgetRateLimits } from "@/lib/widget-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveWidgetSessionAccess(request);
    if (!access.ok) return access.response;
    const { session } = access;
    const visitorId = session.visitorId ?? "";
    const rate = await enforceWidgetRateLimits({ businessId: session.businessId, widgetKeyId: session.widgetKeyId, ...(visitorId ? { visitorId } : {}), ...(requestIpHash(request) ? { ipHash: requestIpHash(request) } : {}), operation: "config" });
    if (!rate.allowed) return NextResponse.json({ error: "Rate limit reached.", code: rate.code }, { status: rate.status });

    // The session request already saved the visitor and the key's last use.
    const context = createWorkerDomainContext();
    // The widget's receptionist, or the default one when it is paused or archived.
    const [snapshot, chatBilling, voiceBilling] = await Promise.all([
      getCachedReceptionistSnapshot(context, { businessId: session.businessId, receptionistId: session.receptionistId }),
      getWidgetChatAllowance(context, { businessId: session.businessId }),
      getWebVoiceBillingAllowance(context, { businessId: session.businessId }),
    ]);

    // The key's greeting is written for the receptionist the key names, the
    // default one when it names none. A page that another receptionist
    // answers, such as that receptionist's own page, leaves it out rather than
    // greet as someone else.
    const answering = snapshot?.receptionist;
    const keyGreetingFits = !answering || (session.keyReceptionistId ? answering.id === session.keyReceptionistId : answering.isDefault);
    const { greeting: keyGreeting, ...otherSettings } = session.config;

    return NextResponse.json({
      key: session.widgetKeyId,
      business: { id: session.businessId, name: session.businessName, defaultLocale: session.defaultLocale },
      config: keyGreetingFits ? session.config : otherSettings,
      billing: { chatAllowed: chatBilling.allowed, plan: chatBilling.plan, voiceAllowed: voiceBilling.allowed },
      greeting: (keyGreetingFits ? keyGreeting : undefined) ?? snapshot?.greeting ?? undefined,
      // Who answers: the widget's receptionist, or the default one for a paused or archived one.
      ...(snapshot?.receptionist ? { receptionist: { id: snapshot.receptionist.id, name: snapshot.receptionist.name, isDefault: snapshot.receptionist.isDefault } } : {}),
      snapshotPresent: snapshot !== null,
      businessSlug: session.businessSlug,
      // A call button shows only when a call can start: the business has a
      // number, this deployment runs live calls, and it has minutes left.
      voiceEnabled: Boolean(snapshot?.contactChannels?.phoneNumber) && process.env.LIVE_PROTOTYPE_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY) && voiceBilling.allowed,
      // The call says it's with an AI and recorded unless the business turned
      // that off, and the line under the call button says so before it starts.
      recordingNotice: snapshot?.recordingNotice !== false,
    });
  } catch (error) {
    return asApiResponse(error);
  }
}
