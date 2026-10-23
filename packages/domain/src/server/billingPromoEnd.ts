import { sql } from "drizzle-orm";

import { auditLogs, enqueueOutbox, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { billingPlanName, hostedCheckoutPlanSlugs, normalizeInterfaceLocale, promoPlanEndRenewal, promoPlanEnding, type BillingInterval, type HostedCheckoutPlanSlug, type PromoPlanEnding } from "@lobbystack/shared";

import { isLiveSubscriptionState, lockBillingAccount, MANAGED_BILLING_SOURCE } from "./billing";
import type { DomainContext } from "./context";

// A time-limited plan ends at the subscription's first renewal on or after
// plan_ends, because the period that renewal closes was paid at the plan's
// price. A week before it, the worker tells Polar what the renewal does (move
// to the tier's standard product without the plan's discount, or cancel) and
// emails the business's owners. Once the renewal happens, Polar's webhook
// moves the account off the plan as for any other product change; a canceled
// subscription is no longer live, so its plan stops counting without one.

/** How long before a promo plan ends the owners hear about it and Polar is told. */
export const PROMO_END_NOTICE_MS = 7 * 24 * 60 * 60_000;

/** A billing account's promo columns and its plan's own ending, as the daily check reads them. */
export type PromoEndFacts = {
  plan: string | null;
  planCode: string | null;
  planEnds: Date | null;
  /** billing_plans.ends of planCode: tier, keep or cancel. */
  planEnding: string | null;
  endWith: string | null;
  endNoticeAt: Date | null;
  endSetAt: Date | null;
  source: string | null;
  subscriptionState: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};

export type PromoEndStep =
  | { due: false }
  | {
    due: true;
    ending: PromoPlanEnding;
    /** The renewal that ends the plan, as the account knows it. */
    endsAt: Date;
    /** Polar still needs telling: never told, or told before a renewal that kept the plan anyway. */
    set: boolean;
    notify: boolean;
    /** A renewal passed after Polar was told and the plan is still in force. */
    overdue: boolean;
  };

/** What a promo plan's ending needs now. It is due a week before the renewal that ends it, and at once when an operator ended it. */
export function promoEndStep(facts: PromoEndFacts, now = new Date()): PromoEndStep {
  if (!facts.planCode || facts.planCode === facts.plan || !facts.planEnds) return { due: false };
  if (facts.source === MANAGED_BILLING_SOURCE || !isLiveSubscriptionState(facts.subscriptionState)) return { due: false };
  const ending = promoPlanEnding(facts.endWith, facts.planEnding);
  if (!ending) return { due: false };
  const endsAt = promoPlanEndRenewal(facts.planEnds, facts.currentPeriodEnd);
  const overdue = facts.endSetAt !== null && facts.currentPeriodStart !== null && facts.endSetAt.getTime() < facts.currentPeriodStart.getTime();
  // An operator's end, and one a renewal passed over, are due at once. Without a renewal that reaches the plan's end, so is one whose end has passed.
  const due = facts.endWith !== null || overdue || (endsAt ? endsAt.getTime() - PROMO_END_NOTICE_MS <= now.getTime() : facts.planEnds.getTime() <= now.getTime());
  if (!due) return { due: false };
  return { due: true, ending, endsAt: endsAt && endsAt.getTime() > now.getTime() ? endsAt : facts.planEnds, set: facts.endSetAt === null || overdue, notify: facts.endNoticeAt === null, overdue };
}

/** A due promo ending, with what the worker needs to tell Polar. */
export type PromoEndWork = {
  planCode: string;
  planEnds: Date;
  tier: HostedCheckoutPlanSlug;
  interval: BillingInterval;
  subscriptionId: string;
  ending: PromoPlanEnding;
  endsAt: Date;
  set: boolean;
  notify: boolean;
  overdue: boolean;
};

type AccountRow = {
  plan: string | null; plan_code: string | null; plan_ends: Date | string | null; end_with: string | null; end_notice_at: Date | string | null; end_set_at: Date | string | null;
  source: string | null; subscription_state: string | null; subscription_id: string | null; billing_interval: string | null;
  current_period_start: Date | string | null; current_period_end: Date | string | null; plan_ending: string | null;
};

const dateOrNull = (value: Date | string | null | undefined): Date | null => value === null || value === undefined ? null : value instanceof Date ? value : new Date(value);

async function readPromoAccount(tx: DatabaseTransaction, businessId: string): Promise<AccountRow | undefined> {
  return (await tx.execute<AccountRow>(sql`
    select a.plan, a.plan_code, a.plan_ends, a.end_with, a.end_notice_at, a.end_set_at, a.source, a.subscription_state, a.subscription_id,
      a.billing_interval, a.current_period_start, a.current_period_end, p.ends as plan_ending
    from public.billing_accounts a
    left join public.billing_plans p on p.code = a.plan_code
    where a.business_id = ${businessId}::uuid`)).rows[0];
}

function factsOf(row: AccountRow): PromoEndFacts {
  return {
    plan: row.plan, planCode: row.plan_code, planEnds: dateOrNull(row.plan_ends), planEnding: row.plan_ending, endWith: row.end_with,
    endNoticeAt: dateOrNull(row.end_notice_at), endSetAt: dateOrNull(row.end_set_at), source: row.source, subscriptionState: row.subscription_state,
    currentPeriodStart: dateOrNull(row.current_period_start), currentPeriodEnd: dateOrNull(row.current_period_end),
  };
}

/** The promo ending a business is due for, or null when nothing is due. */
export async function loadPromoEndWork(context: DomainContext, input: { businessId: string; now?: Date }): Promise<PromoEndWork | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = await readPromoAccount(tx, input.businessId);
    if (!row?.plan_code || !row.subscription_id || !(hostedCheckoutPlanSlugs as readonly string[]).includes(row.plan ?? "")) return null;
    const step = promoEndStep(factsOf(row), input.now);
    if (!step.due) return null;
    return {
      planCode: row.plan_code,
      planEnds: dateOrNull(row.plan_ends)!,
      tier: row.plan as HostedCheckoutPlanSlug,
      interval: row.billing_interval === "annual" ? "annual" : "monthly",
      subscriptionId: row.subscription_id,
      ending: step.ending,
      endsAt: step.endsAt,
      set: step.set,
      notify: step.notify,
      overdue: step.overdue,
    };
  });
}

/**
 * Records what the worker did for a due ending: that Polar was told, and the
 * owners' email, which goes once per ending and says what the renewal does:
 * the plan the subscription moves to, or that it ends. A quiet notice sends
 * nothing: the business chose another promo plan for that renewal and saw its
 * terms then. Nothing changes when the account moved on meanwhile, such as
 * onto another plan. Returns the emails queued.
 */
export async function recordPromoEnd(
  context: DomainContext,
  input: { businessId: string; planCode: string; planEnds: Date; set: boolean; notice: { ending: PromoPlanEnding; endsAt: Date; tier: HostedCheckoutPlanSlug; interval: BillingInterval; quiet?: boolean } | null; appUrl: string },
): Promise<number> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    await lockBillingAccount(tx, input.businessId);
    const row = await readPromoAccount(tx, input.businessId);
    if (!row || row.plan_code !== input.planCode || dateOrNull(row.plan_ends)?.getTime() !== input.planEnds.getTime()) return 0;
    if (input.set) {
      await tx.execute(sql`update public.billing_accounts set end_set_at = now(), updated_at = now() where business_id = ${input.businessId}::uuid`);
      await tx.insert(auditLogs).values({ businessId: input.businessId, eventType: "billing.promo_end_set", entityType: "billing_account", entityId: input.businessId, payload: { plan: input.planCode, ending: input.notice?.ending ?? promoPlanEnding(row.end_with, row.plan_ending) } });
    }
    if (!input.notice || row.end_notice_at !== null) return 0;
    const { quiet, ...notice } = input.notice;
    const queued = quiet ? 0 : await queuePromoEndNotice(tx, { businessId: input.businessId, planCode: input.planCode, planEnds: input.planEnds, ...notice, appUrl: input.appUrl });
    await tx.execute(sql`update public.billing_accounts set end_notice_at = now(), updated_at = now() where business_id = ${input.businessId}::uuid`);
    return queued;
  });
}

/** The tiers' names, which are the same in every language. */
const TIER_NAMES: Record<HostedCheckoutPlanSlug, string> = { starter: "Starter", pro: "Pro" };

/**
 * Emails each owner of the business, in their own language, that the plan
 * ends: when, and what the subscription becomes. The worker sends the email
 * from the default sender.
 */
async function queuePromoEndNotice(
  tx: DatabaseTransaction,
  input: { businessId: string; planCode: string; planEnds: Date; tier: HostedCheckoutPlanSlug; interval: BillingInterval; ending: PromoPlanEnding; endsAt: Date; appUrl: string },
): Promise<number> {
  const recipients = (await tx.execute<{ user_id: string; email: string; preferred_locale: string | null; business_name: string; timezone: string | null }>(
    sql`select user_id, email, preferred_locale, business_name, timezone from app.billing_owner_recipients(${input.businessId}::uuid)`,
  )).rows;
  if (!recipients.length) return 0;
  const [plan] = (await tx.execute<{ names: Record<string, string> | null }>(sql`select names from public.billing_plans where code = ${input.planCode}`)).rows;
  const [price] = (await tx.execute<{ cents: number; currency: string }>(sql`
    select cents, currency from public.billing_prices
    where plan = ${input.tier} and period = ${input.interval} and retired_at is null limit 1`)).rows;
  const base = input.appUrl.endsWith("/") ? input.appUrl.slice(0, -1) : input.appUrl;
  for (const recipient of recipients) {
    const locale = normalizeInterfaceLocale(recipient.preferred_locale) ?? "en";
    await enqueueOutbox(tx, {
      topic: "email.send",
      businessId: input.businessId,
      aggregateType: "billing_account",
      aggregateId: input.businessId,
      dedupeKey: `promo-ending:${input.businessId}:${input.planEnds.toISOString()}:${recipient.user_id}`,
      payload: {
        template: "promo_ending",
        to: recipient.email,
        variables: {
          locale,
          businessName: recipient.business_name,
          planName: billingPlanName(plan?.names ?? {}, locale) ?? input.planCode,
          tier: TIER_NAMES[input.tier],
          ending: input.ending,
          date: input.endsAt.toISOString(),
          timeZone: recipient.timezone ?? "UTC",
          interval: input.interval,
          ...(price && input.ending === "tier" ? { priceCents: String(price.cents), currency: price.currency } : {}),
          url: `${base}/settings/plan`,
        },
      },
    });
  }
  return recipients.length;
}

/**
 * Ends a business's promo plan at its next renewal, for an operator: the plan
 * ends as it says, and one that would keep going moves to its tier. Its
 * owners hear about it and the worker tells Polar. Null when the business
 * has no promo plan in force. Callers check that an operator asked.
 */
export async function endPromoPlanInTransaction(tx: DatabaseTransaction, input: { businessId: string }): Promise<{ plan: string; ending: PromoPlanEnding; planEnds: Date } | null> {
  await lockBillingAccount(tx, input.businessId);
  const row = await readPromoAccount(tx, input.businessId);
  if (!row?.plan_code || row.plan_code === row.plan || row.source === MANAGED_BILLING_SOURCE || !isLiveSubscriptionState(row.subscription_state)) return null;
  const ending = promoPlanEnding(row.end_with, row.plan_ending) ?? "tier";
  const now = new Date();
  const current = dateOrNull(row.plan_ends);
  const periodEnd = dateOrNull(row.current_period_end);
  // A plan that already ends at the next renewal, or whose end has passed, keeps its date.
  const keepsDate = current !== null && (current.getTime() <= now.getTime() || (periodEnd !== null && promoPlanEndRenewal(current, periodEnd) !== null));
  const planEnds = keepsDate ? current : now;
  if (current?.getTime() !== planEnds.getTime()) {
    // A new end date needs a new email, and Polar telling again.
    await tx.execute(sql`
      update public.billing_accounts set plan_ends = ${planEnds.toISOString()}::timestamptz, end_with = ${ending}, end_notice_at = null, end_set_at = null, updated_at = now()
      where business_id = ${input.businessId}::uuid`);
  } else if (row.end_with !== ending) {
    // The same renewal ends it the same way, so it is only due at once: owners who heard about it don't hear again.
    await tx.execute(sql`update public.billing_accounts set end_with = ${ending}, updated_at = now() where business_id = ${input.businessId}::uuid`);
  }
  await enqueueOutbox(tx, { topic: "billing.endPromoPlan", businessId: input.businessId, aggregateType: "billing_account", aggregateId: input.businessId, dedupeKey: `promo-end:${input.businessId}:${planEnds.getTime()}:${ending}`, payload: {} });
  await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "billing_account", aggregateId: input.businessId, dedupeKey: `billing:${input.businessId}:promo-ended:${now.getTime()}`, payload: { type: "billing.updated", entityId: input.businessId } });
  return { plan: row.plan_code, ending, planEnds };
}
