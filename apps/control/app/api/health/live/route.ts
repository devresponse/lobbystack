import { displayVersion } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Railway's health check, which reaches the service without Cloudflare Access: it says only that the service runs. */
export function GET(): Response {
  return Response.json({ ok: true, service: "control", version: displayVersion() }, { headers: { "cache-control": "no-store" } });
}
