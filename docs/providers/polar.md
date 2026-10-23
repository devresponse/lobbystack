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

Run `pnpm billing apply` with your brand's `billing.json` (see [`brands/README.md`](../../brands/README.md)). It creates or adopts the Polar products, meters, benefits and webhook the file describes, then links them in the billing catalog. Once a link makes a plan active, checkout, plan changes and the webhook use the catalog's linked products, a retired price's product included, and the plan screens show the catalog's prices in its currency. Confirm the live prices in Polar before accepting payments.

Use `starter` or `pro` for checkout, with monthly or annual billing.

The four `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variables (such as `POLAR_STARTER_MONTHLY_PRODUCT_ID`) are optional. A deployment that hasn't applied a `billing.json` yet sells a plan through its variable if it has one, and shows this build's built-in plans in US dollars. After the link, checkout ignores them, and `pnpm billing verify` notes any that are still set so you can remove them.

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

Starter and Pro include usage allowances that reset each month, including on annual subscriptions. The worker sends `billableQuantity` when present, including zero; otherwise, it sends the recorded quantity.

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

The Next.js app exposes three billing entry points.

| Route | Purpose |
| --- | --- |
| `POST /api/billing/checkout` | Queue a Starter or Pro checkout request. |
| `POST /api/billing/portal` | Create a customer portal session for an active paid subscription. |
| `POST /api/webhooks/polar` | Verify and store Polar events for worker reconciliation. |

Configure Polar to send subscription and order webhooks to `https://app.example.com/api/webhooks/polar`. Replace `app.example.com` with your admin application’s public host.

Set `POLAR_WEBHOOK_SECRET` in production. The route rejects missing secrets and invalid signatures with HTTP 401.

Set `POLAR_ACCEPT_LEGACY_BUSINESS_IDS=true` only in production. It lets signed webhooks resolve `business:<legacy-id>` customer references from before the PostgreSQL move through the `businesses.legacy_convex_id` column. Keep it disabled in staging so a shared Polar organization cannot route production customer events into the staging database.

## Understand the billing flow

Use this sequence to check where a checkout stops:

1. The admin API writes a checkout request and enqueues `billing.createCheckout`.
2. The worker creates the Polar checkout with the product the catalog links to the plan and interval. A business that already pays for Starter or Pro gets no checkout, because Polar refuses a second subscription: the worker moves its subscription to the new product instead (`PATCH /v1/subscriptions/{id}`, which needs `subscriptions:write` on the worker's token) and marks the request `changed`. An upgrade is charged as `billing.json`'s `polar.upgradeProration` says (`invoice`: the prorated difference now), and a downgrade as `polar.downgradeProration` (`next_period`: from the next renewal).
3. The browser opens the checkout URL after the request becomes ready, or for a plan change waits until the webhook moves the business onto the plan.
4. Polar sends subscription and order events to the Next.js webhook route.
5. The route stores each provider event once and enqueues `billing.reconcile`.
6. The worker updates local subscription and transaction records.

The billing page reads PostgreSQL for plan, usage, spending-cap, and transaction data. It creates portal sessions on the server for billing administrators.

## Recover failed usage syncs

Use `billing_usage_events` to investigate metered usage that did not reach Polar.

Inspect these columns and the worker’s job logs:

- `sync_status`
- `source_key`
- `quantity` and `billable_quantity`
- `is_final`
- `updated_at`

The worker tries each `billing.syncUsage` job 12 times. It waits 5 seconds before the first retry and doubles the wait each time, so it gives up about 3 hours after the first failure. Inspect worker logs for provider failures before you requeue a job.

Fix the provider error before you requeue `billing.syncUsage`. Keep the usage row and source key to prevent duplicate ingestion.

## Recover missing orders

Replay a signed Polar webhook when Polar contains an order missing from `billing_transactions`.

The webhook handler uses provider event IDs for idempotency. Do not insert billing transactions by hand.

## Validate the integration

Run these checks in the Polar sandbox before enabling production billing:

- Confirm only business administrators can start checkout or open the portal.
- Complete monthly and annual checkout for Starter and Pro.
- Upgrade a paying Starter business to Pro from **Settings** > **Billing**, and confirm Polar invoices the difference and the page shows Pro.
- Confirm invalid webhook signatures receive an unauthorized response.
- Confirm duplicate webhook deliveries create one provider event.
- Generate each metered usage type and verify the Polar quantity.
- Confirm annual subscriptions send monthly overage quantities.
- Confirm worker logs identify usage-sync failures and that requeueing recovers them.

Self-hosted workspaces remain outside hosted billing enforcement.
