# Choose a voice platform

Three studies between 2026-10-06 and 2026-10-08 compared ways to run the receptionist's voice: the provider study in the [phone call review](../reviews/phone-calls-2026-10-06.md#weigh-moving-off-openai), the [Azure port](azure-port.md) feasibility study, and the [voice agent market](voice-agent-market.md) research. This page brings their engineering comparison together. Nothing in it has been built: calls still run on GPT-Live over Twilio's SIP trunk ([voice runtime](../voice/runtime.md), [ADR 0008](../adr/0008-gpt-live-voice.md)). Prices, quotas and tiers are as the vendors published them on those dates and move monthly, so re-check a number before reusing it.

## Know where things stand

- **Today:** GPT-Live answers every phone and website call. Its audio goes from Twilio straight to OpenAI, and the worker holds one sideband connection per call.
- **For a C# port to Azure (2026-10-07):** the maintainer chose Azure OpenAI's Realtime API over SIP, with LiveKit kept as an optional fourth route. The port is a design only ([Azure port](azure-port.md)).
- **The re-check a day later (2026-10-08):** GPT-Live now beats that route on price, rated quality and concurrency, so choosing Azure rests only on Azure-specific needs (Entra ID sign-in, one Azure bill, data zones, C# on Functions), which cost about two cents a minute. The choice hasn't been revisited.
- **Undecided:** whether to prefer a provider that answers SIP itself or a cheaper one behind a media bridge; whether to use LiveKit; whether to build the provider seam that would make any switch a configuration change ([open items](../project/open-items.md)).

## Compare the four routes

All four keep the receptionist's own logic and feed each call from Twilio straight into a realtime model. Monthly costs are for 1,000 calls of four minutes (4,000 minutes) and include Twilio and about $70 of Azure hosting for the C# port; on today's Railway deployment GPT-Live's line is its $200 of minutes plus Twilio and Railway.

| | GPT-Live over SIP (today) | Azure OpenAI over SIP (chosen for the port) | Azure Voice Live | LiveKit Cloud (optional) |
| --- | --- | --- | --- | --- |
| How a call arrives | Twilio's trunk to OpenAI | Twilio's trunk to Azure OpenAI in East US 2 or Sweden Central | A Twilio media stream to a bridge of ours, since Voice Live has no SIP | Twilio's trunk to LiveKit's SIP service |
| Where the audio goes | Stays at OpenAI | Stays at Azure | Through our bridge | Through LiveKit and our agent |
| What runs per call | A process holding the sideband | A function holding a control socket | A container holding Twilio's stream and the Voice Live session | A Python agent on LiveKit Cloud |
| Voice model | `gpt-live-1`, full duplex, with a text agent working out each answer | `gpt-realtime-2.1` or its mini, which call tools themselves | A realtime or text model of our choice | `gpt-realtime-2.1` or its mini through LiveKit's plugin; GPT-Live or a speech-to-text pipeline by configuration |
| C# support | None: hand-written client | None for SIP call control | `Azure.AI.VoiceLive`, generally available | None for the agent: Python or Node |
| Voice a minute | $0.05 flat, plus the text agent's tokens | About $0.069; $0.023 on the mini | About $0.068, or $0.052 with an Azure voice; $0.026 on the mini | As over SIP, plus about $0.0125 for LiveKit |
| Twilio a minute | $0.0034 | $0.0059 with Twilio's recording | $0.0154 for the call, stream and recording | $0.0059 |
| Per month | About $284 | About $370; $185 on the mini | $395 to $440; $225 to $270 on the mini | About $400; $215 on the mini |
| At 10,000 calls a month | About $2,260 | About $3,040; $1,270 on the mini | About $3,440; $1,760 on the mini | About $3,510; $1,740 on the mini |
| Calls at once before asking | 50 on OpenAI's first paid tier, 300 on Launch, 500 on Grow | 100,000 tokens a minute: 2 or 3 calls if cached tokens count, about 30 if not | 100,000 to 120,000 tokens a minute: 2 to 4 calls, or 30 to 40 | Azure's quota, and 20 calls on LiveKit's Ship plan, 50 on Scale |
| Recovery when our process dies | Another worker re-attaches to the same session within about a minute (`live.recoverOrphans`), which OpenAI doesn't document | A lease and re-attach, if Azure keeps a call whose socket closed (undocumented) | Twilio's reconnect, then a new session seeded from saved turns | LiveKit sends a new agent in about 15 seconds; it starts with no memory |
| Recording | OpenAI stores it and we copy it | Twilio's trunk records it | Twilio records it | Twilio's trunk records it |
| Effort of a C# port | 44 to 64 days | 44 to 65 days | 44 to 63 days | 41 to 60 days |

No route can buy an uptime commitment for the voice itself. Multiplying the published SLAs of what a call depends on gives each route about 99.6% to 99.7% a month (2.2 to 2.9 hours), leaving out OpenAI's voice and LiveKit, which publish none. The useful protections are operational: the trunk's disaster-recovery address, and moving a number back to GPT-Live with one Twilio change.

## Know what changed the ranking

The 2026-10-08 re-check found every price unchanged, but four other facts moved:

- **Quality.** On Artificial Analysis's independent speech-to-speech index, GPT-Live scores 83.2 against 75.2 for `gpt-realtime-2.1`, and completes 59% to 75% of tasks on its τ-Voice benchmark against 38% to 46%. The minis cost 55% to 60% less than GPT-Live but complete 22.5%, a large risk for an agent whose job is booking. The index ran GPT-Live with a different delegate model and effort than LobbyStack uses, and nothing was measured over a phone line.
- **Concurrency.** OpenAI cut its usage tiers to three on 2026-10-06, and GPT-Live now gets 50 sessions at once on the first paid tier. The busiest hour needs about 4 calls at once at 1,000 calls a month and about 15 at 10,000.
- **Price.** GPT-Live costs about 26% less a minute than `gpt-realtime-2.1` on the same call model ($0.05 against $0.068).
- **Data residency** is no longer a clean Azure advantage: OpenAI's regional processing in the US or the EU adds about 10%, the same as an Azure Data Zone deployment. No speech-to-speech provider checked processes audio in Canada.

GPT-Live's supported languages aren't published, so French needs testing on real calls whichever route is kept.

## Compare other voice models

Per-minute figures convert each price on LobbyStack's model of a four-minute call. "Native SIP" means a Twilio trunk can reach the model with no bridge.

| Model | A minute | Index (τ-Voice) | Native SIP |
| --- | --- | --- | --- |
| GPT-Live | About $0.050 | 83.2 (74.5%) | Yes |
| Gemini 3.8 Live, Extended Thinking | About four times plain 3.8 Live | 82.6 (68.6%) | No |
| Grok Voice, Think Fast 2.0 and 1.0 | $0.06 to $0.09 | 81.3 and 73.7 | Not confirmed |
| Gemini 3.8 Live | About $0.012, or $0.06 if context is billed again each turn | 76.0 (30.1%) | No |
| `gpt-realtime-2.1` | About $0.068 | 75.2 (45.7%) | Yes, at OpenAI and Azure |
| `gpt-realtime-2.1-mini` | About $0.020 to $0.023 | 54.4 (22.5%) | Yes |
| Amazon Nova 2 Sonic | About $0.012 | Not ranked | No; 20 sessions per account and region, fixed |
| Ultravox | $0.05 to $0.055 | Not ranked | Yes; 5 calls at once on pay-as-you-go; changing owners |
| A cascade: speech-to-text, a fast text model, text-to-speech | $0.009 to $0.03 before orchestration | Not ranked | Through a platform |

Every frontier model starts speaking within 0.7 to 1.35 seconds, so task completion separates them more than latency does. Cascades are cheapest but answer in 0.6 to 1.7 seconds when stitched from different vendors, and several of their prices were promotional. The [phone call review](../reviews/phone-calls-2026-10-06.md#weigh-moving-off-openai) explains the three ways a Twilio call can reach a provider, and the [voice agent market](voice-agent-market.md) prices the hosted platforms such as Retell and Vapi, whose platform fee alone equals GPT-Live's whole price.

## Prove these before switching

1. **Extract the seam first.** A `VoiceProvider` and `VoiceSession` interface in `packages/agent-core`, with one generic `ask_backend` tool in place of GPT-Live's delegation, keeps the controller and the receptionist's logic whatever the provider ([phone call review](../reviews/phone-calls-2026-10-06.md#weigh-moving-off-openai)). It changes no behavior and is worth doing on its own.
2. **Test on phone audio.** Run the golden tests and recorded questions over real calls in English and French, and time the gap from the end of a question to the first audio of the answer.
3. **Measure the quota.** For any token-billed model, find out whether cached tokens count toward tokens a minute, or get the quota for the expected peak in writing.
4. **Keep the way back.** Move one staging number at a time; moving it back to GPT-Live is one Twilio change.

The small voice vendors have proven less durable than the carriers and model makers: four were bought or folded into larger companies within fifteen months. A provider seam and a one-change fallback are worth more than any single price gap.
