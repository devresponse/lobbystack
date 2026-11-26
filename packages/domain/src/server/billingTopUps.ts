import { and, asc, desc, eq, gt, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";

import { auditLogs, billingPackPlans, billingTopUpDraws, billingTopUps, enqueueOutbox, type DatabaseTransaction } from "@lobbystack/db";
import { billingTopUpStatus, isBillingCode, normalizeBillingCode, packCapacity, topUpEndsAt, type ApiBillingTopUp, type BillingTopUpAmounts, type BillingTopUpCodeView, type BillingTopUpHolding, type BillingTopUpSource } from "@lobbystack/shared";

import { packUsageKinds, type PackAllowance, type PackUsageKind } from "./billingPacks";

// The top-up ledger (migrations 0154 and 0155, docs/features/top-ups.md). A
// top-up is extra voice seconds, alert texts, transfers and website chats on
// top of the business's plan: an operator grants one with a platform key,
// someone on the team adds one with a top-up code, or the business pays for
// one on sale through the billing provider. It never changes the plan. Its uses
// draw on it only once the plan's own allowance of their kind is used up (on
// the prepaid tier, once the packs hold none of it), the top-up that ends
// first first, and what it paid for is never counted against the allowance,
// the spending cap or the billing provider: usage.ts records that part on the
// usage row as top_up_quantity, and which top-up paid for it here.
//
// Every draw on a business's top-ups takes the business's top-up lock, after
// the usage period's lock and the pack lock when the use holds those too, so a
// balance that spans months is never drawn twice.

/** The usage kinds a top-up gives: a call's seconds, a text's segments, a transfer's attempts and a website chat's units, as a pack does. */
export const topUpUsageKinds = packUsageKinds;
export type TopUpUsageKind = PackUsageKind;

/** One allowance of the live top-ups: what they give, what uses drew, and what is left. */
export type TopUpAllowance = PackAllowance;

/** A top-up that counts now, as reservations read it. */
export type LiveTopUp = {
  id: string;
  voiceSec: number;
  smsSeg: number;
  callsOut: number;
  chatUnits: number;
  voiceUsed: number;
  smsUsed: number;
  callsUsed: number;
  chatUsed: number;
  startsAt: Date;
  endsAt: Date | null;
};

// Each kind's columns on a top-up: what it gives and what uses drew.
const kindFields = {
  voice_seconds: { total: "voiceSec", used: "voiceUsed" },
  alert_sms_segments: { total: "smsSeg", used: "smsUsed" },
  outbound_call_attempts: { total: "callsOut", used: "callsUsed" },
  chat_ai_tokens: { total: "chatUnits", used: "chatUsed" },
} as const satisfies Record<TopUpUsageKind, { total: keyof LiveTopUp; used: keyof LiveTopUp }>;

const usedColumns = { voice_seconds: billingTopUps.voiceUsed, alert_sms_segments: billingTopUps.smsUsed, outbound_call_attempts: billingTopUps.callsUsed, chat_ai_tokens: billingTopUps.chatUsed } as const satisfies Record<TopUpUsageKind, unknown>;

/** What a top-up still holds of a kind. */
export function topUpKindLeft(topUp: LiveTopUp, kind: TopUpUsageKind): number {
  return Math.max(0, topUp[kindFields[kind].total] - topUp[kindFields[kind].used]);
}

/** What a business's live top-ups add up to. */
export type TopUpBalance = {
  topUps: LiveTopUp[];
  /** Every allowance the live top-ups hold, by usage kind. */
  allowances: Record<TopUpUsageKind, TopUpAllowance>;
  /** When the live top-up that ends first ends; null when none ends. */
  nextEndsAt: Date | null;
  /** When the last live top-up ends; null when one never ends. */
  lastEndsAt: Date | null;
};

const liveColumns = {
  id: billingTopUps.id,
  voiceSec: billingTopUps.voiceSec,
  smsSeg: billingTopUps.smsSeg,
  callsOut: billingTopUps.callsOut,
  chatUnits: billingTopUps.chatUnits,
  voiceUsed: billingTopUps.voiceUsed,
  smsUsed: billingTopUps.smsUsed,
  callsUsed: billingTopUps.callsUsed,
  chatUsed: billingTopUps.chatUsed,
  startsAt: billingTopUps.startsAt,
  endsAt: billingTopUps.endsAt,
  amountCents: billingTopUps.amountCents,
  refundedCents: billingTopUps.refundedCents,
};

/**
 * What a top-up gives after refunds: a purchase partly refunded gives its
 * unrefunded share of each allowance, as a pack does (packCapacity). A grant
 * or a code's top-up, never paid for, gives what it gave.
 */
export function topUpGives<T extends { voiceSec: number; smsSeg: number; callsOut: number; chatUnits: number; amountCents: number; refundedCents: number }>(row: T): T {
  if (row.refundedCents <= 0) return row;
  return { ...row, voiceSec: packCapacity(row.voiceSec, row), smsSeg: packCapacity(row.smsSeg, row), callsOut: packCapacity(row.callsOut, row), chatUnits: packCapacity(row.chatUnits, row) };
}

function liveTopUp(row: LiveTopUp & { amountCents: number; refundedCents: number }): LiveTopUp {
  const { amountCents: _paid, refundedCents: _refunded, ...topUp } = topUpGives(row);
  return topUp;
}

/** Takes the business's top-up lock for the rest of the transaction. */
export async function lockBusinessTopUps(tx: DatabaseTransaction, businessId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing-top-ups:${businessId}`}, 0))`);
}

const liveAt = (now: Date) => and(eq(billingTopUps.status, "active"), lte(billingTopUps.startsAt, now), or(isNull(billingTopUps.endsAt), gt(billingTopUps.endsAt, now)));

/**
 * The business's top-ups that count at `now`: active, started and not ended,
 * the one that ends first first and one that never ends last. forUpdate locks
 * the rows, for a caller holding the top-up lock that is about to draw on them.
 * A business that never had a top-up gets nothing from one indexed read.
 */
export async function readLiveTopUps(tx: DatabaseTransaction, businessId: string, options: { now?: Date; forUpdate?: boolean } = {}): Promise<LiveTopUp[]> {
  const query = tx.select(liveColumns).from(billingTopUps)
    .where(and(eq(billingTopUps.businessId, businessId), liveAt(options.now ?? new Date())))
    .orderBy(sql`${billingTopUps.endsAt} asc nulls last`, asc(billingTopUps.startsAt), asc(billingTopUps.id));
  // What each gives after refunds, which is what uses may draw.
  return (options.forUpdate ? await query.for("update") : await query).map(liveTopUp);
}

/** What the live top-ups add up to, or null without one. */
export function topUpBalance(topUps: readonly LiveTopUp[]): TopUpBalance | null {
  if (topUps.length === 0) return null;
  const ends = topUps.map((topUp) => topUp.endsAt);
  const dated = ends.filter((end): end is Date => end !== null).map((end) => end.getTime());
  const allowance = (kind: TopUpUsageKind): TopUpAllowance => ({
    total: topUps.reduce((sum, topUp) => sum + topUp[kindFields[kind].total], 0),
    used: topUps.reduce((sum, topUp) => sum + Math.min(topUp[kindFields[kind].used], topUp[kindFields[kind].total]), 0),
    left: topUps.reduce((sum, topUp) => sum + topUpKindLeft(topUp, kind), 0),
  });
  return {
    topUps: [...topUps],
    allowances: Object.fromEntries(topUpUsageKinds.map((kind) => [kind, allowance(kind)])) as Record<TopUpUsageKind, TopUpAllowance>,
    nextEndsAt: dated.length ? new Date(Math.min(...dated)) : null,
    lastEndsAt: ends.includes(null) || !dated.length ? null : new Date(Math.max(...dated)),
  };
}

/** What a business's live top-ups hold, as the usage status reports it: each allowance, with what uses drew and what is left. */
export type TopUpUsage = {
  voiceSeconds: TopUpAllowance;
  alertSmsSegments: TopUpAllowance;
  outboundCallAttempts: TopUpAllowance;
  chatAiUnits: TopUpAllowance;
  /** When the live top-up that ends first ends; null when none ends. */
  nextEndsAt: Date | null;
  /** When the last live top-up ends; null when one never ends. */
  lastEndsAt: Date | null;
};

/** A balance as the usage status reports it; null without a live top-up. */
export function topUpUsage(balance: TopUpBalance | null): TopUpUsage | null {
  return balance ? { voiceSeconds: balance.allowances.voice_seconds, alertSmsSegments: balance.allowances.alert_sms_segments, outboundCallAttempts: balance.allowances.outbound_call_attempts, chatAiUnits: balance.allowances.chat_ai_tokens, nextEndsAt: balance.nextEndsAt, lastEndsAt: balance.lastEndsAt } : null;
}

/** What the business's live top-ups still hold of a kind. */
export function topUpLeft(balance: TopUpBalance | null | undefined, kind: TopUpUsageKind): number {
  return balance?.allowances[kind].left ?? 0;
}

/**
 * How much of a use of `quantity` a top-up pays for: what `room` can't take,
 * as far as the top-ups hold it (`available`, with what the use already drew
 * from them). room is what the plan's own allowance still takes of it: on the
 * prepaid tier what the packs hold, else the allowance left after the other
 * uses, or null where a top-up never pays (usage.ts decides). Whole units, as
 * a top-up is drawn, and never more than the use.
 */
export function topUpShare(input: { quantity: number; available: number; room: number | null }): number {
  if (input.room === null || input.available <= 0) return 0;
  const over = Math.max(0, input.quantity - Math.max(0, input.room));
  if (over <= 1e-9) return 0;
  return Math.min(input.quantity, input.available, Math.ceil(over - 1e-9));
}

/**
 * The business's live top-ups under its top-up lock, for a use about to draw
 * on them or settle what it drew (`drew`). A business without a live top-up
 * (balance null), whose use drew none, takes no lock and reads nothing more.
 */
export async function lockedTopUps(tx: DatabaseTransaction, businessId: string, balance: TopUpBalance | null | undefined, drew = false): Promise<TopUpBalance | null> {
  if (!balance && !drew) return null;
  await lockBusinessTopUps(tx, businessId);
  return topUpBalance(await readLiveTopUps(tx, businessId));
}

/** What the usage row sourceKey drew from the business's top-ups, by top-up. */
async function readTopUpDraws(tx: DatabaseTransaction, businessId: string, sourceKey: string): Promise<Array<{ topUpId: string; units: number }>> {
  return await tx.select({ topUpId: billingTopUpDraws.topUpId, units: billingTopUpDraws.units }).from(billingTopUpDraws)
    .where(and(eq(billingTopUpDraws.businessId, businessId), eq(billingTopUpDraws.sourceKey, sourceKey)));
}

/** What the usage row sourceKey drew from the business's top-ups, in its kind's units. */
export async function drawnTopUpUnits(tx: DatabaseTransaction, businessId: string, sourceKey: string): Promise<number> {
  return (await readTopUpDraws(tx, businessId, sourceKey)).reduce((sum, draw) => sum + draw.units, 0);
}

export type TopUpDrawResult = {
  /** What the row draws now, which is less than asked when the live top-ups hold less. */
  drawn: number;
  /** The business's live balance after the change. */
  after: TopUpBalance | null;
};

/**
 * Makes the usage row sourceKey draw `units` of its kind from the business's
 * top-ups: seconds for a call, segments for a text, attempts for a transfer,
 * units for a chat, rounded up to whole units. More than it draws now takes
 * the difference from the live top-ups, the one that ends first first, as far
 * as they hold it. Less gives the difference back to the top-up drawn on last
 * first, ended or not. Runs under the business's top-up lock, which the caller
 * may already hold.
 */
export async function setTopUpDraw(tx: DatabaseTransaction, input: { businessId: string; sourceKey: string; usageKind: TopUpUsageKind; units: number; now?: Date }): Promise<TopUpDrawResult> {
  await lockBusinessTopUps(tx, input.businessId);
  const now = input.now ?? new Date();
  const kind = input.usageKind;
  const target = Math.max(0, Math.ceil(input.units - 1e-9));
  const draws = await readTopUpDraws(tx, input.businessId, input.sourceKey);
  const current = draws.reduce((sum, draw) => sum + draw.units, 0);
  const live = await readLiveTopUps(tx, input.businessId, { now, forUpdate: true });
  if (target === current) return { drawn: current, after: topUpBalance(live) };
  if (target < current) {
    await giveBack(tx, { businessId: input.businessId, sourceKey: input.sourceKey, kind, draws, amount: current - target });
    return { drawn: target, after: topUpBalance(await readLiveTopUps(tx, input.businessId, { now })) };
  }
  let need = target - current;
  const used = usedColumns[kind];
  for (const topUp of live) {
    if (need <= 0) break;
    const take = Math.min(need, topUpKindLeft(topUp, kind));
    if (take <= 0) continue;
    await tx.update(billingTopUps).set({ [kindFields[kind].used]: sql`${used} + ${take}`, updatedAt: new Date() }).where(eq(billingTopUps.id, topUp.id));
    await tx.insert(billingTopUpDraws).values({ topUpId: topUp.id, businessId: input.businessId, sourceKey: input.sourceKey, usageKind: kind, units: take })
      .onConflictDoUpdate({ target: [billingTopUpDraws.topUpId, billingTopUpDraws.sourceKey], set: { units: sql`${billingTopUpDraws.units} + ${take}`, updatedAt: new Date() } });
    need -= take;
  }
  return { drawn: target - need, after: topUpBalance(await readLiveTopUps(tx, input.businessId, { now })) };
}

/**
 * Makes the usage row sourceKey draw its share, `units` (topUpShare), from the
 * business's top-ups when that is more than nothing or the row drew before
 * (`drew`), which gives back what it no longer needs. What the row draws then,
 * never more than its share, and the balance after; `balance` as it is when
 * the row neither draws nor drew.
 */
export async function drawTopUpShare(tx: DatabaseTransaction, input: { businessId: string; sourceKey: string; usageKind: TopUpUsageKind; units: number; drew: boolean; balance: TopUpBalance | null }): Promise<{ topUpQuantity: number; after: TopUpBalance | null }> {
  if (input.units <= 0 && !input.drew) return { topUpQuantity: 0, after: input.balance };
  const drawn = await setTopUpDraw(tx, { businessId: input.businessId, sourceKey: input.sourceKey, usageKind: input.usageKind, units: input.units });
  return { topUpQuantity: Math.min(input.units, drawn.drawn), after: drawn.after };
}

/** Gives `amount` of a kind back from the row's draws, to the top-up drawn on last first. */
async function giveBack(tx: DatabaseTransaction, input: { businessId: string; sourceKey: string; kind: TopUpUsageKind; draws: Array<{ topUpId: string; units: number }>; amount: number }): Promise<void> {
  const rows = await tx.select({ id: billingTopUps.id, used: usedColumns[input.kind] })
    .from(billingTopUps)
    .where(and(eq(billingTopUps.businessId, input.businessId), inArray(billingTopUps.id, input.draws.map((draw) => draw.topUpId))))
    .orderBy(sql`${billingTopUps.endsAt} desc nulls first`, desc(billingTopUps.startsAt), desc(billingTopUps.id))
    .for("update");
  let release = input.amount;
  for (const row of rows) {
    if (release <= 0) break;
    const draw = input.draws.find((entry) => entry.topUpId === row.id);
    const take = Math.min(release, draw?.units ?? 0, row.used);
    if (take <= 0) continue;
    await tx.update(billingTopUps).set({ [kindFields[input.kind].used]: row.used - take, updatedAt: new Date() }).where(eq(billingTopUps.id, row.id));
    await tx.update(billingTopUpDraws).set({ units: sql`${billingTopUpDraws.units} - ${take}`, updatedAt: new Date() }).where(and(eq(billingTopUpDraws.topUpId, row.id), eq(billingTopUpDraws.sourceKey, input.sourceKey)));
    release -= take;
  }
}

// The business's view of its top-ups: Settings > Plan and GET /v1/billing.

/** How many top-ups that no longer count a list shows, newest first, after those that count or will. */
export const LISTED_ENDED_TOP_UPS = 20;

const heldColumns = {
  id: billingTopUps.id,
  source: billingTopUps.source,
  code: billingTopUps.code,
  note: billingTopUps.note,
  offer: billingTopUps.offer,
  amountCents: billingTopUps.amountCents,
  refundedCents: billingTopUps.refundedCents,
  currency: billingTopUps.currency,
  voiceSec: billingTopUps.voiceSec,
  smsSeg: billingTopUps.smsSeg,
  callsOut: billingTopUps.callsOut,
  chatUnits: billingTopUps.chatUnits,
  voiceUsed: billingTopUps.voiceUsed,
  smsUsed: billingTopUps.smsUsed,
  callsUsed: billingTopUps.callsUsed,
  chatUsed: billingTopUps.chatUsed,
  startsAt: billingTopUps.startsAt,
  endsAt: billingTopUps.endsAt,
  status: billingTopUps.status,
  createdAt: billingTopUps.createdAt,
  revokedAt: billingTopUps.revokedAt,
};

type HeldRow = {
  id: string;
  source: string;
  code: string | null;
  note: string | null;
  offer: string | null;
  amountCents: number;
  refundedCents: number;
  currency: string | null;
  voiceSec: number;
  smsSeg: number;
  callsOut: number;
  chatUnits: number;
  voiceUsed: number;
  smsUsed: number;
  callsUsed: number;
  chatUsed: number;
  startsAt: Date;
  endsAt: Date | null;
  status: string;
  createdAt: Date;
  revokedAt: Date | null;
};

/** What a top-up gives, and what uses drew, in the shared shape. */
export function topUpAmounts(row: { voiceSec: number; smsSeg: number; callsOut: number; chatUnits: number }): BillingTopUpAmounts {
  return { voiceSeconds: row.voiceSec, alertSmsSegments: row.smsSeg, outboundCallAttempts: row.callsOut, chatAiUnits: row.chatUnits };
}

function topUpUsed(row: { voiceUsed: number; smsUsed: number; callsUsed: number; chatUsed: number }): BillingTopUpAmounts {
  return { voiceSeconds: row.voiceUsed, alertSmsSegments: row.smsUsed, outboundCallAttempts: row.callsUsed, chatAiUnits: row.chatUsed };
}

function topUpSource(source: string): BillingTopUpSource {
  return source === "code" || source === "purchase" ? source : "grant";
}

/** A top-up as the business sees it. names are those of a purchase's top-up on sale, which the caller joins in; null otherwise. */
export function topUpHolding(row: HeldRow & { names?: Record<string, string> | null }, now = new Date()): BillingTopUpHolding {
  // A partial refund takes its share off what a purchase gives.
  const gives = topUpAmounts(topUpGives(row));
  const used = topUpUsed(row);
  return {
    id: row.id,
    source: topUpSource(row.source),
    code: row.code,
    note: row.note,
    offer: row.offer,
    names: row.names ?? null,
    amountCents: row.amountCents,
    refundedCents: row.refundedCents,
    currency: row.currency?.toLowerCase() ?? null,
    gives,
    used,
    status: billingTopUpStatus({ status: row.status, startsAt: row.startsAt, endsAt: row.endsAt, gives, used }, now),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** The business's top-ups with a purchase's names, which its top-up on sale keeps. */
function selectHeld(tx: DatabaseTransaction) {
  return tx.select({ ...heldColumns, names: billingPackPlans.names }).from(billingTopUps).leftJoin(billingPackPlans, eq(billingPackPlans.code, billingTopUps.offer));
}

/**
 * The business's top-ups as Settings > Plan and the API show them: those that
 * count now or will (active, scheduled and used up) and those a dispute holds
 * (frozen), the one that ends first first, then the latest
 * LISTED_ENDED_TOP_UPS that ended, were refunded or were revoked, newest
 * first. A business that never had one gets an empty list from one indexed
 * read.
 */
export async function listBusinessTopUps(tx: DatabaseTransaction, businessId: string, now = new Date()): Promise<BillingTopUpHolding[]> {
  const open = and(inArray(billingTopUps.status, ["active", "frozen"]), or(isNull(billingTopUps.endsAt), gt(billingTopUps.endsAt, now)));
  const held = await selectHeld(tx)
    .where(and(eq(billingTopUps.businessId, businessId), open))
    .orderBy(sql`${billingTopUps.endsAt} asc nulls last`, asc(billingTopUps.startsAt), asc(billingTopUps.id));
  const ended = await selectHeld(tx)
    .where(and(eq(billingTopUps.businessId, businessId), or(notInArray(billingTopUps.status, ["active", "frozen"]), lte(billingTopUps.endsAt, now))))
    .orderBy(desc(billingTopUps.createdAt), desc(billingTopUps.id)).limit(LISTED_ENDED_TOP_UPS);
  return [...held, ...ended].map((row) => topUpHolding(row, now));
}

/** One of the business's top-ups as the business sees it, or null for one it doesn't have. */
export async function readBusinessTopUp(tx: DatabaseTransaction, businessId: string, topUpId: string, now = new Date()): Promise<BillingTopUpHolding | null> {
  const [row] = await selectHeld(tx).where(and(eq(billingTopUps.businessId, businessId), eq(billingTopUps.id, topUpId))).limit(1);
  return row ? topUpHolding(row, now) : null;
}

function apiTopUpAmounts(amounts: BillingTopUpAmounts): ApiBillingTopUp["gives"] {
  return { voice_seconds: amounts.voiceSeconds, alert_sms_segments: amounts.alertSmsSegments, outbound_call_attempts: amounts.outboundCallAttempts, chat_units: amounts.chatAiUnits };
}

/** A top-up as the v1 API shows it: in GET /billing, and to the operator who grants or revokes it. */
export function serializeBillingTopUp(topUp: BillingTopUpHolding): ApiBillingTopUp {
  return { id: topUp.id, source: topUp.source, code: topUp.code, note: topUp.note, top_up: topUp.offer, amount_cents: topUp.amountCents, refunded_cents: topUp.refundedCents, currency: topUp.currency, gives: apiTopUpAmounts(topUp.gives), used: apiTopUpAmounts(topUp.used), status: topUp.status, starts_at: topUp.startsAt, ends_at: topUp.endsAt, created_at: topUp.createdAt, revoked_at: topUp.revokedAt };
}

// Operator grants (POST /v1/billing/top-ups) and revokes.

/** What a grant gives, how long it lasts and the operator's note, as the API checked them. */
export type TopUpGrant = {
  voiceSec: number;
  smsSeg: number;
  callsOut: number;
  chatUnits: number;
  startsAt: Date;
  endsAt: Date | null;
  note: string | null;
};

/** The operator platform key that grants, for the ledger. */
export type TopUpGrantor = { keyId: string; partner: string };

/** Publishes billing.updated for the business, as other billing changes do. No screen listens for it yet, so Settings > Plan and Usage show the change when they next load the billing summary. */
async function announceTopUp(tx: DatabaseTransaction, businessId: string, topUpId: string, change: "granted" | "revoked" | "added" | "bought" | TopUpChange["status"]): Promise<void> {
  await enqueueOutbox(tx, { topic: "realtime.publish", businessId, aggregateType: "billing_top_up", aggregateId: topUpId, dedupeKey: `billing-top-up:${topUpId}:${change}`, payload: { type: "billing.updated", entityId: topUpId } });
}

/**
 * Grants the business in the transaction a top-up, as the worker actor of an
 * operator's platform key. Callers check that an operator's key asked and that
 * the grant gives something, and audit it; the v1 API's Idempotency-Key makes
 * a retry return the first grant.
 */
export async function grantTopUpInTransaction(tx: DatabaseTransaction, input: { businessId: string; grantor: TopUpGrantor; grant: TopUpGrant }): Promise<BillingTopUpHolding> {
  const { grant } = input;
  const [row] = await tx.insert(billingTopUps).values({
    businessId: input.businessId,
    source: "grant",
    keyId: input.grantor.keyId,
    partner: input.grantor.partner,
    note: grant.note,
    voiceSec: grant.voiceSec,
    smsSeg: grant.smsSeg,
    callsOut: grant.callsOut,
    chatUnits: grant.chatUnits,
    startsAt: grant.startsAt,
    endsAt: grant.endsAt,
  }).returning(heldColumns);
  if (!row) throw new Error("The top-up could not be recorded.");
  await announceTopUp(tx, input.businessId, row.id, "granted");
  return topUpHolding(row);
}

/**
 * Revokes one of the business's top-ups: what it still holds stops counting at
 * once, and uses it already paid for stay paid. A revoked top-up comes back as
 * it is, with revoked false; null for one the business doesn't have. Takes the
 * top-up lock, so no use draws on it while it is revoked.
 */
export async function revokeTopUpInTransaction(tx: DatabaseTransaction, input: { businessId: string; topUpId: string }): Promise<{ topUp: BillingTopUpHolding; revoked: boolean } | null> {
  await lockBusinessTopUps(tx, input.businessId);
  const [revoked] = await tx.update(billingTopUps).set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(billingTopUps.businessId, input.businessId), eq(billingTopUps.id, input.topUpId), eq(billingTopUps.status, "active")))
    .returning(heldColumns);
  if (revoked) await announceTopUp(tx, input.businessId, revoked.id, "revoked");
  // Read back with a purchase's names.
  const topUp = await readBusinessTopUp(tx, input.businessId, input.topUpId);
  return topUp ? { topUp, revoked: Boolean(revoked) } : null;
}

// Top-up codes, as someone on the team types them under Have a promo code?

type Row = Record<string, unknown>;

const count = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/**
 * What a top-up code adds for the business and the person in the transaction,
 * or null for a code that doesn't work for them, or that is a plan's code:
 * app.billing_top_up_code reads it, so every reason reads the same. One the
 * business or the person already added still comes back, saying so. Callers
 * authorize the person first.
 */
export async function topUpCodeView(tx: DatabaseTransaction, code: string): Promise<BillingTopUpCodeView | null> {
  const normalized = normalizeBillingCode(code);
  if (!isBillingCode(normalized)) return null;
  const [row] = (await tx.execute<Row>(sql`select * from app.billing_top_up_code(${normalized})`)).rows;
  if (!row) return null;
  return {
    kind: "top_up",
    code: String(row.code),
    gives: { voiceSeconds: count(row.voice_sec), alertSmsSegments: count(row.sms_seg), outboundCallAttempts: count(row.calls_out), chatAiUnits: count(row.chat_units) },
    days: row.days === null || row.days === undefined ? null : Number(row.days),
    usedHere: row.used_here === true,
    usedByYou: row.used_by_you === true,
  };
}

/** Why a top-up code added nothing: it doesn't work for the business (invalid), or the business or the person already added it (used). */
export type TopUpCodeRefusal = "invalid" | "used";

const topUpCodeRefusalErrors: Record<TopUpCodeRefusal, { status: number; code: string; message: string }> = {
  invalid: { status: 400, code: "promo_invalid", message: "This code isn't valid." },
  used: { status: 409, code: "promo_used", message: "This code was already added." },
};

/** What the dashboard tells someone whose top-up code added nothing; every reason the code itself fails reads as invalid. */
export function topUpCodeRefusalError(refusal: TopUpCodeRefusal): Error {
  const { message, ...rest } = topUpCodeRefusalErrors[refusal];
  return Object.assign(new Error(message), rest);
}

/**
 * Adds a top-up code's top-up to the business in the transaction for the
 * person in it, at once and without a payment: the new top-up, or why not.
 * app.redeem_billing_top_up_code locks the code, so its last use can't be
 * taken twice. Callers authorize the person and count the try against the
 * promo code limits.
 */
export async function redeemTopUpCodeInTransaction(tx: DatabaseTransaction, input: { businessId: string; userId: string; code: string }): Promise<{ topUp: BillingTopUpHolding } | { refusal: TopUpCodeRefusal }> {
  const normalized = normalizeBillingCode(input.code);
  if (!isBillingCode(normalized)) return { refusal: "invalid" };
  const [redeemed] = (await tx.execute<{ id: string | null }>(sql`select app.redeem_billing_top_up_code(${normalized}) as id`)).rows;
  const topUpId = redeemed?.id ?? null;
  if (!topUpId) {
    const view = await topUpCodeView(tx, normalized);
    return { refusal: view && (view.usedHere || view.usedByYou) ? "used" : "invalid" };
  }
  const [row] = await tx.select(heldColumns).from(billingTopUps).where(and(eq(billingTopUps.businessId, input.businessId), eq(billingTopUps.id, topUpId))).limit(1);
  if (!row) throw new Error("The top-up the code added could not be read.");
  await announceTopUp(tx, input.businessId, row.id, "added");
  await tx.insert(auditLogs).values({ businessId: input.businessId, actorUserId: input.userId, eventType: "billing.top_up_code_redeemed", entityType: "billing_top_up", entityId: row.id, payload: { code: row.code, voiceSec: row.voiceSec, smsSeg: row.smsSeg, callsOut: row.callsOut, chatUnits: row.chatUnits, endsAt: row.endsAt?.toISOString() ?? null } });
  return { topUp: topUpHolding(row) };
}

// Top-ups on sale (0155): a business on Free or on a prepaid pack pays for one
// once through the billing provider, and billing.reconcile adds it here when
// the payment arrives (billingPackEvents.ts). One per payment, so an event
// delivered twice adds nothing. Refunds and disputes change it as they change
// a pack: a partial refund takes its share off what it gives, a whole one ends
// it, and a dispute holds it until it closes.

/** A top-up on sale as its checkout kept it, or the catalog has it: what its payment adds. */
export type TopUpOfferTerms = { code: string; voiceSec: number; smsSeg: number; callsOut: number; chatUnits: number; days: number | null };

/** A payment for a top-up on sale, as the provider's event reports it. */
export type TopUpPurchase = {
  businessId: string;
  offer: TopUpOfferTerms;
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
 * Adds the top-up a payment bought, once: a second delivery of the same
 * payment finds the first's row. What it gives is copied from the terms its
 * checkout kept, and it lasts its days from the payment, as 24-hour days.
 * created says whether this call added it.
 */
export async function recordTopUpPurchaseInTransaction(tx: DatabaseTransaction, purchase: TopUpPurchase): Promise<{ topUpId: string; created: boolean }> {
  await lockBusinessTopUps(tx, purchase.businessId);
  const [inserted] = await tx.insert(billingTopUps).values({
    businessId: purchase.businessId,
    source: "purchase",
    offer: purchase.offer.code,
    priceId: purchase.priceId,
    provider: purchase.provider,
    providerRef: purchase.providerRef,
    transactionId: purchase.transactionId,
    amountCents: Math.max(0, Math.round(purchase.amountCents)),
    currency: purchase.currency.toLowerCase(),
    voiceSec: purchase.offer.voiceSec,
    smsSeg: purchase.offer.smsSeg,
    callsOut: purchase.offer.callsOut,
    chatUnits: purchase.offer.chatUnits,
    startsAt: purchase.paidAt,
    endsAt: topUpEndsAt(purchase.paidAt, purchase.offer.days),
  }).onConflictDoNothing({ target: [billingTopUps.provider, billingTopUps.providerRef] }).returning({ id: billingTopUps.id });
  if (inserted) {
    // Its minutes and length are fixed once a business has bought it, as a pack's are.
    await tx.update(billingPackPlans).set({ frozenAt: sql`coalesce(${billingPackPlans.frozenAt}, now())`, updatedAt: new Date() }).where(eq(billingPackPlans.code, purchase.offer.code));
    await announceTopUp(tx, purchase.businessId, inserted.id, "bought");
    return { topUpId: inserted.id, created: true };
  }
  const [existing] = await tx.select({ id: billingTopUps.id }).from(billingTopUps).where(and(eq(billingTopUps.provider, purchase.provider), eq(billingTopUps.providerRef, purchase.providerRef))).limit(1);
  if (!existing) throw new Error("The top-up's payment could not be read back.");
  return { topUpId: existing.id, created: false };
}

/** A bought top-up's change: its status in the ledger before and after. */
export type TopUpChange = { topUpId: string; status: "active" | "frozen" | "revoked" | "refunded"; previous: "active" | "frozen" | "revoked" | "refunded" };

type PaidTopUp = { id: string; status: TopUpChange["status"]; amountCents: number; refundedCents: number };

function ledgerStatus(status: string): TopUpChange["status"] {
  return status === "frozen" || status === "revoked" || status === "refunded" ? status : "active";
}

async function topUpByPayment(tx: DatabaseTransaction, businessId: string, provider: string, providerRef: string): Promise<PaidTopUp | null> {
  const [row] = await tx.select({ id: billingTopUps.id, status: billingTopUps.status, amountCents: billingTopUps.amountCents, refundedCents: billingTopUps.refundedCents })
    .from(billingTopUps)
    .where(and(eq(billingTopUps.businessId, businessId), eq(billingTopUps.provider, provider), eq(billingTopUps.providerRef, providerRef)))
    .limit(1)
    .for("update");
  return row ? { ...row, status: ledgerStatus(row.status) } : null;
}

const unchanged = (topUp: PaidTopUp): TopUpChange => ({ topUpId: topUp.id, status: topUp.status, previous: topUp.status });

async function changed(tx: DatabaseTransaction, businessId: string, topUp: PaidTopUp, status: TopUpChange["status"]): Promise<TopUpChange> {
  await announceTopUp(tx, businessId, topUp.id, status);
  return { topUpId: topUp.id, status, previous: topUp.status };
}

/**
 * Applies a refund of a top-up's payment: refundedCents is the payment's whole
 * refunded amount so far, as the provider reports it, so a repeated or late
 * event never takes off more. A partial refund takes its share off what the
 * top-up gives; one of the whole payment ends it at once, whatever it still
 * held. A revoked top-up only records the refund. Null when no top-up has the
 * payment.
 */
export async function applyTopUpRefundInTransaction(tx: DatabaseTransaction, input: { businessId: string; provider: "polar" | "stripe"; providerRef: string; refundedCents: number; at: Date }): Promise<TopUpChange | null> {
  await lockBusinessTopUps(tx, input.businessId);
  const topUp = await topUpByPayment(tx, input.businessId, input.provider, input.providerRef);
  if (!topUp) return null;
  const refunded = Math.max(topUp.refundedCents, Math.round(input.refundedCents));
  if (refunded === topUp.refundedCents) return unchanged(topUp);
  if (refunded >= topUp.amountCents && (topUp.status === "active" || topUp.status === "frozen")) {
    await tx.update(billingTopUps).set({ status: "refunded", refundedAt: input.at, refundedCents: refunded, updatedAt: new Date() }).where(eq(billingTopUps.id, topUp.id));
    return await changed(tx, input.businessId, topUp, "refunded");
  }
  await tx.update(billingTopUps).set({ refundedCents: refunded, updatedAt: new Date() }).where(eq(billingTopUps.id, topUp.id));
  await announceTopUp(tx, input.businessId, topUp.id, topUp.status);
  return unchanged(topUp);
}

/**
 * Freezes a live top-up whose payment is disputed: nothing draws on it until
 * the dispute closes. alreadyClosed is asked only once a live top-up is
 * found: when it says the dispute's close was applied before this opening,
 * the top-up stays live.
 */
export async function freezeTopUpInTransaction(tx: DatabaseTransaction, input: { businessId: string; provider: "polar" | "stripe"; providerRef: string; alreadyClosed?: () => Promise<boolean> }): Promise<TopUpChange | null> {
  await lockBusinessTopUps(tx, input.businessId);
  const topUp = await topUpByPayment(tx, input.businessId, input.provider, input.providerRef);
  if (!topUp) return null;
  if (topUp.status !== "active" || (input.alreadyClosed && await input.alreadyClosed())) return unchanged(topUp);
  await tx.update(billingTopUps).set({ status: "frozen", updatedAt: new Date() }).where(eq(billingTopUps.id, topUp.id));
  return await changed(tx, input.businessId, topUp, "frozen");
}

/**
 * Closes a top-up's dispute: won, a frozen top-up counts again until its end;
 * lost, the payment went back, so it ends refunded, also when the dispute's
 * opening never reached LobbyStack and it was still live. A lost dispute of a
 * top-up already refunded or revoked only records the whole payment as
 * refunded.
 */
export async function closeTopUpDisputeInTransaction(tx: DatabaseTransaction, input: { businessId: string; provider: "polar" | "stripe"; providerRef: string; won: boolean; at: Date }): Promise<TopUpChange | null> {
  await lockBusinessTopUps(tx, input.businessId);
  const topUp = await topUpByPayment(tx, input.businessId, input.provider, input.providerRef);
  if (!topUp) return null;
  if (!input.won) {
    if (topUp.status === "refunded" || topUp.status === "revoked") {
      if (topUp.refundedCents < topUp.amountCents) await tx.update(billingTopUps).set({ refundedCents: topUp.amountCents, updatedAt: new Date() }).where(eq(billingTopUps.id, topUp.id));
      return unchanged(topUp);
    }
    await tx.update(billingTopUps).set({ status: "refunded", refundedAt: input.at, refundedCents: topUp.amountCents, updatedAt: new Date() }).where(eq(billingTopUps.id, topUp.id));
    return await changed(tx, input.businessId, topUp, "refunded");
  }
  if (topUp.status !== "frozen") return unchanged(topUp);
  await tx.update(billingTopUps).set({ status: "active", updatedAt: new Date() }).where(eq(billingTopUps.id, topUp.id));
  return await changed(tx, input.businessId, topUp, "active");
}
