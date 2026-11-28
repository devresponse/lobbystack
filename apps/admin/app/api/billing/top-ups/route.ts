import { NextResponse } from "next/server";

import { redeemTopUpCodeInTransaction, topUpCodeRefusalError } from "@lobbystack/domain";
import { asApiResponse, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { checkPromoCodeLimit, promoCodeLimitResponse } from "@/lib/promo-code-limit";
import { trustedClientIp } from "@/lib/trusted-client-ip";

export const dynamic = "force-dynamic";

/**
 * Adds a top-up code's top-up to the business, at once and without a payment:
 * { topUp }, or 400 promo_invalid for a code that doesn't work, or 409
 * promo_used once the business or the person added it. Each try counts
 * against the promo code limits, as a lookup does.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
    if (!code.trim()) throw topUpCodeRefusalError("invalid");
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const limit = await checkPromoCodeLimit({ businessId, userId: session.user.id, ip: trustedClientIp(request) });
      if (!limit.allowed) throw promoCodeLimitResponse(limit.status);
      const result = await redeemTopUpCodeInTransaction(tx, { businessId, userId: session.user.id, code });
      if ("refusal" in result) throw topUpCodeRefusalError(result.refusal);
      return { topUp: result.topUp };
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}
