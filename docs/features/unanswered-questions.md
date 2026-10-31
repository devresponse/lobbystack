# Answer the questions the receptionist couldn't

Since fork PR #105, LobbyStack saves the questions the receptionist couldn't answer. The business's team sees the open ones on the **Questions** page, right below **Knowledge** in the sidebar, and an owner or admin answers each once, which saves the answer as a text entry the receptionist uses from then on, or dismisses it. The feature was ported from the original project's October 2026 release (its PR #345), with migration `0131` in the fork's numbering. Fork PR #106 changed what gets saved, because the original's test, a knowledge lookup that found nothing, almost never passes ([see why](#know-why-an-empty-lookup-isnt-the-test)). Fork PR #107 moved the list from the bottom of the Knowledge page to its own page, `/agent/questions`, and the Knowledge page is back to how it was before. Checked against the code of fork PR #107.

## Know what gets saved

- **On calls and browser calls, after the call ends.** The worker's `conversation.finalizeSession` job asks the text model for the call's one-line summary (`packages/agent-core/src/callSummary.ts`), and the same request lists each question about the business that the receptionist said it didn't have the information for. Once that job has finalized the call, it saves them (`saveCallUnansweredQuestions` in `apps/worker/src/handlers.ts`); a retried job doesn't save them twice. So a call's questions show up shortly after the caller hangs up, not during the call.
- **In website chats, as the receptionist replies.** A chat's receptionist has a `noteUnansweredQuestion` tool (`packages/agent-core/src/tools.ts`), and its instructions say to call it before it tells the visitor it doesn't have that information. The question shows up right away.
- **What it saves is a short, self-contained question** the model wrote, such as "What is your support phone number?", not the caller's exact words. A call's questions are written in the business's language, like its summary. Each is cut to 300 characters, so an answer's title fits the 300 characters a text entry's title allows. A call saves at most 5.
- **The same question counts once.** Questions are compared without case, punctuation or extra spaces (`normalizeUnansweredQuestion`), so "Do you validate parking?" and "do you validate  parking" add to one row's count. Each ask moves its last-asked time and remembers the call or chat it came from. Two wordings of one question, such as "support number" and "support phone number", are two rows.
- **Not saved:** questions the receptionist answered; requests it handled, such as bookings, messages and transfers; anything not about the business; a prospect demo (its callers aren't the business's); a call where the caller barely spoke, which gets no summary; and a call whose summary request failed or timed out (the worker logs `call.summary_failed`), or a deployment with no text model, where the call keeps the summary taken from its transcript.
- **It never slows the answer.** A chat's save runs in the background, and a call's runs after the call. A failed save only logs `knowledge.unanswered_question_failed` with the business's ID, and the call's ID for a call.
- **Every call but a prospect demo now gets a summary request**, even one whose booking or message already describes it, so a call can leave its questions. That adds one small text model request for those calls, recorded like the others as a `call.summary` AI generation event.

## Know why an empty lookup isn't the test

The original project saved the receptionist's query when its `searchKnowledge` lookup came back empty. For a business with any documents or websites, that almost never happens: the semantic search returns the closest passages however far they are (`searchKnowledgeEvidence` in `packages/domain/src/server/knowledge.ts` has no distance cutoff, and the ranks it fuses have no score floor), so the lookup "finds" something even when nothing in it answers. On calls, GPT-Live can also say it doesn't know without handing the question to the receptionist's tools at all. So a caller who asked for the support number heard "I don't have that information" and nothing was saved. Since fork PR #106, the model that read the conversation says which questions went unanswered instead.

## Answer or dismiss a question

1. Go to **Agent > Questions** (`/agent/questions`), right below **Knowledge** in the sidebar. Its **Unanswered Questions** list shows the open questions most asked first, up to 50, with how many times people asked and when they last asked; the badge counts every open one. While any are open, Home also shows a card under **Action required** that opens this page and counts as one action. Only owners and admins see that card.
2. Click **Answer**, write what the receptionist should say (up to 5,000 characters), and click **Save Answer**. LobbyStack adds an active text entry titled with the question, at the default priority, and the question leaves the list. The entry appears in the table on the Knowledge page, where it can be edited, paused or deleted like any other. The receptionist's snapshot refreshes like after any new entry, so the next call or chat has it.
3. Or click **Dismiss** to take a question off the list.

Owners and admins answer and dismiss. Schedulers and viewers see the list on the Questions page without the buttons. If someone else answered or dismissed a question first, the page says so and shows the list as it is now.

## Know what happens when it's asked again

| The question was | Asked again, it |
| --- | --- |
| Open | Counts again on the same row |
| Dismissed | Counts on the dismissed row and stays off the list, until the row expires |
| Answered | Opens a new row: the answer didn't reach the receptionist, for example because the entry was turned off or deleted, or the search didn't match it |

## Know how long questions are kept

A question repeats what a caller or visitor said, so it expires like a follow-up made from their call: after the business's plan's follow-up retention (30 days on the free cloud plan; 365 on the paid plans and on self-hosted deployments, unless `CONTENT_RETENTION_POLICY_JSON` changes it), counted from the last time someone asked it. The hourly privacy sweep (`runPrivacyRetentionSweep` in `packages/domain/src/server/privacy.ts`) deletes expired questions, whatever their status. A text entry made from an answer is the business's own and stays. With `CONTENT_RETENTION_ENABLED=false`, questions never expire. Deleting a business deletes its questions.

## Know how it's built

- **Table:** `unanswered_questions` (migration `0131`), with forced row-level security: calls and chats record questions as the worker, anyone on the business's team reads them, and owners and admins resolve them. A partial unique index on the business and the normalized question, for open and dismissed rows, is what makes a repeat count on its row.
- **The call and chat it came from** are kept only while they belong to the business, and cleared if the call or conversation is deleted.
- **Domain:** `packages/domain/src/server/unansweredQuestions.ts` (`recordUnansweredQuestion`, `listOpenUnansweredQuestions`, `answerUnansweredQuestion`, `dismissUnansweredQuestion`).
- **From calls:** the `unansweredQuestions` field of `callSummarySchema`, cleaned by `cleanUnansweredQuestions` (`packages/agent-core/src/callSummary.ts`); `loadCallSummaryInput` (`packages/domain/src/server/conversations.ts`) marks a prospect demo with `needsUnansweredQuestions: false` and gives the channel; the worker saves them in `saveCallUnansweredQuestions`. The model reads the transcript's first 8,000 and last 4,000 characters, like the summary, so a long call can miss a question asked in its middle.
- **From chats:** `noteUnansweredQuestion` in `packages/agent-core/src/tools.ts`, offered only to website chats, and the matching line in `buildAgentInstructions` (`packages/agent-core/src/instructions.ts`). A chat's turn allows one more model step than a call's, 5, so a lookup, a second lookup and the save still leave room for the reply.
- **Routes:** `GET /api/knowledge/questions` and `PATCH /api/knowledge/questions/{questionId}` ([route catalog](../reference/routes.md#knowledge)). The v1 API, the MCP server and the command line have no unanswered questions yet.
- **Dashboard:** the page `apps/admin/app/(dashboard)/agent/questions/page.tsx` renders `LiveQuestionsSurface` (`apps/admin/src/components/live-questions-surface.tsx`), which shows the list from `apps/admin/src/components/unanswered-questions-section.tsx` for the active business. The sidebar item is in `apps/admin/src/components/dashboard-shell.tsx`, the page title in `agent-shell.tsx` (`sections.questions` in the `agent` namespace), and Home's card in `apps/admin/src/components/live-overview-surface.tsx`, all in English, French, Spanish and Serbian. The Knowledge page (`live-knowledge-surface.tsx`) neither shows nor loads the questions.
- **Tests:** the page and its route (`apps/admin/app/(dashboard)/agent/questions/page.test.tsx`), the list (`unanswered-questions-section.test.tsx`), the sidebar (`dashboard-shell.test.tsx`), Home's card (`live-overview-surface.test.tsx`), and the Knowledge page without the list (`live-knowledge-surface.test.tsx`). A browser journey, `apps/admin/e2e/unanswered-questions.e2e.ts`: Home's card opens the Questions page, the Knowledge page shows and loads no questions, the sidebar lists Questions below Knowledge, an owner answers one question, which shows up on the Knowledge page, and dismisses the other.

## Know the limit on text entries

An answer is useful only if it reaches the receptionist. Calls and chats read text entries from the business's snapshot, which since fork PR #105 holds 50 active entries: the highest priority first, then the most recently changed. Before, it held 8, so a business's ninth entry, and any answer saved here once a business had 8, never reached a call. Prompts still list only the 8 with the highest priority; the knowledge search covers all 50. A business with more than 50 active entries should raise the priority of the ones that matter most, or move long reference text into a document ([knowledge](../knowledge/architecture.md#use-text-entries-in-calls-and-chats)).
