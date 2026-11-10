import { NextResponse } from "next/server";

import { createBillingSubscriptionRequest, isBillingSubscriptionAction } from "@lobbystack/domain";
import { asApiResponse, businessIdFromRequest, readJson, requireApiSession } from "@/lib/api-helpers";
import { assertBillingCallAllowed } from "@/lib/billing-limit";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

/**
 * Settings > Plan's Cancel plan, Resume and Keep my plan (the Stripe plan's
 * step 15): a request the billing.changeSubscription job makes, which the
 * page follows as it follows a checkout, through GET /api/billing/checkout.
 */
export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("A subscription change is required.");
    const input = body as Record<string, unknown>;
    const businessId = typeof input.businessId === "string" ? input.businessId : businessIdFromRequest(request);
    if (!businessId) throw new Error("A businessId is required.");
    if (typeof input.action !== "string" || !isBillingSubscriptionAction(input.action)) throw Object.assign(new Error("action must be cancel, resume or keep."), { status: 400 });
    // Each new request is a call to the billing provider, and counts as a checkout does.
    const checkLimit = (subject: { businessId: string; userId: string }) => assertBillingCallAllowed("checkout", subject);
    const requestId = await createBillingSubscriptionRequest(createDomainContext(), { userId: session.user.id, businessId, action: input.action, checkLimit });
    return NextResponse.json({ requestId }, { status: 202 });
  } catch (error) {
    return asApiResponse(error);
  }
}
