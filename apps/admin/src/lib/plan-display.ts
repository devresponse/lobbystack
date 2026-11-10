import {
  billingIntervals,
  billingPlanPrice,
  cloudBillingPlanSlugs,
  fillPlanDisplayText,
  isPlanDisplayText,
  planDisplayIntervalText,
  planDisplayText,
  type BillingDisplay,
  type BillingInterval,
  type BillingPlanList,
  type BillingPlanOffer,
  type CloudBillingPlanSlug,
  type PlanDisplayAllowance,
  type PlanDisplayCard,
  type PlanDisplayIntervalText,
  type PlanDisplayText,
  type PlanDisplayValueName,
} from "@lobbystack/shared";

import { findPlan, formatMoney, storageSize } from "./billing-plans";
import { intlLocale } from "./locale";

// The plan screens' layout and words from the deployment's billing.json
// display section, which GET /api/billing returns as planDisplay: which plans
// get a card and in what order, the popular one, the opening tab, the cards'
// words and bullets, and the comparison. A screen says whatever the section
// leaves out in its built-in words, and a deployment without a section shows
// the built-in screens. The numbers always come from the plan list.

/** A translation function that also reaches the common namespace as `common:...`. */
export type PlanDisplayTranslate = (key: string, options?: Record<string, unknown>) => string;

/** A card a plan screen shows: its plan, whether it's marked popular, and the section's words for it, if any. */
export type PlanCard = { plan: CloudBillingPlanSlug; popular: boolean; display: PlanDisplayCard | null };

const builtInCards: PlanCard[] = cloudBillingPlanSlugs.map((plan) => ({ plan, popular: plan === "pro", display: null }));

/** The cards in their order, which are also the comparison's columns: the section's, else Free, Starter, Pro (popular) and Enterprise. */
export function planCards(display: BillingDisplay | null | undefined): PlanCard[] {
  return display?.plans ? display.plans.map((card) => ({ plan: card.plan, popular: card.popular === true, display: card })) : builtInCards;
}

/**
 * The tabs a plan screen offers: each interval a plan with a card has a price
 * for. A deployment that sells monthly prices only, as on Stripe as merchant
 * of record, shows no Annual tab.
 */
export function pricedIntervals(plans: BillingPlanList, cards: PlanCard[]): BillingInterval[] {
  return billingIntervals.filter((interval) => cards.some((card) => billingPlanPrice(findPlan(plans, card.plan), interval) !== undefined));
}

/** The tab a screen opens on until the person picks one: the section's, else Annual. */
export function openingInterval(display: BillingDisplay | null | undefined): BillingInterval {
  return display?.defaultInterval ?? "annual";
}

/**
 * The tab a plan screen shows: the preferred one where a plan can be bought on
 * it, else the first such tab; where none can be bought, the preferred one if
 * it is a tab, else the first tab.
 */
export function shownInterval(preferred: BillingInterval, tabs: BillingInterval[], buyable: BillingInterval[]): BillingInterval {
  const pool = buyable.length > 0 ? buyable : tabs;
  return pool.includes(preferred) ? preferred : pool[0] ?? preferred;
}

const cardColumns = ["", "mx-auto w-full max-w-md", "mx-auto w-full max-w-4xl md:grid-cols-2", "md:grid-cols-2 lg:grid-cols-3", "md:grid-cols-2 xl:grid-cols-4"];

/** The grid columns for a number of plan cards: four across on a wide screen, as the built-in screens show them. */
export function planCardColumns(count: number): string {
  return cardColumns[Math.min(Math.max(count, 0), 4)] ?? "";
}

/**
 * The values a plan's text prints as {{name}}: its allowances, formatted in
 * the visitor's language, and its overage rates in the plan list's currency.
 * A custom allowance prints the word for custom, as does a custom plan's rate;
 * a rate the plan doesn't bill prints a dash.
 */
export function planDisplayValues(offer: BillingPlanOffer | undefined, currency: string, locale: string, t: PlanDisplayTranslate): Record<PlanDisplayValueName, string> {
  const custom = t("common:planDisplay.custom");
  const included = offer?.included;
  const count = (value: number | null | undefined) => (value === null || value === undefined ? custom : value.toLocaleString(intlLocale(locale)));
  const rate = (cents: number | null | undefined) => (cents !== null && cents !== undefined ? formatMoney(cents, currency, locale) : offer?.custom ? custom : "—");
  const seconds = included?.voiceSeconds;
  const bytes = included?.knowledgeStorageBytes;
  const size = bytes === null || bytes === undefined ? null : storageSize(bytes, locale);
  return {
    voiceMinutes: count(seconds === null || seconds === undefined ? null : Math.floor(seconds / 60)),
    receptionists: count(included?.receptionists),
    businessNumbers: count(included?.businessNumbers),
    alertSmsSegments: count(included?.alertSmsSegments),
    outboundCallAttempts: count(included?.outboundCallAttempts),
    chatAiUnits: count(included?.chatAiUnits),
    knowledgeStorage: size ? t(`common:planDisplay.storage.${size.unit === "GB" ? "gigabytes" : "megabytes"}`, { amount: size.amount }) : custom,
    voiceMinuteRate: rate(offer?.overageRates.voiceMinuteCents),
    alertSmsSegmentRate: rate(offer?.overageRates.alertSmsSegmentCents),
    outboundCallAttemptRate: rate(offer?.overageRates.outboundCallAttemptCents),
  };
}

/** What text about one plan prints: its values, and the app's name. */
export function planTextValues(offer: BillingPlanOffer | undefined, currency: string, locale: string, t: PlanDisplayTranslate, appName: string): Record<string, string> {
  return { ...planDisplayValues(offer, currency, locale, t), appName };
}

/** What text about the whole page prints: every plan's values named after it, such as {{free_cloud.voiceMinutes}}, and the app's name. */
export function pageTextValues(plans: BillingPlanList, locale: string, t: PlanDisplayTranslate, appName: string): Record<string, string> {
  const values: Record<string, string> = { appName };
  for (const plan of cloudBillingPlanSlugs) {
    for (const [name, value] of Object.entries(planDisplayValues(findPlan(plans, plan), plans.currency, locale, t))) values[`${plan}.${name}`] = value;
  }
  return values;
}

/** The section's text in the visitor's language, with its values filled in. */
export function displayText(value: PlanDisplayText, locale: string, values: Readonly<Record<string, string>>): string {
  return fillPlanDisplayText(planDisplayText(value, locale), values);
}

/** A card's text on a tab: one version for both, or the tab's own. */
export function cardText(value: PlanDisplayIntervalText, interval: BillingInterval, locale: string, values: Readonly<Record<string, string>>): string {
  return displayText(planDisplayIntervalText(value, interval), locale, values);
}

/**
 * What a card bullet that names an allowance says: the plan's own number with
 * its plural, and for voice minutes the overage rate. A plan without a
 * business number calls from the browser only, so its minutes say so and its
 * number says none; a custom allowance says custom.
 */
export function allowanceBullet(allowance: PlanDisplayAllowance, offer: BillingPlanOffer | undefined, currency: string, locale: string, t: PlanDisplayTranslate): string {
  const included = offer?.included;
  const say = (name: string, options: Record<string, unknown> = {}) => t(`common:planDisplay.bullets.${name}`, options);
  const amount = (count: number) => ({ count, amount: count.toLocaleString(intlLocale(locale)) });
  const counted = (name: string, value: number | null | undefined) => (value === null || value === undefined ? say(`${name}Custom`) : say(name, amount(value)));
  switch (allowance) {
    case "voiceMinutes": {
      const seconds = included?.voiceSeconds;
      if (seconds === null || seconds === undefined) return say("voiceMinutesCustom");
      const cents = offer?.overageRates.voiceMinuteCents;
      const billed = cents !== null && cents !== undefined;
      return say(`${included?.businessNumbers === 0 ? "browserVoiceMinutes" : "voiceMinutes"}${billed ? "Then" : ""}`, { ...amount(Math.floor(seconds / 60)), ...(billed ? { rate: formatMoney(cents, currency, locale) } : {}) });
    }
    case "businessNumbers":
      return included?.businessNumbers === 0 ? say("businessNumbersNone") : counted("businessNumbers", included?.businessNumbers);
    case "knowledgeStorage": {
      const bytes = included?.knowledgeStorageBytes;
      if (bytes === null || bytes === undefined) return say("knowledgeStorageCustom");
      const size = storageSize(bytes, locale);
      return say(size.unit === "GB" ? "knowledgeStorageGigabytes" : "knowledgeStorageMegabytes", { amount: size.amount });
    }
    default:
      return counted(allowance, included?.[allowance]);
  }
}

/** A card's bullets from the section: an allowance's own words, or the section's text with the plan's values. */
export function cardBullets(bullets: NonNullable<PlanDisplayCard["bullets"]>, offer: BillingPlanOffer | undefined, currency: string, locale: string, t: PlanDisplayTranslate, values: Readonly<Record<string, string>>): string[] {
  return bullets.map((bullet) => (isPlanDisplayText(bullet) ? displayText(bullet, locale, values) : allowanceBullet(bullet, offer, currency, locale, t)));
}
