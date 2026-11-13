import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { HelpIndexView } from "@/components/help/help-index-view";
import { HelpPageShell } from "@/components/help/help-page-shell";
import { isHelpLocale } from "@/lib/help/locales";
import { helpWords } from "@/lib/help/registry";

// The help center's index, built for each language that has help.

type HelpIndexProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: HelpIndexProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isHelpLocale(locale)) return {};
  const words = helpWords(locale);
  return { title: words.indexTitle, description: words.indexDescription };
}

export default async function HelpIndexPage({ params }: HelpIndexProps) {
  const { locale } = await params;
  if (!isHelpLocale(locale)) notFound();
  const words = helpWords(locale);
  return (
    <HelpPageShell locale={locale} words={words}>
      <HelpIndexView locale={locale} words={words} />
    </HelpPageShell>
  );
}
