import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { helpArticles } from "../apps/admin/src/lib/help/registry";
import type { HelpArticle } from "../apps/admin/src/lib/help/types";

// Writes the dashboard's help pages as knowledge-base documents, one Markdown
// file per screen, for a business whose receptionist answers questions about
// the app itself, such as RealInfoBot's support assistant. Each folder under
// devops/kb/ with a help-kb.json gets its own copy, and the lines of its
// manifest between "# screens:start" and "# screens:end", which list the files
// for lobbystack onboard. A test in scripts/help-kb.test.ts fails when they fall
// behind the help pages: run pnpm help:kb.
//
// The knowledge base cuts a document at every Markdown heading and into pieces
// of at most 1,800 characters, and a piece is found and read on its own. So
// every heading here names the screen, a section that would run past a piece
// is split under a repeated heading, and "Related help", which only lists
// other pages, is left out.

export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const kbRoot = join(repositoryRoot, "devops", "kb");

/** Room for a section, under the knowledge base's 1,800-character pieces, so a section stays one piece with its heading. */
export const SECTION_MAX_CHARACTERS = 1_500;

export type HelpKbConfig = {
  /** The brand's name, as the documents name the app. */
  appName: string;
  /** The dashboard's address, which makes each screen's address a link. */
  appUrl: string;
  /** The manifest, in the same folder, whose screens block lists the files. */
  manifest: string;
  /** The folder, in the same folder, the screen guides go in. */
  folder: string;
  /** Help pages left out, by slug, each with why. */
  skip: Record<string, string>;
};

export type ScreenGuide = { slug: string; path: string; title: string; markdown: string };

const START = "# screens:start";
const END = "# screens:end";

export function readHelpKbConfig(folder: string): HelpKbConfig {
  const config = JSON.parse(readFileSync(join(folder, "help-kb.json"), "utf8")) as HelpKbConfig;
  for (const field of ["appName", "appUrl", "manifest", "folder"] as const) {
    if (typeof config[field] !== "string" || !config[field].trim()) throw new Error(`${join(folder, "help-kb.json")}: ${field} is missing.`);
  }
  return { ...config, appUrl: config.appUrl.replace(/\/+$/, ""), skip: config.skip ?? {} };
}

/** The folders under devops/kb/ that have a help-kb.json. */
export function helpKbFolders(root = kbRoot): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "help-kb.json"))).map((entry) => join(root, entry.name));
}

const isSetupStep = (article: HelpArticle) => article.slug.startsWith("onboarding-");

/** What the headings call the page: "the Team screen", or "the setup step "Choose your plan"". */
function subject(article: HelpArticle): string {
  return isSetupStep(article) ? `the setup step "${article.title}"` : `the ${article.title} screen`;
}

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** A task's title starts with a verb, so "Invite someone" reads as "invite someone" after "How to". */
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text);

/** The screen's addresses, as links where they're fixed and as text where a part changes, such as /calls/{callId}. */
function addresses(article: HelpArticle, appUrl: string): string {
  return article.screenPaths.map((path) => (path.includes("{") ? `\`${path}\`` : `${appUrl}${path}`)).join(", ");
}

/**
 * A heading and its blocks, as one or more sections that each fit
 * SECTION_MAX_CHARACTERS: blocks that don't fit go on under the heading again,
 * marked (continued). A single block too long for a section stays whole.
 */
export function splitSection(heading: string, blocks: readonly string[], separator = "\n\n"): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  const text = (title: string, items: readonly string[]) => `${title}\n\n${items.join(separator)}`;
  const title = () => (sections.length ? `${heading} (continued)` : heading);
  for (const block of blocks) {
    if (current.length && text(title(), [...current, block]).length > SECTION_MAX_CHARACTERS) {
      sections.push(text(title(), current));
      current = [];
    }
    current.push(block);
  }
  if (current.length) sections.push(text(title(), current));
  return sections;
}

/** One help page as a knowledge-base document. */
export function screenGuide(article: HelpArticle, config: Pick<HelpKbConfig, "appName" | "appUrl" | "folder">): ScreenGuide {
  const about = subject(article);
  const short = isSetupStep(article) ? `setup step "${article.title}"` : `${article.title} screen`;
  const facts = [
    `- Where to find it: ${article.location.join(" > ")}`,
    `- Who can use it: ${article.access}`,
    `- Address: ${addresses(article, config.appUrl)}`,
  ].join("\n");
  const blocks: string[] = [
    [`# ${capitalized(about)} in the ${config.appName} app`, article.summary, facts, ...(article.keywords?.length ? [`Also known as: ${article.keywords.join(", ")}.`] : [])].join("\n\n"),
    ...splitSection(`## What ${about} is for`, article.purpose),
  ];
  if (article.areas?.length) blocks.push(...splitSection(`## What you see on ${about}`, article.areas.map((area) => `- **${area.name}**: ${area.description}`), "\n"));
  for (const group of article.fields ?? []) {
    const fields = group.fields.map((field) => `- **${field.name}**${field.requirement ? ` (${capitalized(field.requirement === "conditional" ? "sometimes required" : field.requirement)})` : ""}: ${field.description}`);
    // A step whose fields have no name of their own is named like the page.
    const heading = group.title === article.title ? `## The fields on ${about}` : `## ${group.title}, on ${about}`;
    // One block per field, so a long group splits between fields; the blank line after a description ends its paragraph.
    blocks.push(...splitSection(heading, [...(group.description ? [`${group.description}\n`] : []), ...fields], "\n"));
  }
  for (const task of article.tasks ?? []) {
    blocks.push(...splitSection(`## How to ${lowerFirst(task.title)}, on ${about}`, task.steps.map((step, index) => `${index + 1}. ${step}`), "\n"));
  }
  if (article.notes?.length) blocks.push(...splitSection(`## Good to know about ${about}`, article.notes.map((note) => `- ${note}`), "\n"));
  for (const entry of article.troubleshooting ?? []) blocks.push(...splitSection(`## ${entry.question} (${short})`, [entry.answer]));
  return {
    slug: article.slug,
    path: `${config.folder}/${article.slug}.md`,
    title: `${isSetupStep(article) ? "Setup step guide" : "Screen guide"}: ${article.title}`,
    markdown: `${blocks.join("\n\n")}\n`,
  };
}

/** The screen guides a folder's config asks for, in the help center's order. */
export function screenGuides(config: HelpKbConfig): ScreenGuide[] {
  const articles = helpArticles("en");
  const unknown = Object.keys(config.skip).filter((slug) => !articles.some((article) => article.slug === slug));
  if (unknown.length) throw new Error(`help-kb.json skips ${unknown.join(", ")}, which no help page is called. Take ${unknown.length === 1 ? "it" : "them"} out of skip.`);
  return articles.filter((article) => !(article.slug in config.skip)).map((article) => screenGuide(article, config));
}

/** The manifest with the lines between its markers listing the guides, each marker's indentation kept. */
export function withScreensBlock(manifest: string, guides: readonly ScreenGuide[], manifestName = "the manifest"): string {
  const lines = manifest.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(START));
  const end = lines.findIndex((line) => line.trim().startsWith(END));
  if (start < 0 || end < start) throw new Error(`${manifestName} needs a "${START}" line and, after it, a "${END}" line under knowledge.files.`);
  const indent = /^\s*/.exec(lines[start]!)![0];
  const entries = guides.flatMap((guide) => [`${indent}- path: ${guide.path}`, `${indent}  title: ${JSON.stringify(guide.title)}`]);
  return [...lines.slice(0, start + 1), ...entries, ...lines.slice(end)].join("\n");
}

/** Every file pnpm help:kb writes for a folder, by its path in the folder, and the guides it no longer writes. */
export function helpKbOutputs(folder: string): { files: Map<string, string>; stale: string[] } {
  const config = readHelpKbConfig(folder);
  const guides = screenGuides(config);
  const files = new Map<string, string>(guides.map((guide) => [guide.path, guide.markdown]));
  const manifestPath = join(folder, config.manifest);
  files.set(config.manifest, withScreensBlock(readFileSync(manifestPath, "utf8").replace(/\r\n/g, "\n"), guides, config.manifest));
  const screens = join(folder, config.folder);
  const stale = existsSync(screens) ? readdirSync(screens).filter((name) => name.endsWith(".md") && !files.has(`${config.folder}/${name}`)).map((name) => `${config.folder}/${name}`) : [];
  return { files, stale };
}

/** What's out of date in a folder, as the paths that differ, are missing or should go. */
export function helpKbDrift(folder: string): string[] {
  const { files, stale } = helpKbOutputs(folder);
  const differing = [...files].filter(([path, content]) => {
    const target = join(folder, path);
    // A Windows checkout with core.autocrlf has CRLF line endings in text files.
    return !existsSync(target) || readFileSync(target, "utf8").replace(/\r\n/g, "\n") !== content;
  }).map(([path]) => path);
  return [...differing, ...stale];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const folders = helpKbFolders();
  if (!folders.length) throw new Error(`No folder under ${kbRoot} has a help-kb.json.`);
  let behind = 0;
  for (const folder of folders) {
    const name = folder.slice(repositoryRoot.length);
    if (check) {
      const drift = helpKbDrift(folder);
      behind += drift.length;
      for (const path of drift) console.log(`${name}/${path} is behind the help pages.`);
      continue;
    }
    const { files, stale } = helpKbOutputs(folder);
    for (const [path, content] of files) {
      const target = join(folder, path);
      mkdirSync(join(target, ".."), { recursive: true });
      if (existsSync(target) && readFileSync(target, "utf8").replace(/\r\n/g, "\n") === content) continue;
      writeFileSync(target, content);
      console.log(`Wrote ${name}/${path}`);
    }
    for (const path of stale) {
      rmSync(join(folder, path));
      console.log(`Removed ${name}/${path}, which no help page writes any more. Delete its document from the knowledge base by hand.`);
    }
  }
  if (check && behind) {
    console.log("Run pnpm help:kb to bring them up to date.");
    process.exitCode = 1;
  }
}
