import { billingProviderNames, billingProviderOf, TOP_UP_MAX_DAYS, TOP_UP_MAX_START_DAYS, topUpEndsAt, type ApiBilling, type ApiBillingTopUp, type ApiBillingTopUpCreate } from "@lobbystack/shared";

import { endManagedPlanInTransaction, setManagedPlanInTransaction } from "../billing";
import { endPromoPlanInTransaction } from "../billingPromoEnd";
import { grantTopUpInTransaction, revokeTopUpInTransaction, serializeBillingTopUp } from "../billingTopUps";
import type { DomainContext } from "../context";
import { conflict, invalidRequest, notFound, PublicApiError } from "./errors";
import { audit, inBusiness, loadBilling, type ApiCaller } from "./operations";

// The billing changes only an operator's platform key makes, one with access to
// every business: the managed plan, a promo plan's end, and top-ups. The v1
// routes check that such a key asked before they call these.

/** Puts the business on the managed enterprise plan. Callers check that an operator's platform key asked. */
export async function setManagedPlanForApi(context: DomainContext, caller: ApiCaller): Promise<ApiBilling> {
  return await inBusiness(context, caller, async (tx) => {
    const outcome = await setManagedPlanInTransaction(tx, { businessId: caller.businessId });
    if (outcome === "paid_through_provider") throw conflict(`This business pays through ${billingProviderNames[billingProviderOf(process.env)]}. Cancel that subscription before giving it a managed plan.`);
    if (outcome === "set") await audit(tx, caller, { eventType: "api.billing.managed_plan_set", entityType: "billing_account", entityId: caller.businessId, payload: { plan: "enterprise" } });
    return await loadBilling(tx, caller.businessId);
  });
}

/** Moves the business off its managed plan, back to the free plan. Callers check that an operator's platform key asked. */
export async function endManagedPlanForApi(context: DomainContext, caller: ApiCaller): Promise<ApiBilling> {
  return await inBusiness(context, caller, async (tx) => {
    if (!await endManagedPlanInTransaction(tx, { businessId: caller.businessId })) throw notFound("Managed plan");
    await audit(tx, caller, { eventType: "api.billing.managed_plan_ended", entityType: "billing_account", entityId: caller.businessId });
    return await loadBilling(tx, caller.businessId);
  });
}

/** Ends the business's promo plan at its next renewal. Callers check that an operator's platform key asked. */
export async function endPromoPlanForApi(context: DomainContext, caller: ApiCaller): Promise<ApiBilling> {
  return await inBusiness(context, caller, async (tx) => {
    const ended = await endPromoPlanInTransaction(tx, { businessId: caller.businessId });
    if (!ended) throw notFound("Promo plan");
    await audit(tx, caller, { eventType: "api.billing.promo_plan_ended", entityType: "billing_account", entityId: caller.businessId, payload: { plan: ended.plan, endsWith: ended.ending, planEnds: ended.planEnds.toISOString() } });
    return await loadBilling(tx, caller.businessId);
  });
}

const DAY_MS = 86_400_000;

/**
 * Grants the business a top-up: extra allowances on top of its plan, which
 * stays as it is (billingTopUps.ts). Callers check that an operator's platform
 * key asked. A starts_at already past starts it now, so a clock a little
 * behind the server's isn't refused.
 */
export async function grantTopUpForApi(context: DomainContext, caller: ApiCaller, input: ApiBillingTopUpCreate): Promise<ApiBillingTopUp> {
  if (caller.platformKeyId === undefined) throw new PublicApiError(403, "forbidden", "Only an operator's platform key can grant a top-up.");
  const grantor = { keyId: caller.platformKeyId, partner: caller.partnerId };
  const now = Date.now();
  const startsAt = new Date(Math.max(now, input.starts_at === undefined ? now : Date.parse(input.starts_at)));
  if (startsAt.getTime() > now + TOP_UP_MAX_START_DAYS * DAY_MS) throw invalidRequest(`starts_at must be at most ${TOP_UP_MAX_START_DAYS} days ahead.`, [{ path: "starts_at", message: `At most ${TOP_UP_MAX_START_DAYS} days ahead.` }]);
  const endsAt = input.ends_at === undefined ? topUpEndsAt(startsAt, input.days ?? null) : new Date(input.ends_at);
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) throw invalidRequest("ends_at must be in the future and after starts_at.", [{ path: "ends_at", message: "Must be in the future and after starts_at." }]);
  if (endsAt && endsAt.getTime() - startsAt.getTime() > TOP_UP_MAX_DAYS * DAY_MS) throw invalidRequest(`A top-up lasts at most ${TOP_UP_MAX_DAYS} days.`, [{ path: "ends_at", message: `At most ${TOP_UP_MAX_DAYS} days after starts_at.` }]);
  const grant = { voiceSec: input.voice_seconds ?? 0, smsSeg: input.alert_sms_segments ?? 0, callsOut: input.outbound_call_attempts ?? 0, chatUnits: input.chat_units ?? 0, startsAt, endsAt, note: input.note || null };
  return await inBusiness(context, caller, async (tx) => {
    const topUp = await grantTopUpInTransaction(tx, { businessId: caller.businessId, grantor, grant });
    await audit(tx, caller, { eventType: "api.billing.top_up_granted", entityType: "billing_top_up", entityId: topUp.id, payload: { voiceSec: grant.voiceSec, smsSeg: grant.smsSeg, callsOut: grant.callsOut, chatUnits: grant.chatUnits, startsAt: topUp.startsAt, endsAt: topUp.endsAt } });
    return serializeBillingTopUp(topUp);
  });
}

/** Revokes one of the business's top-ups; a revoked one comes back as it is. Callers check that an operator's platform key asked. */
export async function revokeTopUpForApi(context: DomainContext, caller: ApiCaller, topUpId: string): Promise<ApiBillingTopUp> {
  return await inBusiness(context, caller, async (tx) => {
    const result = await revokeTopUpInTransaction(tx, { businessId: caller.businessId, topUpId });
    if (!result) throw notFound("Top-up");
    if (result.revoked) await audit(tx, caller, { eventType: "api.billing.top_up_revoked", entityType: "billing_top_up", entityId: topUpId, payload: { source: result.topUp.source } });
    return serializeBillingTopUp(result.topUp);
  });
}
