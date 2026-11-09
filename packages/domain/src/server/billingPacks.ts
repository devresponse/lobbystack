import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { billingPackDraws, billingPackPlans, billingPacks, enqueueOutbox, phoneNumbers, type DatabaseTransaction } from "@lobbystack/db";
import { isBillingPackStatus, MAX_PHONE_CALL_MS, packCapacitySeconds, packEndsAt, type BillingPackHolding, type BillingPackStatus, type BillingPlanLimits } from "@lobbystack/shared";

import { isSharedSmsSender } from "./smsSender";

// The prepaid pack ledger (migration 0148, docs/features/prepaid-packs.md). A
// business pays its billing provider once for a pack; the provider's part ends
// there. LobbyStack keeps the rest: one billing_packs row per payment, with
// everything the business gets copied onto it, the end date fixed at the
// payment, and what each call drew from it in billing_pack_draws. While a pack
// has time left the business is on the prepaid tier: the limits copied onto
// its packs apply, and its calls draw voice seconds from them, earliest end
// first, until none are left, when a call is refused as on Free.
//
// Every write to a business's packs takes the business's pack lock, after the
// usage period's lock when a call holds that one too, so a balance that spans
// months is never drawn twice.

/** A pack with time left, as reservations and the plan in force read it. */
export type LivePack = {
  id: string;
  pack: string;
  secondsTotal: number;
  secondsUsed: number;
  amountCents: number;
  refundedCents: number;
  paidAt: Date;
  endsAt: Date | null;
  smsSeg: number;
  callsOut: number;
  chatUnits: number;
  kbBytes: number;
  numbers: number;
  receptionists: number;
};

/** What a business's live packs add up to: their seconds, and the limits the prepaid tier enforces. */
export type PackBalance = {
  packs: LivePack[];
  /** The seconds the live packs hold after refunds. */
  secondsTotal: number;
  secondsUsed: number;
  secondsLeft: number;
  /** When the live pack that ends first ends; null when one never ends and it is the only one. */
  nextEndsAt: Date | null;
  /** When the last live pack ends; null when one never ends. */
  lastEndsAt: Date | null;
  limits: BillingPlanLimits;
};

const livePackColumns = {
  id: billingPacks.id,
  pack: billingPacks.pack,
  secondsTotal: billingPacks.secondsTotal,
  secondsUsed: billingPacks.secondsUsed,
  amountCents: billingPacks.amountCents,
  refundedCents: billingPacks.refundedCents,
  paidAt: billingPacks.paidAt,
  endsAt: billingPacks.endsAt,
  smsSeg: billingPacks.smsSeg,
  callsOut: billingPacks.callsOut,
  chatUnits: billingPacks.chatUnits,
  kbBytes: billingPacks.kbBytes,
  numbers: billingPacks.numbers,
  receptionists: billingPacks.receptionists,
};

/** The pack statuses that have ended: an ended pack never comes back. */
export const endedPackStatuses = ["expired", "replaced", "refunded"] as const satisfies readonly BillingPackStatus[];

/** Takes the business's pack lock for the rest of the transaction. */
export async function lockBusinessPacks(tx: DatabaseTransaction, businessId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing-packs:${businessId}`}, 0))`);
}

const liveAt = (now: Date) => and(eq(billingPacks.status, "active"), or(isNull(billingPacks.endsAt), gt(billingPacks.endsAt, now)));

/**
 * The business's packs with time left at `now`, the one that ends first
 * first, and a pack that never ends last. forUpdate locks the rows, for a
 * caller holding the pack lock that is about to draw on them.
 */
export async function readLivePacks(tx: DatabaseTransaction, businessId: string, options: { now?: Date; forUpdate?: boolean } = {}): Promise<LivePack[]> {
  const query = tx.select(livePackColumns).from(billingPacks)
    .where(and(eq(billingPacks.businessId, businessId), liveAt(options.now ?? new Date())))
    .orderBy(sql`${billingPacks.endsAt} asc nulls last`, asc(billingPacks.paidAt), asc(billingPacks.id));
  return options.forUpdate ? await query.for("update") : await query;
}

/** The seconds a pack still holds: what it holds after refunds, less what calls drew. */
export function packSecondsLeft(pack: Pick<LivePack, "secondsTotal" | "secondsUsed" | "amountCents" | "refundedCents">): number {
  return Math.max(0, packCapacitySeconds(pack) - pack.secondsUsed);
}

/** How many ended packs a pack list shows, newest first, after the live and frozen ones. */
export const LISTED_ENDED_PACKS = 20;

const heldPackColumns = {
  id: billingPacks.id,
  code: billingPacks.pack,
  names: billingPackPlans.names,
  status: billingPacks.status,
  secondsTotal: billingPacks.secondsTotal,
  secondsUsed: billingPacks.secondsUsed,
  amountCents: billingPacks.amountCents,
  refundedCents: billingPacks.refundedCents,
  days: billingPacks.days,
  paidAt: billingPacks.paidAt,
  endsAt: billingPacks.endsAt,
  endedAt: billingPacks.endedAt,
  currency: billingPacks.currency,
};

/**
 * The business's packs as Settings > Plan and the API show them: active and
 * frozen ones first, the one that ends first first, then the latest
 * LISTED_ENDED_PACKS ended ones, newest first. A pack whose end date passed
 * holds nothing, though it stays active until the daily expiry job ends it; a
 * frozen pack shows what it holds once its dispute is won. A business that
 * never bought a pack gets an empty list from one indexed read.
 */
export async function listBusinessPacks(tx: DatabaseTransaction, businessId: string, now = new Date()): Promise<BillingPackHolding[]> {
  const held = await tx.select(heldPackColumns).from(billingPacks).leftJoin(billingPackPlans, eq(billingPackPlans.code, billingPacks.pack))
    .where(and(eq(billingPacks.businessId, businessId), inArray(billingPacks.status, ["active", "frozen"])))
    .orderBy(sql`${billingPacks.endsAt} asc nulls last`, asc(billingPacks.paidAt), asc(billingPacks.id));
  const ended = await tx.select(heldPackColumns).from(billingPacks).leftJoin(billingPackPlans, eq(billingPackPlans.code, billingPacks.pack))
    .where(and(eq(billingPacks.businessId, businessId), inArray(billingPacks.status, [...endedPackStatuses])))
    .orderBy(desc(billingPacks.paidAt), desc(billingPacks.id)).limit(LISTED_ENDED_PACKS);
  return [...held, ...ended].map((row) => {
    const status: BillingPackStatus = isBillingPackStatus(row.status) ? row.status : "active";
    const timeLeft = (status === "active" || status === "frozen") && (row.endsAt === null || row.endsAt.getTime() > now.getTime());
    return {
      id: row.id,
      code: row.code,
      names: row.names ?? null,
      status,
      secondsTotal: packCapacitySeconds(row),
      secondsUsed: row.secondsUsed,
      secondsLeft: timeLeft ? packSecondsLeft(row) : 0,
      days: row.days,
      paidAt: row.paidAt.toISOString(),
      endsAt: row.endsAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
      currency: row.currency,
      amountCents: row.amountCents,
      refundedCents: row.refundedCents,
    };
  });
}

/**
 * The prepaid tier's limits from the live packs: the most any of them gives,
 * which is every pack's own when, as usual, they give the same. Voice has no
 * monthly allowance on a pack, and nothing past an allowance is billed.
 */
export function packLimits(packs: readonly LivePack[]): BillingPlanLimits {
  const most = (pick: (pack: LivePack) => number) => Math.max(...packs.map(pick));
  return {
    knowledgeStorageBytes: most((pack) => Number(pack.kbBytes)),
    voiceSecondsIncluded: null,
    alertSmsSegmentsIncluded: most((pack) => pack.smsSeg),
    outboundCallAttemptsIncluded: most((pack) => pack.callsOut),
    chatAiTokensIncluded: most((pack) => pack.chatUnits),
    includedBusinessNumbers: most((pack) => pack.numbers),
    includedReceptionists: most((pack) => pack.receptionists),
    overagesBillable: false,
    voiceOverageRatePerMinuteCents: null,
    alertSmsOverageRatePerSegmentCents: null,
    outboundCallAttemptOverageRateCents: null,
  };
}

/** What the live packs add up to, or null without one. */
export function packBalance(packs: readonly LivePack[]): PackBalance | null {
  if (packs.length === 0) return null;
  const secondsTotal = packs.reduce((sum, pack) => sum + packCapacitySeconds(pack), 0);
  const secondsUsed = packs.reduce((sum, pack) => sum + Math.min(pack.secondsUsed, packCapacitySeconds(pack)), 0);
  const ends = packs.map((pack) => pack.endsAt);
  const dated = ends.filter((end): end is Date => end !== null).map((end) => end.getTime());
  return {
    packs: [...packs],
    secondsTotal,
    secondsUsed,
    secondsLeft: packs.reduce((sum, pack) => sum + packSecondsLeft(pack), 0),
    nextEndsAt: dated.length ? new Date(Math.min(...dated)) : null,
    lastEndsAt: ends.includes(null) || !dated.length ? null : new Date(Math.max(...dated)),
    limits: packLimits(packs),
  };
}

/** The seconds the usage row sourceKey has drawn from the business's packs, by pack. */
async function readDraws(tx: DatabaseTransaction, businessId: string, sourceKey: string): Promise<Array<{ packId: string; seconds: number }>> {
  return await tx.select({ packId: billingPackDraws.packId, seconds: billingPackDraws.seconds }).from(billingPackDraws)
    .where(and(eq(billingPackDraws.businessId, businessId), eq(billingPackDraws.sourceKey, sourceKey)));
}

/** The seconds the usage row sourceKey has drawn from the business's packs. */
export async function drawnSeconds(tx: DatabaseTransaction, businessId: string, sourceKey: string): Promise<number> {
  return (await readDraws(tx, businessId, sourceKey)).reduce((sum, draw) => sum + draw.seconds, 0);
}

export type PackDrawResult = {
  /** The seconds the row draws now, which is less than asked when the live packs hold less. */
  drawn: number;
  /** The business's live balance before and after, for the low-balance notices. */
  before: PackBalance | null;
  after: PackBalance | null;
};

/**
 * Makes the usage row sourceKey draw `seconds` from the business's packs, in
 * whole seconds. More than it draws now takes the difference from the live
 * packs, the one that ends first first, as far as they hold it. Less gives the
 * difference back, to the pack drawn on last first, ended or not: a pack that
 * has ended keeps the seconds given back among its unused ones. Runs under the
 * business's pack lock, which the caller may already hold.
 */
export async function setPackDraw(tx: DatabaseTransaction, input: { businessId: string; sourceKey: string; seconds: number; now?: Date }): Promise<PackDrawResult> {
  await lockBusinessPacks(tx, input.businessId);
  const now = input.now ?? new Date();
  const target = Math.max(0, Math.ceil(input.seconds - 1e-9));
  const draws = await readDraws(tx, input.businessId, input.sourceKey);
  const current = draws.reduce((sum, draw) => sum + draw.seconds, 0);
  const live = await readLivePacks(tx, input.businessId, { now, forUpdate: true });
  const before = packBalance(live);
  if (target === current) return { drawn: current, before, after: before };
  if (target < current) {
    await giveBack(tx, input.businessId, input.sourceKey, draws, current - target);
    const after = packBalance(await readLivePacks(tx, input.businessId, { now }));
    return { drawn: target, before, after };
  }
  let need = target - current;
  for (const pack of live) {
    if (need <= 0) break;
    const take = Math.min(need, packSecondsLeft(pack));
    if (take <= 0) continue;
    await tx.update(billingPacks).set({ secondsUsed: sql`${billingPacks.secondsUsed} + ${take}`, updatedAt: new Date() }).where(eq(billingPacks.id, pack.id));
    await tx.insert(billingPackDraws).values({ packId: pack.id, businessId: input.businessId, sourceKey: input.sourceKey, seconds: take })
      .onConflictDoUpdate({ target: [billingPackDraws.packId, billingPackDraws.sourceKey], set: { seconds: sql`${billingPackDraws.seconds} + ${take}`, updatedAt: new Date() } });
    need -= take;
  }
  const after = packBalance(await readLivePacks(tx, input.businessId, { now }));
  const crossed = packBalanceCrossing(before, after);
  if (crossed && after) await queuePackNoticeRun(tx, { businessId: input.businessId, sourceKey: input.sourceKey, balance: after, notice: crossed, now });
  return { drawn: target - need, before, after };
}

/** The share of the live balance left at or below which the owners hear the balance is low. */
export const PACK_LOW_BALANCE_SHARE = 0.2;

/** A balance reminder: low at a fifth of the balance left, empty at none. */
export type PackBalanceNotice = "low" | "empty";

/** The balance reminder a draw crossed into, if any: empty when it took the last second, low when it took the balance to a fifth. */
export function packBalanceCrossing(before: PackBalance | null, after: PackBalance | null): PackBalanceNotice | null {
  if (!before || !after) return null;
  if (before.secondsLeft > 0 && after.secondsLeft <= 0) return "empty";
  const low = (balance: PackBalance) => balance.secondsLeft <= PACK_LOW_BALANCE_SHARE * balance.secondsTotal;
  return !low(before) && low(after) ? "low" : null;
}

/** The live pack bought last, which a balance reminder is recorded on, so each purchase can remind again. */
export function newestLivePack(balance: PackBalance): LivePack {
  return balance.packs.reduce((newest, pack) => pack.paidAt > newest.paidAt || (pack.paidAt.getTime() === newest.paidAt.getTime() && pack.id > newest.id) ? pack : newest);
}

/**
 * How long after a call reserved the balance down to low or empty its
 * reminder run waits: past the longest call, so the run reads what the call
 * really used once it was settled, not what it held while it ran.
 */
export const PACK_NOTICE_RUN_DELAY_MS = MAX_PHONE_CALL_MS + 5 * 60_000;

/**
 * Runs billing.expirePacks for the business soon, rather than at its daily
 * run, when a call took its balance to low or empty: that job sends the
 * reminders the settled balance is due. The call's transaction may not read
 * the owners, so it only queues the run, once per call, newest pack and
 * reminder; the job records each reminder sent, so runs that find nothing
 * new send nothing.
 */
async function queuePackNoticeRun(tx: DatabaseTransaction, input: { businessId: string; sourceKey: string; balance: PackBalance; notice: PackBalanceNotice; now: Date }): Promise<void> {
  const newest = newestLivePack(input.balance);
  await enqueueOutbox(tx, {
    topic: "billing.expirePacks",
    businessId: input.businessId,
    aggregateType: "billing_pack",
    aggregateId: newest.id,
    dedupeKey: `billing-pack:${newest.id}:${input.notice}:${input.sourceKey}`,
    availableAt: new Date(input.now.getTime() + PACK_NOTICE_RUN_DELAY_MS),
    payload: { reason: input.notice },
  });
}

async function giveBack(tx: DatabaseTransaction, businessId: string, sourceKey: string, draws: Array<{ packId: string; seconds: number }>, seconds: number): Promise<void> {
  const packs = await tx.select({ id: billingPacks.id, status: billingPacks.status, endsAt: billingPacks.endsAt, paidAt: billingPacks.paidAt, secondsTotal: billingPacks.secondsTotal, secondsUsed: billingPacks.secondsUsed, amountCents: billingPacks.amountCents, refundedCents: billingPacks.refundedCents })
    .from(billingPacks)
    .where(and(eq(billingPacks.businessId, businessId), inArray(billingPacks.id, draws.map((draw) => draw.packId))))
    .orderBy(sql`${billingPacks.endsAt} desc nulls first`, desc(billingPacks.paidAt), desc(billingPacks.id))
    .for("update");
  let release = seconds;
  for (const pack of packs) {
    if (release <= 0) break;
    const draw = draws.find((entry) => entry.packId === pack.id);
    const take = Math.min(release, draw?.seconds ?? 0, pack.secondsUsed);
    if (take <= 0) continue;
    const used = pack.secondsUsed - take;
    const ended = (endedPackStatuses as readonly string[]).includes(pack.status);
    await tx.update(billingPacks).set({ secondsUsed: used, ...(ended ? { unusedSeconds: Math.max(0, packCapacitySeconds(pack) - used) } : {}), updatedAt: new Date() }).where(eq(billingPacks.id, pack.id));
    await tx.update(billingPackDraws).set({ seconds: sql`${billingPackDraws.seconds} - ${take}`, updatedAt: new Date() }).where(and(eq(billingPackDraws.packId, pack.id), eq(billingPackDraws.sourceKey, sourceKey)));
    release -= take;
  }
}

/** A pack as the catalog sells it now, which a purchase copies. */
export type PackPlanTerms = {
  code: string;
  voiceSec: number;
  days: number | null;
  smsSeg: number;
  callsOut: number;
  chatUnits: number;
  kbBytes: number;
  numbers: number;
  receptionists: number;
};

/** A pack's catalog row, or null for a code the catalog doesn't have. */
export async function readPackPlan(tx: DatabaseTransaction, code: string): Promise<PackPlanTerms | null> {
  const [row] = await tx.select({ code: billingPackPlans.code, voiceSec: billingPackPlans.voiceSec, days: billingPackPlans.days, smsSeg: billingPackPlans.smsSeg, callsOut: billingPackPlans.callsOut, chatUnits: billingPackPlans.chatUnits, kbBytes: billingPackPlans.kbBytes, numbers: billingPackPlans.numbers, receptionists: billingPackPlans.receptionists })
    .from(billingPackPlans).where(eq(billingPackPlans.code, code)).limit(1);
  return row ? { ...row, kbBytes: Number(row.kbBytes) } : null;
}

/** A payment for a pack, as the provider's event reports it. */
export type PackPurchase = {
  businessId: string;
  pack: PackPlanTerms;
  priceId: string | null;
  provider: "polar" | "stripe";
  /** The Stripe PaymentIntent or the Polar order. */
  providerRef: string;
  amountCents: number;
  currency: string;
  paidAt: Date;
  transactionId: string | null;
};

/**
 * Adds the pack a payment bought, once: a second delivery of the same payment
 * finds the first's row. Everything the business gets is copied from the
 * catalog's row, and the end date is fixed now. created says whether this
 * call added it.
 */
export async function recordPackPurchaseInTransaction(tx: DatabaseTransaction, purchase: PackPurchase): Promise<{ packId: string; created: boolean }> {
  await lockBusinessPacks(tx, purchase.businessId);
  const [inserted] = await tx.insert(billingPacks).values({
    businessId: purchase.businessId,
    pack: purchase.pack.code,
    priceId: purchase.priceId,
    days: purchase.pack.days,
    provider: purchase.provider,
    providerRef: purchase.providerRef,
    transactionId: purchase.transactionId,
    amountCents: Math.max(0, Math.round(purchase.amountCents)),
    currency: purchase.currency.toLowerCase(),
    secondsTotal: purchase.pack.voiceSec,
    smsSeg: purchase.pack.smsSeg,
    callsOut: purchase.pack.callsOut,
    chatUnits: purchase.pack.chatUnits,
    kbBytes: purchase.pack.kbBytes,
    numbers: purchase.pack.numbers,
    receptionists: purchase.pack.receptionists,
    paidAt: purchase.paidAt,
    endsAt: packEndsAt(purchase.paidAt, purchase.pack.days),
  }).onConflictDoNothing({ target: [billingPacks.provider, billingPacks.providerRef] }).returning({ id: billingPacks.id });
  if (inserted) {
    // Its minutes and length are fixed once a business has bought it.
    await tx.update(billingPackPlans).set({ frozenAt: sql`coalesce(${billingPackPlans.frozenAt}, now())`, updatedAt: new Date() }).where(eq(billingPackPlans.code, purchase.pack.code));
    return { packId: inserted.id, created: true };
  }
  const [existing] = await tx.select({ id: billingPacks.id }).from(billingPacks).where(and(eq(billingPacks.provider, purchase.provider), eq(billingPacks.providerRef, purchase.providerRef))).limit(1);
  if (!existing) throw new Error("The pack's payment could not be read back.");
  return { packId: existing.id, created: false };
}

/** A pack found by its payment, with what its changes need. */
export type PackByPayment = {
  id: string;
  businessId: string;
  status: BillingPackStatus;
  amountCents: number;
  refundedCents: number;
  secondsTotal: number;
  secondsUsed: number;
  endsAt: Date | null;
};

async function packByPayment(tx: DatabaseTransaction, businessId: string, provider: string, providerRef: string): Promise<PackByPayment | null> {
  const [row] = await tx.select({ id: billingPacks.id, businessId: billingPacks.businessId, status: billingPacks.status, amountCents: billingPacks.amountCents, refundedCents: billingPacks.refundedCents, secondsTotal: billingPacks.secondsTotal, secondsUsed: billingPacks.secondsUsed, endsAt: billingPacks.endsAt })
    .from(billingPacks)
    .where(and(eq(billingPacks.businessId, businessId), eq(billingPacks.provider, provider), eq(billingPacks.providerRef, providerRef)))
    .limit(1)
    .for("update");
  return row ? { ...row, status: row.status as BillingPackStatus } : null;
}

/** The columns that end a pack: when, why, and the seconds it still held. */
function endedColumns(pack: Pick<PackByPayment, "secondsTotal" | "secondsUsed" | "amountCents">, status: (typeof endedPackStatuses)[number], at: Date, refundedCents: number) {
  return { status, endedAt: at, unusedSeconds: packSecondsLeft({ ...pack, refundedCents }), refundedCents, updatedAt: new Date() };
}

export type PackChange = { packId: string; status: BillingPackStatus; previous: BillingPackStatus };

/**
 * Applies a refund of a pack's payment: refundedCents is the payment's whole
 * refunded amount so far, as the provider reports it, so a repeated or late
 * event never takes off more. A partial refund takes its share of the seconds
 * off the pack; one of the whole payment ends it. Null when no pack has the
 * payment.
 */
export async function applyPackRefundInTransaction(tx: DatabaseTransaction, input: { businessId: string; provider: "polar" | "stripe"; providerRef: string; refundedCents: number; at: Date }): Promise<PackChange | null> {
  await lockBusinessPacks(tx, input.businessId);
  const pack = await packByPayment(tx, input.businessId, input.provider, input.providerRef);
  if (!pack) return null;
  const refunded = Math.max(pack.refundedCents, Math.round(input.refundedCents));
  if (refunded === pack.refundedCents) return { packId: pack.id, status: pack.status, previous: pack.status };
  const ended = (endedPackStatuses as readonly string[]).includes(pack.status);
  if (!ended && refunded >= pack.amountCents) {
    await tx.update(billingPacks).set(endedColumns(pack, "refunded", input.at, refunded)).where(eq(billingPacks.id, pack.id));
    return { packId: pack.id, status: "refunded", previous: pack.status };
  }
  await tx.update(billingPacks).set({ refundedCents: refunded, ...(ended ? { unusedSeconds: packSecondsLeft({ ...pack, refundedCents: refunded }) } : {}), updatedAt: new Date() }).where(eq(billingPacks.id, pack.id));
  return { packId: pack.id, status: pack.status, previous: pack.status };
}

/** Freezes a live pack whose payment is disputed: it stops counting until the dispute closes. */
export async function freezePackInTransaction(tx: DatabaseTransaction, input: { businessId: string; provider: "polar" | "stripe"; providerRef: string }): Promise<PackChange | null> {
  await lockBusinessPacks(tx, input.businessId);
  const pack = await packByPayment(tx, input.businessId, input.provider, input.providerRef);
  if (!pack) return null;
  if (pack.status !== "active") return { packId: pack.id, status: pack.status, previous: pack.status };
  await tx.update(billingPacks).set({ status: "frozen", updatedAt: new Date() }).where(eq(billingPacks.id, pack.id));
  return { packId: pack.id, status: "frozen", previous: pack.status };
}

/**
 * Closes a frozen pack's dispute: won, it is live again, or expired if its end
 * date passed meanwhile; lost, the payment went back, so it ends refunded,
 * also when the dispute's opening never reached LobbyStack and the pack was
 * still live.
 */
export async function closePackDisputeInTransaction(tx: DatabaseTransaction, input: { businessId: string; provider: "polar" | "stripe"; providerRef: string; won: boolean; at: Date }): Promise<PackChange | null> {
  await lockBusinessPacks(tx, input.businessId);
  const pack = await packByPayment(tx, input.businessId, input.provider, input.providerRef);
  if (!pack) return null;
  const lostWhileLive = !input.won && pack.status === "active";
  if (pack.status !== "frozen" && !lostWhileLive) return { packId: pack.id, status: pack.status, previous: pack.status };
  if (!input.won) {
    await tx.update(billingPacks).set(endedColumns(pack, "refunded", input.at, pack.amountCents)).where(eq(billingPacks.id, pack.id));
    return { packId: pack.id, status: "refunded", previous: pack.status };
  }
  if (pack.endsAt !== null && pack.endsAt <= input.at) {
    await tx.update(billingPacks).set(endedColumns(pack, "expired", pack.endsAt, pack.refundedCents)).where(eq(billingPacks.id, pack.id));
    return { packId: pack.id, status: "expired", previous: "frozen" };
  }
  await tx.update(billingPacks).set({ status: "active", updatedAt: new Date() }).where(eq(billingPacks.id, pack.id));
  return { packId: pack.id, status: "active", previous: "frozen" };
}

/**
 * Ends a pack whose end date has come, live or frozen, keeping the seconds it
 * still held for the accounts. Null when it already ended or its end hasn't come.
 */
export async function expirePackInTransaction(tx: DatabaseTransaction, input: { businessId: string; packId: string; now?: Date }): Promise<PackChange | null> {
  await lockBusinessPacks(tx, input.businessId);
  const now = input.now ?? new Date();
  const [pack] = await tx.select({ id: billingPacks.id, status: billingPacks.status, endsAt: billingPacks.endsAt, secondsTotal: billingPacks.secondsTotal, secondsUsed: billingPacks.secondsUsed, amountCents: billingPacks.amountCents, refundedCents: billingPacks.refundedCents })
    .from(billingPacks).where(and(eq(billingPacks.businessId, input.businessId), eq(billingPacks.id, input.packId))).limit(1).for("update");
  if (!pack || (pack.status !== "active" && pack.status !== "frozen") || pack.endsAt === null || pack.endsAt > now) return null;
  await tx.update(billingPacks).set(endedColumns(pack, "expired", pack.endsAt, pack.refundedCents)).where(eq(billingPacks.id, pack.id));
  return { packId: pack.id, status: "expired", previous: pack.status as BillingPackStatus };
}

/**
 * Ends every live or frozen pack of the business because a subscription
 * started (decision 6): their unused seconds are lost, kept on each row for
 * the accounts. Returns the packs it ended.
 */
export async function replaceLivePacksInTransaction(tx: DatabaseTransaction, input: { businessId: string; at: Date }): Promise<string[]> {
  await lockBusinessPacks(tx, input.businessId);
  // A pack whose end has come is the expiry job's: it ends expired, as it would have anyway.
  const packs = await tx.select({ id: billingPacks.id, secondsTotal: billingPacks.secondsTotal, secondsUsed: billingPacks.secondsUsed, amountCents: billingPacks.amountCents, refundedCents: billingPacks.refundedCents })
    .from(billingPacks)
    .where(and(eq(billingPacks.businessId, input.businessId), inArray(billingPacks.status, ["active", "frozen"]), or(isNull(billingPacks.endsAt), gt(billingPacks.endsAt, input.at))))
    .for("update");
  for (const pack of packs) {
    await tx.update(billingPacks).set(endedColumns(pack, "replaced", input.at, pack.refundedCents)).where(eq(billingPacks.id, pack.id));
  }
  return packs.map((pack) => pack.id);
}

/** Why a business's number goes back to Twilio once its last pack ended, as phone_numbers.reclaim_reason. */
export const PACK_RECLAIM_REASON = "pack_ended";

/**
 * Sets the business's numbers to go back to Twilio at releaseAt, once its last
 * live pack ended: its active numbers not already set to go, and never the
 * shared sender, as a cancellation does. A number set to go answers no call
 * (app.resolve_business_by_phone). Returns the release time, or null when no
 * number was set.
 */
export async function schedulePackNumberReleaseInTransaction(tx: DatabaseTransaction, input: { businessId: string; releaseAt: Date }): Promise<Date | null> {
  const numbers = (await tx.select({ id: phoneNumbers.id, e164: phoneNumbers.e164 }).from(phoneNumbers)
    .where(and(eq(phoneNumbers.businessId, input.businessId), eq(phoneNumbers.status, "active"), isNull(phoneNumbers.reclaimScheduledAt))))
    .filter((number) => !isSharedSmsSender(number.e164));
  if (!numbers.length) return null;
  await tx.update(phoneNumbers).set({ reclaimScheduledAt: input.releaseAt, reclaimReason: PACK_RECLAIM_REASON, updatedAt: new Date() })
    .where(and(eq(phoneNumbers.businessId, input.businessId), inArray(phoneNumbers.id, numbers.map((number) => number.id))));
  return input.releaseAt;
}

/**
 * Takes back the release a pack's end set, when a new pack or a subscription
 * brings the number back into the business's plan. Releases set for any other
 * reason keep their date, and a number Twilio is already taking back can't be
 * kept. Returns how many numbers it kept.
 */
export async function clearPackNumberReleaseInTransaction(tx: DatabaseTransaction, businessId: string): Promise<number> {
  // Read first, so a business that never had a pack has nothing written.
  const set = await tx.select({ id: phoneNumbers.id }).from(phoneNumbers)
    .where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.status, "active"), eq(phoneNumbers.reclaimReason, PACK_RECLAIM_REASON)));
  if (!set.length) return 0;
  await tx.update(phoneNumbers).set({ reclaimScheduledAt: null, reclaimReason: null, updatedAt: new Date() })
    .where(and(eq(phoneNumbers.businessId, businessId), inArray(phoneNumbers.id, set.map((number) => number.id))));
  return set.length;
}
