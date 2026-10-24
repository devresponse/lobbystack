# Port the phone path to Azure in C#

On 2026-10-07 a study asked whether the phone path (Twilio and OpenAI call handling) and the knowledge lookup behind it could run as Azure Functions in C#, with no dashboard. The answer was yes, for about 9 to 13 weeks of one .NET developer's work, and the same day the maintainer chose Azure OpenAI's Realtime API over SIP as its voice. This page keeps the design. **Nothing has been built**, and a day later the [market re-check](voice-platforms.md#know-what-changed-the-ranking) found GPT-Live cheaper, better rated and less quota-bound than the chosen route, so the choice rests on Azure-specific needs. Code references were to the original's `main` at `77865d4` (#259); prices, regions and quotas are as published on 2026-10-07.

## Know the scope

| In | Out |
| --- | --- |
| Inbound calls through Twilio for each business's numbers | The dashboard, onboarding and every other screen |
| Answers from business settings and knowledge documents, in English and French | Browser and website calls, website chat |
| Taking a message, transferring to staff, ending the call | Booking, calendars and appointment changes |
| Transcripts, recordings and usage records | Texts |
| Adding and removing knowledge documents | Subscription billing |
| Emailing taken messages and call summaries | Reports beyond logs and Application Insights |

Behavior that must survive the port: busy (SIP 486) when the business is out of minutes, 603 for a blocked caller, 503 with no published settings; a greeting as soon as the call is answered; one question at a time with "still checking" after 4 seconds and a failure after 30; hanging up after 75 seconds of silence, at 30 minutes, or after the goodbye; transfers by the business's policy with a SIP REFER; every turn, the billed minutes and the recording saved.

Targets for the prototype and the pilot: the greeting heard within 2 seconds of the accept at the 95th percentile, answers no slower than today on the same questions, 30-minute calls, 25 calls on one instance, no call cut by a deploy, and tools answering again within 40 seconds after an instance is lost.

## Know the shape

A second Twilio Elastic SIP trunk sends each call to Azure OpenAI's SIP endpoint in East US 2, which hosts the audio and the voice model, and the trunk records each call, since Azure documents no recording. Four functions do the rest:

| Function | Trigger | Does |
| --- | --- | --- |
| `IncomingCall` | Azure OpenAI's `realtime.call.incoming` webhook | Checks the signature, finds the business by the dialled number, applies the minute cap and blocked callers, records the call, accepts it with the session's settings, queues it, and waits up to 5 seconds for the attach, all within the webhook's 10 seconds |
| `CallSession` | A Service Bus message, one per live call | Takes the call's lease, opens the control socket, asks for the greeting, saves each turn and tool call, runs the six tools and sends back their results, and finishes the call |
| `IngestDocument` | Event Grid events for Blob uploads and deletes | Extracts text (Document Intelligence reads scanned pages), chunks, embeds and indexes |
| `AfterCall` | A one-minute timer | Copies Twilio's recording, writes and emails the summary, and sweeps calls left without an owner |

Around them: .NET 10 on Flex Consumption with RollingUpdate deploys, so running calls finish (generally available only in four regions, so the functions run in North Central US and reach Azure OpenAI across regions); a Basic Service Bus queue; Azure Database for PostgreSQL 18 with pgvector; Blob storage; Key Vault; Application Insights. The code would be one .NET solution with projects for the functions, the realtime client, the receptionist's prompt and tools, knowledge, data access and tests, including a fake realtime server.

## Know the decisions

| # | Decision | Chosen | Main alternatives |
| --- | --- | --- | --- |
| D1 | Voice engine | Azure OpenAI's Realtime API over SIP | GPT-Live, as today; Azure Voice Live |
| D2 | Telephony | Twilio's SIP trunk, pointed at Azure OpenAI and recording each call | Twilio media streams; Azure Communication Services, which stopped taking new phone customers on 2026-10-23 |
| D3 | Model | `gpt-realtime-2.1` on a Global Standard deployment, with the mini tested beside it | `gpt-live-1`, which has no SIP on Azure; a Data Zone deployment |
| D4 | Compute | Functions on Flex Consumption | Premium plan; Container Apps as the fallback host |
| D5 | Call session | One Service Bus–triggered execution per call | An HTTP-held execution; Durable Functions |
| D6 | Ownership | A lease row per call in Postgres | The message lock alone, which covers one delivery, not one call |
| D7 | Interruptions | Re-attach to the same call | Hang up, as the original did then |
| D8 | Time limit | 30 minutes, enforced in code | `functionTimeout`, whose expiry restarts the worker and drops every call on it |
| D9 | Regions | Functions in North Central US, Azure OpenAI in East US 2 | Everything in East US 2, with deploys that cut calls |
| D10 | Realtime client | Hand-written on `HttpClient` and `ClientWebSocket` | The OpenAI .NET library's experimental realtime types |
| D11 | Tools | Function calls run in `CallSession`, answered by the voice model itself | A remote MCP server |
| D12 | Other AI | Azure OpenAI deployments for transcription, embeddings and summaries | OpenAI's API |
| D13 | Knowledge search | Today's Postgres hybrid search, ported | Azure AI Search |
| D14 | Database | PostgreSQL 18 with a slim schema, Burstable B1ms for the pilot | Cosmos DB for NoSQL; Table Storage with AI Search |
| D15 | Documents and settings | Blob uploads; a versioned JSON settings document per business | A dashboard or upload API |
| D16 | Notifications | Email for messages and call summaries | None |
| D17 | Spend and abuse | Keep the minute cap and blocked callers | Drop them with billing |

## Keep one owner per call

The design's recovery rests on two things Azure doesn't document: whether a call outlives its control socket, and whether a second socket can attach to it. The prototype tests both first; if either fails, deploys and scale-in still drain, but a crash cuts its calls.

- Each call has a Postgres lease, renewed every 5 seconds with a 20-second expiry; each renewal saves the call's length so far. A holder that misses renewals for 20 seconds stops sending and running tools.
- `CallSession` claims the lease, opens the socket at once and stamps the attach, then loads saved turns, tool calls and actions. `IncomingCall` polls for that stamp every 200 ms for up to 5 seconds, else hangs up.
- Tool calls and actions are saved before they run and again when done. A re-attach answers saved but unanswered tool calls, reports an action left half done as possibly done, and adds a note so the receptionist asks again rather than wait.
- On shutdown the execution stops renewing, closes the socket, releases the lease and sends a fresh attach message; if that send fails it throws, so Service Bus redelivers the original.
- `AfterCall` resends for calls whose lease has been missing for a minute, up to three times, then finishes them as `connection_lost`, and hangs up any call more than 31 minutes old.
- The month's minutes count elapsed time of active calls, at most 30 minutes each, instead of reserving 30 minutes per call.

## Choose the database

Keep PostgreSQL. It runs today's hybrid search unchanged in English and French. Burstable B1ms costs about $16 a month with 32 GB at 99.9% uptime (Microsoft doesn't recommend Burstable for production, and it allows 35 connections); General Purpose with a same-zone standby reaches 99.95% for about $267, the region's ceiling. Cosmos DB for NoSQL would commit to 99.99% for about $10 a month, but its French keyword search was in preview, and it needs about a week more work. Table Storage can't search, so it would need Azure AI Search at $74 to $147 a month. Across the services a call depends on (the voice, Functions, Service Bus and Twilio), the route commits to about 99.6% a month, about 2.9 hours, so the database isn't the limit.

## Follow the plan

| Phase | Days | Gate |
| --- | --- | --- |
| 1. Prototype | 17 | What a dropped socket does to the call and whether a second socket attaches; then the greeting within 2 seconds at p95, answers no slower than today, a 30-minute call, 25 calls on one instance, a deploy during them that cuts none, and tokens a minute measured |
| 2. Core call path | 12 to 20 | In a chaos run, a deploy, a killed instance and a dropped socket mid-call cut none, and recovery takes under 40 seconds |
| 3. Knowledge and after-call | 8 to 13 | The same passages from the ported search, and a recording, summary and email for every test call |
| 4. Hardening and pilot | 7 to 15, then two weeks | Two weeks of pilot calls for one or two businesses with none cut |
| **Total** | **44 to 65, plus the pilot** | |

Moving a pilot number is one Twilio change, and moving it back sends its next call to GPT-Live. If a function can't hold calls, `CallSession` moves to Container Apps; if the voice loses on quality or the quota isn't granted, the port switches to Voice Live or stays on GPT-Live. The 80 golden tests of the call path at the time (54 in `packages/agent-core/src/live`, 19 in `apps/worker/src/liveCalls.test.ts`, 7 for the webhook) would become C# tests where behavior carries over.

## Know the running cost

At 1,000 calls of four minutes a month:

| Option | Voice | Twilio | Azure | Per month |
| --- | --- | --- | --- | --- |
| GPT-Live on the same functions | $200 | $14 | About $70 | About $284, plus its text agent's tokens |
| `gpt-realtime-2.1`, Global Standard | About $275 | $24 | About $70 | About $370 |
| `gpt-realtime-2.1-mini` | About $93 | $24 | About $70 | About $185 |
| Either on a Data Zone deployment | About 10% more | $24 | About $70 | About $395 or $195 |

The voice bills tokens, so these are estimates from a model of a typical call that the prototype would replace with measurements. Audio is about 73% of a `gpt-realtime-2.1` call's cost, so the bill follows how long the receptionist talks more than how often it looks things up. The tokens-a-minute quota is likely to limit growth before cost does: 100,000 a minute holds 2 or 3 calls if cached tokens count, and 25 calls would need about 850,000.

## Know the alternatives

- **Voice Live:** Twilio streams each call's audio to a C# bridge on Container Apps that relays it to Voice Live. It gains a generally available .NET SDK and Azure's speech tools (voices, turn detection, noise suppression, phrase lists with a text model), and Twilio's one stream per call replaces the queue and lease. It costs a media bridge that the audio passes through, Twilio media streams at $0.0154 a minute, and sessions that can't resume. About 44 to 63 days, and $395 to $440 a month on its Pro model.
- **LiveKit:** LiveKit Cloud takes the trunk's calls and runs a Python agent that talks to Azure OpenAI and calls the C# functions for tools. Its framework replaces the hand-written client, queue and lease, and it sends a new agent within about 15 seconds of a crash. It costs a second language, a third vendor in the call path with no uptime commitment, and about $30 a month more; about 41 to 60 days. Self-hosting LiveKit on Azure would need virtual machines or AKS, since Container Apps has no UDP.
- **GPT-Live on the same functions:** keeps today's voice at $0.05 a minute, but leaves the voice outside Azure.

## Know the open questions

- What Azure does with a call whose control socket drops, and with two sockets on one call.
- Whether cached tokens count toward the quota, and what quota `gpt-realtime-2.1` gets.
- Where call data must live: Global deployments may process audio in any Azure region, and Data Zone deployments weren't documented for SIP.
- Whether Twilio's trunk keeps recording after a REFER, and whether the webhook's SIP headers tie Twilio's call to Azure's.
- Whether key sign-in can be switched off after the webhook is registered, and whether realtime deployments take a custom content filter.
- Whether the Foundry Models SLA covers realtime sessions over SIP.
- Which businesses would pilot, and whether booking, texts or a dashboard would be needed later, each adding weeks.
- How much uptime the database must commit to before phase 2.

The original stays in TypeScript, so every later call-path fix or prompt change there would have to be ported by hand.
