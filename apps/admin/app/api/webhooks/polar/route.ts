import { createBillingWebhook } from "@lobbystack/providers/billing/factory";
import { handleBillingWebhook } from "@/lib/billing-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Polar's billing events, checked with POLAR_WEBHOOK_SECRET, stored once per business and applied by the worker; 404 on a deployment billed through Stripe. */
export async function POST(request: Request) {
  return await handleBillingWebhook(request, () => createBillingWebhook(process.env), { route: "/api/webhooks/polar", provider: "polar" });
}
