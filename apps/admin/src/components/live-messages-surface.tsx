"use client";

import { requestJson } from "@/lib/request-json";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { subscribeRealtimeQuery } from "@/lib/realtime-query";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, Bot, CircleAlert, SearchIcon, Send, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SmsFailureReason, SmsHoldReason } from "@lobbystack/shared";

import { PageHeader } from "@/components/page-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getContactDisplayName } from "@/lib/contact-display";
import { formatDateTime } from "@/lib/locale";
import { useTelemetry } from "@/components/product-analytics";

const PAGE_SIZE = 50;

// channel is the conversation's; messageChannel, in a thread, is how the message itself went, such as "sms" for a text.
type Message = { id: string; conversationId: string; contactName: string | null; contactPhone: string | null; visitorName: string | null; visitorEmail: string | null; channel: string | null; conversationStatus?: string | null; automationState: string | null; teamRequestedAt?: string | null; messageChannel?: string | null; body: string; direction: string; status: string; failureReason?: SmsFailureReason | null; createdAt: string };

/** A website visitor asked for a person and nobody from the team has joined yet. */
function waitingForTeam(message: Message): boolean {
  return message.channel === "web_chat" && message.automationState === "human_handoff" && Boolean(message.teamRequestedAt);
}

/** A website chat that closed: the visitor's widget no longer shows it, so it takes no replies. */
function closedChat(message: Message): boolean {
  return message.channel === "web_chat" && message.conversationStatus === "closed";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

/** How the delivery of a text the team sent went, by its status, as keys in the messages namespace. */
const textStatusKeys: Record<string, string> = { queued: "page.statusSending", sending: "page.statusSending", sent: "page.statusSent", delivered: "page.statusDelivered", undelivered: "page.statusUndelivered", failed: "page.deliveryFailed" };

/** Why a text can't reach a contact, or why one failed before it went out, as keys in the messages namespace. */
const smsHoldKeys: Record<SmsFailureReason, string> = { no_phone: "page.smsHold.noPhone", blocked: "page.smsHold.blocked", opted_out: "page.smsHold.optedOut", no_consent: "page.smsHold.noConsent", no_sender: "page.smsHold.noSender", rejected: "page.smsHold.rejected", region_blocked: "page.smsHold.regionBlocked", unsent: "page.smsHold.unsent" };

/** Why the server refused a reply, as a key: the chat closed, or the text can't reach the contact ("sms_opted_out"). */
function refusalKey(error: unknown): string | undefined {
  const code = errorCode(error);
  if (code === "chat_closed") return "page.closedReplyRefused";
  const reason = code?.startsWith("sms_") ? code.slice("sms_".length) : "";
  return Object.hasOwn(smsHoldKeys, reason) ? smsHoldKeys[reason as SmsFailureReason] : undefined;
}

function initials(name: string | null, fallback: string): string {
  if (!name) return fallback.slice(0, 2).toUpperCase();
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function conversationName(message: Message, locale: string, t: (key: string) => string): string {
  return getContactDisplayName({ name: message.contactName ?? message.visitorName, phone: message.contactPhone, email: message.visitorEmail, channels: [message.channel] }, locale, t);
}

function conversationSubtitle(message: Message, t: (key: string) => string): string {
  if (message.channel === "web_chat") {
    return message.visitorEmail ?? message.contactName ?? message.visitorName ?? t("page.noChannel");
  }
  return message.contactPhone ?? message.contactName ?? t("page.noChannel");
}

/** A conversation as the list shows it, from its latest message. */
function conversationOf(latest: Message, locale: string, t: (key: string) => string) {
  return { id: latest.conversationId, latest, displayName: conversationName(latest, locale, t), channel: latest.channel === "web_chat" ? "web_chat" : "sms" };
}

/** One message in the thread. A text the team sent shows how its delivery went, and why it failed when it never went out. */
function MessageBubble({ message, locale, t }: { message: Message; locale: string; t: (key: string) => string }) {
  const outbound = message.direction === "outbound";
  const statusKey = outbound && message.messageChannel === "sms" ? textStatusKeys[message.status] : undefined;
  const failed = message.status === "failed" || message.status === "undelivered";
  return <div className={cn("flex", outbound ? "justify-end" : "justify-start")}><div className={cn("max-w-[80%] rounded-2xl px-4 py-3 text-sm", outbound ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted text-foreground")}><p className="ph-mask whitespace-pre-wrap">{message.body}</p><p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] opacity-70"><span>{formatDateTime(message.createdAt, locale, { hour: "numeric", minute: "2-digit" })}</span>{statusKey ? <span className="inline-flex items-center gap-1">{failed ? <CircleAlert className="size-3" /> : null}{t(statusKey)}</span> : null}</p>{message.failureReason ? <p className="mt-1 text-[11px]">{t(smsHoldKeys[message.failureReason])}</p> : null}</div></div>;
}

export function LiveMessagesSurface() {
  const { i18n, t } = useTranslation("messages");
  const telemetry = useTelemetry();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [channelFilter, setChannelFilter] = useState<"all" | "web_chat" | "sms">("all");
  const { business } = useActiveBusiness();
  const query = search.trim();
  // Both keys sit under ["messages", businessId], so realtime and mutation invalidations refresh the list and the open thread.
  const latestMessages = useInfiniteQuery({
    queryKey: ["messages", business?.businessId, "list", channelFilter, query],
    queryFn: ({ pageParam }) => requestJson<{ messages: Message[]; hasNext: boolean }>(`/api/messages?limit=${PAGE_SIZE}&offset=${pageParam}&channel=${channelFilter}&search=${encodeURIComponent(query)}`),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => lastPage.hasNext ? pages.length * PAGE_SIZE : undefined,
    // Keeps the open thread visible while a new search or filter loads.
    placeholderData: keepPreviousData,
    enabled: Boolean(business),
  });
  const thread = useQuery({
    queryKey: ["messages", business?.businessId, "thread", selectedId],
    queryFn: () => requestJson<{ messages: Message[]; newerConversationId?: string | null; smsReplyHold?: SmsHoldReason | null }>(`/api/messages?conversationId=${encodeURIComponent(selectedId!)}`),
    enabled: Boolean(business && selectedId),
  });
  // A refusal means the conversation changed since it loaded, such as a website chat that closed or a contact who texted STOP: show it as it is now.
  const refreshAfterRefusal = (error: unknown) => {
    if (refusalKey(error)) void queryClient.invalidateQueries({ queryKey: ["messages", business?.businessId] });
  };
  const send = useMutation({
    mutationFn: async () => {
      if (!business || !selected) return;
      await requestJson(`/api/messages?businessId=${encodeURIComponent(business.businessId)}`, { method: "POST", body: JSON.stringify({ conversationId: selectedId, body: draft.trim(), channel: selected.channel }) });
    },
    onSuccess: async () => {
      if (business && selectedId && selected) telemetry.track("web.messages.reply_sent", { businessId: business.businessId, conversationId: selectedId, channel: selected.channel });
      setDraft("");
      await queryClient.invalidateQueries({ queryKey: ["messages", business?.businessId] });
    },
    onError: (error) => {
      toast.error(t(refusalKey(error) ?? "page.sendFailed"));
      refreshAfterRefusal(error);
    },
  });
  const toggleAutomation = useMutation({
    mutationFn: async (state: "ai_active" | "human_handoff") => {
      if (!business || !selectedId) return;
      await requestJson(`/api/messages?businessId=${encodeURIComponent(business.businessId)}`, { method: "PATCH", body: JSON.stringify({ conversationId: selectedId, automationState: state }) });
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["messages", business?.businessId] }); },
    onError: (error) => {
      toast.error(t(errorCode(error) === "chat_closed" ? "page.closedTakeOverRefused" : "page.automationUpdateFailed"));
      refreshAfterRefusal(error);
    },
  });

  useEffect(() => {
    if (!business?.businessId) return;
    return subscribeRealtimeQuery(queryClient, business?.businessId, ["messages", business?.businessId], ["message.upserted", "message.deliveryUpdated", "conversation.updated"]);
  }, [business?.businessId, queryClient]);

  const conversations = useMemo(() => {
    // Offset pages can overlap when a new message moves a conversation up between page loads; keep the newer, earlier row.
    const latestByConversation = new Map<string, Message>();
    for (const latest of (latestMessages.data?.pages ?? []).flatMap((page) => page.messages)) if (!latestByConversation.has(latest.conversationId)) latestByConversation.set(latest.conversationId, latest);
    return [...latestByConversation.values()].map((latest) => conversationOf(latest, i18n.language, t));
  }, [latestMessages.data, i18n.language, t]);
  const selectedMessages = thread.data?.messages ?? [];
  const threadLatest = selectedMessages.at(-1);
  // A conversation opened from another, such as a visitor's newer chat, may not be on a loaded page of the list.
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? (threadLatest?.conversationId === selectedId ? conversationOf(threadLatest, i18n.language, t) : null);
  const selectedAutomation = selected?.latest.automationState === "human_handoff" ? "human_handoff" : "ai_active";
  const selectedWaiting = selected ? waitingForTeam(selected.latest) : false;
  const selectedClosed = selected ? closedChat(selected.latest) : false;
  const newerConversationId = selectedClosed ? thread.data?.newerConversationId ?? null : null;
  // Replies outside website chats go by text, voice messages included: why a text can't reach this contact, if it can't.
  const selectedSmsHold = selected && selected.channel !== "web_chat" ? thread.data?.smsReplyHold ?? null : null;
  const replyBlocked = selectedClosed || selectedSmsHold !== null;

  function openConversation(conversationId: string, channel: string) {
    if (business) telemetry.track("web.messages.thread_opened", { businessId: business.businessId, conversationId, channel });
    setSelectedId(conversationId);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.trim() && !replyBlocked) send.mutate();
  }

  return (
    <section className="flex h-full min-w-0 gap-6">
      <div className={cn("flex min-w-0 w-full flex-col gap-3 sm:w-56 lg:w-72 2xl:w-80", selected && "hidden sm:flex")}>
        <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-3 bg-background px-4 py-2 sm:static sm:z-auto sm:mx-0 sm:p-0">
          <PageHeader className="py-0" title={t("page.title")} />
          <div className="flex items-center gap-1">
            {(["all", "web_chat", "sms"] as const).map((key) => <Button key={key} size="sm" variant={channelFilter === key ? "secondary" : "ghost"} className="px-2.5 text-xs" onClick={() => setChannelFilter(key)}>{key === "all" ? t("page.filterAll") : key === "web_chat" ? t("page.filterWeb") : t("page.filterSms")}</Button>)}
          </div>
          <div className="relative"><SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label={t("page.searchPlaceholder")} className="pl-10" onChange={(event) => setSearch(event.target.value)} placeholder={t("page.searchPlaceholder")} value={search} /></div>
        </div>
        <div className="-mx-3 no-scrollbar h-full overflow-y-auto p-3">
          {conversations.map((conversation) => <div key={conversation.id}><button className={cn("group flex w-full rounded-md px-2 py-2 text-start text-sm hover:bg-accent hover:text-accent-foreground", selectedId === conversation.id && "bg-muted")} onClick={() => openConversation(conversation.id, conversation.channel)} type="button"><div className="flex w-full gap-2"><Avatar><AvatarFallback className="ph-mask">{initials(conversation.latest.visitorName ?? conversation.latest.contactName, conversation.displayName)}</AvatarFallback></Avatar><div className="min-w-0 flex-1"><div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2"><span className="ph-mask truncate font-semibold">{conversation.displayName}</span><span className="text-[11px] text-muted-foreground">{formatDateTime(conversation.latest.createdAt, i18n.language, { hour: "numeric", minute: "2-digit" })}</span></div><span className="ph-mask line-clamp-2 text-muted-foreground">{conversation.latest.body || t("page.emptyPreview")}</span>{closedChat(conversation.latest) ? <span className="mt-1 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{t("page.closedBadge")}</span> : waitingForTeam(conversation.latest) ? <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"><User className="size-3" />{t("page.waitingBadge")}</span> : null}</div>{conversation.channel === "web_chat" ? <span className="mt-0.5 flex size-4 items-center justify-center rounded-full bg-primary/10 text-primary" title="Web chat"><Bot className="size-3" /></span> : null}</div></button><Separator className="my-1" /></div>)}
          {latestMessages.hasNextPage ? <Button className="w-full" loading={latestMessages.isFetchingNextPage} onClick={() => void latestMessages.fetchNextPage()} size="sm" variant="ghost">{t("page.loadMore")}</Button> : null}
        </div>
      </div>
      <div className={cn("hidden min-w-0 w-full flex-1 flex-col border bg-background sm:flex sm:rounded-md", selected && "flex")}>
        {selected ? <><div className="flex items-center gap-3 border-b p-4"><Button className="sm:hidden" onClick={() => setSelectedId(null)} size="icon-sm" variant="ghost"><ArrowLeft /></Button><Avatar><AvatarFallback className="ph-mask">{initials(selected.latest.visitorName ?? selected.latest.contactName, selected.displayName)}</AvatarFallback></Avatar><div className="min-w-0"><p className="ph-mask truncate font-semibold">{selected.displayName}</p><p className="ph-mask truncate text-sm text-muted-foreground">{conversationSubtitle(selected.latest, t)}</p></div>{selectedClosed ? <div className="ml-auto flex items-center"><span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{t("page.closedBadge")}</span></div> : selected.channel === "web_chat" ? <div className="ml-auto flex items-center gap-2"><span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", selectedAutomation === "ai_active" ? "bg-teal-50 text-teal-700" : "bg-amber-50 text-amber-700")}>{selectedAutomation === "ai_active" ? <Bot className="size-3.5" /> : <User className="size-3.5" />}{selectedAutomation === "ai_active" ? t("page.automationAiActive") : selectedWaiting ? t("page.waitingTitle") : t("page.automationHumanHandoff")}</span>{selectedWaiting ? <Button size="sm" onClick={() => toggleAutomation.mutate("human_handoff")} disabled={toggleAutomation.isPending}>{t("page.joinChat")}</Button> : null}<Button size="sm" variant="outline" onClick={() => toggleAutomation.mutate(selectedAutomation === "ai_active" ? "human_handoff" : "ai_active")} disabled={toggleAutomation.isPending}>{selectedAutomation === "ai_active" ? t("page.takeOver") : t("page.automationResumeAi")}</Button></div> : null}</div>{selectedClosed ? <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted px-4 py-2 text-xs text-muted-foreground"><p>{t(newerConversationId ? "page.closedNewerDescription" : "page.closedDescription")}</p>{newerConversationId ? <Button onClick={() => openConversation(newerConversationId, "web_chat")} size="sm" variant="outline">{t("page.openNewerChat")}</Button> : null}</div> : selectedWaiting ? <p className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-800">{t("page.waitingDescription")}</p> : selectedSmsHold ? <p className="border-b bg-muted px-4 py-2 text-xs text-muted-foreground">{t(smsHoldKeys[selectedSmsHold])}</p> : null}<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">{selectedMessages.map((message) => <MessageBubble key={message.id} locale={i18n.language} message={message} t={t} />)}</div><form className="flex gap-2 border-t p-4" onSubmit={submit}><Input className="h-11" disabled={replyBlocked} onChange={(event) => setDraft(event.target.value)} placeholder={selectedClosed ? t("page.closedComposerPlaceholder") : selectedSmsHold ? t("page.smsHoldPlaceholder") : selected.channel === "web_chat" ? t("page.composerPlaceholderWeb") : t("page.composerPlaceholderSms")} value={draft} /><Button aria-label={t("page.send")} disabled={!draft.trim() || replyBlocked} loading={send.isPending} size="icon-lg" type="submit"><Send /></Button></form></> : <div className="m-auto p-8 text-center text-sm text-muted-foreground">{t("page.selectConversation")}</div>}
      </div>
    </section>
  );
}
