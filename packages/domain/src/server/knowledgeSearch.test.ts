import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DomainContext } from "./context";
import type { KnowledgePassage } from "../knowledgeRanking";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), productEvent: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock("@lobbystack/db", async original => ({ ...(await original<typeof import("@lobbystack/db")>()), withBusinessTransaction: mocks.transaction }));
vi.mock("./productEvents", async original => ({ ...(await original<typeof import("./productEvents")>()), recordProductEventBestEffort: mocks.productEvent }));
import { chunkText, searchKnowledgeEvidence, traceKnowledgeSearch } from "./knowledge";
import { searchKnowledgeForApi } from "./publicApi/knowledgeSearch";

const primary: KnowledgePassage = { chunkId: "chunk", documentId: "document", title: "BAA", content: "Management", sourceUrl: "https://example.com/baa", sourceRevision: 3, sequence: 1 };
const adjacent: KnowledgePassage = { ...primary, chunkId: "adjacent", sequence: 2, content: "MNGT 10407 — Approches du management." };
const dialect = new PgDialect();
const statements: string[] = [];
let lexical: KnowledgePassage[];
let semantic: KnowledgePassage[];
let current: KnowledgePassage[];
let failAll: boolean;
// The keyword half's query runs out of its 2 seconds.
let keywordTimesOut: boolean;
const statementTimeout = () => Object.assign(new Error("Failed query: canceling statement due to statement timeout"), { cause: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }) });

beforeEach(() => {
  statements.length = 0;
  lexical = [primary]; semantic = [primary]; current = [primary, adjacent]; failAll = false; keywordTimesOut = false;
  mocks.productEvent.mockClear();
  mocks.transaction.mockImplementation(async (_db, actor, callback) => {
    expect(actor.businessId).toBe("tenant-a");
    return callback({ execute: async (statement: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const query = dialect.sqlToQuery(statement);
      statements.push(query.sql);
      if (query.sql.startsWith("SET")) return { rows: [] };
      if (failAll) throw new Error("database unavailable");
      expect(query.params).toContain("tenant-a");
      expect(query.sql).toContain("d.active = true AND d.status = 'indexed'");
      if (query.sql.includes("BETWEEN")) return { rows: current };
      if (keywordTimesOut && query.sql.includes("search_words @@")) throw statementTimeout();
      return { rows: query.sql.includes("<=>") ? semantic : lexical };
    } });
  });
});

function context(embed = vi.fn().mockResolvedValue([[0.1, 0.2]])): DomainContext {
  return { db: {} as never, embeddings: { embed } };
}
afterEach(() => vi.useRealTimers());

describe("knowledge evidence", () => {
  it("reserves primary evidence before expanding neighboring chunks", async () => {
    const content = Array.from({ length: 90 }, (_, index) => `detail${index}`).join(" ");
    lexical = semantic = Array.from({ length: 6 }, (_, index) => ({ ...primary, chunkId: `primary-${index}`, documentId: `document-${index}`, sequence: 1, content: `${content} ${index === 5 ? "MNGT 10407" : ""}` }));
    current = lexical.flatMap(row => [row, { ...row, chunkId: `${row.chunkId}-before`, sequence: 0, content }, { ...row, chunkId: `${row.chunkId}-after`, sequence: 2, content }]);
    const result = await searchKnowledgeEvidence(context(), { businessId: "tenant-a", query: "management" });
    expect(result.matches).toHaveLength(6);
    expect(result.matches.some(row => row.content.includes("MNGT 10407"))).toBe(true);
  });
  it("bounds a stalled embedding request and uses keyword results", async () => {
    vi.useFakeTimers();
    const result = searchKnowledgeEvidence(context(vi.fn().mockImplementation(() => new Promise(() => {}))), { businessId: "tenant-a", query: "management" });
    await vi.advanceTimersByTimeAsync(1801);
    expect(await result).toMatchObject({ mode: "keyword", outcome: "found" });
  });
  it("returns neighboring evidence with source revision and no generated answer", async () => {
    const result = await searchKnowledgeEvidence(context(), { businessId: "tenant-a", query: "management" });
    expect(result.outcome).toBe("found");
    expect(result.mode).toBe("hybrid");
    expect(result.matches[0]).toMatchObject({ sourceRevision: 3, supportingChunkIds: ["chunk", "adjacent"] });
    // The ranked chunk's place in the expanded content, for readers with little room.
    const match = result.matches[0]!;
    expect(match.content.slice(match.focusStart, match.focusEnd)).toBe(current.find(row => row.chunkId === match.chunkId)!.content);
    expect(result.matches[0]?.content).toContain("MNGT 10407");
    expect(statements.filter(value => value.includes("LIMIT 12"))).toHaveLength(2);
    // Each read turns query compiling off: the audience filter's estimates would trigger it.
    expect(statements.filter(value => value === "SET LOCAL jit = off").length).toBe(statements.filter(value => value.startsWith("SET LOCAL statement_timeout")).length);
  });
  it("marks where the ranked chunk sits between its neighbors", async () => {
    const before = { ...primary, chunkId: "before", sequence: 0, content: "Earlier section about mailboxes." };
    current = [adjacent, primary, before];
    const [match] = (await searchKnowledgeEvidence(context(), { businessId: "tenant-a", query: "management" })).matches;
    expect(match!.content).toBe(`${before.content}\n\n${primary.content}\n\n${adjacent.content}`);
    expect(match!.content.slice(match!.focusStart, match!.focusEnd)).toBe(primary.content);
  });
  it("keeps keyword search when embeddings fail", async () => {
    const result = await searchKnowledgeEvidence(context(vi.fn().mockRejectedValue(new Error("private provider error"))), { businessId: "tenant-a", query: "MNGT 10407" });
    expect(result).toMatchObject({ mode: "keyword", outcome: "found", failure: "embedding_unavailable" });
    expect(JSON.stringify(result)).not.toContain("private provider error");
  });
  it("discards evidence deleted or revised while searches were running", async () => {
    current = [];
    const result = await searchKnowledgeEvidence(context(), { businessId: "tenant-a", query: "management" });
    expect(result).toMatchObject({ matches: [], outcome: "empty" });
  });
  it("distinguishes database failure from no evidence", async () => {
    failAll = true;
    expect(await searchKnowledgeEvidence(context(), { businessId: "tenant-a", query: "management" })).toMatchObject({ matches: [], outcome: "unavailable", failure: "search_unavailable" });
  });
  it("matches the stored words, and picks the closest passages before reading their text", async () => {
    await searchKnowledgeEvidence(context(), { businessId: "tenant-a", query: "management" });
    const keyword = statements.find(value => value.includes("to_tsquery") && value.includes("LIMIT 12"))!;
    // Migration 0145's words, checked instead of rebuilt for every passage.
    expect(keyword).toContain("c.search_words @@ to_tsquery('simple', $");
    expect(keyword).not.toContain("to_tsvector");
    const meaning = statements.find(value => value.includes("<=>"))!;
    // The 12 closest from ids and embeddings alone, then their text.
    expect(meaning).toContain("nearest AS (SELECT c.id FROM knowledge_chunks c");
    expect(meaning).not.toContain("MATERIALIZED");
  });
  it("records which half ran out of its 2 seconds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    keywordTimesOut = true;
    // The meaning half still answers, so the search finds something.
    expect(await searchKnowledgeEvidence(context(), { businessId: "tenant-a", query: "management" })).toMatchObject({ mode: "hybrid", outcome: "found" });
    const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ message: "knowledge.search_timed_out", businessId: "tenant-a", keyword: "timed_out", meaning: "ok" }));
    expect(mocks.productEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "knowledge.search_executed", properties: expect.objectContaining({ keywordHalf: "timed_out", meaningHalf: "ok", outcome: "found" }) }));
    // Neither half out of time: no line, and both halves answered.
    warn.mockClear();
    keywordTimesOut = false;
    await searchKnowledgeEvidence(context(vi.fn().mockRejectedValue(new Error("provider down"))), { businessId: "tenant-a", query: "management" });
    expect(warn.mock.calls.map(([line]) => String(line)).filter(line => line.includes("knowledge.search_timed_out"))).toEqual([]);
    expect(mocks.productEvent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ properties: expect.objectContaining({ keywordHalf: "ok", meaningHalf: "failed" }) }));
    // Only words a search leaves out: nothing to match.
    await searchKnowledgeEvidence({ db: {} as never }, { businessId: "tenant-a", query: "are you on" });
    expect(mocks.productEvent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ properties: expect.objectContaining({ keywordHalf: "skipped", meaningHalf: "skipped" }) }));
    warn.mockRestore();
  });
  it("returns empty when both indexes have no matches", async () => {
    lexical = []; semantic = [];
    expect(await searchKnowledgeEvidence(context(), { businessId: "tenant-a", query: "unknown" })).toMatchObject({ matches: [], outcome: "empty" });
  });
});

describe("knowledge search trace", () => {
  const passage = (chunkId: string, extra: Partial<KnowledgePassage> = {}): KnowledgePassage => ({ ...primary, chunkId, documentId: `document-${chunkId}`, title: `Title ${chunkId}`, content: `Parking ${chunkId}`, sequence: 1, ...extra });
  let scores: Array<{ chunkId: string; allTerms: number; anyTerm: number }>;
  let distances: Array<{ chunkId: string; distance: number }>;
  let failReads: boolean;
  let failCurrent: boolean;
  let counted: { sql: string; params: unknown[] } | undefined;
  const traced = (embed = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]])): DomainContext => ({ db: {} as never, embeddings: { fingerprint: "fp-1", embed } });

  beforeEach(() => {
    scores = []; distances = []; failReads = false; failCurrent = false; counted = undefined;
    mocks.transaction.mockImplementation(async (_db, actor, callback) => {
      expect(actor).toMatchObject({ businessId: "tenant-a", actorType: "worker" });
      return callback({ execute: async (statement: Parameters<typeof dialect.sqlToQuery>[0]) => {
        const query = dialect.sqlToQuery(statement);
        statements.push(query.sql);
        if (query.sql.startsWith("SET")) return { rows: [] };
        expect(query.params).toContain("tenant-a");
        // The reads the trace adds after the search.
        if (query.sql.includes('AS "allTerms"')) { if (failReads) throw new Error("database unavailable"); return { rows: scores }; }
        if (query.sql.includes("AS distance")) { if (failReads) throw new Error("database unavailable"); return { rows: distances }; }
        if (query.sql.includes("count(DISTINCT")) { counted = { sql: query.sql, params: query.params }; if (failReads) throw new Error("database unavailable"); return { rows: [{ sources: "2", chunks: "9", embeddedChunks: "7" }] }; }
        // The search's own statements.
        if (query.sql.includes("BETWEEN")) { if (failCurrent) throw new Error("database unavailable"); return { rows: current }; }
        return { rows: query.sql.includes("<=>") ? semantic : lexical };
      } });
    });
  });

  it("answers exactly as the receptionist's search does", async () => {
    const receptionist = await searchKnowledgeEvidence(traced(), { businessId: "tenant-a", query: "management" });
    const { result } = await traceKnowledgeSearch(traced(), { businessId: "tenant-a", query: "management", source: "api" });
    expect({ ...result, durationMs: 0 }).toEqual({ ...receptionist, durationMs: 0 });
    expect(result.matches[0]).toMatchObject({ supportingChunkIds: ["chunk", "adjacent"] });
  });

  it("ranks every candidate with its scores and says what became of it", async () => {
    // b is found by both searches, so it ranks first; g ranks seventh, below the six kept.
    lexical = ["a", "b", "c", "d", "e", "f", "g"].map(id => passage(id, id === "d" ? { content: "word ".repeat(3500) } : {}));
    semantic = [lexical[1]!];
    // c's source changed while the search ran, so the recheck doesn't return it.
    current = lexical.filter(row => row.chunkId !== "c" && row.chunkId !== "g");
    scores = [{ chunkId: "a", allTerms: 0.5, anyTerm: 0.25 }, { chunkId: "b", allTerms: "0.1" as never, anyTerm: 0.05 }];
    distances = [{ chunkId: "b", distance: 0.12 }];
    const { result, trace } = await traceKnowledgeSearch(traced(), { businessId: "tenant-a", query: "parking fees" });
    expect(result.matches.map(row => row.chunkId)).toEqual(["b", "a", "e", "f"]);
    expect(trace.candidates.map(row => [row.passage.chunkId, row.rank, row.lexicalRank, row.semanticRank, row.fate])).toEqual([
      ["b", 1, 2, 1, "evidence"],
      ["a", 2, 1, null, "evidence"],
      ["c", 3, 3, null, "stale"],
      ["d", 4, 4, null, "over_budget"],
      ["e", 5, 5, null, "evidence"],
      ["f", 6, 6, null, "evidence"],
      ["g", 7, 7, null, "below_limit"],
    ]);
    expect(trace.candidates[0]!.score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(trace.candidates[3]!.tokens).toBeGreaterThan(trace.tokenBudget);
    expect(trace).toMatchObject({
      query: "parking fees",
      terms: ["parking", "fees"],
      lexicalQuery: { any: "parking | (fees | f.e.e.s)", all: "parking & (fees | f.e.e.s)" },
      limit: 6,
      tokenBudget: 3000,
      revisionCheck: "ok",
      index: { sources: 2, chunks: 9, embeddedChunks: 7 },
      semantic: { status: "ok", error: null, embeddingFingerprint: "fp-1", embeddingDimensions: 3, candidates: [{ chunkId: "b", rank: 1, distance: 0.12 }] },
    });
    expect(trace.lexical).toMatchObject({ status: "ok", error: null });
    expect(trace.lexical.candidates.slice(0, 3)).toEqual([
      { chunkId: "a", rank: 1, scoreAllTerms: 0.5, scoreAnyTerm: 0.25 },
      { chunkId: "b", rank: 2, scoreAllTerms: 0.1, scoreAnyTerm: 0.05 },
      { chunkId: "c", rank: 3, scoreAllTerms: null, scoreAnyTerm: null },
    ]);
    // The scores are read for the search's own results, and the count only reaches this model's embeddings.
    const scoreRead = statements.find(value => value.includes('AS "allTerms"'))!;
    expect(scoreRead).toContain("ts_rank_cd");
    expect(statements.find(value => value.includes("count(DISTINCT"))).toContain("c.embedding_fingerprint = ");
  });

  it("keeps scores and counts null when the reads that fill them fail, and the answer unchanged", async () => {
    failReads = true;
    const receptionist = await searchKnowledgeEvidence(traced(), { businessId: "tenant-a", query: "management" });
    const { result, trace } = await traceKnowledgeSearch(traced(), { businessId: "tenant-a", query: "management" });
    expect({ ...result, durationMs: 0 }).toEqual({ ...receptionist, durationMs: 0 });
    expect(trace.lexical.candidates).toEqual([{ chunkId: "chunk", rank: 1, scoreAllTerms: null, scoreAnyTerm: null }]);
    expect(trace.semantic.candidates).toEqual([{ chunkId: "chunk", rank: 1, distance: null }]);
    expect(trace.index).toBeNull();
  });

  it("names a failed stage by code, never by the provider's or database's message", async () => {
    const timeout = Object.assign(new Error("Failed query: canceling statement due to statement timeout"), { cause: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }) });
    mocks.transaction.mockImplementationOnce(async (_db, _actor, callback) => callback({ execute: async (statement: Parameters<typeof dialect.sqlToQuery>[0]) => {
      if (dialect.sqlToQuery(statement).sql.startsWith("SET")) return { rows: [] };
      throw timeout;
    } }));
    const { result, trace } = await traceKnowledgeSearch(traced(vi.fn().mockRejectedValue(new Error("private provider error"))), { businessId: "tenant-a", query: "management" });
    expect(result).toMatchObject({ outcome: "unavailable", mode: "keyword", failure: "search_unavailable" });
    expect(trace.lexical).toMatchObject({ status: "failed", error: "statement_timeout", candidates: [] });
    expect(trace.semantic).toMatchObject({ status: "failed", error: "embedding_failed", embeddingDimensions: null, candidates: [] });
    expect(trace.revisionCheck).toBeNull();
    expect(JSON.stringify(trace)).not.toMatch(/private provider error|canceling statement/);
    const unconfigured = await traceKnowledgeSearch({ db: {} as never }, { businessId: "tenant-a", query: "management" });
    expect(unconfigured.trace.semantic).toMatchObject({ status: "failed", error: "embedding_unavailable", embeddingFingerprint: null });
  });

  it("marks the kept candidates unverified when the revision check fails", async () => {
    failCurrent = true;
    const { result, trace } = await traceKnowledgeSearch(traced(), { businessId: "tenant-a", query: "management" });
    expect(result).toMatchObject({ matches: [], outcome: "unavailable", failure: "search_unavailable" });
    expect(trace.revisionCheck).toBe("failed");
    expect(trace.candidates.map(row => row.fate)).toEqual(["unverified"]);
  });

  it("counts only the sources and chunks the receptionist answering may use", async () => {
    const receptionistId = "6f1c2b9e-8a4d-4f3e-9b7a-2c5d8e1f0a3b";
    const { trace } = await traceKnowledgeSearch(traced(), { businessId: "tenant-a", query: "management", receptionistId });
    expect(trace.index).toEqual({ sources: 2, chunks: 9, embeddedChunks: 7 });
    // The search's own reader and audience filters, so the count matches what the search can find.
    expect(counted?.sql).toContain("WITH reader AS (");
    expect(counted?.sql).toContain("knowledge_document_receptionists");
    expect(counted?.sql).toContain("d.active = true AND d.status = 'indexed'");
    expect(counted?.params).toContain(receptionistId);
    expect(statements.filter(value => value.includes("WITH reader AS (")).length).toBeGreaterThan(1);
  });

  it("skips the keyword search for a query of only common words", async () => {
    const { trace } = await traceKnowledgeSearch(traced(), { businessId: "tenant-a", query: "what is the" });
    expect(trace).toMatchObject({ terms: [], lexicalQuery: null, lexical: { status: "skipped", error: null, candidates: [] }, semantic: { status: "ok" } });
  });
});

describe("v1 knowledge search", () => {
  const caller = { businessId: "tenant-a", apiKeyId: "key" };
  const snapshot = { version: "v7", generatedAt: "2026-11-03T12:00:00.000Z", knowledgeSnippets: [{ title: "Parking", content: "Parking is free after 6 pm. ", priority: 0 }, { title: "Hours", content: "Open daily.", priority: 0 }] };
  const withSnapshot = (): DomainContext => ({ ...context(), snapshotCache: { get: vi.fn(async () => snapshot as never), set: vi.fn(async () => undefined) } });

  it("returns the evidence, what the model receives and what a call hears, with every stage", async () => {
    lexical = [{ ...primary, content: "Management parking" }];
    semantic = [lexical[0]!];
    current = [lexical[0]!];
    const callAnswer = vi.fn(() => "Facts for the call.");
    const result = await searchKnowledgeForApi(withSnapshot(), caller, { query: "management parking" }, { callAnswer });
    expect(result).toMatchObject({
      query: "management parking",
      outcome: "found",
      mode: "hybrid",
      failure: null,
      token_budget: 3000,
      snapshot: { version: "v7", generated_at: "2026-11-03T12:00:00.000Z" },
      call_answer: "Facts for the call.",
    });
    expect(Number.isInteger(result.duration_ms)).toBe(true);
    expect(result.evidence).toEqual([{
      rank: 1, chunk_id: "chunk", document_id: "document", title: "BAA", source_url: "https://example.com/baa", source_revision: 3, sequence: 1,
      rrf_score: 2 / 61, lexical_rank: 1, semantic_rank: 1, tokens: expect.any(Number),
      content: "Management parking", supporting_chunk_ids: ["chunk"], focus_start: 0, focus_end: 18,
    }]);
    // The receptionist's tool result: the evidence first, then the matching text entry, whole.
    expect(result.receptionist_result).toEqual({ outcome: "found", matches: [{ title: "BAA", text: "Management parking", focusStart: 0, focusEnd: 18 }, { title: "Parking", text: "Parking is free after 6 pm." }] });
    expect(callAnswer).toHaveBeenCalledWith("management parking", result.receptionist_result);
    expect(result.trace.candidates).toEqual([expect.objectContaining({ chunk_id: "chunk", rank: 1, content: "Management parking", fate: "evidence" })]);
    expect(result.trace).toMatchObject({ terms: ["management", "parking"], revision_check: "ok", lexical: { status: "ok", candidates: [{ rank: 1, chunk_id: "chunk" }] }, semantic: { status: "ok", embedding_dimensions: 2, candidates: [{ rank: 1, chunk_id: "chunk" }] } });
  });

  it("answers as the default receptionist, with only the text entries it may use", async () => {
    lexical = []; semantic = [];
    const each = { status: "active", listed: true, description: null, locale: null, greeting: null, voiceInstructions: null, smsInstructions: null, chatInstructions: null, bookingPolicy: null, bookingMode: "request", transferPolicy: null };
    const shared = {
      ...snapshot,
      knowledgeSnippets: [{ id: "parking", title: "Parking", content: "Parking is free after 6 pm.", priority: 0 }, { id: "hours", title: "Hours", content: "Parking lot hours: open daily.", priority: 0 }],
      receptionists: [{ ...each, id: "front", name: "Front desk", isDefault: true, snippetIds: ["hours"] }, { ...each, id: "valet", name: "Valet", isDefault: false, snippetIds: ["parking", "hours"] }],
    };
    const withReceptionists: DomainContext = { ...context(), snapshotCache: { get: vi.fn(async () => shared as never), set: vi.fn(async () => undefined) } };
    const result = await searchKnowledgeForApi(withReceptionists, caller, { query: "parking" }, { callAnswer: () => undefined });
    // Only the valet may use the parking entry, so the default's result leaves it out.
    expect(result.receptionist_result).toEqual({ outcome: "found", matches: [{ title: "Hours", text: "Parking lot hours: open daily." }] });
    // The documents come from the same reader: the default, as no receptionist is named.
    expect(statements.some(value => value.includes("WITH reader AS ("))).toBe(true);
  });

  it("answers as the receptionist named, with the text entries it may use, and says which one it ran as", async () => {
    lexical = []; semantic = [];
    const front = "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e51";
    const valet = "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e52";
    const each = { status: "active", listed: true, description: "", locale: null, greeting: null, voiceInstructions: null, smsInstructions: null, chatInstructions: null, bookingPolicy: null, bookingMode: "request", transferPolicy: null };
    const shared = {
      ...snapshot,
      knowledgeSnippets: [{ id: "parking", title: "Parking", content: "Parking is free after 6 pm.", priority: 0 }, { id: "hours", title: "Hours", content: "Parking lot hours: open daily.", priority: 0 }],
      receptionists: [{ ...each, id: front, name: "Front desk", isDefault: true, snippetIds: ["hours"] }, { ...each, id: valet, name: "Valet", isDefault: false, snippetIds: ["parking", "hours"] }],
    };
    const withReceptionists: DomainContext = { ...context(), snapshotCache: { get: vi.fn(async () => shared as never), set: vi.fn(async () => undefined) } };
    const result = await searchKnowledgeForApi(withReceptionists, caller, { query: "parking", receptionist_id: valet }, { callAnswer: () => undefined });
    expect(result.receptionist_id).toBe(valet);
    // An id in capitals names the same receptionist.
    expect((await searchKnowledgeForApi(withReceptionists, caller, { query: "parking", receptionist_id: valet.toUpperCase() }, { callAnswer: () => undefined })).receptionist_id).toBe(valet);
    expect(result.receptionist_result.matches.map((match) => match.title)).toEqual(["Parking", "Hours"]);
    // The documents come from the valet's reader.
    expect(statements.some((value) => value.includes("WITH reader AS ("))).toBe(true);
    // Without a name, the default answers, without the valet's entry.
    const fallback = await searchKnowledgeForApi(withReceptionists, caller, { query: "parking" }, { callAnswer: () => undefined });
    expect(fallback.receptionist_id).toBe(front);
    expect(fallback.receptionist_result.matches.map((match) => match.title)).toEqual(["Hours"]);
  });

  it("keeps the business's entries when the search finds nothing, and says when a call would get nothing", async () => {
    lexical = []; semantic = [];
    const empty = await searchKnowledgeForApi(withSnapshot(), caller, { query: "parking" }, { callAnswer: () => undefined });
    expect(empty).toMatchObject({ outcome: "empty", evidence: [], call_answer: null, receptionist_result: { outcome: "found", matches: [{ title: "Parking" }] } });
    // No snapshot yet, and both searches fail.
    failAll = true;
    const noSnapshot = vi.fn(async (_db: unknown, _actor: unknown, callback: (tx: unknown) => unknown) => callback({ select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) }));
    mocks.transaction.mockImplementationOnce(noSnapshot);
    const down = await searchKnowledgeForApi({ db: {} as never }, caller, { query: "hours" }, { callAnswer: () => undefined });
    expect(noSnapshot).toHaveBeenCalledTimes(1);
    expect(down).toMatchObject({ outcome: "unavailable", failure: "search_unavailable", snapshot: null, receptionist_result: { outcome: "unavailable", matches: [] } });
  });
});

describe("knowledge chunk boundaries", () => {
  it("starts a new passage at a course heading instead of mixing adjacent courses", () => {
    const chunks = chunkText("## Marketing\nMARK 10100 Introduction to marketing.\n## Management\nMNGT 10407 Management fundamentals.");
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe("## Management\nMNGT 10407 Management fundamentals.");
    expect(chunkText("## Marketing MARK 10100. ## Management MNGT 10407.")).toHaveLength(2);
  });
  it("preserves headings and overlapping evidence", () => {
    const text = "# Programme BAA\n\n" + "Préparation. ".repeat(12) + "\n## Management\nMNGT 10407\nApproches du management.\n" + "Suite. ".repeat(20);
    const chunks = chunkText(text, { maxCharacters: 200, overlap: 80 });
    expect(chunks.every(chunk => chunk.length <= 200)).toBe(true);
    expect(chunks.some(chunk => chunk.includes("Management\nMNGT 10407"))).toBe(true);
    expect(chunks[0]).toContain("# Programme BAA\n");
  });
  it("handles blank text and rejects non-progressing sizes", () => {
    expect(chunkText("  \n ")).toEqual([]);
    expect(() => chunkText("hello", { maxCharacters: 0 })).toThrow();
  });
});
