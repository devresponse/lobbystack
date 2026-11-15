"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BookOpenText, CalendarCheck, Clock3, LoaderCircle } from "lucide-react";
import { brandPalette, currentBrand, localizedBrandText, type BrandPalette, type BrandSignInPage, type BrandText } from "@lobbystack/shared";

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
 * The signed-out pages. On a large screen the page splits in two: the brand's
 * panel fills the left half from top to bottom, square, and the form the
 * right half. On a phone the panel is a band above the form, its words in the
 * form's column. Everything in it comes from the brand file's name, logo,
 * accent and words, so any brand gets its own colours.
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
        {/* On a large screen the space above the form matches the space that holds the footer, so the form sits in the middle of the page, level with the panel's words, however tall the footer is. */}
        <div aria-hidden="true" className="hidden lg:block lg:flex-1" />
        <main className="flex flex-1 flex-col items-center px-6 pb-6 pt-9 sm:px-10 lg:flex-none lg:py-8">
          <div className="flex w-full max-w-sm flex-col">
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
        <div className="flex flex-col lg:flex-1 lg:justify-end">
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
 * The brand's side of the page: its logo and name at the top, and in the
 * middle what the product does, a headline, a sentence and three points. A
 * brand file's signInPage section may set its own words for each part, and a
 * dark panel; the shared words stand in for the rest.
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
    <section className={cn("auth-brand-panel relative isolate overflow-hidden px-6 sm:px-10 lg:sticky lg:top-0 lg:h-svh lg:w-1/2 lg:shrink-0 lg:px-0", page.panel === "dark" && "dark")}>
      <div aria-hidden="true" className="auth-brand-glow pointer-events-none absolute inset-0 -z-10" />
      <div aria-hidden="true" className="auth-brand-dots pointer-events-none absolute inset-0 -z-10" />
      {/* Below 1024 pixels the band's column is the form's (max-w-sm), so their edges line up. */}
      <div className="mx-auto flex h-full w-full max-w-sm flex-col pb-7 pt-4 lg:max-w-[46rem] lg:px-12 lg:py-9 xl:px-14">
        <div className="flex h-11 shrink-0 items-center justify-between gap-4">
          <PanelLockup />
          <ScreenHelpButton buttonClassName="text-current hover:text-current hover:opacity-75" className="-mr-2 lg:hidden" size="icon" />
        </div>
        <div className="mt-6 lg:my-auto lg:py-8">
          <p className="max-w-[16ch] text-balance font-heading text-[1.75rem] leading-[1.1] font-semibold tracking-tight sm:max-w-[20ch] sm:text-4xl xl:text-[2.75rem] xl:leading-[1.05] 2xl:text-5xl">{words(page.headline, "panel.headline")}</p>
          <p className="mt-3 hidden max-w-md text-[15px] leading-7 text-(--panel-muted) sm:block lg:mt-4 lg:text-[17px]">{words(page.description, "panel.description")}</p>
          <ul className="mt-10 hidden max-w-md flex-col gap-4 [@media(min-height:40rem)]:lg:flex">
            {points.map(({ Icon, text }, index) => (
              <li className="flex items-center gap-3 text-[15px] leading-6 font-medium" key={index}>
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-(--panel-hairline)"><Icon aria-hidden="true" className="size-4" /></span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
        {/* As tall as the logo's row, so the words sit in the middle of the half, level with the form beside them. */}
        <div aria-hidden="true" className="hidden h-11 shrink-0 lg:block" />
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
