import Link from "next/link";

import { helpMarkdownPath, helpPath, type HelpLocale } from "@/lib/help/locales";
import { helpSections, type HelpWords } from "@/lib/help/registry";

import { HelpText } from "./help-text";

/** The help center's index: every page, under the dashboard's own groups. */
export function HelpIndexView({ locale, words }: { locale: HelpLocale; words: HelpWords }) {
  return (
    <div className="text-[15px] leading-7 text-muted-foreground">
      <h1 className="font-heading text-3xl leading-tight font-semibold tracking-tight text-foreground">{words.indexTitle}</h1>
      <p className="mt-3 text-lg leading-8">{words.indexIntro}</p>
      <p className="mt-4 text-sm"><a className="font-medium text-foreground underline-offset-4 hover:underline" href={helpMarkdownPath(locale)}>{words.markdownLink}</a></p>
      {helpSections(locale).map((group) => (
        <section aria-labelledby={`section-${group.section}`} className="mt-12" key={group.section}>
          <h2 className="font-heading text-xl font-semibold tracking-tight text-foreground" id={`section-${group.section}`}>{group.title}</h2>
          <p className="mt-1 text-sm leading-6">{group.description}</p>
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
            {group.articles.map((article) => (
              <li key={article.slug}>
                <Link className="block p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" href={helpPath(locale, article.slug)}>
                  <span className="font-medium text-foreground">{article.title}</span>
                  <span className="mt-1 block text-sm leading-6"><HelpText text={article.summary} /></span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
