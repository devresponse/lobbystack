# Review the phone call path, 2026-10-06

On 2026-10-06 the phone call path (Twilio and OpenAI GPT-Live) was reviewed on the original project's `main` at `77865d4` (#259), as a developer guide, with twelve findings and a study of whether LobbyStack could move off OpenAI. Most findings have been fixed since, in the original project before the fork's reset or in the fork. This page keeps the findings with their state on `da1f548`, and the provider study. [Voice runtime](../voice/runtime.md) and [calls](../features/calls.md) describe the call path as it works now.

## Know how a call runs

A call to a business number travels from Twilio's Elastic SIP trunk straight to GPT-Live over SIP, so LobbyStack never carries its audio:

| Plane | Carried by | What travels |
| --- | --- | --- |
| Media | Twilio's trunk and OpenAI's SIP endpoint | The caller's and the receptionist's audio |
| Call control | OpenAI's webhook to the admin; REST calls to OpenAI | Ringing, accept, reject, hang up, transfer (SIP REFER), recording download |
| Conversation | One sideband WebSocket per call, held by the worker | Transcripts, delegated requests and their answers, usage, the session's end |

The admin's webhook (`apps/admin/app/api/webhooks/openai/live/route.ts`) finds the business by the dialled number, records the call and reserves minutes, then accepts with a session built from the business snapshot and asks the worker to attach. The worker's `LiveCallController` (`packages/agent-core/src/live/callController.ts`) answers GPT-Live's delegated requests with the same receptionist agent and tools website chat uses, saves the transcript, and finishes the call. Browser calls share the second half: they start at `POST /api/voice/live/session` over WebRTC.

## Know the findings and their state

| # | Finding | Impact | State on `da1f548` |
| --- | --- | --- | --- |
| 1 | Every worker deploy or restart hung up all calls in progress | High | Fixed: the worker drains calls before it stops, given `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860` |
| 2 | A worker crash left calls without a backend, and their records and minutes open | High | Fixed: `live.recoverOrphans` runs every minute for phone and browser calls |
| 3 | Callers who withheld their number shared one contact, so blocking one abusive caller blocked them all | High | Fixed: a withheld number gets a contact of its own with no phone, and the Twilio price lookup skips the caller filter |
| 4 | With a spending cap, one call in progress made the next caller hear busy | Medium | Fixed: phone calls reserve minutes in slices (`PHONE_RESERVATION_SLICE_SECONDS`) and top up |
| 5 | Phone calls ran up to 30 minutes whatever minutes or cap remained | Medium | Fixed by the same top-ups; a call ends politely when a top-up returns nothing ([calls](../features/calls.md#end-calls-politely-at-the-time-limit)) |
| 6 | A failed sideband connect ended the call | Medium | Fixed: the sideband retries before the session's first event (the original's #261) |
| 7 | Forwarded calls could route to the wrong deployment or ring out | Medium | Fixed: every `Diversion`, then `To`, then `P-Called-Party-ID` is tried in order |
| 8 | A transfer was recorded as completed when OpenAI accepted the REFER | Medium | Addressed: transfers are recorded as requested, referred, then completed or failed |
| 9 | Silence and duration limits hung up without a goodbye | Low | Fixed: a wrap-up with a goodbye, waiting for a pause (fork PR #54) |
| 10 | Recording copies could be lost on shutdown, and OpenAI keeps its stored copy | Low | Partly: a job retries the copy; OpenAI's stored copy still follows OpenAI's retention, not the plan's |
| 11 | Timing relied on an undocumented sideband event, and keypad input wasn't supported | Low | Partly: keypad digits drive PINs since fork PR #13; timing still reads `session.output_audio.delta` |
| 12 | An attach slower than the sideband's 3-second replay lost the start of the conversation | Low | Flagged on each call as `lateAttach`; the lost start isn't recovered |

Smaller notes from the review that still hold:

- The SIP `From` number is supplied by the caller's carrier and can be spoofed; no STIR/SHAKEN check is made. [Caller authentication](../features/caller-authentication.md) covers the modes that don't trust it.
- `phoneFromSipHeader` adds `+1` to any 10-digit number, which is right only in North America.
- `sip_media_security` isn't logged, so nobody can tell whether a call's audio was encrypted on the trunk.
- Deployments that share one OpenAI project each receive every call; a number present in two databases, such as after restoring production into staging, would be accepted twice.

## Rework the reliability changes

The same day, an earlier fork branch with call reliability changes was reworked to keep only what was clean to contribute: a retry of the worker's GPT-Live sideband when it fails before the session sends any event, using the OpenAI SDK's own `reconnect` option. It went to the original project, which merged it as #261. The rest was dropped: chunk ordering (covered by the original's #234), prompt rules for knowledge lookups, logging of callers' words, and a reformatting that caused most of the conflicts.

## Weigh moving off OpenAI

Switching is feasible without a rewrite. The receptionist agent runs on any OpenAI-compatible text model through the AI SDK; only the voice layer depends on OpenAI, in six files.

**The seam.** Most speech-to-speech APIs have no delegation, but they have tool calls. Giving the voice model one generic tool, `ask_backend({ request })`, in place of GPT-Live's delegation keeps the agent's multi-step logic and the controller whatever the provider. A `VoiceProvider` and `VoiceSession` interface under `packages/agent-core` would wrap accept, reject, hang-up, transfer, recording and the conversation channel.

**Three ways a Twilio call can reach another provider:**

1. **The provider answers SIP itself** (OpenAI Realtime, Azure OpenAI Realtime, Ultravox, ElevenLabs): today's shape stays, with no audio through LobbyStack.
2. **LobbyStack bridges the audio** (Gemini Live, Amazon Nova Sonic, Azure Voice Live, Deepgram): Twilio streams each call to a LobbyStack WebSocket service, which brings back a media gateway like the `apps/voice-gateway` the original removed in #201 (about 19,000 lines), with its deploy and latency costs.
3. **Twilio does speech-to-text and text-to-speech** (ConversationRelay): any text model works, but each turn waits for transcription, the model and synthesis.

**Providers, as their own pages said on 2026-10-06:**

| Provider | How a call reaches it | Published price |
| --- | --- | --- |
| OpenAI GPT-Live (today) | SIP from the trunk | $0.05 a minute, plus the backend model |
| OpenAI Realtime | The same SIP address; either API can accept a pending call | Per token |
| Azure OpenAI Realtime | SIP, in two regions | Per token |
| Ultravox | Native SIP | $0.05 a minute; 5 calls at once on pay-as-you-go |
| ElevenLabs Agents | Native SIP trunk | $0.08 a minute plus model usage |
| Gemini Live | WebSocket only: a bridge | Cheapest per minute |
| Amazon Nova Sonic, Azure Voice Live, Deepgram | A bridge | Per token or per minute |
| Twilio ConversationRelay | Twilio transcribes and speaks | $0.07 a minute plus the call |

**The plan, none of it started:**

1. Extract the interface with no change in behavior: a contained refactor worth doing whether or not anything switches.
2. Make call records and cost provider-neutral, with a voice provider per phone number.
3. Prove the seam with OpenAI Realtime on the same trunk, which needs no Twilio change.
4. Try a first non-OpenAI adapter on a staging number. Ultravox is the closest match: native SIP, spoken or silent results, recording, French and the same price; its frozen-while-tools-run model and 5-call limit are the things to test first.
5. Move browser calls last, since each provider has its own WebRTC client.

Whether to prefer a SIP-native provider or a cheaper bridged one is undecided. [Voice platforms](../research/voice-platforms.md) compares the options studied later, including LiveKit and Azure.
