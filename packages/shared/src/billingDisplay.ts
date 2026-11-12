import { z } from "zod";

import { billingIntervals, cloudBillingPlanSlugs, type BillingInterval, type CloudBillingPlanSlug } from "./billing";
import { normalizeInterfaceLocale, type InterfaceLocale } from "./locales";

// billing.json's display section: the words and the layout of the plan
// screens, onboarding's plan step and Settings > Plan's upgrade dialog. It
// never changes what is sold: the profile hash, the catalog apply, pnpm billing
// verify and the daily drift check all leave it out, and `pnpm brands:build`
// carries it into generated.ts, from which GET /api/billing hands the
// deployment's own to the screens. The numbers always come from the plan
// list: an allowance named here prints that plan's own, from the catalog or,
// before an apply, from the file the build carries. A card can also show a
// prepaid pack of the file, whose numbers and price come from the packs on
// sale. Every field is optional, and a screen uses its built-in words for
// whatever the section leaves out.

/** The allowances a card bullet or a comparison row can name, as billing.json names them. */
export const planDisplayAllowances = ["voiceMinutes", "receptionists", "businessNumbers", "alertSmsSegments", "outboundCallAttempts", "chatAiUnits", "knowledgeStorage"] as const;
export type PlanDisplayAllowance = (typeof planDisplayAllowances)[number];

/**
 * Comparison rows the page fills from the code that enforces them, so the file
 * can only place them: how long transcripts are kept, and the shortest call
 * that is billed.
 */
export const planDisplayComputedRows = ["contentRetention", "shortCalls"] as const;
export type PlanDisplayComputedRow = (typeof planDisplayComputedRows)[number];

/** The rows a comparison can name instead of spelling out: every allowance and the computed rows. */
export const planDisplayRowNames = [...planDisplayAllowances, ...planDisplayComputedRows] as const;
export type PlanDisplayRowName = (typeof planDisplayRowNames)[number];

/**
 * The values a text can print as {{name}}: a plan's allowances and overage
 * rates, formatted in the visitor's language, and the app's name. Text about
 * one plan (its card, or its cell in a row) names them bare, such as
 * {{voiceMinutes}}; text about the whole page names the plan first, such as
 * {{free_cloud.voiceMinutes}}. A custom allowance prints the word for custom.
 */
export const planDisplayValueNames = [...planDisplayAllowances, "voiceMinuteRate", "alertSmsSegmentRate", "outboundCallAttemptRate"] as const;
export type PlanDisplayValueName = (typeof planDisplayValueNames)[number];

/**
 * The values a pack card's text can print as {{name}}: the pack's voice
 * minutes for its whole length, its length in days, its price, paid once, and
 * what it gives each month or allows while it lasts, formatted in the
 * visitor's language. A pack that never ends prints a dash for its days.
 */
export const packDisplayValueNames = ["voiceMinutes", "days", "price", "receptionists", "businessNumbers", "alertSmsSegments", "outboundCallAttempts", "chatAiUnits", "knowledgeStorage"] as const;
export type PackDisplayValueName = (typeof packDisplayValueNames)[number];

/** The most cards a plan screen shows: the four plans' and some packs'. */
export const MAX_PLAN_DISPLAY_CARDS = 12;

/** The words the plan screens show for comparison values they don't spell out. */
export const planDisplayCellWords = ["unlimited", "custom", "multiple"] as const;
export type PlanDisplayCellWord = (typeof planDisplayCellWords)[number];

const text = z.string().trim().min(1).max(300);

/** Words in every interface language. */
export const planDisplayTextSchema = z.strictObject({ en: text, fr: text, es: text, sr: text } satisfies Record<InterfaceLocale, typeof text>).meta({ id: "PlanDisplayText", description: "Words in every interface language: en, fr, es and sr." });
export type PlanDisplayText = z.output<typeof planDisplayTextSchema>;

// A paid plan's words may differ by the tab the visitor is on.
const intervalText = z.union([planDisplayTextSchema, z.strictObject({ monthly: planDisplayTextSchema, annual: planDisplayTextSchema })]);
export type PlanDisplayIntervalText = z.output<typeof intervalText>;

const allowance = z.enum(planDisplayAllowances);

// A card shows a plan, or a prepaid pack of the file: one of the two.
const card = z.strictObject({
  plan: z.enum(cloudBillingPlanSlugs).optional(),
  // A pack's code, from the file's packs: its card shows the pack's price, paid once, and its button buys it.
  pack: z.string().min(1).max(48).optional(),
  // The card the screens mark as popular: at most one.
  popular: z.boolean().optional(),
  // The popular card's badge, in place of the word Popular.
  badge: planDisplayTextSchema.optional(),
  // A pack's card takes one text, since a pack has no monthly or annual price.
  description: intervalText.optional(),
  button: intervalText.optional(),
  // An allowance's name prints the plan's or the pack's own number, with its plural and, for a plan, its rate; anything else is text.
  bullets: z.array(z.union([allowance, planDisplayTextSchema])).min(1).max(12).optional(),
});
/** A card as the file writes it: a plan's or a pack's. */
export type PlanDisplayEntry = z.output<typeof card>;
/** A plan's card. */
export type PlanDisplayCard = PlanDisplayEntry & { plan: CloudBillingPlanSlug; pack?: undefined };
/** A prepaid pack's card, with one text for its description and button. */
export type PlanDisplayPackCard = Omit<PlanDisplayEntry, "description" | "button"> & { pack: string; plan?: undefined; description?: PlanDisplayText; button?: PlanDisplayText };

// What a plan gets in a comparison row: included or not, one of the words, or text.
const cell = z.union([z.boolean(), z.enum(planDisplayCellWords), planDisplayTextSchema]);
export type PlanDisplayCell = z.output<typeof cell>;
const cells = z.strictObject({ free_cloud: cell.optional(), starter: cell.optional(), pro: cell.optional(), enterprise: cell.optional() } satisfies Record<CloudBillingPlanSlug, unknown>);
export type PlanDisplayCells = z.output<typeof cells>;

const rowName = z.enum(planDisplayRowNames);
const row = z.union([
  // A row the page fills: an allowance from the plan list, or a computed row.
  rowName,
  // The same, with its own label or some plans' values in place of the filled ones.
  z.strictObject({ row: rowName, label: planDisplayTextSchema.optional(), values: cells.optional() }),
  // A row of the brand's own, with a value for every plan the screens show.
  z.strictObject({ label: planDisplayTextSchema, values: cells }),
]);
export type PlanDisplayRow = z.output<typeof row>;

const group = z.strictObject({ group: planDisplayTextSchema, rows: z.array(row).min(1).max(40) });
export type PlanDisplayGroup = z.output<typeof group>;

export const billingDisplaySchema = z.strictObject({
  // The tab the plan step opens on, when the plans sell it.
  defaultInterval: z.enum(billingIntervals).optional(),
  // The cards, in their order: the plans', which are also the comparison's columns, and the packs'. A plan left out gets neither.
  plans: z.array(card).min(1).max(MAX_PLAN_DISPLAY_CARDS).optional(),
  comparisonTitle: planDisplayTextSchema.optional(),
  comparisonIntro: planDisplayTextSchema.optional(),
  // The comparison's groups and rows, in their order; an empty list shows no comparison.
  comparison: z.array(group).max(12).optional(),
  // The prepaid packs' box on the plan step, when packs are on sale and no card shows a pack.
  packs: z.strictObject({ title: planDisplayTextSchema.optional(), description: planDisplayTextSchema.optional(), button: planDisplayTextSchema.optional() }).optional(),
});

/** A billing.json's display section, as checked. */
export type BillingDisplay = z.output<typeof billingDisplaySchema>;

// {{ name }}: the name is everything between the braces, trimmed. The spaces
// are trimmed in code, not matched by the pattern: a pattern with \s* on both
// sides of a lazy name takes cubic time on a long run of spaces after {{.
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** The names a text prints, such as voiceMinutes for {{voiceMinutes}}. */
export function planDisplayPlaceholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((match) => match[1]!.trim());
}

const planValueNames = new Set<string>([...planDisplayValueNames, "appName"]);
const packValueNames = new Set<string>([...packDisplayValueNames, "appName"]);
const pageValueNames = new Set<string>(["appName", ...cloudBillingPlanSlugs.flatMap((plan) => planDisplayValueNames.map((name) => `${plan}.${name}`))]);

function isText(value: unknown): value is PlanDisplayText {
  return typeof value === "object" && value !== null && "en" in value;
}

/** Whether a card shows a prepaid pack rather than a plan. */
export function isPackDisplayCard(entry: PlanDisplayEntry): entry is PlanDisplayPackCard {
  return entry.pack !== undefined && entry.plan === undefined && (entry.description === undefined || isText(entry.description)) && (entry.button === undefined || isText(entry.button));
}

/** Whether a card shows one of the four plans. */
export function isPlanDisplayCard(entry: PlanDisplayEntry): entry is PlanDisplayCard {
  return entry.plan !== undefined && entry.pack === undefined;
}

/** The section's words in one interval's version. */
function intervalTexts(value: PlanDisplayIntervalText): Array<[Array<string>, PlanDisplayText]> {
  return isText(value) ? [[[], value]] : [[["monthly"], value.monthly], [["annual"], value.annual]];
}

const placeholderHints = {
  plan: "a plan's text prints an allowance such as {{voiceMinutes}}, a rate such as {{voiceMinuteRate}}, or {{appName}}",
  pack: "a pack's text prints its {{voiceMinutes}}, {{days}}, {{price}}, an allowance such as {{receptionists}}, or {{appName}}",
  page: "the page's text prints a plan's value such as {{free_cloud.voiceMinutes}}, or {{appName}}",
} as const;

/**
 * The checks the JSON Schema can't carry. issue's path starts inside the
 * section: a card for a plan or for a pack of the file (packs, its codes),
 * each at most once, one popular at most, a badge only on it, a Starter or
 * Pro card only for a plan the file sells, one text for a pack card's words, a
 * value in a row only for a plan with a card and in a row of the brand's own
 * for every such plan, and only known names in {{...}}.
 */
export function checkBillingDisplay(display: BillingDisplay, sold: Record<"starter" | "pro", boolean>, packs: readonly string[], issue: (path: Array<string | number>, message: string) => void): void {
  const placeholders = (path: Array<string | number>, value: PlanDisplayText, scope: "plan" | "pack" | "page") => {
    const allowed = scope === "plan" ? planValueNames : scope === "pack" ? packValueNames : pageValueNames;
    const hint = placeholderHints[scope];
    for (const locale of Object.keys(value) as InterfaceLocale[]) {
      for (const name of planDisplayPlaceholders(value[locale])) {
        if (!allowed.has(name)) issue([...path, locale], `{{${name}}} isn't a value it knows: ${hint}`);
      }
    }
  };
  const cards = display.plans ?? [];
  const seen = new Set<string>();
  const filePacks = new Set(packs);
  cards.forEach((entry, index) => {
    if ((entry.plan === undefined) === (entry.pack === undefined)) {
      issue(["plans", index], "a card shows a plan or a pack: name one of the two, plan or pack");
      return;
    }
    const scope = entry.pack !== undefined ? "pack" : "plan";
    if (entry.pack !== undefined) {
      if (!filePacks.has(entry.pack)) issue(["plans", index, "pack"], `${entry.pack} isn't a pack in this file: use a code under packs`);
      if (seen.has(`pack:${entry.pack}`)) issue(["plans", index, "pack"], `${entry.pack} already has a card`);
      seen.add(`pack:${entry.pack}`);
    } else if (entry.plan !== undefined) {
      if (seen.has(entry.plan)) issue(["plans", index, "plan"], `${entry.plan} already has a card`);
      seen.add(entry.plan);
      if ((entry.plan === "starter" || entry.plan === "pro") && !sold[entry.plan]) issue(["plans", index, "plan"], `${entry.plan} isn't sold in this file, so it can't have a card`);
    }
    if (entry.badge) {
      if (!entry.popular) issue(["plans", index, "badge"], "a badge shows only on the popular card: set popular too");
      placeholders(["plans", index, "badge"], entry.badge, scope);
    }
    for (const field of ["description", "button"] as const) {
      const value = entry[field];
      if (!value) continue;
      if (scope === "pack" && !isText(value)) {
        issue(["plans", index, field], "a pack is paid once, so its card takes one text, not a monthly and an annual one");
        continue;
      }
      for (const [suffix, version] of intervalTexts(value)) placeholders(["plans", index, field, ...suffix], version, scope);
    }
    entry.bullets?.forEach((bullet, at) => {
      if (isText(bullet)) placeholders(["plans", index, "bullets", at], bullet, scope);
    });
  });
  if (cards.filter((entry) => entry.popular).length > 1) issue(["plans"], "only one card can be popular");
  // The comparison's columns are the plans' cards, or all four when the section names no card.
  const columns = new Set<string>(display.plans ? cards.flatMap((entry) => (entry.plan !== undefined && entry.pack === undefined ? [entry.plan] : [])) : cloudBillingPlanSlugs);
  for (const field of ["comparisonTitle", "comparisonIntro"] as const) {
    const value = display[field];
    if (value) placeholders([field], value, "page");
  }
  for (const field of ["title", "description", "button"] as const) {
    const value = display.packs?.[field];
    if (value) placeholders(["packs", field], value, "page");
  }
  display.comparison?.forEach((entry, groupIndex) => {
    placeholders(["comparison", groupIndex, "group"], entry.group, "page");
    entry.rows.forEach((current, rowIndex) => {
      if (typeof current === "string") return;
      const path = ["comparison", groupIndex, "rows", rowIndex];
      if (current.label) placeholders([...path, "label"], current.label, "page");
      const values = current.values ?? {};
      for (const [plan, value] of Object.entries(values) as Array<[CloudBillingPlanSlug, PlanDisplayCell | undefined]>) {
        if (value === undefined) continue;
        if (!columns.has(plan)) issue([...path, "values", plan], `${plan} has no card, so its value never shows`);
        if (isText(value)) placeholders([...path, "values", plan], value, "plan");
      }
      if (!("row" in current)) {
        for (const plan of columns) {
          if (values[plan as CloudBillingPlanSlug] === undefined) issue([...path, "values", plan], `a row of your own needs a value for every plan with a card: ${plan} has none`);
        }
      }
    });
  });
}

/** The section's words in the visitor's language, else English. */
export function planDisplayText(value: PlanDisplayText, locale: string | null | undefined): string {
  return value[normalizeInterfaceLocale(locale) ?? "en"];
}

/** A card's words on a tab: one version for both, or each tab's own. */
export function planDisplayIntervalText(value: PlanDisplayIntervalText, interval: BillingInterval): PlanDisplayText {
  return isText(value) ? value : value[interval];
}

/** Text with its {{name}} values filled in; a name without a value stays as written. */
export function fillPlanDisplayText(value: string, values: Readonly<Record<string, string>>): string {
  return value.replace(PLACEHOLDER, (whole, inside: string) => {
    const name = inside.trim();
    return Object.hasOwn(values, name) ? values[name]! : whole;
  });
}

/** Whether a bullet, a cell or a field holds words rather than a name or a flag. */
export function isPlanDisplayText(value: unknown): value is PlanDisplayText {
  return isText(value);
}
