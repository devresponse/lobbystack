# ADR 0009: keep a trace of each AI turn in Postgres to debug wrong answers

Store, for each website chat reply, each call's voice session and each request the voice model delegates, what the model was given and what it did. Keep it in our own database under the same tenancy, retention and deletion rules as transcripts, and out of logs, OpenTelemetry and PostHog.

## Status

Accepted, 2026-10-19.

It started with a demo web call on 2026-10-19, where the receptionist invented board members and a manager's email. The transcript showed the wrong answer, but nothing recorded what the knowledge search returned or what GPT-Live was handed, so the cause had to be inferred from the code (fixed in PR #50).

## What was recorded before

- **Spoken and written words only.** `transcripts` holds the spoken turns and `messages` holds the chat bodies.
- **Content-free telemetry.** `$ai_generation`, `voice.delegation_completed`, `knowledge.search_executed`, the `live.delegation` logs and the spans carry IDs, timings, token counts and tool names. `docs/telemetry/architecture.md` and `docs/validation/posthog-otel-validation.md` forbid prompts, model responses and transcripts in telemetry.
- **Lost after each turn:**
  - the instructions the voice model had;
  - which snapshot was used (each refresh deletes older snapshot rows);
  - the delegation prompt or chat history;
  - each step's tool calls and results;
  - what GPT-Live was handed.
- **PR #50 added a `knowledgeAnswer` field to the `live.delegation` log.** It carried knowledge passages to stdout and OTLP. This change removes it.

## Decision

### Tables (migration `0106_ai_traces.sql`)

- **`ai_traces`**, one row per AI turn:
  - `kind`: `chat_reply`, `voice_session` or `voice_delegation`;
  - `channel`;
  - `call_id` or `conversation_id`, `message_id` and `delegation_id`;
  - `model` and `snapshot_version`;
  - the `input` the model saw, the `steps` (text, tool calls with inputs, tool results), the `output`, `direct_answer`, `failed`, `usage` and `duration_ms`;
  - `expires_at`.
  - Text is cut at 50,000 characters, and each tool input or output at 20,000 characters of JSON.
- **`ai_trace_contexts`** stores each snapshot and each set of instructions once per business, by SHA-256 hash.
  - A trace points to them, so the snapshot a past turn used survives later snapshot refreshes.
  - Each context keeps the latest expiry of the traces using it.
  - It serves as the snapshot archive.
- Both tables have the same RLS policy and grants as tenant tables such as `contact_passcodes`.

### Writers

- **Website chat:** `app/api/widget/chat/route.ts` writes a `chat_reply` trace after the reply is sent, or a failed one when generation fails.
- **Browser and phone calls:** the session route and the OpenAI webhook write a `voice_session` trace with the GPT-Live instructions once the call record exists.
- **Delegations:** the call controller hands each delegation's prompt, steps and what it sent GPT-Live to a new `onDelegationTrace` callback, never to `onDelegation` or logs. The worker writes a `voice_delegation` trace from it.
- All writes run after the reply or answer is on its way, through `recordAiTrace` in `packages/domain/src/server/aiTraces.ts`. A failed write is logged by error type only and never fails the turn.

### Privacy and retention

- **`businesses.ai_traces_enabled`**, off by default. It is read when each turn finishes and set with `PATCH /business` (`ai_traces_enabled`), or `lobbystack business update --ai-traces-enabled`.
- **Retention:** a new `ai_traces` content retention category, 30 days on every plan, overridable like the others through `CONTENT_RETENTION_POLICY_JSON`.
- **Deletion:** the hourly privacy sweep deletes expired traces, then expired contexts.
- **No export:** nothing is exported to OTLP or PostHog.

### Reading and replaying

- **API:**
  - `GET /ai-traces?call_id=…|conversation_id=…` returns trace summaries.
  - `GET /ai-traces/{trace_id}` returns the full trace with its instructions and snapshot.
  - Both use the existing `calls:read` scope, so existing keys can read traces.
- **CLI:** `lobbystack calls traces --call-id <id>` and `lobbystack calls trace <trace_id>`.
- **Replay:** `pnpm ai:replay <trace.json>` reruns a chat reply or delegation offline.
  - It uses the recorded instructions, or a file passed with `--instructions`, and the recorded input.
  - Each tool answers with the result the trace recorded, so no database is needed.

## Options considered

- **Logs or OpenTelemetry with content**, such as AI SDK `experimental_telemetry` with `recordInputs` and `recordOutputs`. Rejected: it breaks the telemetry rules and puts customer content into third-party log storage, with no per-business retention, deletion or access control.
- **PostHog LLM analytics with `$ai_input` and `$ai_output`.** Rejected for the same reasons.
- **Self-hosted Langfuse on Railway.** It has good trace UIs and evals, but it is a second datastore outside our RLS and retention sweep. It can be fed from `ai_traces` later for opted-in businesses.
- **OpenAI-side storage.** It covers only what OpenAI saw, expires on OpenAI's schedule, and has neither our tool results nor the snapshot.
- **A separate `traces:read` scope.** Deferred: existing keys would need replacing to read traces. A business admin's key already reads transcripts with `calls:read`.

## Cost

Estimated at 5 to 15 KB per chat reply or delegation, plus each distinct snapshot and set of instructions once. At 100 calls a day with 5 delegations each, that is under 10 MB a day, or about 300 MB at 30 days' retention.

## Still to do

- A dashboard panel on the call and conversation pages that lines up each spoken answer with its delegation and passages, and a settings toggle for `ai_traces_enabled`. Both need translations in all four interface languages.
- Listing "AI processing records" and their 30-day retention in the privacy policy, before customers turn traces on.
