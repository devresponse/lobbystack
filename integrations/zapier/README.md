# Zapier integration

This folder holds the dashboard's integration for Zapier, built with the Zapier Platform CLI. It calls only the public REST API v1 (`/api/v1`), with a business API key. Each brand publishes it on its own Zapier developer account, under its own name: AlloPlace's is a private integration that people join through an invite link.

The package stays outside the pnpm workspace. Zapier builds it with npm and runs it on Node.js 22, so it has its own `package.json` and `package-lock.json`. Nobody needs the Zapier CLI installed: `npm run zapier -- <command>` runs the CLI release that matches `zapier-platform-core` in `package.json`, on Windows, macOS and Linux alike.

## What it includes

| Type | Name | API |
| --- | --- | --- |
| Trigger | New Call | `call.completed` webhook, sample from `GET /calls` |
| Trigger | New Appointment | `appointment.booked` webhook, sample from `GET /appointments` |
| Trigger | Appointment Rescheduled | `appointment.rescheduled` webhook |
| Trigger | Appointment Cancelled | `appointment.cancelled` webhook |
| Trigger | New Message | `message.taken` webhook, sample from `GET /messages` |
| Trigger | New Contact | `contact.created` webhook, sample from `GET /contacts` |
| Action | Create Contact | `POST /contacts` |
| Action | Update Contact | `PATCH /contacts/{id}` |
| Action | Book Appointment | `POST /appointments` |
| Action | Cancel Appointment | `POST /appointments/{id}/cancel` |
| Action | Reschedule Appointment | `POST /appointments/{id}/reschedule` |
| Action | Add Knowledge | `POST /knowledge` |
| Search | Find Contact (with Find or Create Contact) | `GET /contacts?phone=`, or `GET /contacts?email=` when no phone is given |
| Search | Find Appointment | `GET /appointments?contact_id=` |
| Search | Check Availability | `GET /availability` |

Triggers are REST hooks. Turning on a Zap calls `POST /webhooks` for one event, and turning it off calls `DELETE /webhooks/{id}`. Hidden triggers fill the service, staff, contact and appointment dropdowns. Each trigger checks the Standard Webhooks signature on every delivery with the secret the dashboard returned when the Zap subscribed. If Zapier ever stops passing the raw request, run `npm run zapier -- env:set 1.0.0 LOBBYSTACK_SKIP_WEBHOOK_SIGNATURE=1` to turn the check off while you ship a fix.

People connect with an API key and the dashboard's address. The connection test calls `GET /me`, so a key with any scopes connects, but a step its key doesn't allow fails. **Settings > API keys > Create API key > Set up for Zapier** gives a key every scope the steps use, `webhooks:manage` for the triggers included. Those scopes are `zapierApiKeyScopes` in `packages/shared/src/publicApi/operations.ts`, worked out from `zapierOperationIds`, the list of every operation this integration calls: add an operation there when a step starts calling it. The address must use HTTPS; plain HTTP works only for `localhost`, for local testing.

## Develop

```bash
cd integrations/zapier
npm ci
npm test                  # Jest with nock; no network access
npm run validate          # Zapier's schema and publishing checks
npm run zapier -- build   # builds build/build.zip without uploading it
```

Run the tests on Node.js 22 before a push, since Zapier runs that version: `npx -p node@22 node node_modules/.bin/jest`.

The samples in `lib/resources.js` are what people see while they build a Zap, before any real data arrives. `packages/shared/src/publicApi/zapier.test.ts` checks in every CI run that they have the fields the API returns, so a new API field fails CI until the sample and its output fields have it too.

## Test against a local stack

1. Start PostgreSQL and Redis, apply migrations, and run the admin and worker apps (see `AGENTS.md`).
2. From the repository root, seed a test business and API keys into the local database. The main key has exactly the scopes Settings > API keys sets up for Zapier, so a full run also shows that they're enough. Use the same `ENCRYPTION_KEY` as the admin app, because the API hashes keys with it. The script refuses any database outside localhost.

   ```bash
   ENCRYPTION_KEY=your_admin_encryption_key \
   DATABASE_URL=postgres://postgres:your_local_password@127.0.0.1:15433/lobbystack \
   pnpm zapier:seed-local
   ```

3. Run the checks. Copy the key from `.env.example`; it only works against a database this script seeded.

   ```bash
   cd integrations/zapier
   LOBBYSTACK_BASE_URL=http://localhost:3000 \
   LOBBYSTACK_API_KEY=key_from_env_example \
   npm run e2e:local
   ```

   Add `ZAPIER_E2E_EVENTS_FROM_DB=1` and the same `DATABASE_URL` to also run each appointment and contact trigger on a delivery that the server's own code signed with the endpoint's secret. It checks that a valid signature passes and an altered body fails.

The script tests the connection, subscribes and unsubscribes all six triggers, loads samples, and runs every action and search. Test subscriptions point at a `.invalid` host, so the worker's delivery attempts fail at DNS and no data leaves your machine.

## Publish it for a brand

Run these from this folder, on the computer that holds the brand's Zapier sign-in. AlloPlace's values are shown; another brand uses its own folder under `brands/`, name and dashboard address.

### Register once

1. Create the brand's Zapier account. AlloPlace's uses an `@alloplace.com` address.
2. `npm ci`, then `npm test`.
3. Sign in: `npm run zapier -- login`. An account that signs in with Google has no Zapier password: run `npm run zapier -- login --sso` and paste a deploy key from Zapier's developer settings instead.
4. Register: `npm run zapier -- register "AlloPlace"`. It asks for a sentence about the app (140 characters at most), its homepage (`https://alloplace.com`), whether the integration is public or private (private), how you relate to the app, a category, and whether to get Zapier's updates. The account owner also has to accept Zapier's Developer Platform Agreement. The command writes `.zapierapprc`, which names the new integration: commit it, because `push` uploads to the integration it names.

### Push each version

5. `npm run push -- --brand alloplace --url https://demo.alloplace.com`. It reads the name from `brands/alloplace/brand.json`, uploads the version in `package.json`, and sets that version's name, address and help link ([Name and address](#name-and-address)). Add `--dry-run` to see what it would do.
6. In Zapier's developer dashboard, add the logo, a 256×256 PNG, and check the description and homepage.

### Share it

7. `npm run zapier -- users:links` prints an invite link for all versions. Put it in the brand file as `links.zapier`, run `pnpm brands:build`, and deploy. The dashboard's **Integrations** page then shows a Zapier card whose dialog opens the invite and links to a key set up for Zapier, and the help link in Zapier's API key field opens that dialog (`/integrations?setup=zapier`).

Only people who accept the invite can see or use the integration. To point new connections at another dashboard, such as the live one, push again with its `--url`. Connections already made keep the address they saved.

### Change it later

Pushing the same version again replaces it in place, for every Zap that uses it. For a change existing Zaps should move to on purpose, raise `version` in `package.json` first, push, and move them later with `npm run zapier -- migrate <old version> <new version>`.

## Name and address

The integration calls the product LobbyStack and connects to the original project's hosted dashboard unless these variables say otherwise. `npm run push` sets the first three in the environment of `zapier-platform push`, which reads field labels, help text and the address field's default then, and on the uploaded version with `zapier-platform env:set`, which the running integration reads for its error messages and for a connection saved without an address.

- `ZAPIER_APP_NAME`: the name people see, such as `AlloPlace`.
- `ZAPIER_DEFAULT_URL`: the dashboard address a new connection starts with. Every connection must give an address, but the running integration sends a connection without one, such as one made before the field was required, to this address, and without it to the original project's dashboard, which would receive the connection's API key.
- `ZAPIER_HELP_URL`: the page the API key field's help links to. `npm run push` sets it to the dashboard's `/integrations?setup=zapier`.
- `ZAPIER_DOCS_URL`: used only without `ZAPIER_HELP_URL`, which then links to its `/api/authentication` page, without a trailing slash. Unset, that's the original project's docs.

## Before a public listing

A private integration needs none of this. Listing it in Zapier's app directory, so anyone can find it, does:

- [ ] A test account for `integration-testing@zapier.com` that never expires, with instant booking turned on, at least one service with staff and hours, and an API key set up for Zapier. Zapier support must be able to reset its password.
- [ ] A team member on the Zapier integration with an address at the brand's domain.
- [ ] The logo, category and homepage, and a description that starts with "AlloPlace is a..." and leaves out links and sales language.
- [ ] Public API documentation, and a help link in the API key field that works for someone who isn't signed in to the dashboard.
- [ ] A test Zap for each trigger, action and search, run once each and kept on.
- [ ] A short demo or written steps for booking, since it depends on the business's settings.
- [ ] A `CHANGELOG.md` in this folder, which `promote` requires.

Then `npm run zapier -- promote <version>` gives the form that asks Zapier to make it public. Zapier reviews it, and a newly public integration is marked Beta for its first 90 days.
