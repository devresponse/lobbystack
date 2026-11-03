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

## Give articles to chosen receptionists

Since fork PR #129 a business can have several receptionists that share one library, and each article (a file, a website page or a text entry) is available to everyone or to chosen receptionists ([receptionists](../features/receptionists.md#give-each-receptionist-its-knowledge)).

- **Tables:** `knowledge_documents.audience` and `knowledge_snippets.audience` (`everyone` or `chosen`), with `knowledge_document_receptionists` and `knowledge_snippet_receptionists` naming who a chosen article is for, and `knowledge_website_rules`, whose rows give a crawled site's pages under a path to one receptionist (migration `0136`). The worker applies a website's rules to each page it saves, so later crawls follow them.
- **Who may use what:** a receptionist whose `knowledge_scope` is `all`, as the default receptionist's is, uses every article; one whose scope is `audience` uses the articles for everyone and those chosen for it. An article chosen only for archived receptionists, or for none, is left to the default receptionist. `receptionistMayUse` (`packages/shared/src/receptionists.ts`) and the filter in `searchKnowledgeEvidence` follow the same rule.
- **The snapshot** ranks text entries and documents for each receptionist among the ones it may use (`packages/domain/src/server/snapshotKnowledge.ts`): each keeps its best 50 entries and a digest of its 40 newest documents, and an entry is stored once however many receptionists use it. The default receptionist's are the snapshot's own fields, as before; `snapshotForReceptionist` cuts any other's view.
- **The business summary** is generated from articles for everyone only, so one receptionist's articles don't reach the others through it.

A question the receptionist couldn't answer goes on the business's list of [unanswered questions](../features/unanswered-questions.md), whose answers become text entries. A website chat saves it as the receptionist replies; a call's come from the summary written after it (fork PR #106). An empty search isn't the test, because the search returns its closest passages even when none answers.

## Keep provider boundaries

- Configured OpenAI-compatible adapters handle non-realtime text generation and embeddings behind `packages/providers`. Chat and embedding models/endpoints are deployment-wide and independently configurable.
- Firecrawl optionally imports public website content.
- S3-compatible storage holds original uploads and generated artifacts.
- PostgreSQL RLS and business-scoped transactions enforce tenant isolation.
