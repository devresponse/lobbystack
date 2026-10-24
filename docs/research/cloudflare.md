# Weigh a move to Cloudflare

On 2026-10-08 a study asked, with no code change, whether LobbyStack could move to Cloudflare Workers and use Cloudflare's RAG pipeline, AI Search, for knowledge lookups. **The answer: only as a rebuild of the runtime layer, not a redeploy, and not now.** Nothing was started. Code references were to the original's `main` at `77865d4` (#259); Cloudflare's products, limits and prices are as published then, and several were days old.

## Know the answer

- **Postgres stays outside Cloudflare,** reached through Hyperdrive. D1 doesn't fit: SQLite, 10 GB a database, no row-level security, no pgvector.
- **Everything that needs a long-running Node process or Redis gets rewritten:** the job queues, the per-business schedules, the outbox loop, live dashboard updates, rate limits, sign-in storage and call handling move to Queues, Cron Triggers, Workflows and Durable Objects.
- **Some pieces don't carry over at all:** tesseract OCR, SMTP email over STARTTLS, the Node OpenTelemetry SDK, and the DNS pinning that guards customer webhooks against server-side request forgery.
- **Phone calls are the weak spot.** Each call's sideband would live in a Durable Object, and every deploy restarts every Durable Object, while Cloudflare's own runtime updates, a few times a week, cut WebSockets. A call survives only by re-attaching to its GPT-Live session, which OpenAI doesn't document.
- **Effort:** about 52 to 81 developer-days for a full move, plus 8 to 12 if AI Search replaces pgvector (estimates, not measurements).
- **Cost is no reason either way:** about $5 to $20 a month on Cloudflare at 1,000 four-minute calls, while the Postgres host stays and GPT-Live's minutes (about $200) dominate.
- **It would fork the fork:** a port rewrites the database client, job system, telemetry and call controller, so the original's changes would stop merging.

## See how each part would map

| Today | On Cloudflare | Size | Catch |
| --- | --- | --- | --- |
| Admin on Node (Next.js) | Workers through vinext or OpenNext | Medium | OpenNext needed a newer Next.js and its `proxy.ts` support was experimental; sign-in, the MCP server and server-sent events need a test run |
| `pg` pools, one per database role | Hyperdrive, one configuration per role, a client per request | Medium | Query caching must be off; queries stop at 60 s; whether transaction-scoped advisory locks work needs a test |
| BullMQ queues | Queues | Large | At-least-once delivery and no job-ID deduplication, so every job needs an idempotency key |
| Schedules per business | Cron Triggers fanning out to businesses | Medium | One cron per schedule type; an account gets 250 |
| Long jobs (crawl polling, extraction, reindex) | Workflows | Medium | Durable steps with retries |
| The outbox loop | A Durable Object alarm, nudged after each commit | Medium | Keeps the lease and dedupe keys |
| Live updates over Redis pub/sub | A Durable Object per business | Medium | An open stream keeps the object billed |
| Rate limits, sign-in storage, the snapshot cache | The Rate Limiting binding, Durable Objects, KV | Small to medium | The binding is approximate; KV is eventually consistent |
| The storage bucket | R2 | Small | Possible today without moving anything else |
| Scanned-document OCR | A vision model, AI Search's OCR, or a container | Medium | tesseract.js can't load on Workers |
| SMTP email | An HTTP email API | Small | nodemailer over STARTTLS is reported broken on Workers |
| Webhook and MCP fetches with DNS pinning | `fetch` | Medium | Workers have no DNS hook, so the guard needs a new design and a security review |
| OpenTelemetry Node SDK | Workers logs and traces over OTLP | Medium | `packages/telemetry` would split so the database and domain packages stop importing the Node SDK |

## Know why calls would drop

Twilio's trunk and GPT-Live would stay as they are; only the worker's call holder would move, into one Durable Object per call named after its session, which also replaces the Redis attach lock.

- Every deploy restarts every Durable Object with no shutdown hook. A mode that lets objects finish on old code was undocumented and capped at about 5 minutes, shorter than a 30-minute call.
- Runtime updates give work in flight 30 seconds before closing WebSockets: an estimated 0.1% of four-minute calls and 1% of 30-minute calls would be cut (inferred, not measured).
- An open bug reported outgoing WebSockets in Durable Objects closing shortly after a streaming `fetch`, seen in a Twilio voice agent.
- Surviving a restart needs the call's state in the object's storage, each delegated request written down before it runs, events de-duplicated by `event_id`, and a re-attach within seconds.
- Keeping the call holder in its own rarely deployed Worker, reached through a service binding, would spare calls from app deploys but not from runtime updates.

Cloudflare's own voice kit wasn't a replacement: it takes call audio through Workers over Twilio media streams, had no French voice and didn't list OpenAI as a model provider.

## Compare AI Search with today's search

| | Today, in Postgres | AI Search |
| --- | --- | --- |
| Chunks | 1,800 characters with 180 overlap, split at Markdown headings | Token chunks; our own chunks or vectors can't be supplied |
| Keyword search | Postgres full-text search, aware of acronyms, with stop words for four languages | BM25; French and accent handling undocumented |
| Fusion | Reciprocal rank fusion of 12 keyword and 12 vector hits, top 6 plus neighbours within a 3,000-token budget | Reciprocal rank fusion; drops results under a vector score threshold (0.4 by default) |
| Reranking | None | English and Chinese only |
| Freshness | Immediate, in the same transaction | Uploads indexed "immediately", other sources every 6 hours |
| Isolation | Row-level security | One instance per business, or a shared one filtered by folder that only our code enforces |
| Speed | 95th percentile of 0.25 to 0.59 s on staging | Not published |

Today's tuning came from the [voice knowledge validation](../validation/voice-knowledge.md): the keyword half was needed for exact account codes, and splitting at headings fixed a regression. A trial needs no port, since AI Search has a REST API: load a few test businesses' Markdown, one instance each, with the same embedding model and a score threshold of 0, and run the 44 voice-knowledge probes against both searches. Adopt it only if every probe finds its expected source in French as in English, the 95th percentile stays under about 600 ms, and no result ever comes from another business. The trial wasn't run.

## Choose a shape

| Shape | What it means | Effort | Verdict |
| --- | --- | --- | --- |
| A. Full move to Workers | Everything above, calls last | 52 to 81 days | Only if being on Cloudflare is a goal in itself |
| B. Containers | Today's images as Cloudflare Containers, Redis and Postgres elsewhere | 5 to 10 days | Little gain: the same Node code, rollouts that kill after 15 minutes, no autoscaling |
| C. Pieces only | R2 for files, AI Gateway in front of the text model, an AI Search trial | 1 to 12 days each | Worth it where a piece solves a real problem |
| D. Stay on Railway | Stop deploys from hanging up calls | 2 to 4 days | Recommended then, and since done: the worker drains its calls before stopping, given `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860` ([phone call review](../reviews/phone-calls-2026-10-06.md), finding 1) |

Before any move, six things would need proving: a call surviving a forced Durable Object restart with no delegated request lost or answered twice; the admin building and signing in on Workers; row-level security and the advisory locks behaving through Hyperdrive; AI Search passing the probe test; the Twilio SDK, mammoth and PostHog's client running on Workers; and a redesigned webhook guard passing a security review.
