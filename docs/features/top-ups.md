# Give businesses top-ups on top of their plan

A top-up is extra voice minutes, alert texts, transfers or website chats that a business gets on top of its plan, without a payment and without any change to the plan. An operator grants one to a business with the operator's platform key, for a promotion, as goodwill or for support, or issues a top-up code that the business adds itself under **Have a promo code?**. The business keeps its plan, its subscription, its prices and its allowances: its calls, texts, transfers and chats draw on a top-up only once the plan's own allowance of their kind is used up. Built on `develop/r2` as migration `0154` by fork PR #243, from the maintainer's request of 2026-11-26 for "top up" plans that add minutes and credits to existing plans, given by an administrator for promotions or for a limited time, and for a study of promo code scenarios ([below](#choose-how-a-promotion-reaches-a-business)). The maintainer chose to build the free top-ups first and selling them through Polar and Stripe next ([decisions](../project/decisions.md#choose-what-to-build), [roadmap](../roadmap/paid-top-ups.md)). Checked against `develop/r2` at `7b7b713`, with this change on top.

## Know what a top-up is

- **Units, not money.** A top-up adds what the plans count: voice seconds, shown as minutes, alert text segments, transfer attempts and website chats, any mix of them with at least one above zero. These are the "credits" of the request. A credit of money would only lower a bill from the billing provider, so it would do nothing for a business on Free or on a prepaid pack, which is never billed; units work the same on every plan and need no provider.
- **The plan stays as it is.** Nothing in `billing_accounts` or at the billing provider changes, and the plan screens show the same plan, price and allowances, with the top-ups listed apart under the plan.
- **Used last.** A use draws on top-ups only once the plan's own allowance of its kind is used up, or on the prepaid tier once the packs hold none of it ([below](#know-what-it-does-on-each-plan)). Among several live top-ups, the one that ends first goes first, and one that never ends goes last.
- **Fixed when it is made.** What a top-up gives, when it starts and when it ends are set when it is made. It ends at a set time, given as a date or as a number of 24-hour days from its start, up to 1,095 days, or never. What it still holds at its end is gone, as with a pack.
- **Per business.** A top-up belongs to one business and is never shared with the owner's other businesses.
- **Revoked, never edited.** An operator can revoke a top-up: what it still holds stops counting at once, and the uses it already paid for stay paid. To change one, revoke it and grant another.

## Know what it does on each plan

| Plan in force | What a live top-up does |
| --- | --- |
| Free | A call, text, transfer or website chat that the allowance would refuse runs on the top-up instead, until the top-ups hold none of its kind |
| Prepaid packs | Once the live packs hold none of a kind, its uses draw on the top-ups instead of stopping. The packs go first, even when a top-up ends sooner, since a top-up is extra on top of what the business bought |
| Starter and Pro, monthly or yearly, and the promo plans built on them | Usage past the month's allowance that would be billed as overage is paid by the top-up instead. The part a top-up paid is never sent to the billing provider and never counts toward the spending cap, so a top-up's minutes keep calls running after the cap is reached. Website chats past the allowance cost nothing on these plans, so they never draw on a top-up. A Stripe plan whose overage subscription is missing or unpaid stops usage at its allowance, as Free does, so a top-up runs past it there too |
| Enterprise, a managed plan included | Nothing: the plan has no allowances to run out. The top-ups keep their dates, and if the business moves to a plan with allowances before they end, they count again |
| A self-hosted deployment | Nothing, and the screens don't list them, since such a deployment limits nothing |

## Know how uses draw on a top-up

- **Only the share past the allowance.** Each use's row in `billing_usage_events` records in `top_up_quantity` how much of it a top-up paid for, and `billing_top_up_draws` says which top-up paid it. The month's usage, the spending cap and the quantity sent to the provider count only the rest, so a top-up never makes the month look bigger to the plan or the provider. A top-up is drawn in whole units, so a use's share rounds up to the next whole second, segment, attempt or chat.
- **Calls reserve before they're answered,** as before: a phone call 5-minute slices and a website call its whole length, from what the allowance and the top-ups still hold together. With none left, a phone call gets a busy signal and a website call shows the limit. On a paid plan without a cap a phone call reserves nothing, and its share past the allowance is drawn when it ends.
- **A call settles when it ends:** its real length replaces what it reserved. What it didn't use goes back to the top-up it drew on last, and more than it reserved comes from the live top-ups as far as they hold it. A call that crossed two top-ups keeps what it took from each.
- **Texts, transfers and chats** draw as they're reserved: a transfer one attempt, a website chat one chat before the receptionist answers it, and a text its estimated segments, settled when the carrier reports the real count.
- **One lock per business.** Top-ups span months, as packs do, so every draw takes the business's top-up lock, after the month's lock and the packs' lock where it takes those, and no balance is drawn twice.
- **Only an active top-up counts.** One that starts later, ended, is used up or was revoked is never drawn on. A use already settled keeps what it took from a top-up that has since ended or been revoked.

## Grant a top-up

With the operator's platform key, the one with access to every business (`--access all`), and the business's ID from its **Settings > API keys**:

```bash
# 60 minutes and 5 transfers for 30 days, with a note the business sees.
pnpm lobbystack billing top-up --business <business ID> --voice-seconds 3600 --outbound-call-attempts 5 --days 30 --note "Spring promotion"

# What the business has, top-ups after the plan and its packs.
pnpm lobbystack billing status --business <business ID>

# Stop what a top-up still holds.
pnpm lobbystack billing top-up-revoke <top-up ID> --business <business ID>
```

- **What it gives:** `--voice-seconds` (3600 is an hour, up to 6,000,000), `--alert-sms-segments`, `--outbound-call-attempts` and `--chat-units` (each up to 1,000,000), at least one above 0.
- **When it counts:** from now, or from `--starts-at`, up to 366 days ahead, such as for a holiday weekend; until `--ends-at`, or for `--days` 24-hour days from its start, or for good with neither. A start already past starts it now.
- **`--note`,** up to 200 characters, which the business sees on **Settings > Plan** in place of **Top-up**, so write it for them.
- **The answer** is the top-up, with its ID and the command that revokes it. Each grant and revoke writes an audit row (`api.billing.top_up_granted`, `api.billing.top_up_revoked`).

The API calls are `POST /v1/billing/top-ups`, which answers 201, and `DELETE /v1/billing/top-ups/{top_up_id}`, both with `billing:manage` and the business in the `LobbyStack-Business` header. Only an operator's platform key may make them; any other key gets a 403. With an `Idempotency-Key`, a retry for the same business within 24 hours returns the same top-up, so a loop over businesses run again with the same keys grants nothing twice; the CLI's `--idempotency-key` sends one. Revoking a revoked top-up returns it as it is. `GET /v1/billing` lists the business's top-ups under `top_ups`: those that count now or will, the one that ends first first, then up to 20 that ended or were revoked, the newest first, each with its `source` (`grant` or `code`), `code`, `note`, what it `gives`, what was `used`, its `status` (`scheduled`, `active`, `used_up`, `expired` or `revoked`), `starts_at`, `ends_at`, `created_at` and `revoked_at`.

## Issue a top-up code

A top-up code is a promo code that adds a top-up instead of unlocking a plan. It lives in `billing_codes` beside the plans' codes, with no plan and what it adds in its place, so every code is unique across both kinds.

```bash
# Anyone may add it once until February 1; each top-up lasts 30 days from when it's added.
pnpm lobbystack billing top-up-code --top-up '{"voice_seconds":1800,"days":30}' --max-uses 500 --expires-at 2027-02-01T00:00:00Z

# For one business, which adds it when it chooses; it never ends.
pnpm lobbystack billing top-up-code --top-up '{"voice_seconds":3600,"outbound_call_attempts":10}' --business-id <business ID>
```

- **`--top-up`** takes JSON with `voice_seconds`, `alert_sms_segments`, `outbound_call_attempts` and `chat_units`, at least one above 0, and `days`, 1 to 1,095, how long each top-up lasts from when it's added. Without `days` it never ends. The rest is as for a plan's code ([billing](../billing/README.md#sell-promo-codes-and-promo-plans)): `--code` or `--prefix`, `--business-id` for one business, or else `--max-uses` and `--expires-at`, which a shared code needs, and `--note` for the operator's own records. It prints the code and its link, `/signup?promo=<code>`.
- **Once per business and once per person.** A business adds a code's top-up once, and so does each person, so someone with several businesses can't add one code to all of them. A code's row is locked while a top-up is added, so its last use goes to one business, and `uses` never passes `max_uses`.
- **What stops it:** `pnpm lobbystack billing code-revoke <code ID>`, its `expires_at` or its last use. The top-ups it already added stay until their own end; revoke one of those with `top-up-revoke`.
- **Listing:** `pnpm lobbystack billing codes --kind top_up` lists only top-up codes, and `--kind plan` only plans' codes. A top-up code shows what it adds under `top_up`, and its `plan` is null.

The API call is `POST /v1/billing/codes` with `top_up` in place of `plan`. A code a business can't use for any reason, unknown, revoked, expired, used up or meant for another business, reads the same to whoever typed it, as plans' codes do. Codes live only in the database, never in the repository.

## Add a top-up code in the dashboard

Owners and admins type it under **Have a promo code?**, on **Settings > Plan** or on onboarding's plan step, which take plans' codes and top-up codes alike, where the deployment takes payments.

- **For a top-up code** the field shows **This code adds to your plan:**, a line for each allowance, such as **60 voice minutes**, how long it lasts, **Lasts 30 days from when you add it.** or **It doesn't expire.**, and **Your plan stays as it is. These are used once its own allowance runs out.**
- **Add to my plan** adds it at once, with no payment page, says **Top-up added.**, and the top-up shows under **Your plan**.
- **A code already added** shows **This business already added this code.**, or **You already added this code.** when the person added it for another business, with no button. Adding it anyway answers **This code was already added.** Any other code that doesn't work says **This code isn't valid.**
- **Each look-up and each add is a try,** counted with plans' codes: 10 an hour per business, and 20 per person and per address.
- **A link's code** waits through sign-up and email verification, so a new business sees it checked on onboarding's plan step, where **Add to my plan** adds the top-up before the business picks its plan.

The routes are `POST /api/billing/promo`, which answers a top-up code with `kind` `top_up`, what it adds, its `days`, `usedHere` and `usedByYou`, and `POST /api/billing/top-ups`, which adds it through `app.redeem_billing_top_up_code`: 200 with the top-up, 400 `promo_invalid`, or 409 `promo_used`. Each add writes a `billing.top_up_code_redeemed` audit row.

## Choose how a promotion reaches a business

What the maintainer asked to study: the ways a promotion can reach a business, and which one fits.

| Promotion | Use | What the business does |
| --- | --- | --- |
| Goodwill or support for one business, such as minutes back after an outage | A grant | Nothing: it shows under **Your plan** |
| A deal with one business | A grant, or a top-up code bound to it with `--business-id` | With a code, an owner or admin adds it when they choose, and its days count from then |
| A campaign anyone may join, such as a newsletter, a partner's customers or an event | A shared top-up code, with `--max-uses`, `--expires-at` and `days` | Each business adds it once, and each person once, until the code's end or its last use |
| New customers | A top-up code sent as its link, `/signup?promo=<code>` | The code waits through sign-up, and onboarding's plan step offers it |
| A set period, such as a holiday weekend | A grant with `--starts-at` and `--ends-at` | Nothing: it shows with **Starts on** and its date until then |
| A promo plan with extra minutes on top | A plan's code and a top-up code | Two codes, typed one after the other: the first buys the plan, the second adds the top-up |
| Every business at once | A shared code announced to all, or a grant to each business in a loop, with an `Idempotency-Key` per business | Each adds the code, or nothing for a grant |

- **A code has two clocks.** Its `expires_at` is the last moment anyone can add it, and its `days` how long each top-up lasts once added. A code that expires at the end of January with 30 days lets a business that adds it on January 31 use it until March 2.
- **A grant needs nothing from the business,** so it fits support and one-off deals. A code fits campaigns: the business chooses when its days start, and the ledger records who added it.
- **The recommendation:** a shared top-up code with a use limit, an end date and days for a campaign, sent as its link for new customers; a grant for one business. Use made-up codes for shared ones, never guessable words, since tries are limited but not stopped.
- **Not built:** one code that both unlocks a plan and adds a top-up, a business adding a code through the API, and a grant to every business in one call ([below](#know-what-isnt-built-or-tried)).

## See top-ups on the screens

- **Settings > Plan,** for everyone on the team: under **Your plan**, a **Top-ups** section lists those that count now or start later, the one that ends first first, with **Extra allowances on top of your plan, used once your plan's own allowance runs out. Your plan stays as it is.** Each shows the operator's note, or **Top-up from code** and the code, or **Top-up**; then **Ends on** and a date, **Never ends**, or **Starts on** and a date; and for each allowance it gives, such as **Voice minutes**, what's left of it, such as **45 of 60 left**. On Enterprise it says **Your plan has no limits, so these aren't used while you're on it.** instead. Used-up, ended and revoked top-ups aren't shown.
- **Settings > Usage:** under **Voice minutes**, **Transfer attempts** and **SMS alerts**, a line such as **Top-ups: 45 of 60 min left** while a live top-up gives that kind. The line above it counts only what the plan paid, so on Free it stops at the allowance while the top-up's line counts down, and a line isn't marked **Limit reached** while a top-up still holds some of it. The page has no line for website chats, so a top-up's chats show only on **Settings > Plan**.
- **When they change:** each grant, revoke and add publishes a `billing.updated` live event, as other billing changes do, but no screen listens for it yet, so the screens show a change when they're opened again. The person who adds a code sees it at once.
- `GET /api/billing` carries them as `topUps`, and `usageStatus.topUp` holds what the live ones add up to, kind by kind.

## Set it up on a deployment

1. **Deploy the admin and the worker.** Migrate runs `0154`, which adds two tables, a column with a default to `billing_usage_events`, five columns to `billing_codes` and two functions, and rewrites no row. Nothing else is needed: no variable, no change to `billing.json` and nothing at the billing provider.
2. **Use the CLI from the same release,** since an older one has no `top-up` commands, and the operator's platform key, which needs access to every business.

Rolling back to a release before `0154` leaves the migration in place, and the older code reads none of it: top-ups stop counting, and the usage they paid for counts against its month's allowance again, so later usage that month can be refused or billed sooner. That release's `pnpm lobbystack billing codes` would show a top-up code's plan as `null`, and no one could add one. A release with `0154` brings them back as they were.

## Know what isn't built or tried

- **Selling top-ups** through Polar and Stripe, the second step the maintainer chose ([roadmap](../roadmap/paid-top-ups.md)).
- **Tried only in code,** against PostgreSQL with every plan, packs, caps, revokes and codes in `billingTopUps.integration.test.ts`, not on a deployment with real calls ([open items](../project/open-items.md#test-these)).
- **Codes need the plan screens' field,** which only owners and admins see, only where the deployment takes payments, and not on Enterprise or a managed plan. A business elsewhere gets a grant instead.
- **No business adds a code through the API,** and no call grants every business at once.
- **No reminders:** nothing tells the business that a top-up is about to end or is used up. **Settings > Usage** shows what's left.
- **The control panel doesn't show top-ups:** reading them needs grants for `lobbystack_control` on the two tables, in a migration of its own ([control panel](control-panel.md)).
- **The screens don't refresh on their own** when an operator grants or revokes one, since none listens for `billing.updated` yet.

## Find the code

| Part | Where |
| --- | --- |
| The ledger: balances, draws, the business's list, grants, revokes and codes | `packages/domain/src/server/billingTopUps.ts` |
| Where uses draw on top-ups | `packages/domain/src/server/usage.ts` (`topUpPays`, `reserveUsageInTransaction`, `extendPhoneReservationInTransaction`, `correctUsageInTransaction`), and `billing.ts` for website chats |
| The v1 routes | `apps/admin/app/api/v1/billing/top-ups/route.ts` and `[top_up_id]/route.ts`, handled in `apps/admin/src/lib/public-api/routes.ts` and `packages/domain/src/server/publicApi/operatorBilling.ts` |
| Top-up codes | `packages/domain/src/server/billingCodes.ts` (issuing and listing), `apps/admin/app/api/billing/promo/route.ts` (looking one up) and `apps/admin/app/api/billing/top-ups/route.ts` (adding one) |
| Shared types and the API's shapes | `packages/shared/src/billingTopUps.ts` and `packages/shared/src/publicApi/topUpSchemas.ts` |
| Screens | `apps/admin/src/components/billing-top-ups.tsx` (`HeldTopUps` and `TopUpCodeOffer`), used by `live-plan-surface.tsx` and `promo-code-entry.tsx`, and `live-usage-surface.tsx` |
| The CLI | `packages/cli/src/commands.ts`: `top-up`, `top-up-revoke`, `top-up-code`, and the table `status` prints |
| Tables, functions and grants | `packages/db/migrations/0154_billing_top_ups.sql`, `packages/db/src/schema/billingTopUps.ts`, and `verifyTopUpGrants` in `packages/db/src/cli.ts` ([data model](../billing/data-model.md)) |
