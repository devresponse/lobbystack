# Respond to critical alerts

Configure these conditions in your OTLP backend or infrastructure monitoring system. LobbyStack does not include a monitoring service.

## ReplacementOutboxDeadLettered

An outbox message exhausted ten delivery attempts. Query `operations.outbox_messages` for rows with `dead_lettered_at IS NOT NULL`, identify the topic and redacted error category, fix the provider or handler, then create a new idempotent outbox message. Do not clear the original row.

## ReplacementWorkerJobFailures

At least three BullMQ jobs failed within ten minutes. Inspect worker logs and BullMQ state by queue and job type: the worker logs each failed attempt as a `job.failed` JSON line with its queue, job type, attempt, and redacted reason. Confirm Redis and PostgreSQL health before retrying. Job payloads can contain customer data and must not be copied into incident systems.

## ReplacementOutboxDispatcherUnavailable

At least three PostgreSQL polling attempts failed within five minutes. Check the dispatcher database URL, `lobbystack_dispatcher` role, PostgreSQL readiness, connection limits, and network status. Pending durable work remains in PostgreSQL and should resume automatically after recovery.

## BillingWorkOverdue

The worker found billing work that waited longer than it should: a Polar event not applied an hour after its webhook, usage not sent to Polar an hour after its last change, or a checkout request that failed after 15 minutes without running. The worker reports `Billing work waited longer than it should.` to error tracking, at most once a billing sweep and once for each checkout request its own job failed that way, and adds to the `lobbystack.billing.overdue_work` counter with the `kind` attribute `provider_event`, `usage_event` or `checkout_request`; alert when the counter rises. Read the worker's `job.failed` lines for `billing.reconcile`, `billing.syncUsage` or `billing.createCheckout`, and fix the Polar, token or database error they name. A sweep's report with `polarConfigured: false` means the worker has no `POLAR_ACCESS_TOKEN` or `POLAR_ORGANIZATION_ID`, so usage waits without any `job.failed` line: set both. Leave the rows alone: the sweep queues the work again each hour until it is done. See [Recover lost billing work](../providers/polar.md#recover-lost-billing-work).

## Test each alert

1. Submit a deliberately unsupported outbox topic and advance it to the terminal retry threshold. Confirm `ReplacementOutboxDeadLettered` activates without exposing its payload.
2. Interrupt Redis and PostgreSQL in a disposable environment. Confirm the worker and dispatcher alerts activate.
3. Restore each dependency and confirm the alerts resolve and durable processing resumes.
4. Give the worker a wrong `POLAR_ACCESS_TOKEN` in a disposable environment, make usage, and confirm `BillingWorkOverdue` activates after an hour. Restore the token and confirm the usage reaches Polar.
