# Use the API, the CLI and integrations

Everything an owner does in the dashboard, a program can do through the v1 HTTP API, its `lobbystack` command line, or the MCP server for AI assistants. Webhooks tell other systems what happened. This page says which key to use, what the fork added, and how Zapier and n8n connect. Checked against `main` at `e788004`, with fork PR #94's changes.

## Know the pieces

| Piece | Where | What it is |
| --- | --- | --- |
| v1 API | `/api/v1/...` | 98 operations, all listed in one registry, `packages/shared/src/publicApi/operations.ts`, which also produces the OpenAPI file (`pnpm api:openapi`). |
| MCP server | `/api/mcp` | 18 tools for AI assistants over Streamable HTTP, with an API key or OAuth. |
| CLI | `packages/cli`, the `lobbystack` command | Works only through the v1 API, never the database. Every v1 operation has a command. |
| Webhooks | **Integrations > Webhooks**, or `POST /api/v1/webhooks` | Signed events (Standard Webhooks) for calls, appointments, messages and contacts, delivered by the worker. |

The [route catalog](../reference/routes.md) lists every operation with its route file and scope, and [API gaps](../reference/api-gaps.md) lists what the dashboard can do that the API can't yet.

## Pick a key

| Key | Starts with | Made by | Reaches |
| --- | --- | --- | --- |
| Business API key | `lsk_` | An owner or admin in **Settings > API keys**, with the scopes it needs | One business |
| Platform key | `lsp_` | `pnpm platform-key:create`, then added to the admin's `PLATFORM_API_KEYS` | The businesses its partner onboarded |
| Operator key | `lsp_` | `pnpm platform-key:create --access all` | Every business, plus deployment-wide operations such as the billing catalog and promo codes |

A business API key may leave out the `LobbyStack-Business` header; a platform key names the business in it. The business ID is shown above the keys in **Settings > API keys**, with a Copy button (fork PR #31), and `GET /me` returns it.

The **Create an API key** dialog preselects the read scopes for calls, contacts, appointments, messages and the business, but not `webhooks:manage`, which Zapier triggers and n8n's webhook setup need. Its **Set up for Zapier** button names the key Zapier, unless it already has a name, and ticks the nine scopes the Zapier integration's steps use, `webhooks:manage` included (fork PR #94). `/settings/api-keys?setup=zapier` opens the dialog set up that way.

## Use the CLI

```bash
pnpm lobbystack login --url https://<dashboard domain> --key-stdin --profile ops
pnpm lobbystack --profile ops business get
pnpm lobbystack onboard manifest.yaml
```

`--key-stdin` reads the key from standard input, so it stays out of the shell history. Profiles are saved in `~/.config/lobbystack/config.json`. `lobbystack onboard` creates or updates a business from a YAML manifest: its details, services, hours, knowledge, public profile, team and phone number. Leave `plan` out of a self-hosted deployment's manifests.

## Know what the fork added

| Pull request | Change |
| --- | --- |
| #5 | Onboarding through the API: platform keys create and list businesses, claim, replace and release numbers, manage the team and hand a business over to its owner (migrations `0092` to `0095`), and the `lobbystack onboard` command. |
| #14 | Contact keypad PINs: `POST /contacts/passcodes` and `POST /contacts/passcodes/generate` ([caller authentication](caller-authentication.md)). |
| #31 | The business ID above the API keys, and a scrolling Create dialog. |
| #33 | `GET` and `PATCH /public-profile`, `lobbystack public-profile`, and `public_profile:` in manifests. |
| #34 | Fields the API was missing: the business slug and hours source, a contact's text consent and block, a message's request and appointment, a widget key's key and snippet, a knowledge source's content type and tags, the live chat alert, and the onboarding stage. |
| #35 | `GET /business` and `GET /businesses` show the same onboarding stage as the dashboard. |
| #36, #37 | The API, MCP, demos and Zapier name the deployment's brand, not LobbyStack. |
| #51 | `GET /ai-traces` and `GET /ai-traces/{trace_id}`. |
| #58 to #75 | Billing operations: the catalog, Polar links, plans, checkout, promo codes and promo plans ([billing](../billing/README.md#run-billing-from-the-command-line)). |
| #94 | The Zapier integration under each brand's own name and account: `npm run push` for a brand, a Zapier card on the **Integrations** page, **Set up for Zapier** in the Create dialog, and the contact and service fields its samples were missing. |

## Connect Zapier

`integrations/zapier` is a Zapier Platform app outside the pnpm workspace. It only calls the v1 API with a business key. It has 6 triggers (call completed, appointment booked, rescheduled or cancelled, message taken, contact created), 6 actions, 3 searches and Find or Create Contact. Turning a trigger Zap on creates a webhook named "Zapier: &lt;label&gt;".

Each brand publishes it on its own Zapier developer account, under its own name (fork PR #94). `npm run push -- --brand <id> --url <dashboard address>` uploads it with the name from the brand file, the dashboard's address as each new connection's default, and a help link to that dashboard's Zapier dialog. AlloPlace's is a private integration, on a Zapier account under an alloplace.com address, that people join through its invite link. The [integration's README](../../integrations/zapier/README.md#publish-it-for-a-brand) has the steps. The original project registered its own copy on its own Zapier account, and this folder no longer points at it.

With the invite link in the brand file as `links.zapier` ([branding](../branding.md#send-the-outside-links-to-your-own-site)), the **Integrations** page shows a Zapier card. Its dialog:

1. opens the invite in Zapier;
2. links to the Create dialog set up for Zapier (`/settings/api-keys?setup=zapier`);
3. says to pick the brand in a Zap, paste the key, and check that the connection's address is this dashboard's.

A brand without a Zapier link, such as LobbyStack, shows no card. `/integrations?setup=zapier` opens the dialog, and the help link in the integration's API key field goes there. Book Appointment needs the agent's **Booking** set to **Books appointments**.

`zapierOperationIds` in `packages/shared/src/publicApi/operations.ts` lists every operation the integration calls, and the scopes **Set up for Zapier** ticks come from it. `packages/shared/src/publicApi/zapier.test.ts` checks in every CI run that the integration's samples have the fields the API returns.

Without the brand's integration, Webhooks by Zapier, on a paid Zapier plan, works with a webhook from **Integrations > Webhooks** and the v1 API.

## Connect n8n

n8n works with what's there, with no LobbyStack changes:

- **Actions:** the MCP Client node at `/api/mcp`, Streamable HTTP with a Bearer `lsk_` key, runs the 18 MCP tools. The HTTP Request node covers the v1 API.
- **Triggers:** a webhook made in **Integrations > Webhooks** that posts to an n8n Webhook node. LobbyStack delivers only to public `https://` addresses: it refuses `localhost`, `*.local`, `*.internal` (so `*.railway.internal`) and private IPs.
- **Signatures:** check them in a Code node with `crypto` (on self-hosted n8n, allow it with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`).

A dedicated n8n node, porting the Zapier app's actions and a trigger that manages its own webhook, would take about 3 to 5 days and isn't built. n8n Cloud shows only verified nodes, which have publishing rules of their own ([roadmap](../roadmap/n8n-and-zapier.md)).
