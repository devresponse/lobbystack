# Make app

This folder holds the dashboard's app for Make (make.com), in the local format of Make Apps Editor, Make's extension for VS Code. The app calls only the public REST API v1 (`/api/v1`), with a business API key. Each brand creates it in its own Make account, under its own name: AlloPlace's is shared through an invite link once it's published.

The folder stays outside the pnpm workspace and has no dependencies. Its build and tests run on Node.js 22 or later.

## What it includes

| Type | Name | API |
| --- | --- | --- |
| Trigger | Watch completed calls | `call.completed` webhook |
| Trigger | Watch new appointments | `appointment.booked` webhook |
| Trigger | Watch rescheduled appointments | `appointment.rescheduled` webhook |
| Trigger | Watch cancelled appointments | `appointment.cancelled` webhook |
| Trigger | Watch new messages | `message.taken` webhook |
| Trigger | Watch new contacts | `contact.created` webhook |
| Action | Get a call | `GET /calls/{id}` |
| Search | Search appointments | `GET /appointments` |
| Action | Get an appointment | `GET /appointments/{id}` |
| Search | List open appointment times | `GET /availability` |
| Action | Book an appointment | `POST /appointments` |
| Action | Reschedule an appointment | `POST /appointments/{id}/reschedule` |
| Action | Cancel an appointment | `POST /appointments/{id}/cancel` |
| Search | Search contacts | `GET /contacts` |
| Action | Get a contact | `GET /contacts/{id}` |
| Action | Create a contact | `POST /contacts` |
| Action | Update a contact | `PATCH /contacts/{id}` |
| Action | Add a knowledge entry | `POST /knowledge` |
| Universal | Make an API call | Any path of the API |

Five drop-down lists fill the service, staff member, appointment, contact and call fields from `GET /services`, `/staff`, `/appointments`, `/contacts` and `/calls`. Each of those fields also takes an ID mapped from an earlier module.

Each trigger has its own webhook. Creating the webhook in Make calls `POST /webhooks` for one event, and the dashboard lists it under **Integrations > Webhooks** as "Make: " and the module's name. Deleting the webhook in Make calls `DELETE /webhooks/{id}`; turning a scenario off keeps it. A business can have 20 webhook endpoints, and Make's webhooks count toward that with Zapier's and the ones added in the dashboard.

People connect with an API key and the dashboard's address. The connection test calls `GET /me` and refuses a platform key. **Settings > API keys > Create API key > Set up for Make** gives a key every scope the modules use, `messages:read` and `webhooks:manage` for the triggers included. Those scopes are `makeApiKeyScopes` in `packages/shared/src/publicApi/operations.ts`, worked out from `makeOperationIds` and `makeWebhookEvents`, the lists of every operation and event the app uses: add one there when a module starts using it. The address field starts as the address the app was built with, and the connection keeps only its `https://` origin, so a pasted page address such as `https://demo.alloplace.com/settings/api-keys` still works.

The Zapier integration does two things this app can't:

- **Check webhook signatures.** A webhook's code in Make gets the parsed body, not the raw request, so it can't check the Standard Webhooks signature. Make's webhook address is long and random and only the dashboard learns it, so the address is the secret. The signing secret the dashboard returns is kept out of Make's logs.
- **Send an Idempotency-Key.** Make has no stable ID for a module's run to make one from, and none of the app's operations require one. A module that Make runs again after an error can repeat its request: a contact with the same phone number and an appointment at a time already booked are refused the second time, but a contact without a phone number or a knowledge entry can be added twice.

## Develop

```bash
cd integrations/make
npm test                 # the app's files and the build, without Make
npm run build -- --brand alloplace --url https://demo.alloplace.com
```

The app is in `app/`: one folder per component, holding JSON with IML expressions such as `{{parameters.contact_id}}`, and `app/makecomapp.json`, which lists every component and its files. The files keep three placeholders, `__APP_NAME__`, `__DASHBOARD_URL__` and `__HELP_URL__`, which the build fills in from the brand file and `--url`. Open this folder in VS Code with Make Apps Editor installed for its checks and suggestions while you edit.

`packages/shared/src/publicApi/make.test.ts` runs with the shared package's tests in every CI run. It checks that each request the app makes is an operation in `makeOperationIds`, that it sends only the query parameters and body fields that operation takes, and that each module's sample and output fields match what the API returns. So a new API field fails CI until the modules that return it have it too.

## Deploy it for a brand

These steps use AlloPlace's values; another brand uses its own folder under `brands/`, name and dashboard address. Nothing can be deleted from a published Make app, and the app can't be deleted or made private again, so test on a private testing app first and publish a second app.

### Set up once

1. Create the brand's Make account. AlloPlace's uses an `@alloplace.com` address.
2. Create a token for the editor: in Make, open your profile, select **API access**, then **+ Add token**. Choose the scopes `sdk-apps:read` and `sdk-apps:write`, select **Save**, and copy the token, which Make shows only once.
3. Install VS Code and its **Make Apps Editor** extension (`Integromat.apps-sdk`) from the Visual Studio Marketplace.
4. In Make, open **Custom Apps** and select **+ Create app**. Name: `alloplace-test`. Label: `AlloPlace Testing`. Theme: `#FFD100`. Language: English. App logo: `logos/alloplace.png` from this folder, AlloPlace's mark in black on a transparent background, which Make shows in white on the theme color. Select **Save**, and note the zone at the start of Make's address, such as `eu1` in `https://eu1.make.com`.

### Deploy

5. Build the app for the testing app:

   ```bash
   cd integrations/make
   npm run build -- --brand alloplace --url https://demo.alloplace.com --app-id alloplace-test --zone eu1
   ```

   It writes the app to `brands/alloplace/`.
6. In VS Code, open the `integrations/make` folder, right-click `brands/alloplace/makecomapp.json` and select **Deploy to Make**. When the editor asks for a token, paste the one from step 2 and select **Save & Use API token**: it goes in `brands/alloplace/.secrets/`, which git ignores. When it asks what to do with the first component, choose **Deploy as new remote connection (and Apply for all unmapped)**.
7. Commit `brands/alloplace/makecomapp.json`, the only file in that folder git keeps. The deploy recorded in it the ID Make gave each component, and the next deploy needs those IDs to update the components instead of adding new ones.

### Test

8. In Make, create a scenario and add any AlloPlace module, which has a **Private** tag. Select **Create a connection** and paste a key made in the dashboard with **Settings > API keys > Create API key > Set up for Make**. When you save the scenario, Make asks to install the app in your organization: select **Yes**.
9. Run each module once. For each trigger, create its webhook, then make that thing happen in the dashboard: a call, a booking, a move, a cancellation, a message or a new contact.

### Publish

10. Create the production app the same way, with Name `alloplace` and Label `AlloPlace`. Build with `--app-id alloplace --zone eu1`, deploy as in step 6, choosing that app when the editor asks which one, and commit `makecomapp.json` again: it now names both apps.
11. In the production app's **Modules**, switch every module from hidden to visible. A hidden module works only for the app's author.
12. Select **Publish** on the app's page. **It can't be undone**: Make won't delete a published app or make it private again, and nothing can be deleted from it afterwards. Publishing creates the invite link, which works for organizations in every Make zone.
13. Put the invite link in `brands/alloplace/brand.json` as `links.make`, run `pnpm brands:build`, and deploy the dashboard. Its **Integrations** page then shows a Make card whose dialog opens the invite and links to a key set up for Make, and the help link of Make's API key field opens that dialog (`/integrations?setup=make`).

### Change it later

Edit `app/`, run `npm test`, then build and deploy as in steps 5 to 7; the build keeps the Make apps that `makecomapp.json` names, so `--app-id` and `--zone` are needed only for a new one. A deploy to the published app reaches everyone who installed it at once, so deploy to the testing app first. A module that should go can only be hidden and renamed, such as "[DO NOT USE] Old module".

Building and deploying with another `--url`, such as the live dashboard's, changes the address new connections start with. Connections already made keep theirs.

Make lists an app for everyone only after its own review, which isn't planned. Until then, only people with the invite link can install it.
