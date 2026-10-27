# Find the research

This folder keeps the fork's research: studies of options that were weighed but mostly not built, and market research for the business. Each page gives the question, the answer, and what has happened since. Prices, quotas and market figures are as published on the study's date and move quickly, so re-check a number before reusing it. The features the studies propose are tracked, with their plans and the decisions they wait on, in the [roadmap](../roadmap/README.md). The repository's top-level `research/` folder is different: it holds the original project's marketing comparison articles.

## Engineering studies

| Date | Page | Question | Outcome |
| --- | --- | --- | --- |
| 2026-10-06 to 10-08 | [Choose a voice platform](voice-platforms.md) | Which voice engine should answer calls: GPT-Live, Azure OpenAI over SIP, Azure Voice Live, LiveKit or another? | GPT-Live stays. For a C# port to Azure the maintainer chose Azure OpenAI over SIP, but a day later GPT-Live proved cheaper, better rated and less quota-bound. Undecided |
| 2026-10-07 | [Port the phone path to Azure in C#](azure-port.md) | Can the phone path and knowledge lookup run as Azure Functions in C#? | Yes, in 44 to 65 days for one developer. Design only |
| 2026-10-08 | [Weigh a move to Cloudflare](cloudflare.md) | Can LobbyStack run on Cloudflare Workers with AI Search? | Only as a rebuild of the runtime layer; not now. The deploy-drop fix it recommended instead is done |
| 2026-10-09 | [Choose logs, monitoring and call tracing](observability-options.md) | How to see logs and tie errors to calls? | PostHog, plus tagging everything with its call (built, fork PR #41). The diagnostics tab is undecided |
| 2026-10-14 | [Automate a Railway deployment](railway-automation.md) | How to deploy from the fork with the fewest inputs, without the hosted template? | A bootstrap script with two infrastructure-as-code applies. Not built; the deployment guide covers the manual way |
| 2026-10-25 | [Plan sign-in with Google and Microsoft](google-microsoft-sign-in.md) | How can people sign in to the dashboard with a Google or Microsoft account? | Better Auth's own providers, about 8 days for Google and 3 more for Microsoft, with no migration. Not built; eight decisions wait |
| 2026-10-25 | [Weigh forms filled from calls and chats](intake-forms.md) | Can the receptionist interview callers and fill a business's form from the conversation? | Yes: fill it after the conversation from the transcript, with evidence and review; a first version is 15 to 23 days. Not built; nine decisions wait |
| 2026-10-25 | [Weigh a cloned voice for calls](custom-voices.md) | Can calls speak in a clone of the maintainer's own voice? | Yes, once OpenAI enables cloned voices, in English accents only; one voice for every call is about 2 days. Not built; seven decisions wait |
| 2026-10-25 | [Weigh each business's own OpenAI and Twilio keys](business-provider-keys.md) | Can each business bring its own provider keys, kept in the database? | Yes: an encrypted table with its own key ring, and a webhook address and owner check per credential; 32 to 49 days. Not built; nine decisions wait |

The phone call review's study of moving off OpenAI is in [review the phone call path](../reviews/phone-calls-2026-10-06.md#weigh-moving-off-openai).

## Business research

| Date | Page | Question | Outcome |
| --- | --- | --- | --- |
| 2026-10-08 | [Know the voice agent market, 2026](voice-agent-market.md) | How are voice agents hosted, priced and sold, how big is the market, and can LobbyStack make money? | A $3.5 to 3.7 billion market growing 35% to 39% a year; at LobbyStack's prices only the cheapest top-rated voice model, GPT-Live, keeps an illustrative 10,000-customer business profitable |
| 2026-10-10 | [Weigh a QR place guide](qr-place-guide-market.md) | Is there a market for a no-login AI guide reached by a QR code at a place, and how would it be billed? | Only if place owners pay; a 90-day pilot with one downtown district was proposed. Undecided |
| 2026-10-10 | [Choose the brand name](brand-names.md) | What should the guide's brand be? | AlloPlace, now the project's brand |
