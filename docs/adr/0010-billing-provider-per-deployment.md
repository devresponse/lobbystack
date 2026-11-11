# ADR 0010: bill each deployment through one provider, behind an interface

Each deployment bills through one provider, Polar or Stripe, chosen with `BILLING_PROVIDER` and kept from the deployment's first catalog link on. The calls to the provider live in `packages/providers` and the decisions in `packages/domain`. Storage moves to provider-neutral columns in two steps: first add the new columns and use them, then drop the Polar ones a release later.

## Status

Accepted, 2026-11-08 (the fork's). Being built on `releases/r2`, one step at a time: [Stripe billing](../billing/stripe-history.md) lists the steps.

## What was there before

- **Billing is built around Polar.** The worker's billing jobs, the Polar webhook route, `pnpm billing`, seven billing tables and views, the billing sweep's SQL function, the public API's fields and the sentences on the plan screens all name Polar.
- **The rules don't depend on the provider.** Allowances, usage, the spending cap, promo codes, checkout limits, claims and the sweep decide the same way whoever takes the payment.
- **A deployment already keeps its first Polar organization.** A catalog link to another organization is refused with `polar_org_changed`.

## Decision

- **One provider per deployment.** `BILLING_PROVIDER` is `polar` or `stripe`, and empty means Polar. A deployment keeps the provider and account of its first catalog link, as it keeps its Polar organization now. No customer moves between providers: a deployment changes provider only after its database is reset. The demo and the RealInfoBot test deployments stay on Polar.
- **Calls in `packages/providers`, decisions in `packages/domain`.** Three interfaces stand between the app and the provider:
  - `BillingProvider` for the calls made while the app runs: customers, checkout, plan changes, the billing portal, ending a plan and usage;
  - a webhook interface that checks a provider's signature and turns its event into one normalized event;
  - a catalog client and a planner for `pnpm billing` and the daily catalog check.

  The worker, the admin and the scripts reach a provider only through them. An adapter answers `not_supported` where its provider has nothing, and capability flags tell the app what a provider can do.
- **Expand, then contract.** Migration `0146` adds provider-neutral columns beside the Polar ones, fills them, and keeps both in step with triggers, so the release before it can still run; the code then reads and writes only the new columns. Migration `0147` drops the Polar columns once every deployment runs a release with `0146`. Until then, migrations only add.
- **Polar first.** Moving Polar behind the interfaces changes nothing a Polar deployment sees: a recorded snapshot of every request Polar receives in the billing flows must not change while the seam is built.
- **Stripe behind a gate.** Until its sandbox scenarios pass, `BILLING_PROVIDER=stripe` also needs `BILLING_STRIPE_PREVIEW=true` and test keys, so no deployment can take a live Stripe payment by accident.

## Consequences

- New deployments can bill through Stripe, while existing ones keep Polar and their customers.
- Every billing change names the provider it is for, and a Polar deployment's screens, emails and API answers stay word for word as they were.
- The two migrations are the only ones of the work, and only `0147` can't be reverted: it merges last, on its own.
- Unless Stripe's Managed Payments is used, the operator becomes the merchant of record on a Stripe deployment, and the taxes Polar handles become the operator's to register for and file.
