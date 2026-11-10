import { createBillingWebhook } from "@lobbystack/providers/billing/factory";
import { handleBillingWebhook } from "@/lib/billing-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe's billing events (the Stripe plan's step 12), checked with
 * STRIPE_WEBHOOK_SECRET and the mode of STRIPE_API_KEY, stored once per
 * business and applied by the worker; 404 on a deployment billed through Polar.
 */
export async function POST(request: Request) {
  return await handleBillingWebhook(request, () => createBillingWebhook(process.env), { route: "/api/webhooks/stripe", provider: "stripe" });
}
