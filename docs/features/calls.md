# Understand phone and browser calls

OpenAI's GPT-Live speaks with every caller. Phone calls reach it through a Twilio Elastic SIP trunk; browser calls from the website widget, the dashboard's test call and demos reach it over WebRTC. The admin starts each call and the worker runs it. [The voice runtime](../voice/runtime.md) is the full reference, and [testing voice changes](../voice/testing.md) says how to check a change. This page sums up what the fork changed and what hasn't been tried on a real line. Checked against `main` at `da1f548`.

## Follow a call

1. A phone call arrives at OpenAI through the SIP trunk, and OpenAI posts `realtime.call.incoming` to the admin's `/api/webhooks/openai/live`. A browser call asks the admin's `/api/voice/live/session`.
2. The admin finds the business by the dialled number (or the widget key), checks the plan's minutes, loads the business's context snapshot, records the call and accepts it with the business's instructions.
3. The admin hands the call to the worker at `/internal/live/attach`. The worker opens the session's control connection and runs the call: it answers GPT-Live's delegated requests with the agent core (`packages/agent-core`), takes keypad presses, enforces the time limit, and finishes the call with a transcript and a summary. Since fork PR #80, the transcript leaves out the sounds GPT-Live's transcription marks in square brackets, such as `[tongue click]`, and keeps the worker's own notes, such as `[pressed 1]`.

Only three admin routes must be reachable from the internet for calls and texts: `/api/webhooks/openai/live`, `/api/webhooks/twilio/sms` and `/api/webhooks/twilio/status`. The worker only connects out.

## Open browser calls with a recorded greeting

GPT-Live sometimes ignores the greeting in a browser call's starting history, and the worker's fallback waits 4 seconds before asking again, so some callers heard nothing for several seconds.

With `LIVE_RECORDED_GREETING=true` on the admin (fork PR #45), a browser call opens with a recording of the business's greeting instead. The worker records the greeting during the first call, keeps it in Redis for a week after the last call that played it, and plays it on later calls. Since fork PR #52 it plays on the caller's first audio, or 3 seconds after the session starts, so it no longer plays before the caller's browser connects, and the widget shows it as the first caption. Phone calls are unchanged. To check a call, the worker's `live.greeting` log says how the greeting went; set the variable to `false` to go back.

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

## Know what hasn't been tried

- `pnpm voice:eval` and `pnpm voice:call` haven't been run since fork PRs #13, #18, #45, #50, #52 and #54, because the environment that built them had no OpenAI key. The time-limit change has its own eval scenario: `pnpm voice:eval --scenario time-limit`.
- No real call has typed a keypad PIN ([caller authentication](caller-authentication.md)).
- The [phone call review](../reviews/phone-calls-2026-10-06.md) of 2026-10-06 lists what was open then. Several findings were fixed since, such as calls recovered after a worker crash, withheld numbers and the drain during a deploy, so check a finding against the code before acting on it.
- A recording played to a phone caller, and a website call reserving minutes in slices instead of its whole length, aren't built.
