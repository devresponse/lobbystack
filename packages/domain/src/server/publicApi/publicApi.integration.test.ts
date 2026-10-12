import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiKeys, appointments, auditLogs, businessHours, businesses, calendarConnections, calls, contacts, conversations, createDatabaseClient, idempotencyKeys, inboxItems, knowledgeChunks, knowledgeDocuments, knowledgeSnippets, operatorNotificationDeliveries, outboxMessages, receptionistProfiles, services, staff, staffServiceAssignments, storageObjects, users, businessMemberships, webhookDeliveries, webhookDeliveryAttempts, webhookEndpoints, webhookEvents, websiteIngestionJobs } from "@lobbystack/db";
import { apiAppointmentSchema, apiBusinessSchema, apiCallSchema, apiKnowledgeEntrySchema, apiKnowledgeSourceSchema, apiReceptionistSchema, apiStaffSchema, WEBHOOK_MAX_ATTEMPTS } from "@lobbystack/shared";

import { finalizeConversationSession } from "../conversations";
import { FULL_CRAWL_PAGE_LIMIT, ONBOARDING_CRAWL_PAGE_LIMIT } from "../knowledge";
import { createVoiceFollowUpTask } from "../voice";
import { generateApiKey, resolveApiKey } from "./apiKeys";
import { runIdempotent } from "./idempotency";
import { cancelAppointmentForApi, cancelKnowledgeSourceForApi, completeKnowledgeUploadForApi, createAppointmentForApi, createContactForApi, createKnowledgeEntryForApi, createKnowledgeSourceForApi, createKnowledgeUploadForApi, deleteKnowledgeEntryForApi, deleteKnowledgeSourceForApi, expandKnowledgeSourceForApi, getAvailabilityForApi, getContactForApi, getKnowledgeEntryForApi, getKnowledgeSourceForApi, getMeForApi, getReceptionistForApi, listAppointmentsForApi, listContactsForApi, listKnowledgeEntriesForApi, listKnowledgeSourcesForApi, listStaffForApi, rescheduleAppointmentForApi, retryKnowledgeSourceForApi, updateBusinessForApi, updateKnowledgeEntryForApi, updateKnowledgeSourceForApi, updateReceptionistForApi, type ApiKeyCaller } from "./operations";
import { PublicApiError } from "./errors";
import { createWebhookEndpoint, processWebhookDelivery, pruneApiHistory } from "./webhooks";
import { encryptWebhookSecret } from "./webhookTransport";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Public API integration tests require a dedicated local test database.");
  }
}

// The admin serves /api/v1 with the lobbystack_worker role; run the same role here.
function roleUrl(role: string): string {
  const url = new URL(testUrl!);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

const admin = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
// A real lobbystack_worker login (optional) also exercises the owner-alert resolver, which checks session_user.
const workerLoginUrl = process.env.LOBBYSTACK_PUBLIC_API_TEST_WORKER_DATABASE_URL;
const worker = testUrl ? createDatabaseClient("lobbystack_worker", { DATABASE_URL: workerLoginUrl ?? roleUrl("lobbystack_worker") }) : undefined;
const app = testUrl ? createDatabaseClient("lobbystack_app", { DATABASE_URL: roleUrl("lobbystack_app") }) : undefined;

type Fixture = { businessId: string; serviceId: string; staffId: string; caller: ApiKeyCaller; key: string };
let a: Fixture;
let b: Fixture;
let ownerId: string;

async function createFixture(label: string): Promise<Fixture> {
  const businessId = randomUUID();
  await admin!.db.insert(businesses).values({ id: businessId, slug: `api-${label}-${businessId}`, name: `API ${label}`, timezone: "UTC", businessType: "test" });
  await admin!.db.insert(receptionistProfiles).values({ businessId, greeting: "Hi", tone: "warm", summary: label, bookingPolicy: "Book", transferMode: "never", bookingMode: "instant" });
  const [member] = await admin!.db.insert(staff).values({ businessId, name: "Sam", timezone: "UTC" }).returning({ id: staff.id });
  const [service] = await admin!.db.insert(services).values({ businessId, name: "Cut", slug: "cut", durationMinutes: 30 }).returning({ id: services.id });
  await admin!.db.insert(businessHours).values(Array.from({ length: 7 }, (_, dayOfWeek) => ({ businessId, dayOfWeek, openMinutes: 8 * 60, closeMinutes: 20 * 60 })));
  const generated = generateApiKey();
  const [apiKey] = await admin!.db.insert(apiKeys).values({ businessId, name: label, prefix: generated.prefix, keyHash: generated.keyHash, scopes: ["contacts:read", "contacts:write", "appointments:write"] }).returning({ id: apiKeys.id });
  return { businessId, serviceId: service!.id, staffId: member!.id, caller: { businessId, apiKeyId: apiKey!.id }, key: generated.key };
}

function tomorrowAt(hour: number): string {
  return DateTime.utc().plus({ days: 2 }).set({ hour, minute: 0, second: 0, millisecond: 0 }).toISO()!;
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (value: unknown) => value);
  expect(error).toBeInstanceOf(PublicApiError);
  expect(error).toMatchObject({ status, code });
}

describe.skipIf(!testUrl)("public API against PostgreSQL with RLS", () => {
  beforeAll(async () => {
    a = await createFixture("a");
    b = await createFixture("b");
    ownerId = randomUUID();
    await admin!.db.insert(users).values({ id: ownerId, email: `${ownerId}@example.invalid`, normalizedEmail: `${ownerId}@example.invalid` });
    await admin!.db.insert(businessMemberships).values({ businessId: a.businessId, userId: ownerId, role: "business_owner" });
  });

  afterAll(async () => {
    if (a && b) {
      const ids = [a.businessId, b.businessId];
      await admin!.db.delete(outboxMessages).where(inArray(outboxMessages.businessId, ids));
      await admin!.db.delete(appointments).where(inArray(appointments.businessId, ids));
      await admin!.db.delete(businesses).where(inArray(businesses.id, ids));
      await admin!.db.delete(users).where(eq(users.id, ownerId));
    }
    await Promise.all([admin?.pool.end(), worker?.pool.end(), app?.pool.end()]);
  });

  it("resolves a key to its own business and rejects revoked keys", async () => {
    expect(await resolveApiKey({ db: worker!.db }, a.key)).toMatchObject({ businessId: a.businessId, apiKeyId: a.caller.apiKeyId });
    expect(await resolveApiKey({ db: app!.db }, b.key)).toMatchObject({ businessId: b.businessId });
    // Change the last character; a fixed "x" would match the 1 in 64 keys that end in x.
    expect(await resolveApiKey({ db: worker!.db }, `${a.key.slice(0, -1)}${a.key.endsWith("x") ? "y" : "x"}`)).toBeNull();
    await admin!.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, b.caller.apiKeyId));
    expect(await resolveApiKey({ db: worker!.db }, b.key)).toBeNull();
    await admin!.db.update(apiKeys).set({ revokedAt: null }).where(eq(apiKeys.id, b.caller.apiKeyId));
  });

  it("never lets a key for business A read business B", async () => {
    const context = { db: worker!.db };
    const contactB = await createContactForApi(context, b.caller, { name: "Only in B", phone: "+14165550199" });
    await expectApiError(getContactForApi(context, a.caller, contactB.id), 404, "not_found");
    const pageA = await listContactsForApi(context, a.caller, { limit: 100 });
    expect(pageA.data.map((contact) => contact.id)).not.toContain(contactB.id);
    // RLS itself hides B's row from a transaction scoped to business A.
    const rows = await worker!.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.business_id', ${a.businessId}, true), set_config('app.actor_type', 'worker', true)`);
      return await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactB.id));
    });
    expect(rows).toEqual([]);
  });

  it("pages through contacts with a cursor without gaps or repeats", async () => {
    const context = { db: worker!.db };
    const created = [];
    for (let index = 0; index < 5; index += 1) created.push((await createContactForApi(context, a.caller, { name: `Page ${index}`, phone: `+1416555${String(1000 + index)}` })).id);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listContactsForApi(context, a.caller, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.data.length).toBeLessThanOrEqual(2);
      seen.push(...page.data.map((contact) => contact.id));
      cursor = page.next_cursor ?? undefined;
      expect(page.has_more).toBe(page.next_cursor !== null);
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of created) expect(seen).toContain(id);
  });

  it("rejects a duplicate phone number with 409", async () => {
    const context = { db: worker!.db };
    await createContactForApi(context, a.caller, { phone: "+14165552222" });
    await expectApiError(createContactForApi(context, a.caller, { phone: "+14165552222" }), 409, "conflict");
  });

  it("replays idempotent requests and rejects a reused key with a different body", async () => {
    const context = { db: worker!.db };
    const scope = { businessId: a.businessId, apiKeyId: a.caller.apiKeyId, operation: "createContact", key: `idem-${randomUUID()}` };
    const create = (transactional: typeof context) => createContactForApi(transactional, a.caller, { phone: "+14165551111" }).then((contact) => ({ status: 201, body: JSON.stringify({ data: contact }) }));
    const first = await runIdempotent(context, scope, "hash-1", create);
    expect(first.replayed).toBe(false);
    const again = await runIdempotent(context, scope, "hash-1", create);
    expect(again).toEqual({ replayed: true, response: first.response });
    await expectApiError(runIdempotent(context, scope, "hash-2", create), 422, "idempotency_key_reused");
    // The same key under another API key is independent.
    const other = await runIdempotent(context, { ...scope, businessId: b.businessId, apiKeyId: b.caller.apiKeyId }, "hash-2", async () => ({ status: 201, body: "{}" }));
    expect(other.replayed).toBe(false);
    expect(await admin!.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.businessId, a.businessId), eq(contacts.phone, "+14165551111")))).toHaveLength(1);
  });

  it("commits the mutation and the idempotency record together, so a failure after the mutation leaves no duplicate", async () => {
    const context = { db: worker!.db };
    const scope = { businessId: a.businessId, apiKeyId: a.caller.apiKeyId, operation: "createAppointment", key: `idem-${randomUUID()}` };
    const input = { service_id: a.serviceId, starts_at: tomorrowAt(16), contact_phone: "+14165551212" };
    const book = (transactional: typeof context) => createAppointmentForApi(transactional, a.caller, input).then((appointment) => ({ status: 201, body: JSON.stringify({ data: appointment }) }));
    // The process dies after the booking is written but before the response is stored.
    await expect(runIdempotent(context, scope, "hash", async (transactional) => {
      await book(transactional);
      throw new Error("crash after the mutation");
    })).rejects.toThrow("crash after the mutation");
    const appointmentsFor = async () => await admin!.db.select({ id: appointments.id }).from(appointments).innerJoin(contacts, eq(contacts.id, appointments.contactId)).where(and(eq(appointments.businessId, a.businessId), eq(contacts.phone, "+14165551212")));
    expect(await appointmentsFor()).toEqual([]);
    // The client retries with the same key: the booking happens once.
    const retry = await runIdempotent(context, scope, "hash", book);
    const replay = await runIdempotent(context, scope, "hash", book);
    expect(replay).toEqual({ replayed: true, response: retry.response });
    expect(await appointmentsFor()).toHaveLength(1);
    // Two concurrent requests with a fresh key also book once.
    const concurrentScope = { ...scope, key: `idem-${randomUUID()}` };
    const concurrentInput = { ...input, starts_at: tomorrowAt(17), contact_phone: "+14165551313" };
    const bookOther = (transactional: typeof context) => createAppointmentForApi(transactional, a.caller, concurrentInput).then((appointment) => ({ status: 201, body: JSON.stringify({ data: appointment }) }));
    const results = await Promise.all([runIdempotent(context, concurrentScope, "hash", bookOther), runIdempotent(context, concurrentScope, "hash", bookOther)]);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(await admin!.db.select({ id: appointments.id }).from(appointments).innerJoin(contacts, eq(contacts.id, appointments.contactId)).where(eq(contacts.phone, "+14165551313"))).toHaveLength(1);
  });

  it("books only in instant booking mode", async () => {
    const context = { db: worker!.db };
    const input = { service_id: a.serviceId, starts_at: tomorrowAt(10), contact_phone: "+14165553333", contact_name: "Booker" };
    await admin!.db.update(receptionistProfiles).set({ bookingMode: "request" }).where(eq(receptionistProfiles.businessId, a.businessId));
    await expectApiError(createAppointmentForApi(context, a.caller, input), 409, "booking_requires_confirmation");
    await admin!.db.update(receptionistProfiles).set({ bookingMode: "off" }).where(eq(receptionistProfiles.businessId, a.businessId));
    await expectApiError(createAppointmentForApi(context, a.caller, input), 409, "booking_disabled");
    expect(await admin!.db.select({ id: appointments.id }).from(appointments).innerJoin(contacts, eq(contacts.id, appointments.contactId)).where(and(eq(appointments.businessId, a.businessId), eq(contacts.phone, input.contact_phone)))).toEqual([]);
    await admin!.db.update(receptionistProfiles).set({ bookingMode: "instant" }).where(eq(receptionistProfiles.businessId, a.businessId));
    const appointment = await createAppointmentForApi(context, a.caller, input);
    expect(apiAppointmentSchema.parse(appointment)).toMatchObject({ status: "confirmed", source: "api", service_id: a.serviceId, contact_phone: "+14165553333" });
    const [calendarJob] = await admin!.db.select({ id: outboxMessages.id }).from(outboxMessages).where(and(eq(outboxMessages.businessId, a.businessId), eq(outboxMessages.topic, "calendar.syncAppointment"), eq(outboxMessages.aggregateId, appointment.id)));
    expect(calendarJob).toBeDefined();
    const [auditRow] = await admin!.db.select({ payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.entityId, appointment.id), eq(auditLogs.eventType, "api.appointment.booked")));
    expect(auditRow?.payload).toMatchObject({ actor: "api_key", apiKeyId: a.caller.apiKeyId });
    await expectApiError(createAppointmentForApi(context, a.caller, { ...input, contact_phone: "+14165553334" }), 409, "slot_unavailable");
    const slots = await getAvailabilityForApi(context, a.caller, { serviceId: a.serviceId, startDate: tomorrowAt(10).slice(0, 10) });
    expect(slots.map((slot) => slot.starts_at)).not.toContain(new Date(input.starts_at).toISOString());
    expect(slots.length).toBeGreaterThan(0);
  });

  it("emits appointment and contact webhooks through the outbox in the booking transaction", async () => {
    const context = { db: worker!.db };
    const created = await createWebhookEndpoint({ db: app!.db }, { businessId: a.businessId, manager: { kind: "operator", userId: ownerId }, url: "https://hooks.example.com/lobbystack", events: ["appointment.booked", "appointment.cancelled", "appointment.rescheduled", "contact.created"] });
    const appointment = await createAppointmentForApi(context, a.caller, { service_id: a.serviceId, starts_at: tomorrowAt(12), contact_phone: "+14165554444" });
    const events = await admin!.db.select().from(webhookEvents).where(eq(webhookEvents.businessId, a.businessId));
    const booked = events.find((event) => event.type === "appointment.booked" && (event.payload.data as { id: string }).id === appointment.id);
    expect(booked?.payload).toMatchObject({ type: "appointment.booked", api_version: "v1", business_id: a.businessId, id: booked?.id });
    expect(booked?.payload.data).toEqual(appointment);
    expect(events.some((event) => event.type === "contact.created" && (event.payload.data as { phone: string }).phone === "+14165554444")).toBe(true);
    const [delivery] = await admin!.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.eventId, booked!.id), eq(webhookDeliveries.endpointId, created.endpoint.id)));
    const [job] = await admin!.db.select().from(outboxMessages).where(and(eq(outboxMessages.topic, "webhook.deliver"), eq(outboxMessages.aggregateId, delivery!.id)));
    expect(job?.payload).toEqual({ deliveryId: delivery!.id, attempt: 1 });

    const moved = await rescheduleAppointmentForApi(context, a.caller, appointment.id, { starts_at: tomorrowAt(14) });
    expect(moved.starts_at).toBe(new Date(tomorrowAt(14)).toISOString());
    const cancelled = await cancelAppointmentForApi(context, a.caller, appointment.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await cancelAppointmentForApi(context, a.caller, appointment.id)).status).toBe("cancelled");
    const types = (await admin!.db.select({ type: webhookEvents.type, payload: webhookEvents.payload }).from(webhookEvents).where(eq(webhookEvents.businessId, a.businessId))).filter((event) => (event.payload.data as { id: string }).id === appointment.id).map((event) => event.type);
    expect(types.sort()).toEqual(["appointment.booked", "appointment.cancelled", "appointment.rescheduled"]);
    await expectApiError(rescheduleAppointmentForApi(context, a.caller, appointment.id, { starts_at: tomorrowAt(15) }), 409, "conflict");
  });

  it("does not record events for businesses without subscribed endpoints", async () => {
    const before = await admin!.db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.businessId, b.businessId));
    await createContactForApi({ db: worker!.db }, b.caller, { phone: "+14165556666" });
    expect(await admin!.db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.businessId, b.businessId))).toHaveLength(before.length);
  });

  it("emits call.completed when a finished call is finalized, and message.taken for new messages", async () => {
    const context = { db: worker!.db };
    await admin!.db.update(webhookEndpoints).set({ events: ["call.completed", "message.taken"] }).where(eq(webhookEndpoints.businessId, a.businessId));
    const [contact] = await admin!.db.insert(contacts).values({ businessId: a.businessId, phone: "+14165557777", name: "Caller" }).returning({ id: contacts.id });
    const [conversation] = await admin!.db.insert(conversations).values({ businessId: a.businessId, contactId: contact!.id, channel: "voice", summary: "Asked about prices." }).returning({ id: conversations.id });
    const [call] = await admin!.db.insert(calls).values({ businessId: a.businessId, contactId: contact!.id, conversationId: conversation!.id, providerCallId: `test-${randomUUID()}`, transport: "sip", status: "completed", startedAt: new Date(Date.now() - 120_000), endedAt: new Date() }).returning({ id: calls.id });
    const result = await finalizeConversationSession(context, { businessId: a.businessId, callId: call!.id });
    expect(result.finalized).toBe(true);
    const [event] = await admin!.db.select().from(webhookEvents).where(and(eq(webhookEvents.businessId, a.businessId), eq(webhookEvents.type, "call.completed")));
    expect(apiCallSchema.parse(event!.payload.data)).toMatchObject({ id: call!.id, status: "completed", caller_phone: "+14165557777", channel: "phone" });
    const [outbox] = await admin!.db.select().from(outboxMessages).where(and(eq(outboxMessages.businessId, a.businessId), eq(outboxMessages.topic, "webhook.deliver"), sql`${outboxMessages.payload}->>'deliveryId' in (select id::text from webhook_deliveries where event_id = ${event!.id})`));
    expect(outbox).toBeDefined();

    const task = await createVoiceFollowUpTask(context, { businessId: a.businessId, callId: call!.id, callerName: "Caller", callbackPhone: "+14165557777", urgency: "urgent", message: "Call back", channel: "voice" });
    const [message] = await admin!.db.select().from(webhookEvents).where(and(eq(webhookEvents.businessId, a.businessId), eq(webhookEvents.type, "message.taken")));
    expect(message?.payload.data).toMatchObject({ id: task.inboxItemId, caller_name: "Caller", callback_phone: "+14165557777", urgency: "urgent", channel: "voice", call_id: call!.id });
    const [item] = await admin!.db.select({ metadata: inboxItems.metadata }).from(inboxItems).where(eq(inboxItems.id, task.inboxItemId));
    expect(item?.metadata).toMatchObject({ callerName: "Caller" });
  });

  it("retries failed deliveries with backoff, then disables a failing endpoint and alerts the owner", async () => {
    const context = { db: worker!.db };
    const [endpoint] = await admin!.db.insert(webhookEndpoints).values({ businessId: b.businessId, url: "https://failing.example.com/hook", events: ["contact.created"], encryptedSecret: encryptWebhookSecret("whsec_dGVzdHNlY3JldHRlc3RzZWNyZXR0ZXN0c2VjcmV0MTI=") }).returning();
    await admin!.db.insert(users).values({ id: randomUUID(), email: `b-owner-${randomUUID()}@example.invalid`, normalizedEmail: `b-owner-${randomUUID()}@example.invalid` }).returning({ id: users.id }).then(async ([user]) => {
      await admin!.db.insert(businessMemberships).values({ businessId: b.businessId, userId: user!.id, role: "business_owner" });
    });
    const contact = await createContactForApi(context, b.caller, { phone: "+14165558888" });
    const [delivery] = await admin!.db.select().from(webhookDeliveries).innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.eventId)).where(and(eq(webhookDeliveries.endpointId, endpoint!.id), sql`${webhookEvents.payload}->'data'->>'id' = ${contact.id}`));
    const deliveryId = delivery!.webhook_deliveries.id;
    const failing = async () => ({ ok: false, status: 500, error: "HTTP 500", durationMs: 5 });

    const first = await processWebhookDelivery(context, { businessId: b.businessId, deliveryId, attempt: 1, send: failing });
    expect(first.outcome).toBe("retry_scheduled");
    const [retry] = await admin!.db.select().from(outboxMessages).where(eq(outboxMessages.dedupeKey, `webhook-delivery:${deliveryId}:attempt:2`));
    expect(retry!.availableAt.getTime() - Date.now()).toBeGreaterThan(20_000);
    // A duplicate job for an attempt that already ran is ignored.
    expect((await processWebhookDelivery(context, { businessId: b.businessId, deliveryId, attempt: 1, send: failing })).outcome).toBe("stale");

    let last = first;
    for (let attempt = 2; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) last = await processWebhookDelivery(context, { businessId: b.businessId, deliveryId, attempt, send: failing });
    expect(last).toEqual({ outcome: "failed", endpointDisabled: true });
    const attempts = await admin!.db.select().from(webhookDeliveryAttempts).where(eq(webhookDeliveryAttempts.deliveryId, deliveryId));
    expect(attempts).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    const [after] = await admin!.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint!.id));
    expect(after).toMatchObject({ status: "disabled", disabledReason: "failing", consecutiveFailures: WEBHOOK_MAX_ATTEMPTS });
    const [audit] = await admin!.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, endpoint!.id), eq(auditLogs.eventType, "webhook_endpoint.auto_disabled")));
    expect(audit).toBeDefined();
    // The owner alert goes through app.resolve_operator_notification_recipients, which only
    // answers a session that logged in as lobbystack_worker.
    if (workerLoginUrl) {
      const alerts = await admin!.db.select().from(operatorNotificationDeliveries).where(and(eq(operatorNotificationDeliveries.businessId, b.businessId), eq(operatorNotificationDeliveries.eventKind, "webhookDisabled")));
      expect(alerts.length).toBeGreaterThan(0);
    }
  });

  it("marks a delivery succeeded and resets the failure count", async () => {
    const context = { db: worker!.db };
    await admin!.db.update(webhookEndpoints).set({ events: ["contact.created"], status: "enabled" }).where(eq(webhookEndpoints.businessId, a.businessId));
    const contact = await createContactForApi(context, a.caller, { phone: "+14165559999" });
    const [row] = await admin!.db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.eventId)).where(sql`${webhookEvents.payload}->'data'->>'id' = ${contact.id}`);
    let sent: { id: string; body: string } | undefined;
    const result = await processWebhookDelivery(context, { businessId: a.businessId, deliveryId: row!.id, attempt: 1, send: async (input) => { sent = input; return { ok: true, status: 200, error: null, durationMs: 3 }; } });
    expect(result.outcome).toBe("succeeded");
    expect(JSON.parse(sent!.body)).toMatchObject({ type: "contact.created", data: { id: contact.id } });
    const [delivery] = await admin!.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row!.id));
    expect(delivery).toMatchObject({ status: "succeeded", attemptCount: 1, lastResponseStatus: 200 });
  });

  it("lists each business's own staff with the services they take", async () => {
    const context = { db: worker!.db };
    const listA = await listStaffForApi(context, a.caller);
    expect(listA.map((member) => apiStaffSchema.parse(member).id)).toContain(a.staffId);
    expect(listA.map((member) => member.id)).not.toContain(b.staffId);
    // A business that never set up staff has its one default staff member, open to every service.
    expect(listA.find((member) => member.id === a.staffId)).toMatchObject({ active: true, timezone: "UTC", service_ids: [a.serviceId] });

    const [second] = await admin!.db.insert(staff).values({ businessId: a.businessId, name: "Riley", timezone: "America/Toronto" }).returning({ id: staff.id });
    const [inactive] = await admin!.db.insert(staff).values({ businessId: a.businessId, name: "Gone", timezone: "UTC", active: false }).returning({ id: staff.id });
    const [colour] = await admin!.db.insert(services).values({ businessId: a.businessId, name: "Colour", slug: "colour", durationMinutes: 60 }).returning({ id: services.id });
    await admin!.db.insert(staffServiceAssignments).values({ businessId: a.businessId, staffId: second!.id, serviceId: colour!.id });
    const listed = await listStaffForApi(context, a.caller);
    expect(listed.find((member) => member.id === second!.id)?.service_ids.sort()).toEqual([a.serviceId, colour!.id].sort());
    expect(listed.find((member) => member.id === a.staffId)?.service_ids).toEqual([a.serviceId]);
    expect(listed.find((member) => member.id === inactive!.id)).toMatchObject({ active: false, service_ids: [] });

    // staff_id must be an active member of this business who takes the service.
    const base = { service_id: a.serviceId, starts_at: tomorrowAt(9), contact_phone: "+14165556000" };
    await expectApiError(createAppointmentForApi(context, a.caller, { ...base, staff_id: b.staffId }), 400, "invalid_request");
    await expectApiError(createAppointmentForApi(context, a.caller, { ...base, staff_id: inactive!.id }), 400, "invalid_request");
    await expectApiError(createAppointmentForApi(context, a.caller, { ...base, service_id: colour!.id, staff_id: a.staffId }), 400, "invalid_request");
    await expectApiError(getAvailabilityForApi(context, a.caller, { serviceId: a.serviceId, startDate: base.starts_at.slice(0, 10), staffId: b.staffId }), 400, "invalid_request");

    const booked = await createAppointmentForApi(context, a.caller, { ...base, staff_id: second!.id });
    expect(booked.staff_id).toBe(second!.id);
    const riley = await getAvailabilityForApi(context, a.caller, { serviceId: a.serviceId, startDate: base.starts_at.slice(0, 10), staffId: second!.id });
    expect(riley.map((slot) => slot.starts_at)).not.toContain(new Date(base.starts_at).toISOString());
    const sam = await getAvailabilityForApi(context, a.caller, { serviceId: a.serviceId, startDate: base.starts_at.slice(0, 10), staffId: a.staffId });
    expect(sam.map((slot) => slot.starts_at)).toContain(new Date(base.starts_at).toISOString());

    // Reschedule can move the appointment to another staff member.
    const moved = await rescheduleAppointmentForApi(context, a.caller, booked.id, { starts_at: tomorrowAt(11), staff_id: a.staffId });
    expect(moved).toMatchObject({ staff_id: a.staffId, starts_at: new Date(tomorrowAt(11)).toISOString() });
    await expectApiError(rescheduleAppointmentForApi(context, a.caller, booked.id, { starts_at: tomorrowAt(12), staff_id: b.staffId }), 400, "invalid_request");
    // Not when either staff member has their own calendar: the old event would stay behind.
    await admin!.db.insert(calendarConnections).values({ businessId: a.businessId, ownerUserId: ownerId, staffId: second!.id, provider: "google", externalAccountId: `staff-${randomUUID()}`, status: "connected" });
    await expectApiError(rescheduleAppointmentForApi(context, a.caller, booked.id, { starts_at: tomorrowAt(13), staff_id: second!.id }), 409, "conflict");
    await admin!.db.delete(calendarConnections).where(eq(calendarConnections.businessId, a.businessId));
    await admin!.db.update(staff).set({ active: false }).where(inArray(staff.id, [second!.id]));
  });

  it("describes the calling key and its business", async () => {
    const me = await getMeForApi({ db: worker!.db }, a.caller);
    expect(me).toEqual({ api_key: { id: a.caller.apiKeyId, name: "a", prefix: expect.stringMatching(/^lsk_[0-9a-f]{8}$/), scopes: ["contacts:read", "contacts:write", "appointments:write"], created_at: expect.any(String) }, business: { id: a.businessId, name: expect.any(String) } });
    await expectApiError(getMeForApi({ db: worker!.db }, { businessId: b.businessId, apiKeyId: a.caller.apiKeyId }), 404, "not_found");
  });

  it("filters appointments by contact in SQL, together with status, and pages through them", async () => {
    const context = { db: worker!.db };
    const phone = "+14165557100";
    const ids: string[] = [];
    for (const hour of [9, 10, 11]) ids.push((await createAppointmentForApi(context, a.caller, { service_id: a.serviceId, starts_at: DateTime.utc().plus({ days: 3 }).set({ hour, minute: 0, second: 0, millisecond: 0 }).toISO()!, contact_phone: phone })).id);
    await createAppointmentForApi(context, a.caller, { service_id: a.serviceId, starts_at: DateTime.utc().plus({ days: 3 }).set({ hour: 12, minute: 0, second: 0, millisecond: 0 }).toISO()!, contact_phone: "+14165557101" });
    await cancelAppointmentForApi(context, a.caller, ids[0]!);
    const [contact] = await admin!.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.businessId, a.businessId), eq(contacts.phone, phone)));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAppointmentsForApi(context, a.caller, { contactId: contact!.id, limit: 1, ...(cursor ? { cursor } : {}) });
      expect(page.data.every((appointment) => appointment.contact_id === contact!.id)).toBe(true);
      seen.push(...page.data.map((appointment) => appointment.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());
    const confirmed = await listAppointmentsForApi(context, a.caller, { contactId: contact!.id, status: "confirmed", limit: 100 });
    expect(confirmed.data.map((appointment) => appointment.id).sort()).toEqual(ids.slice(1).sort());
    // Another business's contact id matches nothing.
    expect((await listAppointmentsForApi(context, b.caller, { contactId: contact!.id, limit: 100 })).data).toEqual([]);
  });

  it("replaces opening hours through the business endpoint", async () => {
    const business = await updateBusinessForApi({ db: worker!.db }, a.caller, { name: "API a renamed", hours: [{ day: "monday", open: "09:00", close: "17:30" }] });
    expect(business).toMatchObject({ name: "API a renamed", hours: [{ day: "monday", open: "09:00", close: "17:30" }] });
    await expectApiError(updateBusinessForApi({ db: worker!.db }, a.caller, { hours: [{ day: "monday", open: "10:00", close: "09:00" }] }), 400, "invalid_request");
    await expectApiError(updateBusinessForApi({ db: worker!.db }, a.caller, { timezone: "Mars/Olympus" }), 400, "invalid_request");
  });

  it("adds a website as a sample crawl and returns the same source for a repeat", async () => {
    const context = { db: worker!.db };
    const source = await createKnowledgeSourceForApi(context, a.caller, { type: "website", url: "maple-api.example" });
    expect(source).toMatchObject({ type: "website", url: "https://maple-api.example/", status: "processing", page_limit: ONBOARDING_CRAWL_PAGE_LIMIT });
    expect(apiKnowledgeSourceSchema.safeParse(source).success).toBe(true);
    const [crawl] = await admin!.db.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.businessId, a.businessId), eq(outboxMessages.topic, "knowledge.crawlWebsite"), eq(outboxMessages.aggregateId, source.id)));
    expect(crawl?.payload).toMatchObject({ documentId: source.id, limit: ONBOARDING_CRAWL_PAGE_LIMIT });
    expect((await createKnowledgeSourceForApi(context, a.caller, { type: "website", url: "https://maple-api.example/" })).id).toBe(source.id);
    // Business a is not on its website step, so its website stays as it was.
    const [business] = await admin!.db.select({ websiteUrl: businesses.websiteUrl }).from(businesses).where(eq(businesses.id, a.businessId));
    expect(business?.websiteUrl).not.toBe("https://maple-api.example/");
  });

  it("refuses a website address the crawler can't read", async () => {
    const error = await createKnowledgeSourceForApi({ db: worker!.db }, a.caller, { type: "website", url: "localhost" }).then(() => null, (value: unknown) => value);
    expect(error).toMatchObject({ status: 400, code: "invalid_request", details: [{ path: "url", message: expect.any(String) }] });
  });

  it("expands, cancels and retries a website source, inside its own business only", async () => {
    const context = { db: worker!.db };
    const source = await createKnowledgeSourceForApi(context, a.caller, { type: "website", url: "https://oak-api.example" });
    // A source still being read can't be retried; cancel it first.
    await expectApiError(retryKnowledgeSourceForApi(context, a.caller, source.id), 409, "conflict");
    await cancelKnowledgeSourceForApi(context, a.caller, source.id);
    // A retry keeps the sample's page limit instead of quietly reading the whole site.
    expect(await retryKnowledgeSourceForApi(context, a.caller, source.id)).toMatchObject({ status: "processing", page_limit: ONBOARDING_CRAWL_PAGE_LIMIT });
    expect(await expandKnowledgeSourceForApi(context, a.caller, source.id)).toMatchObject({ status: "processing", page_limit: FULL_CRAWL_PAGE_LIMIT });
    expect(await cancelKnowledgeSourceForApi(context, a.caller, source.id)).toMatchObject({ status: "cancelled" });
    await expectApiError(cancelKnowledgeSourceForApi(context, a.caller, source.id), 409, "conflict");
    // Sending the cancelled site again reads it at its full limit, not back at a sample.
    expect(await createKnowledgeSourceForApi(context, a.caller, { type: "website", url: "https://oak-api.example" })).toMatchObject({ id: source.id, status: "processing", page_limit: FULL_CRAWL_PAGE_LIMIT });
    await expectApiError(expandKnowledgeSourceForApi(context, b.caller, source.id), 404, "not_found");
    await expectApiError(retryKnowledgeSourceForApi(context, b.caller, source.id), 404, "not_found");
    await expectApiError(cancelKnowledgeSourceForApi(context, a.caller, randomUUID()), 404, "not_found");
  });

  it("treats a page a crawl read as part of its website, not as a source", async () => {
    const context = { db: worker!.db };
    const [page] = await admin!.db.insert(knowledgeDocuments).values({ businessId: a.businessId, sourceType: "website", title: "About", sourceUrl: "https://elm-api.example/about", status: "indexed" }).returning({ id: knowledgeDocuments.id });
    await expectApiError(createKnowledgeSourceForApi(context, a.caller, { type: "website", url: "elm-api.example/about" }), 409, "conflict");
    await expectApiError(expandKnowledgeSourceForApi(context, a.caller, page!.id), 400, "invalid_request");
    await expectApiError(retryKnowledgeSourceForApi(context, a.caller, page!.id), 400, "invalid_request");
  });

  describe("file uploads", () => {
    // Stands in for S3 or local storage: holds what a client has PUT.
    const stored = new Map<string, { length: number; contentType: string; checksum?: string }>();
    const storage = {
      createUpload: async (input: { key: string; contentType: string }) => ({ url: `https://storage.test/${input.key}`, headers: { "content-type": input.contentType }, expiresAt: new Date(Date.now() + 900_000) }),
      headObject: async ({ key }: { key: string }) => stored.get(key) ?? null,
      deleteObject: async () => undefined,
      createDownloadUrl: async () => "https://storage.test/download",
    };
    const checksum = createHash("sha256").update("price list").digest("base64");
    const request = { file_name: "prices.pdf", content_type: "application/pdf" as const, length: 10, checksum_sha256: checksum };
    const keyOf = async (uploadId: string) => (await admin!.db.select({ key: storageObjects.objectKey }).from(storageObjects).where(eq(storageObjects.id, uploadId)))[0]!.key;

    it("completes an upload once its file arrives, and returns the same source when completed again", async () => {
      const context = { db: worker!.db };
      const upload = await createKnowledgeUploadForApi(context, a.caller, request, storage);
      expect(upload.upload_url).toContain(upload.upload_id);
      expect(upload.expires_at).not.toBeNull();
      await expectApiError(completeKnowledgeUploadForApi(context, a.caller, upload.upload_id, {}, storage), 409, "conflict");
      stored.set(await keyOf(upload.upload_id), { length: 10, contentType: "application/pdf", checksum });
      const source = await completeKnowledgeUploadForApi(context, a.caller, upload.upload_id, { title: "Price list" }, storage);
      expect(source).toMatchObject({ type: "file", title: "Price list", url: null, status: "pending", page_limit: null });
      expect(apiKnowledgeSourceSchema.safeParse(source).success).toBe(true);
      const [extract] = await admin!.db.select({ id: outboxMessages.id }).from(outboxMessages).where(and(eq(outboxMessages.topic, "knowledge.extractDocument"), eq(outboxMessages.aggregateId, source.id)));
      expect(extract).toBeDefined();
      expect((await completeKnowledgeUploadForApi(context, a.caller, upload.upload_id, {}, storage)).id).toBe(source.id);
      await expectApiError(completeKnowledgeUploadForApi(context, b.caller, upload.upload_id, {}, storage), 404, "not_found");
    });

    it("refuses a stored file that doesn't match its upload request", async () => {
      const context = { db: worker!.db };
      const upload = await createKnowledgeUploadForApi(context, a.caller, request, storage);
      stored.set(await keyOf(upload.upload_id), { length: 11, contentType: "application/pdf", checksum });
      await expectApiError(completeKnowledgeUploadForApi(context, a.caller, upload.upload_id, {}, storage), 400, "invalid_request");
      await expectApiError(completeKnowledgeUploadForApi(context, a.caller, randomUUID(), {}, storage), 404, "not_found");
    });

    it("treats an expired upload, or one that isn't a knowledge document, as not found", async () => {
      const context = { db: worker!.db };
      const upload = await createKnowledgeUploadForApi(context, a.caller, request, storage);
      stored.set(await keyOf(upload.upload_id), { length: 10, contentType: "application/pdf", checksum });
      await admin!.db.update(storageObjects).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(storageObjects.id, upload.upload_id));
      await expectApiError(completeKnowledgeUploadForApi(context, a.caller, upload.upload_id, {}, storage), 404, "not_found");
      const [attachment] = await admin!.db.insert(storageObjects).values({ businessId: a.businessId, objectKey: `${a.businessId}/attachment/${randomUUID()}/note.pdf`, purpose: "attachment", fileName: "note.pdf", contentType: "application/pdf", contentLength: 10, status: "pending" }).returning({ id: storageObjects.id, key: storageObjects.objectKey });
      stored.set(attachment!.key, { length: 10, contentType: "application/pdf" });
      await expectApiError(completeKnowledgeUploadForApi(context, a.caller, attachment!.id, {}, storage), 404, "not_found");
    });

    it("makes one source when two completions race", async () => {
      const context = { db: worker!.db };
      const upload = await createKnowledgeUploadForApi(context, a.caller, request, storage);
      stored.set(await keyOf(upload.upload_id), { length: 10, contentType: "application/pdf", checksum });
      const [first, second] = await Promise.all([0, 1].map(async () => await completeKnowledgeUploadForApi(context, a.caller, upload.upload_id, {}, storage)));
      expect(second!.id).toBe(first!.id);
      expect(await admin!.db.select({ id: knowledgeDocuments.id }).from(knowledgeDocuments).where(eq(knowledgeDocuments.storageObjectId, upload.upload_id))).toHaveLength(1);
    });

    it("refuses an upload with plan_limit_reached once the plan's knowledge text is full, and keeps it pending", async () => {
      const context = { db: worker!.db };
      // Business b is on Free, which includes 1 MB of text. Fill it.
      const [full] = await admin!.db.insert(knowledgeDocuments).values({ businessId: b.businessId, sourceType: "text", title: "Full", status: "indexed" }).returning({ id: knowledgeDocuments.id });
      try {
        await admin!.db.insert(knowledgeChunks).values([0, 1].map((sequence) => ({ businessId: b.businessId, documentId: full!.id, sequence, content: "x".repeat(530_000), contentHash: `full-${sequence}` })));
        const upload = await createKnowledgeUploadForApi(context, b.caller, request, storage);
        stored.set(await keyOf(upload.upload_id), { length: 10, contentType: "application/pdf", checksum });
        await expectApiError(completeKnowledgeUploadForApi(context, b.caller, upload.upload_id, {}, storage), 409, "plan_limit_reached");
        const [object] = await admin!.db.select({ status: storageObjects.status }).from(storageObjects).where(eq(storageObjects.id, upload.upload_id));
        expect(object?.status).toBe("pending");
      } finally {
        await admin!.db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, full!.id));
      }
    });
  });

  it("takes the first website as the business's website while onboarding", async () => {
    await admin!.db.update(businesses).set({ onboardingStage: "website" }).where(eq(businesses.id, b.businessId));
    await createKnowledgeSourceForApi({ db: worker!.db }, b.caller, { type: "website", url: "https://birch-api.example" });
    const [business] = await admin!.db.select({ websiteUrl: businesses.websiteUrl, stage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, b.businessId));
    expect(business).toEqual({ websiteUrl: "https://birch-api.example/", stage: "knowledge" });
  });

  it("reads and changes the receptionist, refreshing the snapshot only when something changes", async () => {
    const context = { db: worker!.db };
    const before = await getReceptionistForApi(context, a.caller);
    expect(before).toMatchObject({ greeting: "Hi", tone: "warm", booking_policy: "Book", transfer_mode: "never", booking_mode: "instant", appointment_change_policy: { enabled: true, allow_cancel: true, allow_reschedule: true, verification_mode: "phone_match_and_facts" } });
    expect(apiReceptionistSchema.safeParse(before).success).toBe(true);
    const [profile] = await admin!.db.select({ id: receptionistProfiles.id }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, a.businessId));
    const refreshes = async () => (await admin!.db.select({ id: outboxMessages.id }).from(outboxMessages).where(and(eq(outboxMessages.topic, "snapshot.refresh"), eq(outboxMessages.aggregateId, profile!.id)))).length;
    const audits = async () => await admin!.db.select({ payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.entityId, profile!.id), eq(auditLogs.eventType, "api.receptionist.updated")));
    const savedAt = async () => (await admin!.db.select({ at: receptionistProfiles.updatedAt }).from(receptionistProfiles).where(eq(receptionistProfiles.id, profile!.id)))[0]!.at.getTime();
    const baseline = await refreshes();
    // No policy is stored, which calls read as the default, so sending the default changes nothing.
    await updateReceptionistForApi(context, a.caller, { appointment_change_policy: before.appointment_change_policy });
    expect(await refreshes()).toBe(baseline);
    expect(await audits()).toEqual([]);
    await expectApiError(updateReceptionistForApi(context, a.caller, {}), 400, "invalid_request");

    const policy = { enabled: true, allow_cancel: false, allow_reschedule: true, verification_mode: "otp_required" as const };
    const updated = await updateReceptionistForApi(context, a.caller, { greeting: "Welcome to Maple.", voice_instructions: "Speak slowly.", transfer_mode: "on_request", transfer_number: "+14165550134", appointment_change_policy: policy });
    expect(updated).toMatchObject({ greeting: "Welcome to Maple.", tone: "warm", voice_instructions: "Speak slowly.", transfer_mode: "on_request", transfer_number: "+14165550134", appointment_change_policy: policy });
    expect(await refreshes()).toBe(baseline + 1);
    expect(await audits()).toEqual([{ payload: expect.objectContaining({ fields: ["greeting", "voice_instructions", "transfer_mode", "transfer_number", "appointment_change_policy"] }) }]);
    // Sending what it already has writes, audits and refreshes nothing.
    const written = await savedAt();
    await updateReceptionistForApi(context, a.caller, { greeting: "Welcome to Maple.", appointment_change_policy: policy });
    expect(await refreshes()).toBe(baseline + 1);
    expect(await audits()).toHaveLength(1);
    expect(await savedAt()).toBe(written);
    expect(await updateReceptionistForApi(context, a.caller, { voice_instructions: null, transfer_number: null })).toMatchObject({ voice_instructions: null, transfer_number: null });

    // Sending the summary it already has still makes it the business's own, so AI won't replace it.
    await admin!.db.update(receptionistProfiles).set({ summary: "Maple cuts hair.", summarySource: "generated" }).where(eq(receptionistProfiles.id, profile!.id));
    expect(await updateReceptionistForApi(context, a.caller, { summary: "Maple cuts hair." })).toMatchObject({ summary: "Maple cuts hair.", summary_source: "operator" });
    // Asking for a new summary hands it back to AI and queues the rewrite.
    expect(await updateReceptionistForApi(context, a.caller, { regenerate_summary: true })).toMatchObject({ summary_source: "generated" });
    expect(await audits()).toContainEqual({ payload: expect.objectContaining({ fields: ["regenerate_summary"] }) });
    const rewrites = await admin!.db.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.topic, "business.generateSummary"), eq(outboxMessages.businessId, a.businessId)));
    expect(rewrites).toContainEqual({ payload: expect.objectContaining({ reason: "operator_regenerate", force: true }) });
    // The other business's receptionist is untouched.
    expect((await getReceptionistForApi(context, b.caller)).greeting).toBe("Hi");
  });

  it("shows a business with no receptionist row the defaults, and saves them with its first change", async () => {
    const businessId = randomUUID();
    await admin!.db.insert(businesses).values({ id: businessId, slug: `api-bare-${businessId}`, name: "Bare Clinic", timezone: "UTC", businessType: "test" });
    const caller: ApiKeyCaller = { businessId, apiKeyId: randomUUID() };
    const rows = async () => await admin!.db.select({ greeting: receptionistProfiles.greeting, tone: receptionistProfiles.tone }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId));
    try {
      const context = { db: worker!.db };
      expect(await getReceptionistForApi(context, caller)).toMatchObject({ greeting: "Thank you for calling Bare Clinic.", summary: "Bare Clinic", summary_source: "placeholder", transfer_mode: "on_request", booking_mode: "instant" });
      expect(await rows()).toEqual([]);
      expect(await updateReceptionistForApi(context, caller, { tone: "warm" })).toMatchObject({ greeting: "Thank you for calling Bare Clinic.", tone: "warm", summary_source: "placeholder" });
      expect(await rows()).toEqual([{ greeting: "Thank you for calling Bare Clinic.", tone: "warm" }]);
    } finally {
      await admin!.db.delete(outboxMessages).where(eq(outboxMessages.businessId, businessId));
      await admin!.db.delete(businesses).where(eq(businesses.id, businessId));
    }
  });

  it("lists, edits and deletes knowledge entries, and keeps an FAQ an FAQ", async () => {
    const context = { db: worker!.db };
    const faq = await createKnowledgeEntryForApi(context, a.caller, { type: "faq", question: "Do you park?", answer: "Behind the building." });
    const text = await createKnowledgeEntryForApi(context, a.caller, { type: "text", title: "Holidays", content: "Closed on public holidays." });
    const ids = async (type?: "text" | "faq", caller: ApiKeyCaller = a.caller) => (await listKnowledgeEntriesForApi(context, caller, { type })).data.map((entry) => entry.id);
    expect(await ids()).toEqual(expect.arrayContaining([faq.id, text.id]));
    expect(await ids("faq")).toContain(faq.id);
    expect(await ids("faq")).not.toContain(text.id);
    expect(await ids("text")).toContain(text.id);
    expect(await ids("text")).not.toContain(faq.id);
    expect(await ids(undefined, b.caller)).not.toContain(faq.id);
    // One page at a time, with no entry on two pages.
    const first = await listKnowledgeEntriesForApi(context, a.caller, { limit: 1 });
    expect(first.has_more).toBe(true);
    const second = await listKnowledgeEntriesForApi(context, a.caller, { limit: 1, cursor: first.next_cursor! });
    expect([first.data[0]?.id, second.data[0]?.id].sort()).toEqual([faq.id, text.id].sort());

    // Tags sent without the FAQ marker keep the FAQ an FAQ.
    const edited = await updateKnowledgeEntryForApi(context, a.caller, faq.id, { content: "Free parking behind the building.", tags: ["parking", "faq", "parking"], priority: 3, active: false });
    expect(edited).toMatchObject({ id: faq.id, type: "faq", title: "Do you park?", content: "Free parking behind the building.", tags: ["parking"], priority: 3, active: false });
    expect(apiKnowledgeEntrySchema.safeParse(edited).success).toBe(true);
    expect(await getKnowledgeEntryForApi(context, a.caller, faq.id)).toEqual(edited);
    const refreshes = async (id: string) => await admin!.db.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.topic, "snapshot.refresh"), eq(outboxMessages.aggregateId, id)));
    expect(await refreshes(faq.id)).toContainEqual({ payload: expect.objectContaining({ reason: "snippet_updated" }) });
    const [updatedAudit] = await admin!.db.select({ payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.entityId, faq.id), eq(auditLogs.eventType, "api.knowledge.updated")));
    expect(updatedAudit?.payload).toMatchObject({ fields: ["content", "tags", "priority", "active"] });
    // A text entry can't turn into an FAQ through its tags.
    expect(await updateKnowledgeEntryForApi(context, a.caller, text.id, { tags: ["faq"] })).toMatchObject({ type: "text", tags: [] });
    // An empty change is refused, and one to the values it already has writes nothing.
    const updatedAt = async () => (await admin!.db.select({ at: knowledgeSnippets.updatedAt }).from(knowledgeSnippets).where(eq(knowledgeSnippets.id, text.id)))[0]!.at.getTime();
    const before = await updatedAt();
    await expectApiError(updateKnowledgeEntryForApi(context, a.caller, text.id, {}), 400, "invalid_request");
    await updateKnowledgeEntryForApi(context, a.caller, text.id, { title: "Holidays", active: true });
    expect(await updatedAt()).toBe(before);

    await expectApiError(getKnowledgeEntryForApi(context, b.caller, faq.id), 404, "not_found");
    await expectApiError(updateKnowledgeEntryForApi(context, b.caller, faq.id, { active: true }), 404, "not_found");
    await expectApiError(deleteKnowledgeEntryForApi(context, b.caller, faq.id), 404, "not_found");
    await deleteKnowledgeEntryForApi(context, a.caller, faq.id);
    await expectApiError(getKnowledgeEntryForApi(context, a.caller, faq.id), 404, "not_found");
    await expectApiError(deleteKnowledgeEntryForApi(context, a.caller, faq.id), 404, "not_found");
    expect(await refreshes(faq.id)).toContainEqual({ payload: expect.objectContaining({ reason: "snippet_deleted" }) });
    expect(await admin!.db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityId, faq.id), eq(auditLogs.eventType, "api.knowledge.deleted")))).toHaveLength(1);
  });

  it("lists websites, pages and files apart, and turns one off or deletes it", async () => {
    const context = { db: worker!.db };
    const website = await createKnowledgeSourceForApi(context, b.caller, { type: "website", url: "https://cedar-api.example" });
    const [page] = await admin!.db.insert(knowledgeDocuments).values({ businessId: b.businessId, sourceType: "website", title: "Menu", sourceUrl: "https://cedar-api.example/menu", status: "indexed" }).returning({ id: knowledgeDocuments.id });
    const [file] = await admin!.db.insert(knowledgeDocuments).values({ businessId: b.businessId, sourceType: "upload", title: "Prices", status: "error", error: "Unreadable." }).returning({ id: knowledgeDocuments.id });
    // A status the API doesn't know reads, and filters, as processing.
    const [queued] = await admin!.db.insert(knowledgeDocuments).values({ businessId: b.businessId, sourceType: "upload", title: "Hours", status: "queued" }).returning({ id: knowledgeDocuments.id });
    await admin!.db.insert(knowledgeChunks).values({ businessId: b.businessId, documentId: page!.id, sequence: 0, content: "Soup of the day.", contentHash: "menu-0" });
    type Filter = { type?: "website" | "page" | "file"; status?: "pending" | "processing" | "indexed" | "error" | "cancelled" };
    const ids = async (filter: Filter, caller: ApiKeyCaller = b.caller) => (await listKnowledgeSourcesForApi(context, caller, filter)).data.map((source) => source.id);
    expect(await ids({})).toEqual(expect.arrayContaining([website.id, page!.id, file!.id, queued!.id]));
    expect(await ids({}, a.caller)).not.toContain(page!.id);
    expect(await ids({ type: "website" })).toContain(website.id);
    expect(await ids({ type: "website" })).not.toContain(page!.id);
    expect(await ids({ type: "page" })).toContain(page!.id);
    expect(await ids({ type: "page" })).not.toContain(website.id);
    expect(await ids({ type: "file", status: "error" })).toContain(file!.id);
    expect(await ids({ type: "file", status: "indexed" })).not.toContain(file!.id);
    expect(await ids({ status: "processing" })).toEqual(expect.arrayContaining([website.id, queued!.id]));
    expect(await getKnowledgeSourceForApi(context, b.caller, queued!.id)).toMatchObject({ type: "file", status: "processing" });
    // One page at a time, with no source on two pages.
    const first = await listKnowledgeSourcesForApi(context, b.caller, { limit: 2 });
    const second = await listKnowledgeSourcesForApi(context, b.caller, { limit: 2, cursor: first.next_cursor! });
    expect(first.has_more).toBe(true);
    expect(second.data).toHaveLength(2);
    expect(second.data.filter((source) => first.data.some((seen) => seen.id === source.id))).toEqual([]);
    const read = await getKnowledgeSourceForApi(context, b.caller, page!.id);
    expect(read).toMatchObject({ type: "page", url: "https://cedar-api.example/menu", page_limit: null, active: true });
    expect(apiKnowledgeSourceSchema.safeParse(read).success).toBe(true);

    expect(await updateKnowledgeSourceForApi(context, b.caller, page!.id, { active: false })).toMatchObject({ id: page!.id, active: false });
    const refreshes = async (id: string) => await admin!.db.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.topic, "snapshot.refresh"), eq(outboxMessages.aggregateId, id)));
    expect(await refreshes(page!.id)).toContainEqual({ payload: expect.objectContaining({ reason: "document_activity_changed" }) });
    // Sending the state it already has writes and audits nothing.
    await updateKnowledgeSourceForApi(context, b.caller, page!.id, { active: false });
    expect(await admin!.db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityId, page!.id), eq(auditLogs.eventType, "api.knowledge_source.updated")))).toHaveLength(1);
    expect(await refreshes(page!.id)).toHaveLength(1);
    await expectApiError(updateKnowledgeSourceForApi(context, a.caller, page!.id, { active: true }), 404, "not_found");
    // Crawl actions belong to the website, not its pages.
    await expectApiError(retryKnowledgeSourceForApi(context, b.caller, page!.id), 400, "invalid_request");

    await deleteKnowledgeSourceForApi(context, b.caller, website.id);
    await expectApiError(getKnowledgeSourceForApi(context, b.caller, website.id), 404, "not_found");
    await expectApiError(deleteKnowledgeSourceForApi(context, b.caller, website.id), 404, "not_found");
    // Its crawl goes with it.
    expect(await admin!.db.select({ id: websiteIngestionJobs.id }).from(websiteIngestionJobs).where(eq(websiteIngestionJobs.rootDocumentId, website.id))).toEqual([]);
    expect(await refreshes(website.id)).toContainEqual({ payload: expect.objectContaining({ reason: "document_deleted" }) });
    // The pages its crawl read stay until they are deleted too.
    expect(await getKnowledgeSourceForApi(context, b.caller, page!.id)).toMatchObject({ type: "page" });
    await expectApiError(deleteKnowledgeSourceForApi(context, a.caller, page!.id), 404, "not_found");
    await deleteKnowledgeSourceForApi(context, b.caller, page!.id);
    await expectApiError(getKnowledgeSourceForApi(context, b.caller, page!.id), 404, "not_found");
    expect(await admin!.db.select({ id: knowledgeChunks.id }).from(knowledgeChunks).where(eq(knowledgeChunks.documentId, page!.id))).toEqual([]);
    expect(await admin!.db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityId, page!.id), eq(auditLogs.eventType, "api.knowledge_source.deleted")))).toHaveLength(1);
  });

  it("reads and updates the business type and reads the onboarding stage", async () => {
    const business = await updateBusinessForApi({ db: worker!.db }, a.caller, { business_type: "dental_clinic" });
    expect(business).toMatchObject({ business_type: "dental_clinic", onboarding_stage: "create_business" });
    expect(apiBusinessSchema.safeParse(business).success).toBe(true);
  });

  it("prunes old webhook events and API idempotency keys, keeping events that are still being retried", async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    const [endpoint] = await admin!.db.insert(webhookEndpoints).values({ businessId: b.businessId, url: "https://prune.example.com/hook", events: ["contact.created"], encryptedSecret: encryptWebhookSecret("whsec_dGVzdHNlY3JldHRlc3RzZWNyZXR0ZXN0c2VjcmV0MTI=") }).returning({ id: webhookEndpoints.id });
    const event = async (businessId: string, createdAt: Date, deliveryStatus?: string) => {
      const [row] = await admin!.db.insert(webhookEvents).values({ businessId, type: "contact.created", payload: { data: { id: randomUUID() } }, createdAt }).returning({ id: webhookEvents.id });
      if (deliveryStatus) await admin!.db.insert(webhookDeliveries).values({ businessId, endpointId: endpoint!.id, eventId: row!.id, status: deliveryStatus });
      return row!.id;
    };
    const oldDelivered = await event(b.businessId, daysAgo(40), "succeeded");
    const oldFailed = await event(b.businessId, daysAgo(40), "failed");
    const oldRetrying = await event(b.businessId, daysAgo(40), "retrying");
    const oldPending = await event(b.businessId, daysAgo(40), "pending");
    const recent = await event(b.businessId, daysAgo(29), "succeeded");
    const otherBusiness = await event(a.businessId, daysAgo(40));
    const key = async (scope: string, createdAt: Date) => (await admin!.db.insert(idempotencyKeys).values({ scope, key: randomUUID(), businessId: b.businessId, createdAt }).returning({ id: idempotencyKeys.id }))[0]!.id;
    const oldApiKey = await key(`api:${b.caller.apiKeyId}:createContact`, daysAgo(2));
    const freshApiKey = await key(`api:${b.caller.apiKeyId}:createContact`, new Date());
    const oldOtherKey = await key("billing:checkout", daysAgo(2));

    expect(await pruneApiHistory({ db: worker!.db }, { businessId: b.businessId })).toEqual({ events: 2, idempotencyKeys: 1 });
    const events = await admin!.db.select({ id: webhookEvents.id }).from(webhookEvents).where(inArray(webhookEvents.id, [oldDelivered, oldFailed, oldRetrying, oldPending, recent, otherBusiness]));
    expect(events.map((row) => row.id).sort()).toEqual([oldRetrying, oldPending, recent, otherBusiness].sort());
    expect(await admin!.db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(inArray(webhookDeliveries.eventId, [oldDelivered, oldFailed]))).toEqual([]);
    const keys = await admin!.db.select({ id: idempotencyKeys.id }).from(idempotencyKeys).where(inArray(idempotencyKeys.id, [oldApiKey, freshApiKey, oldOtherKey]));
    expect(keys.map((row) => row.id).sort()).toEqual([freshApiKey, oldOtherKey].sort());
  });
});
