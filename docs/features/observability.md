# Follow logs, errors and alerts

Every service writes one JSON line per log event to standard output, which Railway's log viewer shows. With PostHog's variables set, errors, product events and logs also reach PostHog. Since fork PR #41 every log line, error, span and job of a call carries that call's IDs, so one call's whole story can be pulled up at once. This page covers the variables, how to follow a call or a sign-in, what to alert on, and what isn't set up yet. [Telemetry architecture](../telemetry/architecture.md) is the reference for events and traces. Checked against `main` at `1a2c81b`; sign-in lines, against the code of fork PR #104.

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

The website chat isn't a call, but since fork PR #79 its lines carry `businessId`, and those about one chat its `conversationId`: `widget.chat_reply` for each answer (`durationMs`, `timeToFirstTokenMs`, `modelSteps`, `tools`, `finishReason` and token counts), `widget.chat_refused` with the `status` and `code`, and `widget.team_request` with its `outcome`. A failed answer is an `[admin] exception:` line, and a PostHog error, with the `errorId` the widget shows and a `category` that says why ([website widget](website-widget.md#find-out-why-a-reply-failed)).

## Follow a sign-in

Since fork PR #104, the admin writes one line for each sign-in and account step. A line names the account by `userId`, never by email address, and gives the Better Auth route as `path`. It has the caller's `ip` when `TRUSTED_CLIENT_IP_HEADER` is set (the Railway template sets `x-real-ip`). A failure adds the `status` and Better Auth's error `code`, or a `detail` for a refusal of our own, such as a failed challenge. Passwords, codes and tokens never appear.

| Line | Written when |
| --- | --- |
| `auth.signed_in` | Someone signs in, with the session's `authSessionId` |
| `auth.sign_in_failed` | A sign-in is refused. `INVALID_EMAIL_OR_PASSWORD` with `accountFound` true is a wrong password; with `accountFound` false, no account has that address. `EMAIL_NOT_VERIFIED` is an address not yet confirmed |
| `auth.rate_limited` | A lockout. `limit` is `route` for Better Auth's limit on a route, such as 5 sign-in tries a minute, or `recipient` for the limit on codes and reset emails sent to one address. At most one line a minute for each route, limit and address |
| `auth.signed_up` | A new account is created |
| `auth.sign_up_existing_account` | Someone signs up with an address that already has an account. They see the same answer as for a new account, and `verified` says whether a sign-in reminder or a new code went out |
| `auth.sign_up_failed` | A sign-up is refused, such as for a weak password or a failed challenge |
| `auth.password_reset_requested`, `auth.password_reset_request_failed` | Someone asks for a reset by emailed link or code (`method`). `accountFound` false means no account has the address, so nothing was sent |
| `auth.password_reset`, `auth.password_reset_failed` | A reset finishes, which signs out every session, or is refused: `INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS` or `INVALID_TOKEN` |
| `auth.password_changed`, `auth.password_change_failed` | A password change in **Settings > Account**, with `revokedOtherSessions`. `INVALID_PASSWORD` is a wrong current password |
| `auth.email_change_requested`, `auth.email_change_failed` | An email change is asked for in **Settings > Account** |
| `auth.email_change_confirmed`, `auth.email_changed` | The current address approves the change, then the new address confirms it |
| `auth.email_verified`, `auth.email_verification_failed` | An address is confirmed by code or link (`method`), or the code or link is refused, with `emailChange` true during a change |
| `auth.verification_code_sent`, `auth.verification_code_skipped` | A sign-up code is queued for email, or isn't, with the `reason`: `no_account` or `already_verified` |
| `auth.verification_code_request_failed` | A request for a sign-up code is refused: `INVALID_REQUEST` or `CHALLENGE_FAILED` |
| `auth.better_auth_error`, `auth.better_auth_warning` | Better Auth itself complains, with its words in `error`. Most errors are requests it refuses, such as one from an untrusted origin. Its warnings that repeat a line above, such as a wrong password, are left out |

When the sign-in service breaks, error tracking gets it with an `errorId`. A dashboard request whose session check fails answers 503 with the `errorId` (`auth.session_check`), and so does a sign-up code that can't be sent (`auth.verification_code`). An exception inside Better Auth, such as a database outage behind a sign-in, is reported as `auth.better_auth`.

To find out why someone can't sign in, look up their user ID in the `users` table and filter Railway's logs with `@userId:<id>`. A lockout has no user ID, so search `auth.rate_limited` around the time instead.

## Alert on what matters

No alert is set up on the demo yet. [Alerts](../operations/alerts.md) is the runbook for the four alert rules the code defines. The recommended minimum:

- An uptime check on `https://<dashboard domain>/api/health/ready` every minute. It answers 503 with the failed check when the database, storage or Redis is down. The worker has no public address, but a dead worker shows up as the admin's `[live] incoming call failed` error.
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
