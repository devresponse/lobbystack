# Know the API's gaps

What the dashboard can do, or the database holds, that the v1 API can't reach yet. The list comes from an audit of the API against the database on 2026-10-17, re-checked against `main` at `da1f548`. Every change suggested here only adds to the API, so nothing existing callers see changes, unless the row says otherwise. How the API, its keys and the CLI work is in [API, CLI and integrations](../features/api-cli-integrations.md), and each operation's route file and scope is in the [route catalog](routes.md#9-public-api-v1).

## Know what's been closed

| Pull request | Closed |
| --- | --- |
| Fork PR #33 | The public profile page: `GET` and `PATCH /public-profile`, its CLI command, and `public_profile` in the onboarding manifest. |
| Fork PR #34 | A message's `request` and `appointment_id`, so a caller's cancellation request no longer looks like an ordinary message; a contact's `sms_consent` and `blocked_at`; a widget key's `key` and `embed_snippet`, which the dashboard has shown again since migration 0096; `slug` on `GET /business`; `hours_source`; the `website_live_chat` notification; a knowledge source's `tags` and `content_type`; and the values `locale` and `source` fields really take, in their descriptions. |
| Fork PR #35 | `onboarding_stage` on `GET /business` and `GET /businesses` is the stage the dashboard shows, the same as `GET /onboarding`, typed as the nine-stage enum. |

## Know what's still missing

| Gap | What the dashboard does | What to add |
| --- | --- | --- |
| Get or close one message | Marks a call's messages done from the call page (`apps/admin/app/api/calls/[callId]/route.ts`, through `completeVoiceFollowUpTasks`). The API only lists messages, and `messages:read` is its only message scope. | `GET /messages/{message_id}` under `messages:read`, reusing `loadMessageResource`, and `PATCH /messages/{message_id}` with `{ "status": "done" }` under a new `messages:write` scope. `completeVoiceFollowUpTasks` works per call and a message taken in a chat may have no call, so it needs a variant by message that keeps its grouping: an ordinary message closes its call's group, a cancellation request only itself. |
| Archive or restore a call | Owners and admins archive a call from its page, which hides it from the **Calls** list and Home's recent calls, and restore it there (`apps/admin/app/api/calls/[callId]/route.ts`, through `setCallArchived`; fork PR #100). The API's `GET /calls` still lists archived calls, and no call says it's archived. | `archived_at` on `Call`, and `PATCH /calls/{call_id}` with `{ "archived": true }` or `false` under a new `calls:write` scope, wrapping `setCallArchived`. Leaving archived calls out of `GET /calls` would change what existing callers see, so it needs its own filter. |
| Delete a contact, or block one | Deletes a contact, admins only and refused with 409 while something links to it, and blocks or unblocks its texts (`apps/admin/app/api/contacts/[contactId]/route.ts`). The API shows `blocked_at`, but `ContactUpdate` takes only `name`, `phone`, `email`, `locale` and `timezone`, and there is no `DELETE`. | `DELETE /contacts/{contact_id}` under `contacts:write`, wrapping `deleteContact` and keeping its 409, and a way for admins to block and unblock, as they set PINs. |
| Rotate a webhook secret, see deliveries, resend one | Rotates an endpoint's secret, lists its deliveries and resends one (`apps/admin/app/api/webhook-endpoints/[endpointId]/rotate-secret`, `.../deliveries` and `apps/admin/app/api/webhook-deliveries/[deliveryId]/resend`). Through the API, a leaked secret means deleting the endpoint and making a new one, with a new id and the events in between lost, and the events an endpoint missed before it was disabled, after about 23 hours of retries, can't be listed or sent again. | Under `webhooks:manage`, next to `POST /webhooks/{webhook_id}/test`: `POST /webhooks/{webhook_id}/rotate-secret`, which can't be idempotent; `GET /webhooks/{webhook_id}/deliveries`, paged over the 30 days kept (`WEBHOOK_HISTORY_RETENTION_DAYS`); and `POST /webhooks/{webhook_id}/deliveries/{delivery_id}/resend`. |
| A business's slug in the list | Shows the slug in **Settings > Public profile**, where it forms the page's address, `/profile/<slug>`. `GET /business` returns it too, but `GET /businesses`, a platform key's list of its businesses, doesn't. | `slug` on `BusinessSummary`. Its SQL function, `app.list_platform_partner_businesses`, has to be dropped and created again in a migration, since its return type changes. |
| More than 100 rules | Adds rules with no cap (`createAgentRule` in `packages/domain/src/server/rules.ts`), while the API refuses a 101st with 409. A reorder must list every rule, and both the dashboard's and the API's reorder take at most 100 ids (`RULES_MAX`), so a business with more than 100 rules can't reorder them anywhere. | Either check `RULES_MAX` in `insertAgentRuleInTransaction`, so the dashboard also refuses rule 101 (this changes the dashboard, not the API), or raise the reorder limit. |
| A service's name in other languages | Not shown in the dashboard either, but the receptionist and the public page read `services.localized_names`. | An optional, read-only `localized_names` on `Service`. Low priority. |

Deleting a business stays out of the API on purpose. Since fork PR #101 an owner deletes one from **Settings > Team**, confirming with its name and their password, which no API key, OAuth grant or MCP tool can give, and a key that could delete its business would make a leaked key cost everything in it ([delete a business](../features/business-deletion.md)). Canceling an account stays out too, for the same reason: since fork PR #102 its owner asks from **Settings > Team** and confirms from an emailed link with their password ([cancel an account](../features/account-cancellation.md)).

## Know which tables have no API

- **`conversations` and `messages`:** the text and website chat threads that the dashboard's **Messages** page reads, answers and hands to a person (`apps/admin/app/api/messages/route.ts`). The API can't read or answer them, and no webhook fires for an incoming text or chat. The API's own "messages" are something else: the messages the receptionist took for the team, kept in `inbox_items`.
- **`closures`:** the dates a business is closed. Availability and the public page read them, but nothing writes them, neither the dashboard nor the API.
- **`billing_transactions`:** billing history. Low priority.

Webhooks fire for `call.completed`, `appointment.booked`, `appointment.rescheduled`, `appointment.cancelled`, `message.taken` and `contact.created` (`webhookEventTypes` in `packages/shared/src/publicApi/constants.ts`).

## Add an operation

1. Add it to the registry, `packages/shared/src/publicApi/operations.ts`, with its schemas in `schemas.ts`. A new scope goes in `apiKeyScopes` in `constants.ts`, with its label in each language's `apps/admin/public/locales/<language>/settings.json`.
2. Write the operation in `packages/domain/src/server/publicApi/operations.ts`, reusing the dashboard's domain function so both keep the same rules.
3. Bind it in `apps/admin/src/lib/public-api/routes.ts` and add the route file under `apps/admin/app/api/v1/`.
4. Give it a CLI command in `packages/cli/src/operations.ts`.
5. Run `pnpm api:openapi`, which writes the OpenAPI file, `mintlify/api-reference/openapi.json`, from the registry.
6. Add it to the [route catalog](routes.md#9-public-api-v1), and take its row off this page.

Tests fail when an operation has no route file, no declared scope, a scope with no label, or an OpenAPI file out of date (`apps/admin/src/lib/public-api/contract.test.ts`), and when it has no command (`packages/cli/src/operations.test.ts`).
