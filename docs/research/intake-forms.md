# Weigh forms filled from calls and chats

On 2026-10-25 a study asked whether a person could answer a business's form or survey by talking with the receptionist, and the system produce the filled form from the conversation. It read the code on `main` at `62517d2`, OpenAI's and Twilio's documentation, how seven voice and form products handle the same need, seven studies of chatbot and AI-led surveys, and two law firms' summaries of FCC rulings, and changed no code. **Its answer: yes, and most of the plumbing exists.** A form becomes one more schema for the job that already summarizes each call, plus a block of questions in the receptionist's instructions; what's missing is a place to define forms, a table for the answers and screens to review them. Nothing is built, and no test call has tried how well GPT-Live follows a list of questions. [Fill intake forms from calls and chats](../roadmap/intake-forms.md) tracks the plan and the nine decisions it waits on.

## Know the answer

1. The business defines a form once: its questions, each answer's type, which are required, and when the receptionist should use it, such as "when a caller reports water damage".
2. During the call or chat, the receptionist asks the questions one at a time, takes answers given early, reads back names and numbers, and moves on when someone declines.
3. When the conversation ends, a worker job fills the form from the transcript. Every answer keeps the caller's own words as evidence, and a status: answered, unclear, declined or not asked.
4. The business reviews the prefilled form, each answer linked to the transcript, and approves it. Approved responses go out by webhook, API, CSV, Zapier or n8n.

- **Avoid:** making the voice model call a tool for every answer, since the caller hears silence each time, and starting with outbound survey calls, which need OpenAI to enable outbound calling, a codec Twilio enables only on request, and a legal review.
- **Effort:** a first version for inbound calls and website chat, with review and export, is 15 to 23 developer-days in 5 pull requests. A second phase adds 8 to 13, and outbound calls 8 to 15 more.
- **Cost:** filling a form from a 10-minute call costs about $0.002 at OpenAI's list prices, next to $0.50 for the call's minutes.

## Know the two kinds of form

| | Intake form | Survey |
| --- | --- | --- |
| Asks about | Facts: an address, a vehicle, a claim number, symptoms | Opinions: satisfaction, ratings, comments |
| When | During a call the person made anyway | After a visit or a purchase |
| Accuracy | Each answer matters and gets checked | Trends across many responses matter |
| Who starts it | The caller | Usually the business, with a link or an outbound call |
| Fits first | Yes: inbound calls and chat exist | Later: needs links or outbound calls |

Examples: a water damage intake (the address, the source of the water, how long, the rooms affected, whether the power is on, the insurer and claim number), a plumbing service request, a property maintenance request, an auto repair intake, a salon consultation (careful with allergies, which are health data), lead qualification for law and accounting firms, and a feedback survey for any business. AlloPlace's own knowledge base, kept outside this repository, already promises restoration businesses that the receptionist "collects intake details"; today that works only as a free-text message.

## Know what existed

| What forms need | At `62517d2` |
| --- | --- |
| A voice that asks questions | GPT-Live's instructions are built from the business's snapshot when a call starts (`buildLiveInstructions` in `packages/agent-core/src/instructions.ts`), with a token budget per block, such as 1,000 for rules and 3,000 for FAQs, inside GPT-Live's 16,384 |
| A chat that asks questions | Website chat runs the same agent core on the `web_chat` channel, with the last 20 messages as history |
| A typed way to save what was said | The `takeMessage` tool saves a summary, a name, a callback number, an urgency and a callback window |
| Every turn of a call | The worker saves each turn as the call runs (`onTurn` in `packages/agent-core/src/live/callController.ts`) |
| Structured output after a call | `conversation.finalizeSession` asks the summary model for an object matching a zod schema, treating the transcript as untrusted data (`packages/agent-core/src/callSummary.ts`); filling a form is the same job with a bigger schema |
| Telling other systems | Signed webhooks, including `call.completed`; the v1 API, the CLI and the MCP tools; the unpublished Zapier app; n8n through webhooks |
| The rest | Outbox jobs that wait until `available_at`, retention by category, opt-in AI traces, `pnpm voice:eval` scenarios, and texts with recorded consent |

Missing: any form, survey or custom field in the schema; an end to a website chat, which closes only when the visitor writes again after a day of silence (`WIDGET_CHAT_IDLE_CLOSE_MS`); a dashboard editor for the voice and chat instructions, which only `PATCH /receptionist` changes, though rules can be changed in the dashboard; and outbound calls, since the only outbound leg is a transfer.

## Learn from other products and studies

Every voice-agent platform checked fills its fields **after the call, from the transcript, against a typed schema**, and delivers them by webhook: Retell's post-call fields, Vapi's structured outputs, ElevenLabs' data collection and Bland's analysis schema. None asks the voice model to save answers one by one, and field types are simple everywhere: text, number, yes or no, a choice. Form vendors start from the form and add a conversation (Jotform's AI Agents, Typeform's Formless); receptionist vendors start from the call and add questions, and sell more scenarios on higher plans (Rosie: 2, 5 or unlimited). Users report Retell leaving fields empty or missing from its webhooks, so a response here should always arrive, with a status for each answer.

The research on surveys points the same way:

- Conversation helps open answers more than closed ones (Xiao and others, 2020; Kim, Lee and Gweon, 2019), though a two-week study found a web survey often gave better data (Zarouali and others, 2024).
- AI interviewers accept vague answers and move on, so follow-ups have to be asked for: an AI phone survey of 2,739 people asked about 19 questions in 7 minutes, against about 15 for a human, and about 5% of those invited finished it (Lang and Eskenazi, 2025).
- People agree too readily with what's suggested (Barari and others, 2025), so the receptionist shouldn't propose answers.
- People tell an automated interviewer more (Lucas, Gratch and others, 2014) but rate chatbots lower on security, so say who sees the answers.

## Define a form

LobbyStack's own JSON definition, checked by a zod schema in `packages/shared` and stored per version in Postgres, so editing a form never changes past answers. SurveyJS's format is richer, but much of it can't be asked aloud and its builder needs a paid licence per developer; imports from Google Forms, Jotform or Typeform can come later, and pasting a list of questions for AI to draft is the fastest start.

- **Question types:** short and long text, a number with a range and unit, yes or no, one or several choices, date, time, phone, email, address, a rating, and consent. Photos and files can come later through a texted link; signatures don't fit a conversation.
- **For each question:** a stable key for exports, the label, how to ask it aloud, why it's asked, whether it's required, the choices with the words people use for them, one follow-up hint, checks, one level of "only ask if", and a sensitive flag (never read back, never in notifications).
- **For each form:** a name, a purpose the receptionist can say, its channels, when to use it, its opening, what to do at the end, who's notified, whether responses need review, and how long they're kept.
- **Languages:** written once in the business's language and asked in the caller's, with the caller's words kept as evidence and the value in the business's language.
- **Size:** at most 40 questions a form, fewer on calls; OpenAI's structured outputs allow far more.

## Run the interview

- **On calls,** a form block after the rules with its own budget of about 1,500 tokens, enough for about 12 to 15 questions; the dashboard refuses to turn on a form that doesn't fit. With more than one or two forms, the instructions list each form's name and when to use it, and the worker sends the chosen form's questions with `session.instructions.append`, at most 500 tokens at a time. The rules: one question at a time, take early answers, skip what's settled, move on after a refusal, read back names, emails and numbers digit by digit, don't suggest answers, sum up and confirm at the end, then say what happens next.
- **Knowing what's missing, in phase 2:** after each caller turn a small, quick model call checks the transcript, and the worker sends a quiet note with `session.thinking.append`, such as "still missing: rooms affected", which GPT-Live can use without saying it and the call never waits for.
- **In website chat,** the agent sees only the last 20 messages, so it gets two tools, `saveFormAnswers` and `finishForm`, and each reply's instructions list the answers saved so far. The form is filled when `finishForm` runs, or by a delayed job 30 minutes after the last message.
- **Never:** card numbers, passwords or government ID numbers, advice beyond the business's facts, or insisting after a refusal.

## Capture the answers

| Option | How | Verdict |
| --- | --- | --- |
| A. Fill after the conversation | One structured-output call over the whole transcript | **First version:** simple, cheap and sturdy, the same job as the call summary |
| B. Save each answer as it comes | GPT-Live delegates every answer to the worker | On calls, no: every delegation is silence for the caller. In chat, yes |
| C. Track live, fill at the end | A small background check after each caller turn, a quiet note, then A | **Phase 2** |
| D. Let OpenAI call our tools | GPT-Live's Responses delegation | No: the mode is fixed when a session starts, and every call uses client delegation |

The fill step takes the whole transcript (a 30-minute call is about 30,000 characters, while the call summary keeps only the first 8,000 and the last 4,000), the form's version, the business's language, and the call's date and time zone, so "yesterday" becomes a date. For each question it returns a status, a typed value or null, the caller's own words or null, and a short note. Code, not the model, then checks that each quote appears in the caller's turns, or marks the answer unclear; that values match the type, range and choices; and that required answers are there. There are no confidence scores, since a model's own are unreliable: evidence, status and the business's review do that job. A correction keeps the last answer, a failed fill is kept as "fill failed" and retried, and the transcript is untrusted data that can't change the output's shape or start an action.

| For a 10-minute interview | Tokens | Cost |
| --- | --- | --- |
| Filling the form once (A) | About 6,000 in, 2,000 out | About $0.002 |
| Live tracking (C), about 30 turns on the priority tier | About 90,000 in, 6,000 out | About $0.024 |
| The call itself | 10 minutes of GPT-Live | $0.50 |

The token counts are estimates at the deployment guide's list prices for `gpt-6-luna`, not measurements.

## Review, confirm and send

- **Review:** a **Forms** page listing responses, with filters for status and date and a CSV download; a response page where each answer shows the caller's words, linked to that moment in the transcript; edit (the AI's value stays in the history), approve, reject, or send the caller a link to finish; a **Form** tab on the call page; and an inbox item for each new response. Review is on by default, with a switch per form to send right away.
- **The caller's confirmation, in phase 2:** the read-back on the call catches most mistakes; after a phone call, a texted link to the prefilled form, signed, expiring and showing that one response; in chat, a card with "Looks right" and "Edit".
- **Out:** two new webhook events, `form_response.completed` and `form_response.approved`; the v1 API, CLI and MCP with `forms:read` and `forms:write` scopes; CSV; and n8n through the webhook. Later, a Zapier trigger, a PDF, a hosted form page, filling the business's own website form, and Jotform. Google Forms' API can't create responses, so only a pre-filled link works there.

## Know why outbound calls wait

LobbyStack places no calls of its own. GPT-Live can place an outbound SIP call through the Live API only once OpenAI enables outbound SIP for the organization, over a trunk with TLS signalling, Opus audio and SDES-SRTP media, and Twilio offers Opus on its trunks only as a Limited Availability codec that its sales team enables. Twilio's other route relays the audio over WebSockets, which brings back the audio relay [ADR 0008](../adr/0008-gpt-live-voice.md) removed. In the US, an FCC ruling of 2024-02-08 counts AI-generated voices as an "artificial or prerecorded voice" under the TCPA, so such calls generally need the person's prior express consent, and even exempt calls to a home line are limited to three in 30 days. Safer ways to reach people who didn't call: a texted or emailed link that opens a browser call or chat with the form, a "call me now" button on the website, or a feedback number on a receipt. The build itself would be 8 to 15 days.

## Keep it private and safe

- The form's opening says an AI receptionist is asking and why. The study proposed adding that the call is recorded; since fork PR #84, every call says it's with an AI and recorded right after the greeting.
- Ask only what's needed, and keep card numbers (they would bring the recordings into PCI scope), passwords, government ID numbers and health details out of the first version.
- Form responses get their own retention category, deleting a contact deletes them, and the new tables use the same row-level security as every business table.
- Answers stay out of telemetry like transcripts ([telemetry](../telemetry/architecture.md)), and the review screens mask answer text from PostHog with `ph-mask`.
- Whoever receives a webhook should treat answer text as user input.

## Know the plan it proposed

| Step | Pull request | Developer-days |
| --- | --- | --- |
| 1 | Forms: tables, the definition schema, domain code, v1 API and CLI, a simple editor | 4 to 6 |
| 2 | The interview: forms in the snapshot, the form block for calls and chat, the chat tools, when to start | 3 to 5 |
| 3 | Filling: the schema from the form, the evidence check, statuses, retries, call and chat triggers | 3 to 4 |
| 4 | Review: the responses list and page, edit and approve, the call page's tab, the inbox item | 3 to 5 |
| 5 | Out: webhooks, CSV, docs and test scenarios | 2 to 3 |
| | **First version** | **15 to 23** |
| Phase 2 | Live tracking (3 to 4), the caller's confirmation link and form page (3 to 5), a PDF (1 to 2), the chat answer card (1 to 2) | 8 to 13 |
| Phase 3 | A Zapier trigger (2 to 3), Jotform (2 to 3), the business's own website form (3 to 5), a Google pre-filled link (1) | 8 to 12 |
| Outbound | Scheduling, consent records, calling hours, retries, opt-outs, voicemail | 8 to 15, plus OpenAI's and a lawyer's approval |

The data: `forms`; `form_versions`, the definition as JSON with its version; and `form_responses`, with the form version, contact, conversation, call and channel, a status, the answers (value, status, evidence, the AI's original value and who edited it), the model and time of the fill, and the review and confirmation, all scoped to a business. The testing: unit tests for the definition and the evidence check; a fill test set of 20 to 30 written transcripts per kind of form, run on demand since it calls the model; new `pnpm voice:eval` scenarios for callers who answer everything, answer out of order, correct an answer, decline, or speak Spanish; and a pilot with one business for 20 to 50 real calls.
