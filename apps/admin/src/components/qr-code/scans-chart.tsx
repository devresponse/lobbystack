"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { intlLocale, resolveLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";

// A QR link's scans per day: the small line in its row of the QR links
// table, and the chart under its sign. The server counts scans per UTC day and
// sends a count for each of the last 30 days, so the days here are UTC days
// too, whatever the viewer's time zone.

/** A count per UTC day from `from` (YYYY-MM-DD), oldest first, today last. */
export type RecentScans = { from: string; counts: number[] };

export type ScanDay = { day: string; scans: number };

const DAY_MS = 86_400_000;

/** Each count with its UTC day, as YYYY-MM-DD. */
export function scanDays(scans: RecentScans): ScanDay[] {
  const start = Date.parse(`${scans.from}T00:00:00Z`);
  return scans.counts.map((count, index) => ({ day: new Date(start + index * DAY_MS).toISOString().slice(0, 10), scans: count }));
}

/** The scans in all, and the busiest day: the latest of the days with the most scans, or null without any. */
export function scanSummary(scans: RecentScans): { total: number; busiest: ScanDay | null } {
  let total = 0;
  let busiest: ScanDay | null = null;
  for (const day of scanDays(scans)) {
    total += day.scans;
    if (day.scans > 0 && (!busiest || day.scans >= busiest.scans)) busiest = day;
  }
  return { total, busiest };
}

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** Dates of UTC days in the dashboard's language. */
function useDayFormats() {
  const { i18n } = useTranslation();
  const locale = intlLocale(resolveLocale(i18n.resolvedLanguage, i18n.language));
  const short = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const long = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", timeZone: "UTC" });
  const numbers = new Intl.NumberFormat(locale);
  return {
    short: (day: string) => short.format(asDate(day)),
    weekday: (day: string) => weekday.format(asDate(day)),
    range: (from: string, to: string) => long.formatRange(asDate(from), asDate(to)),
    number: (value: number) => numbers.format(value),
  };
}

/** The 30 days as a small line, for a table row. Nothing for a link without scans. */
export function ScansSparkline({ counts, className }: { counts: readonly number[]; className?: string }) {
  const max = Math.max(0, ...counts);
  if (!max || counts.length < 2) return null;
  const width = 48;
  const height = 16;
  const step = width / (counts.length - 1);
  // A pixel of room top and bottom, so the line's round ends aren't cut off.
  const points = counts.map((count, index) => `${(index * step).toFixed(1)},${(height - 1 - (count / max) * (height - 2)).toFixed(1)}`).join(" ");
  return (
    <svg aria-hidden="true" className={cn("shrink-0 overflow-visible text-muted-foreground", className)} data-slot="scans-sparkline" focusable="false" height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
      <polyline fill="none" points={points} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} />
    </svg>
  );
}

/**
 * Scans per day under a link's sign: a column per day with the busiest one
 * dark, the highest count and 0 beside them, and a sentence that sums it up.
 * Pointing at a day shows its count; screen readers get the sentence and a
 * table of the days.
 */
export function ScansChart({ scans, className }: { scans: RecentScans; className?: string }) {
  const { t } = useTranslation("settings");
  const formats = useDayFormats();
  const id = useId();
  const [pointed, setPointed] = useState<number | null>(null);
  const days = scanDays(scans);
  if (!days.length) return null;
  const { total, busiest } = scanSummary(scans);
  const max = Math.max(...days.map((day) => day.scans));
  const first = days[0]!.day;
  const last = days[days.length - 1]!.day;
  const middle = days[Math.floor((days.length - 1) / 2)]!.day;
  const range = formats.range(first, last);
  const sentence = total
    ? `${t("qrCode.chart.summary", { count: total, total: formats.number(total), range })}${busiest ? ` ${t("qrCode.chart.busiest", { count: busiest.scans, scans: formats.number(busiest.scans), day: formats.weekday(busiest.day) })}` : ""}`
    : t("qrCode.chart.none", { range });
  const shown = pointed === null ? null : days[pointed] ?? null;

  return (
    <figure className={cn("flex w-full flex-col gap-2", className)} data-slot="scans-chart">
      <figcaption className="text-sm font-medium" id={`${id}-title`}>{t("qrCode.chart.title")}</figcaption>
      <div className="flex gap-2">
        <div aria-hidden="true" className="flex h-24 flex-col justify-between text-right text-xs/none tabular-nums text-muted-foreground">
          <span>{formats.number(max)}</span>
          <span>{formats.number(0)}</span>
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            aria-describedby={`${id}-summary`}
            aria-labelledby={`${id}-title`}
            className="flex h-24 items-end gap-0.5 border-b border-border"
            onPointerLeave={() => setPointed(null)}
            role="img"
          >
            {days.map((day, index) => (
              <div className="flex h-full min-w-0 flex-1 items-end justify-center" data-day={day.day} key={day.day} onPointerEnter={() => setPointed(index)}>
                <div
                  className={cn(
                    "w-full max-w-6 rounded-t-[4px] transition-colors",
                    busiest?.day === day.day ? "bg-foreground" : pointed === index ? "bg-muted-foreground/70" : "bg-muted-foreground/35",
                  )}
                  style={{ height: day.scans && max ? `max(2px, ${(day.scans / max) * 100}%)` : 0 }}
                />
              </div>
            ))}
          </div>
          {shown ? (
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute -top-7 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm ring-1 ring-foreground/10",
                pointed! < 4 ? "translate-x-0" : pointed! > days.length - 5 ? "-translate-x-full" : "-translate-x-1/2",
              )}
              style={{ left: `${((pointed! + (pointed! < 4 ? 0 : pointed! > days.length - 5 ? 1 : 0.5)) / days.length) * 100}%` }}
            >
              {t("qrCode.chart.day", { count: shown.scans, scans: formats.number(shown.scans), day: formats.weekday(shown.day) })}
            </div>
          ) : null}
          <div aria-hidden="true" className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>{formats.short(first)}</span>
            <span>{formats.short(middle)}</span>
            <span>{formats.short(last)}</span>
          </div>
        </div>
      </div>
      <p className="text-[13px]/[18px] text-muted-foreground" id={`${id}-summary`}>{sentence}</p>
      <table className="sr-only">
        <caption>{t("qrCode.chart.tableCaption", { range })}</caption>
        <thead><tr><th scope="col">{t("qrCode.chart.dayColumn")}</th><th scope="col">{t("qrCode.chart.scansColumn")}</th></tr></thead>
        <tbody>{days.map((day) => <tr key={day.day}><th scope="row">{formats.weekday(day.day)}</th><td>{formats.number(day.scans)}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
