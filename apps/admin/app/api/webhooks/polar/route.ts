import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { polarWebhookSchema } from "@lobbystack/contracts";
import { businesses, withBusinessTransaction, withDispatcherTransaction } from "@lobbystack/db";
import { polarProductLinks, readBillingCatalogSnapshot, storePolarWebhookEvent } from "@lobbystack/domain";
import { verifyPolarWebhookSignature } from "@lobbystack/providers";
import { logEvent } from "@lobbystack/telemetry/node";
import { runAfterResponse } from "@/lib/after-response";
import { getDispatcherDatabase, getWorkerDatabase } from "@/lib/api-helpers";
import { reportServerError } from "@/lib/error-reporting";
import { normalizePolarEvent } from "@/lib/polar-event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SignatureRefusal = "unconfigured" | "missing_headers" | "bad_signature";

/** Why a delivery isn't Polar's, or null when it is. A signature older than five minutes doesn't match either. */
function signatureRefusal(body: string, headers: Headers): SignatureRefusal | null {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) return "unconfigured";
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return "missing_headers";
  return verifyPolarWebhookSignature(body, {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  }, secret) ? null : "bad_signature";
}

// Polar turns an endpoint off after 10 failed deliveries in a row, and its
// billing events stop arriving, so each refusal leaves a line: a run of
// unconfigured or bad_signature means POLAR_WEBHOOK_SECRET is missing or isn't
// the endpoint's secret. It carries Polar's delivery ID, never the body.
function recordRefusedWebhook(reason: SignatureRefusal, headers: Headers): void {
  const webhookId = headers.get("webhook-id")?.slice(0, 64);
  logEvent("warn", "ops.billing.webhook_refused", { provider: "polar", reason, ...(webhookId ? { webhookId } : {}) });
}

// A webhook we cannot attribute to a business is dropped with a 200, which is
// correct for Polar but leaves no trace of a subscription that never applied.
// This log line is the only signal that a billing event went missing. It is not
// a product event: product_events rows need a business, and this has none.
function recordUnresolvedWebhook(
  input: { eventType: string; reason: "no_reference" | "unknown_business"; reference?: string },
): void {
  console.error(JSON.stringify({
    event: "ops.billing.webhook_unresolved",
    provider: "polar",
    eventType: input.eventType,
    reason: input.reason,
    ...(input.reference ? { businessReference: input.reference } : {}),
  }));
}

export async function POST(request: Request) {
  let eventType: string | undefined;
  try {
    const body = await request.text();
    const refusal = signatureRefusal(body, request.headers);
    if (refusal) {
      recordRefusedWebhook(refusal, request.headers);
      return new NextResponse("Unauthorized", { status: 401 });
    }
    // Standard Webhooks supplies the delivery ID in headers, not the JSON body.
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid webhook." }, { status: 400 });
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "Invalid webhook." }, { status: 400 });
    const event = polarWebhookSchema.safeParse({ ...raw, id: request.headers.get("webhook-id") ?? raw.id });
    if (!event.success) return NextResponse.json({ error: "Invalid webhook." }, { status: 400 });
    eventType = event.data.type;
    // The catalog names the plan of a product it links; a retired price's product still counts.
    const links = await withBusinessTransaction(getWorkerDatabase().db, { actorType: "worker" }, (tx) => readBillingCatalogSnapshot(tx), { accessMode: "read only" });
    const normalized = normalizePolarEvent(event.data.type, event.data.data, polarProductLinks(links, process.env));
    // The live Polar organization also serves staging. UUID references are safe
    // everywhere; legacy Convex references are resolved only during production
    // cutover when the environment explicitly enables compatibility routing.
    const allowLegacyReference = process.env.POLAR_ACCEPT_LEGACY_BUSINESS_IDS === "true";
    const condition = normalized.businessId
      ? eq(businesses.id, normalized.businessId)
      : allowLegacyReference && normalized.businessReference
        ? eq(businesses.legacyConvexId, normalized.businessReference)
        : undefined;
    if (!condition) {
      recordUnresolvedWebhook({
        eventType: event.data.type,
        reason: "no_reference",
        ...(normalized.businessReference ? { reference: normalized.businessReference } : {}),
      });
      return NextResponse.json({ accepted: true, ignored: true });
    }
    const businessId = await withDispatcherTransaction(getDispatcherDatabase().db, async tx => {
      return (await tx.select({ id: businesses.id }).from(businesses).where(condition).limit(1))[0]?.id;
    });
    if (!businessId) {
      recordUnresolvedWebhook({
        eventType: event.data.type,
        reason: "unknown_business",
        ...(normalized.businessReference ? { reference: normalized.businessReference } : {}),
      });
      return NextResponse.json({ accepted: true, ignored: true });
    }
    // Each business has its own Polar customer, so the checkout's business and the customer's agree.
    // A customer that names another business is one Polar matched by email before that, and the
    // subscription still goes to the business that bought it.
    if (normalized.customerBusinessId) logEvent("warn", "ops.billing.webhook_customer_mismatch", { provider: "polar", eventType: event.data.type, businessId, customerBusinessId: normalized.customerBusinessId });
    // A redelivery of an event that never applied queues it again.
    const inserted = await withBusinessTransaction(getWorkerDatabase().db, { businessId, actorType: "worker" }, async (tx) => await storePolarWebhookEvent(tx, { businessId, providerEventId: event.data.id, eventType: event.data.type, payload: normalized.payload }));
    return NextResponse.json({ accepted: true, duplicate: !inserted, eventId: event.data.id });
  } catch (error) {
    // Polar retries the delivery, and its log shows this errorId beside the one PostHog has.
    const errorId = crypto.randomUUID();
    const webhookId = request.headers.get("webhook-id")?.slice(0, 64);
    runAfterResponse(async () => await reportServerError(error, { operation: "billing.webhook", errorId, route: "/api/webhooks/polar", ...(eventType ? { eventType } : {}), ...(webhookId ? { webhookId } : {}) }));
    return NextResponse.json({ error: "Webhook processing failed.", errorId }, { status: 500, headers: { "x-error-id": errorId } });
  }
}
