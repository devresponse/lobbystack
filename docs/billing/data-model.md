# Know the billing tables

Billing keeps two kinds of rows in PostgreSQL. The catalog belongs to the whole deployment: the plans `billing.json` defines, their prices, the runs that wrote them and the promo codes operators issue. Everything else belongs to one business: its account, checkout requests, usage, monthly totals, payments and Polar's events. This page lists each table, the migrations the fork added, the database functions billing relies on, and who may read and write what. Checked against `main` at `da1f548`.

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
| `voice_rate`, `sms_rate`, `call_rate` | Overage cents per voice minute, text segment and transfer; set exactly when `overage` is |
| `months`, `ends` | How many months a promo plan lasts, and what follows: `tier`, `keep` or `cancel` |
| `offer_end` | No new subscription after this moment |
| `discount`, `polar_disc` | The plan's code-less Polar discount, and its Polar ID |
| `terms_hash`, `frozen_at` | A hash of the terms subscribers depend on, and when the first business took the plan, after which a promo plan's terms can't change |
| `sort`, `run_id`, `retired_at`, `created_at`, `updated_at` | Display order, the run that last changed the row, and its times |

Checks keep the shapes apart: a standard plan has no names and no promo fields, a custom plan is never sold and has no allowances, and a plan has all three overage rates or none.

### `billing_prices`

| Column | Holds |
| --- | --- |
| `plan`, `period` | The plan code, and `monthly` or `annual` |
| `currency`, `cents` | Three lowercase letters, and the price of one period |
| `per_month` | Computed: `cents`, or `cents / 12` for annual |
| `polar_id` | The Polar product that sells it, unique across every plan |
| `run_id`, `retired_at`, `created_at`, `updated_at` | The run that last changed it, and its times |

Each plan has one live price per period, so every live price is in the file's one currency. A currency change retires the old rows before it adds the new ones.

### `billing_runs`

One row per catalog apply (`kind` `catalog`), Polar link (`polar`) and check (`verify`), with its `status` (`applied`, `unchanged`, `failed`, `passed` or `drift`), the brand, the file's version and `hash`, the previous hash, the hash built into the code that ran it (`code_hash`), the normalized file (`profile`), the rows written (`changes`), the drift found (`problems`), the Polar environment and organization, and the operator key, partner, Idempotency-Key and request hash that asked for it. Every run but the worker's daily check was asked for by an operator key with an Idempotency-Key, and one key can't run two requests under the same Idempotency-Key. `started_at` is kept to the millisecond, since the API's cursor carries it.

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

## Know the business tables

Every one has a `business_id` and policies that keep each business to its own rows.

| Table | Holds |
| --- | --- |
| `billing_accounts` | One row per business: `billing_key` (`business:<business ID>`, which usage and the portal use), the Polar `customer_id` and `subscription_id`, `plan` (the tier), `billing_interval`, `subscription_state`, the current period, `overage_spending_cap_cents`, and the columns below |
| `billing_checkout_requests` | Each checkout or plan change asked for: who asked, the target plan and interval, `status` (`pending`, `processing`, `ready`, `changed`, `error`, or `canceled` when the business moved to a managed plan), Polar's checkout ID and URL, the error, and `plan_code`, `code_id` and `billing_email` |
| `billing_usage_events` | Each use: `source_key` (unique), `usage_kind` (`voice_seconds`, `alert_sms_segments`, `outbound_call_attempts` or `chat_ai_tokens`), `quantity` and `billable_quantity`, the plan, plan code and interval it was used under, `is_final`, `sync_status` (`pending`, `synced` or `skipped`), and the sync columns below |
| `billing_usage_months` | Each business's monthly totals and blocked flags, and its overage spend |
| `billing_transactions` | Polar's orders and refunds: amount, refunded amount, currency, invoice URL and the Polar IDs |
| `provider_events` | Each Polar webhook event, stored once by its ID, with its `status` (`received` until the worker applies it) |
| `unit_economics_rollups` | What each business cost each month in provider, AI and hosting fees, in US dollars |

The columns the fork added to them:

| Column | Added in | Holds |
| --- | --- | --- |
| `billing_accounts.plan_code` | `0109` | The exact plan when it isn't its tier's standard plan; `plan` stays the tier |
| `billing_accounts.plan_ends`, `code_id` | `0109` | When a time-limited plan ends, and the code the business subscribed with |
| `billing_accounts.end_with`, `end_notice_at`, `end_set_at` | `0111` | An operator's early ending (`tier` or `cancel`), when the owners were emailed, and when Polar was told |
| `billing_accounts.subscription_claim`, `subscription_claimed_until` | `0116` | The worker run changing the Polar subscription, and when its claim runs out, so two changes never overlap |
| `billing_checkout_requests.plan_code`, `code_id` | `0109` | The plan and code a promo checkout sells |
| `billing_checkout_requests.billing_email` | `0115` | The email a business's new Polar customer gets when another customer has the requester's |
| `billing_usage_events.plan_code_at_record_time` | `0110` | The promo plan the use counted under, so a month that moves onto or off one prices each event on its own terms |
| `billing_usage_events.synced_quantity`, `sync_seq`, `sending_quantity` | `0116` | What Polar has, the number of the next event to send (`source_key`, then `source_key:<n>`), and the difference being sent |

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

They only add tables, columns, indexes and functions, so rolling back one release leaves the database usable. `0113` fills `billing_code_redemptions` only when the migration signs in as a role that bypasses row-level security, such as `postgres`: its log says `Promo codes: <n> uses by a business recorded.`, or `Skipping the promo code redemption backfill` when it couldn't.

## Know the database functions

| Function | Called by | Does |
| --- | --- | --- |
| `app.billing_code_offers(code)` | The dashboard and the worker | Returns the offer a code unlocks for the business in the transaction: one row per live price. A code that is revoked, expired, used up, bound to another business or already used by this one finds nothing, the same for every reason. |
| `app.billing_owner_recipients(business)` | The worker | The active owners to email about billing, with their language and the business's name and time zone |
| `app.business_included_numbers(business)` | The number claim functions | How many numbers the plan in force includes. It mirrors `limitsFor` in `packages/domain/src/server/billingPlans.ts`, so change both together. |
| `app.reserve_onboarding_number_claim`, `app.reserve_replacement_number_claim`, `app.reserve_api_number_claim` | The dashboard, and the v1 API | Refuse a cloud business's number claim when its plan includes none |
| `app.list_billing_sweep_work(...)` | The worker's sweep | Which Polar events, usage rows and checkout requests wait, and in which business, so the sweep can queue each in the business's own scope |

Each runs as its owner (`SECURITY DEFINER`) and checks who is calling.

## Know who reads and writes

- **The worker role** writes every catalog and promo table, as the worker actor (`app.current_actor_type() = 'worker'`). The v1 API runs as that role too (`createWorkerDomainContext`), so the operator's catalog and code requests write the tables directly. It reads the catalog, and each business's redemptions only in that business's scope.
- **The dashboard** (`lobbystack_app`) reads public plans and their prices, the plan its business is on, and every plan its usage counted under. It never reads codes or redemptions; it finds a code's offer through `app.billing_code_offers`, which needs the whole code.
- **The read-only role** reads everything.
- **No role** may delete a catalog, code or redemption row.

`pnpm db:verify-rls` checks these policies with the rest, on every pull request.
