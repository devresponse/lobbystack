# Choose logs, monitoring and call tracing

On 2026-10-09 a study asked how to see logs in the dashboard or through a monitoring tool, and how to tie each error to the call it hurt. It recommended PostHog, which the code already supported, plus tagging every log line, error, span and job with its call, and a diagnostics tab on each call page later. The tagging was built (fork PR #41, after the fork's reset; see [history](../project/history.md)). PostHog is set up on the demo at least for worker errors; no alert rule is. The diagnostics tab is undecided. [Logs, errors and alerts](../features/observability.md) describes what works now. Code references were to the original's `main` at `249f9f3`; tool prices are as of 2026-10-09.

## Know what the study found

- **Logs named a call by its OpenAI session ID and events by its call ID,** while setup errors and failed jobs named neither, so one call's story couldn't be pulled up at once.
- **The worker reported nothing to error tracking,** failed jobs logged nothing, and the outbox never carried trace context, so a recording copy or call summary didn't join its call's trace.
- **The call page labelled the OpenAI session ID "Twilio Call SID".**
- **The admin's readiness check covered only the database and storage,** and the worker has no public address. A dead worker shows up as the admin's "incoming call failed" error, so a log alert covers it.

Fork PR #41 closed all of these but one: Twilio's call SID is saved on the call record, but the worker's lines don't carry it and Twilio's price lookup doesn't use it.

## Compare the monitoring tools

| Tool | Fit | Free tier then | Code needed |
| --- | --- | --- | --- |
| **PostHog (chosen)** | Already wired for admin errors, worker events and OTLP logs and traces; error alerts to Slack, Discord, Teams or a webhook | Logs 10 GB a month kept 14 days; 100,000 exceptions a month | None; traces may need the protobuf exporter |
| Sentry | Best error grouping and release tracking; its SDK would sit beside PostHog's error code | 1 user, 5,000 errors | An SDK in the admin and worker |
| Grafana Cloud | Strongest dashboards and metric alerts; no error tracking | 50 GB of logs and of traces, 14 days | None |
| Better Stack | Logs, uptime monitors and a status page in one place | 3 GB of logs kept 3 days; 10 monitors | None |
| Axiom | The largest free allowance for logs and traces; no error tracking | 500 GB a month | None |
| OpenObserve on Railway | Data stays in the Railway project | About $10 to $15 a month of Railway usage | A service to run and update |

Railway keeps logs 7 days on Hobby and 30 on Pro, its own alerts need Pro, and its tracing preview takes traces only and skips services that set their own endpoint.

## Weigh logs inside the dashboard

| Option | Effort | Verdict |
| --- | --- | --- |
| A diagnostics tab on each call page: setup steps with their times, each request the agent answered, errors with their `errorId`, the transfer, the end reason, recording and summary results | 4 to 6 days on a new per-business table, or 1 to 2 days for a first cut from `product_events` | Recommended later; the only option that shows an owner why their call went wrong without leaving the dashboard. Undecided |
| A log page reading Railway's API | 2 to 3 days | Not recommended: the admin would hold a Railway token for the environment that holds every secret, and it works only on Railway |
| A full log search across both services | 3 to 4 weeks | Not recommended: it rebuilds a log tool, and logs mix every business's data |

A first cut from `product_events` has three limits: a business with telemetry off writes none, rows are deleted 7 days after PostHog receives them, and they carry failure flags but no messages. A view across all businesses would also need a platform-wide staff role, which the dashboard doesn't have: `platform_admin` exists only as a role within one business.
