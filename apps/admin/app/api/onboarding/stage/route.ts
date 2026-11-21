import { NextResponse } from "next/server";

import { advanceOnboardingStage, isOnboardingStage } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const body = await readJson(request);
    const target = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { to?: unknown }).to : undefined;
    if (!isOnboardingStage(target) || target === "create_business" || target === "complete") {
      return jsonError("A valid next onboarding stage is required.", 400);
    }
    // The step to open next: the one asked for, or the one the server puts in its place, as the plan step
    // after the name where the deployment has one, and the last step in place of the number step on a
    // plan without a number.
    const stage = await advanceOnboardingStage(createDomainContext(), { userId: session.user.id, businessId, to: target });
    return NextResponse.json({ ok: true, stage });
  } catch (error) {
    return asApiResponse(error);
  }
}
