# Know the billing tables

Billing keeps two kinds of rows in PostgreSQL. The catalog belongs to the whole deployment: the plans `billing.json` defines, their prices, the prepaid packs it sells, the runs that wrote them and the promo codes operators issue. Everything else belongs to one business: its account, checkout requests, usage, monthly totals, payments, prepaid packs and the provider's events. This page lists each table, the migrations the fork added, the database functions billing relies on, and who may read and write what. Checked against `main` at `da1f548`; the prepaid pack tables of migrations `0148` and `0149` against `feature/receptionists` on 2026-11-09 ([prepaid packs](../features/prepaid-packs.md)).

`\d+ <table>` in `psql` shows each column's comment, which the migrations write for every catalog and promo column. [Billing](README.md) describes how the pieces work together.

## Know the catalog tables

These have no `business_id`. Rows are retired, never deleted, and no role may delete them.

### `billing_plans`

One row per plan in `billing.json`, standard or not. The four standard plans are the rows whose `code` is their `tier`.

| Column | Holds |
| --- | --- |
| `code` | The plan's permanent code, its key in `billing.json` |
| `tier` | The built-in tier the code treats it as: `free_cloud`, `starter`, `pro` or `enterprise` |
| `status` | `draft` (not sellable yet), `active` or `retired`. A link from `pnpm billing apply` makes a sold plan active. |
| `access` | `public`, `code` (only through a promo code) or `hidden` (operator only) |
| `sold`, `custom`, `overage` | Polar sells it; it is priced by hand with no allowances; usage past the allowance is billed rather than refused |
| `src` | `file` (`billing.json`) or `api` |
| `names` | Display names in `en`, `fr`, `es` and `sr`; null for the standard plans, whose names are translated in the app |
| `voice_sec`, `sms_seg`, `calls_out`, `chat_units` | Included each month: voice seconds, alert text segments, call transfers, website chats |
| `kb_bytes`, `numbers` | Knowledge storage limit and included phone numbers (at most one since fork PR #70) |
| `receptionists` | Active receptionists included, from `limits.receptionists` (migration `0134`, fork PR #129); null on a custom plan, which gets the deployment's cap. It stays out of `terms_hash`, since Polar never sees it, so an apply checks it apart: on a plan with `frozen_at` it may only go up (fork PR #134) |
| `voice_rate`, `sms_rate`, `call_rate` | Overage cents per voice minute, text segment and transfer; set exactly when `overage` is |
| `months`, `ends` | How many months a promo plan lasts, and what follows: `tier`, `keep` or `cancel` |
| `offer_end` | No new subscription after this moment |
| `discount`, `provider_disc` | The plan's code-less discount, and the provider's ID for it: a Polar discount or a Stripe coupon (`0146`; `polar_disc` until `0147`) |
| `terms_hash`, `frozen_at` | A hash of the terms subscribers depend on, and when the first business took the plan, after which a promo plan's terms can't change and its receptionists can't go down |
| `sort`, `run_id`, `retired_at`, `created_at`, `updated_at` | Display order, the run that last changed the row, and its times |

Checks keep the shapes apart: a standard plan has no names and no promo fields, a custom plan is never sold and has no allowances, and a plan has all three overage rates or none.

### `billing_prices`

| Column | Holds |
| --- | --- |
| `plan`, `period` | The plan code, and `monthly` or `annual` |
| `currency`, `cents` | Three lowercase letters, and the price of one period |
| `per_month` | Computed: `cents`, or for annual `cents / 12` rounded to the nearest whole unit of the currency, so 37000 gives 3100 (`0119`) |
| `provider_ref` | The provider's object that sells it, unique across every plan: a Polar product or a Stripe price (`0146`; `polar_id` until `0147`) |
| `run_id`, `retired_at`, `created_at`, `updated_at` | The run that last changed it, and its times |

Each plan has one live price per period, so every live price is in the file's one currency. A currency change retires the old rows before it adds the new ones.

### `billing_runs`

One row per catalog apply (`kind` `catalog`), link to the provider's objects (`link`, which `0147` made of every earlier `polar` run; the API still shows a Polar link as `polar`) and check (`verify`), with its `status` (`applied`, `unchanged`, `failed`, `passed` or `drift`), the brand, the file's version and `hash`, the previous hash, the hash built into the code that ran it (`code_hash`), the normalized file (`profile`), the rows written (`changes`), the drift found (`problems`), the provider, its environment (`sandbox` or `live`) and account (`provider`, `provider_env` and `provider_account` since `0146`; `polar_env` and `polar_org` until `0147`), and the operator key, partner, Idempotency-Key and request hash that asked for it. Every run but the worker's daily check was asked for by an operator key with an Idempotency-Key, and one key can't run two requests under the same Idempotency-Key. `started_at` is kept to the millisecond, since the API's cursor carries it.

### `billing_offers`

A view of the plans on offer now: active, offer not ended, each with its live prices. It reads with each caller's own row-level security (`security_invoker`), so the dashboard sees only public offers; without that the view would return nothing, since the tables force row-level security.

### `billing_codes` and `billing_code_redemptions`

| Column | Holds |
| --- | --- |
| `code` | What people type, in upper case, at least 4 characters; compared regardless of case |
| `plan` | The plan whose `access` is `code` that it unlocks |
| `business_id` | The one business that may use it, or null for a shared code, which then needs `max_uses` and `expires_at` |
| `max_uses`, `uses`, `expires_at` | How many businesses may subscribe with it, how many have, and when it stops |
| `status`, `revoked_at` | `active` or `revoked`; businesses already on its plan keep it |
| `note` | The operator's note, such as who it was for |
| `key_id`, `partner`, `idem_key`, `req_hash`, `created_at`, `updated_at` | The operator key that issued it, its Idempotency-Key, and its times |

`billing_code_redemptions` has one row per code and business that subscribed with it, with `redeemed_at`, so a business uses a code once (fork PR #70). Codes live only in the database, never in the repository.

### `billing_pack_plans` and `billing_pack_prices`

One row per pack in `billing.json`'s `packs` section (migration `0148`), and its one-time price. Like the plans, packs are retired, never deleted.

| Column | Holds |
| --- | --- |
| `code` | The pack's permanent code, its key in `billing.json` |
| `status` | `draft` (not sellable yet), `active` or `retired`. A link from `pnpm billing apply` makes a pack active, and new terms take it back to `draft` until the next link. |
| `names` | Display names in `en`, `fr`, `es` and `sr` |
| `voice_sec` | The voice seconds the pack holds for its whole length |
| `days` | How long it lasts from the payment, in 24-hour days, from 1 to 1,095; null for a pack that never ends |
| `sms_seg`, `calls_out`, `chat_units` | Included each UTC month while the pack lasts: alert text segments, call transfers, website chats |
| `kb_bytes`, `numbers`, `receptionists` | Knowledge storage limit, included phone numbers (0 or 1) and receptionists (1 to 50) |
| `terms_hash`, `frozen_at` | A hash of the minutes, length, allowances, limits and price, and when the first business bought the pack, after which an apply refuses to change its minutes or length |
| `sort`, `run_id`, `retired_at`, `created_at`, `updated_at` | Display order, the run that last changed the row, and its times |

`billing_pack_prices` has `pack`, `currency`, `cents` (the one-time price) and `provider_ref`, the Stripe price or Polar product that sells it, unique across every pack. Each pack has one live price. A retired price keeps its `provider_ref`, so a payment made at that price still finds its pack.

### `billing_pack_offers`

A view of the packs on sale now: active, each with its live price. Like `billing_offers` it reads with each caller's own row-level security (`security_invoker`). Packs never fall back to the brand's file, so it is empty until an apply links them.

## Know the business tables

Every one has a `business_id` and policies that keep each business to its own rows.

| Table | Holds |
| --- | --- |
| `billing_accounts` | One row per business: `billing_key` (`business:<business ID>`, which usage and the portal use), the Polar `customer_id` and `subscription_id`, `plan` (the tier), `billing_interval`, `subscription_state`, the current period, `overage_spending_cap_cents`, and the columns below |
| `billing_checkout_requests` | Each checkout or plan change asked for: who asked, the target plan and interval, `status` (`pending`, `processing`, `ready`, `changed`, `error`, or `canceled` when the business moved to a managed plan), Polar's checkout ID and URL, the error, and `plan_code`, `code_id` and `billing_email` |
| `billing_usage_events` | Each use: `source_key` (unique), `usage_kind` (`voice_seconds`, `alert_sms_segments`, `outbound_call_attempts` or `chat_ai_tokens`), `quantity` and `billable_quantity`, the plan, plan code and interval it was used under, `is_final`, `sync_status` (`pending`, `synced` or `skipped`), and the sync columns below |
| `billing_usage_months` | Each business's monthly totals and blocked flags, and its overage spend |
| `billing_transactions` | The provider's orders and refunds: amount, refunded amount, currency, invoice URL, the provider's IDs and the payer's customer, `provider_customer_id` |
| `provider_events` | Each Polar webhook event, stored once by its ID, with its `status` (`received` until the worker applies it) |
| `unit_economics_rollups` | What each business cost each month in provider, AI and hosting fees, in US dollars |
| `billing_pack_checkouts` | Each pack checkout asked for (`0148`): who asked, the pack and price, `status` (`pending`, `processing`, `ready`, `paid`, `failed` or `expired`), the provider's checkout ID and URL, the error, `billing_email`, and `expires_at`, when it stops being open whatever its status. Since `0149`, `terms`, the pack's minutes, days, allowances and limits when it was asked for, which its payment adds the pack with (null on an older row, whose payment reads the catalog), `pack_id`, the pack its payment added, and `subscription_id`, the subscription live on the account when it was asked for, which its payment replaces (null when none was, so a live subscription the payment finds that it doesn't name came later, and the pack gives way to it) |
| `billing_packs` | The prepaid pack ledger (`0148`), one row per pack bought: the pack, the price and payment it was bought with (`provider`, and `provider_ref`, a Stripe PaymentIntent or a Polar order, unique per provider), the amount and currency, `seconds_total` and `seconds_used`, the allowances and limits copied from the pack at purchase, `paid_at` and `ends_at` (the payment plus `days` times 24 hours), `status` (`active`, `expired`, `replaced`, `refunded` or `frozen` during a dispute), `refunded_cents`, `ended_at` and the `unused_seconds` it held then, and `notices`, the reminders the daily expiry job already sent |
| `billing_pack_draws` | Which pack paid for each call (`0148`): the pack, the call's usage `source_key` and the seconds it took. No foreign key into `billing_usage_events`, so that table's rules stay as they are |

The columns the fork added to them:

| Column | Added in | Holds |
| --- | --- | --- |
| `billing_accounts.plan_code` | `0109` | The exact plan when it isn't its tier's standard plan; `plan` stays the tier |
| `billing_accounts.plan_ends`, `code_id` | `0109` | When a time-limited plan ends, and the code the business subscribed with |
| `billing_accounts.end_with`, `end_notice_at`, `end_set_at` | `0111` | An operator's early ending (`tier` or `cancel`), when the owners were emailed, and when Polar was told |
| `billing_accounts.subscription_claim`, `subscription_claimed_until` | `0116` | The worker run changing the Polar subscription, and when its claim runs out, so two changes never overlap |
| `billing_checkout_requests.plan_code`, `code_id` | `0109` | The plan and code a promo checkout sells |
| `billing_checkout_requests.billing_email` | `0115` | The email that owns a business's new Polar customer instead of the requester's, when Polar refused the requester's |
| `billing_usage_events.plan_code_at_record_time` | `0110` | The promo plan the use counted under, so a month that moves onto or off one prices each event on its own terms |
| `billing_usage_events.synced_quantity`, `sync_seq`, `sending_quantity` | `0116` | What Polar has, the number of the next event to send (`source_key`, then `source_key:<n>`), and the difference being sent |
| `billing_accounts.source` check | `0146`, `0147` | `polar`, `stripe` or `managed`; `0147` checked the rows from before. The `polar` default stays: reconcile's upsert leaves the source out for an account that exists, and PostgreSQL checks NOT NULL before it finds the conflict |
| `billing_accounts.overage_subscription_id`, `cancel_at` | `0146` | Stripe's monthly overage subscription, or the plan subscription itself when overage is on the plan's checkout (merchant of record), and when the subscription ends unless resumed |
| `billing_accounts.next_plan_code`, `next_interval`, `next_change_at` | `0146` | A plan change waiting for the renewal, all three or none |
| `billing_usage_events.rate_cents`, `sync_sent_at` | `0146` | The overage rate a row was priced at, where the provider meters money (Stripe), and when its event last went out |
| `billing_usage_months.provider_overage_cents`, `provider_checked_at`, `fix_seq` | `0146` | What the provider held at the last daily totals check, when, and the number of its next correction |
| `billing_transactions.provider_customer_id` | `0146` | The payer's customer at the provider (`polar_customer_id` until `0147`); the finance export still shows it as `polarCustomerId` too |
| `billing_accounts.allowances_since` | `0148` | Where the month's allowances start counting, written only when a business switches between a pack and a subscription; null, the whole month, for every other business |
| `billing_accounts.replaced_subscription_id` | `0148` | The subscription a pack replaced, which LobbyStack treats as ended from the pack's payment while `billing.endPlanForPack` ends it at the provider; null for every other business |

## Know the migrations

| Migration | Pull request | Adds |
| --- | --- | --- |
| `0108_billing_catalog` | #58 | `billing_runs`, `billing_plans`, `billing_prices` and the `billing_offers` view |
| `0109_billing_codes` | #63 | `billing_codes`, the promo columns on accounts and checkout requests, `app.billing_code_offers`, and a policy that lets a business read its own plan |
| `0110_promo_plan_allowances` | #64 | `plan_code_at_record_time`, and the allowances in `app.billing_code_offers` |
| `0111_promo_ending` | #65 | The three ending columns and `app.billing_owner_recipients` |
| `0112_number_claims_by_allowance` | #66 | `app.business_included_numbers`, used by the three number claim functions |
| `0113_billing_code_redemptions` | #70 | `billing_code_redemptions`, filled from earlier uses |
| `0114_billing_sweep` | #71 | `app.list_billing_sweep_work` and two partial indexes for it |
| `0115_billing_email` | #72 | `billing_checkout_requests.billing_email` |
| `0116_billing_edges` | #75 | The subscription claim, the usage sync columns, and open checkouts counting toward a shared code's limit |
| `0119_whole_annual_per_month` | #89 | `per_month` rounded to a whole unit, by adding the column again and making `billing_offers` again |
| `0134_billing_receptionists` | #129 | `billing_plans.receptionists`, filled for the standard tiers from both brands' files, and the column at the end of `billing_offers` and `app.billing_code_offers` |
| `0146_billing_provider` | #129 (the Stripe plan's step 5) | Provider-neutral twins of the Polar columns, filled from them and kept equal by triggers until the contract migration; the account and usage columns the Stripe steps use; the source check, not yet validated; the two new columns at the end of `billing_offers` and `app.billing_code_offers`; and the sweep for either billing provider ([Stripe billing](stripe-history.md)) |
| `0147_billing_provider_contract` | #129 (the Stripe plan's step 19) | The contract: drops `0146`'s triggers and the Polar columns they kept equal, renames `polar` link runs to `link`, checks the source and rate checks against every row, drops `0114`'s Polar-only sweep index, and makes `billing_offers` and `app.billing_code_offers` again without the Polar columns |
| `0148_billing_packs` | [Prepaid packs](../features/prepaid-packs.md), on `feature/receptionists` | The five pack tables and the `billing_pack_offers` view, two empty columns on `billing_accounts`, a first step for a live pack in `app.business_included_numbers`, one condition for a number whose last pack ended in the three phone resolvers, and a fourth branch for pack checkouts in `app.list_billing_sweep_work`, with its index. Nothing is backfilled |
| `0149_billing_pack_checkout_terms` | The prepaid packs' review, on `feature/receptionists` | `billing_pack_checkouts.terms`, `pack_id` and `subscription_id`, and `app.billing_code_offers` again, no longer counting a subscription a pack's payment replaced as live on a code's plan. Nothing is backfilled. The dashboard's writes to `billing_packs` and `billing_pack_draws`, which it never makes, stay for now: the release before checks for them at the end of its migrate step, so a later migration takes them back |
| `0150_account_business_plans` | #154, on `feature/receptionists` | `app.list_user_business_plans`, which reads the plan columns of each business the signed-in account owns and whether a pack has time left, for the business cap per plan ([businesses per account](../../brands/README.md#businesses-per-account)) |

Up to `0146` they only add tables, columns, indexes, functions and triggers, and `0119` only changes what `per_month` holds, so rolling back one release leaves the database usable. `0146`'s triggers kept each Polar column equal to its new twin for the release before it. `0147` drops them, so no release before `0146` runs on a database after `0147`: it's fixed forward, never rolled back. `0113` fills `billing_code_redemptions` only when the migration signs in as a role that bypasses row-level security, such as `postgres`: its log says `Promo codes: <n> uses by a business recorded.`, or `Skipping the promo code redemption backfill` when it couldn't.

`0148` only adds, and the five functions it replaces act as before for every business without a pack, so a release before it still runs on the database. That release ignores the pack tables, though: a business on a pack falls back to its account's plan there, and its catalog check treats the packs' Stripe or Polar objects as leftovers. [Prepaid packs](../features/prepaid-packs.md#set-it-up-on-a-deployment) says what to do before a rollback. `0149` adds two nullable columns and changes what `app.billing_code_offers` returns only for a business whose subscription a pack replaced, with the same arguments and columns, so a release before it runs on the database too. It leaves the dashboard's unused pack writes in place, because that release's migrate step checks for them; the migration that takes them back comes once no deployment can roll back below `0149`, whose checks no longer expect them.

`0150` only adds a function, so a release before it still runs on the database and ignores it.

### Before `0147` on a database with data

A deployment that ran `0146` and has data runs these read-only queries before it takes `0147`, as `postgres` (pgAdmin, or `psql` with the Postgres service's `DATABASE_PUBLIC_URL`). A deployment set up after `0147` needs none. If one finds rows, fix them before the deploy: the migration stops on them, and the deployment keeps running the release before.

```sql
-- 0: every link and verify run names its provider.
select count(*) from public.billing_runs where kind <> 'catalog' and num_nulls(provider, provider_env, provider_account) > 0;
-- Only polar, stripe and managed.
select source, count(*) from public.billing_accounts group by source;
-- 0: no usage priced below zero.
select count(*) from public.billing_usage_events where rate_cents < 0;
-- 0: no Polar event from before the webhook seam waits to apply.
select count(*) from public.provider_events where provider = 'polar' and status = 'received' and not (payload ? 'kind');
```

The last one is the plan's check; reconcile still reads such an event's kind from its name, so a row there only waits for the sweep as any other.

## Know the database functions

| Function | Called by | Does |
| --- | --- | --- |
| `app.billing_code_offers(code)` | The dashboard and the worker | Returns the offer a code unlocks for the business in the transaction: one row per live price. A code that is revoked, expired, used up, bound to another business or already used by this one finds nothing, the same for every reason, except that a code the business used still finds its plan while the business pays for it, which the dashboard then calls the plan it's on. Since `0149`, a subscription a pack's payment replaced no longer counts as paying for it. |
| `app.billing_owner_recipients(business)` | The worker | The active owners to email about billing, with their language and the business's name and time zone |
| `app.business_included_numbers(business)` | The number claim functions | How many numbers the plan in force includes. Since `0148`, while the business holds a live pack and no live subscription the pack didn't replace, the most any live pack includes; a subscription a pack replaced counts as ended. It mirrors `limitsFor` in `packages/domain/src/server/billingPlans.ts` and the prepaid tier in `packages/domain/src/server/usage.ts`, so change them together. |
| `app.list_user_business_plans(user)` | The dashboard, at creating a business, accepting a claim link, claiming a demo and `GET /api/businesses` | Since `0150`, one row for each open business the signed-in account owns (`app.list_user_businesses`): its deployment mode, the billing account's plan, plan code, subscription state, subscription and the subscription a pack replaced, and whether a pack has time left. It decides nothing: the dashboard works out each plan in force as usage does. Another account gets no rows |
| `app.reserve_onboarding_number_claim`, `app.reserve_replacement_number_claim`, `app.reserve_api_number_claim` | The dashboard, and the v1 API | Refuse a cloud business's number claim when its plan includes none |
| `app.list_billing_sweep_work(...)` | The worker's sweep | Which billing events (Polar's, and Stripe's since `0146`), usage rows, checkout requests and, since `0148`, pack checkouts wait, and in which business, so the sweep can queue each in the business's own scope |
| `app.resolve_business_by_phone`, `app.resolve_receptionist_by_phone`, `app.is_closed_business_phone` | Incoming calls and texts | Since `0148`, a number the expiry job scheduled to go back to Twilio because the business's last pack ended (`reclaim_reason` `pack_ended`) finds no business or receptionist and counts as closed, as a canceled business's numbers do. A new pack or a plan clears the reason |

Each runs as its owner (`SECURITY DEFINER`) and checks who is calling.

## Know who reads and writes

- **The worker role** writes every catalog and promo table, as the worker actor (`app.current_actor_type() = 'worker'`). The v1 API runs as that role too (`createWorkerDomainContext`), so the operator's catalog and code requests write the tables directly. It reads the catalog, and each business's redemptions only in that business's scope.
- **The dashboard** (`lobbystack_app`) reads public plans and their prices, the plan its business is on, and every plan its usage counted under. It never reads codes or redemptions; it finds a code's offer through `app.billing_code_offers`, which needs the whole code.
- **The read-only role** reads everything.
- **The packs** (`0148`): the worker writes `billing_pack_plans` and `billing_pack_prices`, which the dashboard, the worker and the read-only role all read, since every pack is on public sale. A business's `billing_pack_checkouts` are read and written by the dashboard and the worker in that business's scope, as its checkout requests are. Only the worker writes `billing_packs` and `billing_pack_draws`: calls reserve minutes through its role, the admin's call webhooks included, and it adds a pack from the provider's payment event and applies refunds, disputes and ends. The dashboard only reads them in the business's scope. `0148` also gave it writes to both, which it never makes; they stay until a later migration takes them back, since the release before `0149` checks for them.
- **No role** may delete a catalog, code, redemption or pack row; a business's packs go only with the business.

`pnpm db:verify-rls` checks these policies with the rest, on every pull request.
