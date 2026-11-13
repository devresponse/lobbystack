import { HELP_LOCALES, isHelpLocale } from "@/lib/help/locales";
import { helpMarkdown } from "@/lib/help/markdown";

// Every help page in one Markdown file, for AI assistants and knowledge bases.
// It is built from the same articles as the pages, once per language with help.

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return HELP_LOCALES.map((locale) => ({ locale }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isHelpLocale(locale)) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(helpMarkdown(locale), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
