# Brands

Each folder here is one brand: its `brand.json` and the images it names. `index.json` maps apex domains to folders, and a deployment shows the brand that claims the domain of its `APP_BASE_URL`. `BRAND_PRESET` names a folder where no brand claims the domain, such as on `localhost`.

After any change here, run `pnpm brands:build` and commit what it writes. The repository is public, so everything in these folders is public too.

If a brand's name, contact address or website changes, update the sample HELP and START messages in that brand's SMS registration, because the replies carry them.

See [docs/branding.md](../docs/branding.md) for the fields and how a deployment picks its brand.
