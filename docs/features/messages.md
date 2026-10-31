# Archive conversations in Messages

The dashboard's **Messages** page is the team's inbox: texts, website chats and the messages the receptionist took on calls, one row per conversation, newest first, with **All**, **Web** and **SMS** filters and a search. Since fork PR #108, an owner or admin can archive a conversation to take it off that list, such as a test chat or a thread that's finished, and restore it later. Archiving only hides the conversation: migration `0132` adds `conversations.archived_at`, and nothing is deleted. Checked against the code of fork PR #108.

## Archive a conversation

1. Open the conversation in **Messages** and choose **Archive**, at the right of its header.
2. A dialog asks first: **Archive conversation** archives it, and **Cancel** or Escape keeps it.
3. The conversation leaves the list, its thread closes, and **Conversation archived.** shows. Other open dashboards drop it at once.

- **Where it goes:** off the **All**, **Web** and **SMS** lists and their search, and off **Action required** on Home when the team had taken the chat over.
- **What stays:** every message, the contact and its history, the counts on Home and in **Analytics**, and billing. Archiving doesn't close a website chat or hand it back to the receptionist: whoever had it still has it.
- **Who:** owners and admins, since it hides the conversation from the whole team. Schedulers and viewers don't see the button, and the server refuses them (`setConversationArchived` in `packages/domain/src/server/conversations.ts`). Each archive and restore goes in `audit_logs` as `conversation.archived` or `conversation.restored` with who did it.

## Find and restore an archived conversation

**Archived**, after **SMS** in the filters, lists the archived conversations of every channel, newest first, and the search works there too. An archived conversation's thread says when it was archived. **Restore** in its header puts it back in the list, without a dialog, and **Conversation restored.** shows. Everyone on the team can read archived conversations, and schedulers can reply in them, which brings them back, but only owners and admins see **Restore**.

## Know what brings one back by itself

A new message in an archived conversation takes it out of **Archived** and puts it back in the list, so nothing the team should see stays hidden:

- the customer texts again (`receiveInboundSms` in `packages/domain/src/server/sms.ts`);
- a website visitor writes in the chat, or the receptionist answers or takes a message in it;
- someone from the team replies in it.

Every message is saved through `insertMessageInTransaction` (`packages/domain/src/server/conversations.ts`) or `receiveInboundSms`, and both clear `archived_at` in the same transaction. That isn't recorded in `audit_logs`: the message is the record. A visitor's next chat after a day of quiet is a new conversation, so it shows in the list whatever happened to the old one.

## Know how it's built

- **Column:** `conversations.archived_at` (migration `0132`), null unless archived. Archiving again keeps the first time. Archiving leaves `updated_at` as it was, since it picks a contact's or a visitor's current conversation.
- **Domain:** `setConversationArchived` answers null for a conversation the business doesn't have, bumps `revision` and queues a `conversation.updated` realtime event, which Messages and Home already listen for. `listHandoffConversations` (`packages/domain/src/server/operatorActivity.ts`) is Home's **Action required** list of conversations the team took over, without archived ones.
- **Route:** `PATCH /api/messages` with `{ "conversationId", "action": "archive" }` or `"restore"`, beside the take-over switch, answers `{ archivedAt }`, 404 `not_found` for an unknown conversation and 403 `forbidden` below admin. `GET /api/messages` leaves archived conversations out of the list, and with `archived=true` lists only them; a thread opens either way ([route catalog](../reference/routes.md#messages)).
- **Dashboard:** `apps/admin/src/components/live-messages-surface.tsx`, with its strings under `page.archive` in the `messages` namespace, in English, French, Spanish and Serbian.
- **Not built:** the v1 API, the MCP server and the command line can't read conversations at all yet ([API gaps](../reference/api-gaps.md#know-which-tables-have-no-api)). There's no way to archive several conversations at once.

## Know how it's tested

- **The page:** `apps/admin/src/components/live-messages-archive.test.tsx` covers the dialog's cancel, Escape, confirm and failure, the roles, the **Archived** list, **Restore** and an empty **Archived** list.
- **The route:** `apps/admin/app/api/messages/route.test.ts` covers the two actions, an unknown or malformed conversation, the domain's refusal, and the list's filter.
- **The domain, under row-level security:** `packages/domain/src/server/conversationArchiving.integration.test.ts`, which runs under `pnpm test:reliability`: what archiving keeps and records, restoring, roles, another business's conversation, Home's list, and a text, a chat message, a message taken by the receptionist and a team reply each bringing a conversation back.
- **A browser journey:** `apps/admin/e2e/message-archive.e2e.ts`, in CI's list in `scripts/e2e-local.sh`: an owner cancels, then archives a customer's text conversation, which stays gone after a reload with its message kept and the archive on record, finds it under **Archived** and restores it.
