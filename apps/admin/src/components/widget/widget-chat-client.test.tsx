// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en", changeLanguage: vi.fn() }, t: (key: string, options?: { id?: string }) => (options?.id ? `${key} ${options.id}` : key) }) }));
vi.mock("@lobbystack/web-voice", () => ({ useWebVoiceCall: vi.fn() }));

import { useWebVoiceCall } from "@lobbystack/web-voice";
import { readableOn, WidgetChatClient } from "./widget-chat-client";

const visitorId = "5ef3b4ef-720d-47a7-8320-e6f4707a64e2";
const config = { key: "widget-key", business: { id: "business", name: "Acme", defaultLocale: "en" }, config: {}, billing: { chatAllowed: true, plan: "starter" }, snapshotPresent: true };
const visitorMessage = { id: "m1", role: "user", content: "Can someone call me?" };
const teamReply = { id: "m2", role: "assistant", content: "Sure, I will call you in five minutes." };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("widget chat after a team member takes over", () => {
  it("shows the banner from history and picks up the team's reply without a reload", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Element.prototype.scrollTo = () => {};
    const history = vi.fn()
      .mockResolvedValueOnce({ automationState: "human_handoff", messages: [visitorMessage] })
      .mockResolvedValue({ automationState: "human_handoff", messages: [visitorMessage, teamReply] });
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).includes("/api/widget/history") ? Response.json(await history()) : Response.json(config)));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><WidgetChatClient widgetKey="widget-key" /></QueryClientProvider>);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://business.test", data: { type: "session", token: "token", parentOrigin: "https://business.test", visitorId } }));
    });

    expect(await screen.findByText("chat.handoffBanner")).toBeTruthy();
    expect(screen.queryByText(teamReply.content)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(45_000);
    });
    expect(await screen.findByText(teamReply.content)).toBeTruthy();
    client.clear();
  });
});

describe("widget voice captions", () => {
  it("shows both sides of a live voice call in the chat thread and asks the loader to warn before leaving", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const postMessage = vi.spyOn(window, "postMessage");
    Element.prototype.scrollTo = () => {};
    vi.mocked(useWebVoiceCall).mockReturnValue({
      status: "connected",
      errorKey: null,
      remoteAudioRef: { current: null },
      transcript: [
        { speaker: "assistant", text: "Hi, how can I help?" },
        { speaker: "caller", text: " Are you open Sunday?" },
      ],
      startCall: vi.fn(),
      endCall: vi.fn(),
    } as unknown as ReturnType<typeof useWebVoiceCall>);
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).includes("/api/widget/history") ? Response.json({ messages: [] }) : Response.json({ ...config, businessSlug: "acme", voiceEnabled: true })));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><WidgetChatClient widgetKey="widget-key" /></QueryClientProvider>);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://business.test", data: { type: "session", token: "token", parentOrigin: "https://business.test", visitorId } }));
    });

    expect(await screen.findByText("Hi, how can I help?")).toBeTruthy();
    expect(screen.getByText("Are you open Sunday?")).toBeTruthy();
    expect(screen.getByText("chat.voiceLive")).toBeTruthy();
    expect(screen.getByRole("button", { name: "chat.voiceEnd" })).toBeTruthy();
    expect(postMessage).toHaveBeenCalledWith({ type: "leave-warning", enabled: true }, "*");
    postMessage.mockRestore();
    client.clear();
  });
});

describe("widget composer", () => {
  it("puts the details button on its own row under the message box and shows the start of the visitor id", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Element.prototype.scrollTo = () => {};
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).includes("/api/widget/history") ? Response.json({ messages: [visitorMessage, teamReply] }) : Response.json({ ...config, config: { leadForm: { enabled: true } } })));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><WidgetChatClient widgetKey="widget-key" /></QueryClientProvider>);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://business.test", data: { type: "session", token: "token", parentOrigin: "https://business.test", visitorId } }));
    });

    const details = await screen.findByRole("button", { name: "chat.leaveDetails" });
    const composer = screen.getByRole("textbox", { name: "chat.composerPlaceholder" });
    const send = screen.getByRole("button", { name: "chat.send" });
    // The message box and send button share the first row; the details button sits in the row below.
    expect(composer.parentElement).toBe(send.parentElement);
    expect(composer.parentElement?.contains(details)).toBe(false);
    expect(composer.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("chat.visitorId 5ef3b4ef")).toBeTruthy();
    expect(screen.queryByText(visitorId)).toBeNull();
    client.clear();
  });
});

describe("widget call button", () => {
  it("shows a full-width Say Allo! button under the business name", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Element.prototype.scrollTo = () => {};
    const startCall = vi.fn();
    vi.mocked(useWebVoiceCall).mockReturnValue({
      status: "idle",
      errorKey: null,
      remoteAudioRef: { current: null },
      transcript: [],
      startCall,
      endCall: vi.fn(),
    } as unknown as ReturnType<typeof useWebVoiceCall>);
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).includes("/api/widget/history") ? Response.json({ messages: [] }) : Response.json({ ...config, businessSlug: "acme", voiceEnabled: true })));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><WidgetChatClient widgetKey="widget-key" /></QueryClientProvider>);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://business.test", data: { type: "session", token: "token", parentOrigin: "https://business.test", visitorId } }));
    });

    const call = await screen.findByRole("button", { name: "chat.voiceStart" });
    // Its own row in the header, after the row with the business name, as wide as the chat.
    const header = call.closest("header");
    expect(call.parentElement).toBe(header);
    expect(header?.querySelector("p")?.textContent).toBe("Acme");
    expect(call.className).toContain("w-full");
    expect(call.getAttribute("title")).toBe("chat.voiceButton");
    fireEvent.click(call);
    expect(startCall).toHaveBeenCalledTimes(1);
    client.clear();
  });
});

describe("widget loading state", () => {
  it("draws the chat in the loader's color with placeholders until the settings arrive", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Element.prototype.scrollTo = () => {};
    vi.mocked(useWebVoiceCall).mockReturnValue({ status: "idle", errorKey: null, remoteAudioRef: { current: null }, transcript: [], startCall: vi.fn(), endCall: vi.fn() } as unknown as ReturnType<typeof useWebVoiceCall>);
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((url: URL | string) => String(url).includes("/api/widget/history")
      ? Promise.resolve(Response.json({ messages: [] }))
      : new Promise<Response>((resolve) => { answer = resolve; })));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><WidgetChatClient widgetKey="widget-key" initialColor="#ffd100" /></QueryClientProvider>);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://business.test", data: { type: "session", token: "token", parentOrigin: "https://business.test", visitorId } }));
    });

    const send = screen.getByRole("button", { name: "chat.send" });
    expect(send.style.backgroundColor).toBe("rgb(255, 209, 0)");
    expect(screen.getByRole("status").textContent).toContain("chat.loadingTranscript");
    // Placeholders stand in for the name and the call button.
    expect(container.querySelectorAll("header .animate-pulse")).toHaveLength(2);

    await act(async () => {
      answer(Response.json({ ...config, config: { color: "#ffd100" }, businessSlug: "acme", voiceEnabled: true }));
    });
    expect(await screen.findByText("chat.voiceStart")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(send.style.backgroundColor).toBe("rgb(255, 209, 0)");
    client.clear();
  });

  it("puts dark text on light widget colors and white text on dark ones", () => {
    expect(readableOn("#ffd100")).toBe("#18181b");
    expect(readableOn("#fff")).toBe("#18181b");
    expect(readableOn("#0f766e")).toBe("#ffffff");
    expect(readableOn("#7c3aed")).toBe("#ffffff");
  });
});
