// Top-ups (migrations 0154 and 0155, docs/features/top-ups.md): extra voice
// minutes, alert texts, transfers and website chats a business gets on top of
// its plan, granted by an operator, added with a top-up code, or bought once
// through the billing provider where the brand's billing.json sells one. A
// top-up never changes the plan: uses draw on it only once the plan's own
// allowance of their kind is used up, and on Starter and Pro what it pays for
// is never billed.

/** What a top-up gives, or what uses drew from it: voice seconds, alert SMS segments, outbound call attempts (transfers) and website chat units. */
export type BillingTopUpAmounts = {
  voiceSeconds: number;
  alertSmsSegments: number;
  outboundCallAttempts: number;
  chatAiUnits: number;
};

/** grant: an operator's platform key gave it. code: someone on the team typed a top-up code. purchase: the business paid for one on sale. */
export const billingTopUpSources = ["grant", "code", "purchase"] as const;
export type BillingTopUpSource = (typeof billingTopUpSources)[number];

/**
 * scheduled: it starts later. active: uses can draw on it. used_up: every
 * allowance it gives is drawn. expired: its end passed. frozen: a dispute
 * holds its payment until it closes. refunded: its whole payment went back.
 * revoked: an operator stopped it. Only an active top-up counts.
 */
export const billingTopUpStatuses = ["scheduled", "active", "used_up", "expired", "frozen", "refunded", "revoked"] as const;
export type BillingTopUpStatus = (typeof billingTopUpStatuses)[number];

/** The most days a top-up lasts from its start: three years. */
export const TOP_UP_MAX_DAYS = 1095;
/** The most one top-up gives of each allowance. */
export const TOP_UP_MAX_VOICE_SECONDS = 6_000_000;
export const TOP_UP_MAX_UNITS = 1_000_000;
/** How far ahead an operator may start a grant. */
export const TOP_UP_MAX_START_DAYS = 366;

/** A top-up a business has, as Settings > Plan shows it. */
export type BillingTopUpHolding = {
  id: string;
  source: BillingTopUpSource;
  /** The code typed, for a code's top-up; null for a grant or a purchase. */
  code: string | null;
  /** The operator's note, which the business sees, such as the promotion it is for. */
  note: string | null;
  /** A purchase's top-up on sale: its code in billing.json's topUps, and its display names by language; null for a grant or a code. */
  offer: string | null;
  names: Record<string, string> | null;
  /** What a purchase paid, what of it was refunded, and in what currency; 0, 0 and null for a grant or a code. */
  amountCents: number;
  refundedCents: number;
  currency: string | null;
  /** What it gives after refunds: a partial refund takes its share off each allowance. */
  gives: BillingTopUpAmounts;
  used: BillingTopUpAmounts;
  status: BillingTopUpStatus;
  /** ISO 8601. */
  startsAt: string;
  /** ISO 8601; null when it never ends. */
  endsAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

/** What the dashboard shows for a top-up code someone typed: what it adds, for how long, and whether the business or the person already added it. */
export type BillingTopUpCodeView = {
  kind: "top_up";
  /** The code as stored. */
  code: string;
  gives: BillingTopUpAmounts;
  /** How long the top-up lasts once added, in 24-hour days; null when it never ends. */
  days: number | null;
  /** The business already added this code's top-up. */
  usedHere: boolean;
  /** The person already added it, for this business or another. */
  usedByYou: boolean;
};

/** A top-up's status at `now`: revoked or refunded, then expired, then frozen, then scheduled, then used up once nothing it gives is left, else active. */
export function billingTopUpStatus(topUp: { status: string; startsAt: Date; endsAt: Date | null; gives: BillingTopUpAmounts; used: BillingTopUpAmounts }, now = new Date()): BillingTopUpStatus {
  if (topUp.status === "revoked") return "revoked";
  if (topUp.status === "refunded") return "refunded";
  if (topUp.endsAt !== null && topUp.endsAt.getTime() <= now.getTime()) return "expired";
  if (topUp.status === "frozen") return "frozen";
  if (topUp.startsAt.getTime() > now.getTime()) return "scheduled";
  const kinds = Object.keys(topUp.gives) as Array<keyof BillingTopUpAmounts>;
  return kinds.every((kind) => topUp.used[kind] >= topUp.gives[kind]) ? "used_up" : "active";
}

/** Whether a top-up gives anything at all. */
export function topUpGivesAnything(gives: BillingTopUpAmounts): boolean {
  return gives.voiceSeconds + gives.alertSmsSegments + gives.outboundCallAttempts + gives.chatAiUnits > 0;
}

/** When a top-up that starts at startsAt and lasts `days` 24-hour days ends; null when it never ends. */
export function topUpEndsAt(startsAt: Date, days: number | null): Date | null {
  return days === null ? null : new Date(startsAt.getTime() + days * 86_400_000);
}

/** A top-up on sale, as the plan screens show it and sell it (0155). */
export type BillingTopUpOffer = {
  code: string;
  /** Display names by language: en, fr, es and sr. */
  names: Record<string, string>;
  gives: BillingTopUpAmounts;
  /** How long it lasts from the payment, in 24-hour days; null when it never ends. */
  days: number | null;
  amountCents: number;
  currency: string;
  /** The provider sells it here and the caller may buy it now, so a button can start its checkout. */
  checkoutAvailable: boolean;
};

/**
 * Why a business may not buy a top-up now. managed_plan: an operator bills it
 * directly. top_up_not_sold_on_plan: only Free and a prepaid pack may buy one,
 * since Starter and Pro go on past their allowance and are billed for it, and
 * Enterprise and self-hosted deployments have no allowances. top_up_not_on_sale:
 * the top-up isn't on sale, or the provider doesn't sell it here.
 * plan_change_pending: another purchase of the business is in progress.
 */
export const topUpCheckoutRefusalCodes = ["managed_plan", "top_up_not_sold_on_plan", "top_up_not_on_sale", "plan_change_pending"] as const;
export type TopUpCheckoutRefusalCode = (typeof topUpCheckoutRefusalCodes)[number];

/** The refusals that hold for every top-up a business might buy, which the plan screens say before anyone clicks. */
export type TopUpCheckoutRefusal = Extract<TopUpCheckoutRefusalCode, "managed_plan" | "top_up_not_sold_on_plan">;

/** The plans whose businesses may buy a top-up: Free and a prepaid pack. */
export const topUpBuyingPlans = ["free_cloud", "prepaid"] as const;

/** Whether a business on this plan (BillingPlanSlug) may buy a top-up. */
export function topUpSoldOnPlan(plan: string): boolean {
  return (topUpBuyingPlans as readonly string[]).includes(plan);
}
