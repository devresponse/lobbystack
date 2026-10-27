# Weigh each business's own OpenAI and Twilio keys

On 2026-10-25 a study asked whether each business could bring its own OpenAI key and Twilio account, kept encrypted in the database, with the deployment's environment keys as the default. It read the code on `main` at `62517d2` and OpenAI's and Twilio's pages as published that day, and changed no code. **Its answer: yes.** The places that read the keys become one lookup per provider, and the code has the pieces: jobs and calls carry their business, and calendar tokens are already encrypted. Chat, knowledge, summaries and browser calls need only a client per business. Phone calls and texts also need a trunk and webhook addresses per credential, and a check that each event's number belongs to that business. Billing needs a plan for businesses that pay the providers themselves. Nothing is built; [let businesses bring their own keys](../roadmap/business-provider-keys.md) tracks the plan and the nine decisions it waits on.

## Know how the code read the keys

Every Twilio and OpenAI credential came from an environment variable, read in 13 places across the admin and the worker, and most clients were built once when the process started, so one key served every business:

| Variable | Read in | What for |
| --- | --- | --- |
| `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET` | The admin's `getLiveClient` (`apps/admin/src/lib/live-prototype.ts`) | Checking the incoming-call webhook; accepting, rejecting and hanging up calls; creating browser calls |
| `OPENAI_API_KEY` | The worker's `src/liveCalls.ts` and `src/index.ts`, at boot | Each call's sideband, transfers, hang-ups, greeting recordings, crash recovery and recording copies |
| `AI_CHAT_API_KEY`, else `OPENAI_API_KEY` | `createAgentModel` (`packages/agent-core/src/model.ts`) | Website chat replies, call delegation, call and business summaries, opening hours |
| `AI_EMBEDDING_API_KEY`, else `OPENAI_API_KEY` | `packages/providers/src/ai/embeddingProvider.ts` | Indexing knowledge and searching it during chats and calls |
| Whether `OPENAI_API_KEY` is set | `apps/admin/app/api/widget/config/route.ts` | Whether the widget offers a call |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | The admin's `getTwilioProvider`, and the worker at boot | Number search, purchase, trunking and release; texts and codes; text and call prices |
| `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_WEBHOOK_URL` | `apps/admin/app/api/webhooks/twilio/sms/route.ts` | An inbound text's signature, checked before the business is known |
| `TWILIO_AUTH_TOKEN` or `TWILIO_ALERT_WEBHOOK_SECRET` | `apps/admin/src/lib/twilio-status-auth.ts` | Delivery-status callbacks |
| `TWILIO_SIP_TRUNK_SID`, `TWILIO_ALERT_*`, `TWILIO_STATUS_CALLBACK_URL` | The worker | The trunk for new numbers and call prices, the shared alert sender, each text's callback address |

Two settings live outside LobbyStack: the OpenAI project's webhook, in OpenAI's dashboard, and the trunk's origination address `sip:<project id>@sip.api.openai.com`, in Twilio ([voice runtime](../voice/runtime.md)). The database knows each number's Twilio SID and trunk, but not which Twilio account owns it.

## Know what each feature needs

| Feature | With the business's own OpenAI key | With its own Twilio account |
| --- | --- | --- |
| Website chat | The model built from the business's key; the route already builds one per request | Nothing |
| Knowledge | An embedding client per business; the index's fingerprint holds no key, so the same model needs no re-embedding | Nothing |
| Summaries and opening hours | A model per worker job; jobs already carry `businessId` | Nothing |
| Browser calls | The session created with the business's key, and the worker's sideband, hang-up and recording copy on the same project | Nothing |
| Phone calls | The business's OpenAI project with GPT-Live SIP turned on, its own webhook to a per-business address, and a trunk pointed at its SIP address | Numbers on a trunk in the business's account; transfers bill to it |
| Crash recovery and recordings | The key the call started with, so each call records its credential; a Zero Data Retention project keeps no recording | Nothing |
| Numbers | Nothing | Search, purchase, adoption and release on the business's account |
| Texts out, texts in and delivery reports | Nothing | The business's account, under its own A2P 10DLC registration; a webhook address per account, then a match of `AccountSid` and number |
| Twilio prices | Nothing | Fetched with the business's account and marked as the business's cost |
| The widget's call button | Whether the business has a working key, not whether the variable is set | Nothing |

A business that brings only its OpenAI key still needs its own trunk for phone calls, because a trunk sends all its numbers to one SIP address; Twilio allows 100 trunks per account unless its sales team raises the limit. The same storage could instead hold accounts the platform creates for each business: Twilio subaccounts, which bill to the main account (1,000 by default), and OpenAI projects with their own spend limits, both created by API, though each project's webhook and SIP access are set up by hand.

## Store the keys

One new encrypted table under the same forced row-level security as every business table, such as `provider_credentials`, holding the business; the provider; a status (checking, active, invalid or revoked, set to invalid when the provider answers 401); the public fields that route webhooks and are shown to members (the OpenAI project ID, the Twilio account and API key SIDs); the key's last four characters; the encrypted secrets; the master key's version; a random route token for webhook addresses; health fields; and who added it. `phone_numbers` and `calls` gain a nullable `provider_credential_id`, where null means the deployment's.

`SecretBox` (`packages/providers/src/crypto/secretBox.ts`), AES-256-GCM with a key derived from `ENCRYPTION_KEY`, already encrypts calendar tokens and webhook secrets. Provider keys need three additions:

1. A key version in every value and a key ring variable, such as `PROVIDER_SECRET_KEYS=v2:…,v1:…`, so a job can re-encrypt everything under a new key. Today one key covers everything, so changing `ENCRYPTION_KEY` breaks every stored token and every API key hash at once.
2. Associated data that ties each value to its row, so a value copied into another business's row fails to decrypt.
3. A key apart from `ENCRYPTION_KEY`, which also peppers API key hashes, so each rotates alone. Saving fails when the key is missing, in every mode, unlike the outbound webhook code's fixed development key outside production.

Only `lobbystack_worker`, which the admin already uses for webhooks and chat, may read the encrypted column; never `lobbystack_app` or `lobbystack_readonly`. Only an owner changes a key, after re-entering a password or a code; every owner gets an email; the audit log records who, when and the hint; and the screen and the API are write-only. A webhook finds its credential before the business is known through a security-definer resolver by route token, like `app.resolve_business_by_phone`.

## Resolve, check and rotate

`openAIFor(businessId)` and `twilioFor(businessId)` return the client, its source and the credential, with decrypted clients cached per process for about a minute. In the admin, `getLiveClient()` and `getTwilioProvider()` take a business, and the model and embedding factories take a key instead of reading `process.env`; in the worker, the clients built at boot become lookups inside each job and each attach. No credential means the deployment's. A credential marked invalid stops the feature with a clear message and tells the owner, since quietly using the deployment's key would put that business's usage on the deployment's bill.

Saving a key checks it, rate limited per user and business so the screen can't test stolen keys: list OpenAI's models and look for `gpt-live-1` and the chat model; make a test call to the business's number; fetch the Twilio account; and fetch the trunk and its origination address.

| What changes | What LobbyStack needs |
| --- | --- |
| An OpenAI key in the same project | Revoke the old one 30 minutes after saving the new one, the longest a call runs |
| The OpenAI project | Keep the old credential as retiring until its calls finish and their recordings copy, and move the trunk to the new SIP address |
| The OpenAI webhook secret | Add a second webhook with the new secret, save it, then delete the first; the admin already treats a second delivery as a retry |
| A Twilio API key | Save the new one, then delete the old one |
| The Twilio auth token | Save the secondary token before promoting it, since promotion deletes the old one at once, and check signatures against both; or use Twilio's signing keys, which rotate apart from the token |
| The master key | Add a version to the key ring, let a job re-encrypt every row, then drop the old version |

## Check every webhook twice

A signature can be checked only once its secret is known, and OpenAI's incoming-call event names no project, so each credential needs its own addresses: `/api/webhooks/openai/live/<route token>`, set by the owner in the business's OpenAI project; `/api/webhooks/twilio/sms/<route token>`, set as the number's SMS address when it's bought or adopted; and a status callback with the token, which the worker sets on each text. The token isn't a secret, since it shows in OpenAI's and Twilio's dashboards; it only picks which secret to check, and an unknown token answers 404 before any database write. OpenAI documents no API for creating webhooks, so the owner adds the address and pastes the secret.

After the signature, each event must match its number's owner: the dialled number belongs to the credential's business, or `AccountSid` is the credential's account and `To` an active number of the same business and credential. Without the match, a business holding a valid secret for its own account could sign a text "to" another business's number, which LobbyStack would record, alert that team about and could even treat as a STOP; a forged call event could spend another business's minutes and reach its booking tools. The deployment's addresses stay for the deployment's credentials and refuse numbers on a business's own account.

## Bill businesses that pay the providers

| Part of billing | With the business's own keys |
| --- | --- |
| Allowances | No longer protect the deployment's bill: fair-use caps, or none, like the self-hosted plan |
| Overage events to Polar | Only for usage the deployment paid; a minute on the deployment's trunk still costs it about $0.0034 |
| Spending cap | Doesn't cover the business's own bills; its OpenAI spend limit and Twilio balance do |
| Phone numbers | A number on the business's account costs the deployment nothing, so the one-number limit can lift |
| Unit economics and the finance export | A `paid_by` mark on each event, so the business's costs don't count as the deployment's |
| Rate limits | Stay: they protect the shared worker, database and Redis |

A plan for own keys would charge a platform fee, with no or fair-use allowances and `overagesBillable: false`. The plan tiers are fixed in code, so it needs a new tier, or Enterprise's managed plan by hand at first (`pnpm lobbystack billing managed-plan`). The business's own limits then stop its calls: a project at its spend limit gets 429 from OpenAI, which browser calls show as a 502 and phone calls as SIP 503, so the dashboard should say why. In return, each such business gets its own OpenAI limits instead of sharing one project's 50 GPT-Live sessions on the first paid tier.

## Know the security risks

| Risk | How to reduce it |
| --- | --- |
| One breach exposes every business's keys: the database plus the master key would unlock every account, for toll fraud and SMS pumping on their Twilio accounts too | The key ring with associated data, the master key only on the admin and the worker, revocable Twilio API keys rather than the auth token, spend limits asked of every business, and a cloud key service later |
| Forged webhooks between businesses | A route token per credential, and the owner match after the signature |
| A hijacked owner swaps in an attacker's OpenAI project, which then receives every later call's audio, transcript and recording | Owners only, a re-entered password or code, email to every owner, an audit row, and the project ID shown on the dashboard |
| Keys in logs: redaction covers `sk-` keys and Bearer tokens, but not a Twilio Basic header or a 32-character auth token (`packages/telemetry/src/node.ts`) | Extend the redaction, and never log a client's options |
| Requests to internal addresses, if a business could point its key at its own server | Per-business keys for `api.openai.com` only, or an allowlist checked with `createGuardedLookup`, as outbound webhooks are |
| A key-testing oracle | Owners only, and a rate limit per user and business |
| Callers' data under another contract: with its own key, the business is OpenAI's customer for its callers' audio, and a Zero Data Retention project keeps no recording | Say so on the screen, and update the privacy notice and sub-processor list |
| A business's broken account stops its calls and texts | A daily check, an invalid status, a dashboard banner and an email; no silent fallback |

## Know what it found on the way

Twilio's page on signing keys names their header `X-Twilio-Webhooks-Signature-Settings`, while `apps/admin/app/api/webhooks/twilio/status/route.ts` reads `x-twilio-signature-key-sid`, so delivery reports from a separate alert account (`TWILIO_ALERT_*`) may fail their check. The deployment guide tells deployments to leave those variables empty, so it likely affects none ([open items](../project/open-items.md#build-these-when-theyre-needed)).

## Know the plan it proposed

| PR | What it does | Developer-days | Needs |
| --- | --- | --- | --- |
| 1 | The seam: `openAIFor` and `twilioFor` serving only the deployment's credentials, and clients built per business in the admin and the worker; nothing changes for users | 3 to 5 | None |
| 2 | The encrypted table (migration, row-level security, grants, resolvers, key ring), the owner's OpenAI key screen in four languages, the v1 API and CLI, checks, audit and emails; chat, knowledge, summaries and browser calls use the business's key | 8 to 12 | 1 |
| 3 | Phone calls on the business's OpenAI project: the per-credential webhook route and secret, the owner match, a trunk per project on the deployment's Twilio account, calls, recovery and recordings by credential, and the setup guide | 6 to 9 | 2 |
| 4 | The business's own Twilio account: its key and signing secret; number search, purchase, adoption and release; its trunk; text and delivery-report routes with the match; texts and prices through it | 8 to 12 | 2, and 3 to reach the business's own OpenAI project |
| 5 | Billing for own keys: the plan, `paid_by` on usage and unit economics, Polar events only for what the deployment paid, and the plan screen's words | 4 to 6 | 2 |
| 6 | Hardening: the master key rotation job, two-secret windows, Twilio redaction, rate limits on checks, end-to-end tests | 3 to 5 | 2 to 4 |

About 32 to 49 developer-days in all, with tests and docs. PRs 1 and 2, 11 to 17 days, already give businesses their own OpenAI key with no change to webhooks. Accounts the platform creates for each business take about the same: PR 5 drops out, and creating subaccounts and project keys by API adds 4 to 6 days. Not counted: testing with a second real OpenAI organization and Twilio account, and the privacy notice.
