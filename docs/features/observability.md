# Follow logs, errors and alerts

Every service writes one JSON line per log event to standard output, which Railway's log viewer shows. With PostHog's variables set, errors, product events and logs also reach PostHog. Since fork PR #41 every log line, error, span and job of a call carries that call's IDs, so one call's whole story can be pulled up at once. This page covers the variables, how to follow a call or a sign-in, a closed test deployment's lines, how to watch every copy of the admin and the worker, what to alert on, and what isn't set up yet. [Telemetry architecture](../telemetry/architecture.md) is the reference for events and traces. Checked against `main` at `1a2c81b`; sign-in lines, against the code of fork PR #104; receptionist lines, against the code of fork PR #129; the bootstrap script's PostHog values and the dashboard's EU link, against fork PR #165; the access gate's lines, against the code of fork PR #176; the copies' heartbeat, status address and metrics, against the code of fork PR #185.

## Set the variables

| Service | Variable | Sends |
| --- | --- | --- |
| Admin | `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, or `POSTHOG_KEY` for errors only | Dashboard analytics, session replay and server errors |
| Worker | `POSTHOG_API_KEY` | Product and system events (`ops.*`), and the worker's errors and warnings |
| Admin, worker | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | Logs, traces and metrics over OTLP, to PostHog (`https://us.i.posthog.com/i` with `Authorization=Bearer <project token>`) or any OTLP service |

All three take a PostHog project token (`phc_...`). The exporter sends JSON, so traces may not show in PostHog. `devops/bootstrap.mjs` finds or makes the project and sets all of these, with the hosts below, on the environments it sets up, unless its settings say `POSTHOG=no` ([its PostHog section](../../devops/bootstrap.md#posthog), fork PR #165).

On Railway, `NEXT_PUBLIC_POSTHOG_HOST` may stay unset for PostHog's US region, where the dashboard then uses PostHog's US host. For the EU region, set it and the worker's `POSTHOG_HOST` to `https://eu.i.posthog.com`; since fork PR #165 the dashboard's links into PostHog then open PostHog's EU app. In Docker Compose, set it: `docker-compose.yml` and `.env.example` default it to the original project's own PostHog relay. The website widget loads no analytics at all (fork PR #22).

The worker sends each business's product events to PostHog in one request a minute while the business is in use. Since fork PR #189 a request gets 15 seconds: when PostHog stalls, the `telemetry.flush` job fails, the events stay pending and the next run sends them. Before, a stalled PostHog held the job for minutes, and with it a slot of the `maintenance` queue, which daily summaries, retention and number reclaim share (the technical audit's AUDIT-023).

## Follow one call

Since fork PR #41, `withCallContext`, `logEvent`, `reportError` and `reportWarning` (`packages/telemetry`) put these fields on every line written during a call: `callId`, `sessionId`, `businessId` and, for phone calls, `twilioCallSid`, plus the `traceId`.

- In Railway's log explorer, filter with `@callId:<id>` or `@sessionId:<id>`. The call's page in the dashboard shows both IDs, and the Twilio call SID that migration `0103` saves.
- The worker logs each failed job attempt as a `job.failed` line with the job, the attempt and the reason, and reports only the last attempt as an error.
- The admin logs each server failure as `[admin] exception: <message>` with the route, an `errorId` that the dashboard shows to the person, and the cause.
- Outbox delivery failures log `outbox.dispatch_failed`. Calls add `live.call`, `live.delegation` and `tool.<name>` spans.
- A missing Twilio price after 17 hours of rechecks is a warning, not an error (fork PR #44).
- `calls.live_presence_unavailable` is a warning from the admin, with the `businessId` whose Calls page asked: no worker's heartbeat is fresh, or a call's own entry has gone stale, so the page shows "Live status unavailable". It is written at most once a minute for each admin process while that lasts. Before fork PR #213 every such request, one every 5 seconds for each open Calls page, was an `[admin] exception:` line and a reported error, which buried the others. A worker that stopped is also in the [fleet status](#ask-the-status-address).
- With AI traces on for a business, its traces show what the model was given and did on each turn ([calls](calls.md#trace-what-the-ai-was-given)).

The website chat isn't a call, but since fork PR #79 its lines carry `businessId`, and those about one chat its `conversationId`: `widget.chat_reply` for each answer (`durationMs`, `timeToFirstTokenMs`, `modelSteps`, `tools`, `finishReason` and token counts), `widget.chat_refused` with the `status` and `code`, and `widget.team_request` with its `outcome`. A failed answer is an `[admin] exception:` line, and a PostHog error, with the `errorId` the widget shows and a `category` that says why ([website widget](website-widget.md#find-out-why-a-reply-failed)).

Since fork PR #174, three more lines watch the website chat's protection against scripts ([website widget](website-widget.md#stop-scripts-from-spending-a-businesss-chats)):

- `widget.turnstile_off`, a warning as a production admin starts and the chat would answer without Turnstile's check, with the `reason`: `keys_missing` (no `NEXT_PUBLIC_TURNSTILE_SITE_KEY` or `TURNSTILE_SECRET_KEY`) or `turned_off` (`WIDGET_TURNSTILE=false`).
- `widget.verify_refused`, a warning: a visitor's Turnstile check didn't pass, with the `status` and `code`, `widget_challenge_failed` (Cloudflare turned the token down), `widget_challenge_unavailable` (Cloudflare couldn't be asked) or a rate limit's, and its `reason`. A failure of our own is an `[admin] exception:` line with the operation `widget_session_verify`.
- `widget.chat_refused` with the code `widget_challenge_required` (a session that didn't pass the check) or `chat_daily_limit_reached` (the business's daily limit, with its `dailyLimit` and `plan`). A daily limit alert that couldn't be queued is reported with the operation `widget.chat_limit_alert`.

Since fork PR #129 a business can have several receptionists ([receptionists](receptionists.md)). These lines say when the receptionist a visitor's page named didn't answer the chat; the one the widget key names answered instead, or the default one:

- `widget.receptionist_token_rejected`, a warning: the page's signed token didn't check out, with the `businessId`, the `widgetKeyId` and a `reason`. `invalid` is a token this deployment didn't sign, one past its 30 days, or one signed before the widget's secret changed (`WIDGET_SESSION_SECRET`, or `BETTER_AUTH_SECRET` when it's unset); `other_widget` is one signed for another business or widget key.
- `widget.receptionist_token_archived`: the page's receptionist was archived after the visitor opened the page.
- `public_profile.receptionist_token_failed`, an error: a business or receptionist page couldn't sign its token, which happens only on a production admin with neither `WIDGET_SESSION_SECRET` nor `BETTER_AUTH_SECRET`.

The worker's job dispatcher counts `lobbystack.outbox.coalesced`, by `topic`: the `snapshot.refresh` rows it marked published without a job of their own, since a rebuild it had already queued for the same business in that batch covers them; they count in `lobbystack.outbox.published` too, with the outcome `coalesced` on `lobbystack.outbox.publish_duration_ms`. A QR link that can't open its page right now answers 503, and the failure is an `[admin] exception:` line, and a PostHog error, with the operation `entry_link.follow`.

## Follow a sign-in

Since fork PR #104, the admin writes one line for each sign-in and account step. A line names the account by `userId`, never by email address, and gives the Better Auth route as `path`. It has the caller's `ip` when `TRUSTED_CLIENT_IP_HEADER` is set (the Railway template sets `x-real-ip`). A failure adds the `status` and Better Auth's error `code`, or a `detail` for a refusal of our own, such as a failed challenge. Passwords, codes and tokens never appear.

| Line | Written when |
| --- | --- |
| `auth.signed_in` | Someone signs in, with the session's `authSessionId` |
| `auth.sign_in_failed` | A sign-in is refused. `INVALID_EMAIL_OR_PASSWORD` with `accountFound` true is a wrong password; with `accountFound` false, no account has that address. `EMAIL_NOT_VERIFIED` is an address not yet confirmed |
| `auth.rate_limited` | A lockout. `limit` is `route` for Better Auth's limit on a route, such as 5 sign-in tries a minute, or `recipient` for the limit on codes emailed to one address. At most one line a minute for each route, limit and address |
| `auth.signed_up` | A new account is created |
| `auth.sign_up_existing_account` | Someone signs up with an address that already has an account. They see the same answer as for a new account, and `verified` says whether a sign-in reminder or a new code went out |
| `auth.sign_up_failed` | A sign-up is refused, such as for a weak password or a failed challenge |
| `auth.password_reset_requested`, `auth.password_reset_request_failed` | Someone asks for a reset code by email. `accountFound` false means no account has the address, so nothing was sent |
| `auth.password_reset`, `auth.password_reset_failed` | A reset finishes, which signs out every session, or is refused, such as with `INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`, or `INVALID_PASSWORD` for a weak new password |
| `auth.password_changed`, `auth.password_change_failed` | A password change in **Settings > Account**, with `revokedOtherSessions`. `INVALID_PASSWORD` is a wrong current password or a weak new one |
| `auth.email_change_requested`, `auth.email_change_failed` | An email change is asked for in **Settings > Account** |
| `auth.email_change_confirmed`, `auth.email_changed` | The current address approves the change, then the new address confirms it |
| `auth.email_verified`, `auth.email_verification_failed` | An address is confirmed by code or link (`method`), or the code or link is refused, with `emailChange` true during a change |
| `auth.verification_code_sent`, `auth.verification_code_skipped` | A sign-up code is queued for email, or isn't, with the `reason`: `no_account` or `already_verified` |
| `auth.verification_code_request_failed` | A request for a sign-up code is refused: `INVALID_REQUEST` or `CHALLENGE_FAILED` |
| `auth.email_verification_off` | A warning as the admin starts in production with `REQUIRE_EMAIL_VERIFICATION=false`, which lets anyone sign up with an address they don't own (fork PR #171) |
| `auth.better_auth_error`, `auth.better_auth_warning` | Better Auth itself complains, with its words in `error`. Most errors are requests it refuses, such as one from an untrusted origin. Its warnings that repeat a line above, such as a wrong password, are left out |

When the sign-in service breaks, error tracking gets it with an `errorId`. A dashboard request whose session check fails answers 503 with the `errorId` (`auth.session_check`), and so does a sign-up code that can't be sent (`auth.verification_code`). An exception inside Better Auth, such as a database outage behind a sign-in, is reported as `auth.better_auth`.

To find out why someone can't sign in, look up their user ID in the `users` table and filter Railway's logs with `@userId:<id>`. A lockout has no user ID, so search `auth.rate_limited` around the time instead.

## Watch a closed test deployment

Since fork PR #176 on `releases/r2`, a test deployment closed to strangers with `PROTECTION_TOKEN` writes two lines of its own ([close a test deployment to strangers](access-gate.md#watch-it-in-the-logs)):

- `access_gate.on`, as the admin starts with the variable set. When every page answers "Not found", this line is the reason: the person needs the access link, not a password.
- `access_gate.wrong_token`, a warning: a request offered a token that isn't `PROTECTION_TOKEN` and got the 404. `via` is `query` for a token in an address, or `header`. Each copy of the admin writes at most one a minute, with `notLogged`, the number left out since the line before. It's usually someone with an access link from before the token changed.

Neither line carries a token, and a stranger's 404 writes none, since scanners would fill the log. The proxy is built apart from the rest of the admin, so it writes its warning with `console.warn`, as the JSON line `logEvent` would write.

## Watch every copy

Railway can run several copies of the admin and the worker, which it calls replicas ([guide 7.24](../deployment/guide/part-7-operations.md#724-scale-up)). Its charts show each copy's processor and memory, but not what a copy is doing, and an uptime check on the admin's ready check can't see the worker, which has no public address. Since fork PR #185 on `develop/r2`, every copy says which one it is and what it holds, and one address on the admin answers for all of them. Since fork PR #186, a copy that died stays listed for 24 hours with what it reported last. It works the same with one copy of each, and on a server under Docker Compose.

### Tell the copies apart

- Every metric, log record and trace a copy exports over OTLP carries `service.instance.id`: Railway's `RAILWAY_REPLICA_ID`, or the host name anywhere else, which under Docker Compose is the container's ID (`serviceInstance()` in `packages/telemetry/src/node.ts`). A chart can then be split by copy.
- An error sent to PostHog carries the same value as `replica`, beside its `release`.
- The JSON lines on standard output don't repeat it: Railway's log explorer already knows which copy wrote a line, and filters with `replica:<id>` *(as Railway's docs describe it; not tried)*.

### Read the heartbeat

Every 10 seconds each copy writes a short status, its heartbeat, to Redis in one round trip (`packages/jobs/src/fleet.ts`). Redis's clock dates every beat, so the copies' own clocks don't matter.

| A beat holds | For |
| --- | --- |
| The service, the copy, the release, Railway's deployment and region, and when the process started | Both |
| `busy`: the share of the time since the beat before that the process's one thread was busy, from 0 to 1. The first beat's is since the process started | Both |
| Memory: `rssBytes` and `heapUsedBytes` | Both |
| `db`: the database connections its pools hold `open`, have `inUse`, the requests `waiting` for one, and `max`, the most the copy may open, which is the sum of its `…_POOL_MAX` shares | Both |
| `draining`, once the copy was told to stop, and for how long | Both |
| `ready`: false while it can't reach the database, the files or Redis | Worker |
| `activeJobs` and `liveCalls`: the jobs it's running and the calls it holds | Worker |
| `queues`: each queue's jobs `waiting`, `active`, `delayed` and `failed`, as its health check counted them in the last 10 seconds | Worker |

- **A copy that is told to stop** says so at once, keeps beating while it finishes its calls and requests, and leaves that as its last word. So a deploy, a restart, or a copy the scale script takes away never looks like a copy that died.
- **A copy that dies** just stops beating: it crashed, was killed, or ran out of memory. After 30 seconds, three missed beats, it counts as silent. Its last beat is kept for 24 hours, so what it held just before can still be read the next day ([read a copy that died](#read-a-copy-that-died)).
- **Each process has a record of its own,** named after the service, the copy and the moment the process started. A host that starts a crashed copy again under the same name starts a new process, as Docker does *(whether Railway keeps a copy's ID over a restart: not confirmed)*. Its beats then stand beside the last beat of the process that died and don't replace it.
- **The list** lives in three Redis keys: `<REDIS_PREFIX>:fleet:seen` holds when each copy last beat, `<REDIS_PREFIX>:fleet:died` holds the same for the copies that died, and `<REDIS_PREFIX>:fleet:beats` holds each listed copy's latest status, under a kilobyte for each ([what it costs](#know-what-it-costs)). The prefix is `lobbystack` unless `REDIS_PREFIX` is set. A beat replaces the process's own record, so Redis holds one record for each process and no history, however long the deployment runs. The numbers over time leave as metrics instead ([chart the copies' load](#chart-the-copies-load)).
- **Nothing piles up, and nothing needs deleting.** When a copy's last beat turns 10 minutes old, the next beat from any copy deals with it, once:
  - A copy that said it was shutting down is removed. A deploy therefore holds the old copies' records beside the new ones for up to 10 minutes.
  - A copy that never said so died. Its record moves to the list of copies that died, which keeps the newest 50 and drops each one 24 hours after its last beat.
  - The list never holds more than 1,000 copies heard from in the last 10 minutes: past that, the oldest go. So a copy that crashes and starts again without end can't fill Redis.
  - All three keys expire 24 hours and 10 minutes after the last beat from any copy. Once every copy has stopped they go by themselves, and until then they hold the last beats of a deployment that went down altogether.
- **Without `REDIS_URL`,** as on a developer's admin, a copy writes nothing. A beat that fails is logged as `fleet.heartbeat_failed`, at most once a minute, and the next beat tries again; no request or call waits on a beat.

### Ask the status address

`GET /api/internal/fleet` on the admin lists every copy from those heartbeats, with each queue's jobs (`apps/admin/src/lib/fleet-status.ts`). Any copy of the admin can answer it.

It's off until the admin has a `FLEET_STATUS_TOKEN` of 32 characters or more, and takes only that token, as `Authorization: Bearer <token>` or, for an uptime check that can't send a header, as `?token=<token>`. The token opens nothing else, and the answer names no business, caller or setting. `devops/bootstrap.mjs` gives a new deployment's admin a token; anywhere else, make one as in [guide 7.10](../deployment/guide/part-7-operations.md#710-health-checks-and-uptime-monitoring). Since fork PR #216, the control panel's System health page reads the address too, over Railway's private network with the same token, and shows every copy, the queues and the copies that died ([the control panel](control-panel.md#read-the-system-health-page)).

```sh
curl -H "Authorization: Bearer <the token>" "https://<dashboard domain>/api/internal/fleet?admin=2&worker=2"
```

`admin` and `worker` say how many running copies the check expects of each, from 1 to 50, and 1 when left out.

| Answer | When |
| --- | --- |
| 404 "Not found" | The admin has no `FLEET_STATUS_TOKEN`, or one shorter than 32 characters, which the admin also says as it starts, in a `fleet.status_token_too_short` line |
| 401 "Unauthorized" | No token, or another one |
| 400 with an `error` | `admin` or `worker` isn't a whole number from 1 to 50 |
| 200 with `"ok":true` | Every expected copy runs and no copy went silent |
| 503 with `"ok":false` and its `problems` | A problem below, or Redis didn't give the heartbeats within 3 seconds, which also logs `fleet.status_unreadable` |
| 503 with `Retry-After: 60` | Maintenance mode, which answers every API call but the two health checks this way |

The answer's `problems` are sentences a person can read, `services` counts each service's copies by state beside the number expected, `copies` lists each copy heard from in the last 10 minutes with its state and its last beat, `died` lists the copies that died in the last 24 hours ([read a copy that died](#read-a-copy-that-died)), and `queues` holds each queue's jobs from the worker that counted last, with `queuesCountedSecondsAgo`. `answeredBy` names the copy of the admin that answered.

| A copy's state | Means |
| --- | --- |
| `running` | It beats and takes work |
| `not_ready` | It beats, but the worker can't reach the database, the files or Redis, or is still starting |
| `draining` | It beats and is shutting down |
| `silent` | It stopped beating in the last 10 minutes without saying it was shutting down, and no newer copy took its place |
| `left` | It stopped beating after it said it was shutting down. It stays under `copies` for 10 minutes |
| `died` | It stopped beating without saying it was shutting down, and a newer copy took its place or 10 minutes passed. It is listed under `died`, not under `copies`, for 24 hours |

Three things are a problem, and turn the answer into a 503:

- **A silent copy,** such as "worker copy 9b8d7c6a stopped reporting 45 s ago without shutting down, and no newer copy took its place." It clears when a copy of the same service starts after that last beat, which is what Railway's restart of a crashed copy does, or when a newer deployment's copy runs, or after 10 minutes. From then on the copy counts as one that died, which is no problem by itself, and only the number of running copies still tells. A copy that crashes and reports again within those 30 seconds never shows as a problem: the host's crash notice, and the process that died under `died`, are the signs.
- **A worker that isn't ready,** unless it started in the last 2 minutes.
- **Fewer running copies than expected,** such as "1 worker copy is running, and 2 are expected." or "No worker copy is running." A copy that started in the last 2 minutes and isn't ready yet counts as running here, and so does one that said it was shutting down in the last 2 minutes, whether it is still finishing or already gone. So a deploy or a restart that replaces the only copy raises no alarm.

In a check on a computer on 2026-11-15, with two workers and two built admins on one PostgreSQL and one Redis, a worker killed with `kill -9` turned the answer into a 503 after 31 seconds, a restart cleared it within 4 seconds, and a worker or an admin stopped the ordinary way never raised a problem. With one worker only, stopping it the ordinary way and starting the next one 12 seconds later raised nothing either, and stopping it for good gave "No worker copy is running." 2 minutes after it was told to stop. Nothing here has run on Railway yet ([open items](../project/open-items.md#test-these)).

### Read a copy that died

A copy that stops beating without saying it was shutting down died: it crashed, was killed, or ran out of memory. Since fork PR #186 its last beat is kept for 24 hours, so what the copy was doing can still be looked into the next day. The status address lists these copies under `died`, the newest first, once a newer copy took their place or 10 minutes passed:

```json
"died": [
  {
    "service": "worker",
    "replica": "7a6b5c4d-0000-4000-8000-000000000004",
    "state": "died",
    "release": "abc1234",
    "deployment": "dep-2",
    "region": "us-west2",
    "startedAt": "2026-11-13T15:00:00.000Z",
    "lastSeenSecondsAgo": 18000,
    "busy": 0.97,
    "rssBytes": 1981808640,
    "heapUsedBytes": 1700000000,
    "db": { "open": 12, "inUse": 11, "waiting": 3, "max": 12 },
    "ready": true,
    "activeJobs": 12,
    "liveCalls": 4,
    "lastSeenAt": "2026-11-15T15:00:00.000Z",
    "ranForSeconds": 172800,
    "queues": { "critical": { "waiting": 40, "active": 12, "delayed": 0, "failed": 9 } }
  }
]
```

| In the last beat | What it tells |
| --- | --- |
| `lastSeenAt` | When the copy last reported. It died within the 10 seconds after, so this is the moment to look for in the host's log |
| `ranForSeconds` | How long the process had run by then. A few seconds, in copy after copy, is a copy that crashes soon after it starts |
| `rssBytes` and `heapUsedBytes` | Its memory. Close to the service's limit, the host stopped it for running out of memory |
| `busy` | Near 1, its one thread was full, and everything it served waited |
| `db` | Requests `waiting` mean its database pool was full |
| `liveCalls` and `activeJobs` | The calls and the jobs a worker held. The calls are taken over or ended within a minute or two ([guide 7.16](../deployment/guide/part-7-operations.md#716-worker-crash-and-stuck-calls)) |
| `queues` | The queues' jobs as that worker counted them last |

- **It is no problem by itself.** The answer goes back to 200 once another copy took its place or 10 minutes passed, so an uptime check doesn't stay red for a day. `services.<name>.died` counts each service's copies that died in the last 24 hours, and `died` lists the newest 50.
- **A copy that crashed and came back within 30 seconds** never raised a problem, and is listed all the same. Before, the new process's beats replaced the last beat of the one that died.
- **A copy that was told to stop** isn't listed, whether a deploy, a restart or the scale script stopped it: its last beat says it was shutting down, and it drops off `copies` after 10 minutes.
- **A copy that only lost its way to Redis** looks like one that died while it is silent. Its next beat takes it off the list.
- **A copy that stops before its first beat** isn't listed. A worker beats once its start-up checks have passed, so one that stops on a missing setting or a wrong database password never does: the host's crash notice and the copy's log show it.
- **The beat doesn't say why the copy died.** The host does: the end of the copy's log at `lastSeenAt`, and Railway's crash notice ([guide 7.16](../deployment/guide/part-7-operations.md#716-worker-crash-and-stuck-calls)).
- **On Railway,** `node devops/scale.mjs` prints the same list under its table of copies ([guide 7.24](../deployment/guide/part-7-operations.md#724-scale-up)).
- **After 24 hours the beat is gone,** and nothing keeps a longer history of the copies that died. With the OTLP variables set, each copy's load over time stays in the metrics ([chart the copies' load](#chart-the-copies-load)), and the host keeps its logs.

In a check on a computer on 2026-11-15, with two workers and two built admins on one PostgreSQL and one Redis, a worker killed with `kill -9` turned the answer into a 503 after 26 seconds. Started again under the same name 45 seconds after the kill, it had the answer fine again within 3 seconds, with the process that died under `died`: its last beat, and the 23 seconds it had run. An admin killed and started again the same way was listed too. A worker killed and started again a second later never raised a problem, and was under `died` 28 seconds after. A worker stopped the ordinary way showed as `draining`, then `left`, and never under `died`. Eleven minutes after the last kill, the three that died were still listed, the one that left was gone, and Redis held the four running copies in one list and the three that died in the other. The 24 hours themselves were tried in the tests against Redis, with beats dated back, not by waiting a day. Nothing here has run on Railway yet.

### Chart the copies' load

With the OTLP variables set, each copy also sends these every 15 seconds, split by `service.instance.id`:

| Metric | What it measures |
| --- | --- |
| `process.event_loop.utilization` | The share of the last 15 seconds the process's one thread was busy, from 0 to 1. Near 1, everything the copy serves waits. `process.event_loop.delay_p99_ms`, sent before, reads about 20 on an idle process, because its 20 ms sampling step is part of the number |
| `db.pool.open`, `db.pool.in_use`, `db.pool.waiting`, `db.pool.max` | Each database pool's connections, by `role`. `waiting` above 0 means requests queue for a connection |
| `lobbystack.worker.live_calls`, `lobbystack.worker.active_jobs` | The calls a copy of the worker holds, and the jobs it's running |
| `lobbystack.queue.jobs` | Each queue's jobs, by `messaging.destination.name` and `state` (`waiting`, `active` or `delayed`). Every worker counts the same queues, so chart the maximum over the copies, not the sum |

The same change makes the worker's older metrics arrive at all. OpenTelemetry hands a module that makes its counters before telemetry starts counters that record nothing, and the worker loads its database and job modules first. So `db.pool.wait_ms`, `db.query.duration_ms`, `db.transaction.duration_ms`, `lobbystack.billing.overdue_work`, the `rag.*` timings and the `lobbystack.webhooks.*` counters were never sent from the worker. `getMeter()` in `packages/telemetry` now hands out instruments that find the real one when they're first used. On the same computer, the worker of the commit before sent 7 metric names in 70 seconds and none about the database; the worker of this change sent 18.

### Know what it costs

Measured on a computer on 2026-11-15, with Node.js 26 and a local Redis:

- A beat takes 83 microseconds of the copy's processor and 18 of Redis's, every 10 seconds: under a thousandth of a percent of one processor for each copy.
- Keeping the copies that died for 24 hours (fork PR #186) added two commands to a beat. Measured side by side, a beat took about 16 microseconds of Redis's thread before and 20 after, and the same 20 with 50 copies that died on the list as with none. That's because a copy that stopped is looked at once, when its last beat turns 10 minutes old, and not at every beat: that look takes Redis about 15 microseconds a copy, and a beat looks at 100 copies at most.
- An answer of the status address takes 0.12 milliseconds of the admin's processor for 4 copies and 0.9 for 100, and came back in 23 milliseconds over HTTP. With 50 copies that died listed beside 4 that run, it takes 0.45.
- A worker already sends Redis about 790 commands a minute while idle; the heartbeat adds 6.
- Redis holds about 340 bytes for an admin's record and 750 for a worker's, with identifiers as long as Railway's. Two copies of each took 3 kilobytes of Redis's memory and 25 of each took 38. Eleven beats from every copy left as many records as the first one. A worker that died takes about 1 kilobyte for its 24 hours, and 50 of them, the most the list keeps, took 47. At its limit of 1,000 copies heard from in 10 minutes, the list took 1 megabyte.
- The new gauges are read from memory once every 15 seconds: five pools' counters in 280 nanoseconds, and the busy share in 143. A counter that finds its real instrument at each use costs 3 nanoseconds more than before, and a histogram 19.
- The admin's start-up check of its database roles made four connection pools of its own beside the ones its routes use, each holding a connection for 30 seconds. They now close as soon as the check is done, so a starting copy stays within its connection budget, and the figures above count each pool once.

## Alert on what matters

No alert is set up on the demo yet. [Alerts](../operations/alerts.md) is the runbook for the four alert rules the code defines. The recommended minimum:

- An uptime check on `https://<dashboard domain>/api/health/ready` every minute. It answers 503 with the failed check when the database, storage or Redis is down.
- A second uptime check on the fleet status address, with the copies the deployment runs: `https://<dashboard domain>/api/internal/fleet?token=<the token>&admin=2&worker=2` ([watch every copy](#watch-every-copy)). It answers 503 when a copy of the admin or the worker went silent, a worker isn't ready, or fewer copies run than expected. Before it, a dead worker showed only as the admin's `[live] incoming call failed` error, once someone called.
- PostHog error tracking notifications for the admin and the worker ([provider failure alerts](../telemetry/provider-failure-error-tracking.md)).
- PostHog alerts on the billing events and log lines in [billing](../billing/README.md#watch-billing).
- A log alert on `auth.rate_limited` lines for `/sign-in/email`, which show someone guessing passwords.
- Spending alerts at OpenAI and Twilio, since one business can use the shared budget.
- Railway's email on failed deploys.

Railway keeps logs 7 days on the Hobby plan and 30 on Pro, and its Monitors need Pro.

## Know what isn't built

- A view of logs and errors inside the dashboard was proposed on 2026-10-09 and is undecided ([roadmap](../roadmap/call-diagnostics.md)).
- Twilio's call SID isn't on the worker's lines, and Twilio's price lookup doesn't use it.
- Sign-in lines live only in the logs, so they last as long as Railway or PostHog keeps logs. The database keeps no record of sign-ins beyond the sessions still open.
- Nothing checks a deployment automatically after it deploys ([open items](../project/open-items.md)).
- Nothing keeps the last beat of a copy that died past 24 hours, and no log line or alert says that a copy died: the status address lists it, and the host's crash notice says it at the time.
- No dashboard or alert reads the copies' metrics yet: a PostHog dashboard and alerts are the next step ([grow past one stack](../roadmap/scale-past-one-stack.md#watch-the-copies)). Nothing restarts a copy whose thread is stuck, and no copy of the worker refuses calls past a limit of its own.
