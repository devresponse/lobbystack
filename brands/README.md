# Brands

Each folder here is one brand: its `brand.json` and the images it names. `index.json` maps apex domains to folders, and a deployment shows the brand that claims the domain of its `APP_BASE_URL`. `BRAND_PRESET` names a folder where no brand claims the domain, such as on `localhost`. Where neither names one, a deployment shows the only folder besides `lobbystack`, if there's exactly one. There are two today, `alloplace` and `realinfobot`, so each deployment on such an address needs a `BRAND_PRESET`, or it shows LobbyStack.

After any change here, run `pnpm brands:build` and commit what it writes. The repository is public, so everything in these folders is public too.

If a brand's name, contact address or website changes, update the sample HELP and START messages in that brand's SMS registration, because the replies carry them.

See [docs/branding.md](../docs/branding.md) for the fields and how a deployment picks its brand.

## billing.json

A brand's `billing.json` holds its plans: the four standard ones (`free_cloud`, `starter`, `pro` and `enterprise`) and any others, each with its prices in one currency, what it includes and what usage past that costs. It may also hold [prepaid packs](#prepaid-packs), and the [words of the plan screens](#the-plan-screens-words). `brands/billing.schema.json` checks it as you type, and `pnpm brands:build` checks the rules the schema can't and writes its hash and its four standard plans into the code. The admin never serves the file.

It also holds the settings of the billing providers its deployments use: the `polar` block and the `stripe` block ([Stripe billing](../docs/providers/stripe.md)). An apply refuses a file without the block of its deployment's provider. Once a Stripe deployment is linked, an apply refuses a change to `stripe.overage` or `managedPayments` (`selling_mode_changed`): its customers' subscriptions were made that way. AlloPlace's and RealInfoBot's `stripe` blocks sell with Stripe as the merchant of record (`managedPayments`, with `overage` on the plan's checkout), so AlloPlace's Stripe deployments sell monthly prices only, while its Polar deployments sell the yearly ones too. RealInfoBot's file sells packs and no plan.

It is public like the rest of this folder, so it never holds a key, a token, a webhook secret or a Polar product id. Keys, tokens and the webhook secret stay in environment variables, and the deployment's tables keep the product ids, so no product id variable is needed.

Every plan other than the four standard ones is one more key under `plans`. Its key is its permanent code: 3 to 48 lowercase letters, digits, `_` and `-`. It names the `tier` it behaves like (`starter` or `pro`), its `names` in every language, and its `prices`; any allowance, limit or overage rate it leaves out comes from its tier. Then:

- For a promo unlocked by a code, set `"access": "code"`, and `months` with `endsWith` for one that lasts a while: `tier` moves the subscription to its tier at the standard price when the months run out, `cancel` ends it, and `keep` lets the plan go on.
- For money off, add a `discount` (`percentage` in basis points or `fixed` in cents).
- For a new plan anyone can take, set `"access": "public"`, and for a private deal sent to one client, `"access": "hidden"`. Polar gets a public or private product for each, but the plan screens and checkout don't offer them yet: a public one shows only in Polar's billing portal, where plan changes are allowed. Sell an extra plan through a code for now.
- For a seasonal offer, set `offerEndsAt`; those who took it keep it.
- To stop offering a plan, remove its entry. Its row is retired, not deleted, so its subscribers keep it.

A plan's code is never reused for other terms. Once someone has subscribed, its terms can't change and its `limits.receptionists` can't go down, directly or through its tier: put new terms or a lower number under a new code. It may include more receptionists.

Nothing reads the file at run time. A deployment that has never applied one shows and enforces the four standard plans its build carries, and sells them only through the `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variables; from the first apply on, its tables decide. After the change is merged and deployed, an operator's platform key writes it into those tables:

```bash
pnpm lobbystack billing catalog-preview alloplace --billing-file @brands/alloplace/billing.json
pnpm lobbystack billing catalog-apply alloplace --billing-file @brands/alloplace/billing.json --replaces-hash <hash from lobbystack billing catalog>
```

The preview changes nothing and lists every change, flagging any that lowers an allowance or raises a price. The first apply leaves out `--replaces-hash`, or passes `null` to stop if someone applied first. A change to a sold plan's terms, its prices included, sends the plan back to draft, and checkout stops selling it until Polar sells the new terms and a link records them, so for anything Polar sells, use `pnpm billing apply` (below), which does both in one run.

Once applied, the standard plans' allowances, overage rates, knowledge storage and included numbers are what the deployment enforces and what the plan and Usage pages show; until the first apply, it uses those of the file its build carries (fork PR #88), though a number claim counts one number on Starter and Pro and none on Free. A change counts for the whole current month: usage already recorded this month is measured against the new allowance, so lowering one can block a business at once. A business holds one number at most, so `businessNumbers` is 0 or 1: 1 lets it claim one.

### Prepaid packs

A pack is voice minutes a business pays for once and uses within a number of days of the payment. Each size and length is one more key under `packs`, with a price of its own, so the file decides which sizes and lengths are on sale. A file without `packs` sells none, and its plans' rows and provider objects stay exactly as they are. AlloPlace sells nine: 250, 500 and 1,000 minutes, each for 90, 180 or 365 days. RealInfoBot sells three listing packs instead of plans, with Starter and Pro kept in the file unsold, since every file holds the four standard plans ([the packs on sale](../docs/features/prepaid-packs.md#know-the-packs-on-sale)). [Prepaid packs](../docs/features/prepaid-packs.md) says what a business on a pack gets, how it buys one and when a pack ends.

```json
"pack_500_180": {
  "names": { "en": "500 minutes, 180 days", "fr": "500 minutes, 180 jours", "es": "500 minutos, 180 días", "sr": "500 minuta, 180 dana" },
  "minutes": 500,
  "days": 180,
  "priceCents": 9900,
  "limits": { "knowledgeStorageMb": 20 }
}
```

- The key is the pack's permanent code: 3 to 48 lowercase letters, digits, `_` and `-`, as a plan's. No plan may have it, whether in the file or only on the deployment, such as one made through the API, which an apply refuses as `code_taken`. A file holds at most 30 packs.
- Each pack needs `names` in all four languages, up to 60 characters each, `minutes` from 1 to 100,000, and `priceCents` up to 10,000,000, which is paid once, in the file's `currency`; on Stripe it's the price before tax. A pack has no overage rates.
- `days` runs from the payment, 1 to 1,095. A pack without `days` never ends.
- `included` (`alertSmsSegments` and `outboundCallAttempts` up to 100,000, `chatAiUnits` up to 1,000,000) is what a business on the pack gets each UTC month, and `limits` (`knowledgeStorageMb` up to 1,024, `businessNumbers` 0 or 1, `receptionists` 1 to 50) what it may have while the pack lasts. Whatever a pack leaves out comes from the file's Starter, so changing that in Starter changes the pack's terms too.
- Packs are listed by minutes, then length, a pack without `days` last.

Once a pack has been bought, its minutes and length can't change: an apply refuses it (`plan_frozen`), so put new minutes or a new length under a new code. Its names, price, monthly allowances and limits may change. Any change but a name is new terms, which takes the pack off sale until `pnpm billing apply` has the provider sell them and links it again. Stripe never changes a price, so there new terms make a new price, and a pack already linked needs `--allow-archive` for the old price and `--allow-replace` to link the new one ([Stripe billing](../docs/providers/stripe.md#know-what-apply-makes-for-packs)); Polar keeps the pack's own product, with a new price on it when the price changes ([Polar billing](../docs/providers/polar.md#create-the-hosted-products)). To stop selling a pack, remove its entry: its row is retired, not deleted, and `pnpm billing apply` archives its provider object only with `--allow-archive`, refusing to run without it. Packs already bought keep their minutes, and a pack put back in the file gets its row, its price and its provider object back.

`pnpm billing apply` makes each pack a product of its own at the provider, after everything the plans need, and links it: a one-time price on Stripe ([Stripe billing](../docs/providers/stripe.md#know-what-apply-makes-for-packs)), a private one-time product on Polar ([Polar billing](../docs/providers/polar.md#create-the-hosted-products)). A pack is on sale once that link has made it active. Deploy the code first: an instance built before migration `0148` refuses a file with `packs`. `lobbystack billing catalog` lists the packs with the plans.

### The plan screens' words

The optional `display` section holds the words and the layout of the onboarding plan step (`/onboarding/plan`) and of the **Upgrade plan** dialog the dashboard opens from Settings > Plan and elsewhere: which plans get a card and in what order, the popular one, the tab they open on, the cards' words and bullets, the comparison table and the prepaid packs' box. A file without it shows the built-in screens, and the screens use their built-in words for whatever it leaves out. RealInfoBot's shows the Free card alone, with no tabs and no comparison table, and words the packs' box for its listing packs. The tests' example file, `packages/shared/src/brands/testing/plans-and-packs.billing.json`, has a section that copies the built-in words for all four plans.

It sells nothing. The file's hash, the apply, `pnpm billing verify` and the daily check leave it out, and `pnpm billing` and `lobbystack billing catalog-preview` and `catalog-apply` leave it out of what they send, so a deployment built before the section still takes the file. `pnpm brands:build` writes it into the code beside the plans, and `GET /api/billing` hands the deployment's own to the screens as `planDisplay`, so a change goes live with the next deploy, with no apply. The numbers always come from the plan list, the catalog's after an apply: a bullet or a row that names an allowance prints that plan's own, so an apply that changes it changes the screens too.

```json
"display": {
  "defaultInterval": "annual",
  "plans": [
    { "plan": "free_cloud", "bullets": ["voiceMinutes", "receptionists", "businessNumbers", { "en": "Community support", "fr": "Support communautaire", "es": "Soporte de la comunidad", "sr": "Podrška zajednice" }] },
    { "plan": "pro", "popular": true,
      "description": { "en": "Includes {{voiceMinutes}} voice minutes, then {{voiceMinuteRate}} a minute.", "fr": "...", "es": "...", "sr": "..." },
      "button": { "monthly": { "en": "Go Pro monthly", "fr": "...", "es": "...", "sr": "..." }, "annual": { "en": "Go Pro annual", "fr": "...", "es": "...", "sr": "..." } },
      "bullets": ["voiceMinutes", "receptionists", "businessNumbers", "alertSmsSegments"] }
  ],
  "comparison": [
    { "group": { "en": "Usage & limits", "fr": "...", "es": "...", "sr": "..." },
      "rows": ["voiceMinutes", { "row": "outboundCallAttempts", "values": { "free_cloud": false } }, "contentRetention"] },
    { "group": { "en": "Booking", "fr": "...", "es": "...", "sr": "..." },
      "rows": [{ "label": { "en": "Appointment confirmation texts", "fr": "...", "es": "...", "sr": "..." }, "values": { "free_cloud": false, "pro": true } }] }
  ]
}
```

- `plans` lists the cards in their order, which is also the order of the comparison's columns: `free_cloud`, `starter`, `pro` or `enterprise`, each once. A plan left out gets neither a card nor a column. `popular` marks one card at most, with the badge on the card and its column. A Starter or Pro card needs the plan sold in the file; Free and Enterprise are never sold and may always have one.
- A card's `description` and `button` are one text for both tabs, or a `monthly` and an `annual` one. Its `bullets`, 1 to 12, are each an allowance's name or a text.
- An allowance's name prints the plan's number in the visitor's language with its plural: `voiceMinutes` (with the overage rate, and as browser minutes on a plan without a business number), `receptionists`, `businessNumbers` ("No telephone number" at 0), `alertSmsSegments`, `outboundCallAttempts` (transfer attempts), `chatAiUnits` (website chats) and `knowledgeStorage`. A custom allowance says so, as Enterprise's do.
- `defaultInterval` is the tab the screens open on, `monthly` or `annual`, where a plan can be bought on it. A tab shows only where a plan with a card has a price for it, so a deployment selling monthly prices only, as on Stripe as the merchant of record, shows no Annual tab.
- `comparison` lists the table's groups, up to 12, each with its `group` name and 1 to 40 `rows`. A row is a name the page fills, an allowance or `contentRetention` (how long transcripts and recordings are kept) or `shortCalls` (calls too short to bill), both from the code that enforces them; or such a name with its own `label` and some plans' `values`; or a row of the brand's own, a `label` with a value for every plan with a card. A value is `true`, `false`, `"unlimited"`, `"custom"`, `"multiple"` or a text. Without `comparison` the built-in table shows, with a column for each card, and an empty list shows no comparison. `comparisonTitle` and `comparisonIntro` replace the title and the line under it.
- `packs` holds the `title`, `description` and `button` of the prepaid packs' box on the plan step.

Every text has all four languages, `en`, `fr`, `es` and `sr`, up to 300 characters each. A text can print values as `{{name}}`. Text about one plan, its card and its cells, names them bare: its allowances, as above, its rates `voiceMinuteRate`, `alertSmsSegmentRate` and `outboundCallAttemptRate`, and `appName`. Text about the whole page, the group names, labels, title, intro and packs' box, names the plan first, such as `{{free_cloud.voiceMinutes}}`. A custom allowance prints the word for custom, and a rate the plan doesn't bill prints a dash.

What stays in the code: the plans' names, Starter and Pro, which the checkout and receipts use; the prices, the Annual tab's badge and which intervals can be bought, from the plan list; "/mo", Enterprise's "Custom" price and its **Contact us** mail to the brand's sales address; and in the **Upgrade plan** dialog, the short line under each price and the buttons, which follow the business's current plan. The dialog shows the cards, their order, the popular one, the opening tab and the bullets from the section.

`pnpm brands:build` refuses a section with a language missing, an unknown plan, allowance or field, a plan's second card, a second popular card, a Starter or Pro card the file doesn't sell, an unknown `{{name}}`, a value for a plan without a card, or a row of the brand's own without a value for a plan with a card.

### Promo codes

A plan whose `access` is `code` is sold only to a business that enters one of its codes. Codes never go in this file: an operator's platform key issues them on the deployment, once the plan is applied and `pnpm billing apply` has made its Polar product and discount.

```bash
pnpm lobbystack billing code-create pro_launch --max-uses 50 --expires-at 2026-12-31T00:00:00Z   # anyone may enter it
pnpm lobbystack billing code-create pro_launch --business-id <business id>                        # one business, once
pnpm lobbystack billing codes --plan pro_launch
pnpm lobbystack billing code-revoke <code id>
```

A code is made up as the brand's first letters and two groups of four, such as `ALLO-7K2Q-PX9M`, unless `--code` names one. A code anyone may enter needs a use limit and an end date. Its open checkouts count toward the limit for a day, as long as Polar keeps a checkout page, so its last use goes to one business's checkout at a time. Each code comes with a link, `/signup?promo=CODE`: whoever opens it signs up, or signs in, and finds the code filled in on the plan screen, and **Have a promo code?** on onboarding and Settings > Plan takes one typed in. The checkout sells the plan's own Polar product with its discount, and a business that already pays has its subscription moved to it. Each business uses a code once: once it has subscribed with one, the code doesn't sell the plan to it again, even after the plan ends, though it still says the business is on the plan while it is. A business can try 10 codes an hour, and a person, an address or an API key 20 across businesses, with the keys that act for a person counting toward that person's 20; a code that doesn't work, for any reason, only says it isn't valid. Revoking a code stops new checkouts; businesses already on its plan keep it.

A promo plan can include more, or less, than its tier. Whatever it sets under `included`, `limits` and `overageCents` is what a business on it gets: the rates on its own Polar product, and the usage limits, spending cap, knowledge storage and number check the deployment enforces, as the plan and Usage pages show. Anything it leaves out comes from its tier, and its features and data retention are always its tier's. Usage counts under the plan it was used on, so a business that moves onto or off a promo plan in the middle of a month keeps each part of the month on the terms it was used under. For example, a Starter plan with twice the minutes and storage, for one code:

```json
"salons-plus": {
  "tier": "starter",
  "access": "code",
  "sold": true,
  "names": { "en": "Salons Plus", "fr": "Salons Plus", "es": "Salons Plus", "sr": "Salons Plus" },
  "prices": { "monthlyCents": 3000 },
  "included": { "voiceMinutes": 300 },
  "limits": { "knowledgeStorageMb": 10 }
}
```

A plan with `months` ends at the subscription's first renewal once they have run out, since the period before it was paid at the plan's price; a yearly subscription keeps it to the end of its year. A week before that renewal the worker emails the business's owners, in their language, what happens and when, and tells Polar: with `tier` the subscription moves to its tier's standard product without the plan's discount from that renewal, and with `cancel` it ends then. A change or cancellation the business already chose in Polar's billing portal stands, and a subscription that has already left the plan's product, such as after an upgrade, is left as it is. Polar's webhook moves the business off the plan once the renewal happens, and Settings > Plan shows the date and what comes next until then. An operator can end a plan early, at the next renewal, with `pnpm lobbystack billing end-promo-plan` (`DELETE /v1/billing/promo-plan`); its owners hear about it and Polar is told straight away, and a `keep` plan ended that way moves to its tier. A business that switches its plan in Polar's billing portal leaves its promo plan, and the worker removes the plan's discount, which Polar would otherwise carry over. Checkouts never take discount codes typed into Polar's page, so a discount comes only with a promo plan.

### Setting Polar up from it

`pnpm billing` does all of the above and Polar in one command: it applies the file to the tables, makes Polar's organization sell what the file says (settings, meters, products, discounts and the webhook; all but the settings and the webhook are tagged with `lobbystack_*` metadata), records which Polar product sells each price, and checks the three against each other. Products carry no Credits: the worker reports only the usage past each month's allowance, so a run takes any Credits off the brand's products. Credits taken off stay in Polar's Benefits list, on no product. Annual products invoice that overage each month, on a meter cycle of their own.

```bash
pnpm billing plan   --brand alloplace --polar sandbox            # shows what apply would change, changes nothing
pnpm billing apply  --brand alloplace --polar sandbox --railway-file .env.railway
pnpm billing verify --brand alloplace --polar sandbox            # exit 0 in sync, 1 drift, 2 a side couldn't be read
```

It reaches the instance with an operator's platform key, from a `lobbystack login` profile (`--profile`) or `LOBBYSTACK_URL` and `LOBBYSTACK_API_KEY`. `apply` needs a Polar setup token in `POLAR_SETUP_TOKEN` (organizations, meters, products, discounts and webhooks write); `plan` and `verify` take a read token in `POLAR_READ_TOKEN` (the same five objects, read). Without one it asks, with typing hidden, and it never saves a token. Make the tokens in Polar under Settings > Developers, in the organization the instance's `POLAR_ORGANIZATION_ID` names: a deployment stays with the Polar organization it was first linked to, and live payments get a deployment of their own.

- The first run on an organization `polar-setup.mjs` set up takes `--adopt`, which tags its meters and monthly products, keeps their ids and takes their Credits off, and `--allow-replace`, which replaces its annual products: they invoice overage once a year, and Polar never adds a meter cycle to a product. Without them, a lookalike stops the run, so a forgotten flag can't make duplicates.
- A file the instance's code wasn't built with needs `--allow-undeployed`, for trying it on a sandbox.
- Archiving a product or discount the file no longer has needs `--allow-archive`, and anything Polar can't change in place, such as a product's billing or meter cycle, needs `--allow-replace`. Current subscribers keep their old price; edits made in Polar's dashboard are put back to the file.
- `--railway-file` saves `POLAR_API_BASE_URL` and `POLAR_ORGANIZATION_ID` to a new file, readable only by you, for `railway-vars.mjs`, as soon as Polar is set up. A name like `.env.railway`, as above, keeps it out of commits, since Git ignores `.env.*`. When this run made the webhook, the file also holds `POLAR_WEBHOOK_SECRET`, even if a later step stops the run, so delete it once Railway has the values. Run again with a new file name, or none.

A run that stops part-way is finished by running it again: everything is found again by its tags, and the webhook by its address. Nothing is deleted, in Polar or in the tables. The worker checks the same things once a day, records each check as a `verify` run (`lobbystack billing catalog-runs --kind verify`) and sends `ops.billing.profile_drift` to PostHog while they differ; its `POLAR_ACCESS_TOKEN` needs four read scopes for that: organizations, meters, products and discounts. It leaves out the webhook, which Polar lists with its signing secret, so that token goes without `webhooks:read`, and `pnpm billing verify` checks the webhook and its secret. The file's `polar.upgradeProration` and `polar.downgradeProration` say how Polar charges a paying business that picks another plan, which the worker does by changing its subscription; that token also needs `subscriptions:write`, which ending a promo plan uses too, and `customers:write`, with which each checkout finds or makes the business's own Polar customer.
