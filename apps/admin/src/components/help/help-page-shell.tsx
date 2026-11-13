import Link from "next/link";

import { helpMarkdownPath, helpPath, type HelpLocale } from "@/lib/help/locales";
import type { HelpWords } from "@/lib/help/registry";
import { localeTag } from "@/lib/locale";

import { HelpBrandLink } from "./help-brand-link";

const linkClass = "rounded-md text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * The frame every help page shares: the deployment's name and logo, a link to
 * the index, and nothing else that changes with the brand. The content's
 * language is set here, so it stays right when the reader's own interface
 * language differs.
 */
export function HelpPageShell({ children, locale, words }: { children: React.ReactNode; locale: HelpLocale; words: HelpWords }) {
  return (
    <div className="flex min-h-svh w-full flex-col bg-background text-foreground" lang={localeTag(locale)}>
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between gap-4 px-6">
          <HelpBrandLink />
          <Link className={linkClass} href={helpPath(locale)}>{words.helpCenter}</Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10 sm:py-12">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-6">
          <Link className={linkClass} href={helpPath(locale)}>{words.allTopics}</Link>
          <a className={linkClass} href={helpMarkdownPath(locale)}>{words.markdownLink}</a>
        </div>
      </footer>
    </div>
  );
}
