# Brands

Each folder here is one brand: its `brand.json` and the images it names. `index.json` maps apex domains to folders, and a deployment shows the brand that claims the domain of its `APP_BASE_URL`. `BRAND_PRESET` names a folder where no brand claims the domain, such as on `localhost`.

After any change here, run `pnpm brands:build` and commit what it writes. The repository is public, so everything in these folders is public too.

If a brand's name, contact address or website changes, update the sample HELP and START messages in that brand's SMS registration, because the replies carry them.

See [docs/branding.md](../docs/branding.md) for the fields and how a deployment picks its brand.

## billing.json

A brand's `billing.json` holds its plans: the four standard ones (`free_cloud`, `starter`, `pro` and `enterprise`) and any others, each with its prices in one currency, what it includes and what usage past that costs. `brands/billing.schema.json` checks it as you type, and `pnpm brands:build` checks the rules the schema can't and writes its hash into the code. The admin never serves it.

It is public like the rest of this folder, so it never holds a key, a token, a webhook secret or a Polar product id. Keys, tokens and the webhook secret stay in environment variables, and the deployment's tables keep the product ids, so no product id variable is needed.

Every plan other than the four standard ones is one more key under `plans`. Its key is its permanent code: 3 to 48 lowercase letters, digits, `_` and `-`. It names the `tier` it behaves like (`starter` or `pro`), its `names` in every language, and its `prices`; any allowance, limit or overage rate it leaves out comes from its tier. Then:

- For a promo unlocked by a code, set `"access": "code"`, and `months` with `endsWith` for one that lasts a while: `tier` moves the subscription to its tier at the standard price when the months run out, `cancel` ends it, and `keep` lets the plan go on.
- For money off, add a `discount` (`percentage` in basis points or `fixed` in cents).
- For a new plan anyone can take, set `"access": "public"`, and for a private deal sent to one client, `"access": "hidden"`. Polar gets a public or private product for each, but the plan screens and checkout don't offer them yet: a public one shows only in Polar's billing portal, where plan changes are allowed. Sell an extra plan through a code for now.
- For a seasonal offer, set `offerEndsAt`; those who took it keep it.
- To stop offering a plan, remove its entry. Its row is retired, not deleted, so its subscribers keep it.

A plan's code is never reused for other terms. Once someone has subscribed, its terms can't change: put new terms under a new code.

Nothing reads the plans from the file at run time. After the change is merged and deployed, an operator's platform key writes it into the deployment's tables:

```bash
pnpm lobbystack billing catalog-preview alloplace --billing-file @brands/alloplace/billing.json
pnpm lobbystack billing catalog-apply alloplace --billing-file @brands/alloplace/billing.json --replaces-hash <hash from lobbystack billing catalog>
```

The preview changes nothing and lists every change, flagging any that lowers an allowance or raises a price. The first apply leaves out `--replaces-hash`, or passes `null` to stop if someone applied first. A change to a sold plan's terms, its prices included, sends the plan back to draft, and checkout stops selling it until Polar sells the new terms and a link records them, so for anything Polar sells, use `pnpm billing apply` (below), which does both in one run.

Once applied, the standard plans' allowances, overage rates, knowledge storage and included numbers are what the deployment enforces and what the plan and Usage pages show; until the first apply, it uses the ones its build ships with. A change counts for the whole current month: usage already recorded this month is measured against the new allowance, so lowering one can block a business at once. A business holds one number at most, so `businessNumbers` is 0 or 1: 1 lets it claim one.

### Promo codes

A plan whose `access` is `code` is sold only to a business that enters one of its codes. Codes never go in this file: an operator's platform key issues them on the deployment, once the plan is applied and `pnpm billing apply` has made its Polar product and discount.

```bash
pnpm lobbystack billing code-create pro_launch --max-uses 50 --expires-at 2026-12-31T00:00:00Z   # anyone may enter it
pnpm lobbystack billing code-create pro_launch --business-id <business id>                        # one business, once
pnpm lobbystack billing codes --plan pro_launch
pnpm lobbystack billing code-revoke <code id>
```

A code is made up as the brand's first letters and two groups of four, such as `ALLO-7K2Q-PX9M`, unless `--code` names one. A code anyone may enter needs a use limit and an end date. Each code comes with a link, `/signup?promo=CODE`: whoever opens it signs up, or signs in, and finds the code filled in on the plan screen, and **Have a promo code?** on onboarding and Settings > Plan takes one typed in. The checkout sells the plan's own Polar product with its discount, and a business that already pays has its subscription moved to it. Each business uses a code once: once it has subscribed with one, the code doesn't sell the plan to it again, even after the plan ends, though it still says the business is on the plan while it is. A business can try 10 codes an hour, and a person, an address or an API key 20 across businesses; a code that doesn't work, for any reason, only says it isn't valid. Revoking a code stops new checkouts; businesses already on its plan keep it.

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

A plan with `months` ends at the subscription's first renewal once they have run out, since the period before it was paid at the plan's price; a yearly subscription keeps it to the end of its year. A week before that renewal the worker emails the business's owners, in their language, what happens and when, and tells Polar: with `tier` the subscription moves to its tier's standard product without the plan's discount from that renewal, and with `cancel` it ends then. A change or cancellation the business already chose in Polar's billing portal stands. Polar's webhook moves the business off the plan once the renewal happens, and Settings > Plan shows the date and what comes next until then. An operator can end a plan early, at the next renewal, with `pnpm lobbystack billing end-promo-plan` (`DELETE /v1/billing/promo-plan`); its owners hear about it and Polar is told straight away, and a `keep` plan ended that way moves to its tier. A business that switches its plan in Polar's billing portal leaves its promo plan, and the worker removes the plan's discount, which Polar would otherwise carry over. Checkouts never take discount codes typed into Polar's page, so a discount comes only with a promo plan.

### Setting Polar up from it

`pnpm billing` does all of the above and Polar in one command: it applies the file to the tables, makes Polar's organization sell what the file says (settings, meters, products, discounts and the webhook; all but the settings and the webhook are tagged with `lobbystack_*` metadata), records which Polar product sells each price, and checks the three against each other. Products carry no Credits: the worker reports only the usage past each month's allowance, so a run takes any Credits off the brand's products. Credits taken off stay in Polar's Benefits list, on no product.

```bash
pnpm billing plan   --brand alloplace --polar sandbox            # shows what apply would change, changes nothing
pnpm billing apply  --brand alloplace --polar sandbox --railway-file railway.txt
pnpm billing verify --brand alloplace --polar sandbox            # exit 0 in sync, 1 drift, 2 a side couldn't be read
```

It reaches the instance with an operator's platform key, from a `lobbystack login` profile (`--profile`) or `LOBBYSTACK_URL` and `LOBBYSTACK_API_KEY`. `apply` needs a Polar setup token in `POLAR_SETUP_TOKEN` (organizations, meters, products, discounts and webhooks write); `plan` and `verify` take a read token in `POLAR_READ_TOKEN` (the same five objects, read). Without one it asks, with typing hidden, and it never saves a token. Make the tokens in Polar under Settings > Developers, in the organization the instance's `POLAR_ORGANIZATION_ID` names: a deployment stays with the Polar organization it was first linked to, and live payments get a deployment of their own.

- The first run on an organization `polar-setup.mjs` set up takes `--adopt`, which tags its meters and products, keeps their ids and takes its Credits off the monthly products. Without it, a lookalike stops the run, so a forgotten flag can't make duplicates.
- A file the instance's code wasn't built with needs `--allow-undeployed`, for trying it on a sandbox.
- Archiving a product or discount the file no longer has needs `--allow-archive`, and anything Polar can't change in place, such as a product's billing cycle, needs `--allow-replace`. Current subscribers keep their old price; edits made in Polar's dashboard are put back to the file.
- `--railway-file` saves `POLAR_API_BASE_URL` and `POLAR_ORGANIZATION_ID` to a new file, readable only by you, for `railway-vars.mjs`, as soon as Polar is set up. When this run made the webhook, the file also holds `POLAR_WEBHOOK_SECRET`, even if a later step stops the run, so delete it once Railway has the values. Run again with a new file name, or none.

A run that stops part-way is finished by running it again: everything is found again by its tags, and the webhook by its address. Nothing is deleted, in Polar or in the tables. The worker checks the same things once a day, records each check as a `verify` run (`lobbystack billing catalog-runs --kind verify`) and sends `ops.billing.profile_drift` to PostHog while they differ; its `POLAR_ACCESS_TOKEN` needs the five read scopes for that. The file's `polar.upgradeProration` and `polar.downgradeProration` say how Polar charges a paying business that picks another plan, which the worker does by changing its subscription; that token also needs `subscriptions:write`, which ending a promo plan uses too, and `customers:write`, with which each checkout finds or makes the business's own Polar customer.
