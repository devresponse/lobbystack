import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HELP_LOCALES, helpPath } from "./locales";
import { helpMarkdown } from "./markdown";
import { helpArticle, helpArticles, helpSections, helpSlugForPath, helpWords } from "./registry";
import { HELP_BANNED_TERMS, termPattern, validateHelpArticle } from "./validate";

const adminRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repoRoot = join(adminRoot, "../..");

/**
 * Every brand's name, support address and domains. Help is written for any
 * brand, today's and future ones, so none of them may appear in it.
 */
function brandTerms(): string[] {
  const brandsDir = join(repoRoot, "brands");
  const terms = new Set<string>();
  for (const entry of readdirSync(brandsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    terms.add(entry.name);
    const brand = JSON.parse(readFileSync(join(brandsDir, entry.name, "brand.json"), "utf8")) as { appName?: string; contactEmail?: string; links?: Record<string, string> };
    if (brand.appName) terms.add(brand.appName);
    if (brand.contactEmail) terms.add(brand.contactEmail);
    // The brand's own sites; links to the outside apps it lists are not its own.
    for (const key of ["site", "docs", "terms", "privacy"]) {
      const link = brand.links?.[key];
      if (link) terms.add(new URL(link).hostname.replace(/^www\./, ""));
    }
  }
  const index = JSON.parse(readFileSync(join(brandsDir, "index.json"), "utf8")) as { domains?: Record<string, string> };
  for (const domain of Object.keys(index.domains ?? {})) terms.add(domain);
  return [...terms];
}

/**
 * Every page of the app, as the addresses people open: route groups, slots and
 * the language left out, [name] written {name}. Private folders (_name) hold
 * no pages.
 */
function pageRoutes(): string[] {
  const root = join(adminRoot, "app");
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!name.startsWith("_")) walk(path);
      } else if (/^page\.(?:tsx|ts|jsx|js|mdx)$/.test(name)) {
        const parts = relative(root, dir).split(sep).filter((part) => part && !/^\(.+\)$/.test(part) && !part.startsWith("@") && part !== "[locale]");
        routes.push(`/${parts.map((part) => part.replace(/^\[(.+)\]$/, "{$1}")).join("/")}`);
      }
    }
  };
  walk(root);
  return routes;
}

// Every page of the app, wherever it lives, so a new screen can't go without help.
const SCREENS = pageRoutes();

// Pages with no help page of their own, and why.
const NOT_SCREENS: Record<string, string> = {
  "/agent/integrations": "redirects to /agent",
  "/settings": "redirects to /settings/usage",
  "/onboarding/verify-phone": "an old address that sends people to their current onboarding step",
  "/onboarding/verify-phone/code": "an old address that sends people to their current onboarding step",
  "/help": "the help center",
  "/help/{screen}": "a help page",
  "/embed/{key}": "the website widget's chat window, which a business's visitors see",
  "/profile/{slug}": "a business's public page, for its callers and visitors",
  "/profile/{slug}/{handle}": "a receptionist's public page, for its callers and visitors",
};

it("names only real pages as having no help page", () => {
  for (const screen of Object.keys(NOT_SCREENS)) expect(SCREENS, `${screen} is no longer a page: remove it from NOT_SCREENS`).toContain(screen);
});

/** An address for a screen path, with a sample value for each {name} part. */
function sampleAddress(screenPath: string): string {
  return screenPath.replace(/\{[^}]+\}/g, "sample-id");
}

describe.each(HELP_LOCALES)("%s help", (locale) => {
  const articles = helpArticles(locale);
  const slugs = new Set(articles.map((article) => article.slug));
  const bannedTerms = brandTerms();

  it("keeps the words around the pages brand-neutral", () => {
    const words = helpWords(locale);
    const texts = [
      words.helpCenter,
      words.indexTitle,
      words.indexDescription,
      words.indexIntro,
      words.markdownLink,
      words.markdownIntro,
      words.breadcrumb,
      words.allTopics,
      words.pageTitle("Page"),
      ...Object.values(words.sections),
      ...Object.values(words.sectionDescriptions),
      ...Object.values(words.facts),
      ...Object.values(words.headings),
      ...Object.values(words.requirements),
    ];
    const patterns = [...HELP_BANNED_TERMS, ...bannedTerms].map((term) => [term, termPattern(term)] as const);
    const named = texts.flatMap((text) => patterns.filter(([, pattern]) => pattern.test(text)).map(([term]) => `${term}: ${text}`));
    expect(named).toEqual([]);
  });

  it("lists every article file once", () => {
    const files = readdirSync(join(adminRoot, "src/lib/help/articles", locale)).filter((file) => file.endsWith(".ts")).map((file) => file.slice(0, -3)).sort();
    expect([...slugs].sort()).toEqual(files);
    expect(slugs.size).toBe(articles.length);
  });

  it.each(articles.map((article) => [article.slug, article] as const))("keeps %s brand-neutral and in the house format", (slug, article) => {
    expect(validateHelpArticle(article, { bannedTerms, knownSlugs: slugs })).toEqual([]);
    expect(helpArticle(locale, slug)).toBe(article);
  });

  it("has a page for every screen of the app", () => {
    const uncovered = SCREENS.filter((screen) => !NOT_SCREENS[screen] && !articles.some((article) => article.screenPaths.includes(screen)));
    expect(uncovered, "screens without a help page: add a page, or say in NOT_SCREENS why the address has none").toEqual([]);
  });

  it("points each page at real screens, and each screen at one page", () => {
    const owners = new Map<string, string>();
    for (const article of articles) {
      for (const screenPath of article.screenPaths) {
        expect(SCREENS, `${article.slug}: ${screenPath} is not a page of the app`).toContain(screenPath);
        expect(owners.get(screenPath), `${screenPath} is claimed by ${owners.get(screenPath)} and ${article.slug}`).toBeUndefined();
        owners.set(screenPath, article.slug);
        // The help button finds the same page from the address the screen is open at.
        expect(helpSlugForPath(locale, sampleAddress(screenPath)), screenPath).toBe(article.slug);
      }
    }
  });

  it("shows every page in the index, under its section", () => {
    const listed = helpSections(locale).flatMap((group) => group.articles.map((article) => {
      expect(article.section).toBe(group.section);
      return article.slug;
    }));
    expect(listed.sort()).toEqual([...slugs].sort());
  });

  it("exports every page to one Markdown file, with each page's address", () => {
    const markdown = helpMarkdown(locale);
    for (const article of articles) {
      expect(markdown).toContain(`\n# ${article.title}\n`);
      expect(markdown).toContain(helpPath(locale, article.slug));
    }
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown).not.toMatch(/<\/?[a-z][a-z0-9-]*[\s>]/i);
  });
});
