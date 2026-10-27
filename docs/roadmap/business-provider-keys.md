# Let businesses bring their own OpenAI and Twilio keys

Every business on a deployment shares one OpenAI key and one Twilio account, and so one rate limit, one spend limit and one count of GPT-Live sessions ([multitenancy](../features/multitenancy.md#know-what-the-deployment-shares)). A study on 2026-10-25 designed letting each business bring its own, kept encrypted in the database, with the deployment's keys as the default ([the study](../research/business-provider-keys.md)).

- **Status:** not started; waiting on the maintainer's decisions below.
- **Effort:** about 32 to 49 developer-days in six pull requests. The first two, 11 to 17 days, give businesses their own OpenAI key for chat, knowledge, summaries and browser calls, with no change to webhooks or numbers.
- **Related:** the same table could hold accounts the platform creates for each business, Twilio subaccounts and OpenAI projects, which [growing past one stack](scale-past-one-stack.md) needs per cell.

## Know what it would give

- A business's calls, chats and texts would run on its own OpenAI project and Twilio account, billed to it directly and under its own limits, so its calls no longer count against the deployment's GPT-Live sessions.
- A business without its own credential keeps using the deployment's, as today.
- A business whose own key fails stops with a clear message to its owner. It never falls back to the deployment's key, which would put its usage on the deployment's bill.
- Keys are write-only: the screen and the API show a hint, the status and the last check.

## Build it this way

- **One lookup per provider,** `openAIFor(businessId)` and `twilioFor(businessId)`, in place of the 13 places that read environment variables, with clients cached per process for about a minute.
- **One encrypted table** under forced row-level security, such as `provider_credentials`, with a key ring variable of its own apart from `ENCRYPTION_KEY`, a key version and the row's identity bound into every value, and the secret readable only by `lobbystack_worker`. `phone_numbers` and `calls` record which credential they use.
- **Owners only** change keys, after re-entering a password or code, with an email to every owner and an audit row. Saving checks the key with the provider, rate limited.
- **Webhook addresses per credential,** with a route token that picks the secret to check, then a match of the event's number to the credential's business, so one business can't forge events about another's number.
- **Billing:** a plan for own keys with a platform fee and no minute allowances, a `paid_by` mark on usage, and Polar events only for usage the deployment paid. Until then, an operator can bill such a business by hand with Enterprise's managed plan.

## Follow the plan

| PR | What it does | Developer-days | Needs |
| --- | --- | --- | --- |
| 1 | The lookups, serving only the deployment's credentials; nothing changes for users | 3 to 5 | None |
| 2 | The encrypted table, the owner's OpenAI key screen, the API and CLI, checks, audit and emails; chat, knowledge, summaries and browser calls on the business's key | 8 to 12 | 1 |
| 3 | Phone calls on the business's OpenAI project: its webhook route and owner match, a trunk per project, recovery and recordings by credential, the setup guide | 6 to 9 | 2 |
| 4 | The business's own Twilio account: numbers, trunk, texts, delivery reports and prices | 8 to 12 | 2, and 3 for its own OpenAI project |
| 5 | Billing for own keys | 4 to 6 | 2 |
| 6 | Hardening: master key rotation, two-secret windows, Twilio keys kept out of logs, end-to-end tests | 3 to 5 | 2 to 4 |

Not counted: testing with a second real OpenAI organization and Twilio account, and the privacy notice. Accounts the platform creates for each business take about the same: PR 5 drops out, and creating them by API adds 4 to 6 days.

## Decide these

| # | Question | Recommended |
| --- | --- | --- |
| 1 | Who holds the accounts: the business, the platform for each business, or both? | The business's own keys, with the deployment's as the default; the same table fits platform-made accounts later |
| 2 | What comes first? | PRs 1 and 2: OpenAI keys for chat, knowledge, summaries and browser calls |
| 3 | What happens when a business's own key fails? | Stop, mark it invalid and tell the owner |
| 4 | Who may change keys? | Owners only, after re-entering a password or code, with an email to every owner, since a swapped project receives every later call's audio |
| 5 | How do businesses with their own keys pay? | A plan with a platform fee and no minute allowances; whether the Free plan may use its own keys is open |
| 6 | Which master key? | A new key ring variable apart from `ENCRYPTION_KEY`, so each rotates alone |
| 7 | How are Twilio webhooks checked? | With the account's auth token, encrypted, accepting both tokens while rotating; Twilio's signing keys changed their header recently |
| 8 | Custom AI endpoints for each business, such as Azure OpenAI? | Not for now: they open requests to internal addresses and embeddings that don't match |
| 9 | Where do the deployment's own keys live? | In the environment, as today; a database row would still need a master key from the environment |

## Know the risks

The largest is concentration: the database plus one master key would unlock every business's OpenAI and Twilio accounts, so the master key lives only on the admin and the worker and every value is bound to its row. Next come forged webhooks between businesses, which the owner match stops, and a hijacked owner swapping in an attacker's OpenAI project, which owner-only changes and the emails make hard and visible. With its own key a business becomes OpenAI's customer for its callers' audio, so the privacy notice changes too. The [study](../research/business-provider-keys.md#know-the-security-risks) has the full list.
