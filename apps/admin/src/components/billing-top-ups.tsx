"use client";

import type { BillingTopUpAmounts, BillingTopUpCodeView, BillingTopUpHolding } from "@lobbystack/shared";
import { Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatDateTime, intlLocale } from "@/lib/locale";
import { Button } from "./ui/button";

// Top-ups on the plan screens (docs/features/top-ups.md): extra voice minutes,
// alert texts, transfers and website chats on top of the plan, which an
// operator grants or a top-up code adds. Settings > Plan lists those that
// count now or will under Your plan, and the promo code field shows what a
// top-up code adds before anyone adds it. The plan itself never changes.

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

/** One top-up: its note or where it came from, what each allowance has left of what it gave, and when it starts or ends. */
function HeldTopUp({ topUp, locale }: { topUp: BillingTopUpHolding; locale: string }) {
  const { t } = useTranslation("settings");
  const title = topUp.note ?? (topUp.code ? t("billing.topUps.fromCode", { code: topUp.code }) : t("billing.topUps.granted"));
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
  </div>;
}

/**
 * The top-ups that count now or will start later, under Settings > Plan's Your
 * plan, the one that ends first first. counted is false on a plan without
 * allowances, such as Enterprise, where nothing draws on them while it lasts.
 */
export function HeldTopUps({ topUps, locale, counted }: { topUps: BillingTopUpHolding[]; locale: string; counted: boolean }) {
  const { t } = useTranslation("settings");
  const shown = topUps.filter((topUp) => topUp.status === "active" || topUp.status === "scheduled");
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
