# Know what limits scale, 2026-10-18

On 2026-10-18 the whole system was read for what stops it growing, from `main` at `160b18a`. The answer: the single database isn't the first limit. Database connections, the one admin process, background jobs that run per business, and the shared provider accounts bite first. This page keeps the limits, the options for each part, and the roadmap. It is analysis only: nothing here has been built, apart from the billing fixes noted below. Numbers are marked measured (local load tests on 2026-10-15, with the AI replaced by a 4-second stand-in), computed (from constants in the code) or inferred (estimates). Nothing was measured on Railway.

## Know what breaks first

| # | Limit | When it bites | Fix |
| --- | --- | --- | --- |
| 1 | **Database connections.** Postgres keeps its default of 100. One admin process opens up to 40 connections (52 with the finance export) and one worker 16, from pools of 12 per database role (`packages/db/src/client.ts`). | A second admin copy during a worker deploy, while the old worker drains beside the new one: 2 × 40 + 2 × 16 = 112 (computed). | PgBouncer in transaction mode, logging in as each runtime role, since security functions check `session_user`; or smaller pools (`LOBBYSTACK_*_POOL_MAX`). |
| 2 | **One admin process, one Node thread,** with no replicas. | About 400 people chatting at once; opens took 3.5 s at 600 and failed at 800 (measured). A bigger machine doesn't help one thread. | Two or more admin copies once connections are pooled, and a drain on shutdown. |
| 3 | **Background jobs per business.** Each active business has its own schedules, about 192 runs an hour, each a database transaction even with nothing to do (`apps/worker/src/scheduler.ts`). | 53 jobs a second at 1,000 active businesses, 533 at 10,000 (computed). | One job per type that pages through businesses, or work driven by events. |
| 4 | **The hourly transcript clean-up** scans the whole `transcripts` table once per business: no index on `business_id` or `expires_at`. | Work grows with businesses times table size (inferred). | An index on (`business_id`, `expires_at`), or monthly partitions dropped whole. |
| 5 | **Shared provider accounts.** | GPT-Live allows 50 calls at once on OpenAI's Build tier, 300 on Launch and 500 on Grow, for every business together. | A provider project and subaccount per cell; more capacity from OpenAI; a second voice source. |
| 6 | **The worker:** 34 job slots share a 12-connection pool with every live call; no cap on calls; call audio decoded on the main thread. | Bursts of uploads, texts or calls wait up to 5 s for a connection, then fail (inferred). | Concurrency and pool size by variable, two or more copies, a per-process call cap. |
| 7 | **Redis:** one node, no memory ceiling, `noeviction`, one connection per open dashboard tab. When it fails, jobs stop and rate-limited routes answer 503. | 10,000 connections across copies, or any outage. | A memory ceiling with an alert, one subscriber per process, a standby. |
| 8 | **One Postgres** with stock settings, a 5 GB volume and the community pgvector image. | Railway's standby and point-in-time recovery work only on Railway's own images, which already ship pgvector 0.8; the volume allows 3,000 reads and 3,000 writes a second. | Tuned memory; Railway's own image with a standby and point-in-time recovery, or a managed Postgres. |
| 9 | **Tables that never shrink:** calls, conversations, messages, audit logs, usage and provider events, notifications. | Disk, indexes and backups grow forever. | A retention rule per table; monthly partitions for event tables. |
| 10 | **Lookups that read whole tables:** sign-in by `users.email`, the Resend webhook's lookups, contacts by phone across businesses, the monthly usage replay. | Grows with users, notifications, contacts and a business's volume. | Indexes; running usage counters. |
| 11 | **The outbox** publishes one row at a time, and every call transcript turn writes one. | About 200 to 500 rows a second per dispatcher (inferred). | Batched claims, and a separate path for live updates. |
| 12 | **No CDN:** `/embed.js` and public profile pages reach the admin on every view. | Every page view on every customer website. | Cloudflare in front, caching the loader and profile pages. |

## Weigh the database options

One Postgres can carry this product much further once pooling, indexes and the per-business jobs are fixed. It is still a ceiling: on Railway's Pro plan one database tops out at 24 vCPU and 24 GB, about 600 widget replies a second at the measured 4% of a core each (inferred).

| Option | Fit with this code | When |
| --- | --- | --- |
| Pooling and tuning | PgBouncer's transaction mode keeps `set_config(..., true)` and transaction advisory locks working; it must log in as each of the six runtime roles, and the migrator connects directly. | Now |
| Indexes and retention | Limits 4, 9 and 10. A partitioned table's unique keys must include its partition column. | Now |
| Standby and point-in-time recovery | Railway's (experimental high availability, beta point-in-time recovery) need its own images; leaving `pgvector/pgvector:pg16` means a dump and restore into a new service. Most managed Postgres services offer both with pgvector. | Before revenue depends on it |
| Read replicas | Policies are part of the schema, so they hold on a replica; live paths stay on the primary. | When reports compete with live traffic |
| Distributed Postgres (Citus) | Every key would have to include `business_id`, its row-level security examples use a role per tenant, its image has no pgvector, and Azure's managed Citus is retiring. | Not recommended |
| Cells | Each cell is today's whole stack with its own Postgres and Redis; a directory maps each business to its cell. | The long-term answer |

Before businesses can live in separate databases: lookups that arrive without a business (incoming calls, widget keys, API key prefixes, profile slugs, Polar events) need a directory; unique keys that don't include the business (user emails, outbox dedupe keys, idempotency keys) move to a shared layer or gain the business; and deployment-wide jobs run once per cell.

## Scale Redis

Memory isn't Redis's limit, since jobs and counters expire; being a single copy is. In order: a memory ceiling with an alert, keeping `noeviction`, which BullMQ requires; one shared subscriber per process for dashboards; then a standby with failover (Railway's Redis high availability takes the official `redis` image). Later, a durable node for queues and sessions and a cache node for limits, pub/sub and snapshots. Braces in keys (`{critical}` queue names, the business ID in counter keys) keep a Redis Cluster possible; without them the presence and rate-limit scripts fail on a cluster.

## Scale each part

The admin and the worker keep nothing between requests that another copy couldn't pick up, so both can run as several copies once connections are pooled. Several copies also need bucket storage, one Redis, `APP_BASE_URL` set before the admin's build, and drain time on the worker ([billing's second pass](../billing/design-history.md#make-a-second-pass-2026-10-23) ran two of each without problems).

| Combination | Buys | Binds next |
| --- | --- | --- |
| Pooling, 3 admin copies, 2 workers | About 1,200 people chatting at once (inferred) and deploys that don't drop chats | Background jobs and the transcript scan |
| Plus one job per type, indexes and retention | Background load stops growing with businesses | GPT-Live's 500 calls at once |
| Plus standbys, a read copy and partitions | A failed machine means a short failover | Writes on one primary, and one region |
| Cells behind a directory | Capacity and failure radius per cell, other regions | The shared layer, and the provider caps cells don't raise |

## Know the sign-up, account and billing limits

| Area | Limit found | Since |
| --- | --- | --- |
| Sign-up | Always open: no invite-only mode, allowlist or off switch; sign-in looks users up by an unindexed column. | Open ([open items](../project/open-items.md)) |
| Onboarding | One owner can create 10 businesses, because each adds worker jobs; the partner API skips the cap. | Open |
| Accounts | No deletion, suspension or export of a user or business, no 2FA or SSO, no operator console. | Open |
| Plans | Upgrading opened a second checkout, and any subscription's event overwrote the account's one subscription ID. | Fixed in fork PRs #60 and #75 |
| Usage | Each reservation replays the business's month under one lock; events go to Polar one request each, were dropped after about 3 hours of retries, and corrections reused their ID. | Retries and corrections fixed in #71 and #75; the replay and one-event requests are unchanged |
| Texts | One shared toll-free number sends every cloud business's alerts, 3 messages a second by default, and one STOP opts a phone out of every business. | Partly addressed: since #55 a business with its own number texts from it ([SMS](../features/sms.md)) |
| Partner keys | Keys live in `PLATFORM_API_KEYS`, so rotating one needs a redeploy. | Open |

Polar's acceptable use policy, effective 2026-03-25, prohibits "Telecommunication and eSIM Services" and reviews AI voice tools more closely. Ask Polar to confirm in writing that an AI receptionist that rents phone numbers is accepted before revenue depends on it.

## Know the shared accounts

| Account | Limit | Way past it |
| --- | --- | --- |
| OpenAI GPT-Live | 50 calls at once on Build, 300 on Launch, 500 on Grow; no self-serve tier above Grow | Ask OpenAI for more; a second voice source behind a voice-provider interface |
| OpenAI usage | $500 a month on Build, $5,000 on Launch; one busy or abused business can spend it for everyone | An OpenAI project per cell; an AI budget per business |
| OpenAI SIP webhook | One project, so every call reaches every deployment sharing it | A project per cell |
| Twilio voice | One account and SIP trunk; unlimited calls with an approved Business profile, 2 at once without | A subaccount per cell or business |
| Twilio texts | One toll-free sender, 3 messages a second | Twilio's ISV setup: a subaccount and brand per business |
| Polar | 500 API requests a minute per organization | Batched usage events |
| Email (Resend) | 10 requests a second per team; a new SMTP connection per message | A pooled connection or the batch API |

## Follow the roadmap

| Phase | Work | Start when |
| --- | --- | --- |
| 1. Harden one stack | PgBouncer, memory settings, the indexes, one job per type, a Redis ceiling, a drain on shutdown and two admin copies, Cloudflare caching the loader and profile pages, usage counters and Polar batching, a sign-up mode | Now |
| 2. Survive a failure | A Postgres standby and point-in-time recovery, a Redis standby, partitions and retention, a read copy, calls on their own worker deployment, Twilio subaccounts, an AI budget per business | Before paying customers rely on it |
| 3. Split into cells | A directory, one shared sign-in, Polar events routed through the directory, an OpenAI project and Twilio subaccount per cell, a tested move of a business between cells | The primary passes about half its capacity at peak, or customers need another region |
| 4. Add cells | Cells from one template, each with a fixed maximum size, in other regions too | A cell reaches its maximum |
| Throughout | More GPT-Live capacity, and a second voice source | Calls near the tier's limit |

Phase 1 holds most of the near-term value and needs no new service except PgBouncer.
