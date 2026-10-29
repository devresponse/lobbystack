# Publish the n8n and Zapier integrations

Zapier and n8n can already reach LobbyStack, but neither has an integration that anyone can find in its directory ([integrations](../features/api-cli-integrations.md#connect-zapier)). Since fork PR #94 each brand publishes the Zapier integration in `integrations/zapier` privately, on its own Zapier account: people join it through the brand's invite link, which the dashboard's **Integrations** page opens. An n8n node was sized on 2026-10-13, checked again on 2026-10-28, and never built.

- **Status:** the private Zapier integration is built (fork PR #94). The n8n node and a listing in Zapier's directory aren't started; build them when customers ask.
- **Effort:** about 3 to 5 days for the n8n node, with tests, CI and help pages; about 1.5 to 2.5 days to list the Zapier integration, plus about 3 hours of the maintainer's, then Zapier's review.

## Know what works today

- **Zapier:** the brand's private integration, through the Zapier card on the **Integrations** page, or Webhooks by Zapier on a paid Zapier plan with a webhook from **Integrations > Webhooks**.
- **n8n:** the MCP Client node at `/api/mcp` runs the MCP tools with an `lsk_` key, the HTTP Request node covers the v1 API, and a webhook from **Integrations > Webhooks** starts an n8n Webhook node.

## Build the n8n node

A TypeScript package, such as `integrations/n8n`, with a credential (the key and the dashboard's address, checked with `GET /me`), an action node that ports the Zapier app's 6 actions and 3 searches, and a trigger node that creates and deletes its own webhook through `/api/v1/webhooks` and checks each delivery's signature. Self-hosted n8n installs unverified nodes from npm. n8n Cloud shows only verified ones, which must come from a public repository matching the npm package, under the MIT licence, with no runtime dependencies, published from GitHub Actions with npm provenance and submitted through n8n's Creator Portal. Check n8n's verification rules again before building.

## List the Zapier integration in Zapier's directory

After the brand's public launch, work through "Before a public listing" in the [integration's README](../../integrations/zapier/README.md#before-a-public-listing): a test account Zapier's reviewers can use, public API docs, a help link that works for someone who isn't signed in, a test Zap for every step, and a changelog. Then `npm run zapier -- promote <version>` sends the form for Zapier's review. A newly public integration is marked Beta for its first 90 days. Check Zapier's publishing requirements again before starting.

## Decide these

- List the Zapier integration in Zapier's directory after the public launch, and build the n8n node before customers ask?

[Intake forms](intake-forms.md) would add a "Form response" trigger to both in their third phase.
