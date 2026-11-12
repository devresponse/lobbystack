"use client";

import { billingPlanName } from "@lobbystack/shared";
import { useTranslation } from "react-i18next";

import { formatMoney } from "@/lib/billing-plans";
import { formatDateTime, intlLocale } from "@/lib/locale";
import type { BillingPackViewModel, PackCheckoutViewModel } from "@/lib/page-view-models";
import { packPriceSuffix } from "@/lib/plan-display";
import { cn } from "@/lib/utils";
import { ConfirmActionDialog } from "./confirm-action-dialog";

// Prepaid packs on the plan screens. A pack on sale is a card like a plan's,
// on the onboarding plan step and in the Upgrade plan dialog, and a business
// on one pack has it as its plan under Settings > Plan's Your plan. Here are
// what those screens share: the question before a purchase whose payment
// ends a Starter or Pro subscription, which says what the business loses, and
// the list of the packs a business holds when they aren't its plan by
// themselves, such as several at once.

/** A pack's end date, as the plan screens write dates. */
export function formatPackDate(value: string, locale: string): string {
  return formatDateTime(value, locale, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Asks before a purchase whose payment ends a Starter or Pro subscription:
 * the plan ends at once, the rest of its month isn't refunded and its usage
 * so far is still billed, a promo code is lost for good, Pro's receptionists
 * but one are paused, and the pack starts.
 */
export function PackEndsPlanDialog({ ends, open, onOpenChange, onConfirm, pending = false }: { ends: NonNullable<PackCheckoutViewModel["endsSubscription"]>; open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void; pending?: boolean }) {
  const { i18n, t } = useTranslation("settings");
  const plan = t(`billing.planLabels.${ends.plan}`);
  const lines = [
    ends.periodEnd ? t("billing.packs.endsPlanDialog.noRefund", { date: formatPackDate(ends.periodEnd, i18n.language) }) : t("billing.packs.endsPlanDialog.noRefundUndated"),
    ends.promo ? t("billing.packs.endsPlanDialog.promoLost") : null,
    ends.plan === "pro" ? t("billing.packs.endsPlanDialog.receptionistsPaused") : null,
    t("billing.packs.endsPlanDialog.packStarts"),
  ].filter((line): line is string => line !== null);
  return <ConfirmActionDialog
    cancelLabel={t("billing.cancelDialog.back")}
    confirmLabel={t("billing.packs.endsPlanDialog.confirm")}
    confirmVariant="destructive"
    description={t("billing.packs.endsPlanDialog.planEnds", { plan })}
    details={<ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
    onConfirm={onConfirm}
    onOpenChange={onOpenChange}
    open={open}
    pending={pending}
    title={t("billing.packs.endsPlanDialog.title", { plan })}
  />;
}

/** A pack the business holds: its name and price for its length, its minutes left out of its total, when it ends, and whether a dispute holds it. */
function HeldPack({ pack, locale }: { pack: BillingPackViewModel; locale: string }) {
  const { t } = useTranslation("settings");
  const left = Math.floor(pack.secondsLeft / 60);
  const total = Math.floor(pack.secondsTotal / 60);
  const share = pack.secondsTotal > 0 ? Math.min(100, (pack.secondsLeft / pack.secondsTotal) * 100) : 0;
  const frozen = pack.status === "frozen";
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="text-[15px] font-medium leading-6 text-foreground">{billingPlanName(pack.names, locale) ?? pack.code}</span>
      <span className="text-[15px] leading-6 text-muted-foreground tabular-nums">{formatMoney(pack.amountCents, pack.currency, locale)} {packPriceSuffix(pack.days, locale, (key, options) => t(key, options ?? {}))}</span>
    </div>
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div className={cn("h-full rounded-full", frozen ? "bg-muted-foreground" : "bg-foreground")} style={{ width: `${share}%` }} />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm leading-6 text-muted-foreground">
      <span className="tabular-nums">{t("billing.packs.left", { count: left, left: left.toLocaleString(intlLocale(locale)), total: total.toLocaleString(intlLocale(locale)) })}</span>
      <span>{pack.endsAt ? t("billing.packs.endsOn", { date: formatPackDate(pack.endsAt, locale) }) : t("billing.packs.neverEnds")}</span>
    </div>
    {frozen ? <span className="text-sm leading-6 text-amber-700 dark:text-amber-400">{t("billing.packs.frozen")}</span> : null}
  </div>;
}

/**
 * The packs a business holds, under Settings > Plan's Your plan, when they
 * aren't its plan by themselves: several at once, the soonest to end first,
 * or one a dispute froze beside another plan. Each is listed as a plan is
 * shown: its name and its price for its length, with its minutes left and
 * when it ends.
 */
export function HeldPacks({ packs, locale }: { packs: BillingPackViewModel[]; locale: string }) {
  const { t } = useTranslation("settings");
  return <div className="flex flex-col gap-4 border-t border-border pt-5">
    <span className="text-base font-medium leading-6 text-foreground">{t("billing.packs.heldTitle")}</span>
    <div className="flex flex-col gap-5">{packs.map((pack) => <HeldPack key={pack.id} locale={locale} pack={pack} />)}</div>
  </div>;
}
