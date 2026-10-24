# Read how billing was designed

Billing was rebuilt in the fork between 2026-10-18 and 2026-10-24: ten planned steps, a full review, and a second pass over Polar's calls, security and running several instances, in fork PRs #58 to #75. This page keeps the reasoning: where billing started, the options weighed, what each step built, the decisions the maintainer made, and what the two reviews found and fixed. [Billing](README.md) describes billing as it works now. Checked against `main` at `da1f548`.

## Know where billing started

The original project billed through Polar with its plans written into the code:

- The prices, allowances and rates sat in nine places: `billingPlanCatalog` in `packages/shared/src/billing.ts`, the upgrade dialog, about 40 translated lines of onboarding and settings text in each language, plan names in SQL migrations, the marketing site, and the four `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variables that named Polar's products. A price change touched all of them and a redeploy.
- Every price showed in US dollars, whatever Polar charged.
- Upgrading a paying Starter business to Pro opened a second checkout, which Polar refuses.
- Monthly plans carried their allowance as Polar Credits, which renew on each subscription's billing day, while the dashboard reset allowances on the first of the month.

To set a Polar organization up, a separate guide from 2026-10-18 and its script, `polar-setup.mjs`, made the meters, the Credits, the products and the webhook through Polar's API. The script was never part of the repository. It was run on the demo's sandbox organization on 2026-10-19, in Canadian dollars, after a first run stopped because Polar requires the organization's default currency on every product. `pnpm billing apply --adopt` now takes over what it made: it tags its meters and monthly products, keeps their IDs and takes their Credits off; `--allow-replace` replaces its annual products, which invoice overage once a year.

## Weigh the options

Three designs were written on 2026-10-20 and merged into one master design the same day:

| Option | How it works | For | Against | Outcome |
| --- | --- | --- | --- | --- |
| Prices in code, as before | Prices in the code, the dialog, the translations and four variables | Nothing changes by accident | Nine places to change, the wrong currency | Replaced |
| A. Polar is the source | Plans are edited in Polar's dashboard and copied into the database by webhooks, a daily sync and a Sync now button | New prices need no deploy | No review or history; a typo in Polar changes limits | Kept only as the daily read-only check |
| B. A file in the repository is the source | Plans are edited in `brands/<brand>/billing.json` through a pull request; `pnpm billing apply` makes the database and Polar match | Every change is reviewed and kept in history; sandbox and live come from one file | An apply changes production, and prices are public in the code before launch | **Chosen** |
| C. Promo plans by code | Operators issue codes that put one business on a special plan or discount | Deals for one customer without touching the file | Codes name businesses, so they stay out of the public repository | **Chosen**, on top of B |
| Read Polar on every page | Screens ask Polar each time | No copy to keep in step | A Polar outage breaks the dashboard | Rejected |
| A plan editor in the dashboard | One screen edits plans and writes to Polar | One place for every field | Needs write access to Polar at runtime | Maybe later |

B keeps the token that can change prices off the running deployment: `pnpm billing` runs on an operator's computer, and the deployment's own tokens can't change Polar's products.

## Follow the ten steps

| Step | What it built | Pull request | Migration | Merged |
| --- | --- | --- | --- | --- |
| 1. Plan changes | A paying business's upgrade changes its Polar subscription instead of opening a second checkout; downgrades stay in Polar's portal | #60 | | 2026-10-22 |
| 2. Catalog tables | `billing_plans`, `billing_prices`, `billing_runs` and the `billing_offers` view | #58 | `0108` | 2026-10-21 |
| 3. The plans file | `billing.json`, its schema and checks, its hash built into the code | #58 | | 2026-10-21 |
| 4. Apply | The catalog API and command line (#58); `pnpm billing plan` and `apply`, and links from prices to Polar products (#59) | #58, #59 | | 2026-10-22 |
| 5. Verify | `pnpm billing verify` and the worker's daily check, with PostHog events | #59 | | 2026-10-22 |
| 6. Screens | Onboarding, the upgrade dialog, **Settings > Plan** and checkout read the catalog, in its currency | #61 | | 2026-10-22 |
| 6b. Limits | Allowances, rates, storage and number limits read the catalog | #62 | | 2026-10-22 |
| 7. Promo codes | Operators issue codes for a plan's discount; the **Have a promo code?** link | #63 | `0109` | 2026-10-23 |
| 8. Promo plans | A promo plan's own allowances, limits and overage rates, and usage priced by the plan it was used under | #64 | `0110` | 2026-10-23 |
| 9. Promo endings | A time-limited plan ends at the renewal after its months, with an email a week before; an operator's early end; checkouts refuse codes typed on Polar's page | #65 | `0111` | 2026-10-23 |
| 10. Clean-up | The four product ID variables become optional, and number claims count a plan's included numbers | #66 | `0112` | 2026-10-23 |

Step 6b wasn't in the plan: step 6 left the limits on the built-in plans, and step 8 needed them on the catalog first.

## Know the decisions

The step designs listed their choices with a default for each. The maintainer accepted every default of step 1 (D1 to D19) and answered step 2's (D20 to D34). The ones that shape billing today:

| # | Decision |
| --- | --- |
| D1 | AlloPlace bills in Canadian dollars. |
| D2, D12, D17 | Three catalog tables; the dashboard reads only public plans and their prices; offers come from a `security_invoker` view. |
| D3, D4, D5 | Extra plans are sold plans on the Starter or Pro tier; the schema takes them from the start; promo codes and the account columns came with the promo steps. |
| D6 | Applying a file the deployment wasn't built with is refused without `allow_undeployed`. |
| D7 | Only operator keys read and change the catalog. |
| D10 | Polar settings in the file: one subscription per customer, plan changes on in the portal, upgrades invoiced now, downgrades from the next period. |
| D11 | No `billing.json` for the `lobbystack` brand: self-hosters keep the built-in plans. |
| D13, D15 | An extra plan stores every value, inheriting what it leaves out from its tier when applied, and freezes once someone takes it; standard plans never freeze. |
| D20 | The Polar work runs in `pnpm billing` on an operator's computer, not as a worker job holding the setup token. |
| D21 | One command applies the catalog, then Polar, then the links. |
| D22 | `--adopt` takes over what `polar-setup.mjs` made, keeping its IDs. |
| D25, D26 | Edits made in Polar's dashboard are put back; a price change leaves current subscribers on their old price, as Polar does. |
| D28 | Live payments get a deployment of their own, and each deployment keeps one Polar organization. |
| D29 | The daily check runs on the worker. |
| D33 | No nightly check in GitHub Actions: the worker's covers it without an operator key in GitHub. |

D24, a flag to allow fewer Credits, went away with the Credits in fork PR #69.

## Review the billing code, 2026-10-23

A full review of steps 1 to 10 read every file they touched, compared each comment and doc with the code, and ran every check from an empty database. Fork PR #67 fixed the 33 problems it found:

| Area | Fixes |
| --- | --- |
| Catalog and Polar setup | Dropped discounts no longer linked; meters archived last so `--allow-replace` finishes; Credits only on plans with a monthly price; product names from the plan's own entries; the variables count only before a plan's first link; `apply` always previews the catalog; the Railway file written as soon as Polar is set up |
| Promo plans | Months counted from the first renewal on the plan, ending on the month's last day as Polar's do; a lapsed subscription keeps its plan and months; the use credited to the paid checkout's code; another promo plan chosen for the renewal stands; one ending email; discount removals retried |
| Promo codes and checkout | A code for the current plan is forgotten; a key that can't pay doesn't use the business's tries; the dashboard refuses a downgrade the screens never offer |
| Usage and numbers | Alert texts metered once Twilio settles them; emoji texts estimated as Twilio counts them; documents checked one at a time against storage; a zero voice rate never reaches the cap; number questions follow the plan in force |
| Screens | Fresh blocked flags and spend; "Resets on" the first of next month; Free, retired and self-hosted plan texts; translated transaction statuses; decimal commas in Spanish and Serbian; the leaving survey held off during a checkout; onboarding errors translated |
| Checks | `replacement:billing` reads the enforced terms; DOMPurify 3.4.17 for a critical advisory; two flaky tests |

It left five behaviors for the maintainer, who chose all five:

| # | Before | After | Pull request |
| --- | --- | --- | --- |
| 1 | Once spend passed the cap, even included minutes and website chats were refused | Only usage that itself pushes spend past the cap is refused | #68 |
| 2 | Polar's Credits renewed on each subscription's cycle while allowances reset on the first of the month, so a business could be invoiced overage the dashboard never showed | Monthly plans report only each month's overage, like annual ones, with no Credits | #69 |
| 3 | A business could redeem a shared code again once its plan ended | A business uses a code once (migration `0113`) | #70 |
| 4 | An API key could try 10 codes an hour on every business it reaches | Each key, OAuth grant and platform key also gets 20 tries an hour across businesses | #70 |
| 5 | `billing.json` accepted up to 20 numbers, though a business can hold one | A plan includes 0 or 1 numbers | #70 |

Left as they were: alert texts sent before #67 stay off Polar's meter; a promo discount left by a switch in Polar's portal stays if the worker's token lacks `subscriptions:write`; and the worker marks a plan change done when the product matches, even if a pending Polar update moves it elsewhere.

## Make a second pass, 2026-10-23

A second pass read every Polar call against Polar's own server code, checked the security of each, and ran two admins and two workers behind load balancers against a stand-in for Polar, with webhooks sent to both admins at once and instances killed mid-run. Nothing was charged or applied twice. It found 3 serious, 6 medium and 12 minor problems:

| Finding | What happened | Fixed in |
| --- | --- | --- |
| H1 | A Polar event that failed five times in about 15 seconds was never applied, and Polar's redelivery was answered as a duplicate, so a business could pay and stay on Free | #71 |
| H2 | Polar keeps one customer per email and picked a checkout's customer by email, so a person paying for a second business was refused or billed on the first | #72 |
| H3 | Annual products had no meter cycle, so their overage was invoiced once a year | #73 |
| M1 | Usage that couldn't reach Polar for about three hours was never billed | #71 |
| M2 | A shared code's use limit counted only subscriptions, so open checkouts could all pay with it | #75 |
| M3 | The admin's Polar token could read the webhook signing secret | #74 |
| M4 | A webhook could replace a business's billing key with Polar's customer ID, so usage was accepted but never billed | #72 |
| M5 | Checkouts and the portal had no rate limit, and Polar's request budget is the whole organization's | #74 |
| M6 | Changing a sold plan's terms applies to every subscriber at once, while Polar keeps each on the prices they bought | Open, as a rule: add a new plan instead |
| L1 | A worker crash while making a checkout left the request "processing" for good | #71 |
| L2 | Two upgrades at once both reached Polar | #75 |
| L3 | Ending a promo plan just after an unprocessed upgrade scheduled a move back | #75 |
| L4 | A usage correction reused its event ID, so Polar dropped it | #75 |
| L5 | Polar ignores a checkout's idempotency key, so a retry could open a second page | #75 |
| L6 | Webhook refusals weren't logged, and Polar turns the webhook off after 10 failures in a row | #71 |
| L7 | A late event about an ended subscription could overwrite the live one | #75 |
| L8 | A late "paid" event could show a refunded order as paid again | #75 |
| L9 | An apply could change a promo plan's terms as its first subscriber fixed them | #75 |
| L10 | Through API keys, a person could try 100 codes an hour, against 20 on the dashboard | #74 |
| L11 | A subscription to a product the catalog doesn't know kept the business on its previous plan | #75 |
| L12 | No Polar API version was pinned | #73 |

The maintainer chose all five proposed fixes, merged on 2026-10-24 one pull request at a time, serious ones first:

| Fix | Pull request | Migration | What changed |
| --- | --- | --- | --- |
| 1. Nothing billing-related gets lost | #71 | `0114` | `billing.sweep` every 5 minutes queues again unapplied Polar events, unsent usage and stuck checkout requests, at most once an hour each, and reports work over an hour old; requests fail after 15 minutes; refused webhooks are logged |
| 2. A Polar customer per business | #72 | `0115` | The worker finds or makes the business's own customer by its billing key; a taken email asks for a separate billing email; checkouts name their business in metadata; webhooks never change the billing key |
| 3. Monthly overage on annual plans | #73 | | Annual products get a monthly meter cycle, so a product made earlier needs `--allow-replace`; every call asks for Polar API version `2026-10` |
| 4. Tokens and limits | #74 | | Separate admin and worker tokens, neither with `webhooks:read`; hourly checkout and portal limits; a person's open request comes back; API code tries count per person |
| 5. The edges | #75 | `0116` | Corrections sent as numbered differences; one plan change at a time with a subscription claim; open checkouts count toward a code's limit; events applied in each subscription's order; events for unknown products wait |

Five notes needed no code but shape how billing is run:

- **O1.** Taking Credits off products with subscribers makes Polar take back each subscriber's whole grant, so on the sandbox, used allowance can be billed once. A live organization set up only with `pnpm billing` never has Credits.
- **O2.** `0113` fills its table only when the migration runs as a role that bypasses row-level security; its log says which.
- **O3.** `--allow-replace` on an organization with subscribers is untested: it archives products their subscriptions still use.
- **O4.** Allowances reset on the first of each month (UTC), not at renewal, so after a mid-month downgrade or a promo plan's end, the month's earlier usage counts against the smaller allowance. Whether to keep this is undecided.
- **O5.** A promo plan with an annual price would get its months of discount on the whole first year, since Polar checks a repeating discount against the start of the period it bills.

The pass also listed what more than one admin or worker needs: database pools under Postgres's connection limit (two of each can open 112 to 136 connections), bucket storage, one Redis, `APP_BASE_URL` set before the admin's build, and drain time on the worker. [Scalability](../reviews/scalability-2026-10-18.md) and the deployment guide's [7.24](../deployment/guide/part-7-operations.md#724-scale-up) cover them.
