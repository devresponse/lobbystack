import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businessMemberships, businesses, calls, contacts, conversations, createDatabaseClient, operatorNotificationDeliveries, operatorNotificationPreferences, outboxMessages, transcripts, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { DASHBOARD_TEST_CALL_WIDGET_ID, PROSPECT_DEMO_WIDGET_ID } from "@lobbystack/shared";

import { loadCallTranscriptEmail, queueCallTranscriptEmailsInTransaction, saveCallTranscriptSettingsInTransaction, type CallTranscriptSettings } from "./callTranscriptEmails";
import { finalizeConversationSession } from "./conversations";
import { defaultOperatorNotificationEventPreferences, getNotificationPreferences, setNotificationPreferences } from "./notifications";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Call email integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

// The worker's recipient lookup trusts its login identity, so worker steps
// switch the session user. Operator steps run as the app role. Fixtures run as
// the owner.
async function asWorker(tx: DatabaseTransaction) { await tx.execute(sql`reset role`); await tx.execute(sql`reset session authorization`); await tx.execute(sql`set local session authorization lobbystack_worker`); }
async function asApp(tx: DatabaseTransaction) { await tx.execute(sql`reset session authorization`); await tx.execute(sql`set local role lobbystack_app`); }
async function asOwner(tx: DatabaseTransaction) { await tx.execute(sql`reset role`); await tx.execute(sql`reset session authorization`); }

const STARTED_AT = new Date("2026-10-26T19:42:10.000Z");
const APP_URL = "https://app.example.test/";
const fridayCall: Array<[string, string]> = [
  ["assistant", "Thanks for calling Maple Dental, how can I help?"],
  ["caller", "Hi, are you open on Friday afternoon?"],
  ["assistant", "Yes, until 5."],
];

/**
 * A business with an owner and an admin who turned the email after each call
 * on, a scheduler who did too, an admin who turned it off and a viewer who
 * never chose, and a finished phone call with a turn every 5 seconds.
 */
async function seed(tx: DatabaseTransaction, options: { settings?: Partial<CallTranscriptSettings>; call?: Partial<typeof calls.$inferInsert>; turns?: Array<[string, string]> } = {}) {
  await asOwner(tx);
  const businessId = randomUUID();
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Maple Dental", timezone: "America/Toronto", businessType: "test", telemetryEnabled: false, callTranscriptRecipients: options.settings?.recipients ?? "owners_and_admins", callTranscriptContent: options.settings?.content ?? "summary" });
  const member = async (role: string, input: { locale?: string; callEmails?: boolean } = {}) => {
    const userId = randomUUID();
    const email = `${role}.${userId}@example.test`;
    await tx.insert(users).values({ id: userId, email, normalizedEmail: email, preferredLocale: input.locale ?? "en" });
    await tx.insert(businessMemberships).values({ businessId, userId, role });
    if (input.callEmails !== undefined) {
      const eventPreferences = defaultOperatorNotificationEventPreferences();
      eventPreferences.callTranscript.email = input.callEmails;
      await tx.insert(operatorNotificationPreferences).values({ businessId, userId, emailEnabled: true, smsEnabled: false, eventPreferences });
    }
    return { userId, email };
  };
  const owner = await member("business_owner", { callEmails: true });
  const admin = await member("business_admin", { locale: "fr", callEmails: true });
  const scheduler = await member("scheduler", { callEmails: true });
  const quietAdmin = await member("business_admin", { callEmails: false });
  const viewer = await member("viewer");
  const contactId = randomUUID();
  const conversationId = randomUUID();
  const callId = randomUUID();
  await tx.insert(contacts).values({ id: contactId, businessId, phone: "+14165550134", name: "Jane Doe" });
  await tx.insert(conversations).values({ id: conversationId, businessId, contactId, channel: "voice", summary: "Asked about Friday hours." });
  await tx.insert(calls).values({ id: callId, businessId, conversationId, contactId, providerCallId: `rtc_${callId}`, transport: "phone", status: "completed", startedAt: STARTED_AT, endedAt: new Date(STARTED_AT.getTime() + 252_000), disposition: "caller_finished", ...options.call });
  const turns = options.turns ?? fridayCall;
  await tx.insert(transcripts).values(turns.map(([speaker, text], index) => ({ businessId, callId, sequence: index + 1, speaker, text, final: true, createdAt: new Date(STARTED_AT.getTime() + (index + 1) * 5_000) })));
  const db = tx as unknown as Database;
  const queue = async () => {
    await asWorker(tx);
    return await withBusinessTransaction(db, { businessId, actorType: "worker" }, async (workerTx) => await queueCallTranscriptEmailsInTransaction(workerTx, { businessId, callId, transcript: turns.map(([speaker, text]) => ({ speaker, text })) }));
  };
  const deliveries = async () => {
    await asOwner(tx);
    return await tx.select({ id: operatorNotificationDeliveries.id, userId: operatorNotificationDeliveries.userId, eventKind: operatorNotificationDeliveries.eventKind, eventKey: operatorNotificationDeliveries.eventKey, channel: operatorNotificationDeliveries.channel, destination: operatorNotificationDeliveries.destination, subject: operatorNotificationDeliveries.subject, body: operatorNotificationDeliveries.body, status: operatorNotificationDeliveries.status }).from(operatorNotificationDeliveries).where(eq(operatorNotificationDeliveries.businessId, businessId));
  };
  /** The email the worker would send for this person's delivery now, after claiming it. */
  const email = async (userId: string) => {
    await asOwner(tx);
    const [delivery] = await tx.update(operatorNotificationDeliveries).set({ status: "processing" }).where(and(eq(operatorNotificationDeliveries.businessId, businessId), eq(operatorNotificationDeliveries.userId, userId))).returning({ id: operatorNotificationDeliveries.id });
    await asWorker(tx);
    return await loadCallTranscriptEmail({ db }, { businessId, deliveryId: delivery!.id, appUrl: APP_URL });
  };
  const settings = async (change: Partial<CallTranscriptSettings>) => {
    await asOwner(tx);
    await withBusinessTransaction(db, { businessId, userId: owner.userId, actorType: "operator" }, async (ownerTx) => await saveCallTranscriptSettingsInTransaction(ownerTx, { businessId, change, audit: { actorUserId: owner.userId } }));
  };
  return { db, businessId, callId, conversationId, owner, admin, scheduler, quietAdmin, viewer, queue, deliveries, email, settings };
}

describe.skipIf(!testUrl)("emails after a call against PostgreSQL under worker RLS", () => {
  it("are queued by the summary job for each person who turned them on and whom the business sends them to", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx);
      await asWorker(tx);
      await finalizeConversationSession({ db: fixture.db }, { businessId: fixture.businessId, callId: fixture.callId, generated: { summary: "Asked about Friday hours." } });

      const queued = await fixture.deliveries();
      expect(queued.map((row) => row.userId).sort()).toEqual([fixture.owner.userId, fixture.admin.userId].sort());
      // The worker writes the email as it sends it, so the row holds neither the call nor its words.
      for (const row of queued) expect(row).toMatchObject({ eventKind: "callTranscript", eventKey: `callTranscript:${fixture.callId}`, channel: "email", subject: "Call email", body: "", status: "pending" });
      expect(queued.find((row) => row.userId === fixture.admin.userId)?.destination).toBe(fixture.admin.email);
      const dispatches = await tx.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.businessId, fixture.businessId), eq(outboxMessages.topic, "notification.dispatch")));
      expect(dispatches.map((row) => row.payload.operatorDeliveryId).sort()).toEqual(queued.map((row) => row.id).sort());

      // A retried job queues no second email, and a wider choice adds only the people it lets in.
      expect(await fixture.queue()).toEqual([]);
      await fixture.settings({ recipients: "team" });
      expect(await fixture.queue()).toHaveLength(1);
      expect((await fixture.deliveries()).map((row) => row.userId)).toContain(fixture.scheduler.userId);
    });
  });

  it("aren't queued for a call the caller barely spoke on, a prospect demo, or a business that turned them off", async () => {
    await rollbackTest(async (tx) => {
      expect(await (await seed(tx, { turns: [["assistant", "Thanks for calling, how can I help?"], ["caller", "Hello?"]] })).queue()).toEqual([]);
      expect(await (await seed(tx, { call: { transport: "web_voice", widgetId: PROSPECT_DEMO_WIDGET_ID, sessionPurpose: "prospect_demo" } })).queue()).toEqual([]);
      expect(await (await seed(tx, { settings: { recipients: "nobody" } })).queue()).toEqual([]);
    });
  });

  it("are written as they go out, in the reader's language, with the turns only when the business sends them", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx, { call: { mediaStartedAt: new Date(STARTED_AT.getTime() + 2_000) } });
      await fixture.queue();
      expect(await fixture.email(fixture.admin.userId)).toEqual({
        to: fixture.admin.email,
        replyTo: fixture.owner.email,
        email: {
          locale: "fr",
          businessName: "Maple Dental",
          timeZone: "America/Toronto",
          channel: "phone",
          callerName: "Jane Doe",
          callerPhone: "+14165550134",
          startedAt: STARTED_AT.toISOString(),
          durationSeconds: 252,
          outcome: { kind: "summary", summary: "Asked about Friday hours." },
          callUrl: `https://app.example.test/calls/${fixture.callId}`,
          settingsUrl: "https://app.example.test/settings/notifications",
          turns: null,
        },
      });

      // A turn past its retention date is gone from the dashboard, so from the email too.
      await fixture.settings({ content: "transcript" });
      await tx.update(transcripts).set({ expiresAt: new Date(Date.now() - 1_000) }).where(and(eq(transcripts.callId, fixture.callId), eq(transcripts.sequence, 3)));
      const sent = await fixture.email(fixture.owner.userId);
      expect("email" in sent && sent.email).toMatchObject({
        locale: "en",
        // Each turn begins about when the one before it was saved, counted from when the call's audio started.
        turns: [
          { speaker: "assistant", text: "Thanks for calling Maple Dental, how can I help?", atSeconds: 0 },
          { speaker: "caller", text: "Hi, are you open on Friday afternoon?", atSeconds: 3 },
        ],
      });
    });
  });

  it("name a website call and a test call from the dashboard", async () => {
    await rollbackTest(async (tx) => {
      const website = await seed(tx, { call: { transport: "web_voice", widgetId: "widget-1" } });
      await website.queue();
      expect(await website.email(website.owner.userId)).toMatchObject({ email: { channel: "website" } });
      const test = await seed(tx, { call: { transport: "web_voice", widgetId: DASHBOARD_TEST_CALL_WIDGET_ID } });
      await test.queue();
      expect(await test.email(test.owner.userId)).toMatchObject({ email: { channel: "test" } });
    });
  });

  it("aren't sent when the person, the business or the call changed before they went out", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx, { settings: { recipients: "team" } });
      await fixture.queue();
      await asOwner(tx);
      await tx.update(operatorNotificationPreferences).set({ eventPreferences: defaultOperatorNotificationEventPreferences() }).where(eq(operatorNotificationPreferences.userId, fixture.scheduler.userId));
      expect(await fixture.email(fixture.scheduler.userId)).toEqual({ skip: "The person turned call emails off." });
      await tx.update(businessMemberships).set({ status: "removed" }).where(eq(businessMemberships.userId, fixture.admin.userId));
      expect(await fixture.email(fixture.admin.userId)).toEqual({ skip: "The person is no longer on the team." });
      await fixture.settings({ recipients: "owners_and_admins" });
      await asOwner(tx);
      await tx.update(operatorNotificationPreferences).set({ eventPreferences: { ...defaultOperatorNotificationEventPreferences(), callTranscript: { email: true, sms: false } } }).where(eq(operatorNotificationPreferences.userId, fixture.scheduler.userId));
      expect(await fixture.email(fixture.scheduler.userId)).toEqual({ skip: "The business doesn't send call emails to this person." });
      await fixture.settings({ content: "transcript" });
      await asOwner(tx);
      await tx.delete(transcripts).where(eq(transcripts.callId, fixture.callId));
      expect(await fixture.email(fixture.owner.userId)).toEqual({ skip: "The call's transcript was deleted." });
      await asOwner(tx);
      await tx.delete(calls).where(eq(calls.id, fixture.callId));
      expect(await fixture.email(fixture.owner.userId)).toEqual({ skip: "The call was deleted." });
    });
  });

  it("show each person whether the business sends them the email, and keep it off texts", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx);
      const preferences = async (userId: string) => {
        await asApp(tx);
        return await getNotificationPreferences({ db: fixture.db }, { userId, businessId: fixture.businessId });
      };
      expect(await preferences(fixture.owner.userId)).toMatchObject({ eventPreferences: { callTranscript: { email: true, sms: false } }, callTranscript: { available: true, unavailableReason: null, recipients: "owners_and_admins", content: "summary", canEdit: true } });
      // A person the business leaves out still sees what they chose.
      expect(await preferences(fixture.scheduler.userId)).toMatchObject({ eventPreferences: { callTranscript: { email: true, sms: false } }, callTranscript: { available: false, unavailableReason: "owners_and_admins_only", canEdit: false } });
      expect(await preferences(fixture.viewer.userId)).toMatchObject({ eventPreferences: { callTranscript: { email: false, sms: false } }, callTranscript: { available: false, canEdit: false } });

      const eventPreferences = { ...defaultOperatorNotificationEventPreferences(), callTranscript: { email: true, sms: true } };
      await asApp(tx);
      await setNotificationPreferences({ db: fixture.db }, { userId: fixture.quietAdmin.userId, businessId: fixture.businessId, emailEnabled: true, smsEnabled: false, eventPreferences });
      await asOwner(tx);
      const [saved] = await tx.select({ eventPreferences: operatorNotificationPreferences.eventPreferences }).from(operatorNotificationPreferences).where(eq(operatorNotificationPreferences.userId, fixture.quietAdmin.userId));
      expect(saved?.eventPreferences.callTranscript).toEqual({ email: true, sms: false });
    });
  });
});
