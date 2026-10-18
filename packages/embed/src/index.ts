type LobbyStackApi = {
  open: () => void;
  close: () => void;
  toggle: () => void;
};

type WidgetMessage = { type: string; [key: string]: unknown };

// The root's z-index lifts the panel above the site's own fixed elements: a
// fixed element is a stacking context, so the panel's z-index alone only counts
// inside it. The bubble has the same z-index and comes later in the page, so it
// stays above the panel's shadow.
const WIDGET_STYLES = `
.lobby-widget-root{position:fixed;inset:0;pointer-events:none;z-index:2147483000}
.lobby-widget-bubble{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:9999px;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(0,0,0,.22);pointer-events:auto;transition:transform .15s ease;z-index:2147483000}
.lobby-widget-bubble:hover{transform:scale(1.06)}
.lobby-widget-bubble[data-position="bottom-left"]{left:24px;right:auto}
.lobby-widget-bubble[data-position="bottom-center"]{left:50%;transform:translateX(-50%)}
.lobby-widget-bubble[data-position="bottom-center"]:hover{transform:translateX(-50%) scale(1.06)}
.lobby-widget-bubble svg{width:30px;height:30px}
.lobby-widget-frame-holder{position:fixed;bottom:96px;right:24px;width:min(380px,calc(100vw - 32px));height:0;opacity:0;pointer-events:none;transition:opacity .18s ease;z-index:2147483001}
.lobby-widget-frame-holder[data-position="bottom-left"]{left:24px;right:auto}
.lobby-widget-frame-holder[data-position="bottom-center"]{left:50%;transform:translateX(-50%)}
.lobby-widget-frame-holder.lobby-widget-open{opacity:1;pointer-events:auto}
.lobby-widget-frame{width:100%;height:100%;border:0;border-radius:16px;background:#fff;box-shadow:0 24px 64px rgba(0,0,0,.24)}
.lobby-widget-hidden{display:none!important}
.lobby-widget-inline{width:100%;height:100%;border-radius:inherit;overflow:hidden}
.lobby-widget-inline .lobby-widget-frame{display:block;border-radius:inherit;box-shadow:none}
`;

function injectStyles(): void {
  const style = document.createElement("style");
  style.textContent = WIDGET_STYLES;
  document.head.appendChild(style);
}

function resolveOrigin(): string {
  // The admin app serves this loader, so its own src names the API origin when data-base-url is absent.
  const baseUrl = currentScriptAttribute("data-base-url") || (document.currentScript as HTMLScriptElement | null)?.src;
  if (baseUrl) {
    try {
      return new URL(baseUrl, window.location.href).origin;
    } catch {
      /* fall through */
    }
  }
  return window.origin;
}

type LoaderLabels = { title: string; open: string; close: string };

const LOADER_LABELS: Record<"en" | "fr" | "es" | "sr", LoaderLabels> = {
  en: { title: "Chat with us", open: "Open chat", close: "Close chat" },
  fr: { title: "Discutez avec nous", open: "Ouvrir la discussion", close: "Fermer la discussion" },
  es: { title: "Escríbanos", open: "Abrir el chat", close: "Cerrar el chat" },
  sr: { title: "Pišite nam", open: "Otvori čet", close: "Zatvori čet" },
};

/** Labels for the bubble and frame in the host page's language, English otherwise. */
export function loaderLabels(language: string): LoaderLabels {
  const primary = language.trim().toLowerCase().split(/[-_]/)[0];
  return primary === "fr" || primary === "es" || primary === "sr" ? LOADER_LABELS[primary] : LOADER_LABELS.en;
}

/** The key in the loader's own URL (`/embed.js?key=…`), for a tag without data-widget-key. */
function scriptSrcKey(): string | null {
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  if (!src) return null;
  try {
    return new URL(src, window.location.href).searchParams.get("key");
  } catch {
    return null;
  }
}

function currentScriptAttribute(name: string): string | null {
  const script = document.currentScript as HTMLScriptElement | null;
  return script?.getAttribute(name) ?? null;
}

type WidgetPosition = "bottom-left" | "bottom-center" | "bottom-right";
type WidgetLocale = "en" | "fr" | "es" | "sr";
type WidgetAppearance = { color?: string; position?: WidgetPosition; locale?: WidgetLocale };

// Filled by the dashboard's keyed loader (`/embed.js?key=…`) before this code
// runs; the name matches WIDGET_APPEARANCE_GLOBAL in @lobbystack/shared.
const APPEARANCE_GLOBAL = "__lobbyStackWidgetAppearance";
const POSITIONS: ReadonlyArray<WidgetPosition> = ["bottom-left", "bottom-center", "bottom-right"];
const LOCALES: ReadonlyArray<WidgetLocale> = ["en", "fr", "es", "sr"];
const COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;

/** The bubble look and chat language the dashboard saved for this key, when the loader carried them. */
function savedAppearance(widgetKey: string): WidgetAppearance {
  const saved = (window as unknown as Record<string, Record<string, WidgetAppearance> | undefined>)[APPEARANCE_GLOBAL]?.[widgetKey];
  return {
    ...(typeof saved?.color === "string" && COLOR_PATTERN.test(saved.color) ? { color: saved.color } : {}),
    ...(saved?.position && POSITIONS.includes(saved.position) ? { position: saved.position } : {}),
    ...(saved?.locale && LOCALES.includes(saved.locale) ? { locale: saved.locale } : {}),
  };
}

/**
 * Near-black or white for the bubble's icon, whichever reads better on its
 * color, as the chat itself chooses (a yellow gets a dark icon). White for a
 * color that isn't written in hex.
 */
export function iconColorOn(color: string): string {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim())?.[1];
  if (!hex) return "#ffffff";
  const value = hex.length <= 4 ? [...hex.slice(0, 3)].map((digit) => digit + digit).join("") : hex.slice(0, 6);
  const [red, green, blue] = [0, 2, 4].map((start) => {
    const channel = Number.parseInt(value.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  // Contrast ratios against white and against zinc-900 (luminance 0.0097).
  return (luminance + 0.05) / 0.0597 > 1.05 / (luminance + 0.05) ? "#18181b" : "#ffffff";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// crypto.randomUUID only exists on https pages; getRandomValues also works on http ones.
function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeVisitorId(widgetKey: string): string {
  const storageKey = `lobbystack.visitorId.${widgetKey}`;
  try {
    // Older loaders stored non-UUID ids on http pages, which the session API rejects.
    const existing = window.localStorage.getItem(storageKey);
    if (existing && UUID_PATTERN.test(existing)) return existing;
  } catch {
    /* storage unavailable */
  }
  const id = randomUuid();
  try {
    window.localStorage.setItem(storageKey, id);
  } catch {
    /* storage unavailable */
  }
  return id;
}

export function initWidget(): boolean {
  const widgetKey = (currentScriptAttribute("data-widget-key") ?? scriptSrcKey() ?? "").trim();
  if (!widgetKey) return false;
  // The dashboard's saved look wins; the script tag's attributes cover older snippets.
  const saved = savedAppearance(widgetKey);
  const position = saved.position ?? (currentScriptAttribute("data-position") as WidgetPosition | null) ?? "bottom-right";
  const color = saved.color ?? currentScriptAttribute("data-color") ?? "#0f766e";
  const labels = loaderLabels(currentScriptAttribute("data-locale") ?? document.documentElement.lang ?? "en");
  // A selector for an element on the page that shows the chat itself, instead of a bubble.
  const inlineTarget = currentScriptAttribute("data-inline-target")?.trim() ?? "";
  const adminOrigin = resolveOrigin();
  let visitorId = makeVisitorId(widgetKey);
  // The chat page draws itself in the bubble's color and the business's language from its first
  // paint, instead of defaults that its settings then replace.
  const frameSrc = `${adminOrigin}/embed/${encodeURIComponent(widgetKey)}?${new URLSearchParams({ color, ...(saved.locale ? { locale: saved.locale } : {}) })}`;

  injectStyles();

  const root = document.createElement("div");
  root.className = "lobby-widget-root";
  const holder = document.createElement("div");
  holder.className = "lobby-widget-frame-holder";
  holder.setAttribute("data-position", position);
  const frame = document.createElement("iframe");
  frame.className = "lobby-widget-frame";
  frame.setAttribute("title", labels.title);
  frame.setAttribute("allow", "microphone");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
  frame.setAttribute("loading", "lazy");
  const bubble = document.createElement("button");
  bubble.type = "button";
  bubble.className = "lobby-widget-bubble";
  bubble.setAttribute("aria-label", labels.open);
  bubble.setAttribute("aria-expanded", "false");
  holder.inert = true;
  bubble.setAttribute("data-position", position);
  bubble.style.backgroundColor = color;
  const iconColor = iconColorOn(color);
  const chatSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
  const closeSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  bubble.innerHTML = chatSvg;

  // The page's element the chat shows in, once it's mounted there.
  let inlineContainer: Element | null = null;

  function findInlineTarget(): Element | null {
    if (!inlineTarget) return null;
    try {
      return document.querySelector(inlineTarget);
    } catch {
      return null;
    }
  }

  /** The bubble in the page's corner, with the chat in a panel above it. */
  function mountBubble(): void {
    holder.appendChild(frame);
    root.appendChild(holder);
    (document.body ?? document.documentElement).append(root, bubble);
  }

  /**
   * The chat in the page's own element, such as a business's profile page. It
   * starts once the element comes near the screen, so a visitor who never
   * scrolls to it opens no session.
   */
  function mountInline(container: Element): void {
    inlineContainer = container;
    if (typeof IntersectionObserver !== "function") {
      startInline();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      startInline();
    }, { rootMargin: "200px" });
    observer.observe(container);
  }

  function startInline(): void {
    if (!inlineContainer) return;
    if (!inlineContainer.contains(frame)) {
      const wrapper = document.createElement("div");
      wrapper.className = "lobby-widget-inline";
      wrapper.appendChild(frame);
      // The page's own placeholder makes way for the chat.
      inlineContainer.replaceChildren(wrapper);
    }
    start();
  }

  let open = false;
  let started = false;
  let frameLoaded = false;
  let sessionMessage: WidgetMessage | null = null;
  let sessionRefreshTimer: number | undefined;
  let sessionState: "idle" | "pending" | "ready" | "error" = "idle";
  let sessionExpiresAtMs = 0;
  let renewalFailures = 0;

  /**
   * Tries a failed renewal again a little later while the current session
   * still works, so a chat left open through a deploy keeps going. False for
   * a refusal that won't change, such as a revoked key, or when the session
   * would expire first.
   */
  function retryRenewal(status: number): boolean {
    const delay = Math.min(60_000, 2_000 * 2 ** renewalFailures);
    if (!(status === 0 || status === 429 || status >= 500) || Date.now() + delay >= sessionExpiresAtMs) return false;
    renewalFailures += 1;
    sessionState = "ready";
    sessionRefreshTimer = window.setTimeout(() => void refreshSession(visitorId), delay);
    return true;
  }

  async function refreshSession(nextVisitorId: string): Promise<void> {
    visitorId = nextVisitorId;
    const renewing = sessionState === "ready" && Date.now() < sessionExpiresAtMs;
    sessionState = "pending";
    // 0 until the server answers, as when the network is down.
    let status = 0;
    try {
      const response = await fetch(`${adminOrigin}/api/widget/session`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ widgetKey, visitorId }),
      });
      status = response.status;
      const payload = await response.json() as { token?: string; expiresAt?: string; code?: string };
      if (!response.ok || !payload.token) {
        if (renewing && retryRenewal(status)) return;
        sessionState = "error";
        sessionMessage = { type: "session-error", code: payload.code ?? "widget_session_failed" };
        if (frameLoaded) postToFrame(sessionMessage);
        return;
      }
      sessionState = "ready";
      renewalFailures = 0;
      sessionMessage = { type: "session", token: payload.token, expiresAt: payload.expiresAt, visitorId, parentOrigin: window.location.origin };
      if (frameLoaded) postToFrame(sessionMessage);
      if (sessionRefreshTimer !== undefined) window.clearTimeout(sessionRefreshTimer);
      const expiresAtMs = payload.expiresAt ? Date.parse(payload.expiresAt) : Date.now() + 3_600_000;
      sessionExpiresAtMs = expiresAtMs;
      // Renewing five minutes early leaves time to try again through an outage.
      sessionRefreshTimer = window.setTimeout(() => void refreshSession(visitorId), Math.max(30_000, expiresAtMs - Date.now() - 5 * 60_000));
    } catch {
      // An error page, such as a deploy's 502, isn't JSON and lands here with its status.
      if (renewing && retryRenewal(status)) return;
      sessionState = "error";
      sessionMessage = { type: "session-error", code: "widget_session_failed" };
      if (frameLoaded) postToFrame(sessionMessage);
    }
  }

  function syncBubbleIcon(): void {
    bubble.innerHTML = open ? closeSvg : chatSvg;
  }

  /** Loads the chat once, and asks for a session unless it has one or is getting one. */
  function start(): void {
    if (!started) {
      started = true;
      frame.setAttribute("src", frameSrc);
    }
    if (sessionState === "idle" || sessionState === "error") {
      void refreshSession(visitorId);
    }
  }

  function setOpen(next: boolean): void {
    open = next;
    holder.inert = !open;
    if (open) start();
    holder.classList.toggle("lobby-widget-open", open);
    // The panel keeps one height whatever the chat holds, so new messages never move the page.
    if (open && !holder.style.height) holder.style.height = "min(640px, calc(100vh - 120px))";
    bubble.setAttribute("aria-expanded", String(open));
    bubble.setAttribute("aria-label", open ? labels.close : labels.open);
    syncBubbleIcon();
    postToFrame({ type: open ? "open" : "close" });
  }

  function postToFrame(message: WidgetMessage): void {
    try {
      frame.contentWindow?.postMessage(message, adminOrigin);
    } catch {
      /* ignore */
    }
  }

  function onFrameReady(): void {
    frameLoaded = true;
    if (sessionMessage) postToFrame(sessionMessage);
    postToFrame({ type: "visitor", visitorId });
  }

  frame.addEventListener("load", onFrameReady);

  // Leaving or reloading the page hangs up a voice call in the chat, and its
  // captions aren't saved, so while the chat says it has one the browser asks
  // first. Browsers word the prompt themselves. The listener only exists while
  // it's needed, since a standing beforeunload listener can keep the page out
  // of the browser's back/forward cache.
  let warnOnLeave = false;
  const confirmLeave = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // Chrome and Edge before 119 ignore preventDefault and need returnValue.
    event.returnValue = true;
  };
  function setWarnOnLeave(next: boolean): void {
    if (next === warnOnLeave) return;
    warnOnLeave = next;
    if (next) window.addEventListener("beforeunload", confirmLeave);
    else window.removeEventListener("beforeunload", confirmLeave);
  }

  // Issue the session on first open instead of at script load. This keeps the
  // widget dormant (and avoids an unauthenticated request) until a visitor
  // engages, while a failed request can retry on a later open.
  bubble.addEventListener("click", () => setOpen(!open));
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== adminOrigin || event.source !== frame.contentWindow) return;
    const data = event.data as Partial<WidgetMessage>;
    if (!data || typeof data !== "object") return;
    if (data.type === "ready") onFrameReady();
    // A chat in the page's own element stays where it is.
    if (data.type === "close" && !inlineContainer) setOpen(false);
    if (data.type === "leave-warning") setWarnOnLeave(data.enabled === true);
  });

  // A snippet in the page's <head> without defer runs before <body> exists, and
  // a chat's element may not be read yet either, so the widget joins the page
  // once it has been read. Without its element, the chat gets a bubble.
  const attach = () => {
    const container = findInlineTarget();
    if (container) mountInline(container);
    else mountBubble();
  };
  if (document.body && (!inlineTarget || findInlineTarget() || document.readyState !== "loading")) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });

  window.LobbyStack = {
    open: () => {
      if (!inlineContainer) return setOpen(true);
      startInline();
      inlineContainer.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    },
    close: () => {
      if (!inlineContainer) setOpen(false);
    },
    toggle: () => (inlineContainer ? startInline() : setOpen(!open)),
  };

  return true;
}

declare global {
  interface Window {
    LobbyStack?: LobbyStackApi;
  }
}

initWidget();
