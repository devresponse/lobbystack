# Use the API, the CLI and integrations

Everything an owner does in the dashboard, a program can do through the v1 HTTP API, its `lobbystack` command line, or the MCP server for AI assistants. Webhooks tell other systems what happened. This page says which key to use, what the fork added, how to test the receptionist's knowledge search, and how Zapier, Make and n8n connect. Checked against `main` at `5682041`, with fork PR #95's changes; the knowledge search section against `main` at `2a4004c`, with fork PR #130's.

## Know the pieces

| Piece | Where | What it is |
| --- | --- | --- |
| v1 API | `/api/v1/...` | 99 operations, all listed in one registry, `packages/shared/src/publicApi/operations.ts`, which also produces the OpenAPI file (`pnpm api:openapi`). |
| MCP server | `/api/mcp` | 21 tools for AI assistants over Streamable HTTP, with an API key or OAuth. |
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

The **Create an API key** dialog preselects the read scopes for calls, contacts, appointments, messages and the business, but not `webhooks:manage`, which Zapier and Make triggers and n8n's webhook setup need. Its **Set up for Zapier** button names the key Zapier, unless it already has a name, and ticks the nine scopes the Zapier integration's steps use, `webhooks:manage` included (fork PR #94). **Set up for Make** does the same for the Make app's modules, which need the same nine scopes, and names the key Make (fork PR #95). `/settings/api-keys?setup=zapier` and `?setup=make` open the dialog set up either way.

## Use the CLI

```bash
pnpm lobbystack login --url https://<dashboard domain> --key-stdin --profile ops
pnpm lobbystack --profile ops business get
pnpm lobbystack onboard manifest.yaml
```

`--key-stdin` reads the key from standard input, so it stays out of the shell history. Profiles are saved in `~/.config/lobbystack/config.json`. `lobbystack onboard` creates or updates a business from a YAML manifest: its details, services, hours, knowledge, public profile, team and phone number. Leave `plan` out of a self-hosted deployment's manifests.

## Test the receptionist's knowledge search

`POST /knowledge/search` runs the receptionist's knowledge search for one query, with the code a call or website chat runs, and returns every stage. It changes nothing in the business, so the same questions can be asked before and after a change to how documents are read, and the answers compared. It needs `knowledge:read`.

```bash
pnpm lobbystack knowledge search "parking fees"
pnpm lobbystack knowledge search "parking fees" --json > parking-before.json
```

The command prints the passages the search handed over in full, the candidates it dropped and why, how many matches the receptionist's model gets, and what a phone call's voice model hears. `--json` prints the whole answer:

| Field | What it holds |
| --- | --- |
| `evidence` | What the search returned from the database after ranking, the revision check and the 3,000-token budget, best first: the passages the `searchKnowledge` tool gets. Each has its chunk and source IDs, its text joined with the neighboring chunks that fit, where the ranked chunk sits in that text, its fused score, its place in each search, and its size in tokens. |
| `receptionist_result` | What the receptionist's model receives: the evidence, then the business's text entries and FAQs that share the query's words and fit, at most 6. It is the tool's own output, so its keys are camelCase. |
| `call_answer` | What a phone call's voice model hears after a step that only searched knowledge: the same matches as facts, cut to about 380 tokens. |
| `trace` | The query's terms and text search queries; the keyword search's results with their two `ts_rank_cd` scores and the semantic search's with their cosine distances, at most 12 each; every candidate after fusion with its text and what became of it (`evidence`, `below_limit`, `stale`, `unverified` or `over_budget`); and how many sources, chunks and embedded chunks the search can reach. |

- **Where it runs.** In the admin app, with the worker database role, the Redis snapshot cache and the embedding settings a website chat's search uses. Phone calls run the same code in the worker, so a call's search matches when the worker has the same `OPENAI_API_KEY` and `AI_EMBEDDING_*` settings; `trace.semantic.embedding_fingerprint` names the model.
- **Which receptionist.** Since fork PR #129 it searches as the business's default receptionist: the articles the default may use, its text entries and FAQs, and `trace.index` counts only those sources and chunks. A business without other receptionists gets every article, as before. On `feature/receptionists`, `receptionist_id` (`--receptionist-id`) searches as another one, as its calls and chats do, and a paused, archived or unknown one as the default; the answer's `receptionist_id` says which one it ran as ([API gaps](../reference/api-gaps.md)).
- **Which query.** The receptionist's model writes its own query. A call's or chat's AI trace (`lobbystack calls trace <trace_id>`) shows it in the `searchKnowledge` tool call, so that search can be repeated.
- **Comparing runs.** Reading a source again replaces its chunks, so chunk IDs change: compare titles, text and ranks.
- **Telemetry.** `duration_ms` is the search's own time; the score reads come after it. Each search counts in the `rag.search.*` metrics and the `knowledge.search_executed` event with `source: "api"`, so dashboards can leave these out, and both say how each half ended (`keyword` and `meaning` on the metrics, `keywordHalf` and `meaningHalf` on the event). It never logs or sends passage text.

### Save each answer in a folder

`--log-dir <folder>` also saves the answer as a JSON file in that folder, so a run can be read again later or compared with the next one. The CLI makes the folder when it's missing, and stops before searching when it can't. `LOBBYSTACK_KNOWLEDGE_LOG_DIR` saves every search the same way without the flag. The flag wins, and `--log-dir ""` saves nothing.

```bash
pnpm lobbystack knowledge search "parking fees" --log-dir .lobbystack/knowledge-searches/before
```

Each search gets a file of its own, named by when it was asked and then the question's words, such as `2026-11-03T18-45-12-345Z-parking-fees.json`. So a folder lists the searches in the order they ran, and one question's files end the same way in every run. A file is never written over: a second search of one question in the same millisecond gets `_2`. The text output ends with the file's path, and `--json` still prints only the answer.

| Field | What it holds |
| --- | --- |
| `requested_at` | When the search was sent, in UTC. |
| `cli_version` | The CLI's version. |
| `request` | The method, the full URL, the business ID and the body. The business ID is `null` when the command named none, so the key's own business was searched. The API key is never saved. |
| `response` | The API's answer as it came, with its `data` envelope: `response.data` is what `--json` prints. |
| `error` | In place of `response` when the search failed: the message and exit code, and the HTTP status, code and details when the API answered, as `--json` reports an error. |

`.lobbystack/` is in `.gitignore`, so searches saved there from the repository's root stay out of commits. The files hold passages from the business's documents, so keep them where those documents may be kept.

To ask a list of questions, one per line in `questions.txt`, before a change, and again into an `after` folder once it's deployed:

```bash
while IFS= read -r question; do
  pnpm lobbystack knowledge search "$question" --log-dir .lobbystack/knowledge-searches/before > /dev/null
done < questions.txt
```

```powershell
Get-Content questions.txt | ForEach-Object { pnpm lobbystack knowledge search $_ --log-dir .lobbystack/knowledge-searches/before | Out-Null }
```

Then compare the two folders file by file, pairing the files by the part of the name after the time, or by `request.body.query`.

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
| #95 | The Make app under each brand's own name and account: `npm run build` for a brand, a Make card on the **Integrations** page and **Set up for Make** in the Create dialog. |
| #129 | With several receptionists, `GET` and `PATCH /receptionist` stay the business's default receptionist, with the settings every receptionist shares; knowledge added through the API is for every receptionist unless `audience` says otherwise; and the plans and the catalog say how many receptionists each plan includes (`receptionists`). On `feature/receptionists`, `/receptionists` and `lobbystack receptionists` list, add, change, pause, archive, restore, order and make default the others, `?receptionist_id=` on `/receptionist` reaches each one's settings, numbers and widget keys say and change who answers them, calls and messages say which receptionist answered, with a filter on their lists, `/qr-links` and `lobbystack qr-links` make, list, change and pause QR links, with their scans, and knowledge entries and sources say and change who they're for, many at once with `POST /knowledge/audience` (`lobbystack knowledge audience`), with website rules giving a site's pages under a path to one receptionist (`/knowledge/website-rules`, `lobbystack knowledge rules`), and `/knowledge/questions` lists, answers and dismisses the questions the receptionist couldn't answer (`lobbystack knowledge questions`, `answer`, `dismiss`). The MCP server's `list_receptionists`, `list_questions` and `answer_question`, `receptionist_id` on `list_calls` and `list_messages`, and `receptionist_ids` on `add_knowledge` do the same for AI assistants, which may now be granted `knowledge:read`. The Zapier and Make apps fill a receptionist drop-down from `GET /receptionists`, and Add Knowledge (Add a knowledge entry in Make) takes the receptionists an entry is for. `lobbystack onboard` adds and updates the receptionists a manifest's `receptionists` lists, with each one's own `settings` ([API gaps](../reference/api-gaps.md#know-whats-still-missing), [receptionists](receptionists.md)). |
| #130 | `POST /knowledge/search` and `lobbystack knowledge search`: the receptionist's knowledge search with every stage shown ([above](#test-the-receptionists-knowledge-search)). |
| #131 | `lobbystack knowledge search --log-dir <folder>` and `LOBBYSTACK_KNOWLEDGE_LOG_DIR`: each answer saved as a JSON file ([above](#save-each-answer-in-a-folder)). |
| Migration `0148` | Prepaid minute packs, built on `feature/receptionists` ([prepaid packs](prepaid-packs.md#see-packs-in-the-api-and-the-cli)). `POST /billing/packs/checkout` starts a checkout for a pack, named by its code, and `GET /billing/packs/checkout/{checkout_id}` follows it until its page is `ready`, then `paid`; `lobbystack billing buy-pack <pack>`, with `--wait` for the page, and `lobbystack billing pack-status <checkout_id>` do the same. Both need `billing:manage`. A business makes one purchase at a time, so a pack checkout still pending or processing holds plan checkouts and plan changes (409), and the other way round. A business on a pack can buy a plan through `POST /billing/checkout`; its packs end once the plan is live. `GET /billing` lists the packs bought under `packs`, which `lobbystack billing status` shows after the plan, and `plan` reads `prepaid` while an active pack has time left. |
| Migration `0149` | The prepaid packs' review, also on `feature/receptionists`. `GET /billing/packs/checkout/{checkout_id}` adds `pack_status`, what became of the pack a paid checkout added: `active` or `frozen` while the business has it, `expired` once its days ran out, `replaced` once a plan the business bought ended it, at once when the plan started before the payment arrived, and `refunded` when its payment went back. `paid` stays true for all of them. `lobbystack billing buy-pack --wait` says which, and a plan that starts closes the business's open pack checkouts, which then read `expired` or `failed` with an `error` saying a plan started, which `--wait` tells apart from a provider's failure. A promo code finds no plan for a business whose subscription a pack's payment replaced, as once that plan ended. |

## Connect Zapier

`integrations/zapier` is a Zapier Platform app outside the pnpm workspace. It only calls the v1 API with a business key. It has 6 triggers (call completed, appointment booked, rescheduled or cancelled, message taken, contact created), 6 actions, 3 searches and Find or Create Contact. Turning a trigger Zap on creates a webhook named "Zapier: &lt;label&gt;". On `feature/receptionists`, the call and message triggers take an optional receptionist and keep only what it answered, Add Knowledge takes the receptionists the entry is for, and calls, messages and knowledge entries show `receptionist_id` and the audience fields.

Each brand publishes it on its own Zapier developer account, under its own name (fork PR #94). `npm run push -- --brand <id> --url <dashboard address>` uploads it with the name from the brand file, the dashboard's address as each new connection's default, and a help link to that dashboard's Zapier dialog. AlloPlace's is a private integration, on a Zapier account under an alloplace.com address, that people join through its invite link, which AlloPlace's brand file has as `links.zapier`. The [integration's README](../../integrations/zapier/README.md#publish-it-for-a-brand) has the steps. The original project registered its own copy on its own Zapier account, and this folder no longer points at it.

With the invite link in the brand file as `links.zapier` ([branding](../branding.md#send-the-outside-links-to-your-own-site)), the **Integrations** page shows a Zapier card. Its dialog:

1. opens the invite in Zapier;
2. links to the Create dialog set up for Zapier (`/settings/api-keys?setup=zapier`);
3. says to pick the brand in a Zap, paste the key, and check that the connection's address is this dashboard's.

A brand without a Zapier link, such as LobbyStack, shows no card. `/integrations?setup=zapier` opens the dialog, and the help link in the integration's API key field goes there. Book Appointment needs the agent's **Booking** set to **Books appointments**.

`zapierOperationIds` in `packages/shared/src/publicApi/operations.ts` lists every operation the integration calls, and the scopes **Set up for Zapier** ticks come from it. `packages/shared/src/publicApi/zapier.test.ts` checks in every CI run that the integration's samples have the fields the API returns.

Without the brand's integration, Webhooks by Zapier, on a paid Zapier plan, works with a webhook from **Integrations > Webhooks** and the v1 API.

## Connect Make

`integrations/make` is an app for Make, in the local format of Make Apps Editor, Make's extension for VS Code (fork PR #95). It sits outside the pnpm workspace, has no dependencies, and only calls the v1 API with a business key. It has 6 instant triggers, for the same events as Zapier's, 12 modules for calls, appointments, contacts and knowledge, Make an API call for any other path, and 6 drop-down lists. On `feature/receptionists`, Add a knowledge entry chooses the receptionists the entry is for from the receptionist list, and calls, messages and knowledge entries show `receptionist_id` and the audience fields; a scenario's filter keeps one receptionist's calls or messages. Creating a trigger's webhook in Make creates a webhook named "Make: &lt;module name&gt;".

Each brand creates it in its own Make account, under its own name. `npm run build -- --brand <id> --url <dashboard address> --app-id <app> --zone <zone>` fills in the name from the brand file, the dashboard's address as each new connection's default, and a help link to that dashboard's Make dialog, for the editor's **Deploy to Make** to upload. AlloPlace's will be published from a Make account under an alloplace.com address and shared through its invite link. Publishing can't be undone, so the steps test a private copy first. The [app's README](../../integrations/make/README.md#deploy-it-for-a-brand) has them.

With the invite link in the brand file as `links.make` ([branding](../branding.md#send-the-outside-links-to-your-own-site)), the **Integrations** page shows a Make card. Its dialog:

1. opens the invite in Make;
2. links to the Create dialog set up for Make (`/settings/api-keys?setup=make`);
3. says to add the brand's module to a scenario, create a connection with the key, and check that its address is this dashboard's.

A brand without a Make link, such as LobbyStack, shows no card. `/integrations?setup=make` opens the dialog, and the help link in the app's API key field goes there. Book an appointment needs the agent's **Booking** set to **Books appointments**.

Two things differ from Zapier. A webhook's code in Make doesn't see the raw request, so it can't check signatures: the long, random webhook address that only the dashboard learns is the secret. And Make has nothing to make an Idempotency-Key from, so the modules send none; none of their operations require one. `makeOperationIds` and `makeWebhookEvents` in `operations.ts` list what the app uses, and the scopes **Set up for Make** ticks come from them. `packages/shared/src/publicApi/make.test.ts` checks in every CI run that each request fits its operation and that each module's output fields match what the API returns.

Without the brand's app, Make's own HTTP module and its custom webhook trigger work with a key and a webhook from **Integrations > Webhooks**.

## Connect n8n

n8n works with what's there, with no LobbyStack changes:

- **Actions:** the MCP Client node at `/api/mcp`, Streamable HTTP with a Bearer `lsk_` key, runs the 21 MCP tools. The HTTP Request node covers the v1 API.
- **Triggers:** a webhook made in **Integrations > Webhooks** that posts to an n8n Webhook node. LobbyStack delivers only to public `https://` addresses: it refuses `localhost`, `*.local`, `*.internal` (so `*.railway.internal`) and private IPs.
- **Signatures:** check them in a Code node with `crypto` (on self-hosted n8n, allow it with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`).

A dedicated n8n node, porting the Zapier app's actions and a trigger that manages its own webhook, would take about 3 to 5 days and isn't built. n8n Cloud shows only verified nodes, which have publishing rules of their own ([roadmap](../roadmap/n8n-and-zapier.md)).
