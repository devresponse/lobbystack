# Answer the questions the receptionist couldn't

Since fork PR #105, when the receptionist looks something up in a business's knowledge and finds nothing, LobbyStack saves the question. The business's team sees the open ones on the Knowledge page, and an owner or admin answers each once, which saves the answer as a text entry the receptionist uses from then on, or dismisses it. The feature was ported from the original project's October 2026 release (its PR #345), with migration `0131` in the fork's numbering. Checked against the code of fork PR #105.

## Know what gets saved

- **A lookup that found nothing.** The receptionist's `searchKnowledge` tool searches the business's documents and websites, and the text entries in its snapshot. When that search ran and matched nothing, `recordKnowledgeMiss` in `packages/agent-core/src/tools.ts` saves the query. Calls, browser calls and website chats all use this tool.
- **What it saves is the receptionist's query**, the self-contained question the model searched with, not the caller's exact words. It's cut to 300 characters, so an answer's title fits the 300 characters a text entry's title allows.
- **The same question counts once.** Questions are compared without case, punctuation or extra spaces (`normalizeUnansweredQuestion`), so "Do you validate parking?" and "do you validate  parking" add to one row's count. Each ask moves its last-asked time and remembers the call or chat it came from.
- **Not saved:** a search that failed (our failure, not a gap in the knowledge), a prospect demo (its callers aren't the business's), a lookup with no words in it, and the lookup `getBusinessServices` makes for itself when the business lists no services.
- **It never slows the answer.** The save runs after the receptionist has its result. A failed save only logs `knowledge.unanswered_question_failed` with the business's ID.

## Answer or dismiss a question

1. Go to **Agent > Knowledge** and scroll to **Unanswered Questions**, below the table. Open questions are listed most asked first, up to 50, with how many times people asked and when they last asked; the badge counts every open one. While any are open, Home also shows a card under **Action required** that links there and counts as one action. Only owners and admins see that card.
2. Click **Answer**, write what the receptionist should say (up to 5,000 characters), and click **Save Answer**. LobbyStack adds an active text entry titled with the question, at the default priority, and it appears in the Knowledge table. The receptionist's snapshot refreshes like after any new entry, so the next call or chat has it.
3. Or click **Dismiss** to take a question off the list.

Owners and admins answer and dismiss. Schedulers and viewers see the list on the Knowledge page without the buttons. If someone else answered or dismissed a question first, the page says so and shows the list as it is now.

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
- **Routes:** `GET /api/knowledge/questions` and `PATCH /api/knowledge/questions/{questionId}` ([route catalog](../reference/routes.md#knowledge)). The v1 API, the MCP server and the command line have no unanswered questions yet.
- **Dashboard:** `apps/admin/src/components/unanswered-questions-section.tsx` on the Knowledge page, and the card in `apps/admin/src/components/live-overview-surface.tsx`, in English, French, Spanish and Serbian.

## Know the limit on text entries

An answer is useful only if it reaches the receptionist. Calls and chats read text entries from the business's snapshot, which since fork PR #105 holds 50 active entries: the highest priority first, then the most recently changed. Before, it held 8, so a business's ninth entry, and any answer saved here once a business had 8, never reached a call. Prompts still list only the 8 with the highest priority; the knowledge search covers all 50. A business with more than 50 active entries should raise the priority of the ones that matter most, or move long reference text into a document ([knowledge](../knowledge/architecture.md#use-text-entries-in-calls-and-chats)).
