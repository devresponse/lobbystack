"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BookOpenText, CalendarCheck, Clock3, LoaderCircle, PhoneIncoming } from "lucide-react";
import { brandPalette, currentBrand, intlLocale, localizedBrandText, type BrandPalette, type BrandSignInPage, type BrandText } from "@lobbystack/shared";

import { useBranding } from "@/components/branding-provider";
import { ScreenHelpButton } from "@/components/screen-help-button";
import { brandLogoSrc } from "@/lib/branding-snapshot";
import { resolveLocale } from "@/lib/locale";
import { privacyHref, termsHref } from "@/lib/marketing-site-url";
import { cn } from "@/lib/utils";

/**
 * The brand's colours as CSS variables, for an element marked
 * data-brand-scope: the accent and the text on it, and the accent as text or
 * a line on each theme's page where it contrasts enough (theme.css falls
 * back to the page's text colour elsewhere).
 */
export function brandScopeStyle(palette: BrandPalette = brandPalette()): CSSProperties {
  return {
    "--brand": palette.accent,
    "--brand-foreground": palette.onAccent,
    ...(palette.text.light ? { "--brand-text-light": palette.text.light } : {}),
    ...(palette.text.dark ? { "--brand-text-dark": palette.text.dark } : {}),
    ...(palette.line.light ? { "--brand-line-light": palette.line.light } : {}),
    ...(palette.line.dark ? { "--brand-line-dark": palette.line.dark } : {}),
  } as CSSProperties;
}

// The brand's accent on a signed-out page's form: a filled button with
// readable text on it, a focus ring and an underline under links. Text and
// outlines read against the page take the accent only where it contrasts
// enough (brandPalette), so they need an AuthShell around them.
export const brandInput = "h-11 focus-visible:border-brand-line focus-visible:ring-brand/35";
export const brandButton = "h-11 w-full border-brand-line/25 bg-brand text-brand-foreground hover:bg-[color-mix(in_oklab,var(--brand)_88%,black)] focus-visible:border-brand-line focus-visible:ring-brand/40";
export const brandLink = "font-medium text-foreground underline decoration-brand decoration-2 underline-offset-4 hover:decoration-brand-line";

type AuthShellProps = {
  /** A short note above the title, such as who is asking. */
  eyebrow?: string;
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Replaces the terms and privacy links at the foot of the form. */
  legalFooter?: ReactNode;
  progress?: { current: number; total: number } | null;
  /** Shows a spinner in place of the form, as while the session is checked. */
  pending?: string;
};

/**
 * The signed-out pages: the screen split in two on a large screen, the brand's
 * panel filling the left half from top to bottom and the form on the right; a
 * band of the panel above the form on a phone. No rounded corners on either. Everything in it comes from the
 * brand file's name, logo and accent, so any brand gets its own colours.
 */
export function AuthShell({ eyebrow, title, description, children, legalFooter, progress, pending }: AuthShellProps) {
  const { t, i18n } = useTranslation("onboarding");
  const marketingLocale = resolveLocale(i18n?.resolvedLanguage, i18n?.language);
  const style = useMemo(() => brandScopeStyle(), []);
  return (
    <div className="flex min-h-svh w-full flex-col bg-background text-foreground lg:flex-row" data-brand-scope="" style={style}>
      <AuthBrandPanel />
      <div className="relative flex flex-1 flex-col">
        <div className="absolute right-3 top-0 hidden h-11 items-center lg:flex">
          <ScreenHelpButton size="icon" />
        </div>
        <main className="flex flex-1 flex-col items-center px-6 pb-6 pt-9 sm:px-10 lg:pt-14">
          <div className="flex w-full max-w-sm flex-col lg:my-auto">
            {pending ? (
              <div className="flex justify-center py-16" role="status">
                <LoaderCircle aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
                <span className="sr-only">{pending}</span>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {eyebrow ? <span className="mb-2 inline-flex w-fit items-center rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">{eyebrow}</span> : null}
                  <h1 className="font-heading text-3xl leading-tight font-semibold tracking-tight text-foreground">{title}</h1>
                  {description ? <p className="text-[15px] leading-7 text-muted-foreground">{description}</p> : null}
                </div>
                <div className="mt-8 w-full">{children}</div>
              </>
            )}
          </div>
        </main>
        <footer className="flex flex-col items-center gap-4 px-6 pb-8 pt-6">
          {progress ? <ProgressDots current={progress.current} total={progress.total} /> : null}
          {legalFooter ?? (
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <a className="hover:text-foreground" href={termsHref(marketingLocale)} rel="noreferrer" target="_blank">{t("shell.terms")}</a>
              <span aria-hidden="true">·</span>
              <a className="hover:text-foreground" href={privacyHref(marketingLocale)} rel="noreferrer" target="_blank">{t("shell.privacy")}</a>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <nav aria-label={`Onboarding progress: step ${current} of ${total}`}>
      <ol className="flex items-center justify-center gap-1.5">
        {Array.from({ length: total }, (_, index) => index + 1).map((step) => {
          const active = step === current;
          return (
            <li className="flex" key={step}>
              <span
                aria-current={active ? "step" : undefined}
                aria-label={`Onboarding step ${step}${active ? ", current step" : ""}`}
                className={cn("h-1.5 rounded-full", active ? "w-6 bg-brand ring-1 ring-brand-line/25 ring-inset" : step < current ? "w-1.5 bg-brand/50" : "w-1.5 bg-border")}
                role="img"
              />
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const POINTS = [
  { key: "answer", Icon: Clock3 },
  { key: "learn", Icon: BookOpenText },
  { key: "book", Icon: CalendarCheck },
] as const;

/**
 * The brand's side of the page: its logo and name, what the product does, and
 * an example call. A brand file's signInPage section may set its own words for
 * each part, and a dark panel; the shared words stand in for the rest.
 */
function AuthBrandPanel({ page = currentBrand().signInPage }: { page?: BrandSignInPage }) {
  const { t, i18n } = useTranslation("auth");
  const locale = resolveLocale(i18n?.resolvedLanguage, i18n?.language);
  const words = (value: BrandText | null, key: string) => (value ? localizedBrandText(value, locale) : t(key));
  const points = page.points
    ? page.points.map((point, index) => ({ Icon: POINTS[index % POINTS.length]!.Icon, text: localizedBrandText(point, locale) }))
    : POINTS.map(({ key, Icon }) => ({ Icon, text: t(`panel.points.${key}`) }));
  return (
    // A dark panel takes the dark theme inside it, in light mode too.
    <section className={cn("auth-brand-panel relative isolate overflow-hidden lg:sticky lg:top-0 lg:h-svh lg:w-1/2 lg:shrink-0", page.panel === "dark" && "dark")}>
      <div aria-hidden="true" className="auth-brand-glow pointer-events-none absolute inset-0 -z-10" />
      <div aria-hidden="true" className="auth-brand-dots pointer-events-none absolute inset-0 -z-10" />
      <div className="flex h-full flex-col px-6 pb-7 pt-4 sm:px-10 lg:mx-auto lg:w-full lg:max-w-[46rem] lg:px-12 lg:pb-10 lg:pt-9 xl:px-14">
        <div className="flex h-11 items-center justify-between gap-4">
          <PanelLockup />
          <ScreenHelpButton buttonClassName="text-current hover:text-current hover:opacity-75" className="-mr-2 lg:hidden" size="icon" />
        </div>
        <div className="mt-6 lg:mt-auto lg:pt-10">
          <p className="max-w-[16ch] text-balance font-heading text-[1.75rem] leading-[1.1] font-semibold tracking-tight sm:max-w-[20ch] sm:text-4xl lg:text-[2.75rem] lg:leading-[1.05] xl:text-5xl">{words(page.headline, "panel.headline")}</p>
          <p className="mt-3 hidden max-w-md text-[15px] leading-7 text-(--panel-muted) sm:block lg:mt-4 lg:text-[17px]">{words(page.description, "panel.description")}</p>
        </div>
        <ConversationPreview call={page.exampleCall} className="mt-10 hidden [@media(min-height:46rem)]:lg:block" />
        <ul className="mt-10 hidden grid-cols-3 gap-6 [@media(min-height:54rem)]:lg:grid">
          {points.map(({ Icon, text }, index) => (
            <li className="flex flex-col gap-3 text-sm leading-5 font-medium" key={index}>
              <span className="grid size-9 place-items-center rounded-full bg-(--panel-hairline)"><Icon aria-hidden="true" className="size-4" /></span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * The logo on a white tile, so a logo of any colour shows on any accent and in
 * dark mode, beside the name. (bg-white would follow the theme: globals.css
 * maps it to the card colour.)
 */
function PanelLockup() {
  const { appName, logoUrl, ready } = useBranding();
  // Hold the space until a prerendered page knows the name, so it never flashes another one.
  if (!ready) return <div aria-hidden="true" className="h-10" />;
  const logo = brandLogoSrc({ appName, logoUrl });
  return (
    <div aria-label={appName} className="flex min-w-0 items-center gap-3">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-[#fff] text-lg font-semibold text-neutral-900 shadow-sm ring-1 ring-black/5">
        {logo ? <img alt="" className="size-full object-contain p-1" draggable={false} src={logo} /> : Array.from(appName)[0]?.toUpperCase()}
      </span>
      <span aria-hidden="true" className="truncate font-heading text-lg leading-none font-semibold">{appName}</span>
    </div>
  );
}

/**
 * An example call, its lines coming in one after another: what the
 * receptionist does, shown rather than told. A brand's own call takes turns
 * from the caller's first line.
 */
function ConversationPreview({ call, className }: { call: BrandSignInPage["exampleCall"]; className?: string }) {
  const { t, i18n } = useTranslation("auth");
  const locale = resolveLocale(i18n?.resolvedLanguage, i18n?.language);
  // A Saturday at 10:00, in the reader's own format.
  const bookedAt = new Intl.DateTimeFormat(intlLocale(locale), { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(2026, 10, 21, 10));
  const lines: ReadonlyArray<{ from: "caller" | "agent"; text: string }> = call
    ? call.lines.map((line, index) => ({ from: index % 2 === 0 ? "caller" : "agent", text: localizedBrandText(line, locale) }))
    : [
      { from: "caller", text: t("panel.preview.caller1") },
      { from: "agent", text: t("panel.preview.agent1") },
      { from: "caller", text: t("panel.preview.caller2") },
      { from: "agent", text: t("panel.preview.agent2") },
    ];
  const booked = call?.booked ? localizedBrandText(call.booked, locale) : t("panel.preview.booked");
  const delay = (index: number) => ({ "--rise-delay": `${400 + index * 650}ms` }) as CSSProperties;
  return (
    <figure aria-label={t("panel.preview.label")} className={cn("w-full max-w-[27rem] rounded-2xl bg-[#fff] p-4 text-neutral-900 shadow-[0_28px_60px_-24px_rgb(0_0_0/0.45)] ring-1 ring-black/5 dark:bg-neutral-900/90 dark:text-neutral-50 dark:ring-white/10", className)}>
      <div className="flex items-center gap-3 border-b border-neutral-200/80 pb-3 dark:border-white/10">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground"><PhoneIncoming aria-hidden="true" className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 font-semibold">{t("panel.preview.title")}</p>
          <p className="truncate text-xs leading-4 text-neutral-500 dark:text-neutral-400">{t("panel.preview.subtitle")}</p>
        </div>
        <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          <span aria-hidden="true" className="auth-live-dot size-1.5 rounded-full bg-emerald-500" />
          {t("panel.preview.status")}
        </span>
      </div>
      <ol className="mt-3 flex flex-col gap-2">
        {lines.map((line, index) => (
          <li className={cn("auth-rise flex", line.from === "agent" ? "justify-end" : "justify-start")} key={index} style={delay(index)}>
            <span className={cn("max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-5", line.from === "agent" ? "rounded-br-md bg-brand text-brand-foreground" : "rounded-bl-md bg-neutral-100 text-neutral-900 dark:bg-white/10 dark:text-neutral-50")}>{line.text}</span>
          </li>
        ))}
      </ol>
      <div className="auth-rise mt-3 flex items-center gap-2 rounded-xl bg-neutral-50 px-3 py-2.5 text-xs font-medium dark:bg-white/5" style={delay(lines.length)}>
        <CalendarCheck aria-hidden="true" className="size-4 text-emerald-600 dark:text-emerald-400" />
        <span>{booked}</span>
        <span className="ml-auto text-neutral-500 dark:text-neutral-400">{bookedAt}</span>
      </div>
    </figure>
  );
}
