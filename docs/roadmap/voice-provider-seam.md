# Make the voice engine swappable

Every phone and browser call runs on OpenAI's GPT-Live, and the code depends on it directly ([ADR 0008](../adr/0008-gpt-live-voice.md)). The phone call review of 2026-10-06 and the voice platform studies that followed recommended a seam that would let calls move to another voice provider, or add a second one, by configuration ([phone call review](../reviews/phone-calls-2026-10-06.md#weigh-moving-off-openai), [voice platforms](../research/voice-platforms.md)).

- **Status:** not started. Whether to build it, and which kind of provider to prefer, is undecided.
- **Effort:** about 3 to 5 weeks for phone calls, by the 2026-10-25 voice study's estimate; browser calls need each provider's own client on top.
- **Why it matters:** GPT-Live allows at most 500 calls at once on OpenAI's self-serve tiers, shared by every business; OpenAI gates features such as [cloned voices](custom-voices.md); small voice vendors keep changing hands; and a second source keeps calls going if one provider fails or changes its terms.

## Build it this way

1. **Extract the interface, with no change in behavior:** a `VoiceProvider` and a `VoiceSession` in `packages/agent-core` that wrap accepting, rejecting, hanging up, transferring, recording and the conversation channel, with one generic `ask_backend({ request })` tool in place of GPT-Live's delegation, so the receptionist's logic and the call controller stay whatever the provider. This is worth doing on its own.
2. **Make call records and costs provider-neutral,** with a voice provider for each phone number.
3. **Prove the seam with OpenAI's Realtime API** on the same trunk, which needs no Twilio change.
4. **Try a first non-OpenAI adapter** on a staging number. Ultravox was the closest match: native SIP, recording, French and the same price. Its model, which freezes while tools run, and its limit of 5 calls at once on pay-as-you-go are what to test first.
5. **Move browser calls last,** since each provider has its own WebRTC client.

## Choose a kind of provider

| Kind | Examples | Trade-off |
| --- | --- | --- |
| Answers SIP itself | OpenAI Realtime, Azure OpenAI Realtime, Ultravox, ElevenLabs | Today's shape: no audio passes through LobbyStack |
| Behind a bridge of LobbyStack's | Gemini Live, Amazon Nova Sonic, Azure Voice Live, Deepgram | Often cheaper, but brings back a media gateway like the `apps/voice-gateway` the original removed, with its deploy and latency costs |
| Twilio listens and speaks | ConversationRelay | Any text model, but each turn waits for transcription, the model and speech |
| A voice agent framework | LiveKit Cloud | A new agent within about 15 seconds of a crash, but a third vendor in the call path and a second language |

On 2026-10-08 GPT-Live led on price, rated quality and concurrency, so the seam is insurance more than a switch ([what changed the ranking](../research/voice-platforms.md#know-what-changed-the-ranking)).

## Prove these before switching

- Run the golden tests and recorded questions over real phone calls in English and French, and time the gap from the end of a question to the first audio of the answer.
- For a model billed by tokens, find out whether cached tokens count toward its tokens-a-minute quota, or get the quota for the expected peak in writing.
- Move one staging number at a time: moving it back to GPT-Live is one Twilio change.

## Decide these

- Build the seam now, or when a second provider is needed?
- Prefer a provider that answers SIP itself, or a cheaper one behind a bridge?
- Use LiveKit?

The 2026-10-07 choice of Azure OpenAI over SIP for a C# port is a separate question ([run the phone path on Azure](azure-phone-path.md)).
