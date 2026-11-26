# Sell top-ups through Polar and Stripe

Since migration `0154` ([top-ups](../features/top-ups.md)), an operator can give a business extra minutes, texts, transfers and website chats on top of its plan, or issue a code that adds them, without a payment and without changing the plan. On 2026-11-26 the maintainer chose to build those first and to sell top-ups in a second pull request: an owner buys extra minutes in the app, pays once through the deployment's billing provider, and keeps the plan as it is.

- **Status:** waiting on 4 decisions, below.
- **Effort:** about 5 to 8 days in one or two pull requests, a rough estimate: most of it is the prepaid packs' catalog, checkout and payment events, reused.

## Know what it would add

- **Top-ups on sale in `billing.json`:** a `topUps` section beside `packs`, each with its code, its names in English, French, Spanish and Serbian, what it gives (`voiceMinutes`, `alertSmsSegments`, `outboundCallAttempts` and `chatAiUnits`), its `days` or none, and a one-time price. `pnpm billing apply` would make a one-time Stripe price or a private Polar product for each, link it and check it daily, as it does for packs.
- **Buying one:** a button on **Settings > Usage** and **Settings > Plan**, for owners and admins, that opens the provider's payment page, as a pack's card does. The payment's event adds a `billing_top_ups` row with a third source, `purchase`, beside `grant` and `code`, with the payment's reference and amount. A bought top-up draws exactly as a granted one, so usage needs no change.
- **Refunds and disputes:** a full refund revokes what is left, a partial one takes its share of what is left, and a dispute holds the top-up until it closes, as the packs' events do (`packages/domain/src/server/billingPackEvents.ts`).
- **Discount codes:** on Polar, the payment page can take a code made in Polar's dashboard, as packs' pages do where `polar.packDiscountCodes` is on ([prepaid packs](../features/prepaid-packs.md#take-money-off-a-pack-with-a-discount-code)).
- **The API and the CLI:** a checkout call beside the packs', such as `POST /v1/billing/top-ups/checkout`, and `pnpm lobbystack billing buy-top-up <code>`, with a business key that has `billing:manage`, as `buy-pack` works.

## Decide these

1. **Which top-ups each brand sells, at what prices,** and whether they end, such as 100 minutes for 90 days.
2. **Which plans may buy them:** every plan with allowances, or Free and packs only. On Starter and Pro a bought top-up replaces overage the business would pay for anyway, so it matters only if it costs less per minute.
3. **Whether to top up on its own** when minutes run low. That needs a payment method saved for charges made without the owner present, which the packs' one-time pages don't keep, so it is a larger piece of work than buying one by hand.
4. **Refunds once a top-up is partly used:** none, its share of what is left, or by hand only, as packs' refunds are today.

## Know what it reuses

The packs' checkout (`packages/domain/src/server/billingPackCheckout.ts` and the worker's `apps/worker/src/billing/packCheckout.ts`), their provider events, the catalog's apply, link and daily check (`billingCatalog.ts`, `billingPolar.ts`, `billingStripe.ts`), the purchase limits, and the top-up ledger as it is (`packages/domain/src/server/billingTopUps.ts`).
