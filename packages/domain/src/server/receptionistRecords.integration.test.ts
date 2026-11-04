import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  billingAccounts,
  businesses,
  calls,
  conversations,
  createDatabaseClient,
  inboxItems,
  knowledgeSnippetReceptionists,
  knowledgeSnippets,
  phoneNumbers,
  receptionistProfiles,
  rlsContextStatement,
  unansweredQuestionReceptionists,
  users,
  type Database,
  type DatabaseTransaction,
} from "@lobbystack/db";

import { findCurrentWidgetChat, findWidgetConversationId, getOrCreateConversation, getOrCreateWidgetConversation, setAutomationState } from "./conversations";
import { listPhoneReceptionists } from "./receptionistRecords";
import { archiveReceptionistInTransaction, createReceptionistInTransaction, setReceptionistStatusInTransaction } from "./receptionists";
import { receiveInboundSms } from "./sms";
import { createBusiness } from "./tenancy";
import { answerUnansweredQuestion, listOpenUnansweredQuestions, recordUnansweredQuestion } from "./unansweredQuestions";
import { createVoiceFollowUpTask, getCallDetail, listCalls } from "./voice";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Receptionist record integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  await expect(client!.db.transaction(async (tx) => {
    await run(tx);
    throw rollback;
  })).rejects.toBe(rollback);
}

async function as(tx: DatabaseTransaction, role: "lobbystack_app" | "lobbystack_worker" | null) {
  await tx.execute(sql`reset role`);
  if (role) await tx.execute(sql.raw(`set local role ${role}`));
}

/** Acts as the business's owner in the dashboard: the app role under the business's row level security. */
async function asOwner(tx: DatabaseTransaction, input: { userId: string; businessId: string }) {
  await as(tx, "lobbystack_app");
  await tx.execute(rlsContextStatement({ userId: input.userId, businessId: input.businessId, actorType: "operator" }));
}

/** Runs a step that should fail in a savepoint, so the transaction goes on after it. */
async function failure(tx: DatabaseTransaction, run: (inner: DatabaseTransaction) => Promise<unknown>): Promise<unknown> {
  return await tx.transaction(async (inner) => { await run(inner); }).then(() => null, (error: unknown) => error);
}

const phone = () => `+1604${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`;

/**
 * A Pro business, whose default receptionist is the front desk, with a second
 * receptionist for its Gastown store.
 */
async function seedChain(tx: DatabaseTransaction, name = "Kitsilano Coffee") {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid`, name: "Riley Owner" });
  await as(tx, "lobbystack_app");
  const context = { db: tx as unknown as Database };
  const { businessId } = await createBusiness(context, { userId, name, timezone: "America/Vancouver", businessType: "restaurant", deploymentMode: "cloud" });
  await as(tx, null);
  await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "pro", subscriptionState: "active", source: "polar" });
  const [main] = await tx.select().from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)));
  await asOwner(tx, { userId, businessId });
  const store = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Gastown store", description: "Orders at Gastown" } });
  await as(tx, null);
  return { context, userId, businessId, mainId: main!.id, storeId: store.id };
}

/** The PostgreSQL error code a step fails with, as a savepoint, or null when it succeeds. */
async function errorCode(tx: DatabaseTransaction, run: (inner: DatabaseTransaction) => Promise<unknown>): Promise<string | null> {
  const error = await failure(tx, run) as { code?: string; cause?: { code?: string } } | null;
  return error ? error.cause?.code ?? error.code ?? "unknown" : null;
}

const newCall = (businessId: string, receptionistId?: string) => ({ businessId, providerCallId: `call-${randomUUID()}`, transport: "sip", startedAt: new Date(), ...(receptionistId ? { receptionistId } : {}) });

describe.skipIf(!testUrl)("records naming their receptionist, against PostgreSQL under RLS", () => {
  it("gives every new business its default receptionist, named in its language, however the business is made", async () => {
    await rollbackTest(async (tx) => {
      // Made outside sign-up, as the seed and other tools do: the database adds it with the default settings.
      const bare = randomUUID();
      await tx.insert(businesses).values({ id: bare, slug: bare, name: "Boulangerie Javor", timezone: "UTC", businessType: "test", defaultLocale: "fr" });
      const made = await tx.select().from(receptionistProfiles).where(eq(receptionistProfiles.businessId, bare));
      expect(made).toEqual([expect.objectContaining({ isDefault: true, name: "Accueil", handle: null, status: "active", knowledgeScope: "all", greeting: "Thank you for calling Boulangerie Javor.", tone: "professional", bookingPolicy: "Confirm availability before booking.", transferMode: "on_request", locale: null })]);
      // A business can't get a second default receptionist.
      expect(await errorCode(tx, (inner) => inner.insert(receptionistProfiles).values({ businessId: bare, greeting: "Hi", tone: "warm", bookingPolicy: "Book", transferMode: "never" }))).toBe("23505");

      // Sign-up gives the one the database made its own greeting and instructions, and adds no other.
      const { businessId, mainId } = await seedChain(tx);
      const [main] = await tx.select().from(receptionistProfiles).where(eq(receptionistProfiles.id, mainId));
      expect(main).toMatchObject({ businessId, isDefault: true, name: "Front desk", greeting: "Thanks for calling Kitsilano Coffee.", tone: "warm and direct", transferMode: "on_request" });
      expect(await tx.select({ id: receptionistProfiles.id }).from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)))).toEqual([{ id: mainId }]);
    });
  });

  it("requires the receptionist on every call, conversation and follow-up, giving one whose insert names none the default", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, mainId, storeId } = await seedChain(tx);
      const other = await seedChain(tx, "Other Roasters");
      const [call] = await tx.insert(calls).values(newCall(businessId)).returning({ id: calls.id, receptionistId: calls.receptionistId });
      const [chat] = await tx.insert(conversations).values({ businessId, channel: "web_chat" }).returning({ id: conversations.id, receptionistId: conversations.receptionistId });
      const [item] = await tx.insert(inboxItems).values({ businessId, kind: "callback", title: "Call back", body: "Asked for a call back." }).returning({ id: inboxItems.id, receptionistId: inboxItems.receptionistId });
      const [named] = await tx.insert(calls).values(newCall(businessId, storeId)).returning({ receptionistId: calls.receptionistId });
      expect([call?.receptionistId, chat?.receptionistId, item?.receptionistId, named?.receptionistId]).toEqual([mainId, mainId, mainId, storeId]);

      // Nothing can clear it, and a record can only name a receptionist of its own business.
      for (const table of ["calls", "conversations", "inbox_items"] as const) {
        expect(await errorCode(tx, (inner) => inner.execute(sql`update ${sql.identifier(table)} set receptionist_id = null where business_id = ${businessId}::uuid`))).toBe("23502");
        expect(await errorCode(tx, (inner) => inner.execute(sql`update ${sql.identifier(table)} set receptionist_id = ${other.mainId}::uuid where business_id = ${businessId}::uuid`))).toBe("23503");
      }
      const keys = await tx.execute<{ conname: string; convalidated: boolean }>(sql`select conname, convalidated from pg_constraint where conname in ('calls_receptionist_fk', 'conversations_receptionist_fk', 'inbox_items_receptionist_fk') order by conname`);
      expect(keys.rows).toEqual([
        { conname: "calls_receptionist_fk", convalidated: true },
        { conname: "conversations_receptionist_fk", convalidated: true },
        { conname: "inbox_items_receptionist_fk", convalidated: true },
      ]);
    });
  });

  it("keeps the settings every receptionist shares on the business alone", async () => {
    await rollbackTest(async (tx) => {
      const columns = await tx.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'receptionist_profiles' and column_name in ('summary', 'summary_source', 'summary_fingerprint', 'summary_generated_at', 'recording_notice', 'appointment_change_policy')`);
      expect(columns.rows).toEqual([]);
      const copier = await tx.execute<{ name: string }>(sql`select tgname as name from pg_trigger where tgname = 'receptionist_profiles_copy_shared_settings' union all select proname from pg_proc where proname = 'copy_shared_receptionist_settings'`);
      expect(copier.rows).toEqual([]);
    });
  });

  it("lists the receptionists that answer the business's numbers, a paused or archived one's as the default", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      await asOwner(tx, { userId, businessId });
      const lab = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Lab results" } });
      const catering = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Catering" } });
      const downtown = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Downtown" } });
      await setReceptionistStatusInTransaction(tx, { businessId, actorUserId: userId, receptionistId: lab.id, status: "paused" });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: catering.id });
      await as(tx, null);
      const storeNumber = phone();
      const labNumber = phone();
      await tx.insert(phoneNumbers).values([
        { businessId, e164: storeNumber, receptionistId: storeId },
        { businessId, e164: labNumber, receptionistId: lab.id },
        { businessId, e164: phone(), receptionistId: catering.id },
        // Downtown's numbers take no calls.
        { businessId, e164: phone(), receptionistId: downtown.id, voiceEnabled: false },
        { businessId, e164: phone(), receptionistId: downtown.id, status: "released" },
      ]);

      await as(tx, "lobbystack_worker");
      expect((await listPhoneReceptionists(context, { businessId })).sort()).toEqual([mainId, storeId].sort());

      // The incoming call webhook asks the same before it knows the business.
      await as(tx, "lobbystack_app");
      const resolve = async (e164: string) => (await tx.execute<{ id: string | null }>(sql`select app.resolve_receptionist_by_phone(${e164}) as id`)).rows[0]?.id ?? null;
      expect(await resolve(storeNumber)).toBe(storeId);
      expect(await resolve(labNumber)).toBe(mainId);
      expect(await resolve(phone())).toBeNull();
      await as(tx, null);
      await tx.update(phoneNumbers).set({ receptionistId: null }).where(eq(phoneNumbers.e164, storeNumber));
      await as(tx, "lobbystack_app");
      // A number naming no receptionist answers as the default.
      expect(await resolve(storeNumber)).toBe(mainId);
    });
  });

  it("filters calls by the receptionist that answered and names it, a call that named none counting for the default", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      const [old] = await tx.insert(calls).values(newCall(businessId)).returning({ id: calls.id });
      const [front] = await tx.insert(calls).values(newCall(businessId, mainId)).returning({ id: calls.id });
      const [store] = await tx.insert(calls).values(newCall(businessId, storeId)).returning({ id: calls.id });

      await as(tx, "lobbystack_app");
      const all = await listCalls(context, { userId, businessId });
      expect(all.pagination.total).toBe(3);
      const names = Object.fromEntries(all.calls.map((call) => [call.id as string, call.receptionist]));
      expect(names).toEqual({
        [old!.id]: { id: mainId, name: "Front desk" },
        [front!.id]: { id: mainId, name: "Front desk" },
        [store!.id]: { id: storeId, name: "Gastown store" },
      });
      const atFrontDesk = await listCalls(context, { userId, businessId, receptionistId: mainId });
      expect(atFrontDesk.calls.map((call) => call.id).sort()).toEqual([old!.id, front!.id].sort());
      expect(atFrontDesk.pagination.total).toBe(2);
      expect((await listCalls(context, { userId, businessId, receptionistId: storeId })).calls.map((call) => call.id)).toEqual([store!.id]);
      // Another business's receptionist answered none of them.
      expect((await listCalls(context, { userId, businessId, receptionistId: randomUUID() })).calls).toEqual([]);
      await expect(listCalls(context, { userId, businessId, receptionistId: "gastown" })).rejects.toMatchObject({ status: 400, code: "invalid_receptionist" });
      // A call's page names it too.
      expect((await getCallDetail(context, { userId, businessId, callId: store!.id }))?.call.receptionist).toEqual({ id: storeId, name: "Gastown store" });
      expect((await getCallDetail(context, { userId, businessId, callId: old!.id }))?.call.receptionist).toEqual({ id: mainId, name: "Front desk" });
    });
  });

  it("names the receptionist on a follow-up: the call's, or else the one that took it", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, mainId, storeId } = await seedChain(tx);
      const [call] = await tx.insert(calls).values(newCall(businessId, storeId)).returning({ id: calls.id });
      await as(tx, "lobbystack_worker");
      // A follow-up saved after the call, whoever is answering then.
      const fromCall = await createVoiceFollowUpTask(context, { businessId, callId: call!.id, message: "Call me back about catering.", receptionistId: mainId });
      const fromChat = await createVoiceFollowUpTask(context, { businessId, message: "Call me back.", channel: "web_chat", receptionistId: storeId });
      const unnamed = await createVoiceFollowUpTask(context, { businessId, message: "Call me back.", receptionistId: "gastown" });
      await as(tx, null);
      const rows = await tx.select({ id: inboxItems.id, receptionistId: inboxItems.receptionistId }).from(inboxItems).where(eq(inboxItems.businessId, businessId));
      expect(Object.fromEntries(rows.map((row) => [row.id, row.receptionistId]))).toEqual({ [fromCall.inboxItemId]: storeId, [fromChat.inboxItemId]: storeId, [unnamed.inboxItemId]: mainId });
    });
  });

  it("names the receptionist a conversation starts with, keeps an open one's, and names a texted number's", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, mainId, storeId } = await seedChain(tx);
      const storeNumber = phone();
      await tx.insert(phoneNumbers).values({ businessId, e164: storeNumber, receptionistId: storeId });
      await as(tx, "lobbystack_worker");
      const caller = phone();
      const first = await getOrCreateConversation(context, { businessId, contactPhone: caller, channel: "voice", receptionistId: storeId });
      const again = await getOrCreateConversation(context, { businessId, contactPhone: caller, channel: "voice", receptionistId: mainId });
      expect(again.conversationId).toBe(first.conversationId);
      const texter = phone();
      await receiveInboundSms(context, { businessId, providerMessageId: `SM${randomUUID()}`, from: texter, to: storeNumber, body: "Are you open today?", payload: {} });
      // A text to a number the business doesn't have, like the shared sender, is the default's.
      await receiveInboundSms(context, { businessId, providerMessageId: `SM${randomUUID()}`, from: phone(), to: phone(), body: "Hello?", payload: {} });
      await as(tx, null);
      const rows = await tx.select({ id: conversations.id, channel: conversations.channel, receptionistId: conversations.receptionistId }).from(conversations).where(eq(conversations.businessId, businessId));
      expect(rows.find((row) => row.id === first.conversationId)?.receptionistId).toBe(storeId);
      expect(rows.filter((row) => row.channel === "sms").map((row) => row.receptionistId).sort()).toEqual([mainId, storeId].sort());
    });
  });

  it("names the receptionist of a number the business bought again, not the released row's", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, mainId, storeId } = await seedChain(tx);
      // The store's number was released, then bought again for the default receptionist:
      // the released row stays as 'reclaimed' beside the new one (migration 0124).
      const reboughtNumber = phone();
      await tx.insert(phoneNumbers).values({ businessId, e164: reboughtNumber, receptionistId: storeId, status: "reclaimed", voiceEnabled: false, smsEnabled: false });
      await tx.insert(phoneNumbers).values({ businessId, e164: reboughtNumber, receptionistId: mainId });
      await as(tx, "lobbystack_worker");
      await receiveInboundSms(context, { businessId, providerMessageId: `SM${randomUUID()}`, from: phone(), to: reboughtNumber, body: "Do you deliver?", payload: {} });
      await as(tx, null);
      const rows = await tx.select({ receptionistId: conversations.receptionistId }).from(conversations).where(and(eq(conversations.businessId, businessId), eq(conversations.channel, "sms")));
      expect(rows).toEqual([{ receptionistId: mainId }]);
    });
  });

  it("keeps a website visitor's chat with one receptionist, while a chat the team has stays theirs on any page", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      const widgetVisitorId = randomUUID();
      await as(tx, "lobbystack_worker");
      const first = await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId, receptionistId: mainId });
      expect(first).toMatchObject({ automationState: "ai_active", receptionistId: mainId });
      expect(await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId, receptionistId: mainId })).toEqual(first);

      // On the store's page the visitor's next message starts a chat with the store, and the first one closes.
      const second = await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId, receptionistId: storeId });
      expect(second.conversationId).not.toBe(first.conversationId);
      expect(second).toMatchObject({ automationState: "ai_active", receptionistId: storeId });
      await as(tx, null);
      const [closed] = await tx.select({ status: conversations.status }).from(conversations).where(eq(conversations.id, first.conversationId));
      expect(closed?.status).toBe("closed");

      // Each page shows only its own receptionist's chat; a page naming none shows the open one.
      await as(tx, "lobbystack_worker");
      expect(await findCurrentWidgetChat(context, { businessId, widgetVisitorId, receptionistId: mainId })).toBeNull();
      expect(await findCurrentWidgetChat(context, { businessId, widgetVisitorId, receptionistId: storeId })).toEqual({ conversationId: second.conversationId, idle: false });
      expect(await findWidgetConversationId(context, { businessId, widgetVisitorId, receptionistId: mainId })).toBeNull();
      expect(await findWidgetConversationId(context, { businessId, widgetVisitorId, receptionistId: storeId })).toBe(second.conversationId);
      expect(await findWidgetConversationId(context, { businessId, widgetVisitorId })).toBe(second.conversationId);

      // Once someone from the team takes the store's chat, it stays the visitor's on the front desk's page too.
      await as(tx, "lobbystack_app");
      await setAutomationState(context, { userId, businessId, conversationId: second.conversationId, state: "human_handoff" });
      await as(tx, "lobbystack_worker");
      expect(await getOrCreateWidgetConversation(context, { businessId, widgetVisitorId, receptionistId: mainId })).toEqual({ conversationId: second.conversationId, automationState: "human_handoff", receptionistId: storeId });
      expect(await findCurrentWidgetChat(context, { businessId, widgetVisitorId, receptionistId: mainId })).toEqual({ conversationId: second.conversationId, idle: false });
    });
  });

  it("counts a question under each receptionist that heard it, and filters the list by one", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      const [storeCall] = await tx.insert(calls).values(newCall(businessId, storeId)).returning({ id: calls.id });
      const [storeChat] = await tx.insert(conversations).values({ businessId, channel: "web_chat", receptionistId: storeId }).returning({ id: conversations.id });

      await as(tx, "lobbystack_worker");
      const now = new Date();
      // The store hears it on a call and in a chat; the front desk once, on a call naming nothing.
      const fromCall = await recordUnansweredQuestion(context, { businessId, question: "Do you sell gift cards?", channel: "voice", callId: storeCall!.id, now: new Date(now.getTime() - 60_000) });
      await recordUnansweredQuestion(context, { businessId, question: "do you sell GIFT cards", channel: "web_chat", conversationId: storeChat!.id, receptionistId: mainId, now });
      await recordUnansweredQuestion(context, { businessId, question: "Do you sell gift cards?", channel: "voice", now });
      // Only the front desk hears this one, named by the agent.
      const parking = await recordUnansweredQuestion(context, { businessId, question: "Is there parking?", channel: "web_chat", receptionistId: mainId, now });
      // A receptionist of another business never counts.
      await recordUnansweredQuestion(context, { businessId, question: "Is there parking?", channel: "web_chat", receptionistId: randomUUID(), now });

      await as(tx, null);
      const links = await tx.select().from(unansweredQuestionReceptionists).where(eq(unansweredQuestionReceptionists.businessId, businessId));
      expect(links.map((link) => [link.questionId === fromCall!.id ? "gift cards" : "parking", link.receptionistId === storeId ? "store" : "front desk", link.timesAsked]).sort()).toEqual([
        ["gift cards", "front desk", 1],
        ["gift cards", "store", 2],
        ["parking", "front desk", 2],
      ]);

      await as(tx, "lobbystack_app");
      const all = await listOpenUnansweredQuestions(context, { userId, businessId });
      expect(all.openCount).toBe(2);
      expect(all.openByReceptionist).toEqual({ [mainId]: 2, [storeId]: 1 });
      const giftCards = all.questions.find((question) => question.id === fromCall!.id)!;
      expect(giftCards.timesAsked).toBe(3);
      expect(giftCards.askedOf.map((asker) => [asker.name, asker.timesAsked, asker.archived])).toEqual([["Gastown store", 2, false], ["Front desk", 1, false]]);
      const atStore = await listOpenUnansweredQuestions(context, { userId, businessId, receptionistId: storeId });
      expect(atStore.questions.map((question) => question.id)).toEqual([fromCall!.id]);
      expect(atStore.openCount).toBe(1);
      expect((await listOpenUnansweredQuestions(context, { userId, businessId, receptionistId: mainId })).questions.map((question) => question.id).sort()).toEqual([fromCall!.id, parking!.id].sort());
      await expect(listOpenUnansweredQuestions(context, { userId, businessId, receptionistId: "store" })).rejects.toMatchObject({ status: 400, code: "invalid_receptionist" });
    });
  });

  it("answers a question for the receptionists that asked, for everyone, or for those chosen", async () => {
    await rollbackTest(async (tx) => {
      const { context, userId, businessId, mainId, storeId } = await seedChain(tx);
      await asOwner(tx, { userId, businessId });
      const catering = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Catering" } });

      await as(tx, "lobbystack_worker");
      const ask = async (question: string, ...receptionistIds: string[]) => {
        let saved: Awaited<ReturnType<typeof recordUnansweredQuestion>> = null;
        for (const receptionistId of receptionistIds) saved = await recordUnansweredQuestion(context, { businessId, question, channel: "web_chat", receptionistId });
        return saved!;
      };
      const giftCards = await ask("Do you sell gift cards?", storeId, catering.id);
      const parking = await ask("Is there parking?", storeId);
      const wifi = await ask("Do you have wifi?", catering.id);
      const dogs = await ask("Can I bring my dog?", mainId);

      await asOwner(tx, { userId, businessId });
      const asked = await answerUnansweredQuestion(context, { userId, businessId, questionId: giftCards.id, answer: "Yes, at the counter.", audience: { audience: "asked" } });
      expect(asked.audience).toBe("chosen");
      expect([...asked.receptionistIds].sort()).toEqual([storeId, catering.id].sort());
      const everyone = await answerUnansweredQuestion(context, { userId, businessId, questionId: parking.id, answer: "Street parking only.", audience: { audience: "everyone" } });
      expect(everyone).toEqual({ snippetId: everyone.snippetId, audience: "everyone", receptionistIds: [] });
      const chosen = await answerUnansweredQuestion(context, { userId, businessId, questionId: dogs.id, answer: "Dogs are welcome on the patio.", audience: { audience: "chosen", receptionistIds: [mainId, storeId] } });
      expect(chosen.receptionistIds).toEqual([mainId, storeId]);

      // Every receptionist that asked is archived: the answer needs someone chosen.
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: catering.id });
      const refused = await failure(tx, (inner) => answerUnansweredQuestion({ db: inner as unknown as Database }, { userId, businessId, questionId: wifi.id, answer: "Yes, ask for the password.", audience: { audience: "asked" } }));
      expect(refused).toMatchObject({ status: 409, code: "no_receptionists_asked" });

      await as(tx, null);
      const audiences = Object.fromEntries((await tx.select({ id: knowledgeSnippets.id, audience: knowledgeSnippets.audience }).from(knowledgeSnippets).where(eq(knowledgeSnippets.businessId, businessId))).map((row) => [row.id, row.audience]));
      expect(audiences).toEqual({ [asked.snippetId]: "chosen", [everyone.snippetId]: "everyone", [chosen.snippetId]: "chosen" });
      const linked = await tx.select({ snippetId: knowledgeSnippetReceptionists.snippetId, receptionistId: knowledgeSnippetReceptionists.receptionistId }).from(knowledgeSnippetReceptionists).where(eq(knowledgeSnippetReceptionists.businessId, businessId));
      expect(linked.filter((row) => row.snippetId === asked.snippetId).map((row) => row.receptionistId).sort()).toEqual([storeId, catering.id].sort());
      expect(linked.filter((row) => row.snippetId === chosen.snippetId).map((row) => row.receptionistId).sort()).toEqual([mainId, storeId].sort());
      expect(linked.filter((row) => row.snippetId === everyone.snippetId)).toEqual([]);
    });
  });
});
