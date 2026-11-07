import type { ApiKnowledgeSearch, ApiKnowledgeSearchResult } from "@lobbystack/shared";

import { countKnowledgeTokens, type KnowledgePassage } from "../../knowledgeRanking";
import { knowledgeToolResult, matchKnowledgeSnippets, type KnowledgeToolResult } from "../../receptionistKnowledge";
import type { DomainContext } from "../context";
import { traceKnowledgeSearch, type KnowledgeSearchTrace } from "../knowledge";
import { getCachedReceptionistSnapshot } from "../snapshotCache";
import type { ApiCaller } from "./operations";

type RankedCandidate = KnowledgeSearchTrace["candidates"][number];

function passageFields(passage: KnowledgePassage, candidate: RankedCandidate) {
  return {
    rank: candidate.rank,
    chunk_id: passage.chunkId,
    document_id: passage.documentId,
    title: passage.title,
    source_url: passage.sourceUrl,
    source_revision: passage.sourceRevision,
    sequence: passage.sequence,
    rrf_score: candidate.score,
    lexical_rank: candidate.lexicalRank,
    semantic_rank: candidate.semanticRank,
    // As the search's token budget counts it: the whole passage as JSON, plus a line break.
    tokens: countKnowledgeTokens(JSON.stringify(passage) + "\n"),
  };
}

/**
 * POST /knowledge/search: the receptionist's knowledge search, run as a call or chat
 * runs it (as the worker, over the business's active, indexed sources), with the
 * snapshot a new call or chat loads for its text entries and FAQs. It searches as the
 * default receptionist, with that receptionist's audiences and its view of the
 * snapshot, as the v1 /receptionist endpoint describes it. callAnswer turns the
 * tool's result into what a phone call's voice model hears: agent-core's
 * knowledgeCallAnswer, which this package can't import.
 */
export async function searchKnowledgeForApi(
  context: DomainContext,
  caller: ApiCaller,
  input: ApiKnowledgeSearch,
  options: { callAnswer: (query: string, result: KnowledgeToolResult) => string | undefined },
): Promise<ApiKnowledgeSearchResult> {
  const [snapshot, { result, trace }] = await Promise.all([
    getCachedReceptionistSnapshot(context, { businessId: caller.businessId }),
    traceKnowledgeSearch(context, { businessId: caller.businessId, query: input.query, source: "api" }),
  ]);
  const receptionistResult = knowledgeToolResult(result, matchKnowledgeSnippets(snapshot?.knowledgeSnippets, input.query));
  const candidates = new Map(trace.candidates.map((candidate) => [candidate.passage.chunkId, candidate]));
  return {
    query: trace.query,
    outcome: result.outcome,
    mode: result.mode,
    failure: result.failure ?? null,
    duration_ms: Math.round(result.durationMs),
    token_budget: trace.tokenBudget,
    // Every match is a candidate the fusion ranked, with its neighbors added when they fit.
    evidence: result.matches.map((match) => ({
      ...passageFields(match, candidates.get(match.chunkId)!),
      content: match.content,
      supporting_chunk_ids: match.supportingChunkIds ?? null,
      focus_start: match.focusStart ?? null,
      focus_end: match.focusEnd ?? null,
    })),
    receptionist_result: receptionistResult,
    call_answer: options.callAnswer(input.query, receptionistResult) ?? null,
    snapshot: snapshot ? { version: snapshot.version, generated_at: snapshot.generatedAt } : null,
    trace: {
      terms: trace.terms,
      lexical_query: trace.lexicalQuery,
      lexical: {
        status: trace.lexical.status,
        error: trace.lexical.error,
        candidates: trace.lexical.candidates.map((row) => ({ rank: row.rank, chunk_id: row.chunkId, score_all_terms: row.scoreAllTerms, score_any_term: row.scoreAnyTerm })),
      },
      semantic: {
        status: trace.semantic.status,
        error: trace.semantic.error,
        embedding_fingerprint: trace.semantic.embeddingFingerprint,
        embedding_dimensions: trace.semantic.embeddingDimensions,
        candidates: trace.semantic.candidates.map((row) => ({ rank: row.rank, chunk_id: row.chunkId, distance: row.distance })),
      },
      revision_check: trace.revisionCheck,
      candidates: trace.candidates.map((candidate) => ({ ...passageFields(candidate.passage, candidate), content: candidate.passage.content, fate: candidate.fate })),
      index: trace.index ? { sources: trace.index.sources, chunks: trace.index.chunks, embedded_chunks: trace.index.embeddedChunks } : null,
    },
  };
}
