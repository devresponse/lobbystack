"use client";

import { Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { TFunction } from "i18next";

import { useBranding } from "@/components/branding-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { annualBadge, findPlan, formatMoney, monthlyPriceCents, planStringValues, planValues } from "@/lib/billing-plans";
import { intlLocale } from "@/lib/locale";
import { cardBullets, displayText, hasPackCards, openingInterval, packCardBullets, packLengthKey, packLengthName, packLengths, packName, packPrice, packPriceSuffix, packSectionText, packTextValues, pageTextValues, planCardColumns, planCards, planTextValues, pricedIntervals, screenCards, shownInterval, type PlanCardView, type PlanDisplayTranslate } from "@/lib/plan-display";
import type { BillingPackOfferViewModel } from "@/lib/page-view-models";
import { cn } from "@/lib/utils";
import {
  billingIntervals,
  type BillingDisplay,
  type BillingInterval,
  type BillingPlanList,
  type BillingPlanSlug,
  type CloudBillingPlanSlug,
  type HostedCheckoutPlanIntervals,
  type PlanDisplayCard,
  type PlanDisplayPackCard,
} from "@lobbystack/shared";

export type HostedUpgradePlan = "starter" | "pro";

type BillingTranslation = TFunction<"settings">;

// Prices and allowances come from the plan list. The cards, their order, the
// popular one and their bullets come from billing.json's display section, as
// on the onboarding plan step; these built-in bullets fill a card it gives none.
// The short line under a plan's price and its buttons stay the dialog's own. A
// prepaid pack is a plan paid once for a number of days, so its card is a
// plan's card in every part: its price for its length, such as /180 days, the
// section's words or the dialog's own, its allowances for that length, and a
// button that buys it. Packs the section gives no card follow the plans under
// a Prepaid plans heading, a tab for each length, as the plans' intervals.
const builtInHighlights: Record<CloudBillingPlanSlug, string[]> = {
  free_cloud: ["voiceMinutes", "receptionists", "allFeatures", "support"],
  starter: ["voiceMinutes", "receptionists", "dedicatedNumber", "phoneNumber", "support"],
  pro: ["voiceMinutes", "receptionists", "dedicatedNumber", "alertSms", "support"],
  enterprise: ["phoneNumbers", "customReceptionists", "selfHosted", "support"],
};

function isHostedUpgradePlan(slug: CloudBillingPlanSlug): slug is HostedUpgradePlan {
  return slug === "starter" || slug === "pro";
}

/** The popular card's badge, where billing.json words one. */
function Badge({ children }: { children: ReactNode }) {
  return <span className="mb-3 inline-flex rounded-full bg-foreground px-3 py-0.5 text-xs font-medium text-background">{children}</span>;
}

/**
 * A card in the dialog in its original design, the same for a plan and a
 * pack: its name, its price and what follows it, its description, its
 * bullets, its button, and why the button can't be used where it can't.
 */
function DialogPlanCard({ card, loadingLabel }: { card: PlanCardView; loadingLabel: string }) {
  return (
    <section
      className={cn(
        "flex min-h-[29rem] flex-col rounded-xl border bg-background p-5",
        card.popular
          ? "border-foreground/30 bg-muted/20"
          : "border-border/70",
      )}
    >
      <div className="mb-5">
        {card.badge !== null ? <Badge>{card.badge}</Badge> : null}
        <h3 className="font-heading text-lg font-medium tracking-[-0.03em]">
          {card.name}
        </h3>
        <div className="mt-4 flex items-baseline gap-1">
          <span className="font-heading text-4xl font-medium tracking-[-0.05em] tabular-nums">
            {card.price}
          </span>
          {card.priceSuffix !== null ? (
            <span className="text-sm text-muted-foreground">
              {card.priceSuffix}
            </span>
          ) : null}
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {card.description}
        </p>
      </div>

      <div className="flex-1 border-t border-border/60 pt-4">
        <ul className="flex flex-col gap-3">
          {card.bullets.map((bullet, index) => (
            <li className="flex items-start gap-2.5 text-sm" key={index}>
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
              <span className="whitespace-pre-line">{bullet}</span>
            </li>
          ))}
        </ul>
      </div>

      <Button
        className="mt-6 w-full rounded-full"
        disabled={card.action.disabled}
        loading={card.action.busy}
        loadingLabel={loadingLabel}
        onClick={card.action.onClick}
        type="button"
        variant={card.popular ? "default" : "outline"}
      >
        {card.action.label}
      </Button>
      {card.note !== null ? (
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{card.note}</p>
      ) : null}
    </section>
  );
}

export function UpgradePlanDialog({
  availableCheckoutPlans,
  availableCheckoutIntervals,
  billingInterval,
  changesPlan = false,
  currentPlan,
  display = null,
  leavesPromoPlan = null,
  leavesPacks = null,
  loading,
  loadingPack = null,
  loadingPlan,
  locale,
  onBillingIntervalChange,
  onContactEnterprise,
  onBuyPack,
  onOpenChange,
  onStartCheckout,
  open,
  packOffers = [],
  packUnavailable = null,
  plans,
  prompt = null,
  t,
}: {
  availableCheckoutPlans: Array<"starter" | "pro">;
  availableCheckoutIntervals: HostedCheckoutPlanIntervals;
  /** The tab the person picked, or null for the opening one: billing.json's choice, else Annual. */
  billingInterval: BillingInterval | null;
  /** The business already pays, so a plan button changes its subscription instead of opening a checkout. */
  changesPlan?: boolean;
  currentPlan: BillingPlanSlug;
  /** The deployment's billing.json display section, from GET /api/billing. */
  display?: BillingDisplay | null;
  /** The name of the promo plan the business is on, which changing plan ends. */
  leavesPromoPlan?: string | null;
  /** The minutes left on the business's prepaid packs, which starting a plan ends. */
  leavesPacks?: { minutesLeft: number } | null;
  loading: "checkout" | null;
  /** The pack whose checkout is opening. */
  loadingPack?: string | null;
  loadingPlan: HostedUpgradePlan | null;
  locale: string;
  onBillingIntervalChange: (billingInterval: BillingInterval) => void;
  onContactEnterprise: () => void;
  /** Buys a pack a card shows. */
  onBuyPack?: (pack: string) => void;
  onOpenChange: (open: boolean) => void;
  onStartCheckout: (target: HostedUpgradePlan, billingInterval: BillingInterval) => void;
  open: boolean;
  /** The packs on sale to the business, from GET /api/billing: the ones a card shows. */
  packOffers?: BillingPackOfferViewModel[];
  /** Why a pack can't be bought now, under the button of a pack card that can't. */
  packUnavailable?: string | null;
  /** The deployment's plans, from GET /api/billing. */
  plans: BillingPlanList;
  /** Shown above the plans, such as the request for a billing email. */
  prompt?: ReactNode;
  t: BillingTranslation;
}) {
  const { appName } = useBranding();
  // The length of the prepaid plans the person picked, while the packs show under a heading of their own.
  const [chosenLength, setChosenLength] = useState<string | null>(null);
  const translate: PlanDisplayTranslate = (key, options) => t(key, options ?? {});
  const cards = planCards(display);
  // Every card in billing.json's order: the plans', and the packs' that are on sale.
  const shownCards = screenCards(display, packOffers);
  const annualBadgeText = annualBadge(plans, (key, options) => t(key, options), "billing.upgradeDialog.annualFreeMonths", "billing.upgradeDialog.annualDiscount");
  const availableBillingIntervals = billingIntervals.filter(
    (interval) =>
      availableCheckoutPlans.some((plan) =>
        availableCheckoutIntervals[plan].includes(interval),
      ),
  );
  // The intervals a plan can be bought on, else each one a plan has a price for: no Annual tab where plans sell monthly only.
  const switcherIntervals =
    availableBillingIntervals.length > 0
      ? availableBillingIntervals
      : pricedIntervals(plans, cards);
  const selectedBillingInterval = shownInterval(billingInterval ?? openingInterval(display), switcherIntervals, availableBillingIntervals);
  // The page's own words from billing.json print any plan's values, such as {{free_cloud.voiceMinutes}}.
  const pageValues = display ? pageTextValues(plans, locale, translate, appName) : {};
  // Without cards of their own, the packs follow the plans under a heading, a tab for each length.
  const packSection = !hasPackCards(display) && packOffers.length > 0;
  const lengths = packLengths(packOffers);
  // A pack that never ends has no days, so the tab picked is found by its place rather than by a value that may be null.
  const chosenIndex = lengths.findIndex((days) => packLengthKey(days) === chosenLength);
  const length = chosenIndex >= 0 ? lengths[chosenIndex] : lengths[0];
  const sectionPacks = packSection ? packOffers.filter((offer) => offer.days === length) : [];

  // A plan's card, from the plan list and billing.json's bullets for it, else the built-in ones.
  const planCard = (slug: CloudBillingPlanSlug, popular: boolean, card: PlanDisplayCard | null): PlanCardView => {
    const isCurrentPlan = currentPlan === slug;
    const checkoutPlan = isHostedUpgradePlan(slug) ? slug : null;
    const isEnterprisePlan = slug === "enterprise";
    const isSelectedIntervalAvailable =
      checkoutPlan === null ||
      availableCheckoutIntervals[checkoutPlan].includes(selectedBillingInterval);
    // Moving a paid plan down happens in the billing portal, so only an upgrade changes it here.
    const isDowngrade = changesPlan && currentPlan === "pro" && checkoutPlan === "starter";
    const isAvailable =
      isEnterprisePlan ||
      (checkoutPlan !== null &&
        !isDowngrade &&
        availableCheckoutPlans.includes(checkoutPlan) &&
        isSelectedIntervalAvailable);
    const offer = findPlan(plans, slug);
    const values = planValues(offer, plans.currency, locale);
    const textValues = card ? planTextValues(offer, plans.currency, locale, translate, appName) : {};
    // Free costs nothing and Enterprise is priced by agreement; a paid plan shows a month of the selected interval.
    const monthly = checkoutPlan !== null ? monthlyPriceCents(offer, selectedBillingInterval) : undefined;
    // A business on a pack goes back to Free once its packs end, which no button starts.
    const label = isCurrentPlan
      ? t("billing.upgradeDialog.actions.currentPlan")
      : slug === "free_cloud" && currentPlan === "prepaid"
        ? t("billing.upgradeDialog.actions.freeAfterPacks")
        : checkoutPlan !== null
          ? t(`billing.upgradeDialog.actions.${checkoutPlan}`)
          : t("billing.upgradeDialog.actions.enterprise");
    return {
      key: slug,
      name: t(`billing.upgradeDialog.plans.${slug}.name`),
      price: slug === "free_cloud" ? formatMoney(0, plans.currency, locale) : isEnterprisePlan || offer?.custom ? t("billing.upgradeDialog.customPrice") : monthly !== undefined ? formatMoney(monthly, plans.currency, locale) : "—",
      priceSuffix: monthly !== undefined ? t("billing.upgradeDialog.perMonth") : null,
      description: t(`billing.upgradeDialog.plans.${slug}.description.${selectedBillingInterval}`),
      bullets: card?.bullets
        ? cardBullets(card.bullets, offer, plans.currency, locale, translate, textValues)
        : builtInHighlights[slug].map((highlight) => t(`billing.upgradeDialog.plans.${slug}.highlights.${highlight}`, planStringValues(highlight, values))),
      popular,
      badge: popular && card?.badge ? displayText(card.badge, locale, textValues) : null,
      action: {
        label,
        disabled: loading === "checkout" || isCurrentPlan || !isAvailable,
        busy: loading === "checkout" && checkoutPlan !== null && checkoutPlan === loadingPlan,
        onClick: () => {
          if (checkoutPlan !== null) {
            onStartCheckout(checkoutPlan, selectedBillingInterval);
          } else if (isEnterprisePlan) {
            onContactEnterprise();
          }
        },
      },
      note: null,
    };
  };
  // A pack's card, a plan's card in every part: its price for its length, its words from billing.json where it gives
  // them, else the dialog's own, and its allowances for that length.
  const packCard = (offer: BillingPackOfferViewModel, popular: boolean, card: PlanDisplayPackCard | null): PlanCardView => {
    const textValues = packTextValues(offer, locale, translate, appName);
    const days = offer.days === null ? null : packLengthName(offer.days, locale, translate);
    return {
      key: `pack:${offer.code}`,
      name: packName(offer, locale),
      price: packPrice(offer, locale),
      priceSuffix: packPriceSuffix(offer.days, locale, translate),
      description: card?.description ? displayText(card.description, locale, textValues) : days === null ? t("billing.packs.cardDescriptionNoEnd") : t("billing.packs.cardDescription", { days }),
      bullets: packCardBullets(card, offer, locale, translate, textValues),
      popular,
      badge: popular && card?.badge ? displayText(card.badge, locale, textValues) : null,
      action: {
        label: card?.button ? displayText(card.button, locale, textValues) : packSectionText(display, "button", locale, pageValues) ?? (days === null ? t("billing.packs.startNoEnd") : t("billing.packs.start", { days })),
        disabled: loading === "checkout" || !offer.checkoutAvailable || !onBuyPack,
        busy: loading === "checkout" && loadingPack === offer.code,
        onClick: () => onBuyPack?.(offer.code),
      },
      note: offer.checkoutAvailable || !packUnavailable ? null : packUnavailable,
    };
  };
  const loadingLabel = t(changesPlan ? "billing.actions.changingPlan" : "billing.actions.openingCheckout");
  const packLoadingLabel = t("billing.actions.openingCheckout");

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-[72rem]">
        <DialogHeader>
          <DialogTitle className="text-xl">
            {t("billing.upgradeDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("billing.upgradeDialog.description")}
          </DialogDescription>
          {changesPlan ? (
            <p className="text-sm text-muted-foreground">
              {t("billing.upgradeDialog.changesSubscription")}
            </p>
          ) : null}
          {changesPlan && leavesPromoPlan ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {t("billing.upgradeDialog.leavesPromo", { plan: leavesPromoPlan })}
            </p>
          ) : null}
          {leavesPacks ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {t("billing.upgradeDialog.endsPacks", { count: leavesPacks.minutesLeft, minutes: leavesPacks.minutesLeft.toLocaleString(intlLocale(locale)) })}
            </p>
          ) : null}
        </DialogHeader>

        {prompt}

        {switcherIntervals.length > 0 ? <div className="flex justify-center">
          {/* On a narrow phone the Annual tab puts its badge under its name, and wraps it if need be, rather than overflow the dialog. */}
          <div
            aria-label={t("billing.upgradeDialog.billingIntervalLabel")}
            className="inline-flex max-w-full rounded-full border border-border bg-muted/40 p-1"
            role="tablist"
          >
            {switcherIntervals.map((interval) => (
              <Button
                aria-selected={selectedBillingInterval === interval}
                className={cn(
                  "h-auto min-h-9 shrink flex-wrap gap-x-2 gap-y-0.5 whitespace-normal rounded-full px-3 py-1 sm:px-4",
                  selectedBillingInterval === interval
                    ? "bg-background text-foreground shadow-sm hover:bg-background"
                    : "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                key={interval}
                onClick={() => onBillingIntervalChange(interval)}
                role="tab"
                size="sm"
                type="button"
                variant="outline"
              >
                {t(`billing.upgradeDialog.billingIntervals.${interval}`)}
                {interval === "annual" && annualBadgeText !== null ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-center text-xs font-medium text-emerald-700">
                    {annualBadgeText}
                  </span>
                ) : null}
              </Button>
            ))}
          </div>
        </div> : null}

        <div className={cn("grid gap-4", planCardColumns(shownCards.length))}>
          {shownCards.map((shown) => shown.kind === "pack"
            ? <DialogPlanCard card={packCard(packOffers.find((entry) => entry.code === shown.pack)!, shown.popular, shown.display)} key={`pack:${shown.pack}`} loadingLabel={packLoadingLabel} />
            : <DialogPlanCard card={planCard(shown.plan, shown.popular, shown.display)} key={shown.plan} loadingLabel={loadingLabel} />)}
        </div>

        {packSection ? (
          <section className="flex flex-col gap-4 border-t border-border/60 pt-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="font-heading text-lg font-medium tracking-[-0.03em]">
                {packSectionText(display, "title", locale, pageValues) ?? t("billing.packs.title")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {packSectionText(display, "description", locale, pageValues) ?? t("billing.packs.description")}
              </p>
            </div>
            {lengths.length > 1 ? (
              <div className="flex justify-center">
                <div
                  aria-label={t("billing.packs.lengthLabel")}
                  className="inline-flex max-w-full flex-wrap justify-center rounded-full border border-border bg-muted/40 p-1"
                  role="tablist"
                >
                  {lengths.map((days) => (
                    <Button
                      aria-selected={days === length}
                      className={cn(
                        "h-auto min-h-9 shrink whitespace-normal rounded-full px-3 py-1 sm:px-4",
                        days === length
                          ? "bg-background text-foreground shadow-sm hover:bg-background"
                          : "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      key={packLengthKey(days)}
                      onClick={() => setChosenLength(packLengthKey(days))}
                      role="tab"
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {packLengthName(days, locale, translate)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className={cn("grid gap-4", planCardColumns(sectionPacks.length))}>
              {sectionPacks.map((offer) => <DialogPlanCard card={packCard(offer, false, null)} key={`pack:${offer.code}`} loadingLabel={packLoadingLabel} />)}
            </div>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
