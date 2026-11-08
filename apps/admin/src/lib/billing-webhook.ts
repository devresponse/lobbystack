import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { businesses, withBusinessTransaction, withDispatcherTransaction } from "@lobbystack/db";
import { polarProductLinks, readBillingCatalogSnapshot, storeBillingWebhookEvent } from "@lobbystack/domain";
import { BillingWebhookRefusal, type BillingWebhookRefusalReason } from "@lobbystack/providers/billing/errors";
import type { BillingProviderId, BillingWebhook } from "@lobbystack/providers/billing/types";
import { logEvent } from "@lobbystack/telemetry/node";
import { runAfterResponse } from "@/lib/after-response";
import { getDispatcherDatabase, getWorkerDatabase } from "@/lib/api-helpers";
import { reportServerError } from "@/lib/error-reporting";

// What every billing provider's webhook route does with a delivery: check it,
// find its business, store it once and queue it to apply (ADR 0010).

// A provider turns an endpoint off after enough failed deliveries in a row,
// and its billing events stop arriving, so each refusal leaves a line: a run of
// unconfigured or bad_signature means the webhook secret is missing or isn't
// the endpoint's. It carries the provider's delivery ID, never the body.
function recordRefusedWebhook(provider: BillingProviderId, reason: BillingWebhookRefusalReason, headers: Headers): void {
  const webhookId = headers.get("webhook-id")?.slice(0, 64);
  logEvent("warn", "ops.billing.webhook_refused", { provider, reason, ...(webhookId ? { webhookId } : {}) });
}

// A webhook we cannot attribute to a business is dropped with a 200, which is
// correct for the provider but leaves no trace of a subscription that never
// applied. This log line is the only signal that a billing event went missing.
// It is not a product event: product_events rows need a business, and this has none.
function recordUnresolvedWebhook(input: { provider: BillingProviderId; eventType: string; reason: "no_reference" | "unknown_business"; reference?: string }): void {
  console.error(JSON.stringify({
    event: "ops.billing.webhook_unresolved",
    provider: input.provider,
    eventType: input.eventType,
    reason: input.reason,
    ...(input.reference ? { businessReference: input.reference } : {}),
  }));
}

/** Handles one delivery to a billing provider's webhook route, such as /api/webhooks/polar. */
export async function handleBillingWebhook(request: Request, webhookFor: () => BillingWebhook, options: { route: string }): Promise<NextResponse> {
  let eventType: string | undefined;
  try {
    const webhook = webhookFor();
    const body = await request.text();
    let delivery;
    try {
      delivery = webhook.verify(body, request.headers);
    } catch (error) {
      if (!(error instanceof BillingWebhookRefusal)) throw error;
      if (error.reason === "invalid_payload") return NextResponse.json({ error: "Invalid webhook." }, { status: 400 });
      recordRefusedWebhook(webhook.provider, error.reason, request.headers);
      return new NextResponse("Unauthorized", { status: 401 });
    }
    eventType = delivery.type;
    // The catalog names the plan of a product it links; a retired price's product still counts.
    const links = await withBusinessTransaction(getWorkerDatabase().db, { actorType: "worker" }, (tx) => readBillingCatalogSnapshot(tx), { accessMode: "read only" });
    const normalized = webhook.normalize(delivery, polarProductLinks(links, process.env));
    if (!normalized) return NextResponse.json({ accepted: true, ignored: true }, { status: 202 });
    // The live Polar organization also serves staging. UUID references are safe
    // everywhere; legacy Convex references are resolved only during production
    // cutover when the environment explicitly enables compatibility routing.
    const allowLegacyReference = webhook.provider === "polar" && process.env.POLAR_ACCEPT_LEGACY_BUSINESS_IDS === "true";
    const condition = normalized.businessId
      ? eq(businesses.id, normalized.businessId)
      : allowLegacyReference && normalized.businessReference
        ? eq(businesses.legacyConvexId, normalized.businessReference)
        : undefined;
    if (!condition) {
      recordUnresolvedWebhook({ provider: webhook.provider, eventType: delivery.type, reason: "no_reference", ...(normalized.businessReference ? { reference: normalized.businessReference } : {}) });
      return NextResponse.json({ accepted: true, ignored: true });
    }
    const businessId = await withDispatcherTransaction(getDispatcherDatabase().db, async tx => {
      return (await tx.select({ id: businesses.id }).from(businesses).where(condition).limit(1))[0]?.id;
    });
    if (!businessId) {
      recordUnresolvedWebhook({ provider: webhook.provider, eventType: delivery.type, reason: "unknown_business", ...(normalized.businessReference ? { reference: normalized.businessReference } : {}) });
      return NextResponse.json({ accepted: true, ignored: true });
    }
    // Each business has its own customer, so the checkout's business and the customer's agree.
    // A customer that names another business is one Polar matched by email before that, and the
    // subscription still goes to the business that bought it.
    if (normalized.customerBusinessId) logEvent("warn", "ops.billing.webhook_customer_mismatch", { provider: webhook.provider, eventType: delivery.type, businessId, customerBusinessId: normalized.customerBusinessId });
    // A redelivery of an event that never applied queues it again.
    const inserted = await withBusinessTransaction(getWorkerDatabase().db, { businessId, actorType: "worker" }, async (tx) => await storeBillingWebhookEvent(tx, { provider: webhook.provider, businessId, providerEventId: delivery.id, eventType: delivery.type, payload: normalized.payload }));
    return NextResponse.json({ accepted: true, duplicate: !inserted, eventId: delivery.id });
  } catch (error) {
    // The provider retries the delivery, and its log shows this errorId beside the one PostHog has.
    const errorId = crypto.randomUUID();
    const webhookId = request.headers.get("webhook-id")?.slice(0, 64);
    runAfterResponse(async () => await reportServerError(error, { operation: "billing.webhook", errorId, route: options.route, ...(eventType ? { eventType } : {}), ...(webhookId ? { webhookId } : {}) }));
    return NextResponse.json({ error: "Webhook processing failed.", errorId }, { status: 500, headers: { "x-error-id": errorId } });
  }
}
