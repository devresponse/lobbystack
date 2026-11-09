---
meta:
  title: Configure Stripe billing
  navLabel: Stripe Billing
  contentType: How-to
  category: Providers
---

<!-- Content plan: Help operators set up a deployment that bills through Stripe instead of Polar. Cover the account, the keys and their permissions, the variables, pnpm billing --stripe, the webhook endpoints, the Dashboard settings and the checks. Goal: a sandbox deployment that sells, bills overage and checks itself. Open questions: Stripe's own names for each restricted key permission, confirmed by the first sandbox run. -->

# Configure Stripe billing

Use this page to bill a new deployment's businesses through Stripe instead of Polar. A deployment bills through one provider, chosen with `BILLING_PROVIDER` when it's set up, and stays with it ([ADR 0010](../adr/0010-billing-provider-per-deployment.md)). With Stripe the operator is the seller: Stripe runs the checkout page, the billing portal, the subscriptions and the invoices, and Stripe Tax works out the taxes, which the operator registers for and files.

**Status:** built on `feature/receptionists` ([Stripe billing](../billing/stripe-history.md)), and switched on on 2026-11-08, once its sandbox scenarios had passed twice in a row with Stripe as the merchant of record. A deployment bills through Stripe with `BILLING_PROVIDER=stripe`: in a sandbox with test keys, and for real with live ones.

## Know what Stripe does here

| What | How |
| --- | --- |
| Selling a plan | A Stripe Checkout page in subscription mode, on the business's own Stripe customer, with Stripe Tax and the billing address |
| Overage | A second subscription per business, monthly and anchored to the 1st (UTC), with three metered prices that bill dollars: the worker sends each usage's price to a money meter |
| Upgrades | **Settings > Plan**, changed at once once Stripe has the payment; a payment the bank wants confirmed shows **Complete payment** |
| Downgrades, cancelling, resuming | **Settings > Plan**, at the renewal; Stripe's billing portal keeps cards, invoices and billing details, with its plan switches and cancelling off |
| Promo plans | A coupon on the plan's own product, and a schedule that ends the promo at the renewal |
| Refunds and disputes | Done in Stripe's Dashboard; the webhook records them on the business's payments |
| Checks | A daily comparison of `billing.json`, the tables and Stripe, and a daily comparison of what was sent with what Stripe's meters hold |

That is Stripe directly, where the operator is the seller. The `stripe` block can make Stripe the merchant of record instead ([below](#sell-with-stripe-as-the-merchant-of-record)).

## Sell with Stripe as the merchant of record

With `managedPayments: true` and `overage: checkout` in the brand's `stripe` block, Stripe's Managed Payments sells the plans: Stripe computes, collects and files the sales tax, VAT and GST in more than 80 countries, and handles fraud, disputes and payment support. Customers buy from Link ("Sold through Link", `LINK.COM*` on their statements) and get its receipts. Stripe charges 3.5% more for it, and reviews the account and the product before turning it on.

| What | Stripe directly | Merchant of record |
| --- | --- | --- |
| Checkout | The plan's price | The plan's price and the three overage prices, with Managed Payments on |
| Overage | A second subscription, invoiced on the 1st | Metered items on the plan subscription, invoiced at its renewal; `billing.ensureOverage` checks they're there |
| Yearly plans | Sold | Not sold: the deployment leaves the file's yearly prices out, which its Polar deployments still sell |
| Usage dates | By the month's end and the grace hours | By the plan's renewal and the grace hours, with usage from before the period the last renewal ended dated now, since its invoice is final; the daily totals check's open period starts at the renewal |
| Plan changes, cancelling | **Settings > Plan**, as on Stripe directly; a renewal schedule keeps the metered items | The same |
| Cards | The portal | The portal or Link; the API can't set a subscription's card |
| Currency | The catalog's | The customer's own abroad: Stripe's Adaptive Pricing can't be turned off, so a transaction can be in another currency than the plans |

A sandbox showed each of these on a paid test subscription ([Stripe billing](../billing/stripe-history.md#merchant-of-record-as-a-second-mode)). A Stripe subscription with Managed Payments starts only from a Checkout page, so its tests start from test checkouts a person pays. Before the first live sale, the brand's website names Link as the seller in its payment terms.

## Set up a Stripe deployment

1. **An account.** A Stripe account for each live deployment, grouped in a Stripe Organization when there are several, and a sandbox for each test deployment (decision 6 of [Stripe billing](../billing/stripe-history.md#know-what-was-decided)). A deployment stays with the account it's first linked to: `pnpm billing` refuses another account or the other mode. Fill in the account's business details, payouts, and Stripe Tax's origin address and registrations, as an accountant advises.
2. **The brand's `stripe` block.** The brand's `billing.json` needs a `stripe` block, added in a pull request and deployed, or `pnpm billing --stripe` refuses the file ([`brands/README.md`](../../brands/README.md#billingjson)). It says how plan changes charge (`upgrade`, `downgrade`), whether the portal may switch plans or cancel (`portalPlanChanges`, `portalCancel`, both false by decision 4), the tax behavior and product tax code (`tax`), the hours Stripe waits before finalizing an invoice with usage (`usageGraceHours`), how overage is sold (`overage`) and who the seller is (`managedPayments`). AlloPlace's and RealInfoBot's files have theirs, with Stripe as the merchant of record: `overage: checkout` and `managedPayments: true`. A change to the block changes the file's hash, so every deployment of the brand then runs `pnpm billing apply` once, Polar ones too. A linked Stripe deployment keeps its `overage` and `managedPayments`: an apply that changes either is refused as `selling_mode_changed`, since Stripe's meters count by customer and a customer with subscriptions of both kinds would pay twice for the same usage.
3. **Two restricted keys.** In the account, **Developers > API keys > Create restricted key** *(name not confirmed)*, make one key for the admin and one for the worker, each with only its permissions (see [the keys](#know-the-keys)). Copy each into your password manager. A secret key (`sk_`) works, but can do anything in the account.
4. **The variables** of [the table below](#know-the-variables) on the admin and the worker. `devops/bootstrap.mjs` does steps 3 and 4 for a deployment whose settings say `BILLING_PROVIDER=stripe`: it asks for the two keys (`STRIPE_ADMIN_KEY` and `STRIPE_WORKER_KEY` in its secrets file), checks that each is of the deployment's mode and that both belong to one account, and writes that account as `STRIPE_ACCOUNT_ID` ([`devops/bootstrap.md`](../../devops/bootstrap.md)).
5. **After the deploy: an operator key and a setup key.** `pnpm billing` reaches the deployment with a platform key, as on Polar ([Selling plans (Stripe)](../deployment/guide/part-3-outside-services.md#selling-plans-stripe), step 5). Make a third restricted key, the setup key, with write access to the catalog objects, and give it to `pnpm billing` as `STRIPE_SETUP_KEY`, or type it when asked.
6. **Set Stripe up from the file:**

   ```sh
   pnpm billing plan  --brand <brand> --stripe sandbox
   pnpm billing apply --brand <brand> --stripe sandbox --railway-file .env.stripe
   ```

   `apply` makes the products, prices, coupons, the three meters with their overage prices, the billing portal's configuration, the webhook endpoint and the meter error destination, then the packs' products and prices ([below](#know-what-apply-makes-for-packs)), then links them in the catalog. `--railway-file` saves `STRIPE_ACCOUNT_ID` for the admin and the worker, and the two signing secrets Stripe shows only once, `STRIPE_WEBHOOK_SECRET` and `STRIPE_METER_WEBHOOK_SECRET`, for the admin. Set them with `node devops/railway-vars.mjs .env.stripe`, then delete the file.
7. **What Stripe's API can't set,** which `plan` and `verify` list, in the Dashboard: the tax registrations and origin address, the grace period of `usageGraceHours` before an invoice with usage is finalized, the retries after a failed payment and what follows the last one, and the branding, support email and statement descriptor that checkout, invoices and the portal show.
8. **Check:** `pnpm billing verify --brand <brand> --stripe sandbox` should end `Result: in sync (exit 0)`. It reads with `STRIPE_READ_KEY`, else the setup key.

## Know what apply makes for packs

For each of the file's [prepaid packs](../../brands/README.md#prepaid-packs), `pnpm billing apply` makes a product of its own and one price on it, after every other object, so a file without packs gets exactly the calls it got before packs existed.

| Object | What it is |
| --- | --- |
| Product | Named as the pack, with the file's tax code, tagged `lobbystack_brand` and `lobbystack_pack` |
| Price | One-time, the pack's price before tax, under the lookup key `lsp_<brand>_<pack>_<currency>_<first 8 of the terms hash>`, tagged with the pack and its terms |

The link records each pack's price, and the billing portal never offers a pack. Stripe never changes a price, so new terms for a pack, such as a new price or allowance, make a new price under a new lookup key: the run archives the old price only with `--allow-archive`, and links the new one only with `--allow-replace`, as for a plan. A price found under a pack's lookup key that bills on a cycle is replaced only with `--allow-replace`. Packs bought through an old price keep their minutes. Verify checks that each linked pack price is live, one-time, on its pack's product and at the row's price.

## Know the keys

Stripe's names for each permission are confirmed by the first sandbox run, so this table names the resources each key uses. None of these keys is a webhook secret, and none of them goes in `billing.json`.

| Key | Where | Needs | Used for |
| --- | --- | --- | --- |
| The admin's `STRIPE_API_KEY` | Railway, on the admin | Write on billing portal sessions, read on customers | **Manage subscription** in **Settings > Plan**, which opens Stripe's billing portal, and finding the business of a charge's customer when a refund or dispute arrives |
| The worker's `STRIPE_API_KEY` | Railway, on the worker | Write on customers (with their balance transactions), Checkout Sessions, subscriptions, subscription schedules, invoices and meter events; read on invoice payments, meters and their event summaries, products, prices, coupons, the billing portal's configurations, and Stripe Tax's settings and registrations | Checkout, the overage subscription, plan changes, cancelling, usage, deletion, the daily checks, and its startup check of the key's account |
| `STRIPE_SETUP_KEY` | The operator's computer, for `pnpm billing apply` | Write on products, prices, coupons, meters, the billing portal's configurations, webhook endpoints and event destinations; read on Stripe Tax | Setting Stripe up from `billing.json` |
| `STRIPE_READ_KEY` | The operator's computer, for `pnpm billing plan` and `verify` | Read on the same, and on subscriptions for `devops/reset-database.mjs` | Checking; never on a service |

The setup and read keys never go on Railway. Make them for the run and delete them afterwards, as with Polar's setup token.

## Know the variables

| Variable | Service | Value |
| --- | --- | --- |
| `BILLING_PROVIDER` | admin and worker | `stripe`. Empty means `polar`; any other value stops the service at startup |
| `STRIPE_API_KEY` | admin and worker, each its own | A restricted key: `rk_test_` in a sandbox, `rk_live_` for real |
| `STRIPE_ACCOUNT_ID` | admin and worker | The keys' account, `acct_...`. The worker checks its key against it at startup, and `pnpm billing` against the setup key |
| `STRIPE_WEBHOOK_SECRET` | admin | The webhook endpoint's signing secret, `whsec_...`; two, comma-separated, while you roll it |
| `STRIPE_METER_WEBHOOK_SECRET` | admin | The meter error destination's signing secret |

A Polar deployment needs none of them, and a Stripe deployment none of `POLAR_*`. On a server, Docker Compose gives the admin and the worker the same `STRIPE_API_KEY` line from `.env`, so there one key holds both sets of permissions. The landing site's build takes `BILLING_PROVIDER` too, so its terms and privacy pages name Stripe as the payment processor.

## Understand the billing flow

1. An owner picks a plan. The worker finds or makes the business's Stripe customer and makes a Checkout page for the plan's price, keyed so a retry within the minute gets the same page.
2. The owner pays. Stripe's events reach `/api/webhooks/stripe`; the admin stores each once, and the worker reads the subscription back before it applies it, so events applied in any order end on Stripe's latest state.
3. Once the plan is live, `billing.ensureOverage` makes the overage subscription. Until it exists, usage stops at the allowance.
4. Usage past the allowance goes to the money meters as its price in dollars, dated by when it happened while its month's invoice can still take it. Stripe invoices the month's overage on the 1st, after the grace period.
5. Each day `billing.checkUsageTotals` compares what was confirmed sent with what the meters hold, and corrects a gap of half a cent or more in the open month, crediting the balance with what the month can't take.
6. A deleted business's plan and overage subscriptions end at once, each with its last invoice.

[Stripe billing](../billing/stripe-history.md) describes each step as it was built, with its tests.

## Know the webhook endpoints

| Endpoint | Signed with | Events |
| --- | --- | --- |
| `/api/webhooks/stripe` | `STRIPE_WEBHOOK_SECRET` | `checkout.session.completed` and `expired`; `customer.subscription.created`, `updated`, `deleted`, `paused`, `resumed`, `pending_update_applied` and `pending_update_expired`; `invoice.paid`, `payment_failed`, `finalized`, `voided` and `marked_uncollectible`; `charge.refunded` and `charge.dispute.created` (`STRIPE_WEBHOOK_EVENTS`) |
| `/api/webhooks/stripe/meter-errors` | `STRIPE_METER_WEBHOOK_SECRET` | The meter error destination's thin events, `v1.billing.meter.error_report_triggered` and `v1.billing.meter.no_meter_found` |

A delivery more than 300 seconds old, or of the other mode, is refused. `/api/webhooks/polar` answers 404 on a Stripe deployment, and logs `ops.billing.webhook_wrong_provider` at most once a minute.

## Check it

- `billing.verifyCatalog` checks the file, the tables and Stripe every day, with the worker's key, and reports drift as `ops.billing.profile_drift` with `provider` `stripe`.
- `billing.checkUsageTotals` reports each gap it corrects as `ops.billing.usage_totals_mismatch`, and a balance credit a customer billed in another currency can't use as `ops.billing.usage_credit_unapplied`, for a refund by hand.
- The worker's startup reports `ops.billing.provider_mismatch` when its key belongs to another account than `STRIPE_ACCOUNT_ID`, and then runs without billing.
- The other signals are in [billing's table](../billing/README.md#watch-billing).
- Certification: `pnpm replacement:webhooks` sends a signed Stripe event to a Stripe deployment, and `pnpm replacement:billing` runs the usage checks on Stripe accounts, with `BILLING_PROVIDER=stripe`, `STRIPE_WEBHOOK_SECRET` and a test `STRIPE_API_KEY` in its environment.

## Run the sandbox scenarios

`pnpm billing:scenarios` (`scripts/billing-scenarios.ts`) runs the scenarios that must pass before live payments against a Stripe sandbox, through LobbyStack's own Stripe adapter, each on a test clock of its own, so a scenario lives through renewals and the 1st's overage invoices in minutes. `--list` lists them:

| Scenario | Checks |
| --- | --- |
| `checkout` | A monthly Starter and a yearly Pro go live, each with its overage subscription anchored on the 1st at 00:00 UTC, and a second try finds the same one |
| `usage` | Usage past the allowance, a resend of one event and a negative correction: the meters hold what was sent, and the 1st's overage invoice comes to it, to the cent before tax |
| `upgrade-paid`, `upgrade-declined`, `upgrade-3ds` | An upgrade with a good card changes the plan at once; a declined card is refused as `payment_failed` and leaves no pending update; a 3-D Secure card waits on the invoice's page |
| `downgrade` | A downgrade waits for the renewal, **Keep my plan** drops it, and a second one takes effect at the renewal |
| `cancel-resume` | Cancel and resume, then a cancelled plan ends at its renewal, and its overage subscription with its month |
| `promo-endings` | A promo plan ends on its tier's price or cancelled at the renewal, and a discount comes off |
| `deletion` | A deleted business's two subscriptions end at once, each with its last invoice, and a retried revoke counts as ended |
| `refund` | A refund of the plan's first payment leads back to its invoice |
| `totals` | A usage event Stripe never got shows as a gap, a numbered correction sent twice closes it once, and a balance credit counts once |
| `events` | Every webhook event of the scenarios' customers normalizes, each to its own business |

1. **A sandbox of its own,** not a deployment's: the run adds the brand's catalog to it, without the webhook endpoint, and archives prices the other selling mode sold. It refuses a sandbox with any webhook endpoint or event destination, which a deployment's apply makes. In it, set Stripe Tax's origin address (**Settings > Tax**) *(name not confirmed)*: every subscription uses automatic tax, and the run stops without it.
2. **Its test secret key** in `STRIPE_SCENARIOS_KEY`. The run refuses a live key and never prints the key.
3. **Run it** from the code folder, after `pnpm install`:

   ```sh
   pnpm billing:scenarios
   pnpm billing:scenarios --only usage,refund
   ```

   It sets the sandbox up from `brands/realinfobot/billing.json`, or the brand `--brand` names, with the recommended `stripe` block while the file has none. Four scenarios run at once (`--parallel`), most of their time a test clock advancing; the whole run takes about 15 minutes *(estimated)*. It ends `All 12 scenarios passed.` (exit 0), or with a `FAIL` line for each that didn't (exit 1); exit 2 means it couldn't start. Each scenario's test clock is deleted at the end, with its customers and subscriptions, unless `--keep`.

The `Billing scenarios` workflow (`.github/workflows/billing-scenarios.yml`) runs the same by hand from GitHub, with the key in the repository secret `STRIPE_SCENARIOS_KEY`, once its file is on the default branch: GitHub lists a manual workflow only from there.

Two limits: the plan subscription is made through the API with Stripe's test cards, not through the Checkout page, which Stripe asks integrations not to script, so the page itself is a check by hand; and deliveries twice and out of order are checked against PostgreSQL in CI (`billing.reconcile`'s order tests), since the run has no deployment to deliver to.

### With Stripe as the merchant of record

`pnpm billing:scenarios --merchant-of-record` runs the scenarios as a brand with `managedPayments` sells, and so does a brand whose `stripe` block sets it. Stripe starts such a subscription only from a Checkout page, so for each one the run makes the checkout through the adapter, prints a line such as `Pay the usage checkout with test card 4242 4242 4242 4242, any future date, any CVC and any address, within 20 minutes: https://checkout.stripe.com/...`, and waits until it's paid. The scenarios run one at a time.

- **Which scenarios:** without `--only`, those whose Stripe calls differ from Stripe directly: `usage` (the plan's renewal invoices the month's usage with the plan's price), `upgrade-paid`, `downgrade` (the renewal keeps the overage prices), `cancel-resume`, `totals` and `events`. That's five checkouts to pay. The others run when named, and `upgrade-3ds` asks for the 3-D Secure test card, 4000 0027 6000 3184. `upgrade-declined` can't run: no API call gives a merchant of record subscription a declining card.
- **Setup:** the sandbox needs no Stripe Tax origin address, since Stripe works out the tax, and yearly prices aren't made. Without the yearly prices the plans' terms differ, so their prices do too: a run in one mode archives the prices the other mode sold in the scenarios' sandbox, and a run in that mode brings them back.
- **Where:** from a computer, with someone to pay the checkouts; the workflow would wait 20 minutes for each.

## Reset a test deployment

`devops/reset-database.mjs` refuses a database linked to Stripe's live mode unless given `--allow-live-payments`. With `STRIPE_READ_KEY` set, it lists the subscriptions Stripe still bills the deployment's customers for, overage subscriptions included, so you can cancel them in the Dashboard first.

## Know what's left

- The checks by hand: the Checkout page in English, French and Spanish, the portal, a 3-D Secure card, receipts with their tax lines, and whether a zero overage invoice is emailed. [The sandbox scenarios](#run-the-sandbox-scenarios) passed twice in a row with Stripe as the merchant of record, the mode both brands use; Stripe directly hasn't run against a sandbox.
- Stripe's names for each key's permissions, from that run.
- The legal pages: with Stripe directly the operator is the seller, so the operator's lawyer reviews the terms' payment clause before live payments; with Stripe as the merchant of record, the payment terms name Link as the seller. The landing's legal pages, which this fork doesn't publish, name only Polar or Stripe.
