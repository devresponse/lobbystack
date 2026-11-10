import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { auditLogs, billingAccounts, billingPackDraws, billingPackPlans, billingPacks, billingUsageEvents, businesses, enqueueOutbox, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { billingPlanName, isReplacedSubscription, normalizeInterfaceLocale } from "@lobbystack/shared";

import { isLiveSubscriptionState, lockBillingAccount } from "./billing";
import { expirePackInTransaction, lockBusinessPacks, newestLivePack, PACK_LOW_BALANCE_SHARE, PACK_NOTICE_RUN_DELAY_MS, PACK_RECLAIM_REASON, packBalance, packSecondsLeft, readLivePacks, schedulePackNumberReleaseInTransaction, type LivePack, type PackBalance } from "./billingPacks";
import type { DomainContext } from "./context";
import { lockBusinessNumberClaims } from "./phoneNumbers";
import { enqueueReceptionistAllowanceCheck } from "./receptionists";
import { loadBusinessPlanLimits } from "./usage";

// The end of a business's prepaid packs (billing.expirePacks,
// docs/features/prepaid-packs.md). The worker runs it once a day for every
// business, 35 minutes after a call takes the live balance to a fifth or to
// nothing, and at once when a refund or a dispute ends a pack. One transaction:
//
// 1. Ends each pack whose end date has come, live or frozen, keeping the
//    minutes it still held for the accounts.
// 2. Settles each pack that ended by its date, a refund or a dispute,
//    once. When no pack is left that could still count, the business's last
//    pack has ended: receptionists past the plan's number pause, and on a plan
//    without a number the number stops answering and goes back to Twilio 30
//    days after the pack ended, unless a new pack, a subscription or a
//    managed plan takes that back.
//    A pack a subscription replaced is never settled here: the business moved
//    to a plan, and reconcile handled it.
// 3. Emails the owners the reminders due while a pack is the plan in force:
//    at a fifth of the balance left, at none, both read without what calls
//    still running hold, and 30 and 7 days before a pack ends.
// 4. Asks the provider again to end a subscription a pack replaced while it
//    still shows it live (decision 6).
//
// billing_packs.notices records what was done, under the pack lock, so a run
// repeats nothing however often it runs, and a business that never bought a
// pack is left before any lock is taken.

const DAY_MS = 86_400_000;

/** How long after a business's last pack ended its number goes back to Twilio, as on a canceled account. */
const PACK_NUMBER_GRACE_MS = 30 * DAY_MS;

/** A reminder the owners get: low at a fifth of the live balance left, empty at none, ends_30 and ends_7 before a pack's end. */
export type PackReminder = "low" | "empty" | "ends_30" | "ends_7";

/** A live pack with what billing_packs.notices says was already done about it. */
export type NoticedLivePack = LivePack & { notices: readonly string[] };

/** A reminder due: the one to send about packId, and every notice to record on that pack, which includes a reminder it makes pointless. */
export type PackReminderDue = { packId: string; reminder: PackReminder; record: PackReminder[] };

/** What one run did: packs it ended, packs it settled, emails it queued, and the number's release it set. */
export type PackExpiryResult = { expired: number; settled: number; emails: number; releaseAt: Date | null };

const END_REMINDER_DAYS = { ends_30: 30, ends_7: 7 } as const;

/** Whether a pack's reminder `days` before its end is due: that day has come, it falls after the purchase, and it wasn't sent. */
function endReminderDue(pack: NoticedLivePack & { endsAt: Date }, reminder: keyof typeof END_REMINDER_DAYS, now: Date): boolean {
  const at = pack.endsAt.getTime() - END_REMINDER_DAYS[reminder] * DAY_MS;
  return !pack.notices.includes(reminder) && now.getTime() >= at && pack.paidAt.getTime() < at;
}

/**
 * The reminders due about a business's live packs at `now`, each at most once
 * a pack. ends_30 and ends_7 come for a pack with an end date once its end is
 * that near, and never when that day fell before the purchase, so a short pack
 * doesn't warn as it is bought. low and empty come on the whole live balance
 * and are recorded on the newest pack, so a pack bought later reminds again.
 * A run that finds both of a pair due, as after missed days, sends only the
 * later one (ends_7, empty) and records both.
 */
export function packRemindersDue(input: { live: readonly NoticedLivePack[]; balance: PackBalance | null; now: Date }): PackReminderDue[] {
  const due: PackReminderDue[] = [];
  for (const pack of input.live) {
    if (!pack.endsAt) continue;
    const dated = { ...pack, endsAt: pack.endsAt };
    // A month's reminder after the week's would say less, later.
    const month = !pack.notices.includes("ends_7") && endReminderDue(dated, "ends_30", input.now);
    if (endReminderDue(dated, "ends_7", input.now)) due.push({ packId: pack.id, reminder: "ends_7", record: month ? ["ends_30", "ends_7"] : ["ends_7"] });
    else if (month) due.push({ packId: pack.id, reminder: "ends_30", record: ["ends_30"] });
  }
  const balance = input.balance;
  if (balance && balance.packs.length) {
    const newestId = newestLivePack(balance).id;
    const notices = input.live.find((pack) => pack.id === newestId)?.notices ?? [];
    if (balance.secondsLeft <= 0) {
      if (!notices.includes("empty")) due.push({ packId: newestId, reminder: "empty", record: notices.includes("low") ? ["empty"] : ["low", "empty"] });
    } else if (balance.secondsLeft <= PACK_LOW_BALANCE_SHARE * balance.secondsTotal && !notices.includes("low") && !notices.includes("empty")) {
      due.push({ packId: newestId, reminder: "low", record: ["low"] });
    }
  }
  return due;
}

/**
 * billing.expirePacks for one business, as the worker: ends the packs whose
 * end has come, settles each ended pack once, sends the reminders due and asks
 * again for a replaced subscription's end. A business without a pack returns
 * zeros at once, without a lock.
 */
export async function expireBusinessPacks(context: DomainContext, input: { businessId: string; appUrl: string; now?: Date }): Promise<PackExpiryResult> {
  const { businessId } = input;
  const now = input.now ?? new Date();
  return await withBusinessTransaction(context.db, { businessId, actorType: "worker" }, async (tx) => {
    const [anyPack] = await tx.select({ id: billingPacks.id }).from(billingPacks).where(eq(billingPacks.businessId, businessId)).limit(1);
    if (!anyPack) return { expired: 0, settled: 0, emails: 0, releaseAt: null };
    // Number claims, reconcile and every pack write take these, in this order, as a cancellation does.
    await lockBusinessNumberClaims(tx, businessId);
    await lockBillingAccount(tx, businessId);
    await lockBusinessPacks(tx, businessId);

    const expired = await expireDuePacks(tx, businessId, now);
    const live = await readLivePacks(tx, businessId, { now });
    const { settled, releaseAt } = await settleEndedPacks(tx, { businessId, now, live });
    const emails = await sendDueReminders(tx, { businessId, now, live, appUrl: input.appUrl });
    await askAgainToEndReplacedPlan(tx, businessId, now);
    if (expired + settled > 0) {
      await enqueueOutbox(tx, { topic: "realtime.publish", businessId, aggregateType: "billing_account", aggregateId: businessId, dedupeKey: `billing:${businessId}:packs-expired:${now.getTime()}`, payload: { type: "billing.updated", entityId: businessId } });
    }
    return { expired, settled, emails, releaseAt };
  });
}

/** Ends each live or frozen pack whose end has come, with an audit row each. Returns how many it ended. */
async function expireDuePacks(tx: DatabaseTransaction, businessId: string, now: Date): Promise<number> {
  const due = await tx.select({ id: billingPacks.id, pack: billingPacks.pack }).from(billingPacks)
    .where(and(eq(billingPacks.businessId, businessId), inArray(billingPacks.status, ["active", "frozen"]), lte(billingPacks.endsAt, now)))
    .orderBy(asc(billingPacks.endsAt), asc(billingPacks.id));
  let expired = 0;
  for (const pack of due) {
    if (!await expirePackInTransaction(tx, { businessId, packId: pack.id, now })) continue;
    const [row] = await tx.select({ unusedSeconds: billingPacks.unusedSeconds }).from(billingPacks).where(eq(billingPacks.id, pack.id));
    await tx.insert(auditLogs).values({ businessId, eventType: "billing.pack_expired", entityType: "billing_pack", entityId: pack.id, payload: { pack: pack.pack, unusedSeconds: row?.unusedSeconds ?? 0 } });
    expired += 1;
  }
  return expired;
}

/**
 * Settles, once, each pack that ended by its date, a refund or a dispute.
 * When the business has no live pack left, nor a frozen one a won dispute
 * could bring back, its last pack has ended: the receptionist check runs, and
 * a plan in force without a number sets the number's release 30 days after
 * the latest of these packs ended, or now when that has passed.
 */
async function settleEndedPacks(tx: DatabaseTransaction, input: { businessId: string; now: Date; live: readonly LivePack[] }): Promise<{ settled: number; releaseAt: Date | null }> {
  const { businessId, now } = input;
  const ended = await tx.select({ id: billingPacks.id, endedAt: billingPacks.endedAt }).from(billingPacks)
    .where(and(eq(billingPacks.businessId, businessId), inArray(billingPacks.status, ["expired", "refunded"]), sql`not ('ended' = any(${billingPacks.notices}))`));
  if (!ended.length) return { settled: 0, releaseAt: null };
  let releaseAt: Date | null = null;
  if (!input.live.length && !await hasFrozenPackWithTimeLeft(tx, businessId, now)) {
    await enqueueReceptionistAllowanceCheck(tx, businessId, "pack_ended");
    const { limits } = await loadBusinessPlanLimits(tx, businessId);
    if (limits.includedBusinessNumbers === 0) {
      const lastEnded = Math.max(...ended.map((pack) => (pack.endedAt ?? now).getTime()));
      releaseAt = await schedulePackNumberReleaseInTransaction(tx, { businessId, releaseAt: new Date(Math.max(lastEnded + PACK_NUMBER_GRACE_MS, now.getTime())) });
      if (releaseAt) await tx.insert(auditLogs).values({ businessId, eventType: "billing.pack_number_release_set", entityType: "business", entityId: businessId, payload: { releaseAt: releaseAt.toISOString(), reason: PACK_RECLAIM_REASON } });
    }
  }
  await tx.update(billingPacks).set({ notices: sql`array_append(${billingPacks.notices}, 'ended')`, updatedAt: new Date() })
    .where(and(eq(billingPacks.businessId, businessId), inArray(billingPacks.id, ended.map((pack) => pack.id))));
  return { settled: ended.length, releaseAt };
}

/** Whether a frozen pack still has time left: a won dispute would make it live again, so the business's packs haven't all ended. */
async function hasFrozenPackWithTimeLeft(tx: DatabaseTransaction, businessId: string, now: Date): Promise<boolean> {
  const [frozen] = await tx.select({ id: billingPacks.id }).from(billingPacks)
    .where(and(eq(billingPacks.businessId, businessId), eq(billingPacks.status, "frozen"), or(isNull(billingPacks.endsAt), gt(billingPacks.endsAt, now))))
    .limit(1);
  return Boolean(frozen);
}

type Recipient = { user_id: string; email: string; preferred_locale: string | null; business_name: string; timezone: string | null };

/**
 * Emails each owner, in their own language, the reminders due, and records
 * them on their packs in the same transaction. A reminder no owner can get is
 * recorded all the same, as a promo plan's ending is. A canceled business
 * gets none: nobody can open it, and its owners hear again if it comes back.
 * Neither does one whose packs wait beside a managed, yearly or past-due plan:
 * what the emails say about calls and the number holds only while a pack is
 * the plan in force. Nothing is recorded then, so the reminders still due come
 * once a pack is the plan again. Returns the emails queued.
 */
async function sendDueReminders(tx: DatabaseTransaction, input: { businessId: string; now: Date; live: readonly LivePack[]; appUrl: string }): Promise<number> {
  const { businessId, live } = input;
  if (!live.length) return 0;
  if ((await loadBusinessPlanLimits(tx, businessId)).plan !== "prepaid") return 0;
  const noticeRows = await tx.select({ id: billingPacks.id, notices: billingPacks.notices }).from(billingPacks)
    .where(and(eq(billingPacks.businessId, businessId), inArray(billingPacks.id, live.map((pack) => pack.id))));
  const noticesOf = new Map(noticeRows.map((row) => [row.id, row.notices]));
  // low and empty read the balance without what calls still running hold; a pack's end, the packs as they are.
  const balance = packBalance(await withoutOpenReservations(tx, { businessId, now: input.now, live }));
  const due = packRemindersDue({ live: live.map((pack) => ({ ...pack, notices: noticesOf.get(pack.id) ?? [] })), balance, now: input.now });
  if (!due.length) return 0;
  const [business] = await tx.select({ status: businesses.status }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (business?.status !== "active") return 0;

  const recipients = (await tx.execute<Recipient>(sql`select user_id, email, preferred_locale, business_name, timezone from app.billing_owner_recipients(${businessId}::uuid)`)).rows;
  const codes = [...new Set(live.filter((pack) => due.some((entry) => entry.packId === pack.id)).map((pack) => pack.pack))];
  const plans = recipients.length ? await tx.select({ code: billingPackPlans.code, names: billingPackPlans.names }).from(billingPackPlans).where(inArray(billingPackPlans.code, codes)) : [];
  const namesOf = new Map(plans.map((plan) => [plan.code, plan.names]));
  const base = input.appUrl.endsWith("/") ? input.appUrl.slice(0, -1) : input.appUrl;
  let emails = 0;
  const recorded = new Map<string, string[]>();
  for (const entry of due) {
    const pack = live.find((candidate) => candidate.id === entry.packId);
    if (!pack) continue;
    // low and empty speak of the whole balance; a pack's end, of that pack.
    const secondsLeft = entry.reminder === "low" || entry.reminder === "empty" ? balance?.secondsLeft ?? 0 : packSecondsLeft(pack);
    for (const recipient of recipients) {
      const locale = normalizeInterfaceLocale(recipient.preferred_locale) ?? "en";
      await enqueueOutbox(tx, {
        topic: "email.send",
        businessId,
        aggregateType: "billing_pack",
        aggregateId: pack.id,
        dedupeKey: `billing-pack:${pack.id}:${entry.reminder}:${recipient.user_id}`,
        payload: {
          template: "pack_reminder",
          to: recipient.email,
          variables: {
            locale,
            businessName: recipient.business_name,
            packName: billingPlanName(namesOf.get(pack.pack) ?? {}, locale) ?? pack.pack,
            reminder: entry.reminder,
            // To the nearest minute, and never none while seconds are left.
            minutesLeft: String(secondsLeft > 0 ? Math.max(1, Math.round(secondsLeft / 60)) : 0),
            ...(pack.endsAt ? { date: pack.endsAt.toISOString() } : {}),
            timeZone: recipient.timezone ?? "UTC",
            url: `${base}/settings/plan`,
          },
        },
      });
      emails += 1;
    }
    const notices = recorded.get(pack.id) ?? [...(noticesOf.get(pack.id) ?? [])];
    for (const notice of entry.record) if (!notices.includes(notice)) notices.push(notice);
    recorded.set(pack.id, notices);
  }
  for (const [packId, notices] of recorded) {
    await tx.update(billingPacks).set({ notices, updatedAt: new Date() }).where(and(eq(billingPacks.businessId, businessId), eq(billingPacks.id, packId)));
  }
  return emails;
}

/**
 * The live packs as the balance reminders read them: with the seconds calls
 * still running drew up front given back, since a call's finish settles what
 * it really used, so a call holding the last minutes doesn't read as none
 * left. A call's usage row on a pack that isn't final yet is running only
 * within the longest call and a margin of its start, the wait of the run its
 * draw queued: past that it is stuck, and what it drew counts as used, so it
 * can't hide the balance for good.
 */
async function withoutOpenReservations(tx: DatabaseTransaction, input: { businessId: string; now: Date; live: readonly LivePack[] }): Promise<LivePack[]> {
  const open = await tx.select({ packId: billingPackDraws.packId, seconds: sql<number>`sum(${billingPackDraws.seconds})`.mapWith(Number) }).from(billingPackDraws)
    .innerJoin(billingUsageEvents, and(eq(billingUsageEvents.businessId, billingPackDraws.businessId), eq(billingUsageEvents.sourceKey, billingPackDraws.sourceKey)))
    .where(and(
      eq(billingPackDraws.businessId, input.businessId),
      eq(billingUsageEvents.usageKind, "voice_seconds"),
      eq(billingUsageEvents.planAtRecordTime, "prepaid"),
      eq(billingUsageEvents.isFinal, false),
      gt(billingUsageEvents.createdAt, new Date(input.now.getTime() - PACK_NOTICE_RUN_DELAY_MS)),
    ))
    .groupBy(billingPackDraws.packId);
  const held = new Map(open.map((row) => [row.packId, row.seconds]));
  return input.live.map((pack) => ({ ...pack, secondsUsed: Math.max(0, pack.secondsUsed - (held.get(pack.id) ?? 0)) }));
}

/**
 * Decision 6's backstop: while the provider still shows live a subscription a
 * pack replaced, queues the job that ends it again, once a day, since a job
 * id the queue still holds would swallow a repeat.
 */
async function askAgainToEndReplacedPlan(tx: DatabaseTransaction, businessId: string, now: Date): Promise<void> {
  const [account] = await tx.select({ subscriptionId: billingAccounts.subscriptionId, subscriptionState: billingAccounts.subscriptionState, replacedSubscriptionId: billingAccounts.replacedSubscriptionId, allowancesSince: billingAccounts.allowancesSince })
    .from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
  if (!account?.subscriptionId || !isReplacedSubscription(account) || !isLiveSubscriptionState(account.subscriptionState)) return;
  await enqueueOutbox(tx, {
    topic: "billing.endPlanForPack",
    businessId,
    aggregateType: "billing_account",
    aggregateId: businessId,
    dedupeKey: `end-plan-for-pack:${account.subscriptionId}:${now.toISOString().slice(0, 10)}`,
    payload: { subscriptionId: account.subscriptionId, since: (account.allowancesSince ?? now).toISOString() },
  });
}
