import { randomInt, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businessMemberships, businesses, contacts, conversations, createDatabaseClient, phoneNumbers, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { recordSmsConsentAnswerInTransaction, type SmsConsentAnswer } from "./contactSmsConsent";
import { appendMessage, getOrCreateConversation } from "./conversations";
import { claimSmsDelivery, loadSmsDeliveryTarget, receiveInboundSms, setContactSmsManualBlock } from "./sms";

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
  return {
    number,
    contactOf,
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
    /** An operator's reply from Messages, then what the worker's send would text: null when it holds the reply back. */
    async reply(conversationId: string) {
      const messageId = await as(tx, "app", (db) => appendMessage({ db }, { userId, businessId, conversationId, body: "We're open 9 to 5.", direction: "outbound", channel: "sms" }));
      return await as(tx, "worker", async (db) => {
        expect(await claimSmsDelivery({ db }, { businessId, messageId })).toBe(true);
        return await loadSmsDeliveryTarget(db, { businessId, messageId });
      });
    },
  };
}

describe.skipIf(!testUrl)("replies to customer texts", () => {
  it("texts a reply to a customer who texted first, without signing them up for other texts", async () => {
    await rollbackTest(async (shop) => {
      const customer = phone();
      const conversationId = await shop.text(customer, "Are you open Saturday?");
      expect(await shop.reply(conversationId)).toEqual({ to: customer, from: shop.number, body: "We're open 9 to 5." });
      expect((await shop.contactOf(customer)).smsConsentStatus).toBeNull();
    });
  });

  it("answers a customer who declined appointment texts on a call", async () => {
    await rollbackTest(async (shop) => {
      const customer = phone();
      const conversationId = await shop.text(customer, "Can I move my booking?");
      await shop.answerTexts(customer, "declined");
      expect(await shop.reply(conversationId)).toMatchObject({ to: customer });
    });
  });

  it("holds back replies to customers who opted out or were blocked", async () => {
    await rollbackTest(async (shop) => {
      const stopped = phone();
      const stoppedConversation = await shop.text(stopped, "Are you open Saturday?");
      await shop.text(stopped, "STOP");
      expect(await shop.reply(stoppedConversation)).toBeNull();

      const blocked = phone();
      const blockedConversation = await shop.text(blocked, "Are you open Saturday?");
      await shop.block(blocked);
      expect(await shop.reply(blockedConversation)).toBeNull();
    });
  });

  it("still needs a yes to text a customer who never texted", async () => {
    await rollbackTest(async (shop) => {
      const caller = phone();
      const conversationId = await shop.voiceMessage(caller, "Please call me back about Friday.");
      expect(await shop.reply(conversationId)).toBeNull();
      await shop.answerTexts(caller, "agreed");
      expect(await shop.reply(conversationId)).toMatchObject({ to: caller });
    });
  });
});
