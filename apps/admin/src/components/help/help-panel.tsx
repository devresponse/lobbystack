"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { ArrowLeftIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, buttonVariants } from "@/components/ui/button";
import { SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { helpLocaleFor, helpPath, isHelpLocale } from "@/lib/help/locales";
import type { HelpArticle } from "@/lib/help/types";
import { localeTag } from "@/lib/locale";
import { cn } from "@/lib/utils";

import { HelpArticleBody } from "./help-article-body";
import { HelpText } from "./help-text";

type HelpRegistry = typeof import("@/lib/help/registry");

let registryLoad: Promise<HelpRegistry> | null = null;
let loadedRegistry: HelpRegistry | null = null;

/**
 * The help articles arrive with the panel's first opening, as one file, so
 * the screens themselves don't carry them. A failed load is tried again on the
 * next call.
 */
export function loadHelpRegistry(): Promise<HelpRegistry> {
  registryLoad ??= import("@/lib/help/registry").then(
    (registry) => {
      loadedRegistry = registry;
      return registry;
    },
    (error: unknown) => {
      registryLoad = null;
      throw error;
    },
  );
  return registryLoad;
}

type HelpView = { kind: "article"; slug: string } | { kind: "index" };

const listButton = "block w-full p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * What the help panel shows: the article for the screen at `pathname`, or
 * every topic when no article explains it. Related pages and topics open in
 * the panel too, and Back returns to the previous one. `titleRef` is the
 * panel's title, which takes the focus when the panel opens and after each
 * move, so the reader starts at the top; it stays the same element while the
 * articles load. The title scrolls with the page and stays at its top, so the
 * keys that scroll a page work from it.
 */
export function HelpPanelBody({ pathname, titleRef }: { pathname: string; titleRef: React.RefObject<HTMLHeadingElement | null> }) {
  const { t, i18n } = useTranslation("common");
  const interfaceLanguage = i18n.resolvedLanguage ?? i18n.language;
  const locale = helpLocaleFor(interfaceLanguage);
  const [registry, setRegistry] = useState<HelpRegistry | null>(loadedRegistry);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<HelpView[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  // The header stays at the top of the scrolling page, so the page keeps clear
  // of it: a control that takes the focus scrolls into view below it, and Page
  // Down moves by what shows under it. --help-header holds the header's height
  // for the classes that do this.
  useEffect(() => {
    const header = headerRef.current;
    const scroller = scrollRef.current;
    if (!header || !scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => scroller.style.setProperty("--help-header", `${header.offsetHeight}px`));
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (registry) return;
    let active = true;
    loadHelpRegistry().then(
      (loaded) => { if (active) setRegistry(loaded); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [attempt, registry]);

  const words = registry?.helpWords(locale);
  const screenSlug = registry?.helpSlugForPath(locale, pathname) ?? null;
  const view: HelpView = history.at(-1) ?? (screenSlug ? { kind: "article", slug: screenSlug } : { kind: "index" });
  const article = registry && view.kind === "article" ? registry.helpArticle(locale, view.slug) : undefined;
  const related = registry && article ? (article.related ?? []).map((slug) => registry.helpArticle(locale, slug)).filter((page): page is HelpArticle => Boolean(page)) : [];
  const eyebrow = words && article ? (article.slug === screenSlug ? t("help.screen") : words.sections[article.section]) : null;
  const contentLanguage = localeTag(locale);

  // The new view is drawn before its title takes the focus: the control that
  // was used is often gone by then, and the title already reads the new name.
  function move(next: HelpView[]) {
    flushSync(() => setHistory(next));
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    titleRef.current?.focus();
  }
  const open = (next: HelpView) => move([...history, next]);

  return (
    <>
      <div className="min-h-0 flex-1 scroll-pt-(--help-header) overflow-y-auto overscroll-contain" ref={scrollRef}>
        {/*
          No z-index: the header must stay under the panel's close button. Its
          own controls are always in view, so their scroll margins move them
          below it, where the page's padding expects them: Back and the title
          take the focus without scrolling the page.
        */}
        <SheetHeader className="sticky top-0 gap-1 border-b border-border bg-popover px-6 py-5 pr-14 *:-scroll-mt-(--help-header) *:scroll-mb-(--help-header)" ref={headerRef}>
          {history.length ? (
            <Button className="-ml-2.5 mb-1 self-start" onClick={() => move(history.slice(0, -1))} size="xs" type="button" variant="ghost">
              <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
              {t("help.back")}
            </Button>
          ) : null}
          {eyebrow ? <p className="text-xs font-medium text-muted-foreground" lang={article && article.slug !== screenSlug ? contentLanguage : undefined}>{eyebrow}</p> : null}
          <SheetTitle className="font-heading text-xl leading-tight font-semibold tracking-tight outline-none" lang={words ? contentLanguage : undefined} ref={titleRef} tabIndex={-1}>
            {article ? article.title : words ? words.indexTitle : t("help.screen")}
          </SheetTitle>
          {isHelpLocale(interfaceLanguage) ? null : <p className="text-xs text-muted-foreground">{t("help.englishOnly")}</p>}
        </SheetHeader>

        <div className="px-6 pb-10 pt-6 text-[15px] leading-7 text-muted-foreground" lang={words ? contentLanguage : undefined}>
          {!registry || !words ? (
            <div aria-busy={!failed} className="flex flex-col items-center gap-4 py-12 text-center text-sm" role="status">
              {failed ? (
                <>
                  <p>{t("help.failed")}</p>
                  <Button onClick={() => { titleRef.current?.focus(); setFailed(false); setAttempt((count) => count + 1); }} size="sm" type="button" variant="outline">{t("help.retry")}</Button>
                </>
              ) : (
                <>
                  <LoaderCircleIcon aria-hidden="true" className="size-5 animate-spin" />
                  <p>{t("help.loading")}</p>
                </>
              )}
            </div>
          ) : article ? (
            <>
              <SheetDescription className="text-base leading-7 text-muted-foreground"><HelpText text={article.summary} /></SheetDescription>
              <HelpArticleBody
                article={article}
                related={related.length ? (
                  <ul className="divide-y divide-border rounded-xl border border-border">
                    {related.map((page) => (
                      <li key={page.slug}>
                        <button className={listButton} onClick={() => open({ kind: "article", slug: page.slug })} type="button">
                          <span className="font-medium text-foreground">{page.title}</span>
                          <span className="mt-1 block text-sm leading-6"><HelpText text={page.summary} /></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                variant="panel"
                words={words}
              />
            </>
          ) : (
            <>
              <SheetDescription className="text-base leading-7 text-muted-foreground">{words.indexDescription}</SheetDescription>
              {registry.helpSections(locale).map((group) => (
                <section aria-labelledby={`help-panel-section-${group.section}`} className="mt-10" key={group.section}>
                  <h3 className="font-heading text-lg font-semibold tracking-tight text-foreground" id={`help-panel-section-${group.section}`}>{group.title}</h3>
                  <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
                    {group.articles.map((page) => (
                      <li key={page.slug}>
                        <button className={listButton} onClick={() => open({ kind: "article", slug: page.slug })} type="button">
                          <span className="font-medium text-foreground">{page.title}</span>
                          <span className="mt-1 block text-sm leading-6"><HelpText text={page.summary} /></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Once the help has loaded, or to reach the help center when it can't. */}
      {words || failed ? (
        <SheetFooter className="mt-0 flex-row flex-wrap items-center justify-between gap-2 border-t border-border px-6 py-4">
          <a className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "-ml-3")} href={helpPath(locale, article?.slug)} rel="noopener noreferrer" target="_blank">
            {t("help.openPage")}
            <ExternalLinkIcon aria-hidden="true" data-icon="inline-end" />
          </a>
          {article ? (
            <Button onClick={() => open({ kind: "index" })} size="sm" type="button" variant="outline">{t("help.allTopics")}</Button>
          ) : null}
        </SheetFooter>
      ) : null}
    </>
  );
}
