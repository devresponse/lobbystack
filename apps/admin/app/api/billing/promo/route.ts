import { NextResponse } from "next/server";

import { billingCodeRefusalError, billingCodeView, polarCheckoutConfigured } from "@lobbystack/domain";
import { asApiResponse, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { checkPromoCodeLimit, promoCodeLimitResponse } from "@/lib/promo-code-limit";
import { trustedClientIp } from "@/lib/trusted-client-ip";

export const dynamic = "force-dynamic";

/** The plan a promo code unlocks for the business, its discount and prices; or 400 promo_invalid for a code that doesn't work. */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
    if (!code.trim()) throw billingCodeRefusalError("invalid");
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const limit = await checkPromoCodeLimit({ businessId, userId: session.user.id, ip: trustedClientIp(request) });
      if (!limit.allowed) throw promoCodeLimitResponse(limit.status);
      const view = await billingCodeView(tx, { businessId, code, checkout: polarCheckoutConfigured(process.env) });
      if (!view) throw billingCodeRefusalError("invalid");
      return view;
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}
