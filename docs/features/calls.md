# Understand phone and browser calls

OpenAI's GPT-Live speaks with every caller. Phone calls reach it through a Twilio Elastic SIP trunk; browser calls from the website widget, the dashboard's test call and demos reach it over WebRTC. The admin starts each call and the worker runs it. [The voice runtime](../voice/runtime.md) is the full reference, and [testing voice changes](../voice/testing.md) says how to check a change. This page sums up what the fork changed and what hasn't been tried on a real line. Checked against `main` at `62517d2`, with fork PR #84's and fork PR #96's changes.

## Follow a call

1. A phone call arrives at OpenAI through the SIP trunk, and OpenAI posts `live.transport.incoming` to the admin's `/api/webhooks/openai/live`. A browser call asks the admin's `/api/voice/live/session`.
2. The admin finds the business by the dialled number (or the widget key), checks the plan's minutes, loads the business's context snapshot, records the call and accepts it with the business's instructions.
3. The admin hands the call to the worker at `/internal/live/attach`. The worker opens the session's control connection and runs the call: it answers GPT-Live's delegated requests with the agent core (`packages/agent-core`), takes keypad presses, enforces the time limit, and finishes the call with a transcript and a summary, which queues the [email after each call](email.md#email-the-team-after-each-call) for those who turned it on. Since fork PR #80, the transcript leaves out the sounds GPT-Live's transcription marks in square brackets, such as `[tongue click]`, and keeps the worker's own notes, such as `[pressed 1]`.

Only three admin routes must be reachable from the internet for calls and texts: `/api/webhooks/openai/live`, `/api/webhooks/twilio/sms` and `/api/webhooks/twilio/status`. The worker only connects out.

## Open calls with a recorded greeting

GPT-Live sometimes ignores the greeting in a call's starting history: it greeted on 8 of 15 phone calls and 16 of 25 browser calls in October. The worker's fallback waits 4 seconds before asking again, so some callers heard nothing for several seconds. A phone caller who heard nothing often said "Hello?", which stopped the fallback, and GPT-Live answered the hello without the greeting or the notice after it. That was the reported "no greeting until the caller says hello", more often on the first call after a quiet spell.

With `LIVE_RECORDED_GREETING=true` on the admin (fork PR #45), a browser call opens with a recording of the business's greeting instead. The worker records the greeting during the first call, keeps it in Redis for a week after the last call that played it, and plays it on later calls. Since fork PR #52 it plays on the caller's first audio, or 3 seconds after the session starts, so it no longer plays before the caller's browser connects, and the widget shows it as the first caption.

Since fork PR #96, phone calls open with the recording too:

- **When it plays:** on the caller's first audio, which on a phone call reaches the worker as soon as it connects, or 1 second after the worker connects without it, so a late worker still opens with the recording.
- **A caller who speaks first** doesn't get the recording played over them. The worker tells GPT-Live to say the whole opening before it answers, so the caller still hears the greeting and the notice. A sound on the line, such as `[static]`, doesn't count as speaking.
- **Recorded ahead:** with `LIVE_RECORDED_GREETING=true` on the worker too, the worker records a business's opening when its snapshot refreshes, and checks every active business with a phone number once a day and when it starts, so the first call after a greeting change, or after a week without calls, still opens with the recording. Without it, that call opens with the greeting command, as before.
- **Turn it off for phone calls only** with `LIVE_RECORDED_GREETING_PHONE=false` on the admin. `LIVE_RECORDED_GREETING=false` turns it off for both.

To check a call, the worker's `live.greeting` log says how the greeting went, and the admin's `live.incoming` (phone) or `live.browser_start` (browser) says whether the call opened with a recording (`greetingRecording`). [The voice runtime](../voice/runtime.md#open-calls-with-a-recording) has the details.

## Tell callers they're speaking with an AI and the call is recorded

Since fork PR #84, every phone and browser call says, right after the greeting: "You're speaking with an AI assistant, and this call is recorded and transcribed." It says it in the business's **Default customer language**, any of the 13 (`callRecordingNotices` in `packages/shared/src/callTranscripts.ts`). A business with no greeting opens its calls with the notice alone. It's on for every business, those made before it too, from the deploy on.

- **Turn it off** under **AI settings** with **Tell callers about AI and recording**, or with `recording_notice: false` on the v1 API's `PATCH /receptionist`. Migration `0118` adds `receptionist_profiles.recording_notice`, true by default, and a change reaches the next call once the business's snapshot refreshes. Many places require telling callers that a call is recorded, so turn it off only when the business tells them another way.
- **How it works:** `callOpening` joins the greeting and the notice, and everything that used the greeting uses it: the greeting command in the session's starting history, the greeting line in the instructions, the worker's fallback when GPT-Live doesn't greet, and the recorded greeting.
- **The recorded greeting** is kept under its words. After the deploy, and after the switch changes, a business's first browser call opens without a recording while the worker records the new opening for the calls after it. Since fork PR #96, a worker with `LIVE_RECORDED_GREETING=true` records the new opening when the snapshot refreshes, before that call.
- **The website widget** shows "Calls are answered by an AI assistant, and they're recorded and transcribed." under **Say Allo!** in the widget's language while the switch is on (`recordingNotice` from `/api/widget/config`).
- **The greeting's language:** the notice follows the call's language, and the greeting plays as written. A French business that kept the English starter greeting opens in English, then French, so write the greeting in the call's language.

## Keep the end of the call in its summary

Before fork PR #84, the worker saved each finished turn without waiting for it, and the summary job could start before the last turns were saved, so a summary could miss how a call ended. Now the worker finishes a call once its turn writes are saved, after 5 seconds at most. A write that takes longer logs `live.transcript_save_slow`, and the call finishes without it. The summary job (`conversation.finalizeSession`) also retries for about 3 hours, like alert deliveries, where it used to give up after about 15 seconds.

## End calls politely at the time limit

Before fork PR #54, website calls stopped after 5 minutes, and the goodbye could start mid-sentence and be cut 4 seconds later. Now:

- A browser call lasts up to 30 minutes, or less when `WEB_CALL_MAX_DURATION_MS` on the admin or the plan's remaining minutes say so. A phone call lasts as long as its reserved minutes, at most 30.
- A minute before the end, the receptionist tells the caller the call is nearly over.
- At the end, the worker waits up to 10 seconds for a pause, asks for a goodbye up to three times, holds the hang-up while the caller is talking, and hangs up at most 25 seconds after the wrap-up started.
- The worker's `live.closed` log records the warning (`limitWarningMs`) and the wrap-up (`wrapUp.hangup`: `goodbye_played`, `silent` or `timed_out`).

A deploy cuts every call on the old worker unless `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860` is set on the worker service, which gives a 30-minute call time to finish ([deploy the worker during calls](../voice/runtime.md#deploy-the-worker-during-calls)).

## Keep answers to what the business knows

- **Transfers** (direct commit `85adb66`): when the business takes transfers, GPT-Live is told that only the backend can transfer a call, so it no longer says "Connecting you now" without asking for one.
- **Website calls and chats** never promise a transfer (fork PR #18, [website widget](website-widget.md#know-what-the-receptionist-says-on-the-website)).
- **Made-up names** (fork PRs #50 and #53): a knowledge answer handed to GPT-Live has a budget of 380 tokens. When the matched passage didn't fit, the answer kept the wrong part, and GPT-Live invented the names it was missing. The answer now keeps as much as fits from the matched chunk onward, and GPT-Live is told never to make up names, phone numbers, emails, dates or other business facts, and to offer a message instead. The worker's `live.delegation` log carries the answer of a knowledge-only lookup.

## Trace what the AI was given

With AI traces on for a business, each website chat reply, call and delegated request keeps a trace: the input, every tool call and its result, and the output, with the snapshot and instructions stored once per business (fork PR #51, migration `0106`). Traces are off by default; turn them on with `PATCH /business` (`ai_traces_enabled`). They are kept 30 days and never go to logs, OpenTelemetry or PostHog. Read them with `GET /ai-traces` and `GET /ai-traces/{trace_id}` (`calls:read`), `lobbystack calls traces`, or replay one with `pnpm ai:replay`. [ADR 0009](../adr/0009-ai-conversation-traces.md) explains the design.

## Know which language a call uses

GPT-Live has no language setting. The call's instructions name the language to start in, and GPT-Live understands and speaks other languages on its own. Phone and browser calls work the same way.

- **Opening:** calls start in the business's **Default customer language** in **AI settings**. Since fork PR #82 it can be any of 13 languages: English, Spanish, French, German, Hindi, Japanese, Korean, Portuguese, Mandarin Chinese, Italian, Ukrainian, Russian and Arabic (`runtimeLocales` in `packages/shared/src/locales.ts`). Before, it was English or French. The public API's business `locale` takes the same codes. Onboarding picks the dashboard's language when calls can open in it, so English, French or Spanish, and English from a Serbian dashboard. The greeting plays as written, so write it in that language: a new business's starter greeting ("Thanks for calling" and the business's name) is English. The notice after it, that the call is with an AI and recorded, is always in this language.
- **Switching:** when a caller asks for another language or clearly speaks one, the receptionist switches, with no menu to press, and keeps answering in that language for the rest of the call, until the caller switches again. The worker's answers and notes to GPT-Live are written in English, so since fork PR #78 the instructions also say to stay in the caller's language when one arrives (`buildLiveInstructions` in `packages/agent-core/src/instructions.ts`).
- **Voice:** every call uses the `marin` voice (`LIVE_VOICE` in `packages/agent-core/src/live/session.ts`), whatever the language. OpenAI has voices made for Brazilian Portuguese, German, French, Hindi, Japanese and Korean, none for Spanish, and the fork uses none of them. A voice per business, or a cloned one, is planned but not built ([custom voices](../roadmap/custom-voices.md)).
- **After the call:** the summary is in the business's language, any of the 13. If the summary model fails, or the caller barely spoke, the summary comes from the transcript instead, and its few fixed words, such as "Call summary:", are English, or French for a French business. Texts to the caller use the contact's preferred language, or else the business's, and have wording in English, French, Spanish and Serbian only, so a German business's texts go out in English. Nothing saves the language the caller spoke.
- **Captions and transcripts:** since fork PR #78, each line of the widget's captions and of the call page's transcript takes its own text direction, so Arabic and Hebrew read from the right.
- **Which languages work well:** as of 2026-10-24, OpenAI publishes no list of languages for GPT-Live, and its API offers only `gpt-live-1` (`LIVE_MODEL` in the same file). The better French, German, Hindi, Mexican Spanish, Korean and Japanese that OpenAI announced for GPT-Live 1.1 on 2026-10-15 is in ChatGPT, and OpenAI says it's coming soon to the API. Test a language before promising it: `pnpm voice:eval` has two Spanish callers ([testing](../voice/testing.md#check-another-language)).

## Know what hasn't been tried

- `pnpm voice:eval` and `pnpm voice:call` haven't been run since fork PRs #13, #18, #45, #50, #52, #54, #78, #84 and #96, because the environment that built them had no OpenAI key. Nobody has heard fork PR #84's notice after the greeting on a call yet: whether GPT-Live says the whole opening once, and whether a recorded opening still plays on the caller's first audio. The time-limit change has its own eval scenario: `pnpm voice:eval --scenario time-limit`. Fork PR #78's Spanish callers, `spanish-switch` and `spanish-only`, have never run, so nobody knows yet how often a reply slips into English. No call has opened in one of the languages fork PR #82 added either.
- No real call has typed a keypad PIN ([caller authentication](caller-authentication.md)).
- The [phone call review](../reviews/phone-calls-2026-10-06.md) of 2026-10-06 lists what was open then. Several findings were fixed since, such as calls recovered after a worker crash, withheld numbers and the drain during a deploy, so check a finding against the code before acting on it.
- No real phone call has opened with the recorded greeting yet (fork PR #96): whether the caller hears it at once, and whether GPT-Live says the opening when the caller speaks first. The first calls after the deploy will tell: `live.greeting` with `trigger` `recording` and `step` `spoken`, and `inputAudioMs` above 0 at `sent`.
- A website call reserving minutes in slices instead of its whole length isn't built.
