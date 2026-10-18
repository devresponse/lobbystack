// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { iconColorOn, initWidget, loaderLabels } from "./index";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; delete (window as unknown as Record<string, unknown>).__lobbyStackWidgetAppearance; });

function mountWidget(baseUrl: string | null = "https://admin.example.test"): HTMLIFrameElement {
  vi.useFakeTimers();
  const script = document.createElement("script");
  script.setAttribute("data-widget-key", "fixture-key");
  if (baseUrl) script.setAttribute("data-base-url", baseUrl);
  else script.src = "https://admin.example.test/embed.js";
  vi.spyOn(document, "currentScript", "get").mockReturnValue(script);
  expect(initWidget()).toBe(true);
  return document.querySelector("iframe")!;
}

async function flush(): Promise<void> {
  // Flush the session request and its json/state continuations. A couple of
  // microtasks is not enough under CI load, which let the first "ready" race
  // the request and post only the visitor message.
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

async function start(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  const frame = mountWidget();
  // The session is only issued on first open: no request at script load.
  expect(fetchMock).not.toHaveBeenCalled();
  // Only the chat iframe is deferred: no src until the visitor opens.
  expect(frame.hasAttribute("src")).toBe(false);
  window.LobbyStack!.open();
  expect(frame.getAttribute("src")).toBe("https://admin.example.test/embed/fixture-key?color=%230f766e");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  await flush();
  return { frame, post, fetchMock };
}

it("does not issue a session request before the visitor opens the chat", () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ token: "fixture-session" }));
  vi.stubGlobal("fetch", fetchMock);
  const frame = mountWidget();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(frame.hasAttribute("src")).toBe(false);
  window.LobbyStack!.open();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("issues exactly one session request across successful repeated opens", async () => {
  const { frame, fetchMock } = await start(Response.json({ token: "fixture-session", expiresAt: "2099-01-01T00:00:00Z" }));
  window.LobbyStack!.close();
  window.LobbyStack!.open();
  window.LobbyStack!.close();
  window.LobbyStack!.open();
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(frame.getAttribute("src")).toBe("https://admin.example.test/embed/fixture-key?color=%230f766e");
});

it("resends the completed session when the hydrated iframe announces readiness", async () => {
  const { frame, post } = await start(Response.json({ token: "fixture-session", expiresAt: "2099-01-01T00:00:00Z" }));
  frame.dispatchEvent(new Event("load"));
  post.mockClear();
  window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source: frame.contentWindow, data: { type: "ready" } }));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "session", token: "fixture-session" }), "https://admin.example.test");
  post.mockClear();
  window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source: window, data: { type: "ready" } }));
  expect(post).not.toHaveBeenCalled();
});

it("delivers session errors to the iframe instead of leaving it disabled without feedback", async () => {
  const { frame, post } = await start(Response.json({ code: "widget_origin_denied" }, { status: 403 }));
  window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source: frame.contentWindow, data: { type: "ready" } }));
  expect(post).toHaveBeenCalledWith({ type: "session-error", code: "widget_origin_denied" }, "https://admin.example.test");
});

it("delivers the session to a lazily opened iframe that reports ready before the session resolves", async () => {
  let resolveFetch!: (response: Response) => void;
  const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; }));
  vi.stubGlobal("fetch", fetchMock);
  const frame = mountWidget();
  expect(fetchMock).not.toHaveBeenCalled();
  window.LobbyStack!.open();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source: frame.contentWindow, data: { type: "ready" } }));
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session" }), "https://admin.example.test");
  resolveFetch(Response.json({ token: "late-session", expiresAt: "2099-01-01T00:00:00Z" }));
  await flush();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "session", token: "late-session", visitorId: expect.any(String) }), "https://admin.example.test");
});

it("retries the session request on a later open after a failure", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ code: "widget_session_failed" }, { status: 500 }))
    .mockResolvedValueOnce(Response.json({ token: "retry-session", expiresAt: "2099-01-01T00:00:00Z" }));
  vi.stubGlobal("fetch", fetchMock);
  const frame = mountWidget();
  expect(fetchMock).not.toHaveBeenCalled();
  window.LobbyStack!.open();
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  window.LobbyStack!.close();
  window.LobbyStack!.open();
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source: frame.contentWindow, data: { type: "ready" } }));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "session", token: "retry-session" }), "https://admin.example.test");
});

it("renews the session before it expires, trying again through a short outage such as a deploy", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const frame = mountWidget();
  const session = (token: string) => Response.json({ token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  fetchMock
    .mockImplementationOnce(async () => session("first-session"))
    .mockImplementationOnce(async () => new Response("Application failed to respond", { status: 502 }))
    .mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); })
    .mockImplementationOnce(async () => session("renewed-session"));
  window.LobbyStack!.open();
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  await flush();
  window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source: frame.contentWindow, data: { type: "ready" } }));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "session", token: "first-session" }), "https://admin.example.test");

  // Five minutes before the hour is up it renews, while a deploy answers 502 and then the network drops.
  await vi.advanceTimersByTimeAsync(55 * 60_000);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2_000);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(4_000);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  // The chat kept its session meanwhile and never showed an error.
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session-error" }), expect.anything());
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "session", token: "renewed-session" }), "https://admin.example.test");
});

it("tells the chat when a renewal is refused for good, without trying again", async () => {
  const fetchMock = vi.fn()
    .mockImplementationOnce(async () => Response.json({ token: "first-session", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }))
    .mockImplementationOnce(async () => Response.json({ code: "widget_key_invalid" }, { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  const frame = mountWidget();
  window.LobbyStack!.open();
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  await flush();
  window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source: frame.contentWindow, data: { type: "ready" } }));
  await vi.advanceTimersByTimeAsync(55 * 60_000);
  await flush();
  expect(post).toHaveBeenCalledWith({ type: "session-error", code: "widget_key_invalid" }, "https://admin.example.test");
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("asks before the page unloads only while the chat has a voice call or its captions", async () => {
  const { frame } = await start(Response.json({ token: "fixture-session", expiresAt: "2099-01-01T00:00:00Z" }));
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const leaveWarning = (enabled: boolean, source: MessageEventSource | null = frame.contentWindow) => {
    window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source, data: { type: "leave-warning", enabled } }));
  };
  expect(unload()).toBe(false);
  leaveWarning(true, window);
  expect(unload()).toBe(false);
  leaveWarning(true);
  expect(unload()).toBe(true);
  leaveWarning(false);
  expect(unload()).toBe(false);
});

it("keeps the panel at one height when the chat reports its content height", async () => {
  const { frame } = await start(Response.json({ token: "fixture-session", expiresAt: "2099-01-01T00:00:00Z" }));
  const holder = frame.parentElement as HTMLElement;
  const height = holder.style.height;
  window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source: frame.contentWindow, data: { type: "resize", height: 200 } }));
  expect(holder.style.height).toBe(height);
  expect(holder.style.height).not.toBe("200px");
});

it("labels the loader in the host page language", () => {
  expect(loaderLabels("es-MX").open).toBe("Abrir el chat");
  expect(loaderLabels("sr-Latn-RS").title).toBe("Pišite nam");
  expect(loaderLabels("fr").close).toBe("Fermer la discussion");
  expect(loaderLabels("de").title).toBe("Chat with us");
});

it("keeps the sandbox and supports external links without exposing unsupported APIs", async () => {
  const { frame } = await start(Response.json({ token: "fixture-session" }));
  expect(frame.getAttribute("sandbox")?.split(" ")).toEqual(expect.arrayContaining(["allow-scripts", "allow-same-origin", "allow-popups", "allow-popups-to-escape-sandbox"]));
  expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  expect(Object.keys(window.LobbyStack!)).toEqual(["open", "close", "toggle"]);
  window.LobbyStack!.close();
  expect((frame.parentElement as HTMLElement).inert).toBe(true);
});

it("loads the chat from the loader's own origin when the snippet has no data-base-url", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ token: "fixture-session" }));
  vi.stubGlobal("fetch", fetchMock);
  const frame = mountWidget(null);
  window.LobbyStack!.open();
  expect(frame.getAttribute("src")).toBe("https://admin.example.test/embed/fixture-key?color=%230f766e");
  expect(fetchMock).toHaveBeenCalledWith("https://admin.example.test/api/widget/session", expect.anything());
});

it("sends a UUID visitor id on http pages without crypto.randomUUID and replaces a stored non-UUID id", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ token: "fixture-session" }));
  vi.stubGlobal("fetch", fetchMock);
  const realCrypto = globalThis.crypto;
  // http pages expose getRandomValues but not randomUUID.
  vi.stubGlobal("crypto", { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
  window.localStorage.setItem("lobbystack.visitorId.fixture-key", "v-1760000000000-abc");
  mountWidget();
  window.LobbyStack!.open();
  const { visitorId } = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { visitorId: string };
  expect(visitorId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(window.localStorage.getItem("lobbystack.visitorId.fixture-key")).toBe(visitorId);
});

function mountTag(attributes: Record<string, string>, src = "https://admin.example.test/embed.js?key=fixture-key"): void {
  const script = document.createElement("script");
  script.src = src;
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  vi.spyOn(document, "currentScript", "get").mockReturnValue(script);
  expect(initWidget()).toBe(true);
}

function bubble(): HTMLButtonElement {
  return document.querySelector(".lobby-widget-bubble")!;
}

it("draws the bubble with the look saved in the dashboard over the script tag's attributes", () => {
  (window as unknown as Record<string, unknown>).__lobbyStackWidgetAppearance = { "fixture-key": { color: "#112233", position: "bottom-left" } };
  mountTag({ "data-widget-key": "fixture-key", "data-color": "#ff0000", "data-position": "bottom-right" });
  expect(bubble().style.backgroundColor).toBe("rgb(17, 34, 51)");
  expect(bubble().getAttribute("data-position")).toBe("bottom-left");
  expect(document.querySelector(".lobby-widget-frame-holder")!.getAttribute("data-position")).toBe("bottom-left");
});

it("keeps the script tag's look for fields the dashboard did not save, and ignores invalid saved values", () => {
  (window as unknown as Record<string, unknown>).__lobbyStackWidgetAppearance = { "fixture-key": { color: "red;background:url(x)", position: "top" } };
  mountTag({ "data-widget-key": "fixture-key", "data-color": "#ff0000", "data-position": "bottom-center" });
  expect(bubble().style.backgroundColor).toBe("rgb(255, 0, 0)");
  expect(bubble().getAttribute("data-position")).toBe("bottom-center");
});

it("ignores a look saved for another key", () => {
  (window as unknown as Record<string, unknown>).__lobbyStackWidgetAppearance = { "other-key": { color: "#112233", position: "bottom-left" } };
  mountTag({ "data-widget-key": "fixture-key" });
  expect(bubble().style.backgroundColor).toBe("rgb(15, 118, 110)");
  expect(bubble().getAttribute("data-position")).toBe("bottom-right");
});

it("takes the widget key from the loader URL when the tag has no data-widget-key", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ token: "fixture-session" })));
  mountTag({});
  window.LobbyStack!.open();
  expect(document.querySelector("iframe")!.getAttribute("src")).toBe("https://admin.example.test/embed/fixture-key?color=%230f766e");
});

it("tells the chat page the bubble's color, so it loads in that color", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ token: "fixture-session" })));
  (window as unknown as Record<string, unknown>).__lobbyStackWidgetAppearance = { "fixture-key": { color: "#ffd100" } };
  mountTag({ "data-widget-key": "fixture-key", "data-color": "#ff0000" });
  window.LobbyStack!.open();
  expect(document.querySelector("iframe")!.getAttribute("src")).toBe("https://admin.example.test/embed/fixture-key?color=%23ffd100");
});

it("opens the chat in the business's language that the dashboard sent with the loader", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ token: "fixture-session" })));
  (window as unknown as Record<string, unknown>).__lobbyStackWidgetAppearance = { "fixture-key": { color: "#ffd100", locale: "fr" } };
  mountTag({ "data-widget-key": "fixture-key" });
  window.LobbyStack!.open();
  expect(document.querySelector("iframe")!.getAttribute("src")).toBe("https://admin.example.test/embed/fixture-key?color=%23ffd100&locale=fr");
});

it("leaves out a saved language the chat doesn't offer", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ token: "fixture-session" })));
  (window as unknown as Record<string, unknown>).__lobbyStackWidgetAppearance = { "fixture-key": { locale: "de" } };
  mountTag({ "data-widget-key": "fixture-key" });
  window.LobbyStack!.open();
  expect(document.querySelector("iframe")!.getAttribute("src")).toBe("https://admin.example.test/embed/fixture-key?color=%230f766e");
});

it("stacks the panel above the site's own fixed elements, with the bubble above the panel", () => {
  mountTag({ "data-widget-key": "fixture-key" });
  const root = document.querySelector<HTMLElement>(".lobby-widget-root")!;
  // A fixed element is a stacking context. Without a z-index of its own, the
  // root kept the panel under any fixed element with one, such as a cookie bar.
  expect(Number(getComputedStyle(root).zIndex)).toBeGreaterThanOrEqual(2147483000);
  expect(getComputedStyle(root).zIndex).toBe(getComputedStyle(bubble()).zIndex);
  expect(root.compareDocumentPosition(bubble()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("waits for the page's body when the snippet runs in the head without defer", () => {
  const body = document.body;
  body.remove();
  try {
    expect(document.body).toBeNull();
    mountTag({ "data-widget-key": "fixture-key" });
    expect(document.querySelector(".lobby-widget-bubble")).toBeNull();
    document.documentElement.append(body);
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(body.querySelector(".lobby-widget-bubble")).not.toBeNull();
    expect(body.querySelector(".lobby-widget-root iframe")).not.toBeNull();
  } finally {
    if (!document.body) document.documentElement.append(body);
  }
});

it("draws the bubble's icon dark on a light color and white on a dark one", () => {
  expect(iconColorOn("#ffd100")).toBe("#18181b");
  expect(iconColorOn("#FD0")).toBe("#18181b");
  expect(iconColorOn("#0f766e")).toBe("#ffffff");
  expect(iconColorOn("#000000ff")).toBe("#ffffff");
  expect(iconColorOn("red")).toBe("#ffffff");
  (window as unknown as Record<string, unknown>).__lobbyStackWidgetAppearance = { "fixture-key": { color: "#ffd100" } };
  mountTag({ "data-widget-key": "fixture-key" });
  expect(bubble().querySelector("svg")!.getAttribute("stroke")).toBe("#18181b");
});

function inlineContainer(): HTMLElement {
  const container = document.createElement("div");
  container.id = "profile-chat";
  container.textContent = "The chat opens here.";
  document.body.append(container);
  return container;
}

it("shows the chat in the page's own element, without a bubble", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ token: "fixture-session", expiresAt: "2099-01-01T00:00:00Z" }));
  vi.stubGlobal("fetch", fetchMock);
  const container = inlineContainer();
  mountTag({ "data-widget-key": "fixture-key", "data-inline-target": "#profile-chat" });
  // jsdom has no IntersectionObserver, so the chat starts at once.
  expect(document.querySelector(".lobby-widget-bubble")).toBeNull();
  expect(container.textContent).toBe("");
  const frame = container.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toBe("https://admin.example.test/embed/fixture-key?color=%230f766e");
  expect(frame.getAttribute("allow")).toBe("microphone");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // The chat can't close itself out of the page, and opening it again asks for no new session.
  window.dispatchEvent(new MessageEvent("message", { origin: "https://admin.example.test", source: frame.contentWindow, data: { type: "close" } }));
  window.LobbyStack!.close();
  window.LobbyStack!.open();
  await flush();
  expect(container.querySelector("iframe")).toBe(frame);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("starts the chat in the page's element only once it comes near the screen", () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ token: "fixture-session", expiresAt: "2099-01-01T00:00:00Z" }));
  vi.stubGlobal("fetch", fetchMock);
  let notify!: (entries: Array<{ isIntersecting: boolean }>) => void;
  const observeSpy = vi.fn();
  const disconnectSpy = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      notify = callback;
    }
    observe = observeSpy;
    disconnect = disconnectSpy;
  });
  const container = inlineContainer();
  mountTag({ "data-widget-key": "fixture-key", "data-inline-target": "#profile-chat" });
  expect(observeSpy).toHaveBeenCalledWith(container);
  expect(container.textContent).toBe("The chat opens here.");
  notify([{ isIntersecting: false }]);
  expect(fetchMock).not.toHaveBeenCalled();
  notify([{ isIntersecting: true }]);
  expect(disconnectSpy).toHaveBeenCalled();
  expect(container.querySelector("iframe")!.getAttribute("src")).toBe("https://admin.example.test/embed/fixture-key?color=%230f766e");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("waits for the chat's element when the snippet runs before the page is read", () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ token: "fixture-session" })));
  vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
  mountTag({ "data-widget-key": "fixture-key", "data-inline-target": "#profile-chat" });
  expect(document.querySelector(".lobby-widget-bubble")).toBeNull();
  const container = inlineContainer();
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(container.querySelector("iframe")).not.toBeNull();
  expect(document.querySelector(".lobby-widget-bubble")).toBeNull();
});

it("gives the chat a bubble when the page has no element for it", () => {
  mountTag({ "data-widget-key": "fixture-key", "data-inline-target": "#missing" });
  expect(bubble()).not.toBeNull();
  document.body.innerHTML = "";
  mountTag({ "data-widget-key": "fixture-key", "data-inline-target": "[not a selector" });
  expect(bubble()).not.toBeNull();
});
