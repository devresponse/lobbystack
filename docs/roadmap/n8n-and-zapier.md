# Publish the n8n and Zapier integrations

Zapier and n8n can already reach LobbyStack, but neither has an integration that anyone can install from its directory ([integrations](../features/api-cli-integrations.md#connect-zapier)). The Zapier app in `integrations/zapier` was registered on the original project's Zapier account and never published, and an n8n node was sized on 2026-10-13 and never built.

- **Status:** not started; build them when customers ask.
- **Effort:** about 3 to 5 days for the n8n node, with tests, CI and help pages; publishing the Zapier app wasn't estimated.

## Know what works today

- **Zapier:** a private copy pushed from `integrations/zapier` with the Zapier Platform CLI, or Webhooks by Zapier on a paid Zapier plan with a webhook from **Integrations > Webhooks**.
- **n8n:** the MCP Client node at `/api/mcp` runs the MCP tools with an `lsk_` key, the HTTP Request node covers the v1 API, and a webhook from **Integrations > Webhooks** starts an n8n Webhook node.

## Build the n8n node

A TypeScript package, such as `integrations/n8n`, with a credential (the key and the dashboard's address, checked with `GET /me`), an action node that ports the Zapier app's 6 actions and 3 searches, and a trigger node that creates and deletes its own webhook through `/api/v1/webhooks` and checks each delivery's signature. Self-hosted n8n installs unverified nodes from npm. n8n Cloud shows only verified ones, which must come from a public repository matching the npm package, under the MIT licence, with no runtime dependencies, published from GitHub Actions with npm provenance and submitted through n8n's Creator Portal. Check n8n's verification rules again before building.

## Publish the Zapier app

Register the app on the brand's own Zapier developer account, point its default addresses at the brand's dashboard and docs instead of the original's ([open items](../project/open-items.md#clean-up-what-still-points-at-the-original)), work through the publishing checklist in its README, and submit it for Zapier's review. The **Create an API key** dialog leaves out `webhooks:manage`, which trigger Zaps need, so the help pages should say to add it.

## Decide these

- Publish the Zapier app under the brand's account, and build the n8n node before customers ask?

[Intake forms](intake-forms.md) would add a "Form response" trigger to both in their third phase.
