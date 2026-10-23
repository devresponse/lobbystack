# Brand a deployment

A deployment can show its own app name, logo and colour instead of LobbyStack's, and send its outside links to its own website. Each brand is a folder under `brands/`, and a deployment's address picks one. This page covers how to add a brand, how the admin and worker pick which to show, and where the LobbyStack brand still appears.

## Brand files

A brand is a folder under `brands/` with a `brand.json` and its logo. `brands/index.json` maps apex domains to folders and names the default:

```json
{
  "default": "lobbystack",
  "domains": {
    "alloplace.com": "alloplace",
    "alloplace.ai": "alloplace"
  }
}
```

| Field in `brand.json` | Accepted values | Without it |
| --- | --- | --- |
| `appName` (required) | 1 to 40 characters once whitespace is collapsed, with no control or format characters. | |
| `logo` | A PNG, JPEG, WebP or plain SVG file in the folder, up to 256 KB, checked like an uploaded logo. | The name on its own. |
| `emailLogo` | A PNG in the folder, up to 256 KB, shown 48 pixels tall above the name in HTML emails. Make it twice that, 96 pixels tall, for sharp screens. | The name on its own. |
| `ogImage` | A PNG in the folder, up to 256 KB, that link previews show for the admin's pages. 1200 by 630 pixels suits most sites. | No picture in previews. |
| `accentColor` | `#rgb` or `#rrggbb`. | The website widget's teal, `#0f766e`. |
| `links.site`, `links.docs` | An `http://` or `https://` URL without credentials, a query, or a fragment. | LobbyStack's site and docs. |
| `links.terms`, `links.privacy` | An `http://` or `https://` URL without credentials. | `/terms` and `/privacy` on the site. |
| `contactEmail` | A plain address, such as `support@example.com`. | LobbyStack's address for each place. |
| `environments` | Settings by host label, such as `"dev*": { "appNameSuffix": " (dev)", "indexing": false }`. A pattern ending in `*` matches any first label that starts with it. | The plain brand on every host. |

`brands/brand.schema.json` and `brands/index.schema.json` give editors completion and checks.

After changing anything under `brands/`, run `pnpm brands:build`. It checks every brand, then writes `packages/shared/src/brands/generated.ts`, copies each image to `apps/admin/public/brand/<id>/`, and refreshes the schemas. `scripts/brands.test.ts` fails when any of them falls behind `brands/`, and the build refuses a brand with a problem, listing every one.

The repository is public, so everything in a brand folder is public too.

### Billing

A brand folder can also hold a `billing.json`: the plans the brand sells, their prices, allowances and overage rates, and any promo plans. `pnpm billing apply` writes it to the deployment's billing catalog and sets Polar up to match, and `pnpm billing verify` checks that the three still agree. [`brands/README.md`](../brands/README.md) describes the file and the commands. The file holds no keys and no Polar product ids: the catalog keeps the ids it links, so the four `POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID` variables aren't needed. Until a deployment applies a `billing.json`, it shows this build's built-in plans in US dollars.

### How a deployment picks its brand

The admin and the worker resolve the brand once when they start (`packages/shared/src/brands/resolve.ts`):

1. The brand whose domain the host of `APP_BASE_URL` sits under. `dev01.alloplace.com`, `demo.alloplace.com` and `alloplace.com` all get AlloPlace. Domains match whole labels, so `notalloplace.com` doesn't.
2. Where no brand claims the domain, `BRAND_PRESET`, which names a folder, such as `alloplace`. Use it for `localhost` and for platform addresses such as `*.up.railway.app`. On a claimed domain it has no effect, and both services log `brand.preset_ignored` at start.
3. Otherwise the default brand, LobbyStack. Only then does the choice the first owner saved in onboarding, one row in `public.deployment_branding`, set the name and logo.

Earlier releases let `BRAND_APP_NAME`, `BRAND_LOGO_URL`, `BRAND_ACCENT_COLOR`, `NEXT_PUBLIC_LANDING_SITE_URL`, `NEXT_PUBLIC_TERMS_URL`, `NEXT_PUBLIC_PRIVACY_URL`, `NEXT_PUBLIC_DOCS_SITE_URL` and `NEXT_PUBLIC_CONTACT_EMAIL` override the brand file. They no longer do anything, so put their values in a brand folder.

When the matched host's first label matches an `environments` pattern, its settings apply: `appNameSuffix` is added to the name everywhere, emails and texts included, and `"indexing": false` keeps search engines away from every page.

At start, each service logs the brand it picked, such as `[brand] alloplace (apex alloplace.com), shown as AlloPlace`. In production it also logs `brand.unmatched` when no brand claims the address, and `brand.base_url_missing` when `APP_BASE_URL` is missing or isn't a URL and no `BRAND_PRESET` names a brand. Set `BRAND_REQUIRED=true` to make the admin and worker refuse to start instead. The admin's `/api/health/ready` reports the brand's id and how it was picked.

### Add a brand

1. Make a folder under `brands/` named for the brand, in lowercase letters, digits and dashes, with its `brand.json` and logo.
2. Claim its apex domains in `brands/index.json`.
3. Run `pnpm brands:build` and commit what it writes.
4. Deploy with `APP_BASE_URL` on that domain. Set `APP_BASE_URL` on both the admin and the worker, and give it to the admin's Docker build: `Dockerfile.admin` takes it as a build argument, and on Railway the admin's service variables reach its build.

### The onboarding step

On a deployment no brand file matches, the first owner sees a **Make this app your own** step before naming their business. It never appears where a brand file matches, and `POST /api/branding/initial` answers 409 there. The owner can type a name, upload a logo, or skip. Skipping saves an empty row, which keeps LobbyStack and ends the choice.

The step is shown only when both of these are true. `app.can_save_initial_branding()` checks them in the database, and `app.save_initial_branding()` checks them again when the choice is saved:

- No branding has been saved yet.
- The person owns every business on the deployment. A fresh deployment has no businesses, so the first person to sign up qualifies. Someone on a deployment that already serves another person's business never does.

Uploaded logos can be PNG, JPEG, WebP, or SVG files of up to 256 KB. The admin works out the type from the file's bytes rather than its name. It refuses any SVG that contains script, event handlers, `foreignObject`, embedded documents, or entity declarations. The logo route also serves every saved logo under `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox` with `nosniff`, so an image opened on its own can't run anything.

### Change the branding later

On a deployment a brand file matches, edit the brand file and redeploy.

Elsewhere, there's no settings page for this yet. Delete the saved row as the database superuser, because the runtime roles can't write the table, and open `/onboarding/brand` as the owner of every business:

```sql
DELETE FROM public.deployment_branding;
```

The admin caches the saved row for 30 seconds, so other admin replicas pick up a change within that time. A brand file is part of the build, so every replica always shows the same one.

## Where the name and logo appear

- The browser tab's title and icon on every admin page: the dashboard, sign-in and sign-up, onboarding, and the website widget's frame. The logo is the tab icon, so a square logo works best.
- The picture in link previews of those pages, from the brand file's `ogImage`. A business's public profile page has its own preview, without it.
- The logo and name above the sign-in, sign-up, password reset, invitation, email change, verification, OAuth consent, and onboarding pages.
- The header of the public demo page.
- The foot of each business's [public profile page](../mintlify/settings/public-profile.mdx) at `/profile/<slug>`, after "Answered by", and of the page a visitor gets for a profile that isn't published. Both link to the website.
- Every dashboard string in all four languages that used to say LobbyStack: 21 strings, which now use the `{{appName}}` i18n variable.

A deployment still named LobbyStack with no logo of its own shows LobbyStack's mark. A renamed deployment with no logo shows its name on its own, so LobbyStack's mark never appears beside another name.

## Emails and texts

Every email and text the app sends calls it by the same name as the dashboard: verification codes, password resets, email changes, invitations, the "account was made for you" and "you already have an account" emails, the founder check-in, alert emails, the SMS HELP and START replies, and the operator's phone verification code. The text a caller gets when they change an appointment opens with the business's name instead, since the caller phoned the business, and falls back to the app name when the business has none.

`deploymentAppName()` in `packages/domain/src/server/branding.ts` resolves the name in the same order as the dashboard: a matched brand file, then the saved onboarding choice, then the default brand. It caches the saved choice for 30 seconds and uses the default brand when the database can't be read. The admin builds email subjects and SMS replies with it, and the worker renders email bodies and sends the codes with it, so **set `APP_BASE_URL` on the worker as well as the admin**: the worker picks its brand from it the same way.

Every email except the founder check-in and dashboard feedback has an HTML version whose header shows the name as a wordmark, under the brand file's `emailLogo` when it has one. The logo has to be a PNG, because Gmail and Outlook don't show SVG, and it loads from the admin at `APP_BASE_URL`, so the worker needs that address to show it. Some mail clients hide remote images until the reader allows them, which is why the name stays as text.

When `EMAIL_FROM` holds only an address and a brand file matches, the worker puts the brand's name in front of it, as in `"AlloPlace" <no-reply@alloplace.com>`. A name already in `EMAIL_FROM` stays as it is. Without `EMAIL_FROM`, the worker sends as `"<app name>" <no-reply@localhost>`.

The SMS HELP and START replies are part of the registered SMS campaign or toll-free verification, so update the registration's sample messages when the name changes.

The consent text for operator alert texts uses the app name too (`OPERATOR_SMS_DISCLOSURE_TEMPLATE` and `operatorSmsDisclosureText()` in `packages/shared/src/operatorSmsConsent.ts`, and `settings:notifications.phoneVerification.*.consent`). Each opt-in records the disclosure's version, `operator-alerts-2026-10-17` since the name became configurable; consent given under earlier versions stays valid. A test in `apps/admin/src/lib/locale-parity.test.ts` fails if any dashboard string names LobbyStack.

## Send the outside links to your own site

The admin also links to pages outside itself: the website, the terms of service and privacy policy, the docs, and an address to write to. The brand file's `links` and `contactEmail` point them at the brand's own site and inbox, with the values the [brand file table](#brand-files) accepts:

| Link | Field in `brand.json` | Without it |
| --- | --- | --- |
| Website | `links.site` | `https://lobbystack.com` |
| Terms of service | `links.terms` | `/terms` on the website |
| Privacy policy | `links.privacy` | `/privacy` on the website |
| Docs | `links.docs` | `https://docs.lobbystack.com` |
| Contact address | `contactEmail` | LobbyStack's address for each place: `support@lobbystack.com` in the feedback panel, `hello@lobbystack.ai` for Enterprise plans, and `hello@lobbystack.com` in text messages. |

Where each one appears:

- **Website**: the logo on the public demo page, the "visit" link in the SMS HELP reply, and the terms and privacy links when the brand file has no page for them. On lobbystack.com the links open the page in the reader's language, under `/fr/`, `/es/`, or `/sr/`. Any other site gets the same path in every language, such as `/terms`.
- **Terms and privacy**: the links under the sign-up form and at the foot of onboarding, and the affiliate program's terms link. With `links.terms` set, the affiliate link opens the top of that page, since only LobbyStack's terms have an `#affiliate-program` section.
- **Docs**: the "see docs" and Help Center links in the dashboard's feedback panel, and `resource_documentation` in the MCP server's OAuth metadata, which adds `/ai/mcp`.
- **Contact address**: the feedback panel's "Contact us" link, the Enterprise plan's contact button in onboarding and billing, and both SMS HELP replies. The HELP reply is part of the registered A2P 10DLC campaign, so update the campaign when the address or the website changes.

### The brand is part of the build

`next.config.ts` writes the address and preset the brand comes from into the admin's build, both the browser's code and the server's, as `NEXT_PUBLIC_BRAND_BASE_URL` and `NEXT_PUBLIC_BRAND_PRESET`. The server and the browser always agree, and a change takes a rebuild. When the admin starts with an `APP_BASE_URL` or `BRAND_PRESET` that would pick another brand than its build did, it logs `brand.build_mismatch`: rebuild it.

alloplace.com has no docs yet, so AlloPlace's docs links open its home page, and the MCP metadata's `/ai/mcp` page doesn't exist there.

`packages/shared/src/brandLinks.ts` holds the checks and LobbyStack's defaults. `apps/admin/src/lib/marketing-site-url.ts` builds the website, terms, and privacy links.

## Color the public pages

Businesses' public profile pages put one color behind the chat, or behind the call card when a business has no chat, and on today's row of the opening hours. The brand file's `accentColor` sets it. Text on it is black or white, whichever contrasts more, so AlloPlace's yellow, `#FFD100`, gets black text. Without it, the pages use the website widget's default teal, `#0f766e`.

## How it works

- `brands/`: the brand folders and the domain index. `packages/shared/src/brands/schema.ts` checks and compiles them; `scripts/write-brands.ts` writes `packages/shared/src/brands/generated.ts`; `packages/shared/src/brands/resolve.ts` picks the brand (`resolveBrand`, `currentBrand`).
- `packages/shared/src/branding.ts`: the limits, the order of precedence (`resolveBranding`), the logo type check (`brandLogoContentType`), and the public pages' color (`brandAccentColor`, `readableTextOn`).
- `packages/db/migrations/0098_deployment_branding.sql`: the one-row table and the two functions. Every runtime role can read the table, but only `app.save_initial_branding()` writes to it. Row level security is forced on it.
- `packages/domain/src/server/branding.ts`: reads and saves the branding.
- `apps/admin/src/lib/branding.ts`: loads the branding for each render with a 30-second cache. Where a brand file matches, it never reads the database. If the database can't be read, pages fall back to the default brand, and the error is reported at most once a minute.
- Routes:
  - `GET /api/branding` returns `{ appName, logoUrl }` and is never cached.
  - `GET /api/branding/logo` serves the saved logo. Its URL carries the logo's SHA-256 (`?v=`), so browsers can keep it for good.
  - `POST /api/branding/initial` saves the onboarding choice.
- `BrandingProvider` (`apps/admin/src/components/branding-provider.tsx`) gives the name and logo to every component. It sets the `{{appName}}` i18n variable, and it keeps the tab's title and icon in step when they differ from what the server rendered.

### Prerendered pages

The sign-in, sign-up, and other public pages are prerendered at build time, before any database can be read. Where the build's `APP_BASE_URL` or `BRAND_PRESET` picks a brand file, they carry that brand and need nothing more. Otherwise, the browser asks `/api/branding` for the name and logo onboarding saved. Until it answers, the page keeps the logo's space empty instead of showing a name it would then replace, and then the tab title and icon follow.

## Text that keeps LobbyStack on purpose

- Identifiers that stored data or the public API depend on. They don't appear in the interface, and renaming them would break existing deployments:
  - Pepper labels in `packages/domain/src/server/oauth/tokens.ts` and `publicApi/apiKeys.ts`.
  - UUID namespaces in `publicApi/operations.ts` and `publicApi/users.ts`.
  - The `lobbystack-scrypt-v1` password hash format.
  - The `__lobbystack_migrations` journal and its advisory lock.
  - The `LobbyStack-Business` API header (keep it, or add an alias).
  - Cookie and storage keys, `x-lobbystack-*` headers, the Redis prefix, and telemetry names.

## API, MCP and AI text

These use the name from `deploymentAppName()` or `loadBranding()`, like emails:

- The OpenAPI document at `/api/v1/openapi.json` is titled "{name} API". Its descriptions, and the API's error messages, say "the dashboard", "an account" or "the operator" rather than a name. The committed `mintlify/api-reference/openapi.json` keeps LobbyStack's title.
- The MCP server's title and the first line of its instructions use the name; OAuth's protected resource metadata gives it as `resource_name`, and the `oauth_resources` row is named "{name} MCP server". The `WWW-Authenticate` realm is just "MCP".
- Prospect demos tell the voice agent "This is a prospect demo made with {name}."
- New businesses start with their own name as the placeholder summary, as the agent settings API already did. Migration 0102 changed the old placeholder, "… uses LobbyStack to answer calls.", to the business name; `agent-core/src/businessFacts.ts` still recognizes the old wording in snapshots cached before that.

## Still branded

These places still say LobbyStack or link to lobbystack.com. Variables marked "proposed" don't exist yet. When they're added, they should come from the brand file, like the name and logo.

| Area | Where | Proposed setting |
| --- | --- | --- |
| Referral links | `apps/admin/app/api/affiliate/route.ts` falls back to `https://app.lobbystack.com` | `SITE_URL` already overrides it. |
| API wire names | The `LobbyStack-Business` header, the `LobbyStack-Webhooks/1.0` and `LobbyStack-OAuth/1.0` user agents, the `lsk_` and `lsp_` key prefixes, and the MCP server id `lobbystack` | None: API clients, the CLI and Zapier send or match them, so renaming them would break integrations. Descriptions and messages around them name no product. |
| Website widget | The `window.LobbyStack` global, the `lobby-widget-*` classes, and the default color `#0f766e` (`packages/embed`, built into `apps/admin/public/embed/embed.js`) | Keep `window.LobbyStack`, because customers' sites may call it; the dashboard's embed code never shows it. Use the brand's `accentColor`, which [public profile pages](#color-the-public-pages) already read, for the default color. |
| Twilio | Numbers get the friendly name `LobbyStack <business id>` (`apps/worker/src/handlers.ts`) | The app name. Only the Twilio console shows it. |
| CLI | The `lobbystack` command, its `LOBBYSTACK_*` variables and config path, and links to `docs.lobbystack.com` in its help (`packages/cli`) | None: one command works with every deployment, so its help text says "the dashboard" instead of a name. |
| Zapier | The integration's name and logo in Zapier's developer dashboard | `ZAPIER_APP_NAME`, `ZAPIER_DEFAULT_URL` and `ZAPIER_DOCS_URL` set its labels, messages, default address and docs link (`integrations/zapier/README.md`); registering it under that name is done in Zapier. |
| Marketing site and docs | `apps/landing` (about 5,600 mentions) and `mintlify` (about 1,200), including logos, favicons, Open Graph images, structured data, and the legal entity "Lobbystack Inc." | Separate sites, so they're rebranded as content rather than with a variable. |
| Observability | `lobbystack-admin` and `lobbystack-worker` service names, and `lobbystack.*` metric names | Operators see these, end users don't. `OTEL_SERVICE_NAME` already overrides the service name. |

### Writing translations that use the name

A configurable name can't change its form, so translated strings have to use it as it is:

- In Serbian, put the name in apposition ("sa servisom {{appName}}") or use it as a modifier ("{{appName}} nalog"). Never inflect it, as in "LobbyStack-om".
- In French, avoid "de" and "le" directly before the name, because a name that starts with a vowel needs "d'" and "l'".
- In Spanish, avoid an article before the name.
