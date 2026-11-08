# Bill new deployments through Stripe

Billing runs through Polar, which is the merchant of record and handles sales tax. A study on 2026-11-05 designed letting a new deployment bill through Stripe instead: one provider per deployment, chosen at setup, with Polar moved behind the same interfaces first ([ADR 0010](../adr/0010-billing-provider-per-deployment.md)).

- **Status:** being built on `feature/receptionists`, one step at a time; nothing goes to `main`. Steps 1 to 9 are done: phases 1 and 2, and the first step of phase 3.
- **Effort:** 19 steps in four phases, about 40 to 46 developer-days. Phases 1 and 2 (steps 1 to 8) help even if Stripe waits: Polar runs behind the seam, and storage, the API and the wording stop assuming Polar.
- **Migrations:** `0146` (step 5) adds provider-neutral columns beside the Polar ones, and `0147` (step 19) drops the Polar ones a release later.

## Know what it would give

- A new deployment set to `BILLING_PROVIDER=stripe` sells its plans through Stripe Checkout, takes plan changes in **Settings > Plan**, and bills overage as money through Stripe's meters.
- Existing deployments, the demo and the RealInfoBot test deployments, stay on Polar, and no customer moves.
- Stripe doesn't keep one customer per email, so one owner can pay for several businesses with one email.

## Follow the plan

Each step lands on `feature/receptionists` once its checks pass, and leaves Polar deployments as they were.

| Phase | Steps |
| --- | --- |
| 1. The provider seam | 1 the worker's billing jobs in their own folder; 2 the provider types, factory and Polar adapter; 3 the webhook seam and normalized events; 4 the catalog seam |
| 2. Provider-neutral storage, API and wording | 5 neutral storage (`0146`); 6 neutral API fields, the links route and the CLI; 7 neutral wording; 8 plan end and change dates in **Settings > Plan** |
| 3. Stripe, behind `BILLING_STRIPE_PREVIEW` | 9 the Stripe client, adapter, fake and contract tests; 10 the catalog planner and the `stripe` block of `billing.json`; 11 `pnpm billing` on Stripe; 12 the webhook and read-back reconcile; 13 checkout, the overage subscription and deletion; 14 plan changes and promo endings; 15 cancel, resume and keep my plan; 16 usage as money and the daily totals check |
| 4. Deploy, switch on, contract | 17 deployment tooling, provider docs and legal pages; 18 the sandbox scenarios, and Stripe switched on; 19 the contract migration (`0147`), once every deployment runs step 5 |

## Decide these

Phases 1 and 2 need none of them. Each has a recommendation:

1. **Merchant of record:** Stripe directly, with Stripe Tax, where the operator registers for, collects and files the taxes; or Stripe's Managed Payments, where Stripe is the merchant for 3.5% more and overage fits only monthly plans. Needed before step 10.
2. **Yearly plans:** keep them. With Stripe directly they work unchanged.
3. **How overage is billed:** a second subscription, monthly and anchored to the 1st (UTC). Needed before step 10.
4. **Who changes plans:** **Settings > Plan** for upgrades, downgrades and cancelling; Stripe's portal for cards, invoices and billing details. Needed before step 15.
5. **A customer per business,** not per payer, for now.
6. **Stripe accounts:** one per live deployment, grouped in a Stripe Organization, and a sandbox per test deployment.
7. **Upstream's partner billing:** not now.
8. **Which provider the live deployment starts on:** Stripe, if the launch can wait for step 18. Needed before step 18.

## Step 1: the worker's billing jobs in their own folder

The worker's eight billing jobs and their helpers moved, unchanged, from `apps/worker/src/handlers.ts` into `apps/worker/src/billing/`, one file per flow: `checkout.ts`, `planChange.ts`, `reconcile.ts` (with the sweep), `usage.ts`, `promo.ts`, `deletion.ts` and `catalog.ts`. `billing/index.ts` maps each billing job type to its function, and `handlers.ts` sends the eight there. `businessIdOrThrow` moved to `apps/worker/src/jobInput.ts`, which both use. The billing tests moved from `handlers.test.ts` to `billing/*.test.ts` unchanged, with the mocks they share in `billing/testing.ts`: 108 tests before and after. `.gitattributes` merges `docs/project/changelog.md` with `merge=union`, so rows added on two branches don't conflict.

## Step 2: the billing provider interface, and Polar behind it

Its first commit, on the code as it was, records every request Polar receives in the worker's billing flows: `apps/worker/src/billing/polarRequests.test.ts` runs the real Polar client against a stub of `fetch` through checkouts (a new customer, a known one, a billing email), an upgrade invoiced now and one prorated, a downgrade, both kinds of promo ending, a promo discount dropped, a deleted business's plan ended, and usage with a correction and a call's seconds. The rest of the step leaves that snapshot unchanged.

- **The interface:** `packages/providers/src/billing/types.ts` declares `BillingProvider`, with what it can do (`can`), and the webhook and catalog interfaces the next steps fill in. `errors.ts` holds `BillingProviderError`, and `usage.ts` maps usage rows to the three kinds of overage.
- **The factory:** `factory.ts` reads `BILLING_PROVIDER` (unset or `polar`; `stripe` stops the service as not available yet) and builds the provider and the daily check's catalog client from the Polar variables, as the worker did.
- **The Polar adapter:** `packages/providers/src/polar/adapter.ts` implements the interface over the Polar client, with what the worker held before: finding or making the business's customer, the refusals of plan changes and billing emails, billing.json's proration words, promo endings, ending a plan and sending usage.
- **Its callers:** the worker's billing jobs use `WorkerDependencies.billing` and `billingCatalog`, which replace `polar` and `polarCatalog`, and the admin's billing portal route asks the provider for its session. Nothing else builds the Polar client.
- **Tests:** the worker's billing tests wrap their Polar fakes in the adapter and keep their assertions; contract tests in `packages/providers/src/billing/contract/` run each flow against the Polar adapter over a stub of `fetch`, refusals included, and the Stripe adapter joins them in step 9.

Left to the steps that use them: the job types for the overage subscription, plan actions and the daily totals check, and the names that drop Polar, such as `PriceLinks`.

## Step 3: the webhook seam and normalized events

- **One handler for every provider's route:** `apps/admin/src/lib/billing-webhook.ts` checks a delivery, finds its business, stores it once and queues it, with the refusal, unresolved and customer mismatch log lines naming the provider. `POST /api/webhooks/polar` is now a few lines that hand it Polar's webhook.
- **Polar's webhook:** `PolarWebhook` in `packages/providers/src/polar/events.ts` checks the signature with `POLAR_WEBHOOK_SECRET` and turns an event into LobbyStack's terms, as `apps/admin/src/lib/polar-event.ts` did. The stored payload keeps every field it had and adds `kind` (`subscription`, `payment` for an order, `refund`, `checkout` or `other`) and `priceRef`, Polar's product.
- **Storage:** `storeBillingWebhookEvent` replaces `storePolarWebhookEvent` and stores each event under its provider.
- **Reconcile** reads the stored kind, and for an event stored before it, the event's name, as before. A new test shows an event stored either way reconciles to the same rows.

A Polar deployment sees no change: the same answers, the same log lines and the same rows, with two more fields in each stored payload.

## Step 4: the catalog seam

Its first commit, on the code as it was, saves what `pnpm billing` prints: `plan --json` for both brands on an empty Polar organization and on the objects `polar-setup.mjs` made, and `apply` then `verify --json`. The rest of the step leaves those snapshots unchanged.

- **The planner:** `packages/domain/src/server/billingProvider.ts` declares `CatalogPlanner`: what a brand's file makes the provider sell, the calls that get the account there, the three-way verify and the link request. `polarPlanner` wraps `desiredPolarCatalog`, `planPolarChanges`, `verifyBillingCatalog` and `polarLinkPlans` unchanged, and `plannerFor` picks the deployment's. `readBillingDeployment` reads the provider with Polar's settings.
- **The client:** `PolarCatalogClient` implements `BillingCatalogClient`. The step runner, `runPolarSteps`, moved beside it into `packages/providers`, and `billingPolar.ts` exports it as before.
- **Its callers:** `pnpm billing` and the worker's daily check go through the planner, and the client runs the plan's calls. The daily check's `ops.billing.profile_drift` events add `provider` and `providerEnv` beside `polarEnv`, which existing dashboards read.

## Step 5: provider-neutral storage (migration `0146`)

`packages/db/migrations/0146_billing_provider.sql` is the expand half of the storage change. It only adds, so the release before it keeps working while Railway restarts the services, and going back to that release stays safe.

- **Twins of the Polar columns:** `billing_prices.provider_ref` (Polar's product, later Stripe's price), `billing_plans.provider_disc` (Polar's discount, later Stripe's coupon), `billing_transactions.provider_customer_id`, and on `billing_runs` the `provider`, `provider_env` (`sandbox` or `live`), `provider_account` and `provider_objects`. The migration fills them from the Polar columns, and four triggers keep each pair equal whichever release writes the row, until the contract migration (step 19) drops the Polar ones. A run may also be of kind `link`, which the contract migration makes of every `polar` run.
- **What the Stripe steps need, added now:** `billing_accounts.overage_subscription_id`, `cancel_at`, and a change waiting for the renewal (`next_plan_code`, `next_interval` and `next_change_at`, all three or none); `billing_usage_events.rate_cents` and `sync_sent_at`; `billing_usage_months.provider_overage_cents`, `provider_checked_at` and `fix_seq`. They stay empty until steps 8 and 13 to 16 write them, so those steps need no migration.
- **Checks:** `billing_accounts.source` must be `polar`, `stripe` or `managed`, checked for new and changed rows only (`NOT VALID`). Its `polar` default stays, since the release before inserts accounts without a source; the contract migration validates the check and drops the default.
- **Offers and the sweep:** `billing_offers` and `app.billing_code_offers` return `provider_disc` and `provider_ref` after their other columns, and the sweep's `app.list_billing_sweep_work` queues waiting events of either billing provider, with a partial index of its own, `provider_events_billing_received_idx`.
- **The code reads and writes only the new columns.** Link and verify runs write the provider columns (Polar links keep the kind `polar` for now), the catalog reads products and discounts from `provider_ref` and `provider_disc`, reconcile writes `provider_customer_id`, and the promo discount check reads `provider_disc`. Every account insert names its source: a checkout's account takes the deployment's provider, an account reconcile makes takes the event's, and so does a subscription that takes over a managed plan. The API keeps its field names until step 6, so a v1 client sees no change. The finance export adds `providerCustomerId`, and keeps `polarCustomerId`, from the same column, for existing readers. `devops/reset-database.mjs` counts a run against any provider's live account as live payments, reading each column through `to_jsonb` so the check works before and after the migration.
- **Tests:** `packages/domain/src/server/billingStorage.integration.test.ts` runs the migration's backfills on rows written the old way, both directions of each trigger, and the inserts the release before makes, beside the other migration tests the reliability job runs against PostgreSQL. The catalog, reconcile and sweep tests read the new columns, and the sweep's leaves a Twilio event alone.

Before a deployment takes this release, check that each account's source is one the check allows, since any update to another row would fail: `select source, count(*) from billing_accounts group by source` should list only `polar` and `managed`. A Polar deployment sees nothing else change.

## Step 6: neutral API fields, the links route and the CLI

Its first commit, on the code as it was, records what `GET /billing/catalog` and a link answer on a Polar deployment, in `packages/domain/src/server/__snapshots__/billingCatalog.integration.test.ts.snap`. The rest of the step leaves that recording unchanged once the added fields are taken out: a Polar deployment's answers only gained fields.

- **The link request** takes the provider's names: `provider`, `provider_env` (`sandbox` or `live`), `provider_account`, each plan's `provider_disc`, each price's `provider_ref`, and the other `objects` a Stripe link records. With provider `polar`, the default, Polar's names (`polar_env`, `polar_org`, `polar_disc` and `polar_id`) are still accepted, and `billingCatalogLinkRequest` in `packages/shared` translates them on arrival. A link sent in either names hashes the same, so its Idempotency-Key replays across them, and refusals name the fields as the request did.
- **The answers:** runs add `provider`, `provider_env` and `provider_account`, and a link to another provider is of kind `link` (Polar's links keep `polar`); prices add `provider_ref`, plans `provider_disc`, and the catalog a `provider` block beside `polar`, which is null on any other provider. On a Polar deployment the Polar names keep their values.
- **Refusals:** a link for another provider than the deployment's is `provider_mismatch`, and one for another provider than the first link's `billing_provider_changed`. A Polar deployment still answers `polar_org_mismatch` and `polar_org_changed`; any other provider `billing_account_mismatch` and `billing_account_changed`. `provider_block_missing` is for step 10's `stripe` block. Verify's check codes and pairs add the ones a Stripe deployment reports (`file_provider` and `postgres_provider`).
- **The route:** `POST /billing/catalog/links` serves the link, and `POST /billing/catalog/polar-links` stays as its alias, documented beside it in the OpenAPI file. The runs list takes `kind=link` for every provider's links, and `polar` for Polar's.
- **Callers:** `pnpm billing apply` sends the neutral body. The CLI's `billing catalog` shows a `provider` column and names the provider's account, `catalog-runs` shows `provider_account`, and `catalog-link` takes either body. The managed-plan 409 names the deployment's provider (`paid_through_provider`), and the billing operations' descriptions say the billing provider, with Polar's one customer per email marked as Polar's. `mintlify/api-reference/openapi.json` is regenerated.

## Step 7: provider-neutral wording

Sentences name the deployment's billing provider, so a Polar deployment reads exactly as before and a Stripe one never says Polar.

- **Refusals:** `planChangeRefusalSentences` in `packages/shared/src/billing.ts` holds each plan change refusal in each provider's words. Polar's read word for word as before, so requests stored earlier still match. Stripe's are new: its `subscription_ending` sends the business to **Settings > Plan** to resume the plan, and its `token_scope` names `STRIPE_API_KEY`. The worker stores its provider's sentence, and `planChangeRefusalOf` reads any provider's back.
- **Screens:** the plan change toast and the transactions' description take `{{provider}}`, from `provider` and `providerName`, which the dashboard's `GET /api/billing` and the checkout status now carry. The billing email strings keep Polar's name, since only Polar deployments show that form. The v1 `GET /billing` adds `provider` and `provider_name`.
- **Strings for later steps,** in all four languages, so those steps edit no locale file: `planEndsOn` and `planChangesOn` (step 8), `completePayment` and its hint (step 14), and `cancelPlan`, `resume`, `keepPlan`, their toasts, `resumeFirst` and the overage note (step 15).
- **Other messages:** the cancellation emails name the provider the business paid through; the integrations list's billing row, the operator-key 403 and the promo checkout's 409 name the deployment's provider; the CLI's `onboard` and its waits, its docs in three languages and the API's checkout and billing descriptions say the billing provider, with Polar's one customer per email kept as Polar's. `billingProviderOf` in `packages/shared` reads `BILLING_PROVIDER` for these names; the services check its value when they start.

A search of the locale files finds Polar only in the billing email strings.

## Step 8: plan end and change dates in Settings > Plan

Reconcile stores when a plan ends and what it changes to, for Polar too, so **Settings > Plan** can say it.

- **Polar's events:** the normalizer reads a subscription's `cancel_at_period_end` with its `current_period_end`, and `pending_update`'s product, which the catalog's links turn into a plan and interval. A subscription event stores `cancelAt` and `nextChange`, null when there's none; an order says nothing about them.
- **Reconcile** writes `billing_accounts.cancel_at`, and `next_plan_code`, `next_interval` and `next_change_at` all three or none, and clears them when the subscription drops them. An event stored before this step leaves them as they are.
- **The answers:** the v1 `GET /billing` adds `cancels_at`, for a live subscription only, and `next_change` (plan, interval and when). The dashboard's billing answer carries the same, with the waiting plan's tier and names when the business can read them.
- **Settings > Plan** says "Your plan ends on DATE" or "Your plan changes to PLAN on DATE" under the plan, with step 7's strings; a promo plan's own end keeps its wording, and **Manage subscription** still opens Polar's portal.

On the demo, a sandbox subscription canceled in Polar's portal should then show its end date: the check for this step once it's deployed.

## Step 9: the Stripe client, adapter core, fake and contract tests

No app path calls Stripe yet: a deployment only reaches it with `BILLING_PROVIDER=stripe` and `BILLING_STRIPE_PREVIEW=true`, and then with test keys only.

- **The package:** `stripe` 23.1.0 in `packages/providers`, at that exact version, and `STRIPE_API_VERSION` (`2026-10-28.endive`, the version the package was released with) in `packages/shared/src/billing.ts`.
- **The client** (`packages/providers/src/stripe/client.ts`): the pinned version, two network retries, a 15-second timeout, LobbyStack in the user agent and no request telemetry. `checkStripeAccount` is the startup check: the key's own account must be `STRIPE_ACCOUNT_ID`, and a test key goes with a sandbox. The worker calls it once it bills on Stripe, in step 13. `assertCertificationStripeKey` in `packages/shared/src/certification.ts` keeps a certification run on test keys.
- **The adapter** (`stripe/adapter.ts`, `StripeBilling`): finding or making the business's customer (by the ID the account holds; a deleted one, or one naming another business, gets a new one; an idempotency key per business), reading a subscription with its schedule, discounts and latest invoice (`stripe/subscriptions.ts`: the plan's item, never an overage price, with its period), the billing portal, ending a subscription now with its last invoice, and refusals (`stripe/errors.ts`, the proposal's error table). Stripe gets the business's language only when its pages and emails come in it (`stripeLocale`): Serbian isn't one, so Stripe goes by the browser. The flows of later steps have a module each, `checkout.ts`, `overage.ts`, `planChange.ts`, `cancel.ts`, `usage.ts`, `catalog.ts` and `events.ts`, which answers not_supported, naming its step, until then.
- **The fake** (`stripe/fake/`): an in-memory Stripe answering the calls the adapter makes, with Stripe's own error classes and idempotency, and builders for subscriptions, schedules, invoices and test cards.
- **The factory** takes `stripe` behind `BILLING_STRIPE_PREVIEW=true`, building the adapter from `STRIPE_API_KEY` and `STRIPE_ACCOUNT_ID` and refusing a live key; Stripe's webhook stays refused until step 12, and a preview worker has no catalog client until step 11, so it starts and skips the daily check.
- **Tests:** the contract files for the customer, a subscription, the billing portal and refusals run on both adapters; Stripe's statuses, items and errors each have a test, and so do the certification guard and the factory's refusals.
