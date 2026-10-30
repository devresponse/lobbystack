# Understand telemetry architecture

LobbyStack uses PostHog for product analytics and error tracking, and OpenTelemetry for server traces, metrics, and logs.

## Assign runtime ownership

- `apps/admin` browser code emits operator intent, navigation, and workflow outcomes.
- `apps/admin` server code traces HTTP, authentication, database, and provider operations.
- `apps/worker` emits job, outbox, provider, retry, and dead-letter telemetry, plus call lifecycle events for the GPT-Live calls it runs.
- `packages/telemetry` owns shared event names, redaction, trace propagation, and runtime-specific clients.

## Record durable events

Business outcomes are written through `recordProductEvent` to PostgreSQL after the authoritative operation commits. The worker's `telemetry.flush` job delivers pending rows to PostHog and retries failed delivery. A tenant-scoped `outbox.backlogSample` job samples each active business's publishable outbox backlog every 60 seconds. A business is dormant when it has no active member, or hasn't finished onboarding and has had no call, message or member sign-in in 30 days. A dormant business gets no backlog samples, and its `telemetry.flush` runs hourly. Scheduler-created envelopes explicitly mark recurring work, whose ticks do not emit `workflow.started`; delayed event-driven jobs still emit starts, and recurring failures still emit `workflow.failed`. The hourly retention sweep deletes tenant-scoped sent product events older than seven days in indexed, lock-skipping batches. When one run reaches its batch cap, it schedules a bounded continuation through the transactional outbox until the fixed cutoff is drained, so cleanup converges without monopolizing one worker execution. In-process telemetry is reserved for diagnostics where loss during a crash is acceptable.

## Use one declared transport

`TELEMETRY_EVENT_TRANSPORT` is exhaustive and defines the permitted route for every registry event:

- `durable` — business outcomes from admin, domain, and worker code through `recordProductEvent`.
- `browser` — operator intent and navigation through `createBrowserTelemetry` and `useTelemetry`.

Operational billing, outbox, and service events are durable. Do not introduce another capture path. `pnpm telemetry:coverage` checks producer presence and transport ownership.

Both transports validate required properties. Development and self-hosted runtimes throw on invalid events. Cloud runtimes preserve customer data, report `telemetry.validation_failed`, and continue.

## Propagate traces

Admin and worker requests propagate W3C trace context. Queue jobs retain correlation identifiers without storing customer content in telemetry fields. The outbox stores the trace that queued each job, and the worker runs the job as a child span in that trace.

## Follow one call

Log lines, error reports, spans and jobs about a call carry its IDs:

- `callId`: the call's row in `calls`
- `sessionId`: the GPT-Live session, which is also the call's provider ID
- `businessId`
- `twilioCallSid`: Twilio's call SID, on the admin's lines for a phone call whose SIP INVITE carries `X-Twilio-CallSid`. The call's record and its details page keep it too.

The admin sets them when the phone webhook or a browser call starts, and the worker sets them for each call it runs and for each job whose payload names a call (`withCallContext()` in `packages/telemetry`). Work started inside, timers and sockets included, keeps them.

- **Log lines**: `logEvent()` prints one JSON line with `level`, `message`, the IDs, `traceId` and the event's own fields, and exports the same record as an OTel log. Railway's log explorer reads `level` and `message`, and filters on any other field, for example `@callId:<id>` or `@sessionId:<id> @level:error`.
- **Spans**: every span started during a call carries `lobbystack.call_id`, `lobbystack.session_id`, `lobbystack.business_id` and `lobbystack.twilio_call_sid`. A worker call is one trace: `live.call`, a `live.delegation` span for each request the agent answers, a `tool.<name>` span for each tool call, and the database and provider spans under them.
- **Errors**: `reportError()` sends an exception to PostHog Error Tracking with the IDs, logs it as one line whose `message` leads with the error (`[admin] exception: …` or `[worker] exception: …`), and records it on the active span. See [Configure error tracking alerts](provider-failure-error-tracking.md).
- **Jobs**: each failed attempt logs a `job.failed` line with the job type, the attempt, `willRetry`, the reason in `message`, and the call's IDs from the job's payload. The last attempt is also reported. An outbox message the dispatcher can't queue logs `outbox.dispatch_failed`, and one it gives up on is reported.
- **Warnings**: `reportWarning()` reports a problem nobody needs to be alerted about the same way, at warning level: PostHog gets `$exception_level = warning` and `alertable = false`, the line is a `warn` whose `message` leads with `[worker] warning: …`, and the span isn't marked failed. The worker uses it for a text's or call's Twilio price that's still missing after its rechecks (`sms.syncPrice`, `call.syncPrice`). Twilio fills in prices some time after a text or call ends, so a check that finds none queues itself again a minute later, then twice as long after each miss, about 17 hours in all.

Export keeps these ID values whole, while it still redacts phone numbers and email addresses everywhere else.

## Privacy

Telemetry must not contain transcripts, message bodies, phone numbers, email addresses, uploaded filenames, signed URLs, access tokens, or provider credentials. Use the redaction helpers in `packages/telemetry` and stable internal identifiers for correlation.

## Product analytics and session replay

The landing page records sessions after cookie consent. The admin dashboard records operator sessions only when the active business has telemetry enabled, and never on authentication, prospect demo, or widget routes (`/login`, `/signup`, `/forgot-password`, `/reset-password/*`, `/confirm-email-change`, `/accept-invite`, `/claim-demo`, `/demo/*`, `/demos`, `/embed/*`). `ProductAnalytics` owns that decision. Loading it starts the SDK opted out (`apps/admin/src/lib/client-analytics.ts`), so nothing is collected before the decision is made. PostHog stores an opt-in in the browser and would start the next page opted in from it, despite `opt_out_capturing_by_default`, so since fork PR #105 the SDK withdraws a stored opt-in right after it starts: a page whose business has telemetry off, or a sign-in page after a business that has it on, sends nothing. The widget's page never loads `ProductAnalytics`, so visitors on a business's website don't download PostHog at all.

Masking happens in the browser, because PostHog privacy controls run before data leaves the page and `before_send` cannot redact recorded payloads. Mask caller and contact text with the `ph-mask` class and block whole elements with `ph-no-capture` when an attribute carries personal data, such as the signed URL of a call recording or a contact's `title` tooltip. Both are honored by the SDK defaults. A secret shown only once, a new API key or webhook signing secret, carries `ph-no-capture` (`SecretReveal`, fork PR #105): it sits in a dialog, which is a portal, so no class on the page around it reaches it.

Client analytics posts to the PostHog managed reverse proxy (`NEXT_PUBLIC_POSTHOG_HOST`), and the SDK `defaults` value is pinned to `2026-05-30` so later defaults tiers cannot silently enable session-replay network body capture.

## Collection

Server runtimes send traces, metrics, and logs to the OTLP base URL configured through `OTEL_EXPORTER_OTLP_ENDPOINT`. The logs carry each runtime's `logEvent()` records, and its `console.warn` and `console.error` output with the active trace ID and the current call's IDs. Runtimes also keep printing them to stdout. They attach headers from `OTEL_EXPORTER_OTLP_HEADERS` and sanitize telemetry before export. An empty endpoint disables server export. Browser events use the public PostHog key and host configured through `NEXT_PUBLIC_POSTHOG_*`.

## Validation

Run `pnpm telemetry:coverage`, `pnpm replacement:telemetry`, `pnpm replacement:privacy`, and the PostHog/OTel certification steps in `docs/validation/posthog-otel-validation.md` before production cutover.
