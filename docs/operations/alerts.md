# Respond to critical alerts

Configure these conditions in your OTLP backend or infrastructure monitoring system. LobbyStack does not include a monitoring service.

## ReplacementOutboxDeadLettered

An outbox message exhausted ten delivery attempts. Query `operations.outbox_messages` for rows with `dead_lettered_at IS NOT NULL`, identify the topic and redacted error category, fix the provider or handler, then create a new idempotent outbox message. Do not clear the original row.

## ReplacementWorkerJobFailures

At least three BullMQ jobs failed within ten minutes. Inspect worker logs and BullMQ state by queue and job type: the worker logs each failed attempt as a `job.failed` JSON line with its queue, job type, attempt, and redacted reason. Confirm Redis and PostgreSQL health before retrying. Job payloads can contain customer data and must not be copied into incident systems.

## ReplacementOutboxDispatcherUnavailable

At least three PostgreSQL polling attempts failed within five minutes. Check the dispatcher database URL, `lobbystack_dispatcher` role, PostgreSQL readiness, connection limits, and network status. Pending durable work remains in PostgreSQL and should resume automatically after recovery.

## BillingWorkOverdue

The worker found billing work that waited longer than it should: a Polar event not applied an hour after its webhook, usage not sent to Polar an hour after its last change, or a checkout request that failed after 15 minutes without running, and since migration `0148` a prepaid pack's checkout that expired after 15 minutes without running. The worker reports `Billing work waited longer than it should.` to error tracking, at most once a billing sweep and once for each checkout request its own job failed that way, and adds to the `lobbystack.billing.overdue_work` counter with the `kind` attribute `provider_event`, `usage_event`, `checkout_request` or `pack_checkout`; alert when the counter rises. Read the worker's `job.failed` lines for `billing.reconcile`, `billing.syncUsage`, `billing.createCheckout` or `billing.createPackCheckout`, and fix the Polar, token or database error they name. A Polar event can also wait for its product: the worker then reports `A live Polar subscription is for a product no plan maps to` beside it, and the event applies once `pnpm billing apply` links the product or the subscription moves in Polar to a product the catalog sells. A sweep's report with `polarConfigured: false` means the worker has no `POLAR_ACCESS_TOKEN` or `POLAR_ORGANIZATION_ID`, so usage waits without any `job.failed` line: set both. Leave the rows alone: the sweep queues the work again each hour until it is done. See [Recover lost billing work](../providers/polar.md#recover-lost-billing-work).

## KnowledgeSearchTimingOut

A business's knowledge searches ran out of their 2 seconds: at least three `knowledge.search_timed_out` log lines for one business within an hour, or `rag.search.duration_ms` with `keyword` or `meaning` set to `timed_out`. Each line names the business and which half gave up. When only one half gives up the search still finds something, so the receptionist answers but misses what only that half finds, such as an exact name or code, and every question waits the full 2 seconds first. The keyword half reads every passage of the business, so a business near 130,000 passages crosses the line ([knowledge](../knowledge/architecture.md#search-knowledge-the-way-the-receptionist-does)). Check the business's passage count in the knowledge search's trace (`POST /api/v1/knowledge/search`, `trace.index.chunks`), then trim its knowledge, or plan the index and lookup function the RAG speed report calls change 3. Raising the 2-second limit only makes callers wait longer.

## Test each alert

1. Submit a deliberately unsupported outbox topic and advance it to the terminal retry threshold. Confirm `ReplacementOutboxDeadLettered` activates without exposing its payload.
2. Interrupt Redis and PostgreSQL in a disposable environment. Confirm the worker and dispatcher alerts activate.
3. Restore each dependency and confirm the alerts resolve and durable processing resumes.
4. Give the worker a wrong `POLAR_ACCESS_TOKEN` in a disposable environment, make usage, and confirm `BillingWorkOverdue` activates after an hour. Restore the token and confirm the usage reaches Polar.
