import { billingPlanPrice, type BillingInterval, type BillingPlanList, type BillingPlanOffer, type CloudBillingPlanSlug } from "@lobbystack/shared";

import { intlLocale } from "./locale";

// The plan screens' numbers come from the plan list GET /api/billing returns:
// the deployment's billing catalog, or before an apply the plans its build
// carries: its brand's billing.json, else the built-in ones. Translations keep
// the words and take these values.

/**
 * How long a plan change waits for Polar's webhook before it stops checking.
 * A webhook that lands later shows the next time the plan page loads billing.
 */
export const PLAN_CHANGE_SYNC_MS = 90_000;

/** Whether a checkout or billing portal request was refused for too many this hour. */
export function isBillingRateLimited(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "billing_rate_limited";
}

/** The refusal of a plan change while another for the business is still waiting for Polar. */
export function isPlanChangePending(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "plan_change_pending";
}

/** Formats cents as currency, dropping the decimals for whole amounts. */
export function formatMoney(cents: number, currency = "usd", locale = "en"): string {
  return new Intl.NumberFormat(intlLocale(locale), { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/** The currency's short sign, such as $ or €, to put before an amount field. */
export function currencySymbol(currency: string, locale = "en"): string {
  const code = currency.toUpperCase();
  return new Intl.NumberFormat(intlLocale(locale), { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((part) => part.type === "currency")?.value ?? code;
}

export function findPlan(list: BillingPlanList | undefined, slug: CloudBillingPlanSlug): BillingPlanOffer | undefined {
  return list?.plans.find((plan) => plan.slug === slug);
}

/** What a plan costs a month on an interval, an annual price spread over twelve months; undefined where that interval isn't sold. */
export function monthlyPriceCents(plan: BillingPlanOffer | undefined, interval: BillingInterval): number | undefined {
  const price = billingPlanPrice(plan, interval);
  if (!price) return undefined;
  return interval === "annual" ? price.monthlyAmountCents : price.amountCents;
}

/** A storage limit in whole megabytes, or gigabytes from one gigabyte up. */
export function storageSize(bytes: number, locale = "en"): { amount: string; unit: "MB" | "GB" } {
  const unit = bytes >= 1024 ** 3 ? "GB" : "MB";
  return { amount: (bytes / (unit === "GB" ? 1024 ** 3 : 1024 ** 2)).toLocaleString(intlLocale(locale)), unit };
}

/** The allowances "What's included" lists, in its order. */
const includedLineKeys = ["voiceSeconds", "outboundCallAttempts", "alertSmsSegments", "knowledgeStorageBytes"] as const;

/**
 * What a plan includes each month as "What's included" lists it: voice
 * minutes, transfers, texts and storage. No limit reads as custom.
 */
export function includedLines(included: BillingPlanOffer["included"] | undefined, t: (key: string, options?: Record<string, unknown>) => string, locale = "en"): Array<{ key: typeof includedLineKeys[number]; text: string }> {
  const count = (value: number | null | undefined, key: string) => value === null || value === undefined ? t(`billing.currentPlan.${key}Custom`) : t(`billing.currentPlan.${key}`, { count: value });
  const voice = included?.voiceSeconds;
  const storage = included?.knowledgeStorageBytes;
  const text = {
    voiceSeconds: count(voice === null || voice === undefined ? null : Math.floor(voice / 60), "includedVoice"),
    outboundCallAttempts: count(included?.outboundCallAttempts, "includedOutbound"),
    alertSmsSegments: count(included?.alertSmsSegments, "includedSms"),
    knowledgeStorageBytes: storage === null || storage === undefined ? t("billing.currentPlan.includedStorageCustom") : t("billing.currentPlan.includedStorage", storageSize(storage, locale)),
  };
  return includedLineKeys.map((key) => ({ key, text: text[key] }));
}

/**
 * A plan's allowances and overage rates as the plan strings take them:
 * {{minutes}}, {{count}} and {{rate}}. A custom allowance reads as zero, so
 * callers show a custom string for it instead.
 */
export function planValues(plan: BillingPlanOffer | undefined, currency: string, locale = "en") {
  const rate = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : formatMoney(cents, currency, locale));
  return {
    minutes: Math.floor((plan?.included.voiceSeconds ?? 0) / 60),
    alertSmsSegments: plan?.included.alertSmsSegments ?? 0,
    outboundCallAttempts: plan?.included.outboundCallAttempts ?? 0,
    businessNumbers: plan?.included.businessNumbers ?? 0,
    voiceRate: rate(plan?.overageRates.voiceMinuteCents),
    alertSmsRate: rate(plan?.overageRates.alertSmsSegmentCents),
    outboundCallRate: rate(plan?.overageRates.outboundCallAttemptCents),
  };
}

/**
 * What a plan string takes: voice minutes and their rate, or the count it
 * names. The upgrade dialog calls Starter's text line "phoneNumber".
 */
export function planStringValues(key: string, values: ReturnType<typeof planValues>): Record<string, string | number> {
  if (key === "voiceMinutes") return { count: values.minutes, rate: values.voiceRate };
  if (key === "dedicatedNumber") return { count: values.businessNumbers };
  if (key === "phoneNumber" || key === "alertSms") return { count: values.alertSmsSegments };
  return {};
}
