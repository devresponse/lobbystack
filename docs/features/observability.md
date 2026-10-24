# Follow logs, errors and alerts

Every service writes one JSON line per log event to standard output, which Railway's log viewer shows. With PostHog's variables set, errors, product events and logs also reach PostHog. Since fork PR #41 every log line, error, span and job of a call carries that call's IDs, so one call's whole story can be pulled up at once. This page covers the variables, how to follow a call, what to alert on, and what isn't set up yet. [Telemetry architecture](../telemetry/architecture.md) is the reference for events and traces. Checked against `main` at `da1f548`.

## Set the variables

| Service | Variable | Sends |
| --- | --- | --- |
| Admin | `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, or `POSTHOG_KEY` for errors only | Dashboard analytics, session replay and server errors |
| Worker | `POSTHOG_API_KEY` | Product and system events (`ops.*`), and the worker's errors and warnings |
| Admin, worker | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | Logs, traces and metrics over OTLP, to PostHog (`https://us.i.posthog.com/i` with `Authorization=Bearer <project token>`) or any OTLP service |

All three take a PostHog project token (`phc_...`). The exporter sends JSON, so traces may not show in PostHog.

Leave `NEXT_PUBLIC_POSTHOG_HOST` unset on Railway, where the dashboard then uses PostHog's US host. In Docker Compose, set it: `docker-compose.yml` and `.env.example` default it to the original project's own PostHog relay. The website widget loads no analytics at all (fork PR #22).

## Follow one call

Since fork PR #41, `withCallContext`, `logEvent`, `reportError` and `reportWarning` (`packages/telemetry`) put these fields on every line written during a call: `callId`, `sessionId`, `businessId` and, for phone calls, `twilioCallSid`, plus the `traceId`.

- In Railway's log explorer, filter with `@callId:<id>` or `@sessionId:<id>`. The call's page in the dashboard shows both IDs, and the Twilio call SID that migration `0103` saves.
- The worker logs each failed job attempt as a `job.failed` line with the job, the attempt and the reason, and reports only the last attempt as an error.
- The admin logs each server failure as `[admin] exception: <message>` with the route, an `errorId` that the dashboard shows to the person, and the cause.
- Outbox delivery failures log `outbox.dispatch_failed`. Calls add `live.call`, `live.delegation` and `tool.<name>` spans.
- A missing Twilio price after 17 hours of rechecks is a warning, not an error (fork PR #44).
- With AI traces on for a business, its traces show what the model was given and did on each turn ([calls](calls.md#trace-what-the-ai-was-given)).

## Alert on what matters

No alert is set up on the demo yet. [Alerts](../operations/alerts.md) is the runbook for the four alert rules the code defines. The recommended minimum:

- An uptime check on `https://<dashboard domain>/api/health/ready` every minute. It answers 503 with the failed check when the database, storage or Redis is down. The worker has no public address, but a dead worker shows up as the admin's `[live] incoming call failed` error.
- PostHog error tracking notifications for the admin and the worker ([provider failure alerts](../telemetry/provider-failure-error-tracking.md)).
- PostHog alerts on the billing events and log lines in [billing](../billing/README.md#watch-billing).
- Spending alerts at OpenAI and Twilio, since one business can use the shared budget.
- Railway's email on failed deploys.

Railway keeps logs 7 days on the Hobby plan and 30 on Pro, and its Monitors need Pro.

## Know what isn't built

- A view of logs and errors inside the dashboard was proposed on 2026-10-09 and is undecided.
- Twilio's call SID isn't on the worker's lines, and Twilio's price lookup doesn't use it.
- Nothing checks a deployment automatically after it deploys ([open items](../project/open-items.md)).
