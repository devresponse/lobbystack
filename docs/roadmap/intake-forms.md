# Fill intake forms from calls and chats

A business would define a form once, such as a water damage intake, and the receptionist would ask its questions on phone calls, browser calls and website chats. When the conversation ends, a worker job fills the form from the transcript, keeping the caller's own words as evidence for each answer, and the business reviews it and sends it on. A study on 2026-10-25 designed it ([the study](../research/intake-forms.md)).

- **Status:** not started; waiting on the maintainer's decisions below. A pilot needs no code.
- **Effort:** a first version for inbound calls and website chat, with review and export, is 15 to 23 developer-days in five pull requests. A second phase adds 8 to 13 days and a third 8 to 12; outbound survey calls would take 8 to 15 more, plus OpenAI's and a lawyer's approval.
- **Cost to run:** about $0.002 to fill a form from a 10-minute call, next to $0.50 of GPT-Live minutes.
- **Untested:** how well GPT-Live follows a list of questions. No test call has tried it.

## Try it with no code

A rule in **Agent > Rules** can list the questions and ask the receptionist to take a message with the answers, for example: "Water damage intake: when a caller reports water damage, ask these one at a time before ending the call: the property address; where the water is coming from; how long it has been leaking; which rooms are affected; whether the power is on; and their insurer and claim number, if they have one. Then take a message for the team with every answer." The answers arrive as one message in the inbox. Rules share 1,000 tokens on calls, so about six to eight short questions fit; nothing tracks which were answered, and the answers are free text. It hasn't been tried on a real call.

## Build it this way

- **Forms:** LobbyStack's own JSON definition, checked by a zod schema in `packages/shared` and versioned in Postgres, so editing a form never changes past answers. Simple question types (text, number, yes or no, choices, date, time, phone, email, address, a rating, consent), each with a stable key, an optional follow-up hint, one level of "only ask if" and a sensitive flag. At most 40 questions, fewer on calls.
- **On calls:** a form block in the live instructions with its own budget of about 1,500 tokens, enough for about 12 to 15 questions, and interview rules: one question at a time, take early answers, read back names and numbers, don't suggest answers, sum up and confirm at the end. Since fork PR #84 every call already says it's with an AI and recorded, so a form's opening only says why it asks.
- **In chat:** two tools, `saveFormAnswers` and `finishForm`, since the chat agent sees only the last 20 messages. The form fills when it's finished, or 30 minutes after the last message.
- **Filling:** one structured-output call over the whole transcript when the conversation ends, giving each question a status (answered, unclear, declined or not asked), a value and the caller's words. Code checks each quote against the caller's turns, and each value against its type and the required answers. A failed fill is kept and retried.
- **Review and send:** a **Forms** page and a page for each response with every answer linked to the transcript, edit and approve, a **Form** tab on the call page, and an inbox item; review is on by default. Approved responses go out as `form_response.completed` and `form_response.approved` webhooks, through the v1 API, CLI and MCP with `forms:read` and `forms:write` scopes, and as CSV.
- **Data:** `forms`, `form_versions` and `form_responses` behind row-level security, in a new migration, with a retention category of their own.
- **Kept out of the first version:** card numbers, passwords, government ID numbers and health details.

## Follow the plan

| Step | Pull request | Developer-days |
| --- | --- | --- |
| 1 | Forms: tables, the definition, domain code, v1 API and CLI, a simple editor | 4 to 6 |
| 2 | The interview: forms in the snapshot, the block for calls and chat, the chat tools, when to start | 3 to 5 |
| 3 | Filling: the schema from the form, the evidence check, statuses, retries | 3 to 4 |
| 4 | Review: the responses list and page, edit and approve, the call page's tab, the inbox item | 3 to 5 |
| 5 | Out: webhooks, CSV, docs and voice test scenarios | 2 to 3 |
| | **First version** | **15 to 23** |
| Phase 2 | Live tracking of what's missing on calls, the caller's confirmation link and form page, a PDF, the chat answer card | 8 to 13 |
| Phase 3 | A Zapier trigger, Jotform, the business's own website form, a Google Forms pre-filled link | 8 to 12 |

Before the pilot, run `pnpm voice:eval` with an OpenAI key, since it hasn't run since several call changes ([open items](../project/open-items.md#test-these)). Then turn forms on for one business for 20 to 50 real calls.

## Decide these

| # | Question | Recommended |
| --- | --- | --- |
| 1 | Build it, and for whom first? | Intake forms for home services, which AlloPlace's own knowledge base already promises |
| 2 | Surveys in the first version? | Intake first; feedback surveys in phase 2, as links that open a browser call or a chat |
| 3 | Review before anything goes out? | On by default, with a switch per form to send right away |
| 4 | The caller's confirmation link in the first version? | Phase 2; the read-back covers most mistakes at first |
| 5 | Outbound calls? | Not now; revisit once OpenAI enables outbound SIP, Twilio confirms Opus on the trunk and a lawyer has reviewed it |
| 6 | Which plans get forms? | One form on the lowest plan and more on higher plans, with no charge per response |
| 7 | Block payment, ID and health questions? | Yes, in the first version |
| 8 | Our own editor, or SurveyJS? | Our own simple editor, plus "paste your questions" with AI |
| 9 | Try the no-code pilot now? | Yes, on the AlloPlace demo business |

## Know the risks

The receptionist may skip, repeat or bunch questions, since GPT-Live doesn't always follow its instructions: short forms, the read-back, a completeness count on each response and, in phase 2, live tracking answer that. Misheard numbers and names are caught by the read-back, the evidence check and review. Long forms cost plan minutes and lose people, so the editor caps the questions per channel. Forms compete with the business's facts for GPT-Live's 16,384 tokens of instructions, so they get a budget of their own. The [study](../research/intake-forms.md) covers the design, what research says about AI-led surveys, and the law on outbound calls.
