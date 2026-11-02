import { NextResponse } from "next/server";

import { saveOnboardingWebsite } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

// Onboarding's website step: saves the address as the business's website and
// moves on to knowledge. It starts no crawl; the site is read only when the
// owner adds it on the Knowledge page.
export async function POST(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const body = await readJson(request);
    const websiteUrl = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { websiteUrl?: unknown }).websiteUrl : undefined;
    if (typeof websiteUrl !== "string" || websiteUrl.trim().length === 0 || websiteUrl.length > 2_000) {
      return jsonError("Enter a valid website URL.", 422, "website_url_invalid");
    }
    const saved = await saveOnboardingWebsite(createDomainContext(), { userId: session.user.id, businessId, websiteUrl });
    return NextResponse.json({ ok: true, ...saved });
  } catch (error) {
    return asApiResponse(error);
  }
}
