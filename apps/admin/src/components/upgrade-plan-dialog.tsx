"use client";

import { Check } from "lucide-react";
import type { TFunction } from "i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { findPlan, formatMoney, monthlyPriceCents, planStringValues, planValues } from "@/lib/billing-plans";
import { cn } from "@/lib/utils";
import {
  annualSavingPercent,
  type BillingInterval,
  type BillingPlanList,
  type BillingPlanSlug,
  type HostedCheckoutPlanIntervals,
} from "@lobbystack/shared";

export type HostedUpgradePlan = "starter" | "pro";

type BillingTranslation = TFunction<"settings">;

type UpgradePlanCard = {
  slug: "free_cloud" | HostedUpgradePlan | "enterprise";
  highlights: string[];
  highlighted?: boolean;
};

// Prices and allowances come from the plan list; the cards keep their order and words.
const upgradePlanCards: UpgradePlanCard[] = [
  { slug: "free_cloud", highlights: ["voiceMinutes", "allFeatures", "support"] },
  { slug: "starter", highlights: ["voiceMinutes", "dedicatedNumber", "phoneNumber", "support"] },
  { slug: "pro", highlights: ["voiceMinutes", "dedicatedNumber", "alertSms", "support"], highlighted: true },
  { slug: "enterprise", highlights: ["phoneNumbers", "selfHosted", "support"] },
];

function isHostedUpgradePlan(slug: UpgradePlanCard["slug"]): slug is HostedUpgradePlan {
  return slug === "starter" || slug === "pro";
}

export function UpgradePlanDialog({
  availableCheckoutPlans,
  availableCheckoutIntervals,
  billingInterval,
  changesPlan = false,
  currentPlan,
  leavesPromoPlan = null,
  loading,
  loadingPlan,
  locale,
  onBillingIntervalChange,
  onContactEnterprise,
  onOpenChange,
  onStartCheckout,
  open,
  plans,
  t,
}: {
  availableCheckoutPlans: Array<"starter" | "pro">;
  availableCheckoutIntervals: HostedCheckoutPlanIntervals;
  billingInterval: BillingInterval;
  /** The business already pays, so a plan button changes its subscription instead of opening a checkout. */
  changesPlan?: boolean;
  currentPlan: BillingPlanSlug;
  /** The name of the promo plan the business is on, which changing plan ends. */
  leavesPromoPlan?: string | null;
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
  t: BillingTranslation;
}) {
  const annualSaving = annualSavingPercent(plans);
  const availableBillingIntervals = (["monthly", "annual"] as const).filter(
    (interval) =>
      availableCheckoutPlans.some((plan) =>
        availableCheckoutIntervals[plan].includes(interval),
      ),
  );
  const switcherIntervals =
    availableBillingIntervals.length > 0
      ? availableBillingIntervals
      : (["monthly", "annual"] as const);
  const fallbackBillingInterval: BillingInterval = switcherIntervals[0] ?? "monthly";
  const selectedBillingInterval = switcherIntervals.includes(billingInterval)
    ? billingInterval
    : fallbackBillingInterval;

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
        </DialogHeader>

        <div className="flex justify-center">
          <div
            aria-label={t("billing.upgradeDialog.billingIntervalLabel")}
            className="inline-flex rounded-full border border-border bg-muted/40 p-1"
            role="tablist"
          >
            {switcherIntervals.map((interval) => (
              <Button
                aria-selected={selectedBillingInterval === interval}
                className={cn(
                  "h-9 rounded-full px-4",
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
                {interval === "annual" && annualSaving !== null ? (
                  <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    {t("billing.upgradeDialog.annualDiscount", { percent: annualSaving })}
                  </span>
                ) : null}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {upgradePlanCards.map((card) => {
            const isCurrentPlan = currentPlan === card.slug;
            const checkoutPlan = isHostedUpgradePlan(card.slug) ? card.slug : null;
            const isEnterprisePlan = card.slug === "enterprise";
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
            const offer = findPlan(plans, card.slug);
            const values = planValues(offer, plans.currency, locale);
            // Free costs nothing and Enterprise is priced by agreement; a paid plan shows a month of the selected interval.
            const monthly = checkoutPlan !== null ? monthlyPriceCents(offer, selectedBillingInterval) : undefined;
            const price = card.slug === "free_cloud" ? formatMoney(0, plans.currency, locale) : isEnterprisePlan || offer?.custom ? t("billing.upgradeDialog.customPrice") : monthly !== undefined ? formatMoney(monthly, plans.currency, locale) : "—";
            const actionLabel = isCurrentPlan
              ? t("billing.upgradeDialog.actions.currentPlan")
              : checkoutPlan !== null
                ? t(`billing.upgradeDialog.actions.${checkoutPlan}`)
                : t("billing.upgradeDialog.actions.enterprise");

            return (
              <section
                className={cn(
                  "flex min-h-[29rem] flex-col rounded-xl border bg-background p-5",
                  card.highlighted
                    ? "border-foreground/30 bg-muted/20"
                    : "border-border/70",
                )}
                key={card.slug}
              >
                <div className="mb-5">
                  <h3 className="font-heading text-lg font-medium tracking-[-0.03em]">
                    {t(`billing.upgradeDialog.plans.${card.slug}.name`)}
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
                      `billing.upgradeDialog.plans.${card.slug}.description.${selectedBillingInterval}`,
                    )}
                  </p>
                </div>

                <div className="flex-1 border-t border-border/60 pt-4">
                  <ul className="flex flex-col gap-3">
                    {card.highlights.map((highlight) => (
                      <li className="flex items-start gap-2.5 text-sm" key={highlight}>
                        <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                        <span className="whitespace-pre-line">
                          {t(
                            `billing.upgradeDialog.plans.${card.slug}.highlights.${highlight}`,
                            planStringValues(highlight, values),
                          )}
                        </span>
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
                  variant={card.highlighted ? "default" : "outline"}
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
