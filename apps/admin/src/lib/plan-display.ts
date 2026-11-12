import {
  billingIntervals,
  billingPlanName,
  billingPlanPrice,
  cloudBillingPlanSlugs,
  fillPlanDisplayText,
  isPackDisplayCard,
  isPlanDisplayCard,
  isPlanDisplayText,
  planDisplayIntervalText,
  planDisplayText,
  type BillingDisplay,
  type BillingInterval,
  type BillingPlanList,
  type BillingPlanOffer,
  type CloudBillingPlanSlug,
  type PlanDisplayAllowance,
  type PackDisplayValueName,
  type PlanDisplayCard,
  type PlanDisplayIntervalText,
  type PlanDisplayPackCard,
  type PlanDisplayText,
  type PlanDisplayValueName,
} from "@lobbystack/shared";

import { findPlan, formatMoney, storageSize } from "./billing-plans";
import { intlLocale } from "./locale";
import type { BillingPackOfferViewModel } from "./page-view-models";

// The plan screens' layout and words from the deployment's billing.json
// display section, which GET /api/billing returns as planDisplay: which plans
// and packs get a card and in what order, the popular one, the opening tab,
// the cards' words and bullets, and the comparison. A screen says whatever the
// section leaves out in its built-in words, and a deployment without a section
// shows the built-in screens. A plan's numbers always come from the plan list,
// and a pack's, with its price, from the packs on sale. A pack is a plan paid
// once for a number of days, so its card is a plan's card in every part: its
// price is followed by its length, as a plan's is by /mo, and its bullets say
// what it includes for that length in a plan card's words.

/** A translation function that also reaches the common namespace as `common:...`. */
export type PlanDisplayTranslate = (key: string, options?: Record<string, unknown>) => string;

/** A card a plan screen shows: its plan, whether it's marked popular, and the section's words for it, if any. */
export type PlanCard = { plan: CloudBillingPlanSlug; popular: boolean; display: PlanDisplayCard | null };

const builtInCards: PlanCard[] = cloudBillingPlanSlugs.map((plan) => ({ plan, popular: plan === "pro", display: null }));

/** The plans' cards in their order, which are also the comparison's columns: the section's, else Free, Starter, Pro (popular) and Enterprise. */
export function planCards(display: BillingDisplay | null | undefined): PlanCard[] {
  return display?.plans ? display.plans.filter(isPlanDisplayCard).map((card) => ({ plan: card.plan, popular: card.popular === true, display: card })) : builtInCards;
}

/** A pack's card: the code of the pack it sells, whether it's marked popular, and the section's words for it. */
export type PackCard = { pack: string; popular: boolean; display: PlanDisplayPackCard };

/** A card a plan screen shows, a plan's or a pack's, in the section's order. */
export type ScreenCard = ({ kind: "plan" } & PlanCard) | ({ kind: "pack" } & PackCard);

/**
 * Every card a plan screen shows, in the section's order: the plans' and the
 * packs'. A pack's card shows only while its pack is on sale, as offers says,
 * since its price and numbers come from there.
 */
export function screenCards(display: BillingDisplay | null | undefined, offers: readonly BillingPackOfferViewModel[]): ScreenCard[] {
  if (!display?.plans) return builtInCards.map((card) => ({ kind: "plan", ...card }));
  const onSale = new Set(offers.map((offer) => offer.code));
  return display.plans.flatMap((card): ScreenCard[] => {
    if (isPackDisplayCard(card)) return onSale.has(card.pack) ? [{ kind: "pack", pack: card.pack, popular: card.popular === true, display: card }] : [];
    return isPlanDisplayCard(card) ? [{ kind: "plan", plan: card.plan, popular: card.popular === true, display: card }] : [];
  });
}

/**
 * Whether the section gives a pack a card, which puts the packs among the
 * plans' cards in its order. Without one, a screen shows the packs on sale
 * after the plans, under a Prepaid plans heading, in cards of the same kind.
 */
export function hasPackCards(display: BillingDisplay | null | undefined): boolean {
  return display?.plans?.some(isPackDisplayCard) ?? false;
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

/** A pack's name in the visitor's language, else English, else its code. */
export function packName(offer: BillingPackOfferViewModel, locale: string): string {
  return billingPlanName(offer.names, locale) ?? offer.code;
}

/** A pack's price, paid once, in its currency. */
export function packPrice(offer: BillingPackOfferViewModel, locale: string): string {
  return formatMoney(offer.amountCents, offer.currency, locale);
}

/**
 * What follows a pack's price, as /mo follows a plan's: the length it is paid
 * for, such as /180 days, or paid once for a pack that never ends.
 */
export function packPriceSuffix(days: number | null, locale: string, t: PlanDisplayTranslate): string {
  return days === null ? t("common:planDisplay.paidOnce") : t("common:planDisplay.perDays", { count: days, amount: days.toLocaleString(intlLocale(locale)) });
}

/** A pack's length as a tab or a sentence names it, such as 180 days, or no end date. */
export function packLengthName(days: number | null, locale: string, t: PlanDisplayTranslate): string {
  return days === null ? t("common:planDisplay.noEndDate") : t("common:planDisplay.days", { count: days, amount: days.toLocaleString(intlLocale(locale)) });
}

/** Lengths from shortest to longest, with a pack that never ends last. */
function byLength(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

/**
 * The lengths the packs on sale come in, shortest first and one that never
 * ends last: the tabs a screen's prepaid plans show, as the plans show their
 * billing intervals. One length needs no tab.
 */
export function packLengths(offers: readonly BillingPackOfferViewModel[]): Array<number | null> {
  return [...new Set(offers.map((offer) => offer.days))].sort(byLength);
}

/** A pack length's tab, which a tab list keys by a string: its days, or none for a pack that never ends. */
export function packLengthKey(days: number | null): string {
  return days === null ? "none" : String(days);
}

/** The section's own words for the screens' prepaid plans, with the page's values; null where it gives none, for the screen's built-in words. */
export function packSectionText(display: BillingDisplay | null | undefined, field: "title" | "description" | "button", locale: string, values: Readonly<Record<string, string>>): string | null {
  const value = display?.packs?.[field];
  return value ? displayText(value, locale, values) : null;
}

/**
 * A card on a plan screen, whether it sells a plan or a pack: the same parts
 * in the same places, so a pack's card looks and works as a plan's does. Its
 * price is followed by a plan's /mo or a pack's length, such as /180 days.
 */
export type PlanCardView = {
  key: string;
  name: string;
  price: string;
  priceSuffix: string | null;
  description: string;
  bullets: string[];
  popular: boolean;
  /** The popular card's badge, where the screen shows one. */
  badge: string | null;
  action: { label: string; disabled: boolean; busy: boolean; onClick: () => void };
  /** Why the card's button can't be used now, under it. */
  note: string | null;
};

/**
 * The values a pack's text prints as {{name}}: its voice minutes and other
 * allowances for its whole length, its length in days (a dash for a pack that
 * never ends), its price, and its limits while it lasts.
 */
export function packDisplayValues(offer: BillingPackOfferViewModel, locale: string, t: PlanDisplayTranslate): Record<PackDisplayValueName, string> {
  const count = (value: number) => value.toLocaleString(intlLocale(locale));
  const size = storageSize(offer.knowledgeStorageBytes, locale);
  return {
    voiceMinutes: count(offer.minutes),
    days: offer.days === null ? "—" : count(offer.days),
    price: packPrice(offer, locale),
    receptionists: count(offer.receptionists),
    businessNumbers: count(offer.numbers),
    alertSmsSegments: count(offer.smsSegments),
    outboundCallAttempts: count(offer.outboundCalls),
    chatAiUnits: count(offer.chatUnits),
    knowledgeStorage: t(`common:planDisplay.storage.${size.unit === "GB" ? "gigabytes" : "megabytes"}`, { amount: size.amount }),
  };
}

/** What text about one pack prints: its values, and the app's name. */
export function packTextValues(offer: BillingPackOfferViewModel, locale: string, t: PlanDisplayTranslate, appName: string): Record<string, string> {
  return { ...packDisplayValues(offer, locale, t), appName };
}

/** The bullets a pack's card shows when the section gives it none, as a plan's card shows its allowances. */
export const builtInPackBullets: PlanDisplayAllowance[] = ["voiceMinutes", "receptionists", "businessNumbers", "alertSmsSegments", "outboundCallAttempts"];

/**
 * What a pack card's bullet that names an allowance says: the pack's own
 * number with its plural, in a plan card's words. Everything a pack includes
 * lasts its whole length, which its price names, as a plan's month does; a
 * pack has no overage, so its minutes name no rate, and a pack without a
 * business number calls from the browser only, as a plan without one does.
 */
export function packAllowanceBullet(allowance: PlanDisplayAllowance, offer: BillingPackOfferViewModel, locale: string, t: PlanDisplayTranslate): string {
  const say = (name: string, options: Record<string, unknown> = {}) => t(`common:planDisplay.bullets.${name}`, options);
  const amount = (count: number) => ({ count, amount: count.toLocaleString(intlLocale(locale)) });
  switch (allowance) {
    case "voiceMinutes":
      return say(offer.numbers === 0 ? "browserVoiceMinutes" : "voiceMinutes", amount(offer.minutes));
    case "businessNumbers":
      return offer.numbers === 0 ? say("businessNumbersNone") : say("businessNumbers", amount(offer.numbers));
    case "knowledgeStorage": {
      const size = storageSize(offer.knowledgeStorageBytes, locale);
      return say(size.unit === "GB" ? "knowledgeStorageGigabytes" : "knowledgeStorageMegabytes", { amount: size.amount });
    }
    case "receptionists":
      return say("receptionists", amount(offer.receptionists));
    case "alertSmsSegments":
      return say("alertSmsSegments", amount(offer.smsSegments));
    case "outboundCallAttempts":
      return say("outboundCallAttempts", amount(offer.outboundCalls));
    case "chatAiUnits":
      return say("chatAiUnits", amount(offer.chatUnits));
  }
}

/** A pack card's bullets: the section's, else the built-in ones, each an allowance's own words or the section's text with the pack's values. card is null for a card the section doesn't word. */
export function packCardBullets(card: PlanDisplayPackCard | null, offer: BillingPackOfferViewModel, locale: string, t: PlanDisplayTranslate, values: Readonly<Record<string, string>>): string[] {
  return (card?.bullets ?? builtInPackBullets).map((bullet) => (isPlanDisplayText(bullet) ? displayText(bullet, locale, values) : packAllowanceBullet(bullet, offer, locale, t)));
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
