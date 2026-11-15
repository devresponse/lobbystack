import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { resendWebhookSchema } from "@lobbystack/contracts";
import { enqueueOutbox, providerEvents, withBusinessTransaction, withDispatcherTransaction } from "@lobbystack/db";
import { verifyResendWebhookSignature } from "@lobbystack/providers";
import { logEvent } from "@lobbystack/telemetry/node";
import { runAfterResponse } from "@/lib/after-response";
import { getAppDatabase, getDispatcherDatabase, getWorkerDatabase, jsonError } from "@/lib/api-helpers";
import { reportServerError } from "@/lib/error-reporting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/webhooks/resend";

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The body as JSON, or undefined when it isn't JSON, which the schema then refuses. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * An email delivery event. A signed delivery that isn't JSON, or that the
 * schema refuses, answers 400; one that can't be stored answers 500. Each
 * carries an error ID, and the warning or error report names the delivery by
 * its svix-id, never an address or a subject.
 */
export async function POST(request: Request) {
  let webhookId: string | undefined;
  let eventType: string | undefined;
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return jsonError("Resend webhooks are not configured.", 503);
    const body = await request.text();
    const headers = { id: request.headers.get("svix-id") ?? "", timestamp: request.headers.get("svix-timestamp") ?? "", signature: request.headers.get("svix-signature") ?? "" };
    if (!verifyResendWebhookSignature(body, headers, secret)) return new NextResponse("Unauthorized", { status: 401 });
    webhookId = headers.id || undefined;
    const parsed = resendWebhookSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      const errorId = crypto.randomUUID();
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "(payload)"))];
      logEvent("warn", "ops.resend.webhook_invalid", { route: ROUTE, errorId, fields, ...(webhookId ? { webhookId } : {}) });
      return NextResponse.json({ error: "Invalid Resend webhook.", errorId }, { status: 400, headers: { "x-error-id": errorId } });
    }
    eventType = parsed.data.type;
    const emailId = stringField(parsed.data.data.email_id) ?? stringField(parsed.data.data.emailId);
    const businessResult = emailId ? await getAppDatabase().db.execute<{ business_id: string }>(sql`select app.resolve_business_by_email_provider_id(${emailId}) as business_id`) : null;
    const businessId = businessResult?.rows[0]?.business_id;
    const normalizedPayload = { ...(emailId ? { emailId } : {}), eventType: parsed.data.type, ...(parsed.data.created_at ? { createdAt: parsed.data.created_at } : {}), ...(stringField(parsed.data.data.reason) ? { reason: stringField(parsed.data.data.reason) } : {}) };
    const persist = async (tx: Parameters<Parameters<ReturnType<typeof getWorkerDatabase>["db"]["transaction"]>[0]>[0]) => {
      const [stored] = await tx.insert(providerEvents).values({ provider: "resend", providerEventId: headers.id, eventType: parsed.data.type, ...(businessId ? { businessId } : {}), payload: normalizedPayload }).onConflictDoNothing().returning({ id: providerEvents.id });
      if (stored && businessId) await enqueueOutbox(tx, { topic: "email.reconcileDelivery", businessId, aggregateType: "provider_event", aggregateId: stored.id, dedupeKey: `provider-event:${headers.id}:email`, payload: { providerEventId: stored.id } });
      return Boolean(stored);
    };
    const inserted = businessId ? await withBusinessTransaction(getWorkerDatabase().db, { businessId, actorType: "worker" }, persist) : await withDispatcherTransaction(getDispatcherDatabase().db, persist);
    return NextResponse.json({ accepted: true, duplicate: !inserted, eventId: headers.id });
  } catch (error) {
    // Resend tries the delivery again, and its log shows this errorId beside the one PostHog has.
    const errorId = crypto.randomUUID();
    runAfterResponse(async () => await reportServerError(error, { operation: "resend.webhook", errorId, route: ROUTE, ...(eventType ? { eventType } : {}), ...(webhookId ? { webhookId } : {}) }));
    return NextResponse.json({ error: "Webhook processing failed.", errorId }, { status: 500, headers: { "x-error-id": errorId } });
  }
}
