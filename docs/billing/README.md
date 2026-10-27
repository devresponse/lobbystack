# Bill businesses for plans and usage

A business on a cloud deployment pays a monthly or yearly price for Starter or Pro, plus a small charge for each minute, text or call transfer past what its plan includes. Polar, the payment service, collects the money; LobbyStack tells Polar what each business used. This page says who pays, what the plans are, how the money moves, how an operator runs billing, and what to watch. Checked against `main` at `da1f548`.

The other billing pages:

- [Polar billing](../providers/polar.md): the Polar settings, tokens, routes, retries and checks, for whoever sets Polar up.
- [`brands/README.md`](../../brands/README.md#billingjson): how to write a brand's `billing.json`, its promo plans and its codes.
- [Data model](data-model.md): the billing tables, columns and migrations.
- [Design history](design-history.md): the options weighed, the ten steps, the two reviews and the decisions.
- [Selling plans (Polar)](../deployment/guide/part-3-outside-services.md#selling-plans-polar) in the deployment guide: setting Polar up for a new instance, step by step.

## Know who pays

- **Cloud businesses only.** The admin stamps each new business with the deployment's `DEPLOYMENT_MODE` when it is created (`businesses.deployment_mode`). A business made on `cloud` starts on the Free plan and can buy Starter or Pro; one made on `self_hosted_standard` or `development` gets the self-hosted plan, with no limits and no billing. Existing businesses keep their stamp when the variable changes, and nothing in the dashboard or the API changes it.
- **Enterprise is billed by hand.** An operator puts a business on it with `pnpm lobbystack billing managed-plan`, which unlocks what a paid plan unlocks outside Polar, and takes it off with `end-managed-plan`.
- **Polar has two separate worlds.** The sandbox (`https://sandbox-api.polar.sh`) takes test cards and moves no money; the demo is set up there. A live organization takes real payments after Polar's review, which can take up to 14 days, and gets a deployment of its own: a deployment stays with the one Polar organization it was first linked to.

## Know the plans

AlloPlace's plans, from [`brands/alloplace/billing.json`](../../brands/alloplace/billing.json), in Canadian dollars:

| Plan | Monthly | Yearly | Voice minutes | Alert text segments | Call transfers | Website chats | Knowledge storage | Phone numbers | Past the allowance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Free (`free_cloud`) | $0 | $0 | 30 | 10 | 2 | 5 | 1 MB | 0 | Refused, not billed |
| Starter | $37 | $370 | 150 | 50 | 20 | 50 | 5 MB | 1 | $0.20 a minute, $0.02 a segment or transfer |
| Pro | $87 | $870 | 500 | 200 | 100 | 200 | 20 MB | 1 | $0.18 a minute, $0.02 a segment or transfer |
| Enterprise | Custom | Custom | Custom | Custom | Custom | Custom | Custom | Custom | Billed by hand |

- Allowances reset on the first of each month (UTC), on monthly and yearly subscriptions alike, whatever day the subscription renews.
- Calls shorter than 10 seconds (`MIN_BILLABLE_VOICE_DURATION_SECONDS`) and calls ended as spam aren't counted.
- A website chat counts once per conversation. On a paid plan, chats past the allowance are never billed, since Polar has no meter for them; on Free they stop.
- A paid plan can have a monthly spending cap on its overage, set in **Settings > Plan** or with `pnpm lobbystack billing cap`. Since fork PR #68 the cap refuses only usage that itself pushes spend past it, so included minutes always work and website chats never stop.
- A plan includes at most one phone number (fork PR #70), and a phone number claim counts the numbers the plan includes (fork PR #66): Free can't claim one.
- Promo plans, sold only through codes, can carry their own allowances, storage and overage rates in place of their tier's. Their data retention and features stay the tier's.

Until `pnpm billing apply` has run on a deployment, the dashboard shows and enforces the four standard plans of its brand's `billing.json` as the build carries them, in the file's currency, so AlloPlace shows the table above from its first start (fork PR #88). It sells them only through the four `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variables, if they are set. A brand without a file, such as LobbyStack, gets the code's built-in plans: the same numbers in US dollars.

## Follow the money

1. An owner or admin picks a plan in onboarding or **Settings > Plan**. The admin records a checkout request and queues `billing.createCheckout`.
2. The worker finds or makes the business's own Polar customer (fork PR #72) and asks Polar for a checkout page for the product the catalog links to the plan and interval. A business that already pays gets no page: the worker moves its subscription to the new product (fork PR #60), and Polar charges the difference as the file's `upgradeProration` says. Moving down to Starter happens in Polar's billing portal.
3. The owner pays on Polar's page. Polar sends subscription and order events to `/api/webhooks/polar`; the admin stores each once and queues `billing.reconcile`, and the worker moves the business onto the plan.
4. As calls, texts and transfers happen, the worker records usage and sends Polar the part past the month's allowance as `billing.voice_minutes`, `billing.alert_sms_segments` and `billing.outbound_call_attempts` events. A later correction, such as a text that Twilio settles on more segments, goes as an event for the difference (fork PR #75).
5. Polar's meters add the events up and invoice the overage every month: with the renewal on a monthly plan, and as a usage invoice of its own on a yearly plan, whose product has a monthly meter cycle (fork PR #73). No product carries Polar Credits (fork PR #69).
6. Owners manage cards, invoices and cancellation in Polar's customer portal, which **Settings > Plan** opens.

[Polar billing](../providers/polar.md#understand-the-billing-flow) follows the same flow with every retry and time limit.

## Know where the plans live

The plans live in one reviewed file, and one command makes the database and Polar match it:

1. `brands/<brand>/billing.json` holds the plans: prices in one currency, allowances, limits, overage rates, promo plans and four Polar settings. `brands/billing.schema.json` checks it as you type, and `pnpm brands:build` checks the rest and writes its hash and its four standard plans into the code, so a deployment knows which file it was built with and shows that file's plans until its first apply. Codes never go in the file, since the repository is public.
2. `pnpm billing apply` writes the file to the catalog tables (`billing_plans`, `billing_prices`, `billing_runs`), makes Polar's organization sell what it says, records which Polar product sells each price, and checks the three against each other.
3. Once the file is applied, the plan screens (fork PR #61), allowances, rates, storage and number limits (fork PRs #62 and #66) read the catalog, in its currency. Once a link makes a plan active, checkout, plan changes and the webhook use the Polar products it links, and so do promo codes and promo plans (fork PRs #63 to #65). A change to the allowances or rates counts for the whole current month.
4. The worker checks the file, the tables and Polar once a day (`billing.verifyCatalog`).

**Don't change the prices, rates or allowances of a plan people already pay for. Add a new plan instead.** LobbyStack applies new terms to every subscriber at once, while Polar keeps each subscriber on the prices they bought, so the usage screens and the spending cap would stop matching Polar's invoices. This is the one finding of the 2026-10-23 billing pass left open as a rule.

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

Give no service token `webhooks:read`: Polar lists each webhook with its signing secret, and whoever has the secret can put any business on any plan. For the same reason the setup and read tokens never go on Railway; make them with the shortest end date Polar offers and delete them after use. The commands never save or print a token, and ask for a missing one with typing hidden.

### Sign in, preview, apply and check

```bash
# Once per computer. Paste the operator key, then press Ctrl-D; it stays out of the shell history.
pnpm lobbystack login --url https://<dashboard domain> --key-stdin --profile ops
pnpm lobbystack --profile ops billing catalog          # plans, prices and their Polar links

# Shows what an apply would change, and changes nothing.
pnpm billing plan   --brand alloplace --polar sandbox --profile ops

# Applies the file to the tables, makes Polar match, links them, then checks all three.
pnpm billing apply  --brand alloplace --polar sandbox --profile ops --railway-file .env.railway

# Checks the file, the tables and Polar against each other.
pnpm billing verify --brand alloplace --polar sandbox --profile ops
```

`plan` and `verify` take `--json` for scripts. `apply` asks before it changes anything; `--yes` skips the question. A run that stops part-way is finished by running it again: everything is found again by its `lobbystack_*` tags in Polar, and the webhook by its address.

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
| `--webhook-url <url>` | A webhook address other than the deployment's own `/api/webhooks/polar`. |
| `--railway-file <new file>` | Saving `POLAR_API_BASE_URL`, `POLAR_ORGANIZATION_ID` and, when the run made the webhook, `POLAR_WEBHOOK_SECRET` to a new file readable only by you. A name like `.env.railway` keeps it out of commits. Delete it once the values are set. |

The file's format is the input of `devops/railway-vars.mjs`; setting the values in Railway by hand works the same. Current subscribers keep their old price, and edits made by hand in Polar's dashboard are put back to match the file.

### Use the other billing commands

`pnpm lobbystack billing` takes these. `status`, `plans`, `cap`, `checkout` and `checkout-status` work with a business API key that has `billing:manage`; the rest need an operator key.

| Command | Does |
| --- | --- |
| `status` | One business's plan, usage, spending cap, promo plan and when it ends |
| `plans` | The plans the business can buy, with their prices |
| `cap <cents>` | Sets the spending cap on a paid plan's overage |
| `checkout`, `checkout-status <id>` | Starts a checkout and prints the page to send whoever pays, or says the existing subscription moved |
| `managed-plan`, `end-managed-plan` | Puts a business on Enterprise outside Polar, and takes it off |
| `end-promo-plan` | Ends a business's promo plan at its next renewal; its owners get an email |
| `catalog` | The applied file, plans, prices and links |
| `catalog-preview <brand>`, `catalog-apply <brand>` | Preview or apply a `billing.json` to the tables only; `pnpm billing apply` does both sides |
| `catalog-link <brand>` | Records which Polar products sell the catalog; `pnpm billing apply` sends it |
| `catalog-runs --kind catalog\|polar\|verify` | Past applies, links and daily checks |
| `code-create <plan>`, `codes`, `code-revoke <id>` | Issue, list and revoke promo codes |

## Sell promo codes and promo plans

A plan whose `access` is `code` in `billing.json` is sold only to a business that enters one of its codes. It can carry a discount for some months, its own allowances, and what happens when its months run out. [`brands/README.md`](../../brands/README.md#promo-codes) shows the file's side.

1. Add the plan to `billing.json` in a pull request, deploy it and run `pnpm billing apply`, which makes its private Polar product and its discount.
2. Issue codes with an operator key: `pnpm lobbystack billing code-create <plan> --business-id <id>` for one business, or `--max-uses <n> --expires-at <time>` for a shared code. The command prints a link, `/signup?promo=<code>`, which survives sign-up; a signed-in owner lands on **Settings > Plan**.
3. The business enters the code under **Have a promo code?** and buys the plan's own product at its discount. It uses each code once (fork PR #70).
4. A plan with a set number of months ends at the first renewal after they run out. A week before, the worker emails the owners in their language and tells Polar to move the subscription to its tier's standard product or to cancel it (fork PR #65). Switching plans in Polar's portal leaves the promo plan, and the worker removes its discount.

Code tries are limited each hour: 10 per business, 20 per person, 20 per IP address, and 20 per API key, OAuth grant or platform key across the businesses it reaches. Use generated codes for shared ones, never guessable words, and expect no Promotions screen: codes are issued from the command line and sent by hand.

## Know the limits and refusals

| Limit | Value | Over it |
| --- | --- | --- |
| Checkouts | 10 an hour per business, 20 per person across businesses (fork PR #74) | 429 `billing_rate_limited` |
| Billing portal sessions | 20 an hour per business, 40 per person | 429 `billing_rate_limited` |
| Plan changes | One request at a time per paying business (fork PR #75) | 409 `plan_change_pending`, or `conflict` from the v1 API |
| Redis down while counting | | 503 `billing_limit_unavailable` |
| A checkout request | 15 minutes to run; a run that died is taken over after 5 | Fails, and the owner asks again |

Polar's request budget is the whole organization's, and past it Polar refuses every call, payments and usage included, which is why checkouts and the portal are limited. Asking again for the same plan, interval and billing email while a request is still open returns that request and counts nothing.

## Know what runs on its own

| Job | When | Does |
| --- | --- | --- |
| `billing.createCheckout` | Each checkout request | Finds or makes the Polar customer, then makes the checkout or moves the subscription |
| `billing.reconcile` | Each stored Polar event | Applies subscription and order events in the order Polar changed each subscription |
| `billing.syncUsage` | Each final usage row | Sends Polar the billable part, numbered so Polar takes each event once |
| `billing.sweep` | Every 5 minutes | Queues again a Polar event, usage or checkout request a job left behind, at most once an hour each, and reports work older than an hour (fork PR #71) |
| `billing.verifyCatalog` | Daily | Compares the file, the tables and Polar; leaves out the webhook, which `pnpm billing verify` checks |
| `billing.endPromoPlan` | Daily, per business | Ends promo plans whose months ran out, a week ahead |
| `billing.refreshUnitEconomics` | Hourly, per business | Adds up what the business cost this month in provider, AI and hosting fees (`unit_economics_rollups`) |

`billing.reconcile` and `billing.syncUsage` try 12 times over about 3 hours before the sweep takes over, so nothing needs requeueing by hand.

## Watch billing

| Signal | Sent as | Means | Suggested alert |
| --- | --- | --- | --- |
| `ops.billing.profile_drift` | PostHog event from the worker | The daily check found the file, tables and Polar disagreeing, or couldn't read Polar | Any in a day |
| `ops.billing.profile_drift_recovered` | PostHog event from the worker | The first clean check after drift | None; it closes the drift alert |
| `ops.billing.usage_sync_failed` | PostHog event from the worker | Usage couldn't reach Polar, so a business may be undercharged | Any in an hour |
| "Billing work waited longer than it should." | Error tracking, from the worker, and the `lobbystack.billing.overdue_work` counter | A Polar event or usage waited over an hour, or a checkout request failed for waiting | Any ([BillingWorkOverdue](../operations/alerts.md#billingworkoverdue)) |
| "A live Polar subscription is for a product no plan maps to" | Error tracking, from the worker | A subscription to a product the catalog doesn't link, such as one made by hand in Polar; the business keeps its plan until the product is linked | Any |
| "The worker's Polar token can't read or make customers" | Warning in error tracking, from the worker | The worker's token lacks `customers:write`, so Polar picks a checkout's customer by email | Any |
| `ops.billing.webhook_refused` | Warning log line from the admin | A Polar delivery was refused (`unconfigured`, `missing_headers` or `bad_signature`). Polar turns the webhook off after 10 failures in a row | 3 or more in an hour |
| `ops.billing.webhook_unresolved` | Error log line from the admin | A Polar event matched no business, so a subscription may never have applied | Any |
| `ops.billing.webhook_customer_mismatch` | Warning log line from the admin | A subscription came on another business's Polar customer; it still goes to the business that bought it | Any |
| `ops.billing.sweep` | Log line from the worker | What each sweep that found work queued again | None |

Log lines reach PostHog only once the `OTEL_EXPORTER_OTLP_*` variables are set ([observability](../features/observability.md)). The daily checks' history is also on the deployment: `pnpm lobbystack --profile ops billing catalog-runs --kind verify`.

## Find the code

| Part | Where |
| --- | --- |
| The plans file and its schema | `brands/<brand>/billing.json`, `brands/billing.schema.json`, `packages/shared/src/billingProfile.ts` |
| Plan list, limits and what a business can buy | `packages/domain/src/server/billingPlans.ts`, `billingAccess.ts`, `packages/shared/src/billing.ts` |
| Usage, allowances and the spending cap | `packages/domain/src/server/usage.ts` |
| Checkout, reconcile and plan changes | `packages/domain/src/server/billing.ts`, `packages/providers/src/polar/polarBilling.ts`, `packages/providers/src/polar/webhook.ts` |
| Catalog, Polar setup and the daily check | `packages/domain/src/server/billingCatalog.ts`, `billingPolar.ts`, `billingVerify.ts`, `packages/providers/src/polar/polarCatalog.ts`, `scripts/billing.ts` |
| Promo codes and endings | `packages/domain/src/server/billingCodes.ts`, `billingPromoEnd.ts`, `packages/shared/src/billingCodes.ts` |
| The sweep | `packages/domain/src/server/billingSweep.ts` |
| Dashboard routes | `apps/admin/app/api/billing/` (plan, `checkout`, `portal`, `promo`), `apps/admin/app/api/webhooks/polar/route.ts`, `apps/admin/src/lib/billing-limit.ts` |
| Worker jobs and schedules | `apps/worker/src/handlers.ts`, `apps/worker/src/scheduler.ts` |
| Tables | Migrations `0108` to `0116` in `packages/db/migrations/` ([data model](data-model.md)) |

## Know the known problems

- **Changing a sold plan's terms** makes the usage screens and the cap disagree with Polar's invoices. Add a new plan instead.
- **Nothing has been tried against Polar since fork PR #59.** Upgrades, per-business customers, promo codes, promo endings and the monthly invoicing of yearly plans have been tested only against a stand-in built from Polar's code. Try a checkout, an upgrade, a code and the portal on the sandbox, and compare Polar's invoices with **Settings > Usage**.
- **Before the first apply** the dashboard shows the brand's file as the build carries it, so an edit to `billing.json` shows only after `pnpm brands:build` and a new build. A phone number claim still counts the code's numbers until then (none on Free, one on Starter and Pro), which AlloPlace's file matches, and a `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variable's product charges whatever Polar has for it, whatever the screens say.
- **Yearly products made before fork PR #73** invoice their overage once a year until `pnpm billing apply` runs once with `--allow-replace`, and the daily check reports them as drift until then. Their current subscribers stay on them.
- **Allowances reset on the first of the month (UTC), not at renewal.** After a mid-month downgrade or a promo plan's end, the month's earlier usage counts against the smaller allowance. Whether to keep this is undecided ([open items](../project/open-items.md)).
- **A promo plan with an annual price** would get its months of discount on the whole first year, because Polar checks a repeating discount against the start of the period it bills. No such plan exists.
- **Leftovers from the 2026-10-23 review:** alert texts sent before fork PR #67 never reached Polar's meter, and aren't backfilled; a promo discount left by a switch in Polar's portal stays if the worker's token lacks `subscriptions:write`, after one warning; the worker marks a plan change done when the product matches, even if a pending Polar update moves it elsewhere.
- **Public and hidden extra plans** get Polar products, but the plan screens and checkout don't offer them yet. Sell an extra plan through a code.
