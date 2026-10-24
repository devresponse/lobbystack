---
meta:
  title: Configure Polar billing
  navLabel: Polar Billing
  contentType: How-to
  category: Providers
---

<!-- Content plan: Help operators configure hosted billing. Cover products, event ingestion, secrets, webhooks, and verification. Goal: connect an existing Polar organization without changing its prices. Open questions: none for application configuration; confirm live prices in Polar before taking payments. -->

# Configure Polar billing

Use this guide to connect your Polar organization to hosted Starter and Pro billing. You need access to Polar settings and your deployment platform’s secret store.

## Create the hosted products

Run `pnpm billing apply` with your brand's `billing.json` (see [`brands/README.md`](../../brands/README.md)). It writes the file's plans to the billing catalog, creates or adopts the Polar meters, products, discounts and webhook the file describes, takes any Credits off the products, then links them in the catalog. The plan screens and usage limits follow the catalog as soon as it holds the Starter and Pro rows, in its currency. Once a link makes a plan active, checkout, plan changes and the webhook use the catalog's linked products, a retired price's product included. An apply that changes a sold plan's terms, its prices included, stops that plan's checkout until the run links it again, so run `pnpm billing apply` again if one stops part-way. Confirm the live prices in Polar before accepting payments.

Use `starter` or `pro` for checkout, with monthly or annual billing.

The four `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variables (such as `POLAR_STARTER_MONTHLY_PRODUCT_ID`) are optional. A deployment that hasn't applied a `billing.json` yet sells a plan through its variable if it has one, and shows this build's built-in plans in US dollars. After a plan's first link, checkout ignores them, and `pnpm billing verify` notes any that are still set so you can remove them.

## Configure usage event ingestion

The worker sends finalized paid-plan usage from `billing_usage_events` to Polar.

| Usage | Event name | Quantity unit |
| --- | --- | --- |
| Voice | `billing.voice_minutes` | Minutes (seconds divided by 60) |
| Alert text messages | `billing.alert_sms_segments` | Short Message Service (SMS) segments |
| Outbound call attempts | `billing.outbound_call_attempts` | Attempts |

Grant your token `events:write` access for `POST /v1/events/ingest`. You don’t need `POLAR_*METER_ID` variables. The worker sends these fields:

| Field | Value |
| --- | --- |
| `external_customer_id` | The account’s billing key |
| `external_id` | The usage source key, which prevents duplicate ingestion |
| `metadata` | Quantity, business ID, and usage kind |

Keep your existing Polar meters and prices. Connecting this application leaves them unchanged. See [Polar event ingestion](https://polar.sh/docs/features/usage-based-billing/event-ingestion) for the request format.

Starter and Pro include usage allowances that reset on the first of each month (UTC), on monthly and annual subscriptions alike, whatever day the subscription renews. The worker sends only the usage past them, as `billableQuantity`, including zero, so the products carry no Credits and Polar bills every unit it receives. An event recorded without `billableQuantity` sends its whole quantity.

The worker skips these events:

- Provisional usage
- Free-plan usage
- Usage without a linked Polar customer

## Set the environment variables

Copy these variable names from [`.env.example`](../../.env.example) into your deployment platform’s secret store. Replace the placeholder values with credentials from the same Polar environment.

```dotenv
POLAR_ACCESS_TOKEN=your_polar_access_token
POLAR_WEBHOOK_SECRET=your_polar_webhook_secret
POLAR_ORGANIZATION_ID=your_polar_organization_id
POLAR_API_BASE_URL=https://sandbox-api.polar.sh
```

Match `POLAR_API_BASE_URL` to the environment that issued the token and webhook secret.

## Route billing requests

The Next.js app exposes four billing entry points.

| Route | Purpose |
| --- | --- |
| `POST /api/billing/checkout` | Queue a Starter or Pro checkout request, or one for the plan a promo code unlocks. |
| `POST /api/billing/promo` | Look up the plan a promo code unlocks, with its discount and prices. |
| `POST /api/billing/portal` | Create a customer portal session for an active paid subscription. |
| `POST /api/webhooks/polar` | Verify and store Polar events for worker reconciliation. |

`pnpm billing apply` makes Polar's webhook for subscription and order events at the instance's own `/api/webhooks/polar`, or at the address `--webhook-url` names, and finds it again by that address on later runs. When the run makes the webhook, `--railway-file` saves its secret as `POLAR_WEBHOOK_SECRET`; otherwise copy the secret from the webhook in Polar's settings.

Set `POLAR_WEBHOOK_SECRET` in production. The route rejects missing secrets and invalid signatures with HTTP 401, and logs each refusal as `ops.billing.webhook_refused` with its reason (`unconfigured`, `missing_headers` or `bad_signature`) and Polar's delivery ID. Polar turns the webhook off after 10 failed deliveries in a row, so a run of `bad_signature` lines means `POLAR_WEBHOOK_SECRET` isn't the webhook's secret: fix the variable, turn the webhook back on in Polar's settings, and redeliver the failed events. When the route can't store an event it answers 500 with an `errorId`, which Polar's delivery log shows and error tracking reports under the same ID, and Polar delivers it again later.

Set `POLAR_ACCEPT_LEGACY_BUSINESS_IDS=true` only in production. It lets signed webhooks resolve `business:<legacy-id>` customer references from before the PostgreSQL move through the `businesses.legacy_convex_id` column. Keep it disabled in staging so a shared Polar organization cannot route production customer events into the staging database.

## Understand the billing flow

Use this sequence to check where a checkout stops:

1. The admin API writes a checkout request and enqueues `billing.createCheckout`.
2. The worker creates the Polar checkout with the product the catalog links to the plan and interval. A business that already pays for Starter or Pro gets no checkout, because Polar refuses a second subscription: the worker moves its subscription to the new product instead (`PATCH /v1/subscriptions/{id}`, which needs `subscriptions:write` on the worker's token) and marks the request `changed`. An upgrade is charged as `billing.json`'s `polar.upgradeProration` says (`invoice`: the prorated difference now), and a downgrade as `polar.downgradeProration` (`next_period`: from the next renewal).
3. The browser opens the checkout URL after the request becomes ready, or for a plan change waits until the webhook moves the business onto the plan.
4. Polar sends subscription and order events to the Next.js webhook route.
5. The route stores each provider event once and enqueues `billing.reconcile`. When Polar sends an event again, or someone redelivers it from Polar's dashboard, and it never applied, the route queues it again.
6. The worker updates local subscription and transaction records.

A checkout request has 15 minutes to run. While a try fails and the job will try again, the request goes back to pending and the page keeps waiting; the last try fails it. A request whose run died is taken over 5 minutes after its last change. A request still waiting after 15 minutes fails, and the person asks again, so a plan change never goes through long after they left the page.

The billing page reads PostgreSQL for plan, usage, spending-cap, and transaction data. It creates portal sessions on the server for billing administrators.

## Recover lost billing work

The worker tries each `billing.reconcile` and `billing.syncUsage` job 12 times. It waits 5 seconds before the first retry and doubles the wait each time, so it gives up about 3 hours after the first failure. The worker's billing sweep runs every 5 minutes and queues the billing work no job finished again, at most once an hour for each row, until it is done:

- a Polar event in `provider_events` still `received` 5 minutes after its webhook;
- final Starter or Pro usage in `billing_usage_events` still `pending` 15 minutes after its last change, for a business with a Polar customer;
- a checkout request still `pending` or `processing` 5 minutes after its last change, which fails instead once it is 15 minutes old.

Nothing needs requeueing by hand. Each sweep that finds work logs `ops.billing.sweep` with its counts. When a Polar event or usage has waited more than an hour, or a checkout request failed for waiting too long, the worker also reports `Billing work waited longer than it should.` to error tracking (see [BillingWorkOverdue](../operations/alerts.md#billingworkoverdue)).

To find the cause, read the worker's `job.failed` lines for the job type, and fix the provider, token or database error they name, such as a worker token without `events:write`. A worker without `POLAR_ACCESS_TOKEN` or `POLAR_ORGANIZATION_ID` sends no usage and fails no job, and the sweep's report says `polarConfigured: false`. Keep the usage rows and their source keys: Polar keeps one event per source key, so usage sent twice is billed once. Only usage Polar must never bill leaves the sweep by hand, by setting its `sync_status` to `skipped`.

## Recover missing orders

When Polar has an order missing from `billing_transactions`, redeliver its events from the webhook's deliveries in Polar's dashboard. The route stores an event it never received and queues it, and queues again one it stored that never applied; one that applied is a duplicate and changes nothing.

The webhook handler uses provider event IDs for idempotency. Do not insert billing transactions by hand.

## Validate the integration

Run these checks in the Polar sandbox before enabling production billing:

- Confirm only business administrators can start checkout or open the portal.
- Complete monthly and annual checkout for Starter and Pro.
- Upgrade a paying Starter business to Pro from **Settings** > **Plan**, and confirm Polar invoices the difference and the page shows Pro.
- Confirm invalid webhook signatures receive an unauthorized response and log `ops.billing.webhook_refused`.
- Confirm duplicate webhook deliveries create one provider event.
- Generate each metered usage type and verify the Polar quantity.
- Confirm monthly and annual subscriptions send only each month's overage quantities, and that no product carries Credits.
- Make usage while the worker's `POLAR_ACCESS_TOKEN` is wrong, and confirm worker logs identify the usage-sync failures and that the usage reaches Polar once the token is right again, without requeueing anything.

Self-hosted workspaces remain outside hosted billing enforcement.
