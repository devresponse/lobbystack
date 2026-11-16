import { NextResponse } from "next/server";

import { appendMessage, findNewerWidgetChatInTransaction, listConversationsInTransaction, loadSmsReachInTransaction, readConversationThreadInTransaction, setAutomationState, setConversationArchived, type ConversationChannelFilter } from "@lobbystack/domain";
import { isUuid, smsFailureReason } from "@lobbystack/shared";
import { asApiResponse, businessIdFromRequest, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { receptionistIdFromRequest } from "@/lib/receptionist-filter";

export const dynamic = "force-dynamic";

/**
 * Without conversationId: one row per conversation (its latest message), newest first, paged, leaving out archived
 * conversations, or only those with archived=true, and with receptionist=<id> only the ones that receptionist
 * answered. With it: that thread, archived or not,
 * each text with why it failed when it never went out, and where a reply goes: for a website chat that closed, the
 * visitor's newer chat; for any other conversation, which takes replies by text, why a text can't reach the contact.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId");
    if (conversationId !== null && !isUuid(conversationId)) return jsonError("conversationId must be a UUID.", 400);
    const receptionistId = receptionistIdFromRequest(request);
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      if (conversationId) {
        const thread = await readConversationThreadInTransaction(tx, { businessId, conversationId });
        const conversation = thread[0];
        const closedChat = conversation?.channel === "web_chat" && conversation.conversationStatus !== "open";
        const smsReach = conversation && conversation.channel !== "web_chat" ? await loadSmsReachInTransaction(tx, { businessId, conversationId }) : null;
        return {
          messages: thread.map(({ providerStatus, ...message }) => ({ ...message, failureReason: message.status === "failed" ? smsFailureReason(providerStatus) : null })),
          newerConversationId: closedChat ? await findNewerWidgetChatInTransaction(tx, { businessId, conversationId }) : null,
          smsReplyHold: smsReach && !smsReach.ok ? smsReach.reason : null,
        };
      }
      const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit")) || 50), 1), 100);
      const offset = Math.max(Math.trunc(Number(url.searchParams.get("offset")) || 0), 0);
      const search = url.searchParams.get("search")?.trim();
      const channel = url.searchParams.get("channel");
      return await listConversationsInTransaction(tx, {
        businessId, limit, offset, archived: url.searchParams.get("archived") === "true",
        ...(search ? { search } : {}),
        ...(channel === "web_chat" || channel === "sms" ? { channel: channel as ConversationChannelFilter } : {}),
        ...(receptionistId ? { receptionistId } : {}),
      });
    }));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request) as { conversationId?: string; body?: string; channel?: "sms" | "dashboard" | "web_chat" };
    const businessId = businessIdFromRequest(request);
    if (!businessId || !body.conversationId || !body.body) return jsonError("businessId, conversationId, and body are required.", 400);
    const session = await (await import("@/lib/api-helpers")).requireApiSession(request);
    return NextResponse.json({ messageId: await appendMessage(createDomainContext(), { businessId, conversationId: body.conversationId, body: body.body, direction: "outbound", channel: body.channel ?? "dashboard", userId: session.user.id }), }, { status: 201 });
  } catch (error) { return asApiResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const body = await readJson(request) as { conversationId?: string; automationState?: "ai_active" | "human_handoff"; action?: string };
    const businessId = businessIdFromRequest(request);
    if (body?.action === "archive" || body?.action === "restore") {
      if (!businessId || !isUuid(body.conversationId)) return jsonError("businessId and a conversationId UUID are required.", 400);
      const session = await (await import("@/lib/api-helpers")).requireApiSession(request);
      // Archiving hides the conversation from the Messages list and Home; nothing is deleted.
      const archived = await setConversationArchived(createDomainContext(), { userId: session.user.id, businessId, conversationId: body.conversationId, archived: body.action === "archive" });
      return archived ? NextResponse.json(archived) : jsonError("Conversation not found.", 404, "not_found");
    }
    if (!businessId || !body.conversationId || (body.automationState !== "ai_active" && body.automationState !== "human_handoff")) return jsonError("conversationId and a valid automationState are required.", 400);
    const session = await (await import("@/lib/api-helpers")).requireApiSession(request);
    await setAutomationState(createDomainContext(), { userId: session.user.id, businessId, conversationId: body.conversationId, state: body.automationState });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}
