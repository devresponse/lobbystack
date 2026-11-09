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

These are starting prices for the maintainer to set before live payments, not decisions: change `priceCents` in both files, then run `pnpm billing apply`. Stripe never changes a price, so for a pack already linked that run makes a new Stripe price and needs `--allow-archive` and `--allow-replace` ([Stripe billing](../providers/stripe.md#know-what-apply-makes-for-packs)); Polar puts the new price on the pack's own product.

A pack's monthly allowances and limits are Starter's unless the pack sets its own: 50 alert text segments, 20 call transfers and 50 website chats a month, one phone number and one receptionist. Both brands' packs set 20 MB of knowledge where Starter has 5 MB. A pack's `days` runs from 1 to 1,095; a pack with no `days` never ends, a setting the brands don't use. [`brands/README.md`](../../brands/README.md#prepaid-packs) describes the section.

## Know what a business gets

While a business that would otherwise be on Free holds a live pack, the plan in force is **prepaid**, a sixth tier beside self-hosted, Free, Starter, Pro and Enterprise. It is never an account's own plan nor a plan on sale: `billing_accounts` keeps what the provider last reported, and the code works prepaid out from `billing_packs` each time. A pack paid while a managed, yearly or past-due plan is in force waits unused beside it, and its end date still comes.

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

Owners and admins buy a pack under **Prepaid minutes** in **Settings > Plan**, or under **Prefer prepaid minutes?** below the plans in onboarding's plan step. They pick its **Minutes** and how long it **Lasts**, see its price "paid once", and click **Buy pack**, which Settings > Plan calls **Buy more** while the business holds a pack. Settings > Plan also lists the packs held, each with its minutes left out of its total and its end date, and "On hold while a payment dispute is open" while a dispute holds it. Members who don't manage billing see only the packs held, and the section doesn't show on a self-hosted deployment or on Enterprise, managed or not.

The button works for a role of `business_admin` or higher, on a deployment whose provider has what a pack checkout needs (`STRIPE_API_KEY` and `STRIPE_ACCOUNT_ID` on Stripe, `POLAR_ACCESS_TOKEN` and `POLAR_ORGANIZATION_ID` on Polar), for a pack a link has put on sale. Otherwise it's greyed out, with the refusal under it or "Packs can't be bought here right now.". A purchase that would end a monthly Starter or Pro plan first asks **End your Starter plan?** or **End your Pro plan?**: the plan ends at once, the rest of its month isn't refunded and its usage so far is still billed, a promo code is lost for good, Pro's receptionists but one pause, and the pack starts. **End plan and buy** goes on.

The admin records a pack checkout and queues `billing.createPackCheckout`; the worker asks the provider for a one-time payment page:

- **Stripe directly:** a Checkout Session in payment mode on the business's own customer, with Stripe Tax, the billing address and tax ID, and an invoice.
- **Stripe as the merchant of record** (both brands): the same session with Managed Payments on, and without the tax parameters Stripe's guide says to leave out.
- **Polar:** a checkout for the pack's one-time product.

The screen goes to the payment page once it's ready. When the provider won't make the business's customer with the person's email, a form asks for a billing email and starts again with it, as a plan checkout does. A checkout that waits more than 15 minutes for its job expires, and the billing sweep's `pack_checkout` branch queues the job again for one it finds unfinished.

After paying, the provider sends the person back with `?pack=success&packCheckoutId=<id>` to **Settings > Plan**, or to onboarding's plan step while onboarding isn't complete. The page waits up to 90 seconds for the provider's payment event, then says "Your pack was added.", that the payment didn't go through, or that it's processing and the pack shows once it arrives; onboarding moves on to the number step once the pack is paid. A Stripe payment that settles later, such as a bank debit, adds the pack when `checkout.session.async_payment_succeeded` arrives. Leaving the payment page unpaid returns to the plan page without the marker.

A business can't buy a pack when the checkout refuses it, in this order. The plan screens check the first five before the click: the first two hide the packs on sale, and the next three show under the greyed-out button. The dashboard's route answers a refusal with a 409 and its code, which the screen says in the person's language, and the API with a 409 `conflict` and the reason:

| Refusal | Why |
| --- | --- |
| `managed_plan` | An operator gave it a managed plan (Enterprise, billed directly) |
| `pack_not_sold_on_plan` | The deployment is self-hosted, or the business is on Enterprise |
| `pack_yearly_plan` | It's on a yearly plan: set it to end at renewal and buy a pack then (decision 6a) |
| `pack_past_due` | A plan payment is past due: settle it first (decision 6b) |
| `plan_change_payment_waiting` | An upgrade of its plan still waits for its payment |
| `pack_not_on_sale` | The pack is retired, back in draft after new terms, or not linked to the provider yet |
| `plan_change_pending` | A plan checkout, subscription change or other pack checkout of the business, made in the last 15 minutes, is still pending or processing: one purchase at a time, across packs and plans. A payment page already made holds nothing |

The same person asking again for the same pack and billing email while their checkout is pending or processing gets that checkout back.

## Switch between a pack and a subscription

A business can move either way, and minutes or allowances left at the switch are gone (decision 6). Each step acts only when a pack is involved.

- **Pack to subscription.** A pack business buys Starter or Pro through the plan checkout, which works for it as for Free, and whose dialog warns that starting a plan ends the packs and the minutes left on them. When the subscription goes live, `billing.reconcile` ends the business's live and frozen packs as `replaced`, records the minutes each still held, takes back a number release the last pack's end set, and starts the subscription's allowances from that moment, in the same transaction and under the same lock as the account.
- **Subscription to pack.** A subscriber on a monthly Starter or Pro plan buys a pack. When its payment arrives, one transaction adds the pack, marks the subscription as replaced (`billing_accounts.replaced_subscription_id`) so LobbyStack treats it as ended at once, starts the pack's monthly allowances from that moment, and queues `billing.endPlanForPack`. That job waits up to 32 minutes after the switch, the longest call and two minutes, for calls that began on the plan to end, unless the plan would renew first; sends the plan's usage still pending; then ends the subscription at the provider with nothing credited. On Stripe it ends at once: a plan that carries the overage prices, as with Stripe as the merchant of record, ends with `invoice_now`, so its last invoice bills the usage on its meters; on Stripe directly the plan ends alone, and its overage subscription ends with its month, whose invoice on the 1st bills the usage. On Polar it's set to cancel at its period's end, which the job moves to 5 minutes ahead, so the final order bills the usage. The job looks again every minute until the provider shows the plan ended, for up to an hour past the end, then tells the operator; the daily expiry job queues it again while the account still shows the plan live.
- **When the payment finds another plan.** A pack paid while a yearly, past-due or managed plan is in force, which the checkout refuses, leaves that plan alone, with an `ops.billing.pack_beside_subscription` warning in the logs. A subscription that started after the pack's purchase began is the business's latest choice, so the pack ends at once as `replaced`.
- **Fresh allowances only for a switch** (decision 6c). `billing_accounts.allowances_since` marks where the month's allowances start counting; only a switch with a pack writes it, so a business that moves from Free to Starter counts its whole month as before. Pack usage never counts against a subscription, since the pack paid for it, and a call stays in the part of the month it started in.

Worth knowing: a promo-code subscriber who switches to a pack loses the code for good, since a code is redeemed once per business; moving from Pro to a pack pauses all but one receptionist, as a downgrade does; and a business moving from a pack to Starter drops from 20 MB to 5 MB of knowledge: nothing is deleted, but uploads stop until it's under 5 MB.

## Know when a pack ends

The worker's `billing.expirePacks` runs once a day for every business that isn't canceled, and returns at once for one that never bought a pack. It also runs 35 minutes after a call's reservation takes the live balance to a fifth or to nothing, and at once when a refund or a dispute ends a pack. One run:

1. **Ends each pack whose end has come,** live or frozen, as `expired`, keeping the minutes it still held for the accounts.
2. **Settles the business's last pack.** When no live pack is left, nor a frozen one with time left, receptionists past what the plan includes pause, and on a plan without a number the number stops answering at once: calls are turned away and texts get no reply, as on a canceled account. The number goes back to Twilio 30 days after the last pack ended, unless a new pack or a subscription comes first, which clears the release and the number answers again. A pack a subscription replaced is never settled here.
3. **Emails the owners** in their language, English, French, Spanish or Serbian: when a fifth of the live balance is left, when none is, and 30 and 7 days before a pack ends. A reminder that would fall before the purchase is skipped, and `billing_packs.notices` keeps each pack's reminders to once. The balance reminders wait 35 minutes, past the longest call, so they read what the call used rather than what it reserved. A canceled business gets none.
4. **Queues `billing.endPlanForPack` again** for a subscription a pack replaced, while the account still shows it live.

## Know what refunds and disputes do

LobbyStack never refunds on its own and has no refund command (decision 5). The operator refunds in the Stripe or Polar dashboard, and whoever refunds, the provider's event changes the pack:

- **A partial refund** takes its share of the minutes bought off the pack: a refund of a third of the price removes a third of them. Minutes calls already used stay used, so a pack that used more than the refund leaves it has none left. The provider reports the whole amount refunded so far, so a repeated or late event never takes off more.
- **A refund of the whole payment** ends the pack as `refunded`.
- **A dispute opened** freezes the pack: calls can't draw on it until the dispute closes. Disputes come from Stripe only, since Polar sends no dispute event. A Stripe dispute names only the payment, so the webhook reads the payment intent back for its business; a dispute on a plan's payment stays unattributed, as before.
- **A dispute won** makes the pack live again, or expired if its end passed meanwhile. **A dispute lost** ends it as `refunded`.

A pack is matched by its Stripe PaymentIntent or Polar order, not by an invoice, since a pack sold with Stripe as the merchant of record has none.

## See packs in the API and the CLI

- `GET /v1/billing` lists the business's packs under `packs`: the live and frozen ones, the one that ends first first, then up to 20 that ended, the newest first, each with the seconds it holds after refunds, those used and those left, its payment, end date and status. `plan` reads `prepaid` on the prepaid tier, and a subscription a pack replaced reads as ended.
- `POST /v1/billing/packs/checkout` with the pack's code (`pack`, and `billing_email` when needed) answers 202 with a checkout, which `GET /v1/billing/packs/checkout/{checkout_id}` follows until it's `ready`, with `checkout_url` to send to whoever pays, then `paid`. Both need a key with `billing:manage`. A deployment whose provider isn't set up for packs answers 409, and a platform key's checkout is made out to the business's owner.
- `pnpm lobbystack billing buy-pack <pack>` does the same, with `--wait` for the page and `--billing-email`, and `pnpm lobbystack billing pack-status <checkout_id>` checks it. `pnpm lobbystack billing status` shows the packs after the plan, and with an operator's platform key `pnpm lobbystack billing catalog` lists the deployment's packs with their status, live price and link.
- `pnpm lobbystack onboard` accepts a live pack as a plan, and onboarding takes the number limit from the plan in force.
- The dashboard reads `packOffers`, `packs` and `packCheckout` from `GET /api/billing`, and starts and follows a checkout through `POST` and `GET /api/billing/packs/checkout`.

## Set it up on a deployment

1. **Deploy the admin and the worker first.** The apply sends the file through the instance's API, and an instance built before migration `0148` refuses a file with `packs`.
2. **Apply the catalog** once after the deploy: `pnpm billing apply --brand <brand> --stripe live` (or `--polar ...`). The packs section changes the file's hash, so the apply is needed even where no plan changed; every plan's terms hash stays as it was. Until then `pnpm billing verify` reports drift, while the daily catalog check only warns that the code was built with another file (`code_hash`). On Stripe the apply makes a product and a one-time price per pack, with the brands' SaaS tax code, and adds three events to the webhook endpoint: `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `charge.dispute.closed`. On Polar it makes a private one-time product per pack.
3. **Check it:** `pnpm billing verify` should report no drift, and the daily catalog check covers every pack.
4. **Polar needs no new token scope:** refunds stay in Polar's dashboard, and ending a plan a pack replaced uses the worker's `subscriptions:write`, as plan changes do.

Rolling back to a release before `0148` leaves the migration in place, and the older code reads none of its tables: a business on a pack falls back to the plan its account records, and the older worker runs none of the pack jobs, so no pack ends, reminds or ends a plan it replaced. The older release also trips over the packs: its `pnpm billing apply` refuses to run while the pack products and prices are live, unless `--allow-archive` archives them, and its daily catalog check fails on the `packs` of the profile last applied. Applying the file without `packs` before rolling back avoids both: it retires the packs and archives their provider objects, and packs already bought keep their minutes. That run needs `--allow-archive`, and `--allow-undeployed` too, since the running code was built with the file that has them. Otherwise, run the older release's `pnpm billing apply --allow-archive` once it's back: it archives the pack objects and stores its own file, though the pack rows stay as they were until a later release applies packs again.

## Know what isn't built or tried

- **Tried only in code.** The flows above have run against PostgreSQL with Stripe and Polar stood in for, not against a Stripe sandbox, a Polar sandbox or a real call. [Open items](../project/open-items.md#test-these) lists the runs still to make, among them the two the design asked for before live payments: a Stripe test-clock run that shows whether ending a merchant of record subscription with `invoice_now` bills the meters' usage, which the sandbox scenarios' `pack-plan-end` makes ([Stripe billing](../providers/stripe.md#run-the-sandbox-scenarios)), and a Polar sandbox run of the period moved ahead.
- **Known gaps.** LobbyStack doesn't read the expiry of a Polar checkout and takes its page to last an hour (`PACK_CHECKOUT_PAGE_MS`): past that the checkout reads as expired, though a payment that still lands adds the pack. A pack paid on a page opened before an operator gave the business a managed plan is kept, and waits unused while the managed plan lasts. A problem older than packs reaches them too: a plan's checkout needs `POLAR_ACCESS_TOKEN` and `POLAR_ORGANIZATION_ID` even on Stripe, so on a Stripe deployment without them neither the plan screens nor the API offer one, and a pack business there can't move to a subscription ([billing](../billing/README.md#know-the-known-problems)).
- **Left out of the first version:** automatic top-ups; holding a pack and a subscription at once; forwarding a call at zero minutes; a refund command; and an operator command that moves one business's end date.
