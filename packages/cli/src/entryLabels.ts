import type { Row } from "./operations";

// An FAQ's or text entry's labels and priority, as a manifest gives them and
// PATCH /knowledge/{entry_id} takes them: the entries with the highest
// priority are the ones every call and chat keeps ready.

/** An FAQ or text entry as the manifest wants it. Labels and priority it leaves out stay as the entry has them. */
export type WantedEntry = { title: string; content: string; tags?: string[] | undefined; priority?: number | undefined };

/** The faq tag marks an FAQ, so the API keeps it on an FAQ and ignores it in labels sent; comparisons leave it out. */
const ownLabels = (tags: unknown) => [...new Set((Array.isArray(tags) ? tags : []).filter((tag): tag is string => typeof tag === "string" && tag !== "faq"))];

/** Labels are a set: the same ones in another order are no change. */
const sameLabels = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

/** The labels and priority that differ from what the entry has, or a new entry's, as PATCH /knowledge/{entry_id} takes them. */
export function labelChanges(entry: WantedEntry, current: Row = { tags: [], priority: 0 }): Row {
  const tags = ownLabels(entry.tags);
  return {
    ...(entry.tags !== undefined && !sameLabels(tags, ownLabels(current.tags)) ? { tags } : {}),
    ...(entry.priority !== undefined && entry.priority !== current.priority ? { priority: entry.priority } : {}),
  };
}
