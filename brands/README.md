# Brands

Each folder here is one brand: its `brand.json` and the images it names. `index.json` maps apex domains to folders, and a deployment shows the brand that claims the domain of its `APP_BASE_URL`. `BRAND_PRESET` names a folder where no brand claims the domain, such as on `localhost`.

After any change here, run `pnpm brands:build` and commit what it writes. The repository is public, so everything in these folders is public too.

If a brand's name, contact address or website changes, update the sample HELP and START messages in that brand's SMS registration, because the replies carry them.

See [docs/branding.md](../docs/branding.md) for the fields and how a deployment picks its brand.

## billing.json

A brand's `billing.json` holds its plans: the four standard ones (`free_cloud`, `starter`, `pro` and `enterprise`) and any others, each with its prices in one currency, what it includes and what usage past that costs. `brands/billing.schema.json` checks it as you type, and `pnpm brands:build` checks the rules the schema can't and writes its hash into the code. The admin never serves it.

It is public like the rest of this folder, so it never holds a key, a token, a webhook secret or a Polar product id. Those stay in environment variables, and the deployment's tables keep the product ids.

Every plan other than the four standard ones is one more key under `plans`. Its key is its permanent code: 3 to 48 lowercase letters, digits, `_` and `-`. It names the `tier` it behaves like (`starter` or `pro`), its `names` in every language, and its `prices`; any allowance, limit or overage rate it leaves out comes from its tier. Then:

- For a promo unlocked by a code, set `"access": "code"`, and `months` with `endsWith` for one that lasts a while.
- For money off, add a `discount` (`percentage` in basis points or `fixed` in cents).
- For a new plan anyone can take, set `"access": "public"`.
- For a private deal sent to one client, set `"access": "hidden"`.
- For a seasonal offer, set `offerEndsAt`; those who took it keep it.
- To stop offering a plan, remove its entry. Its row is retired, not deleted, so its subscribers keep it.

A plan's code is never reused for other terms. Once someone has subscribed, its terms can't change: put new terms under a new code.

Nothing reads the plans from the file at run time. After the change is merged and deployed, an operator's platform key writes it into the deployment's tables:

```bash
pnpm lobbystack billing catalog-preview alloplace --billing-file @brands/alloplace/billing.json
pnpm lobbystack billing catalog-apply alloplace --billing-file @brands/alloplace/billing.json --replaces-hash <hash from lobbystack billing catalog>
```

The preview changes nothing and lists every change, flagging any that lowers an allowance or raises a price. The first apply leaves out `--replaces-hash`, or passes `null` to stop if someone applied first.

Once applied, the standard plans' allowances, overage rates, knowledge storage and included numbers are what the deployment enforces and what the plan and Usage pages show; until the first apply, it uses the ones its build ships with. A change counts for the whole current month: usage already recorded this month is measured against the new allowance, so lowering one can block a business at once.

### Setting Polar up from it

`pnpm billing` does all of the above and Polar in one command: it applies the file to the tables, makes Polar's organization sell what the file says (settings, meters, Credits, products, discounts and the webhook, each tagged with `lobbystack_*` metadata), records which Polar product sells each price, and checks the three against each other.

```bash
pnpm billing plan   --brand alloplace --polar sandbox            # shows what apply would change, changes nothing
pnpm billing apply  --brand alloplace --polar sandbox --railway-file railway.txt
pnpm billing verify --brand alloplace --polar sandbox            # exit 0 in sync, 1 drift, 2 a side couldn't be read
```

It reaches the instance with an operator's platform key, from a `lobbystack login` profile (`--profile`) or `LOBBYSTACK_URL` and `LOBBYSTACK_API_KEY`. `apply` needs a Polar setup token in `POLAR_SETUP_TOKEN` (organizations, meters, benefits, products and webhooks write, plus discounts write once a plan has a discount); `plan` and `verify` take a read token in `POLAR_READ_TOKEN` (the same six objects, read). Without one it asks, with typing hidden, and it never saves a token. Make the tokens in Polar under Settings > Developers, in the organization the instance's `POLAR_ORGANIZATION_ID` names: a deployment stays with the Polar organization it was first linked to, and live payments get a deployment of their own.

- The first run on an organization `polar-setup.mjs` set up takes `--adopt`, which tags its meters, Credits and products and keeps their ids. Without it, a lookalike stops the run, so a forgotten flag can't make duplicates.
- A file the instance's code wasn't built with needs `--allow-undeployed`, for trying it on a sandbox.
- Fewer included minutes or texts need `--allow-less`, archiving a product or discount the file no longer has needs `--allow-archive`, and anything Polar can't change in place, such as a product's billing cycle, needs `--allow-replace`. Current subscribers keep their old price; edits made in Polar's dashboard are put back to the file.
- `--railway-file` saves the Polar variables to a new file, readable only by you, for `railway-vars.mjs`; it holds the webhook secret only when this run made the webhook, so delete it once Railway has the values.

A run that stops part-way is finished by running it again: everything is found by its tags. Nothing is deleted, in Polar or in the tables. The worker checks the same things once a day, records each check as a `verify` run (`lobbystack billing catalog-runs --kind verify`) and sends `ops.billing.profile_drift` to PostHog while they differ; its `POLAR_ACCESS_TOKEN` needs the six read scopes for that. The file's `polar.upgradeProration` and `polar.downgradeProration` say how Polar charges a paying business that picks another plan, which the worker does by changing its subscription; that token also needs `subscriptions:write`.
