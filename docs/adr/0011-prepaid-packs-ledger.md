# ADR 0011: keep prepaid minutes in LobbyStack's own ledger

A business can pay once for a pack of voice minutes that lasts a set number of days, instead of a monthly plan. The deployment's billing provider, Stripe or Polar, only takes the payment. LobbyStack keeps the minutes, the end date and what each call drew from them in its own tables, the same way on both providers and in both of Stripe's selling modes.

## Status

Accepted, 2026-11-09 (the fork's). Built on `releases/r2` as migration `0148`: [prepaid packs](../features/prepaid-packs.md) describes what it does, and the [decisions](../project/decisions.md#choose-what-to-build) the maintainer made for it. Since migration `0151` (2026-11-12), when packs became fixed-length plans, the ledger also counts what a pack's alert texts, transfers and website chats drew, which last its whole length as its minutes do.

## What was there before

- **Every cloud business is on a plan.** Free, or Starter or Pro paid monthly or yearly through the deployment's provider, with allowances that reset on the 1st of each UTC month and, on a paid plan, overage billed through the provider's meters.
- **The provider owns subscriptions.** LobbyStack mirrors each business's subscription in `billing_accounts` from the provider's events ([ADR 0010](0010-billing-provider-per-deployment.md)).
- **Calls already reserve before they're answered.** On Free, a call reserves minutes from the month's allowance and is refused at zero; the provider never sees that usage.

## Decision

- **A ledger in PostgreSQL.** `billing_packs` holds one row per pack bought, with everything the pack gives copied onto it at purchase, and `billing_pack_draws` records which pack paid for each call. The end date is fixed at the payment: its time plus the pack's days, counted as 24-hour days.
- **The provider takes a one-time payment and nothing else.** A Stripe Checkout Session in payment mode, or a Polar checkout for a one-time product. Its payment, refund and dispute events change the ledger; LobbyStack sends the provider no usage for a pack.
- **A sixth tier, worked out each time.** While a business holds a live pack, the plan in force is `prepaid`. No account stores it: the code derives it from the live packs, so a business that never buys one runs exactly the code it ran before.
- **Additive only.** Packs are an option beside the plans, never a change to them. Five new tables and a view, two columns that stay empty for a business that never switches, and functions that act as before for every business without a pack.

## Considered and not chosen

- **Stripe's billing credits.** A credit grant pays only metered subscription items, and only when the invoice finalizes at the end of the period, so each business would need a monthly metered subscription, could run past its balance mid-month, and would be charged the rest. Funding a grant takes a one-off invoice, which Stripe as the merchant of record doesn't allow, and Stripe now points prepaid drawdown to Metronome, a separate platform with limited Checkout support.
- **Polar's meter credits.** They stack on each purchase of a one-time product, but Polar never blocks usage at zero and its docs give them no expiry, so LobbyStack would enforce both anyway while sending Polar every minute within its request budget.

## Consequences

- **One design on every provider.** Polar, Stripe directly and Stripe as the merchant of record sell packs the same way; only the checkout and the end of a replaced subscription differ by provider.
- **LobbyStack owns the balance.** Reservations, give-backs, expiry, reminder emails and the number release are LobbyStack's jobs, tested against PostgreSQL. A refund or dispute must reach LobbyStack as a provider event before the pack shrinks or freezes.
- **Switching touches shared code.** Moving between a pack and a subscription (decision 6) is the one part every business's code path passes through, so each step there acts only when a pack is involved, and the existing plan tests run unchanged.
- **Rollback isn't free.** A release before `0148` runs on the database, but it ignores the ledger, so a business on a pack falls back to its account's plan there. [Prepaid packs](../features/prepaid-packs.md#set-it-up-on-a-deployment) says what to do first.
