# Find the future features

This folder holds the features that research or a review proposed and nobody has built yet, one page each: what the feature would do, how to build it, the effort, and what it waits on. The studies behind them keep their findings as of their dates in [research](../research/README.md) and [reviews](../reviews/README.md); these pages are kept current instead. Nothing here is started unless its page says so. Efforts are the studies' rough estimates for one developer, so check them against the code before planning on them. Checked against `main` at `c074ae4` (2026-10-26).

Each feature has a status:

- **Waiting on a decision:** the research is done, and the maintainer's answers decide what gets built. They are listed on its page and in [open items](../project/open-items.md#decide-these).
- **Ready when needed:** recommended work with no open question, to build when traffic, a customer or a deadline calls for it.
- **On hold:** designed, but later evidence points elsewhere.

## Know the features

**Sign-in and providers**

| Feature | What it gives | Effort | Status | Study |
| --- | --- | --- | --- | --- |
| [Sign in with Google and Microsoft](google-microsoft-sign-in.md) | Google and Microsoft buttons beside the password, joining existing accounts safely | About 11 days in 2 pull requests; Google alone about 8 | Waiting on 8 decisions | [2026-10-25](../research/google-microsoft-sign-in.md) |
| [Let businesses bring their own OpenAI and Twilio keys](business-provider-keys.md) | Each business on its own provider bills and limits, with the deployment's keys as the default | 32 to 49 days in 6 pull requests; own OpenAI keys for chat and browser calls first, in 11 to 17 | Waiting on 9 decisions | [2026-10-25](../research/business-provider-keys.md) |

**Calls and conversations**

| Feature | What it gives | Effort | Status | Study |
| --- | --- | --- | --- | --- |
| [Fill intake forms from calls and chats](intake-forms.md) | The receptionist asks a business's questions, and the form fills itself with the caller's words as evidence | A first version in 15 to 23 days and 5 pull requests | Waiting on 9 decisions | [2026-10-25](../research/intake-forms.md) |
| [Give calls a custom voice](custom-voices.md) | A voice of the deployment's own, a clone of a real person's voice, or a choice per business | 2 days for one voice; 3 to 4 for a picker; 8 to 12 for clones per business | Waiting on OpenAI and 7 decisions | [2026-10-25](../research/custom-voices.md) |
| [Make the voice engine swappable](voice-provider-seam.md) | Calls that can move off GPT-Live, or add a second voice source, by configuration | 3 to 5 weeks for phone calls | Waiting on a decision | [2026-10-06 to 10-08](../research/voice-platforms.md) |
| [Show why a call went wrong](call-diagnostics.md) | A diagnostics tab on each call page | 1 to 2 days for a first cut, 4 to 6 in full | Waiting on a decision | [2026-10-09](../research/observability-options.md) |
| [Run the phone path on Azure in C#](azure-phone-path.md) | The phone path as Azure Functions, for needs only Azure meets | 44 to 65 days, plus a pilot | On hold | [2026-10-07](../research/azure-port.md) |

**The website, scale and operations**

| Feature | What it gives | Effort | Status | Study |
| --- | --- | --- | --- | --- |
| [Protect the widget and the deployment](protect-the-deployment.md) | Floods and scripts stopped before they reach the app, and no business able to use up what all share | Four settings, then about nine code changes, not estimated | Ready when needed | [2026-10-15](../reviews/widget-scalability-2026-10-15.md) |
| [Grow past one stack](scale-past-one-stack.md) | More people at once, then surviving a failed machine, then cells | Phase 1 first; not estimated in days | Ready when needed | [2026-10-18](../reviews/scalability-2026-10-18.md) |
| [Deploy to Railway with one command](railway-bootstrap.md) | A new deployment from one settings file, one command and one sign-up | A few days | Waiting on a decision | [2026-10-14](../research/railway-automation.md) |

**Integrations and a new product**

| Feature | What it gives | Effort | Status | Study |
| --- | --- | --- | --- | --- |
| [Publish the n8n and Zapier integrations](n8n-and-zapier.md) | A dedicated n8n node, and the brands' private Zapier integration (fork PR #94) listed in Zapier's directory | 3 to 5 days for the node; 1.5 to 2.5 days for the listing | Ready when needed | 2026-10-13, in [integrations](../features/api-cli-integrations.md#connect-n8n) |
| [Offer a QR place guide](qr-place-guide.md) | A no-login guide at a place, paid for by the place's owner | A pilot with no code; a minimum product in 16 to 23 days at the time | Waiting on a decision | [2026-10-10](../research/qr-place-guide-market.md) |

## Know the smaller items

These are tracked only in [open items](../project/open-items.md), since each is a pull request or a choice rather than a project:

- **More call languages:** Serbian calls, a starter greeting in the business's language, texts in all 13 call languages, saving the language a caller spoke, and GPT-Live 1.1 once OpenAI's API offers it ([calls](../features/calls.md#know-which-language-a-call-uses)).
- **The rest of the widget review:** stop the history poll while live updates are up, measure time to the first word in chats, cache the loader, and a panel-only layout about 150 KB lighter. A standalone panel built like the loader would take one to two weeks, worth it only if load time on phones becomes the main complaint ([widget review](../reviews/widget-2026-10-15.md#follow-the-code-improvements)).
- **A middle plan** between Pro and Enterprise, where rivals sell one at $129 to $299 ([voice agent market](../research/voice-agent-market.md#estimate-the-profit)). Plans live in `brands/<brand>/billing.json`, but extra public plans don't show in the plan screens and checkout yet ([billing](../billing/README.md#know-the-known-problems)).
- **Smaller gaps:** appointment emails, changing a public page's address and custom domains, the API's remaining gaps, a check after each deploy, and the rest of the list in [open items](../project/open-items.md#build-these-when-theyre-needed).

## Know what was studied and not planned

| Idea | Why not | Study |
| --- | --- | --- |
| Move to Cloudflare Workers | A rebuild of the runtime layer, 52 to 81 days, with calls cut by deploys and runtime updates; pieces such as R2 for files or an AI Search trial remain options | [Cloudflare](../research/cloudflare.md) |
| A log page that reads Railway's API, or a full log search in the dashboard | The admin would hold a token for the environment that holds every secret, or rebuild a log tool over every business's data | [Observability options](../research/observability-options.md#weigh-logs-inside-the-dashboard) |
| A hosted identity service, or single sign-on per business | 4 to 8 weeks and per-user fees, or 2 to 4 weeks for something few small businesses ask for. Google One Tap waits for signs of sign-in friction | [Sign-in study](../research/google-microsoft-sign-in.md#compare-the-ways-to-add-it) |
| Outbound AI calls for surveys | OpenAI must enable outbound SIP, Twilio must enable Opus on the trunk, and a lawyer must sign off; texted links reach people first | [Forms study](../research/intake-forms.md#know-why-outbound-calls-wait) |
| Distributed Postgres, such as Citus | Every key would need the business, and its image has no pgvector; cells are the long-term answer | [Scalability](../reviews/scalability-2026-10-18.md#weigh-the-database-options) |
| Custom AI endpoints for each business | Requests to internal addresses, and embeddings that don't match | [Provider keys study](../research/business-provider-keys.md#know-the-security-risks) |
| A cloned voice through a bridge to another company's speech | The most work and the slowest of the ways to a cloned voice | [Voice study](../research/custom-voices.md#know-the-ways-out-if-openai-says-no) |

## Keep this folder true

- **Add a page when research proposes a feature,** linking the study, and a row above. The findings stay on the study's page, as of its date.
- **Record the maintainer's decisions** in [decisions](../project/decisions.md), and update the page's decisions and status in the same pull request.
- **When a feature ships,** describe it on its features page, add its changelog row, take it off [open items](../project/open-items.md), and remove its page and row here. Its study keeps a note of what was built.
- **When an idea is dropped,** move its row to the table above with the reason.
