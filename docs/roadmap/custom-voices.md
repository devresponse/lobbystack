# Give calls a custom voice

Every call speaks with one built-in OpenAI voice, `marin`, whatever the business or the language ([calls](../features/calls.md#know-which-language-a-call-uses)). A study on 2026-10-25 asked whether calls could speak in a clone of a real person's voice, such as the maintainer's own on every AlloPlace call, and what a voice for each business would take ([the study](../research/custom-voices.md)).

- **Status:** not started. A cloned voice waits on OpenAI, which enables cloned voices only for eligible customers through its sales team; the rest waits on the decisions below.
- **Effort:** about 2 days for one voice on every call; 3 to 4 for a choice of OpenAI's built-in voices for each business; 8 to 12 in all for a cloned voice for each business, with a consent page.
- **Since the study:** fork PR #84 added a notice after each call's greeting that the call is with an AI and recorded, which OpenAI requires for custom voices.

## Know the options

| Option | What callers hear | Needs | Effort |
| --- | --- | --- | --- |
| One cloned voice for every call | A real person's voice, in English accents only on GPT-Live; French is untested | OpenAI to enable cloned voices, and the speaker to record a consent sentence and a sample | About 2 days |
| One prompt voice for every call | A new voice designed from a written description, which must not imitate a named person | Nothing: open to every API customer since 2026-10-16. It works only in GPT-Live, so the recorded greeting can't use it | About 2 days |
| Built-in voices for each business | A choice of OpenAI's voices, including the French `brise` and `sillage` | Nothing from OpenAI | 3 to 4 days |
| A cloned voice for each business | Each business's own clone, at most 20 for every business on the deployment together | OpenAI's access, a consent page, and counsel's review | 8 to 12 days in all |

GPT-Live costs the same $0.05 a minute with any of them. A call's voice can't change once the call starts, so a caller who switches language keeps the voice the call opened with.

## Build it this way

One voice for every call:

- A setting such as `LIVE_VOICE_ID`: when it is set, both session builders in `packages/agent-core/src/live/session.ts` send `{ "id": … }` instead of `marin`. `buildPhoneSessionConfig` already takes a `voice` option; `buildBrowserSessionConfig` needs one.
- A fallback to `marin` when OpenAI refuses the voice, since a refused accept ends a phone call as `setup_failed`.
- An accent line in the live instructions, such as "Speak American English", as OpenAI asks for cloned voices; a prompt voice's description goes there instead.
- The recorded greeting keyed and recorded with the voice, or `LIVE_RECORDED_GREETING` left off for a prompt voice.
- An instruction to say it's an AI assistant when asked, and never to claim to be a person or the voice's owner.
- The voice tests on the same setting, and an OpenAI key with `api.voices.read` from the project the voice was made in.

A voice for each business adds a voice column on `receptionist_profiles` and a record of each consent, the voice in the business snapshot and the public API, a picker on the agent's basic settings, and a consent page that records the sentence and the sample in the browser. OpenAI documents deleting a consent but not a voice, so ask OpenAI how to remove a business's clone before a self-serve flow ships.

## Decide these

| # | Question | Recommended |
| --- | --- | --- |
| 1 | Whose voice: the maintainer's on every AlloPlace call, or a choice for each business? | One voice for every call first: it needs no dashboard work |
| 2 | Apply to OpenAI's sales team for cloned voices? | Yes, and ask whether clones will speak French on GPT-Live, whether the limit of 20 can be raised, and how to delete a voice through the API |
| 3 | Try a prompt voice while waiting? | Yes, in OpenAI's voice playground: it's free and works on GPT-Live today |
| 4 | Where do callers hear that it's an AI: in the greeting, in an answer when they ask, or both? | Both. Fork PR #84's notice covers the greeting; the answer when asked is still to add |
| 5 | French calls: the clone, untested in French, or a built-in French voice for French-speaking businesses? | Open |
| 6 | Is a business's own voice a paid-plan feature? | Open |
| 7 | If OpenAI says no: wait, settle for a prompt voice, or start the [voice engine seam](voice-provider-seam.md) toward ElevenLabs or Ultravox? | Open. ElevenLabs Agents fits a real voice best, with French, at $0.08 a minute plus the model |

A clone for each business should also wait for counsel to review the [legal points](../research/custom-voices.md#know-the-consent-and-legal-points).

## Know the deadline that applies anyway

The recorded greeting renders with OpenAI's `gpt-4o-mini-tts`, which shuts down on 2027-01-06 whatever is decided here. Moving it to `gpt-realtime-2.1-mini` takes about 1 to 2 days ([open items](../project/open-items.md#do-these-before-a-date)).
