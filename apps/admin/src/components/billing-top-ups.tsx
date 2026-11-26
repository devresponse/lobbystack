"use client";

import { billingPlanName, type BillingTopUpAmounts, type BillingTopUpCodeView, type BillingTopUpHolding, type BillingTopUpOffer } from "@lobbystack/shared";
import { Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePackCheckout } from "@/hooks/use-pack-checkout";
import { formatMoney } from "@/lib/billing-plans";
import { formatDateTime, intlLocale } from "@/lib/locale";
import { BillingEmailForm } from "./billing-email-form";
import { Button } from "./ui/button";

// Top-ups on the plan screens (docs/features/top-ups.md): extra voice minutes,
// alert texts, transfers and website chats on top of the plan, which an
// operator grants, a top-up code adds or the business buys. Settings > Plan
// lists those that count now or will under Your plan, with those on sale that
// the business may buy, and the promo code field shows what a top-up code adds
// before anyone adds it. The plan itself never changes.

type Translate = ReturnType<typeof useTranslation>["t"];

/** Each allowance a top-up gives, in the order the plan screens list them, with the unit they count it in. */
const topUpKinds = [
  { key: "voiceSeconds", label: "voice", per: 60 },
  { key: "outboundCallAttempts", label: "transfers", per: 1 },
  { key: "alertSmsSegments", label: "sms", per: 1 },
  { key: "chatAiUnits", label: "chats", per: 1 },
] as const satisfies ReadonlyArray<{ key: keyof BillingTopUpAmounts; label: string; per: number }>;

/** A count as the screens show it: minutes to a tenth for voice seconds, whole units for the rest. */
function inUnits(value: number, per: number): number {
  return per === 1 ? value : Math.floor((value / per) * 10) / 10;
}

/** What a top-up gives, one line per allowance it has any of, such as "60 voice minutes". */
export function topUpAmountLines(gives: BillingTopUpAmounts, locale: string, t: Translate): Array<{ key: string; text: string }> {
  return topUpKinds.filter((kind) => gives[kind.key] > 0).map((kind) => {
    const count = inUnits(gives[kind.key], kind.per);
    return { key: kind.key, text: t(`billing.topUps.amounts.${kind.label}`, { count, amount: count.toLocaleString(intlLocale(locale)) }) };
  });
}

function formatTopUpDate(value: string, locale: string): string {
  return formatDateTime(value, locale, { month: "short", day: "numeric", year: "numeric" });
}

/** A top-up's title: the operator's note, the code that added it, the name of the top-up bought, or a top-up. */
function topUpTitle(topUp: BillingTopUpHolding, locale: string, t: Translate): string {
  if (topUp.note) return topUp.note;
  if (topUp.code) return t("billing.topUps.fromCode", { code: topUp.code });
  if (topUp.source === "purchase") return (topUp.names ? billingPlanName(topUp.names, locale) : null) ?? t("billing.topUps.bought");
  return t("billing.topUps.granted");
}

/** One top-up: its note or where it came from, what each allowance has left of what it gave, when it starts or ends, and whether a dispute holds it. */
function HeldTopUp({ topUp, locale }: { topUp: BillingTopUpHolding; locale: string }) {
  const { t } = useTranslation("settings");
  const title = topUpTitle(topUp, locale, t);
  const when = topUp.status === "scheduled"
    ? t("billing.topUps.startsOn", { date: formatTopUpDate(topUp.startsAt, locale) })
    : topUp.endsAt ? t("billing.topUps.endsOn", { date: formatTopUpDate(topUp.endsAt, locale) }) : t("billing.topUps.neverEnds");
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="text-[15px] font-medium leading-6 text-foreground">{title}</span>
      <span className="text-sm leading-6 text-muted-foreground">{when}</span>
    </div>
    <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
      {topUpKinds.filter((kind) => topUp.gives[kind.key] > 0).map((kind) => {
        const total = inUnits(topUp.gives[kind.key], kind.per);
        const left = inUnits(Math.max(0, topUp.gives[kind.key] - topUp.used[kind.key]), kind.per);
        return <li className="flex items-baseline justify-between gap-3 text-sm leading-6" key={kind.key}>
          <span className="text-foreground">{t(`billing.topUps.kinds.${kind.label}`)}</span>
          <span className="tabular-nums text-muted-foreground">{t("billing.topUps.left", { left: left.toLocaleString(intlLocale(locale)), total: total.toLocaleString(intlLocale(locale)) })}</span>
        </li>;
      })}
    </ul>
    {topUp.status === "frozen" ? <span className="text-sm leading-6 text-amber-700 dark:text-amber-400">{t("billing.topUps.frozen")}</span> : null}
  </div>;
}

/**
 * The top-ups that count now or will start later, under Settings > Plan's Your
 * plan, the one that ends first first, and a bought one a dispute holds.
 * counted is false on a plan without allowances, such as Enterprise, where
 * nothing draws on them while it lasts.
 */
export function HeldTopUps({ topUps, locale, counted }: { topUps: BillingTopUpHolding[]; locale: string; counted: boolean }) {
  const { t } = useTranslation("settings");
  const shown = topUps.filter((topUp) => topUp.status === "active" || topUp.status === "scheduled" || topUp.status === "frozen");
  if (shown.length === 0) return null;
  return <div className="flex flex-col gap-4 border-t border-border pt-5">
    <div className="flex flex-col gap-1">
      <span className="text-base font-medium leading-6 text-foreground">{t("billing.topUps.title")}</span>
      <span className="text-sm leading-6 text-muted-foreground">{t(counted ? "billing.topUps.description" : "billing.topUps.notCounted")}</span>
    </div>
    <div className="flex flex-col gap-5">{shown.map((topUp) => <HeldTopUp key={topUp.id} locale={locale} topUp={topUp} />)}</div>
  </div>;
}

/** What a top-up code adds, how long it lasts, and the button that adds it; or that the business or the person already did. */
export function TopUpCodeOffer({ view, locale, busy, pending, onAdd }: { view: BillingTopUpCodeView; locale: string; busy: boolean; pending: boolean; onAdd: () => void }) {
  const { t } = useTranslation("settings");
  const lines = topUpAmountLines(view.gives, locale, t);
  const used = view.usedHere ? t("billing.topUps.code.usedHere") : view.usedByYou ? t("billing.topUps.code.usedByYou") : null;
  return <section aria-label={t("billing.topUps.code.adds")} className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-background p-5">
    <div className="flex flex-col gap-1">
      <span className="text-base font-medium text-foreground">{t("billing.topUps.code.adds")}</span>
      <ul className="mt-1 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {lines.map((line) => <li className="flex items-start gap-2 text-sm text-foreground" key={line.key}>
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <span>{line.text}</span>
        </li>)}
      </ul>
      <span className="mt-1 text-sm text-muted-foreground">{view.days === null ? t("billing.topUps.code.noEnd") : t("billing.topUps.code.lasts", { count: view.days })}</span>
      <span className="text-sm text-muted-foreground">{t("billing.topUps.code.planStays")}</span>
    </div>
    {used ? <p className="text-sm text-muted-foreground">{used}</p> : <Button className="self-start" disabled={busy} onClick={onAdd} size="sm" type="button">
      {pending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
      {pending ? t("billing.topUps.code.adding") : t("billing.topUps.code.add")}
    </Button>}
  </section>;
}

/** A top-up on sale: its name and price, what it adds, how long it lasts, and its Buy button. */
function TopUpOfferCard({ offer, locale, busy, pending, onBuy }: { offer: BillingTopUpOffer; locale: string; busy: boolean; pending: boolean; onBuy: () => void }) {
  const { t } = useTranslation("settings");
  const name = billingPlanName(offer.names, locale) ?? offer.code;
  return <section aria-label={name} className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-background p-5">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="text-[15px] font-medium leading-6 text-foreground">{name}</span>
      <span className="text-[15px] font-medium leading-6 tabular-nums text-foreground">{formatMoney(offer.amountCents, offer.currency, locale)}</span>
    </div>
    <ul className="flex flex-col gap-1.5">
      {topUpAmountLines(offer.gives, locale, t).map((line) => <li className="flex items-start gap-2 text-sm text-foreground" key={line.key}>
        <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        <span>{line.text}</span>
      </li>)}
    </ul>
    <span className="text-sm text-muted-foreground">{offer.days === null ? t("billing.topUps.buy.noEnd") : t("billing.topUps.buy.lasts", { count: offer.days })}</span>
    <Button className="self-start" disabled={busy && !pending} loading={pending} loadingLabel={t("billing.topUps.buy.buying")} onClick={onBuy} size="sm" type="button">
      {t("billing.topUps.buy.buy")}
    </Button>
  </section>;
}

/**
 * The top-ups on sale that the business may buy now, under Settings > Plan's
 * Your plan: on Free or a prepaid pack, for those who manage billing, through
 * a provider that sells them. Each opens the provider's payment page, as a
 * pack does; the person comes back with ?topUp=success, where the plan screen
 * waits for the payment. Nothing shows when none may be bought.
 */
export function TopUpOffers({ offers, businessId, locale }: { offers: BillingTopUpOffer[]; businessId: string; locale: string }) {
  const { t } = useTranslation("settings");
  const checkout = usePackCheckout(businessId, "top-up", "top_up");
  const prompt = checkout.emailPrompt;
  const buyable = offers.filter((offer) => offer.checkoutAvailable);
  if (buyable.length === 0) return null;
  return <div className="flex scroll-mt-24 flex-col gap-4 border-t border-border pt-5" id="top-ups">
    <div className="flex flex-col gap-1">
      <span className="text-base font-medium leading-6 text-foreground">{t("billing.topUps.buy.title")}</span>
      <span className="text-sm leading-6 text-muted-foreground">{t("billing.topUps.buy.description")}</span>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      {buyable.map((offer) => <TopUpOfferCard busy={checkout.pending} key={offer.code} locale={locale} offer={offer} onBuy={() => checkout.start(offer.code)} pending={checkout.pendingPack === offer.code} />)}
    </div>
    {prompt ? <BillingEmailForm key={`top-up:${prompt.pack}`} onCancel={checkout.dismissEmailPrompt} onSubmit={(billingEmail) => checkout.start(prompt.pack, billingEmail)} pending={checkout.pending} refusal={prompt.refusal} refusedEmail={prompt.email} /> : null}
  </div>;
}
