import { NextResponse } from "next/server";

import { BillingWebhookRefusal } from "@lobbystack/providers/billing/errors";
import { readBillingProviderId } from "@lobbystack/providers/billing/factory";
import { stripeKeyEnv } from "@lobbystack/providers/stripe/client";
import { stripeWebhookSecrets, verifyStripeThinEvent } from "@lobbystack/providers/stripe/events";
import { logEvent } from "@lobbystack/telemetry/node";
import { recordRefusedWebhook, wrongProviderWebhook } from "@/lib/billing-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = "/api/webhooks/stripe/meter-errors";

/**
 * Stripe's meter error events: a meter event it couldn't use, such as one
 * naming no meter or a customer it doesn't have. Checked with
 * STRIPE_METER_WEBHOOK_SECRET and logged as ops.billing.meter_error; the
 * daily totals check (the Stripe plan's step 16) corrects the month.
 */
export async function POST(request: Request) {
  if (readBillingProviderId(process.env) !== "stripe") return wrongProviderWebhook({ provider: "stripe", route });
  const body = await request.text();
  try {
    const event = verifyStripeThinEvent(body, request.headers, { secrets: stripeWebhookSecrets(process.env.STRIPE_METER_WEBHOOK_SECRET), env: stripeKeyEnv(process.env.STRIPE_API_KEY ?? "") ?? "sandbox" });
    logEvent("warn", "ops.billing.meter_error", { provider: "stripe", eventType: event.type, eventId: event.id, ...(event.related_object ? { relatedObject: event.related_object.id } : {}) });
    return NextResponse.json({ accepted: true });
  } catch (error) {
    if (!(error instanceof BillingWebhookRefusal)) throw error;
    if (error.reason === "invalid_payload") return NextResponse.json({ error: "Invalid webhook." }, { status: 400 });
    recordRefusedWebhook("stripe", error.reason, request.headers);
    return new NextResponse("Unauthorized", { status: 401 });
  }
}
