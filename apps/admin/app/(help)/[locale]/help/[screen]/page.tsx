import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { HelpArticleView } from "@/components/help/help-article-view";
import { HelpPageShell } from "@/components/help/help-page-shell";
import { helpLocaleFor, isHelpLocale } from "@/lib/help/locales";
import { helpArticle, helpArticles, helpWords } from "@/lib/help/registry";

// One help page for one screen of the app, built for each language that has
// help (apps/admin/src/lib/help).

export const dynamicParams = false;

type HelpScreenProps = { params: Promise<{ locale: string; screen: string }> };

// Never an empty list: a language left without pages would leave this route
// with no page built at all.
export function generateStaticParams({ params }: { params: { locale: string } }) {
  return helpArticles(helpLocaleFor(params.locale)).map((article) => ({ screen: article.slug }));
}

export async function generateMetadata({ params }: HelpScreenProps): Promise<Metadata> {
  const { locale, screen } = await params;
  if (!isHelpLocale(locale)) return {};
  const article = helpArticle(locale, screen);
  if (!article) return {};
  return { title: helpWords(locale).pageTitle(article.title), description: article.summary.replace(/\*\*|`/g, ""), keywords: article.keywords ? [...article.keywords] : undefined };
}

export default async function HelpScreenPage({ params }: HelpScreenProps) {
  const { locale, screen } = await params;
  if (!isHelpLocale(locale)) notFound();
  const article = helpArticle(locale, screen);
  if (!article) notFound();
  const words = helpWords(locale);
  return (
    <HelpPageShell locale={locale} words={words}>
      <HelpArticleView article={article} locale={locale} words={words} />
    </HelpPageShell>
  );
}
