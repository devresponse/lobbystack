"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Phone, PhoneOff, SendHorizontal } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useTranslation } from "react-i18next";
import { normalizeInterfaceLocale, type InterfaceLocale } from "@lobbystack/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { renderSafeMarkdown } from "@/lib/widget-markdown";
import { useWebVoiceCall, type WebVoiceTranscriptTurn } from "@lobbystack/web-voice";

type WidgetConfigPayload = {
  key: string;
  business: { id: string; name: string; defaultLocale: "en" | "fr" };
  config: {
    color?: string;
    title?: string;
    subtitle?: string;
    greeting?: string;
    localeOverride?: InterfaceLocale;
    leadForm?: { enabled: boolean; requirePhone?: boolean; requireEmail?: boolean; showBeforeChat?: boolean };
  };
  billing: { chatAllowed: boolean; plan: string };
  greeting?: string;
  snapshotPresent: boolean;
  businessSlug?: string;
  voiceEnabled?: boolean;
};

/** What the voice button shares with the chat: whether a call is live, and its captions. */
type VoiceCaptions = { live: boolean; turns: WebVoiceTranscriptTurn[] };

type WidgetMessageMetadata = {
  automationState?: "ai_active" | "human_handoff";
  /** The receptionist asked the team to join, and the chat waits for them. */
  waitingForTeam?: boolean;
  /** A team member wrote this message, with their first name when they have one. */
  fromTeam?: boolean;
  teamMemberName?: string | null;
};
type WidgetMessage = UIMessage<WidgetMessageMetadata>;

/** Who answers the chat: the receptionist, or the team, which was asked to join or is in the chat. */
type ChatHandling = { handoff: boolean; waitingForTeam: boolean; teamMemberName: string | null };
const RECEPTIONIST_HANDLING: ChatHandling = { handoff: false, waitingForTeam: false, teamMemberName: null };

type HistoryPayload = {
  conversationId?: string;
  automationState?: string;
  waitingForTeam?: boolean;
  teamMemberName?: string | null;
  /** The chat went a day without messages, so the visitor's next message starts a new one. */
  idle?: boolean;
  messages?: Array<{ id: string; role: "user" | "assistant"; content: string; fromTeam?: boolean; teamMemberName?: string | null }>;
};

function messageText(message: WidgetMessage): string {
  return message.parts.filter((part): part is Extract<WidgetMessage["parts"][number], { type: "text" }> => part.type === "text").map((part) => part.text).join("");
}

function chatErrorKey(error: unknown): string {
  if (!(error instanceof Error)) return "chat.sendingFailed";
  try {
    const parsed = JSON.parse(error.message) as { code?: unknown };
    return parsed.code === "chat_ai_limit_reached" ? "chat.limitReached" : "chat.sendingFailed";
  } catch {
    return "chat.sendingFailed";
  }
}


// The base styles make links look like the text around them, so they get an underline back.
function MessageContent({ content, pending }: { content: string; pending?: boolean }) {
  return <span className="widget-message-content [&_a]:underline [&_a]:underline-offset-2" dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(content || (pending ? "…" : "")) }} />;
}

const DEFAULT_COLOR = "#0f766e";
// Only used while the settings load on a chat opened by an older loader, which doesn't pass its color.
const LOADING_COLOR = "#d4d4d8";

/** Near-black or white, whichever reads better on the widget color (a yellow gets dark text). */
export function readableOn(hex: string): string {
  let value = hex.replace("#", "");
  if (value.length <= 4) value = [...value].map((digit) => digit + digit).join("");
  const [red, green, blue] = [0, 2, 4].map((start) => {
    const channel = Number.parseInt(value.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  // Contrast ratios against white and against zinc-900 (luminance 0.0097).
  return (luminance + 0.05) / 0.0597 > 1.05 / (luminance + 0.05) ? "#18181b" : "#ffffff";
}

function storageVisitorKey(widgetKey: string): string {
  return `lobbystack.widget.visitorId.${widgetKey}`;
}

function localVisitorId(widgetKey: string): string {
  try {
    const existing = window.localStorage.getItem(storageVisitorKey(widgetKey));
    if (existing) return existing;
  } catch {
    /* storage unavailable */
  }
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `v-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    window.localStorage.setItem(storageVisitorKey(widgetKey), id);
  } catch {
    /* storage unavailable */
  }
  return id;
}

/** How a live update stream ended: on its own, on an error worth retrying, for good, or because the visitor has no open chat. */
type WidgetStreamOutcome = "ended" | "failed" | "stopped" | "no_chat";

/** Reads the chat's live updates until the stream ends. Only the event names matter: events carry no text. */
async function readWidgetStream(input: { token: string; parentOrigin: string; signal: AbortSignal; onEvent: (name: string) => void }): Promise<WidgetStreamOutcome> {
  const response = await fetch(new URL("/api/widget/stream", window.location.origin), {
    headers: { authorization: `Bearer ${input.token}`, "x-widget-parent-origin": input.parentOrigin, accept: "text/event-stream" },
    credentials: "include",
    cache: "no-store",
    signal: input.signal,
  });
  if (response.status === 404) return "no_chat";
  // A session the server turns down stays turned down until the loader sends a new one.
  if (!response.ok) return [400, 401, 403].includes(response.status) ? "stopped" : "failed";
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) return "stopped";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return "ended";
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const name = buffer.slice(0, end).split("\n").find((line) => line.startsWith("event: "))?.slice("event: ".length);
      buffer = buffer.slice(end + 2);
      if (name) input.onEvent(name);
    }
  }
}

export function WidgetChatClient({ widgetKey, initialColor }: { widgetKey: string; initialColor?: string | undefined }) {
  const { t, i18n } = useTranslation("widget");
  const visitorIdRef = useRef<string>("");
  const [parentVisitorId, setParentVisitorId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [parentOrigin, setParentOrigin] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [leadOpen, setLeadOpen] = useState(false);
  const [leadDone, setLeadDone] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [configState, setConfigState] = useState<WidgetConfigPayload | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  // Whether the thread follows new messages: true while the visitor is at the bottom.
  const followThreadRef = useRef(true);
  const [lead, setLead] = useState({ name: "", email: "", phone: "" });
  const [leadSubmitting, setLeadSubmitting] = useState(false);
  const [handling, setHandling] = useState<ChatHandling>(RECEPTIONIST_HANDLING);
  const handoff = handling.handoff;
  const [voiceCaptions, setVoiceCaptions] = useState<VoiceCaptions>({ live: false, turns: [] });
  // Whether the chat is on screen. The loader loads it when its panel first
  // opens, or in the page's own element, and says when the panel opens or closes.
  const [panelOpen, setPanelOpen] = useState(true);
  // Whether the server has the visitor's chat, which their first message
  // starts. The history says whether they have one; once the server answers a
  // message they most likely do, and the live updates stop if they don't.
  const [chatSaved, setChatSaved] = useState(false);
  // Whether that chat went a day without messages. It stays open, so the live
  // updates still bring a team member's late reply, but the visitor's next
  // message starts a new chat.
  const chatIdleRef = useRef(false);
  // The chat on screen, which the history keeps even once it goes idle, and a
  // count that reopens the live updates when the server starts a new chat.
  const shownChatRef = useRef<string | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);

  const visitorId = useMemo(() => (parentVisitorId ?? visitorIdRef.current) || "", [parentVisitorId]);

  const transport = useMemo(() => new DefaultChatTransport<WidgetMessage>({
    api: "/api/widget/chat",
    credentials: "include",
    headers: () => ({
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
      ...(parentOrigin ? { "x-widget-parent-origin": parentOrigin } : {}),
    }),
    prepareSendMessagesRequest: ({ messages }) => {
      const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
      // The receptionist replies in the language the widget shows.
      const locale = normalizeInterfaceLocale(i18n.language);
      return {
        body: {
          visitorId: visitorIdRef.current || visitorId,
          messageId: lastUserMessage?.id ?? (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `m-${Date.now()}`),
          content: lastUserMessage ? messageText(lastUserMessage) : "",
          ...(locale ? { locale } : {}),
        },
      };
    },
  }), [parentOrigin, sessionToken, visitorId]);

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    clearError,
  } = useChat<WidgetMessage>({
    id: `widget:${widgetKey}`,
    generateId: () => crypto.randomUUID(),
    transport,
    onError: (error) => setSubmitError(chatErrorKey(error)),
    onFinish: ({ message }) => {
      setChatSaved(true);
      const metadata = message.metadata;
      if (metadata?.automationState === "ai_active") setHandling(RECEPTIONIST_HANDLING);
      if (metadata?.automationState === "human_handoff") setHandling((current) => ({ ...current, handoff: true, waitingForTeam: metadata.waitingForTeam ?? current.waitingForTeam }));
    },
  });

  const sending = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const streamingMessageId = status === "streaming" && lastMessage?.role === "assistant" ? lastMessage.id : null;
  const thread = useMemo(() => threadEntries(messages, streamingMessageId), [messages, streamingMessageId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: string; visitorId?: string; token?: string; parentOrigin?: string; code?: string };
      if (data && data.type === "session-error") {
        setSubmitError(data.code === "widget_origin_denied" ? "errors.originDenied" : data.code === "widget_key_invalid" ? "errors.invalidKey" : "errors.configLoad");
      }
      if (data && data.type === "visitor" && typeof data.visitorId === "string") {
        setParentVisitorId(data.visitorId);
      }
      if (data && (data.type === "open" || data.type === "close")) setPanelOpen(data.type === "open");
      if (data && data.type === "session" && typeof data.token === "string" && typeof data.parentOrigin === "string" && event.origin === data.parentOrigin) {
        setSessionToken(data.token);
        setParentOrigin(data.parentOrigin);
        if (typeof data.visitorId === "string") setParentVisitorId(data.visitorId);
      }
    };
    window.addEventListener("message", handleMessage);
    // The loader may finish fetching a session before this client hydrates.
    window.parent?.postMessage({ type: "ready" }, "*");
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const config = useQuery({
    queryKey: ["widget-config", widgetKey, sessionToken],
    enabled: Boolean(sessionToken),
    queryFn: async () => {
      const url = new URL("/api/widget/config", window.location.origin);
      const response = await fetch(url, { headers: { authorization: `Bearer ${sessionToken}`, "x-widget-parent-origin": parentOrigin ?? "" }, credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { code?: string } | null;
        if (body?.code === "widget_origin_denied") throw new Error("originDenied");
        if (body?.code === "widget_key_invalid") throw new Error("invalidKey");
        throw new Error("configLoad");
      }
      const payload = await response.json() as WidgetConfigPayload;
      setConfigState(payload);
      return payload;
    },
  });

  useEffect(() => {
    if (!configState) return;
    const locale = configState.config?.localeOverride ?? configState.business?.defaultLocale ?? navigator.language.split("-")[0];
    const supported = normalizeInterfaceLocale(locale);
    if (supported) void i18n.changeLanguage(supported);
  }, [configState]);

  useEffect(() => {
    if (parentVisitorId) {
      try {
        window.localStorage.setItem(storageVisitorKey(widgetKey), parentVisitorId);
      } catch {
        /* ignore */
      }
    }
  }, [parentVisitorId, widgetKey]);

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    const url = new URL("/api/widget/history", window.location.origin);
    // A chat that went a day without messages comes back only for the page that shows it.
    if (shownChatRef.current) url.searchParams.set("chat", shownChatRef.current);
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${sessionToken}`, "x-widget-parent-origin": parentOrigin ?? "" }, credentials: "include", signal: signal ?? null });
      if (!response.ok) return;
      const data = await response.json() as HistoryPayload;
      if (signal?.aborted) return;
      setHandling(data.automationState === "human_handoff" ? { handoff: true, waitingForTeam: data.waitingForTeam === true, teamMemberName: data.teamMemberName ?? null } : RECEPTIONIST_HANDLING);
      if (Array.isArray(data.messages)) {
        setChatSaved(data.messages.length > 0);
        chatIdleRef.current = data.idle === true;
        const shown = shownChatRef.current;
        const current = data.messages.length > 0 ? data.conversationId ?? null : null;
        shownChatRef.current = current;
        // The live updates follow one chat, so a new one the server started
        // in its place, as when the old one went idle, needs its own.
        if (shown && current && shown !== current) setStreamGeneration((generation) => generation + 1);
        const saved = data.messages.map((message): WidgetMessage => ({
          id: message.id,
          role: message.role === "assistant" ? "assistant" : "user",
          parts: [{ type: "text", text: message.content }],
          ...(message.role === "assistant" && message.fromTeam ? { metadata: { fromTeam: true, teamMemberName: message.teamMemberName ?? null } } : {}),
        }));
        setMessages(saved);
      }
    } catch {
      /* transcript resume is best effort */
    }
  }, [parentOrigin, sessionToken, setMessages]);

  // The history loads at the same time as the settings, as soon as the loader's
  // session arrives. After that the live updates and the reloads below keep it
  // current, so a renewed session doesn't load it again.
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const historyRequestedRef = useRef(false);
  useEffect(() => {
    if (!sessionToken || historyRequestedRef.current) return;
    historyRequestedRef.current = true;
    visitorIdRef.current = visitorIdRef.current || parentVisitorId || localVisitorId(widgetKey);
    void loadHistory().then(() => setHistoryLoaded(true));
  }, [loadHistory, parentVisitorId, sessionToken, widgetKey]);
  // The chat shows once the settings and the history are both in. A renewed
  // session reloads the settings, and the chat stays on screen meanwhile.
  const chatLoaded = configState !== null && historyLoaded;

  // Team replies reach the database only, so poll for them while a person has the chat.
  // The live updates below bring them at once; this is the fallback when those are down.
  useEffect(() => {
    if (!handoff || sending) return;
    // Aborting on send stops an older poll from overwriting the visitor's new message.
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadHistory(controller.signal);
    }, 45_000);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [handoff, loadHistory, sending]);

  // Reloads the history when the team writes or takes the chat over. A reload
  // mid-reply would replace the streaming answer, so it waits for the reply.
  const sendingRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const refreshRef = useRef<AbortController | null>(null);
  const refreshHistory = useCallback(() => {
    if (sendingRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    refreshRef.current?.abort();
    const controller = new AbortController();
    refreshRef.current = controller;
    void loadHistory(controller.signal);
  }, [loadHistory]);
  useEffect(() => {
    sendingRef.current = sending;
    if (sending) {
      refreshRef.current?.abort();
    } else if (refreshPendingRef.current) {
      refreshPendingRef.current = false;
      refreshHistory();
    }
  }, [refreshHistory, sending]);

  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  // Once the visitor has a chat on screen, even one that went idle on a page
  // left open, an open stream tells the widget when a team member writes or
  // takes over. It pauses while the page is in the background.
  const configLoaded = configState !== null;
  useEffect(() => {
    if (!sessionToken || !parentOrigin || !configLoaded || !chatSaved || !pageVisible) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let failures = 0;
    const connect = async () => {
      let outcome: WidgetStreamOutcome;
      try {
        // Every event, "ready" included, reloads the history: a new stream may have missed something.
        outcome = await readWidgetStream({ token: sessionToken, parentOrigin, signal: controller.signal, onEvent: () => { failures = 0; refreshHistory(); } });
      } catch {
        outcome = "failed";
      }
      if (controller.signal.aborted || outcome === "stopped") return;
      if (outcome === "no_chat") {
        // The visitor's next answered message opens the stream again.
        setChatSaved(false);
        return;
      }
      // A stream that ran its course reopens at once; failures back off, up to a minute.
      const delay = outcome === "ended" ? 1_000 : Math.min(60_000, 2_000 * 2 ** failures++);
      timer = window.setTimeout(() => void connect(), delay);
    };
    void connect();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [chatSaved, configLoaded, pageVisible, parentOrigin, refreshHistory, sessionToken, streamGeneration]);

  // New messages and each streamed piece of a reply scroll the thread to the
  // bottom, unless the visitor scrolled up to reread something. This runs
  // before the browser paints, so new text never shows below the fold first.
  // A history that arrived before the settings shows once they load, and
  // opens at its latest message too.
  useLayoutEffect(() => {
    const thread = threadRef.current;
    if (thread && followThreadRef.current) thread.scrollTop = thread.scrollHeight;
  }, [chatLoaded, messages, status, voiceCaptions, submitError]);

  // Leaving or reloading the page hangs up a live voice call, and its captions,
  // unlike typed messages, don't come back from history. So the loader asks the
  // visitor first while a call is live, or while the panel shows the captions
  // of one. Captions in a closed panel aren't worth a prompt on every link.
  const voiceTranscriptShown = voiceCaptions.live || voiceCaptions.turns.length > 0;
  const warnBeforeLeaving = voiceCaptions.live || (voiceCaptions.turns.length > 0 && panelOpen);
  useEffect(() => {
    window.parent?.postMessage({ type: "leave-warning", enabled: warnBeforeLeaving }, "*");
  }, [warnBeforeLeaving]);

  // The loader's color holds until the settings arrive, so the chat never flashes the default color.
  const color = configState ? configState.config?.color ?? initialColor ?? DEFAULT_COLOR : initialColor ?? LOADING_COLOR;
  const onColor = readableOn(color);
  const title = configState?.config?.title || configState?.business?.name || t("chat.titlePlaceholder");

  async function submitChat(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    if (!visitorIdRef.current) return;
    setSubmitError(null);
    setDraft("");
    followThreadRef.current = true;
    if (chatIdleRef.current) {
      // This message closes the idle chat and starts a new one, which the
      // thread shows from here, as a reload would. The live updates follow
      // the new chat once the server answers, as for a first message.
      chatIdleRef.current = false;
      shownChatRef.current = null;
      setChatSaved(false);
      setMessages([]);
    }
    try {
      clearError();
      await sendMessage({ text: content });
    } catch {
      setSubmitError("chat.sendingFailed");
    }
  }

  async function submitLead(event: FormEvent) {
    event.preventDefault();
    const email = lead.email.trim();
    const phone = lead.phone.trim();
    if (configState?.config?.leadForm?.requireEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setSubmitError("lead.invalidEmail");
      return;
    }
    if (configState?.config?.leadForm?.requirePhone && !phone) {
      setSubmitError("lead.invalidPhone");
      return;
    }
    setLeadSubmitting(true);
    setSubmitError(null);
    try {
      const response = await fetch("/api/widget/lead", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}`, "x-widget-parent-origin": parentOrigin ?? "" },
        body: JSON.stringify({ visitorId: visitorIdRef.current, ...(lead.name.trim() ? { name: lead.name.trim() } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}) }),
      });
      if (!response.ok) {
        const code = await response.json().then((data: { code?: unknown }) => data.code, () => null);
        setSubmitError(code === "invalid_phone" ? "lead.invalidPhone" : code === "invalid_email" ? "lead.invalidEmail" : "chat.sendingFailed");
        return;
      }
      setLeadDone(true);
      setLeadOpen(false);
    } catch {
      setSubmitError("chat.sendingFailed");
    } finally {
      setLeadSubmitting(false);
    }
  }

  const showLeadBeforeChat = chatLoaded && Boolean(configState?.config?.leadForm?.showBeforeChat) && !leadDone && messages.length === 0;
  const showLeadButton = !leadDone && messages.length > 0 && Boolean(configState?.config?.leadForm?.enabled);
  // The id the loader keeps for this visitor, so the same chat comes back on every visit. Only its
  // start is shown: with the widget key, the full id is enough to open this visitor's chat.
  const shortVisitorId = parentVisitorId?.slice(0, 8) ?? "";
  const voiceEnabled = Boolean(configState?.voiceEnabled) && Boolean(configState?.businessSlug);
  const configErrorCode = config.error instanceof Error && ["originDenied", "invalidKey", "configLoad"].includes(config.error.message) ? config.error.message : null;
  // Until the settings and the history load, placeholders hold the place of the name, the call
  // button, the chat and the visitor ID, so nothing moves when they arrive.
  const chatPending = !chatLoaded && !config.isError && !submitError?.startsWith("errors.");

  return (
    // The chat fills the frame at a fixed height and only the thread scrolls, so new messages never
    // resize the frame or move the page around it.
    <main className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-white text-zinc-900">
      <header className="flex shrink-0 flex-col gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold" style={{ backgroundColor: color, color: onColor }} aria-hidden="true">
            {chatPending ? null : (title || "?")[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            {chatPending ? <div className="my-0.5 h-4 w-32 animate-pulse rounded bg-zinc-100" aria-hidden="true" /> : <p className="truncate text-sm font-semibold">{title}</p>}
            {chatLoaded && configState?.config?.subtitle ? <p className="truncate text-xs text-zinc-500">{configState.config.subtitle}</p> : null}
          </div>
        </div>
        {chatPending ? <div className="h-10 w-full animate-pulse rounded-4xl bg-zinc-100" aria-hidden="true" /> : null}
        {chatLoaded && voiceEnabled ? <VoiceButton className="w-full" businessSlug={configState!.businessSlug!} visitorId={visitorIdRef.current} sessionToken={sessionToken} parentOrigin={parentOrigin} onStatusChange={setSubmitError} onCaptions={setVoiceCaptions} /> : null}
      </header>

      {chatLoaded && handoff ? (
        <div className="shrink-0 border-b bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800" role="status">
          {handling.waitingForTeam ? t("chat.waitingForTeam") : handling.teamMemberName ? t("chat.teamMemberInChat", { name: handling.teamMemberName }) : t("chat.handoffBanner")}
        </div>
      ) : null}

      <div
        ref={threadRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4"
        onScroll={(event) => {
          const thread = event.currentTarget;
          followThreadRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 64;
        }}
      >
        {configErrorCode ? <p className="text-center text-sm text-zinc-500">{t(`errors.${configErrorCode}` as never)}</p> : null}
        {config.isError ? <p className="text-center text-sm text-zinc-500">{t("errors.configLoad")}</p> : null}
        {chatPending ? (
          <div className="flex flex-col gap-1" role="status">
            <span className="sr-only">{t("chat.loadingTranscript")}</span>
            <div className="my-0.5 h-4 w-44 animate-pulse rounded bg-zinc-100" aria-hidden="true" />
            <div className="h-14 w-4/5 animate-pulse rounded-xl rounded-bl-sm bg-zinc-100" aria-hidden="true" />
          </div>
        ) : null}
        {chatLoaded && messages.length === 0 && !showLeadBeforeChat ? (
          <div className="flex flex-col gap-1 text-sm text-zinc-600">
            <p className="font-medium text-zinc-800">{t("chat.welcome")}</p>
            {configState?.config?.greeting ? <p className="rounded-xl rounded-bl-sm bg-zinc-100 px-3 py-2 whitespace-pre-wrap">{configState.config.greeting}</p> : null}
          </div>
        ) : null}
        {chatLoaded ? thread.map(({ message, teamMemberName, joined, showName }) => (
          <Fragment key={message.id}>
            {joined ? <p className="text-center text-xs text-zinc-500">{teamMemberName ? t("chat.teamJoined", { name: teamMemberName }) : t("chat.teamJoinedNoName")}</p> : null}
            <div className={cn("flex flex-col gap-1", message.role === "user" ? "items-end" : "items-start")}>
              {showName ? <span className="px-1 text-xs font-medium text-zinc-500">{teamMemberName ?? t("chat.teamLabel")}</span> : null}
              {/* A long web address wraps instead of pushing the thread sideways. */}
              <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm wrap-anywhere", message.role === "user" ? "rounded-br-sm" : "rounded-bl-sm bg-zinc-100")} style={message.role === "user" ? { backgroundColor: color, color: onColor } : undefined}>
                <p><MessageContent content={messageText(message)} pending={streamingMessageId === message.id} /></p>
              </div>
            </div>
          </Fragment>
        )) : null}
        {sending && !handoff && messages.at(-1)?.role === "user" ? <div className="flex justify-start"><div className="rounded-2xl rounded-bl-sm bg-zinc-100 px-3 py-2 text-sm text-zinc-400">{t("chat.pendingLabel")}</div></div> : null}
        {voiceTranscriptShown ? <VoiceTranscript captions={voiceCaptions} color={color} onColor={onColor} t={t} /> : null}
        {submitError ? <p className="text-center text-xs text-red-600">{t(submitError)}</p> : null}
      </div>

      {showLeadBeforeChat ? (
        <LeadForm className="shrink-0 border-t p-4" lead={lead} setLead={setLead} onSubmit={submitLead} submitting={leadSubmitting} onSkip={() => { setLeadDone(true); setLeadOpen(false); }} t={t} />
      ) : null}

      <form className="flex shrink-0 flex-col gap-2 border-t p-3" onSubmit={(event) => void submitChat(event)}>
        <div className="flex items-end gap-2">
          <Input
            className="min-h-11 min-w-0 flex-1"
            placeholder={t("chat.composerPlaceholder")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!chatLoaded || sending || leadOpen}
            aria-label={t("chat.composerPlaceholder")}
          />
          <Button aria-label={t("chat.send")} disabled={!draft.trim() || sending || leadOpen} loading={sending} size="icon-lg" type="submit" style={{ backgroundColor: color, color: onColor }}><SendHorizontal /></Button>
        </div>
        {/* This row is always there, so the visitor ID arriving doesn't push the composer up. */}
        <div className="flex min-h-8 items-center gap-2">
          {showLeadButton ? <Button type="button" onClick={() => setLeadOpen(true)} variant="outline" size="sm" className="shrink-0 text-xs" disabled={leadOpen}>{t("chat.leaveDetails")}</Button> : null}
          {shortVisitorId ? <p className="ml-auto truncate text-xs text-zinc-400 tabular-nums">{t("chat.visitorId", { id: shortVisitorId })}</p> : chatPending ? <div className="ml-auto h-3 w-24 animate-pulse rounded bg-zinc-100" aria-hidden="true" /> : null}
        </div>
      </form>

      {leadOpen && !showLeadBeforeChat ? <LeadOverlay lead={lead} setLead={setLead} onSubmit={submitLead} submitting={leadSubmitting} onClose={() => setLeadOpen(false)} t={t} /> : null}
    </main>
  );
}

type ThreadEntry = {
  message: WidgetMessage;
  /** The first name of the team member who wrote the message, when they have one. */
  teamMemberName: string | null;
  /** The first team message after the receptionist's: someone from the team joined the chat. */
  joined: boolean;
  /** Where the speaker changes to a team member, their name goes above the message. */
  showName: boolean;
};

/**
 * The messages the thread shows, with who from the team wrote them. A reply
 * with no text, which is all the chat sends back while the team has it, isn't
 * shown, unless it's still streaming.
 */
export function threadEntries(messages: WidgetMessage[], streamingMessageId: string | null): ThreadEntry[] {
  let teamHasChat = false;
  let previousSpeaker: string | null = null;
  return messages.flatMap((message) => {
    if (message.role === "assistant" && !messageText(message).trim() && message.id !== streamingMessageId) return [];
    const fromTeam = message.role === "assistant" && message.metadata?.fromTeam === true;
    const name = fromTeam ? message.metadata?.teamMemberName ?? null : null;
    const speaker = fromTeam ? `team:${name ?? ""}` : message.role;
    const entry = { message, teamMemberName: name, joined: fromTeam && !teamHasChat, showName: fromTeam && speaker !== previousSpeaker };
    if (message.role === "assistant") teamHasChat = fromTeam;
    previousSpeaker = speaker;
    return [entry];
  });
}

function VoiceButton({ className, businessSlug, visitorId, sessionToken, parentOrigin, onStatusChange, onCaptions }: { className?: string; businessSlug: string; visitorId: string; sessionToken: string | null; parentOrigin: string | null; onStatusChange: (message: string | null) => void; onCaptions: (captions: VoiceCaptions) => void }) {
  const { t } = useTranslation("widget");
  // The iframe runs on the app's own origin, so the call starts here with the
  // widget session token and the embedding page's origin as proof of access.
  const { status, errorKey, remoteAudioRef, transcript, startCall, endCall } = useWebVoiceCall({
    businessSlug,
    widgetId: "lobbystack-widget",
    getStartPayload: async () => ({ visitorId }),
    getHeaders: () => ({ ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}), ...(parentOrigin ? { "x-widget-parent-origin": parentOrigin } : {}) }),
  });

  useEffect(() => {
    if (status === "connected") onStatusChange(null);
    if (status === "error") onStatusChange(errorKey === "connectionDropped" ? "chat.voiceEnded" : "chat.voiceUnavailable");
  }, [errorKey, onStatusChange, status]);

  useEffect(() => {
    onCaptions({ live: status === "connected", turns: transcript });
  }, [onCaptions, status, transcript]);

  const active = status === "requesting_microphone" || status === "connecting" || status === "connected";
  // A labelled button the width of the chat, under the business name, so calling is as easy to find as typing.
  return (
    <>
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      {active ? (
        <Button variant="destructive" size="lg" className={className} onClick={() => void endCall()}><PhoneOff />{t("chat.voiceEnd")}</Button>
      ) : (
        <Button size="lg" className={className} title={t("chat.voiceButton")} onClick={() => void startCall()} disabled={status === "ending"}><Phone />{t("chat.voiceStart")}</Button>
      )}
    </>
  );
}

// Live captions of a widget voice call, in the chat thread. They stay after the
// call ends, until the next call starts, and aren't kept on reload.
function VoiceTranscript({ captions, color, onColor, t }: { captions: VoiceCaptions; color: string; onColor: string; t: (key: string) => string }) {
  const turns = captions.turns.filter((turn) => turn.text.trim());
  return (
    <section className="flex flex-col gap-3" aria-label={t("chat.voiceTranscript")}>
      <p className="flex items-center justify-center gap-2 text-xs font-medium text-zinc-500">
        {t("chat.voiceTranscript")}
        {captions.live ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-red-600">
            <span className="size-1.5 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
            {t("chat.voiceLive")}
          </span>
        ) : null}
      </p>
      {captions.live && turns.length === 0 ? <p className="text-center text-xs text-zinc-400">{t("chat.voiceConnected")}</p> : null}
      {turns.map((turn, index) => (
        <div key={index} className={cn("flex", turn.speaker === "caller" ? "justify-end" : "justify-start")}>
          <p className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap", turn.speaker === "caller" ? "rounded-br-sm" : "rounded-bl-sm bg-zinc-100")} style={turn.speaker === "caller" ? { backgroundColor: color, color: onColor } : undefined}>
            {turn.text.trim()}
          </p>
        </div>
      ))}
    </section>
  );
}

function LeadOverlay({ lead, setLead, onSubmit, submitting, onClose, t }: { lead: { name: string; email: string; phone: string }; setLead: (value: { name: string; email: string; phone: string }) => void; onSubmit: (event: FormEvent) => void; submitting: boolean; onClose: () => void; t: (key: string) => string }) {
  return (
    <div className="absolute inset-0 z-10 flex items-end bg-black/30 p-4 sm:items-center">
      <form className="w-full rounded-2xl bg-white p-4 shadow-xl" onSubmit={onSubmit}>
        <h2 className="text-sm font-semibold">{t("lead.heading")}</h2>
        <p className="mb-3 text-xs text-zinc-500">{t("lead.description")}</p>
        <div className="space-y-3">
          <label className="block text-xs font-medium text-zinc-700">{t("lead.name")}<Input className="mt-1" value={lead.name} onChange={(event) => setLead({ ...lead, name: event.target.value })} /></label>
          <label className="block text-xs font-medium text-zinc-700">{t("lead.email")}<Input className="mt-1" type="email" value={lead.email} onChange={(event) => setLead({ ...lead, email: event.target.value })} /></label>
          <label className="block text-xs font-medium text-zinc-700">{t("lead.phone")}<Input className="mt-1" type="tel" value={lead.phone} onChange={(event) => setLead({ ...lead, phone: event.target.value })} /></label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("lead.skip")}</Button>
          <Button type="submit" loading={submitting}>{t("lead.submit")}</Button>
        </div>
      </form>
    </div>
  );
}

function LeadForm({ lead, setLead, onSubmit, submitting, onSkip, t, className }: { lead: { name: string; email: string; phone: string }; setLead: (value: { name: string; email: string; phone: string }) => void; onSubmit: (event: FormEvent) => void; submitting: boolean; onSkip: () => void; t: (key: string) => string; className?: string }) {
  return (
    <form className={cn("space-y-3", className)} onSubmit={onSubmit}>
      <div>
        <h2 className="text-sm font-semibold">{t("lead.beforeChatHeading")}</h2>
        <p className="text-xs text-zinc-500">{t("lead.description")}</p>
      </div>
      <Input placeholder={t("lead.name")} value={lead.name} onChange={(event) => setLead({ ...lead, name: event.target.value })} />
      <Input placeholder={t("lead.email")} type="email" value={lead.email} onChange={(event) => setLead({ ...lead, email: event.target.value })} />
      <Input placeholder={t("lead.phone")} type="tel" value={lead.phone} onChange={(event) => setLead({ ...lead, phone: event.target.value })} />
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" loading={submitting}>{t("lead.submit")}</Button>
        <Button type="button" variant="ghost" onClick={onSkip}>{t("lead.skip")}</Button>
      </div>
    </form>
  );
}
