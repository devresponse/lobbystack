import { helpArticle, helpArticles, helpWords, type HelpWords } from "./registry";
import { helpPath, type HelpLocale } from "./locales";
import type { HelpArticle } from "./types";

// Help text already uses Markdown's own marks for bold and code, so it goes
// into the file as written.

function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/** One help page as Markdown: a level-one heading, then the page's parts in the order the page shows them. */
export function helpArticleMarkdown(article: HelpArticle, locale: HelpLocale, words: HelpWords = helpWords(locale)): string {
  const blocks: string[] = [
    `# ${article.title}`,
    article.summary,
    list([
      `${words.facts.location}: ${article.location.join(" > ")}`,
      `${words.facts.access}: ${article.access}`,
      `${words.facts.address}: ${article.screenPaths.map((path) => `\`${path}\``).join(", ")}`,
      `${words.facts.page}: ${helpPath(locale, article.slug)}`,
    ]),
    `## ${words.headings.purpose}`,
    ...article.purpose,
  ];
  if (article.areas?.length) {
    blocks.push(`## ${words.headings.areas}`, list(article.areas.map((area) => `**${area.name}**: ${area.description}`)));
  }
  if (article.fields?.length) {
    blocks.push(`## ${words.headings.fields}`);
    for (const group of article.fields) {
      blocks.push(`### ${group.title}`);
      if (group.description) blocks.push(group.description);
      blocks.push(list(group.fields.map((field) => `**${field.name}**${field.requirement ? ` (${words.requirements[field.requirement]})` : ""}: ${field.description}`)));
    }
  }
  if (article.tasks?.length) {
    blocks.push(`## ${words.headings.tasks}`);
    for (const task of article.tasks) blocks.push(`### ${task.title}`, task.steps.map((step, index) => `${index + 1}. ${step}`).join("\n"));
  }
  if (article.notes?.length) blocks.push(`## ${words.headings.notes}`, list(article.notes));
  if (article.troubleshooting?.length) {
    blocks.push(`## ${words.headings.troubleshooting}`);
    for (const entry of article.troubleshooting) blocks.push(`### ${entry.question}`, entry.answer);
  }
  const related = (article.related ?? []).map((slug) => helpArticle(locale, slug)).filter((page): page is HelpArticle => Boolean(page));
  if (related.length) blocks.push(`## ${words.headings.related}`, list(related.map((page) => `${page.title} (${helpPath(locale, page.slug)}): ${page.summary}`)));
  if (article.keywords?.length) blocks.push(`${words.headings.keywords}: ${article.keywords.join(", ")}.`);
  return `${blocks.join("\n\n")}\n`;
}

/** Every help page in the language as one Markdown file, in the index's order. */
export function helpMarkdown(locale: HelpLocale): string {
  const words = helpWords(locale);
  return [`${words.markdownIntro}\n`, ...helpArticles(locale).map((article) => helpArticleMarkdown(article, locale, words))].join("\n---\n\n");
}
