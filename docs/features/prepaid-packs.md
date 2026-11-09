# Sell prepaid minute packs

A business on a cloud deployment can pay once for a pack of voice minutes that lasts a set number of days, instead of a monthly plan: 500 minutes for 180 days, for example. The deployment's billing provider, Stripe or Polar, only takes the payment. LobbyStack keeps the minutes, the end date and what each call drew from them, the same way on both providers and in both of Stripe's selling modes. Packs are an additional option: a business that never buys one keeps its plan, its allowances, its prices and its bills exactly as before. Built on `feature/receptionists` as migration `0148`, from the design of 2026-11-09 and the maintainer's [decisions](../project/decisions.md#choose-what-to-build).

## Know what a pack is

- **One payment, no subscription.** No renewal and no overage bill. When the minutes run out, calls stop as they do on Free, until the business buys another pack.
- **A length in days, fixed at the payment.** A pack ends at its payment time plus its days, counted as 24-hour days, so no month length or clock change shortens it and a later change to the catalog never moves it.
- **No carry-over.** Each pack ends on its own date. A business can hold several, and calls draw from the one that ends first, so buying early loses only minutes the business couldn't have used in time. Unused minutes are gone at the pack's end, even while another pack runs.
- **Per business.** A pack is never shared with the owner's other businesses.

## Know the packs on sale

Each brand's `billing.json` has a `packs` section beside its plans. Each size and length is a pack of its own, with its own code, its names in English, French, Spanish and Serbian, its minutes, its days and its one-time price in the file's currency, and its own Stripe price or Polar product. Both brands sell nine:

| Pack | 90 days | 180 days | 365 days |
| --- | --- | --- | --- |
| 250 minutes | CA$55 | CA$59 | CA$65 |
| 500 minutes | CA$95 | CA$99 | CA$109 |
| 1,000 minutes | CA$179 | CA$189 | CA$199 |

These are starting prices for the maintainer to set before live payments, not decisions: change `priceCents` in both files, then run `pnpm billing apply`.

A pack's monthly allowances and limits are Starter's unless the pack sets its own: 50 alert text segments, 20 call transfers and 50 website chats a month, one phone number and one receptionist. Both brands' packs set 20 MB of knowledge where Starter has 5 MB. A pack's `days` runs from 1 to 1,095; a pack with no `days` never ends, a setting the brands don't use. [`brands/README.md`](../../brands/README.md#billingjson) describes the section.

## Know what a business gets

While a business holds a live pack, the plan in force is **prepaid**, a sixth tier beside self-hosted, Free, Starter, Pro and Enterprise. It is never an account's own plan nor a plan on sale: the account keeps Free in `billing_accounts`, and the code works prepaid out from `billing_packs` each time.

- **Voice minutes** are the live packs' balance, not a monthly allowance. A pack's minutes last its whole length.
- **Alert texts, transfers and website chats** are counted per UTC month against the pack's monthly allowances, as on a plan, and refused past them, as on Free.
- **Limits** are the most any live pack gives: its knowledge storage, its number and its receptionists. Content is kept as on a paying plan.
- **A phone number.** `app.business_included_numbers` returns the live pack's number first, so a pack business can claim one, which Free can't.
- **Nothing goes to the provider.** Calls on a pack are recorded with the plan `prepaid` and sync status `skipped`, so the billing sweep never sends them, and no meter sees them.

## Know how calls use the minutes

- **A call reserves minutes before it's answered,** as on Free: 5-minute slices for a phone call, the whole 30 minutes for a website call. On a pack the reservation draws on the packs, earliest end first, under a lock per business rather than per month, since a balance spans months. `billing_pack_draws` records which pack paid for each call.
- **At zero,** a phone call gets a busy signal (SIP 486) and a website call shows the limit, as on Free.
- **When a call ends,** what it didn't use goes back to the pack it last drew from. A call that crossed two packs keeps what it took from each.
- **A frozen pack** (a dispute is open) and a pack whose end has come aren't drawn from.

## Buy a pack

Owners and admins buy a pack in **Settings > Plan**, and in onboarding's plan step. The page lists the packs on sale with their minutes, length and price, the business's packs with the minutes left and the end date, and **Buy** for each pack. The admin records a pack checkout and queues `billing.createPackCheckout`; the worker asks the provider for a one-time payment page:

- **Stripe directly:** a Checkout Session in payment mode on the business's own customer, with Stripe Tax, the billing address and tax ID, and an invoice.
- **Stripe as the merchant of record** (both brands): the same session with Managed Payments on, and without the tax parameters Stripe's guide says to leave out.
- **Polar:** a checkout for the pack's one-time product.

The page comes back with `?pack=success`, and the pack shows once the provider's payment event arrives. A Stripe payment that settles later, such as a bank debit, adds the pack when `checkout.session.async_payment_succeeded` arrives.

A business can't buy a pack when:

| Refusal | Why |
| --- | --- |
| `managed_plan` | An operator set its plan by hand (Enterprise) |
| `pack_yearly_plan` | It's on a yearly plan: set it to end at renewal and buy a pack then (decision 6a) |
| `pack_past_due` | A plan payment is past due: settle it first (decision 6b) |
| `pack_not_sold_on_plan` | Its plan is one packs aren't sold beside |
| `plan_change_payment_waiting`, `plan_change_pending` | A plan purchase or change is under way: one open purchase per business, across packs and plans |
| `pack_not_on_sale` | The pack is retired, or not linked to the provider yet |

## Switch between a pack and a subscription

A business can move either way, and minutes or allowances left at the switch are gone (decision 6). Each step acts only when a pack is involved.

- **Pack to subscription.** A pack business buys Starter or Pro through the plan checkout, which works for it as for Free. When the subscription goes live, `billing.reconcile` ends the business's live packs as `replaced`, records the minutes each still held, and starts the subscription's allowances from that moment, in the same transaction and under the same lock as the account.
- **Subscription to pack.** A subscriber on a monthly plan buys a pack. When its payment arrives, one transaction adds the pack, marks the subscription as replaced (`billing_accounts.replaced_subscription_id`) so LobbyStack treats it as ended at once, starts the pack's monthly allowances from that moment, and queues `billing.endPlanForPack`. That job sends the plan's remaining usage, waits for calls still in progress, and ends the subscription at the provider: on Stripe as the merchant of record at once with `invoice_now` and no proration, so the meters' usage is billed; on Stripe directly at once with no credit, the overage subscription ending with its month; on Polar at the end of a period it moves a few minutes ahead, so the final order bills the usage with no refund. Until the provider confirms, the daily expiry job asks again.
- **Fresh allowances only for a switch** (decision 6c). `billing_accounts.allowances_since` marks where the month's allowances start counting; only a switch with a pack writes it, so a business that moves from Free to Starter counts its whole month as before. Pack usage never counts against a subscription, since the pack paid for it, and a call stays in the part of the month it started in.

Worth knowing: a promo-code subscriber who switches to a pack loses the code for good, since a code is redeemed once per business; moving from Pro to a pack pauses all but one receptionist, as a downgrade does; and a business moving from a pack to Starter drops from 20 MB to 5 MB of knowledge: nothing is deleted, but uploads stop until it's under 5 MB.

## Know when a pack ends

The worker's `billing.expirePacks` runs once a day for each business that has packs, and at once when a call takes the balance to a fifth or to nothing, or when a refund or a lost dispute ends a pack. One run:

1. **Ends each pack whose end has come,** live or frozen, as `expired`, keeping the minutes it still held for the accounts.
2. **Settles the business's last pack.** When no pack is left that could still count, receptionists past the plan's number pause, and on a plan without a number the number stops answering at once: calls are turned away and texts get no reply, as on a canceled account. The number goes back to Twilio 30 days after the last pack ended, unless a new pack or a plan comes first, which clears the release and the number answers again. A pack a subscription replaced is never settled here.
3. **Emails the owners** in their language, English, French, Spanish or Serbian: when a fifth of the live balance is left, when none is, and 30 and 7 days before a pack ends. A reminder that would fall before the purchase is skipped, and `billing_packs.notices` keeps each pack's reminders to once. The balance reminders wait until the longest call could have settled, so a call's reservation never sends a false "no minutes left".
4. **Asks the provider again** to end a subscription a pack replaced, while the provider still shows it live.

## Know what refunds and disputes do

LobbyStack never refunds on its own and has no refund command (decision 5). The operator refunds in the Stripe or Polar dashboard, and Stripe (through Link, as the merchant of record) or Polar may refund on their own within 60 days of a purchase. Either way the provider's event changes the pack:

- **A partial refund** takes its share of the minutes bought off the pack: a refund of a third of the price removes a third of them. Minutes calls already used stay used, so a pack that used more than the refund leaves it has none left. The provider reports the whole amount refunded so far, so a repeated or late event never takes off more.
- **A refund of the whole payment** ends the pack as `refunded`.
- **A dispute opened** freezes the pack: it stops counting until the dispute closes. On Stripe a dispute names only the payment, so the webhook reads the payment intent back for its business; a dispute on a plan's payment stays unattributed, as before.
- **A dispute won** makes the pack live again, or expired if its end passed meanwhile. **A dispute lost** ends it as `refunded`.

A pack is matched by its Stripe PaymentIntent or Polar order, not by an invoice, since a pack sold with Stripe as the merchant of record has none.

## See packs in the API and the CLI

- `GET /v1/billing` lists the business's packs under `packs`: the live and frozen ones, then the last 20 that ended, each with its minutes, minutes left, payment, end date and status. A subscription a pack replaced shows as ended there.
- `pnpm lobbystack billing status` shows them after the plan.
- `pnpm lobbystack onboard` accepts a live pack as a plan, and onboarding takes the number limit from the plan in force.

## Set it up on a deployment

1. **Apply the catalog** once after the deploy: `pnpm billing apply --brand <brand> --stripe live` (or `--polar ...`). The packs section changes the file's hash, so the apply is needed even where no plan changed; every plan's terms hash stays as it was. On Stripe it makes a product and a one-time price per pack, with the brands' SaaS tax code, and adds three events to the webhook endpoint: `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `charge.dispute.closed`. On Polar it makes a one-time product per pack.
2. **Check it:** `pnpm billing verify` should report no drift, and the daily catalog check covers every pack.
3. **Polar needs no new token scope:** refunds stay in Polar's dashboard.

## Know what isn't built or tried

- **Tried only in code.** The flows above have run against PostgreSQL with Stripe and Polar stood in for, not against a Stripe sandbox, a Polar sandbox or a real call. [Open items](../project/open-items.md#test-these) lists the runs still to make, among them the two the design asked for before live payments: a Stripe test-clock run that shows whether ending a merchant of record subscription with `invoice_now` bills the meters' usage, and a Polar sandbox run of the period moved ahead.
- **Left out of the first version:** automatic top-ups, which Stripe as the merchant of record can't make; holding a pack and a subscription at once; forwarding a call at zero minutes; a refund command; and an operator command that moves one business's end date.
