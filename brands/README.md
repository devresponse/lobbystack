# Brands

Each folder here is one brand: its `brand.json` and the images it names. `index.json` maps apex domains to folders, and a deployment shows the brand that claims the domain of its `APP_BASE_URL`. `BRAND_PRESET` names a folder where no brand claims the domain, such as on `localhost`.

After any change here, run `pnpm brands:build` and commit what it writes. The repository is public, so everything in these folders is public too.

If a brand's name, contact address or website changes, update the sample HELP and START messages in that brand's SMS registration, because the replies carry them.

See [docs/branding.md](../docs/branding.md) for the fields and how a deployment picks its brand.

## billing.json

A brand's `billing.json` holds its plans: the four standard ones (`free_cloud`, `starter`, `pro` and `enterprise`) and any others, each with its prices in one currency, what it includes and what usage past that costs. `brands/billing.schema.json` checks it as you type, and `pnpm brands:build` checks the rules the schema can't and writes its hash into the code. The admin never serves it.

It is public like the rest of this folder, so it never holds a key, a token, a webhook secret or a Polar product id. Those stay in environment variables, and the next billing PR keeps product ids in the database.

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
