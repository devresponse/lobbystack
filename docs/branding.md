# Brand a deployment

A deployment can show its own app name and logo instead of LobbyStack, and send its outside links to its own website. This page covers how to set them, how the admin picks which to show, and where the LobbyStack brand still appears, with the variable proposed for each of those places.

## Set the name and logo

The admin reads two settings. For each one it uses the first of these that has a value:

1. The admin's environment: `BRAND_APP_NAME` and `BRAND_LOGO_URL`.
2. The choice the deployment's first owner saved during onboarding. It's stored as one row in `public.deployment_branding`.
3. LobbyStack's own name and mark.

Each setting is resolved on its own, so an operator can fix the name in the environment and still let the first owner upload a logo. The environment comes first so that whoever runs a deployment keeps control of it: the first person to sign up can't replace a name the operator already set, and an operator can fix the branding without database access. Prerendered pages can only read the environment the admin was built with, so it has to be available at build time as well (see [Prerendered pages](#prerendered-pages)).

| Setting | Environment variable | Accepted values |
| --- | --- | --- |
| App name | `BRAND_APP_NAME` | 1 to 40 characters once whitespace is collapsed. Control and format characters, such as bidirectional overrides, aren't allowed. |
| Logo | `BRAND_LOGO_URL` | An `https://` URL without credentials, or a path on the dashboard such as `/brand/logo.svg`. |

When a variable is set to a value it can't use, the admin logs a warning once and treats the variable as unset.

Set the variables on the admin service. Give them to the admin's Docker build too: `Dockerfile.admin` and `docker-compose.yml` pass build arguments with the same names. On Railway, the admin's service variables reach its Docker build automatically.

### AlloPlace defaults

Out of the box, both variables carry AlloPlace's brand: `BRAND_APP_NAME=AlloPlace` and `BRAND_LOGO_URL=/brand/alloplace/logo.svg`. `Dockerfile.admin` sets them at build and run time, `docker-compose.yml` passes them when they're unset, and `.env.example` carries them for local development. The logo is the yellow tile from AlloPlace's Cadre brand system, in `apps/admin/public/brand/alloplace/logo.svg`. The dashboard sets the name beside it, and the browser tab uses it as its icon, as alloplace.com does.

To rebrand a deployment, set your own values. To let the deployment's first owner choose a field in onboarding instead, set that variable to an empty value. In Docker and Compose, leaving it unset keeps AlloPlace's.

### The onboarding step

The first owner sees a **Make this app your own** step before naming their business. It asks only for the fields the environment leaves unset, and it doesn't appear at all when both are set, as they are with the AlloPlace defaults. The owner can type a name, upload a logo, or skip. Skipping saves an empty row, which keeps LobbyStack and ends the choice.

The step is shown only when both of these are true. `app.can_save_initial_branding()` checks them in the database, and `app.save_initial_branding()` checks them again when the choice is saved:

- No branding has been saved yet.
- The person owns every business on the deployment. A fresh deployment has no businesses, so the first person to sign up qualifies. Someone on a deployment that already serves another person's business never does.

Uploaded logos can be PNG, JPEG, WebP, or SVG files of up to 256 KB. The admin works out the type from the file's bytes rather than its name. It refuses any SVG that contains script, event handlers, `foreignObject`, embedded documents, or entity declarations. The logo route also serves every saved logo under `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox` with `nosniff`, so an image opened on its own can't run anything.

### Change the branding later

There's no settings page for this yet. To change the branding:

- Set `BRAND_APP_NAME` or `BRAND_LOGO_URL` and redeploy the admin. They take priority over the saved choice.
- Or delete the saved row as the database superuser, because the runtime roles can't write the table, and open `/onboarding/brand` as the owner of every business:

  ```sql
  DELETE FROM public.deployment_branding;
  ```

The admin caches the branding for 30 seconds, so other admin replicas pick up a change within that time.

## Where the name and logo appear

- The browser tab's title and icon on every admin page: the dashboard, sign-in and sign-up, onboarding, and the website widget's frame.
- The logo and name above the sign-in, sign-up, password reset, invitation, email change, verification, OAuth consent, and onboarding pages.
- The header of the public demo page.
- The foot of each business's [public profile page](../mintlify/settings/public-profile.mdx) at `/profile/<slug>`, after "Answered by", and of the page a visitor gets for a profile that isn't published. Both link to the website.
- Every dashboard string in all four languages that used to say LobbyStack: 21 strings, which now use the `{{appName}}` i18n variable.

A deployment still named LobbyStack with no logo of its own shows LobbyStack's mark. A renamed deployment with no logo shows its name on its own, so LobbyStack's mark never appears beside another name.

## Send the outside links to your own site

The admin also links to pages outside itself: the website, the terms of service and privacy policy, the docs, and an address to write to. Five variables point them at a deployment's own site and inbox.

| Link | Environment variable | Accepted values | When unset |
| --- | --- | --- | --- |
| Website | `NEXT_PUBLIC_LANDING_SITE_URL` | An `http://` or `https://` URL without credentials, a query, or a fragment. | `https://lobbystack.com` |
| Terms of service | `NEXT_PUBLIC_TERMS_URL` | An `http://` or `https://` URL without credentials. | `/terms` on the website |
| Privacy policy | `NEXT_PUBLIC_PRIVACY_URL` | An `http://` or `https://` URL without credentials. | `/privacy` on the website |
| Docs | `NEXT_PUBLIC_DOCS_SITE_URL` | Like the website. | `https://docs.lobbystack.com` |
| Contact address | `NEXT_PUBLIC_CONTACT_EMAIL` | A plain address, such as `support@example.com`. | LobbyStack's address for each place: `support@lobbystack.com` in the feedback panel, `hello@lobbystack.ai` for Enterprise plans, and `hello@lobbystack.com` in text messages. |

An empty variable counts as unset. When a variable holds a value it can't use, the admin logs a warning at startup and uses LobbyStack's link in its place.

Where each one appears:

- **Website**: the logo on the public demo page, the "visit" link in the SMS HELP reply, and the terms and privacy links when their own variables are unset. On lobbystack.com the links open the page in the reader's language, under `/fr/`, `/es/`, or `/sr/`. Any other site gets the same path in every language, such as `/terms`.
- **Terms and privacy**: the links under the sign-up form and at the foot of onboarding, and the affiliate program's terms link. With `NEXT_PUBLIC_TERMS_URL` set, the affiliate link opens the top of that page, since only LobbyStack's terms have an `#affiliate-program` section.
- **Docs**: the "see docs" and Help Center links in the dashboard's feedback panel, and `resource_documentation` in the MCP server's OAuth metadata, which adds `/ai/mcp`.
- **Contact address**: the feedback panel's "Contact us" link, the Enterprise plan's contact button in onboarding and billing, and both SMS HELP replies. The HELP reply is part of the registered A2P 10DLC campaign, so update the campaign when the address or the website changes.

### Set them for the build

Next.js writes `NEXT_PUBLIC_` variables into the admin's build, both the browser's code and the server's, so a change takes a rebuild. `next.config.ts` fixes all five at build time, even the unset ones, so a value set only when the admin starts can't make the server render one link and the browser another.

`Dockerfile.admin` and `docker-compose.yml` pass build arguments with the same names. On Railway, the admin's service variables reach its Docker build automatically.

### AlloPlace defaults

Out of the box, the links go to alloplace.com:

```bash
NEXT_PUBLIC_LANDING_SITE_URL=https://alloplace.com
NEXT_PUBLIC_TERMS_URL=https://alloplace.com/legal/terms
NEXT_PUBLIC_PRIVACY_URL=https://alloplace.com/legal/privacy
NEXT_PUBLIC_DOCS_SITE_URL=https://alloplace.com
NEXT_PUBLIC_CONTACT_EMAIL=support@alloplace.com
```

`Dockerfile.admin` sets them for the build, `docker-compose.yml` passes them when they're unset, and `.env.example` carries them for local development. alloplace.com has no docs yet, so the docs links open its home page, and the MCP metadata's `/ai/mcp` page doesn't exist there.

To link to LobbyStack's page for one of them instead, set that variable to an empty value. In Docker and Compose, leaving it unset keeps alloplace.com's.

`packages/shared/src/brandLinks.ts` holds the variable names, the checks, and LobbyStack's defaults. `apps/admin/src/lib/marketing-site-url.ts` builds the website, terms, and privacy links.

## Color the public pages

Businesses' public profile pages put one color behind the chat, or behind the call card when a business has no chat, and on today's row of the opening hours. `BRAND_ACCENT_COLOR` sets it, as `#rgb` or `#rrggbb`. Text on it is black or white, whichever contrasts more, so a yellow gets black text.

Out of the box it's AlloPlace's yellow, `#FFD100`. `Dockerfile.admin` sets it at run time, `docker-compose.yml` passes it when it's unset, and `.env.example` carries it in quotes, because an unquoted `#` starts a comment in `.env` files. Without a valid color, the pages use the website widget's default teal, `#0f766e`.

The pages are rendered for each request, so a change only needs a restart, not a rebuild.

## How it works

- `packages/shared/src/branding.ts`: the variable names, the limits, the order of precedence (`resolveBranding`), the logo type check (`brandLogoContentType`), and the public pages' color (`brandAccentColor`, `readableTextOn`).
- `packages/db/migrations/0098_deployment_branding.sql`: the one-row table and the two functions. Every runtime role can read the table, but only `app.save_initial_branding()` writes to it. Row level security is forced on it.
- `packages/domain/src/server/branding.ts`: reads and saves the branding.
- `apps/admin/src/lib/branding.ts`: loads the branding for each render with a 30-second cache. If the database can't be read, pages fall back to the environment and the default, and the error is reported at most once a minute.
- Routes:
  - `GET /api/branding` returns `{ appName, logoUrl }` and is never cached.
  - `GET /api/branding/logo` serves the saved logo. Its URL carries the logo's SHA-256 (`?v=`), so browsers can keep it for good.
  - `POST /api/branding/initial` saves the onboarding choice.
- `BrandingProvider` (`apps/admin/src/components/branding-provider.tsx`) gives the name and logo to every component. It sets the `{{appName}}` i18n variable, and it keeps the tab's title and icon in step when they differ from what the server rendered.

### Prerendered pages

The sign-in, sign-up, and other public pages are prerendered at build time, before any database can be read. They carry the branding that the build's environment sets. When either variable is missing at build time, the browser asks `/api/branding` for both. Until it answers, the page keeps the logo's space empty instead of showing a name it would then replace, and then the tab title and icon follow. Setting both variables for the build skips that request.

## Text that keeps LobbyStack on purpose

- The consent text for operator alert texts (`OPERATOR_SMS_DISCLOSURE_TEXT` in `packages/shared/src/operatorSmsConsent.ts`, and `settings:notifications.phoneVerification.*.consent`). It's versioned, and each opt-in records it word for word, so a new name needs a new disclosure version. A test in `apps/admin/src/lib/locale-parity.test.ts` fails if any other dashboard string names LobbyStack.
- Identifiers that stored data or the public API depend on. They don't appear in the interface, and renaming them would break existing deployments:
  - Pepper labels in `packages/domain/src/server/oauth/tokens.ts` and `publicApi/apiKeys.ts`.
  - UUID namespaces in `publicApi/operations.ts` and `publicApi/users.ts`.
  - The `lobbystack-scrypt-v1` password hash format.
  - The `__lobbystack_migrations` journal and its advisory lock.
  - The `LobbyStack-Business` API header (keep it, or add an alias).
  - Cookie and storage keys, `x-lobbystack-*` headers, the Redis prefix, and telemetry names.

## Still branded

These places still say LobbyStack or link to lobbystack.com. Variables marked "proposed" don't exist yet. When they're added, they should be resolved like the name and logo: the environment first, then a saved value, then the default.

| Area | Where | Proposed setting |
| --- | --- | --- |
| Email subjects and bodies | `apps/admin/src/lib/auth.ts` (verification, password reset, email change, existing account); `packages/providers/src/email/smtp.ts` (templates, the inline 48×48 logo, founder sign-offs); `packages/domain/src/server/onboarding.ts`, `publicApi/users.ts`, `feedback.ts`; the worker's default subject "LobbyStack notification", which invitations use | The worker reads the same branding as the admin. The email header uses the logo at `APP_BASE_URL` + `/api/branding/logo`. |
| Email sender | `EMAIL_FROM` (an existing variable; defaults to `LobbyStack <no-reply@…>`) | Already configurable. Default the display name to the app name. |
| Operator alert emails | `packages/domain/src/server/calendar.ts`, `publicApi/webhooks.ts` | The app name. |
| SMS | The "LobbyStack:" opening of the HELP and START replies in `packages/domain/src/server/sms.ts` (the HELP replies take their address and website from the [outside links](#send-the-outside-links-to-your-own-site)); the verification code text in `verificationCode.ts`, which is also sent to callers who change an appointment, in English only | The app name. The HELP reply is part of the registered A2P 10DLC campaign, so update the campaign when it changes. |
| Referral links | `apps/admin/app/api/affiliate/route.ts` falls back to `https://app.lobbystack.com` | `SITE_URL` already overrides it. |
| AI and voice text | The prospect demo instructions (`packages/domain/src/server/demos.ts`); the placeholder summary "… uses LobbyStack to answer calls." (`tenancy.ts`, `businessSummary.ts`), which `agent-core/src/businessFacts.ts` and migration 0074 detect by its wording; the MCP server's title and instructions (`apps/admin/src/lib/mcp/server.ts`) | The app name. The placeholder detection has to keep matching the old wording. |
| API and OAuth | The OpenAPI title "LobbyStack API" and descriptions such as "LobbyStack Cloud" (`packages/shared/src/publicApi/`); API error messages; the webhook test event; the `LobbyStack-Webhooks` and `LobbyStack-OAuth` user agents; the OAuth resource name and realm (`apps/admin/src/lib/mcp/oauth-config.ts`, `oauth-provider.ts`) | The app name, except the user agents. |
| Website widget | The `window.LobbyStack` global, the `lobby-widget-*` classes, and the default color `#0f766e` (`packages/embed`, built into `apps/admin/public/embed/embed.js`) | Keep `window.LobbyStack` as an alias, because customers' sites may call it. Use `BRAND_ACCENT_COLOR`, which [public profile pages](#color-the-public-pages) already read, for the default color. |
| Twilio | Numbers get the friendly name `LobbyStack <business id>` (`apps/worker/src/handlers.ts`) | The app name. Only the Twilio console shows it. |
| CLI and Zapier | The `lobbystack` command, its config path, and its help text, which links to `docs.lobbystack.com` (`packages/cli`); the Zapier app's labels, errors, and docs link, plus its name and logo in Zapier's dashboard (`integrations/zapier`) | Separate distributions, so they're renamed by publishing a renamed copy rather than with a variable. |
| Marketing site and docs | `apps/landing` (about 5,600 mentions) and `mintlify` (about 1,200), including logos, favicons, Open Graph images, structured data, and the legal entity "Lobbystack Inc." | Separate sites, so they're rebranded as content rather than with a variable. |
| Observability | `lobbystack-admin` and `lobbystack-worker` service names, and `lobbystack.*` metric names | Operators see these, end users don't. `OTEL_SERVICE_NAME` already overrides the service name. |

### Writing translations that use the name

A configurable name can't change its form, so translated strings have to use it as it is:

- In Serbian, put the name in apposition ("sa servisom {{appName}}") or use it as a modifier ("{{appName}} nalog"). Never inflect it, as in "LobbyStack-om".
- In French, avoid "de" and "le" directly before the name, because a name that starts with a vowel needs "d'" and "l'".
- In Spanish, avoid an article before the name.
