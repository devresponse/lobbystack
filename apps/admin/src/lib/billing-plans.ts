import { billingPlanPrice, type BillingInterval, type BillingPlanList, type BillingPlanOffer, type CloudBillingPlanSlug } from "@lobbystack/shared";

import { intlLocale } from "./locale";

// The plan screens' numbers come from the plan list GET /api/billing returns:
// the deployment's billing catalog, or the built-in plans before an apply.
// Translations keep the words and take these values.

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
