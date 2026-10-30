import { NextResponse } from "next/server";

/** The answer to a person who asked or confirmed a business cancellation too often this hour, or when the limit can't be checked. */
export function rateLimitedResponse(status: number): NextResponse {
  return status === 503
    ? NextResponse.json({ error: "Canceling a business is unavailable for a moment. Try again shortly.", code: "rate_limit_unavailable" }, { status: 503, headers: { "Retry-After": "5" } })
    : NextResponse.json({ error: "Too many tries. Try again later.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(3_600 - (Math.floor(Date.now() / 1_000) % 3_600)) } });
}
