import { randomInt } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import {
  allowancesAboveTier,
  BILLING_CODE_ALPHABET,
  billingCodePrefix,
  billingPlanIncluded,
  discountedCents,
  isBillingCode,
  isUuid,
  liveSubscriptionStates,
  normalizeBillingCode,
  type ApiBillingCode,
  type ApiBillingCodeCreate,
  type BillingCodeView,
  type BillingPromoPlanView,
  type BillingInterval,
  type BillingPlanOffer,
  type HostedCheckoutPlanSlug,
  type ResolvedBillingDiscount,
} from "@lobbystack/shared";

import type { BillingCatalogCaller } from "./billingCatalog";
import { readBillingPlanLimits } from "./billingPlans";
import type { DomainContext } from "./context";
import { PublicApiError, conflict, invalidRequest, notFound } from "./publicApi/errors";
import { idempotencyRequestHash } from "./publicApi/idempotency";
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from "./publicApi/resources";

// Promo codes (migration 0109). An operator's platform key issues a code for a
// plan whose access is code in billing.json, and a business that types it buys
// that plan through Polar with the plan's discount. The checkout carries the
// code; Polar's webhook puts the business on the plan and counts the use
// (billing.ts). A code that doesn't work, for whatever reason, finds nothing,
// so whoever typed it learns only that it isn't valid.

type Row = Record<string, unknown>;

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** What a code unlocks for one business: its plan, the discount and every live price, with the Polar objects that sell them. */
export type BillingCodeOffer = {
  codeId: string;
  /** The code as stored. */
  code: string;
  plan: string;
  tier: HostedCheckoutPlanSlug;
  names: Record<string, string>;
  discount: ResolvedBillingDiscount | null;
  polarDiscountId: string | null;
  currency: string;
  prices: Array<{ interval: BillingInterval; cents: number; perMonth: number; polarId: string | null }>;
  /** What the plan includes each month. */
  included: BillingPlanOffer["included"];
};

/**
 * The offer a code unlocks for the business in the transaction, or null for a
 * code that doesn't work for it: unknown, revoked, expired, used up, bound to
 * another business, or for a plan that isn't on sale. Callers authorize the
 * business first.
 */
export async function findBillingCodeOffer(tx: DatabaseTransaction, code: string): Promise<BillingCodeOffer | null> {
  const normalized = normalizeBillingCode(code);
  if (!isBillingCode(normalized)) return null;
  const rows = (await tx.execute<Row>(sql`select * from app.billing_code_offers(${normalized})`)).rows;
  const first = rows[0];
  // billing.json lets a plan other than the standard ones behave only as Starter or Pro.
  if (!first || (first.tier !== "starter" && first.tier !== "pro")) return null;
  return {
    codeId: String(first.code_id),
    code: normalized,
    plan: String(first.plan),
    tier: first.tier,
    names: (first.names ?? {}) as Record<string, string>,
    discount: (first.discount ?? null) as ResolvedBillingDiscount | null,
    polarDiscountId: textOrNull(first.polar_disc),
    currency: String(first.currency),
    prices: rows.map((row) => ({ interval: row.period as BillingInterval, cents: Number(row.cents), perMonth: Number(row.per_month), polarId: textOrNull(row.polar_id) })),
    included: {
      voiceSeconds: numberOrNull(first.voice_sec),
      alertSmsSegments: numberOrNull(first.sms_seg),
      outboundCallAttempts: numberOrNull(first.calls_out),
      chatAiUnits: numberOrNull(first.chat_units),
      // bigint arrives as text.
      knowledgeStorageBytes: numberOrNull(first.kb_bytes),
      businessNumbers: numberOrNull(first.numbers),
    },
  };
}

/** Why a business can't check out with a code. invalid covers every reason the code itself doesn't work. */
export type BillingCodeRefusal = "invalid" | "current" | "interval";

/**
 * The plan a code sells the business, at an interval Polar sells it: the
 * offer, or why not. A business already paying for that plan has nothing to
 * buy.
 */
export async function billingCodeCheckout(tx: DatabaseTransaction, input: { businessId: string; code: string; billingInterval: BillingInterval }): Promise<{ offer: BillingCodeOffer } | { refusal: BillingCodeRefusal }> {
  const offer = await findBillingCodeOffer(tx, input.code);
  if (!offer) return { refusal: "invalid" };
  if (await paysForPlan(tx, input.businessId, offer.plan)) return { refusal: "current" };
  if (!offer.prices.some((price) => price.interval === input.billingInterval && price.polarId)) return { refusal: "interval" };
  return { offer };
}

async function paysForPlan(tx: DatabaseTransaction, businessId: string, plan: string): Promise<boolean> {
  const [account] = (await tx.execute<Row>(sql`select plan_code, subscription_state from public.billing_accounts where business_id = ${businessId}::uuid`)).rows;
  return account?.plan_code === plan && (liveSubscriptionStates as readonly string[]).includes(String(account.subscription_state));
}

/**
 * What the dashboard shows for a code the business entered, or null for one
 * that doesn't work. A price can be bought when this deployment sells through
 * Polar (checkout) and Polar sells that price.
 */
export async function billingCodeView(tx: DatabaseTransaction, input: { businessId: string; code: string; checkout: boolean }): Promise<BillingCodeView | null> {
  const offer = await findBillingCodeOffer(tx, input.code);
  if (!offer) return null;
  const tier = billingPlanIncluded((await readBillingPlanLimits(tx))[offer.tier]);
  return {
    code: offer.code,
    plan: offer.plan,
    tier: offer.tier,
    names: offer.names,
    discount: offer.discount,
    currency: offer.currency,
    current: await paysForPlan(tx, input.businessId, offer.plan),
    prices: offer.prices.map((price) => ({ interval: price.interval, cents: price.cents, discountedCents: discountedCents(price.cents, offer.discount), checkoutAvailable: input.checkout && price.polarId !== null })),
    included: offer.included,
    moreThanTier: allowancesAboveTier(offer.included, tier),
  };
}

/**
 * The plan other than a standard one that the business is on, as its own
 * policies let it read it, or null. Read from the tables rather than the
 * offers view, so a plan that has since been retired still shows.
 */
export async function loadBusinessPromoPlan(tx: DatabaseTransaction, businessId: string): Promise<BillingPromoPlanView | null> {
  const rows = (await tx.execute<Row>(sql`
    select p.code, p.tier, p.names, p.discount, a.plan_ends, r.period, r.currency, r.cents, r.per_month
    from public.billing_accounts a
    join public.billing_plans p on p.code = a.plan_code
    left join public.billing_prices r on r.plan = p.code and r.retired_at is null
    where a.business_id = ${businessId}::uuid
    order by r.period`)).rows;
  const first = rows[0];
  if (!first || (first.tier !== "starter" && first.tier !== "pro")) return null;
  return {
    plan: String(first.code),
    tier: first.tier,
    names: (first.names ?? {}) as Record<string, string>,
    discount: (first.discount ?? null) as ResolvedBillingDiscount | null,
    currency: textOrNull(first.currency),
    ends: isoOrNull(first.plan_ends),
    prices: rows.filter((row) => row.period !== null).map((row) => ({ interval: row.period as BillingInterval, cents: Number(row.cents), perMonth: Number(row.per_month) })),
  };
}

/** The link an operator sends: sign-up with the code filled in. Someone signed in goes on to Settings > Plan. */
export function billingCodeLink(baseUrl: string, code: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/signup?promo=${encodeURIComponent(code)}`;
}

function codeResource(row: Row, baseUrl: string): ApiBillingCode {
  const expiresAt = isoOrNull(row.expires_at);
  const maxUses = numberOrNull(row.max_uses);
  const uses = Number(row.uses);
  const status = row.status === "revoked" ? "revoked" : expiresAt !== null && Date.parse(expiresAt) <= Date.now() ? "expired" : maxUses !== null && uses >= maxUses ? "used_up" : "active";
  return {
    id: String(row.id),
    code: String(row.code),
    plan: String(row.plan),
    business_id: textOrNull(row.business_id),
    max_uses: maxUses,
    uses,
    expires_at: expiresAt,
    status,
    note: textOrNull(row.note),
    link: billingCodeLink(baseUrl, String(row.code)),
    key_id: String(row.key_id),
    partner: String(row.partner),
    created_at: iso(row.created_at),
    revoked_at: isoOrNull(row.revoked_at),
  };
}

/** Two groups of four from an alphabet without look-alikes: 31^8, about 850 billion codes per prefix. */
function madeUpCode(prefix: string): string {
  const group = () => Array.from({ length: 4 }, () => BILLING_CODE_ALPHABET[randomInt(BILLING_CODE_ALPHABET.length)]).join("");
  return `${prefix}-${group()}-${group()}`;
}

function pgErrorCode(error: unknown): string | undefined {
  const cause = typeof error === "object" && error !== null && "cause" in error ? (error as { cause: unknown }).cause : undefined;
  for (const value of [error, cause]) {
    if (typeof value === "object" && value !== null && "code" in value && typeof (value as { code: unknown }).code === "string") return (value as { code: string }).code;
  }
  return undefined;
}

/**
 * Issues a code for a plan whose access is code. With an Idempotency-Key, the
 * same key and request return the code it made, and the same key with another
 * request is a 422. A code typed by the operator that is taken is a 409.
 */
export async function createBillingCodeForApi(context: DomainContext, input: { caller: BillingCatalogCaller; idempotencyKey: string | null; body: ApiBillingCodeCreate; brandName: string; baseUrl: string }): Promise<{ code: ApiBillingCode; replayed: boolean }> {
  const { body, caller } = input;
  const chosen = body.code === undefined ? null : normalizeBillingCode(body.code);
  if (chosen !== null && !isBillingCode(chosen)) throw invalidRequest("code must be 4 to 32 letters and digits, in groups joined by single hyphens.", [{ path: "code", message: "4 to 32 letters and digits, in groups joined by single hyphens." }]);
  const expiresAt = body.expires_at === undefined ? null : new Date(body.expires_at);
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw invalidRequest("expires_at must be in the future.", [{ path: "expires_at", message: "Must be in the future." }]);
  // A bound code is single use unless the operator says otherwise; a shared one always names its limit.
  const maxUses = body.max_uses ?? (body.business_id ? 1 : null);
  const prefix = body.prefix?.toUpperCase() ?? billingCodePrefix(input.brandName);
  const requestHash = input.idempotencyKey ? idempotencyRequestHash({ operation: "createBillingCode", ...body }) : null;

  return await withBusinessTransaction(context.db, { actorType: "worker" }, async (tx) => {
    if (input.idempotencyKey) {
      // One request per key at a time, so a retry racing the first can't issue a second code.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing-code:${caller.platformKeyId}:${input.idempotencyKey}`}, 0))`);
      const [reused] = (await tx.execute<Row>(sql`select * from public.billing_codes where key_id = ${caller.platformKeyId}::uuid and idem_key = ${input.idempotencyKey}`)).rows;
      if (reused) {
        if (reused.req_hash !== requestHash) throw new PublicApiError(422, "idempotency_key_reused", "This Idempotency-Key was used with a different request.");
        return { code: codeResource(reused, input.baseUrl), replayed: true };
      }
    }
    const [plan] = (await tx.execute<Row>(sql`select access, status from public.billing_plans where code = ${body.plan}`)).rows;
    if (!plan) throw invalidRequest(`No plan has the code ${body.plan}. Apply a billing.json that has it first.`, [{ path: "plan", message: "No such plan." }]);
    if (plan.access !== "code") throw conflict(`${body.plan} isn't a promo plan: its access is ${String(plan.access)}. A promo code unlocks a plan whose access is code in billing.json.`);
    if (plan.status === "retired") throw conflict(`${body.plan} is retired, so no one new may take it.`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = chosen ?? madeUpCode(prefix);
      let row: Row | undefined;
      try {
        [row] = (await tx.execute<Row>(sql`
          insert into public.billing_codes (code, plan, business_id, max_uses, expires_at, note, key_id, partner, idem_key, req_hash)
          values (${code}, ${body.plan}, ${body.business_id ?? null}, ${maxUses}, ${expiresAt?.toISOString() ?? null}, ${body.note || null}, ${caller.platformKeyId}::uuid, ${caller.partnerId}, ${input.idempotencyKey}, ${requestHash})
          on conflict (code) do nothing
          returning *`)).rows;
      } catch (error) {
        if (pgErrorCode(error) === "23503") throw notFound("Business");
        throw error;
      }
      if (row) return { code: codeResource(row, input.baseUrl), replayed: false };
      if (chosen !== null) throw conflict(`The code ${chosen} is taken. Choose another.`);
    }
    throw new Error("No free promo code was found in five tries.");
  });
}

/** Every code, newest first, of one plan or bound to one business when asked. */
export async function listBillingCodesForApi(context: DomainContext, input: PageRequest & { plan?: string | undefined; businessId?: string | undefined; baseUrl: string }): Promise<Page<ApiBillingCode>> {
  const limit = pageSize(input.limit);
  const cursor = decodeCursor(input.cursor);
  if (input.businessId !== undefined && !isUuid(input.businessId)) throw invalidRequest("business_id must be a business id.", [{ path: "business_id", message: "Must be a UUID." }]);
  const conditions: SQL[] = [];
  if (input.plan !== undefined) conditions.push(sql`plan = ${input.plan}`);
  if (input.businessId !== undefined) conditions.push(sql`business_id = ${input.businessId}::uuid`);
  // Codes are issued to the millisecond, as the cursor carries them, so the comparison is exact.
  if (cursor) conditions.push(sql`(created_at, id) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`);
  const where = conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;
  const rows = await withBusinessTransaction(context.db, { actorType: "worker" }, async (tx) => (await tx.execute<Row>(sql`select * from public.billing_codes ${where} order by created_at desc, id desc limit ${limit + 1}`)).rows, { accessMode: "read only" });
  return toPage(rows, limit, (row) => codeResource(row, input.baseUrl), (row) => ({ at: new Date(iso(row.created_at)), id: String(row.id) }));
}

/** Revokes a code, so no new checkout can use it; businesses on its plan keep it. A revoked code is returned as it is. */
export async function revokeBillingCodeForApi(context: DomainContext, input: { codeId: string; baseUrl: string }): Promise<ApiBillingCode> {
  return await withBusinessTransaction(context.db, { actorType: "worker" }, async (tx) => {
    const [revoked] = (await tx.execute<Row>(sql`update public.billing_codes set status = 'revoked', revoked_at = now(), updated_at = now() where id = ${input.codeId}::uuid and status = 'active' returning *`)).rows;
    const row = revoked ?? (await tx.execute<Row>(sql`select * from public.billing_codes where id = ${input.codeId}::uuid`)).rows[0];
    if (!row) throw notFound("Promo code");
    return codeResource(row, input.baseUrl);
  });
}
