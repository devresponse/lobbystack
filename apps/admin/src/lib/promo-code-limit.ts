import { NextResponse } from "next/server";

import { enforceFixedWindow, fixedWindowLimit, type FixedWindowResult } from "./fixed-window-limit";

/**
 * Each promo code someone tries is a guess at a secret. A business can try 10
 * codes an hour, from the dashboard and its API keys together; a person and an
 * address 20 each, across businesses.
 */
export async function checkPromoCodeLimit(input: { businessId: string; userId?: string | undefined; ip?: string | undefined }): Promise<FixedWindowResult> {
  return await enforceFixedWindow([
    fixedWindowLimit("promo-code", "business-hour", input.businessId, 10, 60 * 60, "rate_limit_business_hour"),
    ...(input.userId ? [fixedWindowLimit("promo-code", "user-hour", input.userId, 20, 60 * 60, "rate_limit_user_hour")] : []),
    ...(input.ip ? [fixedWindowLimit("promo-code", "ip-hour", input.ip, 20, 60 * 60, "rate_limit_ip_hour")] : []),
  ]);
}

/** Too many codes tried: 429 until the hour's window ends, or 503 while the limiter is down. */
export function promoCodeLimitResponse(status: 429 | 503): NextResponse {
  if (status === 503) return NextResponse.json({ error: "Promo codes are unavailable for a moment. Try again shortly.", code: "rate_limit_unavailable" }, { status, headers: { "Retry-After": "5" } });
  const retryAfter = 3_600 - (Math.floor(Date.now() / 1_000) % 3_600);
  return NextResponse.json({ error: "Too many promo codes tried. Try again later.", code: "promo_rate_limited" }, { status, headers: { "Retry-After": String(retryAfter) } });
}
