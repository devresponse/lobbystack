import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { businesses, enqueueOutbox, onboardingNumberClaimEvents, phoneNumbers, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";

import { requireBusinessAdmin } from "../authz";
import type { DomainContext } from "./context";
import { normalizeOnboardingStage } from "./onboarding";
import { resolveBusinessNumberMarket, type BusinessNumberMarket } from "./phoneNumberMarket";
import { loadBusinessPlanLimits } from "./usage";

export type NumberSelection = { countryCode: "US" | "CA" | "GB" | "AU"; kind: "local" | "toll_free"; areaCode?: string; city?: string; regionCode?: string; postalCode?: string };
export type NumberInventoryProvider = { listAvailablePhoneNumbers(input: NumberSelection & { limit: number }): Promise<Array<{ phoneE164: string; locality?: string; region?: string; countryCode: string; capabilities: { sms: boolean; voice: boolean } }>> };
export type NumberClaimPurpose = "onboarding" | "replacement";
/** A searched number, signed for one person and one business so a claim can trust it. */
export type NumberOffer = { v: 1; purpose: NumberClaimPurpose; businessId: string; userId: string; e164: string; countryCode: string; kind: "local" | "toll_free"; capabilities: { sms: true; voice: true }; selection: NumberSelection; exp: number };
export type NumberSelectionRefusal = "stage" | "replacement_used" | "active_number_required" | "paid_plan_required" | "unsupported_country";

/** A refused number search or claim, with the status and code the dashboard answers it with, so the chooser can say why. */
type NumberRequestError = Error & { status: number; code: string };

function numberRequestError(status: number, code: string, message: string, cause?: unknown): NumberRequestError {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { status, code });
}

/**
 * Why a business can't pick a number now. The API answers each reason with
 * its own status; the dashboard answers with `status` and `code`.
 */
export class NumberSelectionError extends Error {
  readonly reason: NumberSelectionRefusal;
  readonly status: number;
  readonly code: string;

  constructor(message: string, reason: NumberSelectionRefusal) {
    super(message);
    this.name = "NumberSelectionError";
    this.reason = reason;
    this.status = reason === "unsupported_country" ? 400 : 409;
    this.code = reason === "stage" ? "invalid_onboarding_stage" : reason;
  }
}

// What the claim functions raise, as the dashboard answers it. The limits count
// the person's claims in every workspace, failed ones too.
const numberClaimRefusals: Record<string, [status: number, code: string, message: string]> = {
  number_claim_in_progress: [409, "number_claim_in_progress", "Another number for this workspace is still being set up. Wait for it to finish, then try again."],
  replacement_already_reserved: [409, "number_claim_in_progress", "A replacement for this workspace's number is still being set up. Wait for it to finish, then try again."],
  business_number_exists: [409, "business_number_exists", "This workspace already has a phone number."],
  invalid_onboarding_stage: [409, "invalid_onboarding_stage", "Business number selection is not available at this onboarding stage."],
  dedicated_number_requires_paid_plan: [409, "paid_plan_required", "A paid plan is required for a dedicated business number."],
  replacement_already_used: [409, "replacement_used", "This workspace has already used its number replacement."],
  active_number_required: [409, "active_number_required", "An active phone number is required before choosing a replacement."],
  replacement_number_must_differ: [400, "replacement_number_must_differ", "Pick a number other than the one being replaced."],
  number_claim_rate_limited: [429, "number_claim_rate_limited", "You tried 3 numbers in the last hour. Try again later."],
  daily_claim_quota_reached: [429, "daily_claim_quota_reached", "You got 2 numbers in the last 24 hours. Try again tomorrow."],
  monthly_claim_quota_reached: [429, "monthly_claim_quota_reached", "You got 5 numbers in the last 30 days. Try again later."],
};

// Drizzle wraps the PostgreSQL error, and its message lists the query
// parameters. Keep the raised error, which names only the reason, as the cause.
function numberClaimRefusal(error: unknown): NumberRequestError | undefined {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && Object.hasOwn(numberClaimRefusals, message)) {
      const [status, code, text] = numberClaimRefusals[message]!;
      return numberRequestError(status, code, text, current);
    }
  }
  return undefined;
}

// The carrier's own 401 or 403 would read as the person's session, so only its
// refusal of the filters is the person's to fix. Anything else is our failure,
// logged with the carrier's error as the cause.
function numberSearchError(error: unknown): unknown {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status: unknown }).status : undefined;
  if (status === 400) return numberRequestError(400, "number_search_invalid", "The carrier can't search with these filters. Check the area code.", error);
  if (status === 404) return numberRequestError(400, "number_search_unsupported", "The carrier has no numbers of this kind in this country.", error);
  return new Error("The carrier's number search failed.", { cause: error });
}

const offerLifetimeMs = 5 * 60_000;

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function sign(encoded: string, secret: string): string { return createHmac("sha256", secret).update(encoded).digest("base64url"); }
function issueOffer(payload: NumberOffer, secret: string): string { const encoded = encode(payload); return `${encoded}.${sign(encoded, secret)}`; }

/** Reads a signed offer. Throws when the token was not signed with this secret, or has expired. */
export function readNumberOffer(token: string, secret: string): NumberOffer {
  const invalid = () => numberRequestError(400, "number_offer_invalid", "Invalid number claim token.");
  const [encoded, signature, extra] = token.split("."); if (!encoded || !signature || extra) throw invalid();
  const expected = Buffer.from(sign(encoded, secret)); const actual = Buffer.from(signature); if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as NumberOffer;
  if (payload.v !== 1 || !["onboarding", "replacement"].includes(payload.purpose) || !/^\+[1-9]\d{7,14}$/.test(payload.e164) || !payload.capabilities.sms || !payload.capabilities.voice) throw invalid();
  // Offers last five minutes, so a list left open longer has to be searched again.
  if (payload.exp < Date.now()) throw numberRequestError(400, "number_offer_expired", "Number claim token has expired. Search again.");
  return payload;
}

/**
 * Checks that the business may pick a number for this purpose now, and
 * resolves where to search. The dashboard keeps the onboarding stage order;
 * the API ignores it, so it passes enforceStage false.
 */
export async function numberMarketInTransaction(tx: DatabaseTransaction, input: { businessId: string; purpose: NumberClaimPurpose; selection?: Partial<NumberSelection> | undefined; enforceStage: boolean }): Promise<BusinessNumberMarket> {
  const business = (await tx.select({ stage: businesses.onboardingStage, timezone: businesses.timezone, replacementUsedAt: businesses.phoneNumberReplacementUsedAt }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1))[0];
  if (!business) throw new Error("Workspace not found.");
  const onboardingStage = normalizeOnboardingStage(business.stage);
  if (input.enforceStage && input.purpose === "onboarding" && !["plan", "phone_number", "attribution", "complete"].includes(onboardingStage)) throw new NumberSelectionError("Business number selection is not available at this onboarding stage.", "stage");
  if (input.purpose === "replacement") {
    if (business.replacementUsedAt) throw new NumberSelectionError("This workspace has already used its number replacement.", "replacement_used");
    const active = await tx.select({ id: phoneNumbers.id }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, input.businessId), eq(phoneNumbers.status, "active"), isNull(phoneNumbers.reclaimScheduledAt))).limit(1);
    if (!active.length) throw new NumberSelectionError("An active phone number is required before choosing a replacement.", "active_number_required");
  }
  // A plan that includes no number, such as Free, can't pick one.
  if ((await loadBusinessPlanLimits(tx, input.businessId)).limits.includedBusinessNumbers === 0) throw new NumberSelectionError("A paid plan is required for a dedicated business number.", "paid_plan_required");
  const requestedCountry = input.selection?.countryCode?.trim().toUpperCase();
  if (requestedCountry && !["US", "CA", "GB", "AU"].includes(requestedCountry)) throw new NumberSelectionError("Unsupported country.", "unsupported_country");
  return resolveBusinessNumberMarket({ selection: input.selection, timezone: business.timezone });
}

/** Searches the provider in the market and signs an offer for each number, for this person and business only. */
export async function offerBusinessNumbers(input: { businessId: string; userId: string; purpose: NumberClaimPurpose; market: BusinessNumberMarket; selection?: Partial<NumberSelection> | undefined; limit?: number | undefined; claimTokenSecret: string }, provider: NumberInventoryProvider) {
  const countryCode = input.market.countryCode;
  if (!["US", "CA", "GB", "AU"].includes(countryCode)) throw new Error("Unsupported country.");
  const selection: NumberSelection = { countryCode, kind: input.selection?.kind ?? "local", ...(input.selection?.areaCode ? { areaCode: input.selection.areaCode.replace(/\D/g, "") } : {}), ...(input.selection?.city ? { city: input.selection.city.trim() } : {}), ...(input.selection?.regionCode ? { regionCode: input.selection.regionCode.trim() } : {}), ...(input.selection?.postalCode ? { postalCode: input.selection.postalCode.trim() } : {}) };
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 10)));
  const collected: Array<Awaited<ReturnType<NumberInventoryProvider["listAvailablePhoneNumbers"]>>[number] & { selection: NumberSelection }> = [];
  async function collect(search: NumberSelection) {
    const numbers = await provider.listAvailablePhoneNumbers({ ...search, limit });
    collected.push(...numbers.filter(number => number.capabilities.sms && number.capabilities.voice).map(number => ({ ...number, selection: search })));
  }
  await collect(selection);
  const seen = new Set<string>();
  const exp = Date.now() + offerLifetimeMs;
  return collected.filter(number => {
    if (seen.has(number.phoneE164)) return false;
    seen.add(number.phoneE164); return true;
  }).slice(0, limit).map(({ selection: selected, ...number }) => ({ ...number, kind: selected.kind, claimToken: issueOffer({ v: 1, purpose: input.purpose, businessId: input.businessId, userId: input.userId, e164: number.phoneE164, countryCode: number.countryCode, kind: selected.kind, capabilities: { sms: true, voice: true }, selection: selected, exp }, input.claimTokenSecret), expiresAt: new Date(exp) }));
}

export async function searchBusinessNumberInventory(context: DomainContext, input: { userId: string; businessId: string; purpose?: NumberClaimPurpose; selection?: Partial<NumberSelection>; limit?: number; claimTokenSecret: string }, provider: NumberInventoryProvider) {
  const purpose = input.purpose ?? "onboarding";
  const market = await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    return await numberMarketInTransaction(tx, { businessId: input.businessId, purpose, selection: input.selection, enforceStage: true });
  });
  let numbers: Awaited<ReturnType<typeof offerBusinessNumbers>>;
  try {
    numbers = await offerBusinessNumbers({ businessId: input.businessId, userId: input.userId, purpose, market, selection: input.selection, limit: input.limit, claimTokenSecret: input.claimTokenSecret }, provider);
  } catch (error) {
    throw numberSearchError(error);
  }
  return { market, numbers };
}

export async function searchAvailableBusinessNumbers(...args: Parameters<typeof searchBusinessNumberInventory>) {
  return (await searchBusinessNumberInventory(...args)).numbers;
}

export async function reserveOnboardingNumberClaim(context: DomainContext, input: { userId: string; businessId: string; claimToken: string; claimTokenSecret: string; idempotencyKey: string }): Promise<string> {
  const offer = readNumberOffer(input.claimToken, input.claimTokenSecret);
  if (offer.purpose !== "onboarding" || offer.businessId !== input.businessId || offer.userId !== input.userId) throw numberRequestError(400, "number_offer_mismatch", "Number claim token does not belong to this onboarding flow.");
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const tokenHash = createHash("sha256").update(input.claimToken).digest("hex");
    const result = await tx.execute(sql`SELECT app.reserve_onboarding_number_claim(${input.businessId}::uuid, ${input.userId}::uuid, ${offer.e164}, ${JSON.stringify(offer.selection)}::jsonb, ${tokenHash}, ${input.idempotencyKey}) AS id`);
    const claimId = String((result.rows[0] as { id?: unknown } | undefined)?.id ?? ""); if (!claimId) throw new Error("Number claim could not be reserved.");
    await enqueueOutbox(tx, { topic: "phoneNumber.provision", businessId: input.businessId, aggregateType: "number_claim", aggregateId: claimId, dedupeKey: `phone-claim:${claimId}:provision`, payload: { claimId } });
    return claimId;
  }).catch((error: unknown) => { throw numberClaimRefusal(error) ?? error; });
}

export async function reserveReplacementNumberClaim(context: DomainContext, input: { userId: string; businessId: string; claimToken: string; claimTokenSecret: string; idempotencyKey: string }): Promise<string> {
  const offer = readNumberOffer(input.claimToken, input.claimTokenSecret);
  if (offer.purpose !== "replacement" || offer.businessId !== input.businessId || offer.userId !== input.userId) throw numberRequestError(400, "number_offer_mismatch", "Number claim token does not belong to this replacement flow.");
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const tokenHash = createHash("sha256").update(input.claimToken).digest("hex");
    const result = await tx.execute(sql`SELECT app.reserve_replacement_number_claim(${input.businessId}::uuid, ${input.userId}::uuid, ${offer.e164}, ${JSON.stringify(offer.selection)}::jsonb, ${tokenHash}, ${input.idempotencyKey}) AS id`);
    const claimId = String((result.rows[0] as { id?: unknown } | undefined)?.id ?? "");
    if (!claimId) throw new Error("Number replacement could not be reserved.");
    await enqueueOutbox(tx, { topic: "phoneNumber.provision", businessId: input.businessId, aggregateType: "number_claim", aggregateId: claimId, dedupeKey: `phone-claim:${claimId}:provision`, payload: { claimId } });
    return claimId;
  }).catch((error: unknown) => { throw numberClaimRefusal(error) ?? error; });
}

/** The lock every number claim for the business takes, so claims and releases take turns. Keyed as the claim functions key it. */
export async function lockBusinessNumberClaims(tx: DatabaseTransaction, businessId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('phone-claim:' || ${businessId}::uuid::text, 0))`);
}

/**
 * Fails the business's claims that no worker will finish, by the ages the
 * claim functions apply before a new claim: a reservation not taken up within
 * 15 minutes, and provisioning with no progress for 30. The worker skips a
 * failed claim, so none is bought late. Reading a claim through the API
 * applies this too, so polling a claim always ends.
 */
export async function expireAbandonedNumberClaimsInTransaction(tx: DatabaseTransaction, businessId: string): Promise<void> {
  const claims = onboardingNumberClaimEvents;
  const abandoned = or(and(eq(claims.status, "reserved"), lte(claims.reservedAt, sql`now() - interval '15 minutes'`)), and(eq(claims.status, "provisioning"), lte(claims.updatedAt, sql`now() - interval '30 minutes'`)));
  const expired: Array<{ id: string; purpose: string }> = [];
  for (const [purpose, message] of [["onboarding", "Number claim reservation expired."], ["replacement", "Number replacement reservation expired."]] as const) {
    expired.push(...await tx.update(claims)
      .set({ status: "failed", completedAt: sql`now()`, lastError: sql`CASE WHEN ${claims.status} = 'reserved' THEN ${message}::text ELSE 'Number provisioning stalled.' END`, updatedAt: sql`now()` })
      .where(and(eq(claims.businessId, businessId), eq(claims.purpose, purpose), abandoned))
      .returning({ id: claims.id, purpose: claims.purpose }));
  }
  // Then what failNumberProvisioning does after a failed purchase: a new
  // number's business goes back to picking one, and a replacement frees its reservation.
  if (expired.some((claim) => claim.purpose === "onboarding")) await tx.update(businesses).set({ onboardingStage: "phone_number", updatedAt: new Date() }).where(and(eq(businesses.id, businessId), eq(businesses.onboardingStage, "phone_number_claiming")));
  for (const claim of expired.filter((claim) => claim.purpose === "replacement")) {
    await tx.update(businesses).set({ phoneNumberReplacementReservedAt: null, updatedAt: new Date() }).where(and(eq(businesses.id, businessId), sql`${businesses.phoneNumberReplacementReservedAt} = (SELECT reserved_at FROM onboarding_number_claim_events WHERE id = ${claim.id}::uuid)`));
  }
}

/**
 * Reserves a number for an API caller and queues its purchase, inside the
 * caller's worker transaction. The caller has checked the offer. A platform
 * key's claim quotas count the business's claims rather than its account's.
 */
export async function reserveApiNumberClaimInTransaction(tx: DatabaseTransaction, input: { businessId: string; userId: string; offer: NumberOffer; claimToken: string; replacingPhoneNumberId: string | null; quotaByBusiness: boolean; requestKey: string }): Promise<string> {
  const tokenHash = createHash("sha256").update(input.claimToken).digest("hex");
  const result = await tx.execute(sql`SELECT app.reserve_api_number_claim(${input.businessId}::uuid, ${input.userId}::uuid, ${input.offer.purpose}::text, ${input.replacingPhoneNumberId}::uuid, ${input.offer.e164}::text, ${JSON.stringify(input.offer.selection)}::jsonb, ${tokenHash}::text, ${input.requestKey}::text, ${input.quotaByBusiness}::boolean) AS id`);
  const claimId = String((result.rows[0] as { id?: unknown } | undefined)?.id ?? "");
  if (!claimId) throw new Error("Number claim could not be reserved.");
  await enqueueOutbox(tx, { topic: "phoneNumber.provision", businessId: input.businessId, aggregateType: "number_claim", aggregateId: claimId, dedupeKey: `phone-claim:${claimId}:provision`, payload: { claimId } });
  return claimId;
}

export async function getOnboardingNumberClaim(context: DomainContext, input: { userId: string; businessId: string; claimId: string }) {
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => { await requireBusinessAdmin(tx, input); return (await tx.select({ id: onboardingNumberClaimEvents.id, purpose: onboardingNumberClaimEvents.purpose, status: onboardingNumberClaimEvents.status, requestedE164: onboardingNumberClaimEvents.requestedE164, phoneNumberId: onboardingNumberClaimEvents.phoneNumberId, lastError: onboardingNumberClaimEvents.lastError }).from(onboardingNumberClaimEvents).where(and(eq(onboardingNumberClaimEvents.id, input.claimId), eq(onboardingNumberClaimEvents.businessId, input.businessId), eq(onboardingNumberClaimEvents.userId, input.userId))).limit(1))[0] ?? null; });
}

const numberProvisioningLeaseMs = 10 * 60_000;

export async function claimNumberProvisioning(context: DomainContext, input: { businessId: string; claimId: string }) {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => (await tx.update(onboardingNumberClaimEvents).set({ status: "provisioning", attemptCount: sql`${onboardingNumberClaimEvents.attemptCount} + 1`, updatedAt: new Date() }).where(and(eq(onboardingNumberClaimEvents.id, input.claimId), eq(onboardingNumberClaimEvents.businessId, input.businessId), or(eq(onboardingNumberClaimEvents.status, "reserved"), and(eq(onboardingNumberClaimEvents.status, "provisioning"), lt(onboardingNumberClaimEvents.updatedAt, new Date(Date.now() - numberProvisioningLeaseMs)))))).returning({ id: onboardingNumberClaimEvents.id, e164: onboardingNumberClaimEvents.requestedE164 }))[0] ?? null);
}

/** When a claim another attempt holds becomes reclaimable, or null when no attempt holds it. */
export async function numberProvisioningLeaseEndsAt(context: DomainContext, input: { businessId: string; claimId: string }): Promise<Date | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select({ updatedAt: onboardingNumberClaimEvents.updatedAt }).from(onboardingNumberClaimEvents).where(and(eq(onboardingNumberClaimEvents.id, input.claimId), eq(onboardingNumberClaimEvents.businessId, input.businessId), eq(onboardingNumberClaimEvents.status, "provisioning"))).limit(1))[0];
    return row ? new Date(row.updatedAt.getTime() + numberProvisioningLeaseMs) : null;
  });
}

export async function completeNumberProvisioning(context: DomainContext, input: { businessId: string; claimId: string; e164: string; providerPhoneId: string; voiceUrl: string; smsUrl: string }): Promise<string> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const existing = (await tx.select({ id: phoneNumbers.id }).from(phoneNumbers).where(eq(phoneNumbers.providerPhoneId, input.providerPhoneId)).limit(1))[0];
    const [number] = existing ? [existing] : await tx.insert(phoneNumbers).values({ businessId: input.businessId, e164: input.e164, providerPhoneId: input.providerPhoneId, status: "active", voiceEnabled: true, smsEnabled: true, voiceWebhookStatus: "synced", voiceWebhookTargetUrl: input.voiceUrl, voiceWebhookLastSyncedAt: new Date(), smsWebhookStatus: "synced", smsWebhookTargetUrl: input.smsUrl, smsWebhookLastSyncedAt: new Date() }).returning({ id: phoneNumbers.id });
    if (!number) throw new Error("Provisioned number could not be persisted.");
    const claim = (await tx.update(onboardingNumberClaimEvents).set({ status: "claimed", phoneNumberId: number.id, providerPhoneId: input.providerPhoneId, purchasedAt: new Date(), completedAt: new Date(), updatedAt: new Date() }).where(and(eq(onboardingNumberClaimEvents.id, input.claimId), eq(onboardingNumberClaimEvents.businessId, input.businessId), eq(onboardingNumberClaimEvents.status, "provisioning"))).returning({ purpose: onboardingNumberClaimEvents.purpose, replacingPhoneNumberId: onboardingNumberClaimEvents.replacingPhoneNumberId }))[0];
    if (!claim) throw new Error("Number claim is no longer awaiting provisioning.");
    if (claim.purpose === "replacement") {
      if (!claim.replacingPhoneNumberId) throw new Error("Replacement claim has no previous phone number.");
      const retired = await tx.update(phoneNumbers).set({ reclaimScheduledAt: sql`now() + interval '30 days'`, reclaimReason: "replacement", updatedAt: new Date() }).where(and(eq(phoneNumbers.id, claim.replacingPhoneNumberId), eq(phoneNumbers.businessId, input.businessId), eq(phoneNumbers.status, "active"), isNull(phoneNumbers.reclaimScheduledAt))).returning({ id: phoneNumbers.id });
      const business = await tx.update(businesses).set({ phoneNumberReplacementReservedAt: null, phoneNumberReplacementUsedAt: new Date(), updatedAt: new Date() }).where(and(eq(businesses.id, input.businessId), isNull(businesses.phoneNumberReplacementUsedAt), sql`${businesses.phoneNumberReplacementReservedAt} = (SELECT reserved_at FROM onboarding_number_claim_events WHERE id = ${input.claimId}::uuid)`)).returning({ id: businesses.id });
      if (!retired.length || !business.length) throw new Error("Number replacement entitlement is no longer valid.");
    } else {
      await tx.update(businesses).set({ onboardingStage: sql`CASE WHEN ${businesses.onboardingStage} = 'complete' THEN 'complete' ELSE 'attribution' END`, updatedAt: new Date() }).where(eq(businesses.id, input.businessId));
    }
    // The receptionist's snapshot names the number it gives out, and the website widget offers calls from the browser only while it names one.
    await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "phone_number", aggregateId: number.id, dedupeKey: `phone-number:${number.id}:snapshot:added`, payload: { businessId: input.businessId, reason: "phone_number_added" } });
    return number.id;
  });
}

/** Ends a claim no attempt will finish. A claim already claimed, failed or unavailable stays as it is. */
export async function failNumberProvisioning(context: DomainContext, input: { businessId: string; claimId: string; unavailable: boolean; error?: string }): Promise<void> {
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const claim = (await tx.update(onboardingNumberClaimEvents).set({ status: input.unavailable ? "unavailable" : "failed", lastError: input.error ?? (input.unavailable ? "The selected number is no longer available." : "Number provisioning failed."), completedAt: new Date(), updatedAt: new Date() }).where(and(eq(onboardingNumberClaimEvents.id, input.claimId), eq(onboardingNumberClaimEvents.businessId, input.businessId), inArray(onboardingNumberClaimEvents.status, ["reserved", "provisioning"]))).returning({ purpose: onboardingNumberClaimEvents.purpose }))[0];
    if (claim?.purpose === "replacement") await tx.update(businesses).set({ phoneNumberReplacementReservedAt: null, updatedAt: new Date() }).where(and(eq(businesses.id, input.businessId), sql`${businesses.phoneNumberReplacementReservedAt} = (SELECT reserved_at FROM onboarding_number_claim_events WHERE id = ${input.claimId}::uuid)`));
    else if (claim) await tx.update(businesses).set({ onboardingStage: sql`CASE WHEN ${businesses.onboardingStage} IN ('attribution', 'complete') THEN ${businesses.onboardingStage} ELSE 'phone_number' END`, updatedAt: new Date() }).where(eq(businesses.id, input.businessId));
  });
}

export async function skipOnboardingNumber(context: DomainContext, input: { userId: string; businessId: string }): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => { await requireBusinessAdmin(tx, input); const changed = await tx.update(businesses).set({ onboardingStage: "attribution", updatedAt: new Date() }).where(and(eq(businesses.id, input.businessId), or(eq(businesses.onboardingStage, "plan"), eq(businesses.onboardingStage, "phone_number")))).returning({ id: businesses.id }); if (!changed.length) { const [business] = await tx.select({ stage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, input.businessId)); if (!["attribution", "complete"].includes(business?.stage ?? "")) throw new Error("Number selection cannot be skipped at this onboarding stage."); } });
}
