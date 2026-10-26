import { DASHBOARD_TEST_CALL_WIDGET_ID, PROSPECT_DEMO_WIDGET_ID, callTranscriptUnavailableReason, normalizeInterfaceLocale, trimTrailingSlashes, type CallTranscriptContent, type CallTranscriptRecipients } from "@lobbystack/shared";
import type { CallTranscriptEmail } from "@lobbystack/providers/email/templates";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { auditLogs, businesses, calls, contacts, conversations, conversationSessions, enqueueOutbox, operatorNotificationDeliveries, transcripts, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";

import { resolveCallOutcome } from "./callOutcome";
import type { DomainContext } from "./context";
import type { ConversationTranscriptTurn } from "./conversationSummary";
import type { OperatorNotificationEventPreferences } from "./notifications";

// The email someone on the team gets after each call: its summary and a link,
// or the whole conversation too, as the business chose. The summary job queues
// one delivery per person with the call's ID alone, and the worker builds the
// email as it sends it, so the conversation never sits in the outbox, in Redis
// or in the delivery row, and a turn deleted before then is never sent.

export const CALL_TRANSCRIPT_EVENT = "callTranscript";

/** A caller who said fewer characters than this said nothing worth an email, the summary job's own test. */
const MIN_CALLER_CHARACTERS = 15;
/** Delivery rows forget their address and subject after this, like the alerts'. */
const DELIVERY_CONTENT_DAYS = 30;

export type CallTranscriptSettings = { recipients: CallTranscriptRecipients; content: CallTranscriptContent };

export async function loadCallTranscriptSettingsInTransaction(tx: DatabaseTransaction, input: { businessId: string }): Promise<CallTranscriptSettings> {
  const row = (await tx.select({ recipients: businesses.callTranscriptRecipients, content: businesses.callTranscriptContent }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1))[0];
  if (!row) throw Object.assign(new Error("Business not found."), { status: 404, code: "not_found" });
  return row;
}

/** Changes who may get the email after each call, or what it holds, and records who changed it. */
export async function saveCallTranscriptSettingsInTransaction(tx: DatabaseTransaction, input: { businessId: string; change: Partial<CallTranscriptSettings>; audit: { actorUserId?: string; payload?: Record<string, unknown> } }): Promise<CallTranscriptSettings> {
  const before = await loadCallTranscriptSettingsInTransaction(tx, input);
  const after = { recipients: input.change.recipients ?? before.recipients, content: input.change.content ?? before.content };
  if (after.recipients === before.recipients && after.content === before.content) return before;
  await tx.update(businesses).set({ callTranscriptRecipients: after.recipients, callTranscriptContent: after.content, updatedAt: new Date() }).where(eq(businesses.id, input.businessId));
  await tx.insert(auditLogs).values({ businessId: input.businessId, ...(input.audit.actorUserId ? { actorUserId: input.audit.actorUserId } : {}), eventType: "call_transcript_settings.updated", entityType: "business", entityId: input.businessId, payload: { ...after, ...input.audit.payload } });
  return after;
}

type Recipient = { userId: string; email: string; role: string; preferredLocale: string | null; emailEnabled: boolean; preferences: Partial<OperatorNotificationEventPreferences> | null };

/** The business's active members, as the worker's recipient lookup returns them, oldest member first. */
async function loadRecipients(tx: DatabaseTransaction, businessId: string): Promise<Recipient[]> {
  const result = await tx.execute(sql`SELECT user_id AS "userId", email, role, preferred_locale AS "preferredLocale", email_enabled AS "emailEnabled", event_preferences AS preferences FROM app.resolve_operator_notification_recipients(${businessId}::uuid)`);
  return result.rows as Recipient[];
}

/** Why this person gets no email after a call now, or null when they get one. */
function recipientSkipReason(recipient: Recipient, recipients: CallTranscriptRecipients): string | null {
  if (callTranscriptUnavailableReason(recipients, recipient.role)) return "The business doesn't send call emails to this person.";
  if (recipient.emailEnabled === false || recipient.preferences?.callTranscript?.email !== true) return "The person turned call emails off.";
  return null;
}

function callerCharacters(transcript: ConversationTranscriptTurn[]): number {
  return transcript.filter((turn) => turn.speaker === "caller" || turn.speaker === "user").reduce((sum, turn) => sum + turn.text.replace(/\s+/g, " ").trim().length, 0);
}

/**
 * Queues the email after a call for each person on the team who turned it on
 * and whom the business sends it to, in the summary job's transaction. A call
 * the caller said too little on sends nothing, nor does a prospect demo. The
 * event key makes it one email per person per call, however often the job
 * runs. A blocked caller's later calls end before anyone speaks, so they send
 * nothing either.
 */
export async function queueCallTranscriptEmailsInTransaction(tx: DatabaseTransaction, input: { businessId: string; callId: string; transcript: ConversationTranscriptTurn[] }): Promise<string[]> {
  if (callerCharacters(input.transcript) < MIN_CALLER_CHARACTERS) return [];
  const call = (await tx.select({ widgetId: calls.widgetId, sessionPurpose: calls.sessionPurpose, prospectDemoId: calls.prospectDemoId }).from(calls).where(and(eq(calls.id, input.callId), eq(calls.businessId, input.businessId))).limit(1))[0];
  if (!call || call.widgetId === PROSPECT_DEMO_WIDGET_ID || call.sessionPurpose === "prospect_demo" || call.prospectDemoId) return [];
  const { recipients } = await loadCallTranscriptSettingsInTransaction(tx, input);
  if (recipients === "nobody") return [];
  const deliveryIds: string[] = [];
  for (const recipient of await loadRecipients(tx, input.businessId)) {
    if (recipientSkipReason(recipient, recipients)) continue;
    const [delivery] = await tx.insert(operatorNotificationDeliveries).values({
      businessId: input.businessId,
      userId: recipient.userId,
      eventKind: CALL_TRANSCRIPT_EVENT,
      eventKey: `${CALL_TRANSCRIPT_EVENT}:${input.callId}`,
      channel: "email",
      destination: recipient.email,
      // The worker writes the subject and the email when it sends them.
      subject: "Call email",
      body: "",
      contentExpiresAt: new Date(Date.now() + DELIVERY_CONTENT_DAYS * 86_400_000),
    }).onConflictDoNothing().returning({ id: operatorNotificationDeliveries.id });
    if (!delivery) continue;
    deliveryIds.push(delivery.id);
    await enqueueOutbox(tx, { topic: "notification.dispatch", businessId: input.businessId, aggregateType: "operator_notification_delivery", aggregateId: delivery.id, dedupeKey: `operator-notification:${delivery.id}:dispatch`, payload: { operatorDeliveryId: delivery.id } });
  }
  return deliveryIds;
}

export type CallTranscriptEmailToSend = { to: string; replyTo: string; email: CallTranscriptEmail };

/**
 * The email after a call, built as the worker sends it from what holds then:
 * the person must still be on the team, get call emails from the business and
 * want them, and the email holds what the business chooses now. Replies go to
 * the business's owner, or to the reader when it has none, never to the
 * deployment's inbox, where a reply would quote the call. `skip` says why
 * nothing goes out.
 */
export async function loadCallTranscriptEmail(context: DomainContext, input: { businessId: string; deliveryId: string; appUrl: string }): Promise<CallTranscriptEmailToSend | { skip: string }> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const delivery = (await tx.select({ userId: operatorNotificationDeliveries.userId, eventKey: operatorNotificationDeliveries.eventKey }).from(operatorNotificationDeliveries).where(and(eq(operatorNotificationDeliveries.id, input.deliveryId), eq(operatorNotificationDeliveries.businessId, input.businessId), eq(operatorNotificationDeliveries.eventKind, CALL_TRANSCRIPT_EVENT), eq(operatorNotificationDeliveries.status, "processing"))).limit(1))[0];
    const callId = delivery?.eventKey.startsWith(`${CALL_TRANSCRIPT_EVENT}:`) ? delivery.eventKey.slice(CALL_TRANSCRIPT_EVENT.length + 1) : undefined;
    if (!delivery || !callId) return { skip: "The delivery is not a call email." };
    const business = (await tx.select({ name: businesses.name, timezone: businesses.timezone, recipients: businesses.callTranscriptRecipients, content: businesses.callTranscriptContent }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1))[0];
    if (!business) return { skip: "The business was deleted." };
    const members = await loadRecipients(tx, input.businessId);
    const recipient = members.find((member) => member.userId === delivery.userId);
    if (!recipient) return { skip: "The person is no longer on the team." };
    const skip = recipientSkipReason(recipient, business.recipients);
    if (skip) return { skip };
    const call = (await tx.select({
      transport: calls.transport,
      widgetId: calls.widgetId,
      disposition: calls.disposition,
      startedAt: calls.startedAt,
      mediaStartedAt: calls.mediaStartedAt,
      endedAt: calls.endedAt,
      providerDurationSeconds: calls.providerDurationSeconds,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      conversationSummary: conversations.summary,
      currentIntent: conversations.currentIntent,
      persistedOutcome: conversationSessions.summary,
    }).from(calls)
      .leftJoin(contacts, and(eq(contacts.id, calls.contactId), eq(contacts.businessId, calls.businessId)))
      .leftJoin(conversations, and(eq(conversations.id, calls.conversationId), eq(conversations.businessId, calls.businessId)))
      .leftJoin(conversationSessions, and(eq(conversationSessions.callId, calls.id), eq(conversationSessions.businessId, calls.businessId)))
      .where(and(eq(calls.id, callId), eq(calls.businessId, input.businessId)))
      .limit(1))[0];
    if (!call) return { skip: "The call was deleted." };
    let turns: CallTranscriptEmail["turns"] = null;
    if (business.content === "transcript") {
      // Turns past their retention date are gone from the dashboard, so they stay out of the email too.
      const now = new Date();
      const rows = await tx.select({ speaker: transcripts.speaker, text: transcripts.text, createdAt: transcripts.createdAt }).from(transcripts).where(and(eq(transcripts.businessId, input.businessId), eq(transcripts.callId, callId), eq(transcripts.final, true), or(isNull(transcripts.expiresAt), gt(transcripts.expiresAt, now)))).orderBy(asc(transcripts.sequence));
      if (callerCharacters(rows) < MIN_CALLER_CHARACTERS) return { skip: "The call's transcript was deleted." };
      // A turn is saved as it ends, so the one before it ending is about when it began.
      const start = (call.mediaStartedAt ?? call.startedAt).getTime();
      turns = rows.map((row, index) => ({
        speaker: row.speaker === "caller" || row.speaker === "user" ? "caller" as const : "assistant" as const,
        text: row.text,
        atSeconds: index === 0 ? 0 : Math.max(0, Math.floor((rows[index - 1]!.createdAt.getTime() - start) / 1_000)),
      }));
    }
    const owner = members.find((member) => member.role === "business_owner");
    const appUrl = trimTrailingSlashes(input.appUrl);
    const durationSeconds = call.providerDurationSeconds ?? (call.endedAt ? Math.max(0, Math.round((call.endedAt.getTime() - call.startedAt.getTime()) / 1_000)) : null);
    return {
      to: recipient.email,
      replyTo: owner?.email ?? recipient.email,
      email: {
        locale: normalizeInterfaceLocale(recipient.preferredLocale ?? undefined) ?? "en",
        businessName: business.name,
        timeZone: business.timezone,
        channel: call.widgetId === DASHBOARD_TEST_CALL_WIDGET_ID ? "test" : call.transport === "web_voice" ? "website" : "phone",
        callerName: call.contactName?.trim() || null,
        callerPhone: call.contactPhone,
        startedAt: call.startedAt.toISOString(),
        durationSeconds,
        outcome: resolveCallOutcome({ persisted: call.persistedOutcome, currentIntent: call.currentIntent, summary: call.conversationSummary, disposition: call.disposition }),
        callUrl: `${appUrl}/calls/${callId}`,
        settingsUrl: `${appUrl}/settings/notifications`,
        turns,
      },
    };
  });
}
