import { NextResponse } from "next/server";

import { fleetStatus } from "@/lib/fleet-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every copy of the admin and the worker, from their heartbeats. Off by default; it takes only FLEET_STATUS_TOKEN. */
export async function GET(request: Request) {
  const answer = await fleetStatus(request);
  return typeof answer.body === "string" ? new Response(answer.body, { status: answer.status }) : NextResponse.json(answer.body, { status: answer.status });
}
