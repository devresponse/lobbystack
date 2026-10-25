# Configure error tracking alerts

The admin app and the worker report unexpected server errors to PostHog Error Tracking as `$exception` events. Each event carries `service` (`lobbystack-admin` or `lobbystack-worker`), `alertable = true`, the failing `operation`, `environment`, and `release`, plus `route` and `method` when a request failed. An error during a call also carries the call's `callId`, `sessionId`, `businessId` and, when known, `twilioCallSid`. Failures from OpenAI, Google, Twilio, Polar, or Firecrawl reach Error Tracking the same way when they surface as server errors. The app doesn't tag them by provider, except for the website chat's replies, below.

The worker reports a job's last failed attempt (`operation = job.<type>`), an outbox message it gives up on (`outbox.dispatch`), and failures during a call: the attach (`live.attach`), a request the agent couldn't answer (`live.delegation`), a tool that threw (`tool.<name>`), minutes that couldn't be added before the call's limit (`live.top_up`), saving the transcript (`live.transcript_save`), finishing the call (`live.finish`), and recovering one (`live.recover`). The admin reports a website chat reply that failed (`operation = widget.chat_reply`) with the `errorId` the widget shows, `businessId`, `conversationId`, `stage`, and `category`, which sorts the failure into provider_auth, provider_rejected, provider_rate_limited, provider_unavailable, provider_unreachable, invalid_response, output_limit, content_filter, step_limit, no_reply or generation_failed. A failure at the AI provider adds `providerErrorStatus`, `providerErrorCode`, `providerErrorKind`, `providerErrorParam`, `retryable` and `attempts`. Any other failed chat request is `operation = widget.chat` (fork PR #79; [website widget](../features/website-widget.md#find-out-why-a-reply-failed)).

Both services read the project key from `POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` or `POSTHOG_API_KEY`, and the host from `POSTHOG_HOST` or `NEXT_PUBLIC_POSTHOG_HOST`. Without a key, errors are only logged.

A text's or call's Twilio price that's still missing after about 17 hours of rechecks reaches Error Tracking as a warning (`$exception_level = warning`, `alertable = false`, `operation = job.sms.syncPrice` or `job.call.syncPrice`), so the notification below skips it. Only that figure is missing from the cost reports.

## Configure the PostHog notification

Create an Error Tracking notification for alertable errors:

- Filter: `service = lobbystack-admin` or `service = lobbystack-worker`, and `alertable = true`
- Notify on new issues, and add the issue spiking notification for repeated failures
- Include `operation`, `route`, `callId`, `category`, `environment`, and `release` in the notification
- Recommended destination: Discord

## Notes

Keep Product Analytics alert slots for absence checks, such as missing worker heartbeats. Error Tracking can't notify on an event that never arrived, so those checks need Product Analytics.

Skip paid or destructive synthetic provider probes. Real application traffic shows whether providers respond, and `ops.service.health_check` and `ops.voice.heartbeat` cover application and voice liveness.
