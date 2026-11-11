"use client";

import { Check } from "lucide-react";
import type { ReactNode } from "react";
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
import { cardBullets, openingInterval, planCardColumns, planCards, planTextValues, pricedIntervals, shownInterval, type PlanDisplayTranslate } from "@/lib/plan-display";
import { cn } from "@/lib/utils";
import {
  billingIntervals,
  type BillingDisplay,
  type BillingInterval,
  type BillingPlanList,
  type BillingPlanSlug,
  type CloudBillingPlanSlug,
  type HostedCheckoutPlanIntervals,
} from "@lobbystack/shared";

export type HostedUpgradePlan = "starter" | "pro";

type BillingTranslation = TFunction<"settings">;

// Prices and allowances come from the plan list. The cards, their order, the
// popular one and their bullets come from billing.json's display section, as
// on the onboarding plan step; these built-in bullets fill a card it gives none.
// The short line under the price and the buttons stay the dialog's own.
const builtInHighlights: Record<CloudBillingPlanSlug, string[]> = {
  free_cloud: ["voiceMinutes", "receptionists", "allFeatures", "support"],
  starter: ["voiceMinutes", "receptionists", "dedicatedNumber", "phoneNumber", "support"],
  pro: ["voiceMinutes", "receptionists", "dedicatedNumber", "alertSms", "support"],
  enterprise: ["phoneNumbers", "customReceptionists", "selfHosted", "support"],
};

function isHostedUpgradePlan(slug: CloudBillingPlanSlug): slug is HostedUpgradePlan {
  return slug === "starter" || slug === "pro";
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
  loadingPlan,
  locale,
  onBillingIntervalChange,
  onContactEnterprise,
  onOpenChange,
  onStartCheckout,
  open,
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
  loadingPlan: HostedUpgradePlan | null;
  locale: string;
  onBillingIntervalChange: (billingInterval: BillingInterval) => void;
  onContactEnterprise: () => void;
  onOpenChange: (open: boolean) => void;
  onStartCheckout: (target: HostedUpgradePlan, billingInterval: BillingInterval) => void;
  open: boolean;
  /** The deployment's plans, from GET /api/billing. */
  plans: BillingPlanList;
  /** Shown above the plans, such as the request for a billing email. */
  prompt?: ReactNode;
  t: BillingTranslation;
}) {
  const { appName } = useBranding();
  const translate: PlanDisplayTranslate = (key, options) => t(key, options ?? {});
  const cards = planCards(display);
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

        <div className={cn("grid gap-4", planCardColumns(cards.length))}>
          {cards.map(({ plan: slug, popular, display: card }) => {
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
            const highlights = card?.bullets
              ? cardBullets(card.bullets, offer, plans.currency, locale, translate, planTextValues(offer, plans.currency, locale, translate, appName))
              : builtInHighlights[slug].map((highlight) => t(`billing.upgradeDialog.plans.${slug}.highlights.${highlight}`, planStringValues(highlight, values)));
            // Free costs nothing and Enterprise is priced by agreement; a paid plan shows a month of the selected interval.
            const monthly = checkoutPlan !== null ? monthlyPriceCents(offer, selectedBillingInterval) : undefined;
            const price = slug === "free_cloud" ? formatMoney(0, plans.currency, locale) : isEnterprisePlan || offer?.custom ? t("billing.upgradeDialog.customPrice") : monthly !== undefined ? formatMoney(monthly, plans.currency, locale) : "—";
            const actionLabel = isCurrentPlan
              ? t("billing.upgradeDialog.actions.currentPlan")
              : checkoutPlan !== null
                ? t(`billing.upgradeDialog.actions.${checkoutPlan}`)
                : t("billing.upgradeDialog.actions.enterprise");

            return (
              <section
                className={cn(
                  "flex min-h-[29rem] flex-col rounded-xl border bg-background p-5",
                  popular
                    ? "border-foreground/30 bg-muted/20"
                    : "border-border/70",
                )}
                key={slug}
              >
                <div className="mb-5">
                  <h3 className="font-heading text-lg font-medium tracking-[-0.03em]">
                    {t(`billing.upgradeDialog.plans.${slug}.name`)}
                  </h3>
                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="font-heading text-4xl font-medium tracking-[-0.05em] tabular-nums">
                      {price}
                    </span>
                    {monthly !== undefined ? (
                      <span className="text-sm text-muted-foreground">
                        {t("billing.upgradeDialog.perMonth")}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    {t(
                      `billing.upgradeDialog.plans.${slug}.description.${selectedBillingInterval}`,
                    )}
                  </p>
                </div>

                <div className="flex-1 border-t border-border/60 pt-4">
                  <ul className="flex flex-col gap-3">
                    {highlights.map((highlight, index) => (
                      <li className="flex items-start gap-2.5 text-sm" key={index}>
                        <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                        <span className="whitespace-pre-line">{highlight}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <Button
                  className="mt-6 w-full rounded-full"
                  disabled={loading === "checkout" || isCurrentPlan || !isAvailable}
                  loading={
                    loading === "checkout" &&
                    checkoutPlan !== null &&
                    checkoutPlan === loadingPlan
                  }
                  loadingLabel={t(changesPlan ? "billing.actions.changingPlan" : "billing.actions.openingCheckout")}
                  onClick={() => {
                    if (checkoutPlan !== null) {
                      onStartCheckout(checkoutPlan, selectedBillingInterval);
                    } else if (isEnterprisePlan) {
                      onContactEnterprise();
                    }
                  }}
                  type="button"
                  variant={popular ? "default" : "outline"}
                >
                  {actionLabel}
                </Button>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
