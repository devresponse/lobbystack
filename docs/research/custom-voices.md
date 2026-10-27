# Weigh a cloned voice for calls

On 2026-10-25 a study asked whether calls could speak in a clone of the maintainer's own voice through GPT-Live, what LobbyStack would need, and what to do if OpenAI says no. It read the code on `main` at `62517d2` and OpenAI's, other voice platforms' and lawyers' pages as published that day, and changed no code. **Its answer: yes, with conditions.** OpenAI enables cloned voices only for eligible customers through its sales team, they speak English accents only on GPT-Live, and callers must be told the voice is an AI. Once OpenAI turns them on, one voice for every call is about two days of work. Nothing is built; [give calls a custom voice](../roadmap/custom-voices.md) tracks the plan and the seven decisions it waits on. Since the study, fork PR #84 added a notice after every call's greeting that the call is with an AI and recorded. This is research, not legal advice.

## Know what OpenAI offers

| | From a recording (a clone) | From a description (a prompt voice) |
| --- | --- | --- |
| What it is | A copy of one real person's voice, from a consent recording and a 10 to 60 second sample | A new synthetic voice from a written description, which must not imitate a named person |
| Who can use it | Eligible customers, once OpenAI's sales team enables it | Every API customer, since 2026-10-16 |
| Works with | GPT-Live, the Realtime API, the Speech API and Chat Completions audio | GPT-Live only |
| Limit per organization | 20 voices | 100 voices |
| Price | No surcharge: GPT-Live stays $0.05 a minute | The same, and creating one is free |
| Languages on GPT-Live | English accents only, named in the instructions | Whatever the description asks for; test each language |
| Consent | The speaker reads a fixed sentence, in one of 16 languages, and must be the person in the sample | None |

A clone needs a project-scoped key approved for GPT-Live and custom voices: `api.voices.read` to use one and `api.voices.write` to create one, with every request in the same project. OpenAI keeps voices until they are deleted, keeps abuse-monitoring copies for 30 days, doesn't train on them, and can't create them under Zero Data Retention. Its rules forbid impersonation and children's voices, require telling listeners the speech is AI-generated, and put recorded voices under a Text-to-Speech Supplemental Agreement that isn't public.

## Make a cloned voice

1. Ask OpenAI's sales team to enable recorded custom voices for the organization, then create a project key with the voice scopes.
2. Fetch the current consent sentences with `GET /v1/audio/consent_phrases`, since OpenAI can change them.
3. The speaker reads exactly one sentence and nothing else; any change fails the check.
4. Upload it with `POST /v1/audio/voice_consents`, which returns an ID such as `cons_123`.
5. Record 10 to 60 seconds of full sentences in a quiet room. The model copies tone, pace, energy, pauses and habits, so record the receptionist voice wanted, not a casual one.
6. Create the voice with `POST /v1/audio/voices`, the sample and the consent's ID. OpenAI checks that the speakers match and returns an ID such as `voice_123`.
7. Every session that should speak in it passes `{ "id": "voice_123" }` as its voice when it starts. The voice can't change during a session.

A deleted or revoked voice, a consent from another project or missing access comes back as a `404`. Browsers label their recordings `audio/webm;codecs=opus`, which the upload refuses, so an upload page must send `audio/webm`. The API documents creating a voice, but not listing or deleting one.

## Know where a custom voice works

| Where | Cloned voice | Prompt voice |
| --- | --- | --- |
| GPT-Live, in browser, WebSocket and SIP phone calls, through `audio.output.voice` | Yes, English accents | Yes |
| The Realtime API | Yes | No |
| The Speech API (`gpt-4o-mini-tts`) | Yes | No |
| Chat Completions with audio output | Yes | No |

OpenAI shows custom voices on browser and WebSocket sessions but gives no phone example, so the first test should be a real phone call. Two facts matter beyond the voice:

- **The recorded greeting's speech model is going away.** `gpt-4o-mini-tts` shuts down on 2027-01-06, and OpenAI's replacement is `gpt-realtime-2.1-mini` through the Realtime API, not the Speech API ([open items](../project/open-items.md#do-these-before-a-date)).
- **A prompt voice can't record the greeting at all,** since it works only inside GPT-Live.

## Know how calls picked a voice

Every call spoke with one hard-coded voice, `marin` (`LIVE_VOICE` in `packages/agent-core/src/live/session.ts`), and nothing stored a voice:

- **Phone calls:** `buildPhoneSessionConfig(snapshot, voice = LIVE_VOICE)` takes a voice, but the webhook in `apps/admin/app/api/webhooks/openai/live/route.ts` never passes one.
- **Browser calls:** `buildBrowserSessionConfig` writes `LIVE_VOICE` in directly.
- **The recorded greeting:** `recordGreeting` renders it with `gpt-4o-mini-tts` in `LIVE_VOICE` and caches it in Redis under a key made from the words and the voice (`packages/agent-core/src/live/greetingRecording.ts`).
- **Voice tests:** `scripts/voice/live-call-eval.ts` uses `LIVE_VOICE` for the receptionist.
- **Data:** `receptionist_profiles` keeps the business's written call rules, `voice_instructions`, but no voice, and the snapshot, the public API and the dashboard have no voice setting.

The `openai` package at 7.28.0 already types a custom voice `{ id }` for browser sessions, SIP accepts and the Speech API, and has `audio.voices.create`, but no call for uploading a consent, which would be a plain HTTP request.

## Know what it would take

**One voice for every call,** about two days once OpenAI enables cloned voices:

- A setting such as `LIVE_VOICE_ID`: when it is set, both session builders send `{ "id": … }` instead of `marin`.
- A fallback to `marin` when OpenAI refuses the voice, since a refused accept ends a phone call as `setup_failed` and a refused browser session shows the caller an error.
- An accent line in the live instructions, as OpenAI asks for cloned voices, such as "Speak American English"; a prompt voice takes its description there instead.
- The recorded greeting keyed and recorded with the voice's ID, or `LIVE_RECORDED_GREETING` left off.
- The voice tests on the same setting, a key with `api.voices.read` from the voice's project on the admin and the worker, and docs.

Making the voice is a one-off: two requests with the speaker's recordings, and the returned ID goes into the setting. No dashboard work is needed.

**A voice for each business** adds a voice column on `receptionist_profiles` and a record of each consent (who spoke, when, the consent and voice IDs, and when it was withdrawn) behind row-level security; the voice in the business snapshot and the public profile API; a voice picker on the agent's basic settings, with OpenAI's built-in voices first, including the French `brise` and `sillage` added on 2026-10-16; and a consent page where the owner records the sentence and the sample in the browser and the server creates the voice. Every business on a deployment shares one OpenAI organization's 20 clones. OpenAI's reference documents deleting a consent but not a voice, and doesn't say whether deleting the consent revokes the voice, so ask OpenAI before a self-serve flow ships. The data, snapshot and picker alone give each business a choice of built-in voices with no consent flow.

| Work | Rough effort |
| --- | --- |
| One voice for every call, with the fallback, tests and docs | About 2 days, plus test calls |
| A built-in voice picker for each business | About 3 to 4 days |
| A cloned voice for each business, with the consent page | About 8 to 12 days in all, including the picker |
| Moving the recorded greeting off `gpt-4o-mini-tts` to `gpt-realtime-2.1-mini` | About 1 to 2 days, needed before 2027-01-06 in any case |
| Telling callers they are speaking with an AI | About half a day; fork PR #84 has since added a notice after the greeting |

## Know the ways out if OpenAI says no

GPT-Live can't speak through another company's voice, since its sessions have no text-only output, and OpenAI's Realtime API takes clones only behind the same eligibility gate.

| Route | Cloning | A minute | How a phone call reaches it | What LobbyStack needs |
| --- | --- | --- | --- | --- |
| GPT-Live with a prompt voice | Not a clone; no consent | $0.05, as today | As today | The one-voice option, without the recorded greeting |
| Ultravox, part of Inworld since about 2026-10-01 | 1 clone on pay-as-you-go and 5 on Pro, from a 30 to 60 second sample | $0.05; 5 calls at once on pay-as-you-go | Native SIP | The voice provider seam and an adapter; Ultravox's own model replaces GPT-Live |
| ElevenLabs Agents | Instant clones from about 1 to 3 minutes of audio; professional clones of one's own voice from 30 minutes or more, with a check that the speaker is present | $0.08 plus the language model | Twilio integration or a SIP trunk | The seam and an adapter; its custom LLM option can keep LobbyStack's own receptionist agent |
| Cartesia | Instant clones from 10 to 60 seconds, each in one language | $0.06 plus the language model | A SIP trunk | The seam and an adapter; tools become webhooks |
| Azure Voice Live | Limited Access, after Microsoft approves an intake form | Per token, plus the voice charges | No SIP, so a bridge of LobbyStack's | The seam, a media bridge and an adapter |
| A bridge from an OpenAI model to a cloning speech service | That provider's rules | The model plus about $0.018 of speech | Twilio streams each call to a LobbyStack service | A media gateway like the `apps/voice-gateway` the original removed in its #201, plus the seam |
| Twilio ConversationRelay | Twilio's own catalogue of voices | $0.07 plus the call | Twilio | Any text model, but each turn waits for transcription, the model and speech |

On a four-minute call, before Twilio's charges, GPT-Live and Ultravox cost about $0.20, Cartesia $0.24 plus the model, ConversationRelay $0.28 plus the model, and ElevenLabs $0.32 plus the model. Every route but the first starts with the `VoiceProvider` seam, about 3 to 5 weeks for phone calls alone by the study's estimate ([make the voice engine swappable](../roadmap/voice-provider-seam.md)). Phone audio is narrowband, so judge any clone on real phone calls, not in a browser. If it has to be the maintainer's real voice and OpenAI refuses, ElevenLabs Agents is the strongest fit: the best-documented cloning, French, and a way to keep LobbyStack's own agent, at 60% more a minute than today plus the model. Ultravox costs the same as today and works most like today's calls, but allows few clones.

## Know the consent and legal points

- **OpenAI's rules come first.** Only the person whose voice is cloned can consent, by reading the sentence themselves, so a staff member's voice needs that person to record, not just to sign. Listeners must be told the speech is AI-generated, and provenance signals such as OpenAI's audio watermark must be kept. No impersonation, and no children's voices.
- **Where LobbyStack stood.** The call instructions never said the receptionist is an AI, and nothing told the model what to answer when a caller asks whether they're talking to a person. The terms (`apps/landing/src/lib/legal/terms-en.ts`, clause 7.4) put the duty to tell callers that a call may be recorded and handled by an AI on each business, and no clause covered a business uploading a staff member's voice. Fork PR #84 has since added the notice after every greeting. Still needed before a custom voice ships: an instruction to say it's an AI assistant when asked and never to claim to be a person or the voice's owner, and terms and privacy wording for voice samples sent to OpenAI.
- **For counsel.** In the US, the FCC's ruling 24-17 treats AI-generated voices, cloned ones included, as artificial voices under the TCPA, which matters only if outbound AI calls are added. Under Quebec's Civil Code, article 36, using a person's voice for purposes other than the public's legitimate information is an invasion of privacy, and a voice recording of an identifiable person is personal information under Law 25. Tennessee's ELVIS Act bars using a person's voice, real or simulated, without consent, and Illinois's BIPA lists voiceprints as biometric identifiers. A business that clones an employee needs written consent that names the use, says how to withdraw it, and says what happens when the person leaves.

## Know what it recommended

1. Ask OpenAI's sales team to enable recorded custom voices, and ask at the same time whether cloned voices will speak French on GPT-Live, whether the limit of 20 can be raised, and how to delete a voice through the API.
2. Try prompt voices meanwhile in OpenAI's voice playground: they are free to create and work on GPT-Live today.
3. Build the one-voice option with an AI disclosure, about two and a half days. With the accent line or the voice's description as a setting too, it can ship a prompt voice now and the clone later by changing settings only.
4. Move the recorded greeting off `gpt-4o-mini-tts` before 2027-01-06, whatever is decided.
5. Hold the other platforms unless OpenAI refuses, or a French clone matters more than staying on GPT-Live.

A clone for each business should also wait for counsel to review the legal points.
