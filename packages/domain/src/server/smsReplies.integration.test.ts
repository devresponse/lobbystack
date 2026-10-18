import { randomInt, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businessMemberships, businesses, contacts, conversations, createDatabaseClient, messages, operatorNotificationDeliveries, outboxMessages, phoneNumbers, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { recordSmsConsentAnswerInTransaction, type SmsConsentAnswer } from "./contactSmsConsent";
import { appendMessage, getOrCreateConversation } from "./conversations";
import { claimSmsDelivery, loadSmsDeliveryTarget, markSmsFailed, receiveInboundSms, setContactSmsManualBlock } from "./sms";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("SMS reply integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

const digits = (count: number) => String(randomInt(0, 10 ** count)).padStart(count, "0");
const phone = () => `+1647${digits(7)}`;

type Shop = Awaited<ReturnType<typeof seedBusiness>>;

/** Runs a test in one transaction and rolls it back, so other suites never see its rows. */
async function rollbackTest(run: (shop: Shop) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      await run(await seedBusiness(tx));
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

/** Runs one step under the login production uses for it: the worker for webhooks and sends, the app for Messages. */
async function as<T>(tx: DatabaseTransaction, login: "worker" | "app", run: (db: Database) => Promise<T>): Promise<T> {
  await tx.execute(login === "worker" ? sql`set local session authorization lobbystack_worker` : sql`set local session authorization lobbystack_app`);
  try {
    return await run(tx as unknown as Database);
  } finally {
    await tx.execute(sql`reset session authorization`);
  }
}

/** A self-hosted business with its own SMS number and an owner who answers texts from Messages. */
async function seedBusiness(tx: DatabaseTransaction) {
  const businessId = randomUUID();
  const userId = randomUUID();
  const number = `+1437${digits(7)}`;
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Javor", timezone: "UTC", businessType: "test", telemetryEnabled: false, deploymentMode: "self_hosted_standard" });
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid` });
  await tx.insert(businessMemberships).values({ businessId, userId, role: "business_owner" });
  await tx.insert(phoneNumbers).values({ businessId, e164: number, providerPhoneId: `PN-${randomUUID()}` });
  const contactOf = async (contactPhone: string) => (await tx.select({ id: contacts.id, smsConsentStatus: contacts.smsConsentStatus, operatorBlockedAt: contacts.operatorBlockedAt }).from(contacts).where(and(eq(contacts.businessId, businessId), eq(contacts.phone, contactPhone))).limit(1))[0]!;
  /** An operator's reply from Messages. Returns the saved text. */
  const write = async (conversationId: string) => await as(tx, "app", (db) => appendMessage({ db }, { userId, businessId, conversationId, body: "We're open 9 to 5.", direction: "outbound", channel: "sms" }));
  /** What the worker's send would text for a saved reply, or why it holds the reply back. */
  const send = async (messageId: string) => await as(tx, "worker", async (db) => {
    expect(await claimSmsDelivery({ db }, { businessId, messageId })).toBe(true);
    return await loadSmsDeliveryTarget(db, { businessId, messageId });
  });
  return {
    businessId,
    number,
    contactOf,
    write,
    send,
    /** A customer's text to the business number, as the Twilio webhook hands it over. Returns its conversation. */
    async text(from: string, body: string): Promise<string> {
      await as(tx, "worker", (db) => receiveInboundSms({ db }, { businessId, providerMessageId: `SM${randomUUID()}`, from, to: number, body, payload: {} }));
      return (await tx.select({ id: conversations.id }).from(conversations).innerJoin(contacts, eq(contacts.id, conversations.contactId)).where(and(eq(conversations.businessId, businessId), eq(conversations.channel, "sms"), eq(contacts.phone, from))).limit(1))[0]!.id;
    },
    /** A caller's message for staff, as the receptionist takes it during a call. Returns its conversation. */
    async voiceMessage(from: string, body: string): Promise<string> {
      return await as(tx, "worker", async (db) => {
        const { conversationId } = await getOrCreateConversation({ db }, { businessId, contactPhone: from, channel: "voice" });
        await appendMessage({ db }, { businessId, conversationId, body, direction: "inbound", channel: "dashboard" });
        return conversationId;
      });
    },
    /** The caller's answer to "Can I text you?" on a call. */
    async answerTexts(contactPhone: string, answer: SmsConsentAnswer): Promise<void> {
      const contact = await contactOf(contactPhone);
      await as(tx, "worker", (db) => withBusinessTransaction(db, { businessId, actorType: "worker" }, (inner) => recordSmsConsentAnswerInTransaction(inner, { businessId, contactId: contact.id, phone: contactPhone, contact, answer, source: "voice_call" })));
    },
    async block(contactPhone: string): Promise<void> {
      const contact = await contactOf(contactPhone);
      expect(await as(tx, "app", (db) => setContactSmsManualBlock({ db }, { userId, businessId, contactId: contact.id, blocked: true }))).toBe(true);
    },
    /** Turns texting off on the business's number. */
    async stopTexting(): Promise<void> {
      await tx.update(phoneNumbers).set({ smsEnabled: false }).where(eq(phoneNumbers.businessId, businessId));
    },
    /** An operator's reply from Messages, then what the worker's send would text. */
    async reply(conversationId: string) {
      return await send(await write(conversationId));
    },
    /** The worker failing a reply it holds back, as its send does. */
    async fail(messageId: string, failure: Parameters<typeof markSmsFailed>[1]["failure"]): Promise<void> {
      await as(tx, "worker", (db) => markSmsFailed({ db }, { businessId, messageId, failure }));
    },
    async replies(conversationId: string) {
      return await tx.select({ status: messages.status, providerStatus: messages.providerStatus }).from(messages).where(and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId), eq(messages.direction, "outbound")));
    },
    async realtime(messageId: string) {
      return (await tx.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.topic, "realtime.publish"), eq(outboxMessages.aggregateId, messageId)))).map((row) => row.payload.type);
    },
    async failedTextAlerts() {
      return await tx.select({ eventKey: operatorNotificationDeliveries.eventKey, channel: operatorNotificationDeliveries.channel }).from(operatorNotificationDeliveries).where(and(eq(operatorNotificationDeliveries.businessId, businessId), eq(operatorNotificationDeliveries.eventKind, "smsFailed")));
    },
  };
}

describe.skipIf(!testUrl)("replies to customer texts", () => {
  it("texts a reply to a customer who texted first, without signing them up for other texts", async () => {
    await rollbackTest(async (shop) => {
      const customer = phone();
      const conversationId = await shop.text(customer, "Are you open Saturday?");
      expect(await shop.reply(conversationId)).toEqual({ ok: true, to: customer, from: shop.number, body: "We're open 9 to 5." });
      expect((await shop.contactOf(customer)).smsConsentStatus).toBeNull();
    });
  });

  it("answers a customer who declined appointment texts on a call", async () => {
    await rollbackTest(async (shop) => {
      const customer = phone();
      const conversationId = await shop.text(customer, "Can I move my booking?");
      await shop.answerTexts(customer, "declined");
      expect(await shop.reply(conversationId)).toMatchObject({ ok: true, to: customer });
    });
  });

  it("refuses replies to customers who opted out or were blocked, saying why, and saves none", async () => {
    await rollbackTest(async (shop) => {
      const stopped = phone();
      const stoppedConversation = await shop.text(stopped, "Are you open Saturday?");
      await shop.text(stopped, "STOP");
      await expect(shop.write(stoppedConversation)).rejects.toMatchObject({ status: 409, code: "sms_opted_out", message: expect.stringContaining("texted STOP") });
      expect(await shop.replies(stoppedConversation)).toEqual([]);

      const blocked = phone();
      const blockedConversation = await shop.text(blocked, "Are you open Saturday?");
      await shop.block(blocked);
      await expect(shop.write(blockedConversation)).rejects.toMatchObject({ status: 409, code: "sms_blocked" });
      expect(await shop.replies(blockedConversation)).toEqual([]);
    });
  });

  it("still needs a yes to text a customer who never texted, and says so", async () => {
    await rollbackTest(async (shop) => {
      const caller = phone();
      const conversationId = await shop.voiceMessage(caller, "Please call me back about Friday.");
      await expect(shop.write(conversationId)).rejects.toMatchObject({ status: 409, code: "sms_no_consent", message: expect.stringContaining("hasn't agreed to texts or texted you in this conversation") });
      await shop.answerTexts(caller, "agreed");
      expect(await shop.reply(conversationId)).toMatchObject({ ok: true, to: caller });
    });
  });

  it("refuses a reply when the business has no number that can text", async () => {
    await rollbackTest(async (shop) => {
      const conversationId = await shop.text(phone(), "Are you open Saturday?");
      await shop.stopTexting();
      await expect(shop.write(conversationId)).rejects.toMatchObject({ status: 409, code: "sms_no_sender" });
    });
  });

  it("fails a reply the customer can no longer get by the time it goes out, with the reason and an alert", async () => {
    await rollbackTest(async (shop) => {
      const customer = phone();
      const conversationId = await shop.text(customer, "Are you open Saturday?");
      const messageId = await shop.write(conversationId);
      await shop.text(customer, "STOP");

      expect(await shop.send(messageId)).toEqual({ ok: false, reason: "opted_out" });
      await shop.fail(messageId, { held: "opted_out" });

      expect(await shop.replies(conversationId)).toEqual([{ status: "failed", providerStatus: "held:opted_out" }]);
      expect(await shop.realtime(messageId)).toContain("message.deliveryUpdated");
      expect(await shop.failedTextAlerts()).toEqual([{ eventKey: `smsFailed:${messageId}`, channel: "email" }]);
      // A failed text stays failed: another run of the send changes nothing.
      await shop.fail(messageId, { rejected: 21610 });
      expect(await shop.replies(conversationId)).toEqual([{ status: "failed", providerStatus: "held:opted_out" }]);
    });
  });
});
