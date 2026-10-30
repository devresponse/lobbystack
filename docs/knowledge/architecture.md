# Understand knowledge ingestion and retrieval

LobbyStack separates authoritative business facts from retrieved long-form knowledge.

- Structured facts live in PostgreSQL tables for businesses, services, staff, hours, policies, and routing rules.
- Documents, FAQs, and imported website pages live in PostgreSQL with pgvector embeddings and object-storage references.
- `packages/domain` applies tenant boundaries and compiles both sources into versioned business context snapshots.

## Follow the ingestion flow

1. An operator submits a URL, text entry, or uploaded document through `apps/admin`.
2. The API stores durable metadata and enqueues an outbox job in the same PostgreSQL transaction.
3. `apps/worker` fetches or extracts content, chunks it, creates embeddings through the configured OpenAI-compatible endpoint, and writes tenant-scoped vectors.
4. The worker refreshes the business context snapshot after indexing succeeds.

Embedding vectors are stored at the fixed `vector(1536)` dimension together with a fingerprint of the configured endpoint, model, provider name, dimensions, and revision. Semantic retrieval only compares matching fingerprints; keyword retrieval fills gaps while `knowledge.reembedBusiness` regenerates existing chunk text after a provider change.

## Use knowledge during voice calls

The admin loads one snapshot when a call starts. Structured facts stay authoritative; retrieval augments documents and FAQs. The worker answers booking and other state-changing requests through the agent core and `packages/domain`.

## Use text entries in calls and chats

Text entries reach calls and chats only through the business's snapshot, which `refreshBusinessSnapshot` in `packages/domain/src/server/knowledge.ts` rebuilds after every change. Since fork PR #105 it keeps up to 50 active entries (`MAX_KNOWLEDGE_SNIPPETS_PER_SNAPSHOT` in `packages/domain/src/snapshot.ts`), the highest priority first, then the most recently changed, then by ID, so the same entries make it in on every refresh. Before, it kept 8, so a ninth entry never reached a call. The prompts list only the 8 with the highest priority (`PROMPT_MAX_FAQS` in `packages/agent-core/src/instructions.ts`); the receptionist's knowledge search matches the snapshot's entries alongside document passages, so it finds the rest. Entries past the 50th are in neither. Checked against the code of fork PR #105.

When that search finds nothing, the question goes on the business's list of [unanswered questions](../features/unanswered-questions.md), whose answers become text entries.

## Keep provider boundaries

- Configured OpenAI-compatible adapters handle non-realtime text generation and embeddings behind `packages/providers`. Chat and embedding models/endpoints are deployment-wide and independently configurable.
- Firecrawl optionally imports public website content.
- S3-compatible storage holds original uploads and generated artifacts.
- PostgreSQL RLS and business-scoped transactions enforce tenant isolation.
