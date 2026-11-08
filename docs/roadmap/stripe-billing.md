# Bill new deployments through Stripe

Billing runs through Polar, which is the merchant of record and handles sales tax. A study on 2026-11-05 designed letting a new deployment bill through Stripe instead: one provider per deployment, chosen at setup, with Polar moved behind the same interfaces first ([ADR 0010](../adr/0010-billing-provider-per-deployment.md)).

- **Status:** being built on `feature/receptionists`, one step at a time; nothing goes to `main`. Steps 1 to 14 are done: phases 1 and 2, and steps 9 to 14 of phase 3.
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

## Know what was decided

Each decision was taken as the study recommended, on 2026-11-08:

1. **Merchant of record:** Stripe directly, with Stripe Tax: the operator registers for, collects and files the taxes, once an accountant confirms which registrations are needed. Stripe's Managed Payments, the merchant for 3.5% more, wasn't taken.
2. **Yearly plans:** kept. With Stripe directly they work unchanged.
3. **How overage is billed:** a second subscription, monthly and anchored to the 1st (UTC).
4. **Who changes plans:** **Settings > Plan** for upgrades, downgrades and cancelling; Stripe's portal for cards, invoices and billing details, with its plan switches and cancelling off.
5. **A customer per business,** not per payer, for now.
6. **Stripe accounts:** one per live deployment, grouped in a Stripe Organization, and a sandbox per test deployment.
7. **Upstream's partner billing:** not now.
8. **Which provider the live deployment starts on:** Stripe, once step 18 is done.

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
- **The client** (`packages/providers/src/stripe/client.ts`): the pinned version, two network retries, a 15-second timeout, LobbyStack in the user agent and no request telemetry. `checkStripeAccount` checks a key against a deployment: its own account must be `STRIPE_ACCOUNT_ID`, and a test key goes with a sandbox. The worker's startup check, from step 13, reads the account through the adapter (`checkAccount`), the factory having taken only a key of the deployment's mode. `assertCertificationStripeKey` in `packages/shared/src/certification.ts` keeps a certification run on test keys.
- **The adapter** (`stripe/adapter.ts`, `StripeBilling`): finding or making the business's customer (by the ID the account holds; a deleted one, or one naming another business, gets a new one; an idempotency key per business), reading a subscription with its schedule, discounts and latest invoice (`stripe/subscriptions.ts`: the plan's item, never an overage price, with its period), the billing portal, ending a subscription now with its last invoice, and refusals (`stripe/errors.ts`, the proposal's error table). Stripe gets the business's language only when its pages and emails come in it (`stripeLocale`): Serbian isn't one, so Stripe goes by the browser. The flows of later steps have a module each, `checkout.ts`, `overage.ts`, `planChange.ts`, `cancel.ts`, `usage.ts`, `catalog.ts` and `events.ts`, which answers not_supported, naming its step, until then.
- **The fake** (`stripe/fake/`): an in-memory Stripe answering the calls the adapter makes, with Stripe's own error classes and idempotency, and builders for subscriptions, schedules, invoices and test cards.
- **The factory** takes `stripe` behind `BILLING_STRIPE_PREVIEW=true`, building the adapter from `STRIPE_API_KEY` and `STRIPE_ACCOUNT_ID` and refusing a live key; Stripe's webhook stays refused until step 12, and a preview worker has no catalog client until step 11, so it starts and skips the daily check.
- **Tests:** the contract files for the customer, a subscription, the billing portal and refusals run on both adapters; Stripe's statuses, items and errors each have a test, and so do the certification guard and the factory's refusals.

## Step 10: the catalog planner and the `stripe` block

Nothing runs it yet: `pnpm billing` and the daily check run Stripe's planner from step 11, and no brand's `billing.json` has a `stripe` block until its first Stripe deployment (step 18), since adding one changes the file's hash.

- **The `stripe` block** (`packages/shared/src/billingProfile.ts`, and `brands/billing.schema.json` from `pnpm brands:build`): `upgrade` (`invoice`, `prorate` or `reset`) and `downgrade` (`next_period`, `invoice` or `prorate`) in Polar's words; `portalPlanChanges` and `portalCancel` for Stripe's billing portal; `tax` (`exclusive`, and a Stripe product tax code such as `txcd_10103001`); `usageGraceHours`, the Dashboard rule for finalizing a metered invoice, which the API can't read; `overage` (`separate` or `checkout`); and `managedPayments`. The block holds the answers to decisions 1 and 3, so another answer changes the block, not the code: with `managedPayments` the overage must be `checkout`, and with `checkout` no plan can be annual. Step 10 went ahead on the recommended answers, Stripe Tax and a second subscription, which were then taken.
- **The `polar` block is optional.** An apply refuses a file without the block of its deployment's provider (`provider_block_missing`), so a Polar deployment still needs one.
- **The planner** (`packages/domain/src/server/billingStripe.ts`, `stripePlanner`): the objects a file needs, the calls that get a Stripe account there, the link body and verify, pure as Polar's are. The snapshot, step and call types are in `packages/providers/src/stripe/catalog.ts`, for the client of step 11.
  - A product per sold plan, tagged with the brand and the plan; a promo plan gets its own, since the portal can't hold two prices of one product with the same interval.
  - A price per live price, under the lookup key `ls_<brand>_<plan>_<period>_<currency>_<terms8>`, before tax. Stripe never changes a price, so new terms make a new price under a new key, and the old one is archived only with `--allow-archive`; its subscribers keep it. A price that holds the key but can't sell what's wanted is replaced only with `--allow-replace`, which moves the key to a new price. The brand is in the key, so another brand's prices in a shared account never collide, and one tagged for another brand is never replaced.
  - Three meters (`ls_overage_voice`, `ls_overage_sms` and `ls_overage_transfers`, a sum of dollars by `stripe_customer_id`), and an overage product and a metered price for each (`ls_overage_<kind>_<currency>`, a dollar a unit). They are the account's, shared by every brand on it, and never archived.
  - A coupon per discounted plan, under the ID `ls-<brand>-<plan>-<terms8>`, for that plan's product only; one Stripe can't change is refused, and a leftover is deleted only with `--allow-archive`.
  - The billing portal's configuration: invoices, cards, email, address and tax ID; plan changes between the public standard plans, an upgrade charged as `upgrade` says (`reset` starts a new cycle) and a downgrade at the period's end for `next_period`; cancelling as `portalCancel` says; the brand's terms and privacy pages; Settings > Plan to return to.
  - The webhook endpoint at `/api/webhooks/stripe`, with the 14 events of the proposal (`STRIPE_WEBHOOK_EVENTS`) in `STRIPE_API_VERSION`, and the meter error destination under it, with the two thin events. An endpoint in another version is replaced only with `--allow-replace`.
- **The link** records each plan's price and coupon IDs, and the meters, the overage prices, the portal configuration, the endpoint and the destination; pnpm billing adds the webhook secret's SHA-256 in step 11.
- **Verify** shares the file and Postgres checks with Polar, compares the file with Stripe through the planner, checks Stripe Tax (active, an origin address and a registration; drift on a live account, a warning in a sandbox, nothing with Managed Payments), and compares the rows and the latest link with Stripe: the linked prices, the account, the key's mode, the overage prices, the portal configuration and the webhook secret's hash.
- **Tests** (`billingStripe.test.ts`, on the stand-in in `billingStripe.testing.ts`): both brands' files with a test block, an empty account, a run cut off halfway, new terms, another brand in the same account, a renamed meter, objects Stripe can't change, coupons, the portal's settings, the webhook, the link body and verify against drifted accounts.

On an empty account, RealInfoBot's file with the recommended block makes:

| Object | What |
| --- | --- |
| 3 meters | Voice, alert SMS and call transfer overage in dollars |
| 3 overage products and prices | `ls_overage_voice_cad`, `ls_overage_sms_cad` and `ls_overage_transfers_cad`, 1.00 CAD a unit, invoiced monthly |
| 2 products | Starter and Pro, tax code `txcd_10103001` |
| 4 prices | Starter 37.00 CAD a month and 370.00 a year, Pro 87.00 a month and 870.00 a year, before tax |
| No coupon | The file has no discounted plan |
| The billing portal | Plan changes between Starter and Pro; Settings > Plan cancels |
| The webhook endpoint and the meter error destination | 14 events in `2026-10-28.endive`, and the two meter error events |

## Step 11: `pnpm billing` on Stripe

A deployment set to `BILLING_PROVIDER=stripe`, with the preview's test keys, can now have its catalog set up, linked and checked. Nothing sells yet: checkout comes with step 13.

- **`pnpm billing plan|apply|verify --stripe sandbox|live`** in place of `--polar`, with every flag but `--adopt`. `apply` takes `STRIPE_SETUP_KEY`, `plan` and `verify` `STRIPE_READ_KEY` (else the setup key), each asked for with typing hidden when unset and never printed, and a key of the other mode is refused. Before it changes anything the run checks that the instance bills through Stripe, with the key's account (`STRIPE_ACCOUNT_ID`) and mode (its `STRIPE_API_KEY`'s), that it wasn't linked to another account, that it runs the checkout's file, and that the file has a `stripe` block.
- **Apply** runs the planner's calls with `StripeCatalogClient` (`packages/providers/src/stripe/catalog.ts`): each create carries `catalog:<brand>:<object>:<key>` and a hash of what it sends as its idempotency key, and a run cut off halfway is finished by running it again. `--railway-file` gets `STRIPE_ACCOUNT_ID` for the admin and the worker, and the secrets Stripe shows once, `STRIPE_WEBHOOK_SECRET` and `STRIPE_METER_WEBHOOK_SECRET`, for the admin; nothing prints them. The link sends the prices' and coupons' IDs, the deployment-wide objects and the endpoint secret's SHA-256, which `billing_runs.provider_objects` keeps, since Stripe never shows the secret again.
- **Plan and verify** list what's left for Stripe's Dashboard: the tax registrations (or Managed Payments), the grace period of `usageGraceHours`, the retries after a failed payment, and the branding and statement descriptor.
- **The deployment's settings:** `billingCatalogDeployment(brand, env)` gives the catalog's operations Stripe's settings on a Stripe deployment (the account, the mode of `STRIPE_API_KEY`, and the hash of `STRIPE_WEBHOOK_SECRET`'s first secret, as a rotation holds two), so `GET /billing/catalog` shows them and a link to Polar, another account or another mode is refused.
- **The daily check** reads a Stripe account with the worker's `STRIPE_API_KEY`, endpoints left out, and runs Stripe's checks. Its `ops.billing.profile_drift` events need `provider` and `providerEnv`; `polarEnv` comes only from a Polar deployment.
- **Tests:** the client and the fake's catalog objects (`stripe/catalog.test.ts`), `pnpm billing --stripe` end to end on the fake (`scripts/billing.stripe.test.ts`: a full run, a second run with nothing to do, a run cut off halfway, the refusals and verify), and a Stripe deployment's links and daily check on PostgreSQL.

The check for this step, on a Stripe sandbox: `apply` makes every object, a second `apply` plans nothing, and `verify` reports in sync once the admin has `STRIPE_WEBHOOK_SECRET`.

## Step 12: the webhook and read-back reconcile

- **`StripeWebhook`** (`packages/providers/src/stripe/events.ts`): the `Stripe-Signature` header checked with `STRIPE_WEBHOOK_SECRET`, or either of its two secrets during a rotation, and refused when it's more than 300 seconds off or the event's mode isn't that of the admin's `STRIPE_API_KEY` (`wrong_mode`). The event envelope is `stripeEventSchema` in `packages/contracts/src/stripeEvents.ts`. It keeps the events of `STRIPE_WEBHOOK_EVENTS` and drops the rest with 202.
- **Events in reconcile's terms:** a subscription's plan item, status, period, end and, once read back, its waiting change; the overage subscription's events move no plan. An invoice is a payment: an open one is pending, and only the plan's invoices name its subscription. A checkout session names its request and outcome, for step 13. `charge.refunded` names its payment, and `charge.dispute.created` is stored only when its metadata names the business. The business comes from the subscription's metadata, which Stripe copies onto its invoices, or the session's; a charge names only its customer, whose metadata (`businessOfCustomer`, with the admin's key) names the business.
- **Routes:** `POST /api/webhooks/stripe` uses the shared handler, and `POST /api/webhooks/stripe/meter-errors` checks the destination's thin events with `STRIPE_METER_WEBHOOK_SECRET` and logs `ops.billing.meter_error`. The route of the provider a deployment doesn't bill through answers 404 and logs `ops.billing.webhook_wrong_provider` at most once a minute, Polar's on a Stripe deployment too.
- **Read-back:** for a provider that reads back, the worker reads the event's subscription (`getSubscription`), and a refund's invoice (`invoiceOfPayment`, through Stripe's invoice payments), before reconcile opens its transaction. The read-back wins over the event, and its read time becomes `subscriptionModifiedAt` on the stored event, so two reconciles of one subscription, run in either order, end on the later read.
- **Payments:** invoices are order rows (`source_id` and `order_id` the `in_` ID, with the hosted invoice URL and the customer), so affiliate commissions and the finance export need no change; `uncollectible` ranks with pending, so a later payment still lands. A refund adds to its invoice's row, made first when the refund comes before the payment, and cuts the commission.
- **Tests:** signatures (good, bad, rotated, old, the wrong mode), each event type normalized, the routes (a duplicate, an unresolved business, the customer read back, the other provider's route), the worker's read-backs, any order of one subscription's events with read-backs, invoices with an uncollectible one, refunds before and after their payment, and a commission on a paid invoice cut by its refund.

The check for this step: sandbox events forwarded by the Stripe CLI reconcile on a local stack.

## Step 13: checkout, the overage subscription and deletion

- **Checkout** (`stripe/checkout.ts`): a subscription-mode session on the business's customer, the one the billing account holds or a new one, with the plan's price and a promo plan's coupon. The request ID is the `client_reference_id`, and the business, the request and the role go in the session's and the subscription's metadata. The page lasts an hour from the next minute, so a retry within the minute gets the same page (idempotency key `checkout:<request>:<expiry>`), and speaks the business's language where Stripe has it. Stripe Tax applies, with the billing address and tax IDs collected. Stripe keeps no customer per email, so the billing email form, which shows only after Polar refuses an email, never shows.
- **The overage subscription** (`stripe/overage.ts`, and the worker's `billing.ensureOverage` in `apps/worker/src/billing/overage.ts`): the three overage prices in the catalog's currency, anchored on the 1st at 00:00 UTC with no proration, with Stripe Tax. A try that died is found again by the metadata (`lobbystack_role` `overage` and `lobbystack_plan_subscription`). The checkout's card becomes the customer's default, so both subscriptions pay with it, as does a card changed in the portal. The job stores `overage_subscription_id` while the account still pays with that plan subscription.
- **When the job runs:** reconcile queues it, once per event, for a Stripe plan event that finds the plan live without an overage subscription, live again, or ended with one. A live plan keeps its overage subscription while it's set to end. Once the plan has ended, the job sets the overage subscription to end with its month, whose overage is still invoiced. The proposal ended it at a `cancel_at` too, which would have stopped it on the 1st, before a plan set to end in a later month, a yearly one most of all.
- **Without one:** a Stripe account without an overage subscription bills no overage, so usage stops at the allowance (`noOverage` in `usage.ts`). A job that fails an hour or more into the plan's period reports `ops.billing.overage_missing`. Reconcile drops an overage subscription Stripe ended or left unpaid. One Stripe ended after failed payments or a dispute, or left unpaid, while the plan is live is reported as `ops.billing.overage_unpaid`, and the job makes no other while its invoice is open. Once that invoice is paid, voided or marked uncollectible, the plan's next event makes a new one, as it does for one canceled by hand.
- **Deletion:** `billing.revokeSubscription` ends the plan subscription and the overage subscription at once, each with its last invoice.
- **Startup:** the worker reads its key's own account (`checkAccount`). With another account's key than `STRIPE_ACCOUNT_ID`, it runs without billing and sends `ops.billing.provider_mismatch`; when Stripe can't be reached, it bills on and logs `ops.billing.account_unchecked`.
- **Overage on the checkout:** the `stripe` block's `overage: checkout`, the answer to decision 3 that wasn't taken, isn't built: checkout would still make the overage subscription.
- **Tests:** on the fake, the checkout's call and its retry, and the overage subscription made once, found again, kept while it's owing and replaced once it isn't, and ended at once and with its month. The job's cases and a deleted business's two subscriptions run on the in-memory Stripe (`overage.test.ts`), beside the startup check (`account.test.ts`). On PostgreSQL: the plan events that queue the job, the overage subscription stored, dropped and reported, and usage held to the allowance without one.

The check for this step, on a Stripe sandbox: a checkout starts the plan, the overage subscription appears anchored on the 1st, and deleting the business ends both with their invoices.

## Step 14: plan changes and promo endings

- **A change now** (`stripe/planChange.ts`): the plan's item moves to the new price with `payment_behavior: pending_if_incomplete`, so Stripe applies it only once the invoice it makes is paid. The `stripe` block's words set the charge: `invoice` invoices the difference now, `prorate` puts it on the next invoice, and `reset` starts a new period today, crediting what's left of the old one. A promo plan's coupon and metadata go in the same call, and leaving a promo plan for a standard one removes the discount. A change now releases a schedule waiting for the renewal, as Polar's replaces a waiting change.
- **Its payment:** paid at once, the plan changes. A payment the bank wants confirmed, as with 3-D Secure, comes back as `needs_action` with the invoice's page. The worker puts the request in `ready` with that page, and the subscription as its checkout ID, so the dashboard opens the page as it opens a checkout. A declined payment's invoice is voided, which drops the waiting update, and the change is refused as `payment_failed`. Stripe answers a declined payment and one the bank must confirm alike, so the adapter reads the payment intent on the invoice's payments to tell them apart.
- **Settling the request:** `customer.subscription.pending_update_applied` marks the request changed, and its read-back moves the plan. `pending_update_expired` fails the request as `payment_failed` and logs `ops.billing.plan_change_expired`. Until one of them, Settings > Plan shows **Complete payment** with the bank's hint, and `GET /v1/billing` the page as `payment_action_url`, for a day at most.
- **At the renewal:** a downgrade, and a promo plan's end on its tier's price, are a subscription schedule, made from the subscription unless it has one: the current phase to the period's end, then a second on the new price, after which the schedule lets the subscription go. A change at the renewal while an upgrade waits for its payment is refused as `change_pending`, since the phase would drop the upgrade. A promo plan that ends cancelled releases any schedule, then sets the subscription to cancel at the period's end. Removing a discount clears the subscription's discounts.
- **The worker:** `loadPlanChangeProration` reads the `stripe` block's `upgrade` and `downgrade` on a Stripe deployment. The promo ending job already called `endAtRenewal` and `removeDiscount`, and its warnings now name the provider.
- **Tests:** on the fake, an upgrade paid at once, declined, and needing 3-D Secure, then paid or expired, with a retried job getting the same page; the prorations and a promo price's coupon; a downgrade at the renewal and its phase taking effect, and a change now releasing a schedule; both promo endings and a discount removed. The fake gained `payInvoice`, `expirePendingUpdate` and `enterSchedulePhase` for them. The worker's three outcomes run on the in-memory Stripe, and the plan page's **Complete payment** in the admin's tests. On PostgreSQL: the request settled both ways, `payment_action_url`, and the `stripe` block's words.

The check for this step, on a Stripe sandbox with Stripe's test cards: an upgrade, a downgrade, a declined upgrade and a 3-D Secure upgrade each end as the tests say.
