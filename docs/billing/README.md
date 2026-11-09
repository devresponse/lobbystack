# Bill businesses for plans and usage

A business on a cloud deployment pays a monthly or yearly price for Starter or Pro, plus a small charge for each minute, text or call transfer past what its plan includes. The deployment's payment provider, Polar or Stripe, collects the money; LobbyStack tells it what each business used. This page says who pays, what the plans are, how the money moves, how an operator runs billing, and what to watch. Checked against `main` at `da1f548`, and made provider-neutral on 2026-11-08 for step 17 of [Stripe billing](stripe-history.md), on `feature/receptionists`.

The other billing pages:

- [Polar billing](../providers/polar.md): the Polar settings, tokens, routes, retries and checks, for whoever sets Polar up.
- [Stripe billing](../providers/stripe.md): the same for a deployment that bills through Stripe.
- [`brands/README.md`](../../brands/README.md#billingjson): how to write a brand's `billing.json`, its promo plans and its codes.
- [Data model](data-model.md): the billing tables, columns and migrations.
- [Design history](design-history.md): the options weighed, the ten steps, the two reviews and the decisions.
- [Stripe billing's history](stripe-history.md): the nineteen steps that added Stripe beside Polar, merchant of record as a second mode, the review and the technical debt left.
- [Selling plans (Polar)](../deployment/guide/part-3-outside-services.md#selling-plans-polar) and [Selling plans (Stripe)](../deployment/guide/part-3-outside-services.md#selling-plans-stripe) in the deployment guide: setting a provider up for a new instance, step by step.

## Know who pays

- **Cloud businesses only.** The admin stamps each new business with the deployment's `DEPLOYMENT_MODE` when it is created (`businesses.deployment_mode`). A business made on `cloud` starts on the Free plan and can buy Starter or Pro; one made on `self_hosted_standard` or `development` gets the self-hosted plan, with no limits and no billing. Existing businesses keep their stamp when the variable changes, and nothing in the dashboard or the API changes it.
- **Enterprise is billed by hand.** An operator puts a business on it with `pnpm lobbystack billing managed-plan`, which unlocks what a paid plan unlocks outside the billing provider, and takes it off with `end-managed-plan`.
- **One provider per deployment.** `BILLING_PROVIDER` picks Polar, the default, or Stripe when a deployment is set up, and the deployment keeps it ([ADR 0010](../adr/0010-billing-provider-per-deployment.md)). Polar is the merchant of record and handles sales tax. With Stripe the operator is the seller and collects the taxes with Stripe Tax ([Stripe billing](../providers/stripe.md)). Stripe has the same two worlds as Polar: a sandbox, with test keys, and an account's live mode, and a deployment stays with the account and mode it's first linked to.
- **Polar has two separate worlds.** The sandbox (`https://sandbox-api.polar.sh`) takes test cards and moves no money; the demo is set up there. A live organization takes real payments after Polar's review, which can take up to 14 days, and gets a deployment of its own: a deployment stays with the one Polar organization it was first linked to.

## Know the plans

AlloPlace's plans, from [`brands/alloplace/billing.json`](../../brands/alloplace/billing.json), in Canadian dollars:

| Plan | Monthly | Yearly | Voice minutes | Alert text segments | Call transfers | Website chats | Knowledge storage | Phone numbers | Receptionists | Past the allowance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Free (`free_cloud`) | $0 | $0 | 30 | 10 | 2 | 5 | 1 MB | 0 | 1 | Refused, not billed |
| Starter | $37 | $370 | 150 | 50 | 20 | 50 | 5 MB | 1 | 1 | $0.20 a minute, $0.02 a segment or transfer |
| Pro | $87 | $870 | 500 | 200 | 100 | 200 | 20 MB | 1 | 5 | $0.18 a minute, $0.02 a segment or transfer |
| Enterprise | Custom | Custom | Custom | Custom | Custom | Custom | Custom | Custom | Up to 50 | Billed by hand |

- Allowances reset on the first of each month (UTC), on monthly and yearly subscriptions alike, whatever day the subscription renews.
- Calls shorter than 10 seconds (`MIN_BILLABLE_VOICE_DURATION_SECONDS`) and calls ended as spam aren't counted.
- A website chat counts once per conversation. On a paid plan, chats past the allowance are never billed, since no provider meters them; on Free they stop.
- A paid plan can have a monthly spending cap on its overage, set in **Settings > Plan** or with `pnpm lobbystack billing cap`. Since fork PR #68 the cap refuses only usage that itself pushes spend past it, so included minutes always work and website chats never stop.
- A plan includes at most one phone number (fork PR #70), and a phone number claim counts the numbers the plan includes (fork PR #66): Free can't claim one.
- Receptionists (fork PR #129) count active ones, the default included: `limits.receptionists` in `billing.json`, 1 on Free and Starter and 5 on Pro. Enterprise and other custom plans get the deployment's cap, `MAX_RECEPTIONISTS_PER_BUSINESS` (50 unless set), which also caps the receptionists any business keeps, archived ones aside. When a plan change leaves more active receptionists than the new plan includes, the worker pauses the newest extra ones; nothing is deleted ([receptionists](../features/receptionists.md#know-how-many-a-plan-includes)). A plan that has had subscribers can't include fewer ([promo plans](#sell-promo-codes-and-promo-plans)). The plan screens show each plan's number after its voice minutes, and Enterprise's as custom.
- Promo plans, sold only through codes, can carry their own allowances, storage and overage rates in place of their tier's. Their data retention and features stay the tier's.
- The plan screens and the plans API show a yearly price as what it comes to a month: the price over twelve months, rounded to the nearest whole dollar, so Starter shows CA$31 and Pro CA$73 a month (fork PR #89). The provider charges the yearly price itself. The **Annual** tab says **Get 2 months for free!** when every plan's year costs a whole number of months, as AlloPlace's cost ten; otherwise it says the percent saved, such as the built-in plans' **Save 20%**.

Until `pnpm billing apply` has run on a deployment, the dashboard shows and enforces the four standard plans of its brand's `billing.json` as the build carries them, in the file's currency, so AlloPlace shows the table above from its first start (fork PR #88). On Polar it sells them only through the four `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variables, if they are set; on Stripe it sells nothing before the first apply. A brand without a file, such as LobbyStack, gets the code's built-in plans: the same allowances and rates, in US dollars, at $30 and $100 a month or $288 and $960 a year.

## Follow the money

1. An owner or admin picks a plan in onboarding or **Settings > Plan**. The admin records a checkout request and queues `billing.createCheckout`.
2. The worker finds or makes the business's own customer at the provider (fork PR #72) and asks it for a checkout page for the product or price the catalog links to the plan and interval. A business that already pays gets no page: the worker changes its subscription in place (fork PR #60), charging the difference as `billing.json` says. On Polar, moving down to Starter happens in Polar's billing portal; on Stripe, **Settings > Plan** moves it down at the renewal.
3. The owner pays on the provider's page. The provider sends its events to `/api/webhooks/polar` or `/api/webhooks/stripe`; the admin stores each once and queues `billing.reconcile`, and the worker moves the business onto the plan. On Stripe it reads the subscription back first, so events applied in any order end on Stripe's latest state.
4. As calls, texts and transfers happen, the worker records usage and sends the part past the month's allowance: to Polar as `billing.voice_minutes`, `billing.alert_sms_segments` and `billing.outbound_call_attempts` events, and to Stripe as its price, to one money meter per kind. A later correction, such as a text that Twilio settles on more segments, goes as an event for the difference (fork PR #75).
5. The provider invoices the overage every month. Polar's meters add the events up, with the renewal on a monthly plan and as a usage invoice of its own on a yearly plan, whose product has a monthly meter cycle (fork PR #73); no product carries Polar Credits (fork PR #69). On Stripe, a second subscription per business, monthly and anchored to the 1st, invoices the meters, and a daily check compares them with what was sent.
6. Owners manage cards and invoices in the provider's portal, which **Manage subscription** in **Settings > Plan** opens. Polar's portal also changes plans and cancels; on Stripe, **Settings > Plan** does.

[Polar billing](../providers/polar.md#understand-the-billing-flow) and [Stripe billing](../providers/stripe.md#understand-the-billing-flow) follow the same flow with every retry and time limit.

## Know where the plans live

The plans live in one reviewed file, and one command makes the database and the provider match it:

1. `brands/<brand>/billing.json` holds the plans: prices in one currency, allowances, limits, overage rates, promo plans, the prepaid packs ([`brands/README.md`](../../brands/README.md#prepaid-packs)), and the settings of the billing provider its deployments use: four Polar settings in `polar`, and how Stripe sells in `stripe`, which no brand has yet ([Stripe billing](../providers/stripe.md)). `brands/billing.schema.json` checks it as you type, and `pnpm brands:build` checks the rest and writes its hash and its four standard plans into the code, so a deployment knows which file it was built with and shows that file's plans until its first apply. Codes never go in the file, since the repository is public.
2. `pnpm billing apply` writes the file to the catalog tables (`billing_plans`, `billing_prices`, `billing_runs`, and for the packs `billing_pack_plans` and `billing_pack_prices`), makes the provider's organization or account sell what it says, records which product or price there sells each price, and checks the three against each other. A pack's provider objects are made after everything else: a one-time price on Stripe, a private one-time product on Polar. A file without packs leaves the pack tables as they are and makes no pack object.
3. Once the file is applied, the plan screens (fork PR #61), allowances, rates, storage and number limits (fork PRs #62 and #66) read the catalog, in its currency. Once a link makes a plan active, checkout, plan changes and the webhook use the provider's products or prices it links, and so do promo codes and promo plans (fork PRs #63 to #65). A change to the allowances or rates counts for the whole current month. A pack is on sale once a link makes it active, and new terms take it off sale until the next link; once bought, its minutes and length can't change.
4. The worker checks the file, the tables and the provider once a day (`billing.verifyCatalog`).

**Don't change the prices, rates or allowances of a plan people already pay for. Add a new plan instead.** LobbyStack applies new terms to every subscriber at once, while the provider keeps each subscriber on the prices they bought, so the usage screens and the spending cap would stop matching its invoices. This is the one finding of the 2026-10-23 billing pass left open as a rule.

## Run billing from the command line

Every billing change follows the same four moves: change `billing.json` in a pull request, merge and deploy it, preview the change, then apply it. The commands run from a checkout of the fork on an operator's computer.

### Get the keys

| Item | Where it comes from | Used by |
| --- | --- | --- |
| Operator key | `pnpm platform-key:create --access all`, then added to the admin's `PLATFORM_API_KEYS` ([7.19](../deployment/guide/part-7-operations.md#719-manage-operators-api-keys-and-platform-keys)) | `pnpm billing` and `pnpm lobbystack billing ...` |
| `POLAR_SETUP_TOKEN` | Polar, **Settings > Developers**, in the deployment's organization: write access to organizations, meters, products, discounts and webhooks | `pnpm billing apply` |
| `POLAR_READ_TOKEN` | The same place, with read access to the same five | `pnpm billing plan` and `verify`; the setup token works too |
| The worker's `POLAR_ACCESS_TOKEN` | A token of its own: `checkouts:write`, `customers:write`, `events:write`, `subscriptions:write`, `organizations:read`, `meters:read`, `products:read` and `discounts:read` | Checkout, plan changes, usage and the daily check |
| The admin's `POLAR_ACCESS_TOKEN` | Another token, with only `customer_sessions:write` (fork PR #74) | The billing portal |
| `STRIPE_SETUP_KEY` | On Stripe: a restricted key with write access to the catalog objects ([the list](../providers/stripe.md#know-the-keys)) | `pnpm billing apply --stripe` |
| `STRIPE_READ_KEY` | A restricted key that reads the same | `pnpm billing plan` and `verify`; the setup key works too |
| The worker's and the admin's `STRIPE_API_KEY` | A restricted key each, with only what each service does | As Polar's two tokens |

Give no service token `webhooks:read`: Polar lists each webhook with its signing secret, and whoever has the secret can put any business on any plan. For the same reason the setup and read tokens never go on Railway; make them with the shortest end date Polar offers and delete them after use. The commands never save or print a token or key, and ask for a missing one with typing hidden. On Stripe the keys' permissions are by resource, listed in [Stripe billing](../providers/stripe.md#know-the-keys).

### Sign in, preview, apply and check

```bash
# Once per computer. Paste the operator key, then press Ctrl-D; it stays out of the shell history.
pnpm lobbystack login --url https://<dashboard domain> --key-stdin --profile ops
pnpm lobbystack --profile ops billing catalog          # plans, prices and their provider links

# Shows what an apply would change, and changes nothing.
pnpm billing plan   --brand alloplace --polar sandbox --profile ops

# Applies the file to the tables, makes the provider match, links them, then checks all three.
pnpm billing apply  --brand alloplace --polar sandbox --profile ops --railway-file .env.railway

# Checks the file, the tables and the provider against each other.
pnpm billing verify --brand alloplace --polar sandbox --profile ops
```

A deployment that bills through Stripe takes `--stripe sandbox|live` in place of `--polar`, with `STRIPE_SETUP_KEY` and `STRIPE_READ_KEY` in place of Polar's tokens, and every flag but `--adopt` ([Stripe billing](../providers/stripe.md)).

`plan` and `verify` take `--json` for scripts. `apply` asks before it changes anything; `--yes` skips the question. A run that stops part-way is finished by running it again: everything is found again by its `lobbystack_*` tags in Polar, or its lookup key and metadata in Stripe, and the webhook by its address.

| Exit code | Means |
| --- | --- |
| 0 | In sync, or a plan with nothing refused |
| 1 | Drift, a refusal that stopped the run before it changed anything, or an apply you didn't confirm |
| 2 | A wrong command, a side that couldn't be read, or a write that failed |

Flags that need a person's say:

| Flag | Use it for |
| --- | --- |
| `--adopt` | The first run on an organization set up before `pnpm billing` existed, such as with `polar-setup.mjs`: it tags the existing meters and monthly products and keeps their IDs. |
| `--allow-replace` | Changes Polar can't make in place, such as a product's billing or meter cycle. It makes a new product and archives the old one, whose subscribers stay on it. An organization whose annual products were made before fork PR #73 needs it once. It hasn't been tried on an organization with subscribers, so try it on the sandbox first. |
| `--allow-archive` | Archiving a product or discount the file no longer has. |
| `--allow-undeployed` | Trying a file the deployment wasn't built with, on a sandbox. |
| `--webhook-url <url>` | A webhook address other than the deployment's own `/api/webhooks/polar` or `/api/webhooks/stripe`. |
| `--railway-file <new file>` | Saving `POLAR_API_BASE_URL`, `POLAR_ORGANIZATION_ID` and, when the run made the webhook, `POLAR_WEBHOOK_SECRET` to a new file readable only by you; on Stripe, `STRIPE_ACCOUNT_ID`, and the `STRIPE_WEBHOOK_SECRET` and `STRIPE_METER_WEBHOOK_SECRET` Stripe shows once. A name like `.env.railway` keeps it out of commits. Delete it once the values are set. |

The file's format is the input of `devops/railway-vars.mjs`; setting the values in Railway by hand works the same. Current subscribers keep their old price, and edits made by hand in the provider's dashboard are put back to match the file.

### Use the other billing commands

`pnpm lobbystack billing` takes these. `status`, `plans`, `cap`, `checkout`, `checkout-status`, `cancel`, `resume`, `keep-plan` and `change-status` work with a business API key that has `billing:manage`; the rest need an operator key.

| Command | Does |
| --- | --- |
| `status` | One business's plan, usage, spending cap, promo plan and when it ends |
| `plans` | The plans the business can buy, with what each includes, its receptionists among it, and their prices |
| `cap <cents>` | Sets the spending cap on a paid plan's overage |
| `checkout`, `checkout-status <id>` | Starts a checkout and prints the page to send whoever pays, or says the existing subscription moved |
| `cancel`, `resume`, `keep-plan`, `change-status <id>` | On Stripe, ends the plan at its renewal, undoes that, or drops a change waiting for the renewal; Polar does these in its billing portal |
| `managed-plan`, `end-managed-plan` | Puts a business on Enterprise outside the billing provider, and takes it off |
| `end-promo-plan` | Ends a business's promo plan at its next renewal; its owners get an email |
| `catalog` | The applied file, plans, prices and links |
| `catalog-preview <brand>`, `catalog-apply <brand>` | Preview or apply a `billing.json` to the tables only; `pnpm billing apply` does both sides |
| `catalog-link <brand>` | Records which provider objects sell the catalog, Polar's products and discounts or Stripe's prices and coupons; `pnpm billing apply` sends it |
| `catalog-runs --kind catalog\|polar\|link\|verify` | Past applies, links and daily checks (`link`: every provider's links) |
| `code-create <plan>`, `codes`, `code-revoke <id>` | Issue, list and revoke promo codes |

## Sell promo codes and promo plans

A plan whose `access` is `code` in `billing.json` is sold only to a business that enters one of its codes. It can carry a discount for some months, its own allowances, and what happens when its months run out. [`brands/README.md`](../../brands/README.md#promo-codes) shows the file's side.

1. Add the plan to `billing.json` in a pull request, deploy it and run `pnpm billing apply`, which makes its private product and its discount, a coupon on Stripe.
2. Issue codes with an operator key: `pnpm lobbystack billing code-create <plan> --business-id <id>` for one business, or `--max-uses <n> --expires-at <time>` for a shared code. The command prints a link, `/signup?promo=<code>`, which survives sign-up; a signed-in owner lands on **Settings > Plan**.
3. The business enters the code under **Have a promo code?** and buys the plan's own product at its discount. It uses each code once (fork PR #70).
4. A plan with a set number of months ends at the first renewal after they run out. A week before, the worker emails the owners in their language and tells the provider to move the subscription to its tier's standard product or price, or to cancel it, at the renewal (fork PR #65; on Stripe, through a subscription schedule). On Polar, switching plans in its portal leaves the promo plan, and the worker removes its discount.

**A promo plan freezes when its first business takes it.** From then on an apply refuses to change its terms, directly or through the tier it inherits from, and to lower its receptionists the same way (`plan_frozen`), so the businesses on it keep what they bought: put new terms or a lower number under a new code, or write what it inherits into its entry. Its names, access and offer end can still change, it can include more receptionists, and it can be retired. Standard plans never freeze (fork PR #134).

Code tries are limited each hour: 10 per business, 20 per person, 20 per IP address, and 20 per API key, OAuth grant or platform key across the businesses it reaches. Use generated codes for shared ones, never guessable words, and expect no Promotions screen: codes are issued from the command line and sent by hand.

## Know the limits and refusals

| Limit | Value | Over it |
| --- | --- | --- |
| Checkouts | 10 an hour per business, 20 per person across businesses (fork PR #74) | 429 `billing_rate_limited` |
| Billing portal sessions | 20 an hour per business, 40 per person | 429 `billing_rate_limited` |
| Plan changes | One request at a time per paying business (fork PR #75) | 409 `plan_change_pending`, or `conflict` from the v1 API |
| Redis down while counting | | 503 `billing_limit_unavailable` |
| A checkout request | 15 minutes to run; a run that died is taken over after 5 | Fails, and the owner asks again |

Polar's request budget is the whole organization's, and past it Polar refuses every call, payments and usage included, which is why checkouts and the portal are limited. The same limits apply on Stripe. Asking again for the same plan, interval and billing email while a request is still open returns that request and counts nothing.

## Know what runs on its own

| Job | When | Does |
| --- | --- | --- |
| `billing.createCheckout` | Each checkout request | Finds or makes the business's customer at the provider, then makes the checkout or changes the subscription |
| `billing.reconcile` | Each stored provider event | Applies subscription and payment events in the order the provider changed each subscription; on Stripe, after reading the subscription back |
| `billing.syncUsage` | Each final usage row | Sends the provider the billable part, numbered so it takes each event once: Polar the units, Stripe their price, to a money meter |
| `billing.sweep` | Every 5 minutes | Queues again a provider event, usage or checkout request a job left behind, at most once an hour each, and reports work older than an hour (fork PR #71) |
| `billing.verifyCatalog` | Daily | Compares the file, the tables and the provider; leaves out the webhook, which `pnpm billing verify` checks |
| `billing.endPromoPlan` | Daily, per business | Ends promo plans whose months ran out, a week ahead |
| `billing.checkUsageTotals` | Daily, per business | Stripe only: compares what was sent with what Stripe's meters hold, and corrects a gap in the open month, crediting what the month can't take |
| `billing.revokeSubscription` | Each delete of a business that pays | Ends its subscription at the provider at once and marks it canceled, so the delete can go ahead (fork PR #101, [delete a business](../features/business-deletion.md)); tries 12 times over about 3 hours, and the delete asks again every 10 minutes. On Stripe, its overage subscription ends too, with its usage invoiced |
| `billing.changeSubscription` | Each Cancel plan, Resume or Keep my plan | Stripe only (Stripe billing's step 15): asks Stripe to end the plan at its renewal, undo that, or drop a change waiting for the renewal |
| `billing.ensureOverage` | A Stripe plan event that needs it | Stripe only (Stripe billing's step 13): gives a live plan its overage subscription, anchored on the 1st, and once the plan has ended, ends it with its month |
| `billing.refreshUnitEconomics` | Hourly, per business | Adds up what the business cost this month in provider, AI and hosting fees (`unit_economics_rollups`) |

`billing.reconcile` and `billing.syncUsage` try 12 times over about 3 hours before the sweep takes over, so nothing needs requeueing by hand. A deleted business's billing account, usage and transactions go with it, so the finance export no longer lists them; the provider keeps the customer and its orders or invoices.

## Watch billing

| Signal | Sent as | Means | Suggested alert |
| --- | --- | --- | --- |
| `ops.billing.profile_drift` | PostHog event from the worker | The daily check found the file, tables and provider disagreeing, or couldn't read the provider. It names the deployment's `provider` and `providerEnv` (`sandbox` or `live`), and on Polar its `polarEnv` | Any in a day |
| `ops.billing.profile_drift_recovered` | PostHog event from the worker | The first clean check after drift | None; it closes the drift alert |
| `ops.billing.usage_sync_failed` | PostHog event from the worker | Usage couldn't reach the provider, so a business may be undercharged | Any in an hour |
| "Billing work waited longer than it should." | Error tracking, from the worker, and the `lobbystack.billing.overdue_work` counter | A provider event or usage waited over an hour, or a checkout request failed for waiting | Any ([BillingWorkOverdue](../operations/alerts.md#billingworkoverdue)) |
| "A live Polar subscription is for a product no plan maps to", or on Stripe "A live Stripe subscription is for a price no plan maps to" | Error tracking, from the worker | A subscription to a product or price the catalog doesn't link, such as one made by hand in the provider's dashboard; the business keeps its plan until it's linked | Any |
| "The worker's Polar token can't read or make customers" | Warning in error tracking, from the worker | The worker's token lacks `customers:write`, so Polar picks a checkout's customer by email | Any |
| `ops.billing.webhook_refused` | Warning log line from the admin | A provider's delivery was refused (`unconfigured`, `missing_headers` or `bad_signature`, and on Stripe `too_old` or `wrong_mode`). Polar turns the webhook off after 10 failures in a row | 3 or more in an hour |
| `ops.billing.webhook_unresolved` | Error log line from the admin | A provider's event matched no business, so a subscription may never have applied | Any |
| `ops.billing.webhook_customer_mismatch` | Warning log line from the admin | A subscription came on another business's Polar customer; it still goes to the business that bought it | Any |
| `ops.billing.webhook_wrong_provider` | Warning log line from the admin, at most once a minute | A delivery reached the route of the provider the deployment doesn't bill through, such as from an endpoint left in that provider's dashboard; answered 404 | Any in a day |
| `ops.billing.meter_error` | Warning log line from the admin | Stripe couldn't use a meter event, so that usage isn't billed until the daily totals check corrects it (Stripe billing's step 16) | Any |
| `ops.billing.overage_missing` | PostHog event from the worker, and a warning log line | A live Stripe plan still has no overage subscription an hour into its period, so usage past the allowance waits; the job's error says why | Any |
| `ops.billing.overage_unpaid` | PostHog event from the worker, and a warning log line | Stripe ended a live plan's overage subscription after failed payments or a dispute, or left it unpaid. Usage stops at the allowance until its invoice is paid, voided or marked uncollectible in Stripe; that invoice's event then makes a new one, or records the old one again once Stripe makes it live again | Any |
| `ops.billing.provider_mismatch` | PostHog event from the worker, and an error log line, at startup | `STRIPE_API_KEY` belongs to another account than `STRIPE_ACCOUNT_ID`, so the worker runs without billing | Any |
| `ops.billing.account_unchecked` | Warning log line from the worker, at startup | Stripe couldn't be reached to check the key's account; the worker bills on | None |
| `ops.billing.usage_totals_mismatch` | PostHog event from the worker, and a warning log line | The daily totals check found Stripe's meters off what was sent, by `kind` and `gapCents`, and corrected the open month | Any in a day |
| `ops.billing.usage_credit_unapplied` | PostHog event from the worker, and a warning log line | The daily totals check credited `cents` in the catalog's `currency` to a customer billed in their own (`customerCurrency`), as merchant of record bills customers abroad: the credit won't reach their invoices, so refund them that much in their currency in Stripe's Dashboard | Any |
| `ops.billing.plan_change_expired` | Warning log line from the worker | A Stripe upgrade waited a day for a payment the bank wanted confirmed, and Stripe dropped it; the business sees the change fail | None |
| `ops.billing.sweep` | Log line from the worker | What each sweep that found work queued again | None |

Log lines reach PostHog only once the `OTEL_EXPORTER_OTLP_*` variables are set ([observability](../features/observability.md)). The daily checks' history is also on the deployment: `pnpm lobbystack --profile ops billing catalog-runs --kind verify`.

## Find the code

| Part | Where |
| --- | --- |
| The plans and packs file and its schema | `brands/<brand>/billing.json`, `brands/billing.schema.json`, `packages/shared/src/billingProfile.ts` |
| Plan list, limits and what a business can buy | `packages/domain/src/server/billingPlans.ts`, `billingAccess.ts`, `packages/shared/src/billing.ts` |
| Usage, allowances and the spending cap | `packages/domain/src/server/usage.ts` |
| The billing provider interface, with Polar and Stripe behind it | `packages/providers/src/billing/` (`types.ts`, `errors.ts`, `factory.ts`, `usage.ts`), `packages/providers/src/polar/adapter.ts`, `packages/providers/src/stripe/adapter.ts` ([ADR 0010](../adr/0010-billing-provider-per-deployment.md)) |
| Checkout, reconcile and plan changes | `packages/domain/src/server/billing.ts`, `packages/providers/src/polar/polarBilling.ts`, `packages/providers/src/polar/webhook.ts` |
| Stripe | `packages/providers/src/stripe/`: the client and adapter, `checkout.ts`, `overage.ts`, `planChange.ts`, `cancel.ts`, `usage.ts`, `events.ts`, `catalog.ts` and the in-memory Stripe in `fake/`; `packages/domain/src/server/billingSubscription.ts` and `billingUsageTotals.ts` ([Stripe billing](../providers/stripe.md)) |
| Deployment tooling | `devops/bootstrap.mjs` (`BILLING_PROVIDER`, the `stripe.keys` step), `devops/reset-database.mjs`, `scripts/billing.ts`, `scripts/replacement-billing-check.ts` and `replacement-webhook-check.ts`, and the landing site's legal pages, which name the provider (`apps/landing/src/lib/legal/`) |
| Catalog of plans and packs, provider setup and the daily check | `packages/domain/src/server/billingCatalog.ts`, `billingPolar.ts`, `billingStripe.ts` (Stripe's planner, which pnpm billing runs from step 11 of the Stripe plan), `billingVerify.ts`, `billingProvider.ts` (the planner for the deployment's provider), `packages/providers/src/polar/polarCatalog.ts` and `packages/providers/src/stripe/catalog.ts` (the catalog clients, which run a plan's calls), `scripts/billing.ts` |
| Promo codes and endings | `packages/domain/src/server/billingCodes.ts`, `billingPromoEnd.ts`, `packages/shared/src/billingCodes.ts` |
| The sweep | `packages/domain/src/server/billingSweep.ts` |
| Dashboard routes | `apps/admin/app/api/billing/` (plan, `checkout`, `portal`, `promo`), `apps/admin/app/api/webhooks/polar/route.ts`, `stripe/route.ts` and `stripe/meter-errors/route.ts` with the shared `apps/admin/src/lib/billing-webhook.ts`, `apps/admin/src/lib/billing-limit.ts` |
| Worker jobs and schedules | `apps/worker/src/billing/`, one file per flow, and `apps/worker/src/scheduler.ts` |
| Tables | Migrations `0108` to `0116`, `0146` for the provider-neutral columns, and `0148` for the prepaid packs, in `packages/db/migrations/` ([data model](data-model.md)) |

## Know the known problems

- **Changing a sold plan's terms** makes the usage screens and the cap disagree with the provider's invoices. Add a new plan instead.
- **Stripe billing hasn't run against Stripe.** Every Stripe flow has run only against the in-memory Stripe; step 18 of [Stripe billing](stripe-history.md) runs them on a sandbox before Stripe is switched on.
- **Nothing has been tried against Polar since fork PR #59.** Upgrades, per-business customers, promo codes, promo endings and the monthly invoicing of yearly plans have been tested only against a stand-in built from Polar's code. Try a checkout, an upgrade, a code and the portal on the sandbox, and compare Polar's invoices with **Settings > Usage**.
- **Before the first apply** the dashboard shows the brand's file as the build carries it, so an edit to `billing.json` shows only after `pnpm brands:build` and a new build. A phone number claim still counts the code's numbers until then (none on Free, one on Starter and Pro), which AlloPlace's file matches, and a `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variable's product charges whatever Polar has for it, whatever the screens say.
- **Yearly products made before fork PR #73** invoice their overage once a year until `pnpm billing apply` runs once with `--allow-replace`, and the daily check reports them as drift until then. Their current subscribers stay on them.
- **Allowances reset on the first of the month (UTC), not at renewal.** After a mid-month downgrade or a promo plan's end, the month's earlier usage counts against the smaller allowance. Whether to keep this is undecided ([open items](../project/open-items.md)).
- **A promo plan with an annual price** would get its months of discount on the whole first year, because Polar checks a repeating discount against the start of the period it bills. No such plan exists.
- **Leftovers from the 2026-10-23 review:** alert texts sent before fork PR #67 never reached Polar's meter, and aren't backfilled; a promo discount left by a switch in Polar's portal stays if the worker's token lacks `subscriptions:write`, after one warning; the worker marks a plan change done when the product matches, even if a pending Polar update moves it elsewhere.
- **Public and hidden extra plans** get the provider's products, but the plan screens and checkout don't offer them yet. Sell an extra plan through a code.
