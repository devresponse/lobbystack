# Grow past one stack

The scalability review of 2026-10-18 found that the single database isn't the first limit: database connections, the one admin process, background jobs that run for each business, and the shared provider accounts bite first ([scalability](../reviews/scalability-2026-10-18.md)). Its roadmap hardens one stack, then makes it survive a failure, then splits businesses into cells.

- **Status:** started. Apart from billing fixes, fork PR #168 made two admins and two workers possible: smaller connection pools on each copy, a database made with room for 200 connections, a minute for the old admin to finish at a release, and new calls spread over the worker's copies ([replicas review](../reviews/replicas-2026-11-13.md)). Since fork PR #182 on `develop/r2`, `devops/scale.mjs` sets the number of copies after its checks ([guide 7.24](../deployment/guide/part-7-operations.md#724-scale-up)). Since fork PR #185, every copy reports what it's doing, and one address on the admin answers for all of them ([watch the copies](#watch-the-copies)). Phase 1 holds most of the near-term value and needs no new service except PgBouncer.
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

- **PgBouncer** in transaction mode, logging in as each runtime role, since the security functions check `session_user`. Smaller pools and a limit of 200 (fork PR #168) hold up to three admins with two workers; three of each need PgBouncer ([guide 7.24](../deployment/guide/part-7-operations.md#724-scale-up)).
- **An index on `transcripts (business_id, expires_at)`,** which the hourly clean-up scans once for each business, and indexes for the other lookups that read whole tables.
- **One job per type** that pages through businesses, in place of about 192 scheduled runs an hour for each active business.
- **A Redis memory ceiling with an alert,** keeping `noeviction`, which the job queues need, and one shared subscriber per process for dashboards.
- **Two admin copies** once connections are pooled, with a drain on shutdown. Possible since fork PR #168, after a rehearsal on a test environment ([replicas review](../reviews/replicas-2026-11-13.md#know-the-recommendations)).
- **Cloudflare caching** `/embed.js` and the public profile pages ([protect the widget](protect-the-deployment.md)).
- **Running usage counters** in place of replaying a business's month for each reservation, and batched Polar events.

## Watch the copies

A study on 2026-11-15 looked at how to see each copy of the admin and the worker on Railway, how busy it is, and when another is needed. Railway shows each copy's processor and memory, restarts a crashed copy, and checks a service's health only during a deploy; it has no way to see what a copy is doing, and nothing outside could see the worker at all. The study's steps:

| Step | Work | Status |
| --- | --- | --- |
| 1 | No code: Railway's project webhook and its monitors, an uptime check on the ready check, PostHog's error and log alerts, and PostHog's metrics turned on | Not done on any deployment ([open items](../project/open-items.md#do-these-on-the-demo-after-deploys)) |
| 2 | A name for each copy on every metric, log record and error, a heartbeat from each copy, one status address for all of them, gauges for calls, queues, database connections and how busy a copy's thread is, and the scale script's view of each copy | Built in fork PR #185 on `develop/r2` ([watch every copy](../features/observability.md#watch-every-copy)); since fork PR #186 a copy that died stays listed for 24 hours with its last report; tried on a computer, not yet on Railway |
| 3 | A PostHog dashboard and alerts on those metrics | Not started |
| Later | A limit of calls for each worker, with a new call sent to the least busy copy; a watchdog that restarts a copy whose thread is stuck; a load test with two copies of each | Not started |

The study also keeps the replicas review's advice: a fixed two admins and two workers, and no copies added or taken away by load, since a worker can't hand its calls to another.

Before revenue depends on it, ask Polar to confirm in writing that an AI receptionist that rents phone numbers is accepted under its acceptable use policy, which prohibits telecommunication services.

Not recommended: distributed Postgres such as Citus. [Letting businesses bring their own keys](business-provider-keys.md) is another way to take busy businesses out of the shared provider limits.
