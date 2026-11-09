"use client";

import { useState } from "react";
import { billingPlanName } from "@lobbystack/shared";
import { useTranslation } from "react-i18next";

import { usePackCheckout } from "@/hooks/use-pack-checkout";
import { formatMoney } from "@/lib/billing-plans";
import { formatDateTime, intlLocale } from "@/lib/locale";
import type { BillingPackOfferViewModel, BillingPackViewModel, PackCheckoutViewModel } from "@/lib/page-view-models";
import { cn } from "@/lib/utils";
import { BillingEmailForm } from "./billing-email-form";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { SectionBlock } from "./section-block";
import { Button } from "./ui/button";
import { Surface } from "./ui/surface";

// Prepaid packs on the plan screens. PackPicker chooses a pack on sale by its
// minutes and its length. PacksSection, on Settings > Plan, lists the packs
// the business holds and sells another through usePackCheckout. GET
// /api/billing says whether the viewer may buy each pack now and why not; a
// purchase that ends a Starter or Pro subscription asks first and says what
// the business loses. Nothing here shows for a business with no packs on a
// deployment that sells none.

/** A pack's end date, as the plan screens write dates. */
export function formatPackDate(value: string, locale: string): string {
  return formatDateTime(value, locale, { month: "short", day: "numeric", year: "numeric" });
}

/** Lengths from shortest to longest, with a pack that never ends last. */
function byLength(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

type Choice = { key: string; label: string; selected: boolean; disabled: boolean; onSelect: () => void };

/** One segmented choice, such as the pack's minutes or its length. */
function Segmented({ label, choices }: { label: string; choices: Choice[] }) {
  return <div className="flex flex-col gap-2">
    <span className="text-sm font-medium text-foreground">{label}</span>
    <div aria-label={label} className="inline-flex max-w-full flex-wrap gap-1 self-start rounded-3xl border border-border bg-muted/40 p-1" role="radiogroup">
      {choices.map((choice) => <Button
        aria-checked={choice.selected}
        className={cn("h-auto min-h-8 rounded-full px-3 py-1", choice.selected ? "bg-background text-foreground shadow-sm hover:bg-background" : "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground")}
        disabled={choice.disabled}
        key={choice.key}
        onClick={choice.onSelect}
        role="radio"
        size="sm"
        type="button"
        variant="outline"
      >{choice.label}</Button>)}
    </div>
  </div>;
}

/**
 * The packs on sale, chosen by minutes and by length, with the chosen pack's
 * price. A length the chosen minutes aren't sold with can't be picked, and
 * picking minutes keeps the length when it can. value is the chosen pack's
 * code; null or a code no longer on sale chooses the first pack.
 */
export function PackPicker({ offers, value, onChange, disabled = false }: { offers: BillingPackOfferViewModel[]; value: string | null; onChange: (code: string) => void; disabled?: boolean }) {
  const { i18n, t } = useTranslation("settings");
  const locale = i18n.language;
  const selected = offers.find((offer) => offer.code === value) ?? offers[0];
  if (!selected) return null;
  const minutes = [...new Set(offers.map((offer) => offer.minutes))].sort((left, right) => left - right);
  const lengths = [...new Set(offers.map((offer) => offer.days))].sort(byLength);
  const sold = (amount: number, days: number | null) => offers.find((offer) => offer.minutes === amount && offer.days === days);
  const pick = (amount: number, days: number | null) => {
    const offer = sold(amount, days) ?? offers.find((entry) => entry.minutes === amount);
    if (offer && offer.code !== selected.code) onChange(offer.code);
  };
  return <div className="flex flex-col gap-4">
    <Segmented
      choices={minutes.map((amount) => ({ key: String(amount), label: t("billing.packs.minutesOption", { count: amount, minutes: amount.toLocaleString(intlLocale(locale)) }), selected: amount === selected.minutes, disabled, onSelect: () => pick(amount, selected.days) }))}
      label={t("billing.packs.minutesLabel")}
    />
    <Segmented
      choices={lengths.map((days) => ({ key: String(days), label: days === null ? t("billing.packs.neverEndsOption") : t("billing.packs.daysOption", { count: days }), selected: days === selected.days, disabled: disabled || !sold(selected.minutes, days), onSelect: () => pick(selected.minutes, days) }))}
      label={t("billing.packs.lengthLabel")}
    />
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="text-3xl font-semibold tracking-tight text-foreground">{formatMoney(selected.amountCents, selected.currency, locale)}</span>
      <span className="text-sm text-muted-foreground">{t("billing.packs.priceSuffix")}</span>
    </div>
  </div>;
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

/** A pack the business holds: its minutes left out of its total, when it ends, and whether a dispute holds it. */
function HeldPack({ pack, locale }: { pack: BillingPackViewModel; locale: string }) {
  const { t } = useTranslation("settings");
  const left = Math.floor(pack.secondsLeft / 60);
  const total = Math.floor(pack.secondsTotal / 60);
  const share = pack.secondsTotal > 0 ? Math.min(100, (pack.secondsLeft / pack.secondsTotal) * 100) : 0;
  const frozen = pack.status === "frozen";
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <span className="text-[15px] font-medium leading-6 text-foreground">{billingPlanName(pack.names, locale) ?? pack.code}</span>
      <span className="text-[15px] leading-6 text-muted-foreground tabular-nums">{t("billing.packs.left", { count: left, left: left.toLocaleString(intlLocale(locale)), total: total.toLocaleString(intlLocale(locale)) })}</span>
    </div>
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div className={cn("h-full rounded-full", frozen ? "bg-muted-foreground" : "bg-foreground")} style={{ width: `${share}%` }} />
    </div>
    <span className="text-sm leading-6 text-muted-foreground">{pack.endsAt ? t("billing.packs.endsOn", { date: formatPackDate(pack.endsAt, locale) }) : t("billing.packs.neverEnds")}</span>
    {frozen ? <span className="text-sm leading-6 text-amber-700 dark:text-amber-400">{t("billing.packs.frozen")}</span> : null}
  </div>;
}

/**
 * Settings > Plan's packs: those the business holds, and for those who
 * manage billing, the packs on sale with a button that buys the chosen one.
 * The button says why when the business may not buy one now. A plan that
 * sells no packs, such as an operator-managed one, shows only the packs still
 * held; with none held and nothing to buy, the section doesn't show.
 */
export function PacksSection({ businessId, offers, packs, eligibility, managesBilling }: { businessId: string; offers: BillingPackOfferViewModel[]; packs: BillingPackViewModel[]; eligibility: PackCheckoutViewModel; managesBilling: boolean }) {
  const { i18n, t } = useTranslation("settings");
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const checkout = usePackCheckout(businessId);
  const notSold = eligibility.refusal === "managed_plan" || eligibility.refusal === "pack_not_sold_on_plan";
  const selling = managesBilling && !notSold && offers.length > 0;
  if (!selling && packs.length === 0) return null;
  const selected = offers.find((offer) => offer.code === chosen) ?? offers[0];
  const buyable = Boolean(selected?.checkoutAvailable) && eligibility.refusal === null;
  const reason = eligibility.refusal ? t(`billing.packs.refusals.${eligibility.refusal}`) : buyable ? null : t("billing.packs.unavailable");
  const ends = eligibility.endsSubscription;
  const prompt = checkout.emailPrompt;
  function buy() {
    if (!selected || !buyable) return;
    if (ends) setConfirming(true);
    else checkout.start(selected.code);
  }
  return <SectionBlock description={t("billing.packs.description")} title={t("billing.packs.title")}>
    <Surface className="px-6 py-5">
      <div className="flex flex-col gap-6">
        {packs.length > 0 ? <div className="flex flex-col gap-5">{packs.map((pack) => <HeldPack key={pack.id} locale={i18n.language} pack={pack} />)}</div> : null}
        {selling && selected ? <div className={cn("flex flex-col gap-4", packs.length > 0 && "border-t border-border pt-5")}>
          <PackPicker disabled={checkout.pending} offers={offers} onChange={setChosen} value={selected.code} />
          <div className="flex flex-col items-start gap-2">
            <Button disabled={!buyable} loading={checkout.pending} loadingLabel={t("billing.actions.openingCheckout")} onClick={buy} size="sm" type="button">{t(packs.length > 0 ? "billing.packs.buyMore" : "billing.packs.buy")}</Button>
            {reason ? <p className="text-sm leading-6 text-muted-foreground">{reason}</p> : null}
          </div>
          {prompt ? <BillingEmailForm key={prompt.pack} onCancel={checkout.dismissEmailPrompt} onSubmit={(billingEmail) => checkout.start(prompt.pack, billingEmail)} pending={checkout.pending} refusal={prompt.refusal} refusedEmail={prompt.email} /> : null}
        </div> : null}
      </div>
    </Surface>
    {ends && selected ? <PackEndsPlanDialog ends={ends} onConfirm={() => checkout.start(selected.code)} onOpenChange={setConfirming} open={confirming} pending={checkout.pending} /> : null}
  </SectionBlock>;
}
