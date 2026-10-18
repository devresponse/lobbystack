import { NextResponse } from "next/server";

import { getCachedBusinessSnapshot, getWebVoiceBillingAllowance, getWidgetChatAllowance } from "@lobbystack/domain";

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
    const [snapshot, chatBilling, voiceBilling] = await Promise.all([
      getCachedBusinessSnapshot(context, { businessId: session.businessId }),
      getWidgetChatAllowance(context, { businessId: session.businessId }),
      getWebVoiceBillingAllowance(context, { businessId: session.businessId }),
    ]);

    return NextResponse.json({
      key: session.widgetKeyId,
      business: { id: session.businessId, name: session.businessName, defaultLocale: session.defaultLocale },
      config: session.config,
      billing: { chatAllowed: chatBilling.allowed, plan: chatBilling.plan, voiceAllowed: voiceBilling.allowed },
      greeting: session.config.greeting ?? snapshot?.greeting ?? undefined,
      snapshotPresent: snapshot !== null,
      businessSlug: session.businessSlug,
      // A call button shows only when a call can start: the business has a
      // number, this deployment runs live calls, and it has minutes left.
      voiceEnabled: Boolean(snapshot?.contactChannels?.phoneNumber) && process.env.LIVE_PROTOTYPE_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY) && voiceBilling.allowed,
    });
  } catch (error) {
    return asApiResponse(error);
  }
}
