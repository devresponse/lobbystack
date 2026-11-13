import { HELP_REQUIREMENTS, HELP_SECTIONS, type HelpArticle } from "./types";

/**
 * Words a help page never uses, whatever the brand: the services a deployment
 * runs on and how it's set up. Brand names, domains and contact addresses come
 * from brands/ on top of these (help-content.test.ts), so a new brand is
 * checked without touching this list. A service whose name is also a word a
 * screen shows, such as the **Resend** button, is refused by its address.
 */
export const HELP_BANNED_TERMS = [
  "Allo",
  "ChatGPT",
  "Cloudflare",
  "deployment",
  "environment variable",
  "Firecrawl",
  "GPT",
  "LiveKit",
  "OpenAI",
  "Polar",
  "PostHog",
  "Railway",
  "resend.com",
  "self-hosted",
  "Stripe",
  "Turnstile",
  "Twilio",
] as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCREEN_PATH = /^\/(?:[a-z0-9-]+|\{[a-zA-Z]+\})(?:\/(?:[a-z0-9-]+|\{[a-zA-Z]+\}))*$|^\/$/;
// A full stop, question mark or exclamation mark, which may sit inside a
// closing bracket, quote or bold mark, as when a sentence quotes a message.
const ENDS_A_SENTENCE = /[.?!](?:\*\*|[)"'”’])*$/;
// An API scope as the API keys screen shows it, such as `phone_numbers:manage`.
const API_SCOPE = /^[a-z]+(?:_[a-z0-9]+)*:[a-z]+(?:_[a-z0-9]+)*$/;

export type HelpValidationOptions = {
  /** Brand names, domains, contact addresses and any other words to refuse, matched as whole words in any letter case. */
  bannedTerms?: readonly string[];
  /** Every help page's slug, so related pages can be checked. */
  knownSlugs?: ReadonlySet<string>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A banned term as a whole word in any letter case. Unlike \b, an underscore
 * separates words too, so a term inside a name such as SERVICE_SECRET_KEY is
 * caught.
 */
export function termPattern(term: string): RegExp {
  const start = /^[A-Za-z0-9]/.test(term) ? "(?<![A-Za-z0-9])" : "";
  const end = /[A-Za-z0-9]$/.test(term) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(`${start}${escapeRegExp(term)}${end}`, "i");
}

function count(text: string, mark: string): number {
  return text.split(mark).length - 1;
}

/** Problems with one piece of text, whatever field it's in. */
function textProblems(text: string, banned: readonly RegExp[], bannedTerms: readonly string[]): string[] {
  const problems: string[] = [];
  if (text !== text.trim()) problems.push("starts or ends with a space");
  if (!text.trim()) problems.push("is empty");
  if (/ {2,}/.test(text)) problems.push("has two spaces in a row");
  banned.forEach((pattern, index) => { if (pattern.test(text)) problems.push(`names "${bannedTerms[index]}", which a help page for any brand can't`); });
  // Code spans hold what a screen shows or what is typed, such as a dash for an
  // empty value or an option of a command, so dashes in them are no dashes in
  // the sentence.
  const prose = text.replace(/`[^`]*`/g, "");
  if (/[–—]/.test(prose) || /\s-{1,2}\s|--/.test(prose)) problems.push("has a dash; use a comma, a colon or a new sentence");
  if (/\{\{|\}\}/.test(text)) problems.push("has a {{placeholder}}; write the words out");
  if (/<\/?[a-z][^>]*>/i.test(text)) problems.push("has an HTML tag");
  if (/\]\(/.test(text)) problems.push("has a link; name the screen and add it to related instead");
  if (count(text, "**") % 2 !== 0) problems.push("has an unclosed **bold** mark");
  if (count(text, "`") % 2 !== 0) problems.push("has an unclosed `code` mark");
  if (/\b(?:TODO|TBD|FIXME|XXX)\b|lorem ipsum/i.test(text)) problems.push("has a placeholder");
  // A screen never shows a setting's name, even as code.
  if (/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(text)) problems.push("names a setting from the code; describe what it does instead");
  const codeNames = [prose, ...[...text.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? "").filter((code) => !API_SCOPE.test(code))];
  if (codeNames.some((part) => /\b[a-z]+(?:_[a-z0-9]+)+\b/.test(part))) problems.push("names something from the code; use the words the screen shows");
  if (/\/api\//.test(text)) problems.push("names an API address");
  return problems;
}

/**
 * What is wrong with a help page, as sentences naming the field. An empty list
 * means it can be published.
 */
export function validateHelpArticle(article: HelpArticle, options: HelpValidationOptions = {}): string[] {
  const errors: string[] = [];
  const bannedTerms = [...HELP_BANNED_TERMS, ...(options.bannedTerms ?? [])];
  const banned = bannedTerms.map(termPattern);
  const label = article.slug || "(no slug)";
  const fail = (field: string, problem: string) => errors.push(`${label}: ${field} ${problem}`);
  const check = (field: string, text: unknown, rules: { sentence?: boolean; max?: number } = {}) => {
    if (typeof text !== "string") return fail(field, "must be text");
    for (const problem of textProblems(text, banned, bannedTerms)) fail(field, problem);
    if (rules.sentence && !ENDS_A_SENTENCE.test(text.trim())) fail(field, "must end with a full stop");
    if (!rules.sentence && /\.$/.test(text.trim()) && !/\.\.\.$/.test(text.trim())) fail(field, "is a name or title, so it takes no full stop");
    // Names and titles show as plain text, so a mark would show as typed.
    if (!rules.sentence && /\*\*|`/.test(text)) fail(field, "is a name or title, so it takes no **bold** or `code` marks");
    if (rules.max && text.length > rules.max) fail(field, `is longer than ${rules.max} characters`);
  };
  const list = (field: string, value: unknown, { min = 0, max = Infinity }: { min?: number; max?: number } = {}): unknown[] => {
    if (value === undefined) {
      if (min > 0) fail(field, "is missing");
      return [];
    }
    if (!Array.isArray(value)) {
      fail(field, "must be a list");
      return [];
    }
    if (value.length < min) fail(field, `needs at least ${min}`);
    if (value.length > max) fail(field, `takes at most ${max}`);
    return value;
  };

  if (!SLUG.test(article.slug ?? "")) fail("slug", "must be lowercase words joined by hyphens");
  check("title", article.title, { max: 60 });
  if (!(HELP_SECTIONS as readonly string[]).includes(article.section)) fail("section", `must be one of ${HELP_SECTIONS.join(", ")}`);
  check("summary", article.summary, { sentence: true, max: 240 });
  for (const [index, path] of list("screenPaths", article.screenPaths, { min: 1 }).entries()) {
    if (typeof path !== "string" || !SCREEN_PATH.test(path) || /^\/(?:en|fr|es|sr)(?:\/|$)/.test(path)) fail(`screenPaths[${index}]`, "must be an app address such as /calls/{callId}, with no language prefix or trailing slash");
  }
  for (const [index, step] of list("location", article.location, { min: 1, max: 5 }).entries()) check(`location[${index}]`, step, { max: 40 });
  check("access", article.access, { sentence: true });
  for (const [index, paragraph] of list("purpose", article.purpose, { min: 1, max: 4 }).entries()) check(`purpose[${index}]`, paragraph, { sentence: true });

  const areas = list("areas", article.areas);
  for (const [index, area] of areas.entries()) {
    const value = area as { name?: unknown; description?: unknown };
    check(`areas[${index}].name`, value.name, { max: 60 });
    check(`areas[${index}].description`, value.description, { sentence: true });
  }
  const groups = list("fields", article.fields);
  for (const [groupIndex, group] of groups.entries()) {
    const value = group as { title?: unknown; description?: unknown; fields?: unknown };
    check(`fields[${groupIndex}].title`, value.title, { max: 60 });
    if (value.description !== undefined) check(`fields[${groupIndex}].description`, value.description, { sentence: true });
    const names = new Set<string>();
    for (const [fieldIndex, field] of list(`fields[${groupIndex}].fields`, value.fields, { min: 1 }).entries()) {
      const item = field as { name?: unknown; requirement?: unknown; description?: unknown };
      const where = `fields[${groupIndex}].fields[${fieldIndex}]`;
      check(`${where}.name`, item.name, { max: 60 });
      if (typeof item.name === "string") {
        if (names.has(item.name)) fail(`${where}.name`, `repeats "${item.name}" in the same group`);
        names.add(item.name);
      }
      if (item.requirement !== undefined && !(HELP_REQUIREMENTS as readonly string[]).includes(item.requirement as string)) fail(`${where}.requirement`, `must be one of ${HELP_REQUIREMENTS.join(", ")}`);
      check(`${where}.description`, item.description, { sentence: true });
    }
  }
  if (areas.length === 0 && groups.length === 0) fail("areas and fields", "are both empty; describe what the screen shows or what you fill in");
  for (const [taskIndex, task] of list("tasks", article.tasks, { min: 1 }).entries()) {
    const value = task as { title?: unknown; steps?: unknown };
    check(`tasks[${taskIndex}].title`, value.title, { max: 80 });
    for (const [stepIndex, step] of list(`tasks[${taskIndex}].steps`, value.steps, { min: 1 }).entries()) check(`tasks[${taskIndex}].steps[${stepIndex}]`, step, { sentence: true });
  }
  for (const [index, note] of list("notes", article.notes).entries()) check(`notes[${index}]`, note, { sentence: true });
  for (const [index, entry] of list("troubleshooting", article.troubleshooting).entries()) {
    const value = entry as { question?: unknown; answer?: unknown };
    check(`troubleshooting[${index}].question`, value.question, { sentence: true, max: 160 });
    check(`troubleshooting[${index}].answer`, value.answer, { sentence: true });
  }
  const related = new Set<string>();
  for (const [index, slug] of list("related", article.related).entries()) {
    if (typeof slug !== "string") { fail(`related[${index}]`, "must be a slug"); continue; }
    if (slug === article.slug) fail(`related[${index}]`, "links the page to itself");
    if (related.has(slug)) fail(`related[${index}]`, `repeats ${slug}`);
    related.add(slug);
    if (options.knownSlugs && !options.knownSlugs.has(slug)) fail(`related[${index}]`, `names ${slug}, which isn't a help page`);
  }
  for (const [index, keyword] of list("keywords", article.keywords).entries()) check(`keywords[${index}]`, keyword, { max: 60 });
  return errors;
}

/** Every piece of text on a help page, in reading order, for word counts and searches. */
export function helpArticleText(article: HelpArticle): string[] {
  return [
    article.title,
    article.summary,
    ...article.location,
    article.access,
    ...article.purpose,
    ...(article.areas ?? []).flatMap((area) => [area.name, area.description]),
    ...(article.fields ?? []).flatMap((group) => [group.title, ...(group.description ? [group.description] : []), ...group.fields.flatMap((field) => [field.name, field.description])]),
    ...(article.tasks ?? []).flatMap((task) => [task.title, ...task.steps]),
    ...(article.notes ?? []),
    ...(article.troubleshooting ?? []).flatMap((entry) => [entry.question, entry.answer]),
    ...(article.keywords ?? []),
  ];
}
