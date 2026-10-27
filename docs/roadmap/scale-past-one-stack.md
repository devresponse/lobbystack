# Grow past one stack

The scalability review of 2026-10-18 found that the single database isn't the first limit: database connections, the one admin process, background jobs that run for each business, and the shared provider accounts bite first ([scalability](../reviews/scalability-2026-10-18.md)). Its roadmap hardens one stack, then makes it survive a failure, then splits businesses into cells.

- **Status:** not started, apart from billing fixes. Phase 1 holds most of the near-term value and needs no new service except PgBouncer.
- **Effort:** not estimated in days; each item is a pull request or a setting of its own.
- **Measured:** one admin process served about 400 people chatting at once in a local test, slowed at 600 and failed at 800 ([widget scalability](../reviews/widget-scalability-2026-10-15.md#know-the-answer)).

## Follow the phases

| Phase | Work | Start when |
| --- | --- | --- |
| 1. Harden one stack | PgBouncer, memory settings, the missing indexes, one job per type, a Redis memory ceiling, a drain on shutdown and two admin copies, Cloudflare caching the loader and profile pages, usage counters and batched Polar events, a sign-up mode | Now |
| 2. Survive a failure | A Postgres standby and point-in-time recovery, a Redis standby, partitions and retention, a read copy, calls on a worker deployment of their own, Twilio subaccounts, an AI budget for each business | Before paying customers rely on it |
| 3. Split into cells | A directory of which cell holds each business, one shared sign-in, Polar events routed through the directory, an OpenAI project and Twilio subaccount per cell, a tested move of a business between cells | When the database passes about half its capacity at peak, or customers need another region |
| 4. Add cells | Cells from one template, each with a fixed maximum size, in other regions too | When a cell reaches its maximum |
| Throughout | More GPT-Live capacity from OpenAI, and a [second voice source](voice-provider-seam.md) | When calls near the tier's limit |

## Start with phase 1

- **PgBouncer** in transaction mode, logging in as each runtime role, since the security functions check `session_user`; or smaller pools through `LOBBYSTACK_*_POOL_MAX`. Postgres allows 100 connections, and a second admin copy during a worker deploy would need 112.
- **An index on `transcripts (business_id, expires_at)`,** which the hourly clean-up scans once for each business, and indexes for the other lookups that read whole tables.
- **One job per type** that pages through businesses, in place of about 192 scheduled runs an hour for each active business.
- **A Redis memory ceiling with an alert,** keeping `noeviction`, which the job queues need, and one shared subscriber per process for dashboards.
- **Two admin copies** once connections are pooled, with a drain on shutdown.
- **Cloudflare caching** `/embed.js` and the public profile pages ([protect the widget](protect-the-deployment.md)).
- **Running usage counters** in place of replaying a business's month for each reservation, and batched Polar events.

Before revenue depends on it, ask Polar to confirm in writing that an AI receptionist that rents phone numbers is accepted under its acceptable use policy, which prohibits telecommunication services.

Not recommended: distributed Postgres such as Citus. [Letting businesses bring their own keys](business-provider-keys.md) is another way to take busy businesses out of the shared provider limits.
