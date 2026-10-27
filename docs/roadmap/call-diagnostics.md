# Show why a call went wrong

When a call goes wrong, finding out why means filtering logs by its `callId` in Railway or PostHog ([observability](../features/observability.md#follow-one-call)), which a business owner can't do. The 2026-10-09 observability study recommended a diagnostics tab on each call page, the only option it found that shows an owner what happened without leaving the dashboard ([observability options](../research/observability-options.md#weigh-logs-inside-the-dashboard)).

- **Status:** not started; whether to build it is undecided.
- **Effort:** 4 to 6 days on a new table of call diagnostics, or 1 to 2 days for a first cut from `product_events`.

## Know what it would show

The call's setup steps with their times, each request the agent answered, any errors with the `errorId` the dashboard shows people, the transfer, why the call ended, and whether its recording and summary were saved.

## Choose a first cut or the full tab

| | First cut | Full tab |
| --- | --- | --- |
| Reads | `product_events`, which the code already writes | A new table of call diagnostics for each business, behind row-level security |
| Effort | 1 to 2 days | 4 to 6 days |
| Limits | A business with telemetry off writes none; rows are deleted 7 days after PostHog receives them; they carry failure flags but no messages | None of those |

Either way, a view across every business would need a staff role for the whole deployment, which the dashboard doesn't have: `platform_admin` is only a role within one business. Two things already help: since fork PR #41 every log line, error and job carries its call, and AI traces, for a business that turns them on, show what the model was given on each turn ([calls](../features/calls.md#trace-what-the-ai-was-given)).

## Decide these

- Build the tab, and as a first cut or in full?

Not recommended: a log page that reads Railway's API, since the admin would hold a token for the environment that holds every secret, and a full log search across both services, which rebuilds a log tool over every business's data.
