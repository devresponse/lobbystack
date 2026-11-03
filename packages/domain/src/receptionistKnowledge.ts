import { countKnowledgeTokens, KNOWLEDGE_SEARCH_TOKEN_BUDGET, knowledgeQueryTerms, type KnowledgePassage } from "./knowledgeRanking";

// What the receptionist's searchKnowledge tool hands its model: the knowledge
// search's evidence first, then the business's text entries and FAQs that fit
// in the slots and tokens it leaves. Calls, website chats and the v1 knowledge
// search (POST /knowledge/search) all build it here, so the API shows exactly
// what the model receives.

/** One passage as the model reads it. */
export type KnowledgeToolMatch = { title: string; text: string; focusStart?: number; focusEnd?: number };

/** The searchKnowledge tool's result. */
export type KnowledgeToolResult = { outcome: string; matches: KnowledgeToolMatch[] };

/** A text entry or FAQ from the business snapshot. */
type SnapshotSnippet = { title: string; content: string; priority: number };

// A plural always counts ("fee" finds "fees"). Other endings only count for terms of four
// or more letters and at most three extra letters ("park" finds "parking"), so "car"
// doesn't find "care".
function wordMatchesTerm(word: string, term: string): boolean {
  if (word === term || word === `${term}s` || word === `${term}es`) return true;
  return term.length >= 4 && word.startsWith(term) && word.length - term.length <= 3;
}

/**
 * Curated FAQs and text entries from the snapshot fill the slots knowledge search
 * leaves, or stand in when it is unavailable. The document digest is an inventory,
 * not evidence. Pasted snippets are long, so one shared word proves little. A snippet
 * must contain a meaningful query term (see wordMatchesTerm), and two distinct terms
 * once the query has three or more. More terms matched ranks first, then higher priority.
 */
export function matchKnowledgeSnippets(snippets: readonly SnapshotSnippet[] | undefined, query: string): KnowledgeToolMatch[] {
  const terms = knowledgeQueryTerms(query);
  if (!terms.length) return [];
  const needed = terms.length >= 3 ? 2 : 1;
  return (snippets ?? []).flatMap((snippet) => {
    const words = `${snippet.title} ${snippet.content}`.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const matched = terms.filter((term) => words.some((word) => wordMatchesTerm(word, term))).length;
    return matched >= needed ? [{ matched, priority: snippet.priority, title: snippet.title, text: snippet.content.trim() }] : [];
  }).sort((a, b) => b.matched - a.matched || b.priority - a.priority).map(({ title, text }) => ({ title, text }));
}

// Evidence already fits the token budget, so it stays whole. Snippets get what it leaves,
// in rank order, so a long pasted snippet can't push a reply past the budget.
function withSnippetsInBudget(evidence: KnowledgeToolMatch[], snippets: KnowledgeToolMatch[]): KnowledgeToolMatch[] {
  let used = evidence.reduce((sum, match) => sum + countKnowledgeTokens(`${match.title}\n${match.text}\n`), 0);
  const fitting = snippets.filter((snippet) => {
    const size = countKnowledgeTokens(`${snippet.title}\n${snippet.text}\n`);
    if (used + size > KNOWLEDGE_SEARCH_TOKEN_BUDGET) return false;
    used += size;
    return true;
  });
  return [...evidence, ...fitting].slice(0, 6);
}

/**
 * The tool's result from the search's evidence, or from the snippets alone when the
 * search threw (null). focusStart and focusEnd mark the chunk that ranked inside text,
 * which also holds its neighbors, so a reader with little room starts there
 * (agent-core's live/directAnswer.ts).
 */
export function knowledgeToolResult(evidence: { matches: KnowledgePassage[]; outcome: string } | null, snippets: KnowledgeToolMatch[]): KnowledgeToolResult {
  if (!evidence) {
    const matches = withSnippetsInBudget([], snippets);
    return { outcome: matches.length ? "found" : "unavailable", matches };
  }
  // Evidence first. Snippets only fill the slots and tokens it leaves.
  const matches = withSnippetsInBudget(evidence.matches.map((match) => ({ title: match.title, text: match.content, ...(match.focusStart !== undefined && match.focusEnd !== undefined ? { focusStart: match.focusStart, focusEnd: match.focusEnd } : {}) })), snippets);
  return { outcome: matches.length ? "found" : evidence.outcome, matches };
}
