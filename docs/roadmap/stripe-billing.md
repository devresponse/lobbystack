# Bill new deployments through Stripe

Billing runs through Polar, which is the merchant of record and handles sales tax. A study on 2026-11-05 designed letting a new deployment bill through Stripe instead: one provider per deployment, chosen at setup, with Polar moved behind the same interfaces first ([ADR 0010](../adr/0010-billing-provider-per-deployment.md)).

- **Status:** being built on `feature/receptionists`, one step at a time; nothing goes to `main`. Steps 1 and 2 are done.
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
