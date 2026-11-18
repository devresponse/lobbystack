import { NextResponse, type NextRequest } from "next/server";

import { verifyAccessRequest } from "@/lib/access";

/**
 * Every request but the health check needs a Cloudflare Access token for an
 * email in CONTROL_ADMIN_EMAILS (docs/features/control-panel.md). Pages check
 * it again before they read anything.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (request.nextUrl.pathname === "/api/health/live") return NextResponse.next();
  const access = await verifyAccessRequest(request.headers);
  if (access.ok) return NextResponse.next();
  if (access.status === 503) console.error(`control: closed until it's set up: ${access.reason}`);
  else console.warn(`control: refused ${request.method} ${request.nextUrl.pathname} (${access.reason})`);
  return new NextResponse(access.status === 503 ? "The control panel isn't set up yet.\n" : "Forbidden\n", {
    status: access.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
