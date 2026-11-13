import Link from "next/link";

import { helpPath, type HelpLocale } from "@/lib/help/locales";
import { helpArticle, type HelpWords } from "@/lib/help/registry";
import type { HelpArticle } from "@/lib/help/types";

import { HelpArticleBody } from "./help-article-body";
import { HelpText } from "./help-text";

/** One help page: the screen's name and purpose, then each part the article has, in the same order on every page. */
export function HelpArticleView({ article, locale, words }: { article: HelpArticle; locale: HelpLocale; words: HelpWords }) {
  const related = (article.related ?? []).map((slug) => helpArticle(locale, slug)).filter((page): page is HelpArticle => Boolean(page));
  return (
    <article className="text-[15px] leading-7 text-muted-foreground">
      <nav aria-label={words.breadcrumb}>
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          <li><Link className="font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href={helpPath(locale)}>{words.helpCenter}</Link></li>
          <li aria-hidden="true">/</li>
          <li>{words.sections[article.section]}</li>
        </ol>
      </nav>
      <h1 className="mt-4 font-heading text-3xl leading-tight font-semibold tracking-tight text-foreground">{article.title}</h1>
      <p className="mt-3 text-lg leading-8"><HelpText text={article.summary} /></p>
      <HelpArticleBody
        article={article}
        related={related.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {related.map((page) => (
              <li key={page.slug}>
                <Link className="block p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" href={helpPath(locale, page.slug)}>
                  <span className="font-medium text-foreground">{page.title}</span>
                  <span className="mt-1 block text-sm leading-6"><HelpText text={page.summary} /></span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        variant="page"
        words={words}
      />
      {article.keywords?.length ? <p className="mt-12 text-sm"><span className="font-medium text-foreground">{words.headings.keywords}:</span> {article.keywords.join(", ")}</p> : null}
    </article>
  );
}
