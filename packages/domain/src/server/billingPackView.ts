import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { billingAccounts, billingPackOffers, billingPackPlans, billingPacks, type DatabaseTransaction } from "@lobbystack/db";
import { billingProviderOf, packCapacitySeconds, type BillingPlanSlug } from "@lobbystack/shared";

import { isLiveSubscriptionState, isManagedBillingAccount, loadPlanChangePayment } from "./billing";
import { packSecondsLeft } from "./billingPacks";
import { loadBillingContext } from "./usage";

// What the plan screens show about prepaid packs (migration 0148): the packs on
// sale, the packs a business holds, and whether it may buy one now. The last
// mirrors the pack checkout's own refusals, in the checkout's order, so a
// screen never offers a purchase the checkout would refuse, and says before
// the purchase when a pack's payment ends a Starter or Pro subscription
// (decision 6). GET /api/billing reads these on every billing page, so each is
// one small read, and the eligibility takes the plan and the billing account
// its caller already read.

/** A pack on sale, as the plan screens show it and sell it. */
export type PackOfferView = {
  code: string;
  /** Display names by language: en, fr, es and sr. */
  names: Record<string, string>;
  /** The voice minutes the pack holds for its whole length. */
  minutes: number;
  voiceSeconds: number;
  /** How long it lasts from the payment, in days; null when it never ends. */
  days: number | null;
  amountCents: number;
  currency: string;
  /** What it gives each UTC month while it lasts. */
  smsSegments: number;
  outboundCalls: number;
  chatUnits: number;
  /** Its limits while it lasts. */
  knowledgeStorageBytes: number;
  numbers: number;
  receptionists: number;
  /** The provider sells it here and the caller may buy it now, so a button can start its checkout. */
  checkoutAvailable: boolean;
};

/** A pack the business holds, with time left: live, or frozen while a dispute holds its payment. */
export type BusinessPackView = {
  id: string;
  code: string;
  names: Record<string, string>;
  status: "active" | "frozen";
  /** The seconds it holds after refunds. */
  secondsTotal: number;
  secondsLeft: number;
  paidAt: Date;
  /** null when it never ends. */
  endsAt: Date | null;
};

/** Why a business may not buy a pack now: the pack checkout's refusals that hold for every pack. */
export type PackCheckoutRefusal = "managed_plan" | "pack_not_sold_on_plan" | "pack_yearly_plan" | "pack_past_due" | "plan_change_payment_waiting";

/** The subscription a pack's payment ends: its tier, whether it is a promo plan, and the end of the period paid for. */
export type PackEndsSubscription = { plan: "starter" | "pro"; promo: boolean; periodEnd: Date | null };

export type PackCheckoutEligibility = {
  refusal: PackCheckoutRefusal | null;
  /** The Starter or Pro subscription a pack would end, so the screen asks first; null when there is none. */
  endsSubscription: PackEndsSubscription | null;
};

/** The billing account fields the eligibility reads, which a caller that already read the row passes in. */
export type PackEligibilityAccount = {
  source: string | null;
  plan: string | null;
  planCode: string | null;
  subscriptionId: string | null;
  subscriptionState: string | null;
  replacedSubscriptionId: string | null;
  billingInterval: string | null;
  currentPeriodEnd: Date | null;
};

/**
 * Whether the deployment's provider has what a pack checkout needs: Polar's
 * token and organization, or Stripe's key and account. Unlike
 * polarCheckoutConfigured, it reads the provider the deployment uses.
 */
export function packCheckoutConfigured(env: Record<string, string | undefined> = process.env): boolean {
  if (billingProviderOf(env) === "stripe") return Boolean(env.STRIPE_API_KEY?.trim() && env.STRIPE_ACCOUNT_ID?.trim());
  return Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_ORGANIZATION_ID);
}

/**
 * The packs on sale, from billing_pack_offers only: an active pack with a live
 * price. Unlike plans, packs never fall back to the brand's billing.json, so
 * nothing shows before an apply. checkout says whether the caller may buy now;
 * a pack also needs the provider's object that sells it, which a link records.
 */
export async function loadPackOffers(tx: DatabaseTransaction, input: { checkout: boolean }): Promise<PackOfferView[]> {
  const rows = await tx.select({ code: billingPackOffers.code, names: billingPackOffers.names, voiceSec: billingPackOffers.voiceSec, days: billingPackOffers.days, smsSeg: billingPackOffers.smsSeg, callsOut: billingPackOffers.callsOut, chatUnits: billingPackOffers.chatUnits, kbBytes: billingPackOffers.kbBytes, numbers: billingPackOffers.numbers, receptionists: billingPackOffers.receptionists, currency: billingPackOffers.currency, cents: billingPackOffers.cents, providerRef: billingPackOffers.providerRef })
    .from(billingPackOffers)
    .orderBy(asc(billingPackOffers.sort), asc(billingPackOffers.code));
  return rows.map((row) => ({
    code: row.code,
    names: row.names,
    minutes: row.voiceSec / 60,
    voiceSeconds: row.voiceSec,
    days: row.days,
    amountCents: row.cents,
    currency: row.currency,
    smsSegments: row.smsSeg,
    outboundCalls: row.callsOut,
    chatUnits: row.chatUnits,
    knowledgeStorageBytes: Number(row.kbBytes),
    numbers: row.numbers,
    receptionists: row.receptionists,
    checkoutAvailable: input.checkout && row.providerRef !== null,
  }));
}

/**
 * The business's packs with time left at `now`, live or frozen, the one that
 * ends first first and one that never ends last, as calls draw on them.
 */
export async function loadBusinessPacks(tx: DatabaseTransaction, businessId: string, now = new Date()): Promise<BusinessPackView[]> {
  const rows = await tx.select({ id: billingPacks.id, code: billingPacks.pack, names: billingPackPlans.names, status: billingPacks.status, secondsTotal: billingPacks.secondsTotal, secondsUsed: billingPacks.secondsUsed, amountCents: billingPacks.amountCents, refundedCents: billingPacks.refundedCents, paidAt: billingPacks.paidAt, endsAt: billingPacks.endsAt })
    .from(billingPacks)
    .innerJoin(billingPackPlans, eq(billingPackPlans.code, billingPacks.pack))
    .where(and(eq(billingPacks.businessId, businessId), inArray(billingPacks.status, ["active", "frozen"]), or(isNull(billingPacks.endsAt), gt(billingPacks.endsAt, now))))
    .orderBy(sql`${billingPacks.endsAt} asc nulls last`, asc(billingPacks.paidAt), asc(billingPacks.id));
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    names: row.names,
    status: row.status === "frozen" ? "frozen" : "active",
    secondsTotal: packCapacitySeconds(row),
    secondsLeft: packSecondsLeft(row),
    paidAt: row.paidAt,
    endsAt: row.endsAt,
  }));
}

/** A yearly subscription, as the providers' events and read-backs name its interval. */
function isYearly(interval: string | null | undefined): boolean {
  return interval === "annual" || interval === "year";
}

const refused = (refusal: PackCheckoutRefusal): PackCheckoutEligibility => ({ refusal, endsSubscription: null });

/**
 * Whether the business may buy a pack now, as the pack checkout decides, in
 * its order: a managed plan is refused; so is a self-hosted deployment or the
 * Enterprise plan; and a live subscription that is yearly (decision 6a), has
 * a payment past due (6b) or has an upgrade waiting on its payment page. A
 * subscription a pack already replaced counts as ended. Otherwise a monthly
 * Starter or Pro subscription is the one the pack's payment ends.
 *
 * plan is the plan in force and account the billing account row, when the
 * caller already read them; each is read here otherwise.
 */
export async function packCheckoutEligibility(tx: DatabaseTransaction, input: { businessId: string; plan?: BillingPlanSlug; account?: PackEligibilityAccount | null }): Promise<PackCheckoutEligibility> {
  const account = input.account !== undefined ? input.account : await readEligibilityAccount(tx, input.businessId);
  if (isManagedBillingAccount(account)) return refused("managed_plan");
  const plan = input.plan ?? (await loadBillingContext(tx, input.businessId)).plan;
  if (plan === "self_host" || plan === "enterprise") return refused("pack_not_sold_on_plan");
  const subscriptionId = account?.subscriptionId && isLiveSubscriptionState(account.subscriptionState) && account.replacedSubscriptionId !== account.subscriptionId ? account.subscriptionId : null;
  if (!account || !subscriptionId) return { refusal: null, endsSubscription: null };
  if (isYearly(account.billingInterval)) return refused("pack_yearly_plan");
  if (account.subscriptionState === "past_due") return refused("pack_past_due");
  if (await loadPlanChangePayment(tx, { businessId: input.businessId, subscriptionId })) return refused("plan_change_payment_waiting");
  const tier = plan === "starter" || plan === "pro" ? plan : account.plan === "starter" || account.plan === "pro" ? account.plan : null;
  // A promo plan is stored by its own code beside its tier, as the plan card names it.
  const promo = account.planCode !== null && account.planCode !== account.plan;
  return { refusal: null, endsSubscription: tier ? { plan: tier, promo, periodEnd: account.currentPeriodEnd } : null };
}

async function readEligibilityAccount(tx: DatabaseTransaction, businessId: string): Promise<PackEligibilityAccount | null> {
  const [row] = await tx.select({ source: billingAccounts.source, plan: billingAccounts.plan, planCode: billingAccounts.planCode, subscriptionId: billingAccounts.subscriptionId, subscriptionState: billingAccounts.subscriptionState, replacedSubscriptionId: billingAccounts.replacedSubscriptionId, billingInterval: billingAccounts.billingInterval, currentPeriodEnd: billingAccounts.currentPeriodEnd })
    .from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
  return row ?? null;
}
