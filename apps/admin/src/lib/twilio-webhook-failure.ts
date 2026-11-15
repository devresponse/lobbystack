import { NextResponse } from "next/server";

import { logEvent } from "@lobbystack/telemetry/node";
import { runAfterResponse } from "@/lib/after-response";
import { reportServerError } from "@/lib/error-reporting";

// What Twilio's text webhooks answer when they can't handle a delivery. Each
// answer carries an error ID, in its body and its x-error-id header, and the
// warning or error report repeats it, so a failure Twilio records can be
// matched with ours. Neither ever holds the text's words or a phone number:
// only the message SID, which finds the message in Twilio's console.

/** The message SID of a Twilio webhook's form fields, when it looks like one: two letters and 32 hex digits. */
export function twilioMessageSid(params: Record<string, string>): string | undefined {
  const sid = params.MessageSid ?? params.SmsSid;
  return sid && /^[A-Z]{2}[0-9a-f]{32}$/i.test(sid) ? sid : undefined;
}

type SchemaIssues = { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> };

/**
 * A delivery Twilio signed whose fields the schema refuses: 400, since sending
 * it again changes nothing. The warning names the fields refused, never their
 * values.
 */
export function invalidTwilioWebhook(error: SchemaIssues, input: { route: string; messageSid?: string | undefined }): NextResponse {
  const errorId = crypto.randomUUID();
  const fields = [...new Set(error.issues.map((issue) => issue.path.map(String).join(".") || "(payload)"))];
  logEvent("warn", "ops.twilio.webhook_invalid", { route: input.route, errorId, fields, ...(input.messageSid ? { messageSid: input.messageSid } : {}) });
  return NextResponse.json({ ok: false, error: "Invalid Twilio webhook.", errorId }, { status: 400, headers: { "x-error-id": errorId } });
}

/**
 * A delivery whose handling failed: reported as an error with its error ID
 * (reportServerError, which leaves out the query parameters Drizzle puts in
 * its messages, emails and phone numbers), and answered 503, so the number's
 * fallback URL, for an incoming text, or a retry policy on the webhook's URL
 * tries again. Never acknowledged, so nothing is lost silently.
 */
export function failedTwilioWebhook(error: unknown, input: { route: string; operation: string; messageSid?: string | undefined }): NextResponse {
  const errorId = crypto.randomUUID();
  runAfterResponse(async () => await reportServerError(error, { operation: input.operation, errorId, route: input.route, ...(input.messageSid ? { messageSid: input.messageSid } : {}) }));
  return NextResponse.json({ ok: false, error: "Temporary webhook failure.", errorId }, { status: 503, headers: { "Retry-After": "60", "x-error-id": errorId } });
}
