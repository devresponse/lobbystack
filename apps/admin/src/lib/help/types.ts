/**
 * The help center's content model. A help page explains one screen of the
 * dashboard in words that fit any brand: it names the screen, its fields and
 * what they do, and never a brand, a price, a provider or a deployment
 * setting. docs/features/help-pages.md has the writing rules.
 *
 * Text takes plain sentences with two marks: **bold** for a label as the
 * screen shows it (a button, tab, field or menu item), and `code` for
 * something typed or copied exactly, such as an address. Nothing else is
 * parsed, so the same text reads well as HTML, as Markdown and to an AI
 * assistant.
 *
 * This file and the articles import nothing at run time, so Node can load
 * them directly, as the help checks do.
 */

/** The help center's groups, in the order its index lists them. */
export const HELP_SECTIONS = ["getting-started", "general", "agent", "manage", "settings", "account"] as const;

export type HelpSection = (typeof HELP_SECTIONS)[number];

/**
 * required: the screen won't save or go on without it. optional: it can be
 * left empty. conditional: required only in some cases, which the field's
 * description names.
 */
export const HELP_REQUIREMENTS = ["required", "optional", "conditional"] as const;

export type HelpRequirement = (typeof HELP_REQUIREMENTS)[number];

export type HelpField = {
  /** The label as the screen shows it in English. */
  name: string;
  /** Left out for switches, choices that have a default and values the screen only shows. */
  requirement?: HelpRequirement;
  /** What it does and what to enter, in one to three sentences. */
  description: string;
};

export type HelpFieldGroup = {
  /** Where the fields sit: the card, tab, dialog or step, named as the screen names it. */
  title: string;
  /** When you see this group, when that isn't obvious. */
  description?: string;
  fields: HelpField[];
};

export type HelpArea = {
  /** A part of the screen, named as the screen names it. */
  name: string;
  /** What it shows and what you can do there. */
  description: string;
};

export type HelpTask = {
  /** Starts with a verb, such as "Add a rule". */
  title: string;
  /** One action per step. */
  steps: string[];
};

export type HelpQuestion = {
  /** A problem or a question, as someone using the screen would put it. */
  question: string;
  answer: string;
};

export type HelpArticle = {
  /** The page's address is /{locale}/help/{slug}. Lowercase words joined by hyphens, and the article's file name. */
  slug: string;
  /** The screen's name as the dashboard shows it. */
  title: string;
  section: HelpSection;
  /** One sentence on what the screen is for, shown under the title and in the index. */
  summary: string;
  /**
   * The app addresses the page explains, with {name} for each part that
   * changes, such as "/calls/{callId}", and without a language prefix. The
   * help button opens this page from them, so each address belongs to one
   * page only.
   */
  screenPaths: string[];
  /** How to get there, as the things you click in order, such as ["Sidebar", "Agent", "Rules"]. */
  location: string[];
  /** Who can open the screen and who can change it, by the roles the Team screen names. */
  access: string;
  /** Why the screen exists and what it does for the business, in one to four short paragraphs. */
  purpose: string[];
  /** The parts of the screen, top to bottom. */
  areas?: HelpArea[];
  /** The fields and settings, grouped as the screen groups them. */
  fields?: HelpFieldGroup[];
  /** Step-by-step instructions for the common jobs. */
  tasks?: HelpTask[];
  /** Short facts worth knowing: limits, what happens after saving, what depends on the plan. */
  notes?: string[];
  /** Problems someone may meet, with what to do. */
  troubleshooting?: HelpQuestion[];
  /** Slugs of other help pages to read next. */
  related?: string[];
  /** Other words people use for this screen, for search and AI assistants. */
  keywords?: string[];
};
