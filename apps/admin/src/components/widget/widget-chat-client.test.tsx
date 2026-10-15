// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en", changeLanguage: vi.fn() }, t: (key: string, options?: { id?: string; name?: string }) => [key, options?.id, options?.name].filter(Boolean).join(" ") }) }));
vi.mock("@lobbystack/web-voice", () => ({ useWebVoiceCall: vi.fn() }));

import { useWebVoiceCall } from "@lobbystack/web-voice";
import { readableOn, threadEntries, WidgetChatClient } from "./widget-chat-client";

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

describe("widget live chat with the team", () => {
  function openChat(historyPayload: object) {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Element.prototype.scrollTo = () => {};
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).includes("/api/widget/history") ? Response.json(historyPayload) : Response.json(config)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><WidgetChatClient widgetKey="widget-key" /></QueryClientProvider>);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://business.test", data: { type: "session", token: "token", parentOrigin: "https://business.test", visitorId } }));
    });
    return client;
  }

  it("tells a visitor who asked for a person that the team was asked to join", async () => {
    const client = openChat({ automationState: "human_handoff", waitingForTeam: true, teamMemberName: null, messages: [visitorMessage, { id: "m2", role: "assistant", content: "I've let the team know." }] });

    expect(await screen.findByText("chat.waitingForTeam")).toBeTruthy();
    expect(screen.queryByText("chat.handoffBanner")).toBeNull();
    expect(screen.queryByText(/chat\.teamJoined/)).toBeNull();
    client.clear();
  });

  it("shows who from the team joined, with their name on their messages", async () => {
    const client = openChat({
      automationState: "human_handoff",
      waitingForTeam: false,
      teamMemberName: "Yuri",
      messages: [
        visitorMessage,
        { id: "m2", role: "assistant", content: "I've let the team know." },
        { id: "m3", role: "assistant", content: "Hi, this is Yuri.", fromTeam: true, teamMemberName: "Yuri" },
        { id: "m4", role: "assistant", content: "How can I help?", fromTeam: true, teamMemberName: "Yuri" },
        { id: "m5", role: "user", content: "About my invoice." },
        { id: "m6", role: "assistant", content: "Let me check.", fromTeam: true, teamMemberName: "Yuri" },
      ],
    });

    expect(await screen.findByText("chat.teamMemberInChat Yuri")).toBeTruthy();
    expect(screen.getAllByText("chat.teamJoined Yuri")).toHaveLength(1);
    // Once above each run of Yuri's messages.
    expect(screen.getAllByText("Yuri")).toHaveLength(2);
    expect(screen.queryByText("chat.handoffBanner")).toBeNull();
    client.clear();
  });
});

describe("threadEntries", () => {
  const text = (id: string, role: "user" | "assistant", content: string, metadata?: { fromTeam: true; teamMemberName: string | null }) => ({ id, role, parts: [{ type: "text" as const, text: content }], ...(metadata ? { metadata } : {}) });

  it("notes each time the team takes the chat from the receptionist, and leaves out empty replies", () => {
    const entries = threadEntries([
      text("1", "user", "Hello"),
      text("2", "assistant", "Hi! How can I help?"),
      text("3", "assistant", "This is the team.", { fromTeam: true, teamMemberName: null }),
      text("4", "user", "Thanks"),
      text("5", "assistant", ""),
      text("6", "assistant", "Back to the receptionist."),
      text("7", "assistant", "Hi again, Yuri here.", { fromTeam: true, teamMemberName: "Yuri" }),
    ], null);

    expect(entries.map((entry) => [entry.message.id, entry.joined, entry.showName, entry.teamMemberName])).toEqual([
      ["1", false, false, null],
      ["2", false, false, null],
      ["3", true, true, null],
      ["4", false, false, null],
      ["6", false, false, null],
      ["7", true, true, "Yuri"],
    ]);
    // A reply still streaming in stays, even before its first words.
    expect(threadEntries([text("1", "user", "Hello"), text("2", "assistant", "")], "2").map((entry) => entry.message.id)).toEqual(["1", "2"]);
  });
});

describe("widget chat live updates", () => {
  it("shows a team member's reply and the take-over banner as soon as the stream reports them", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Element.prototype.scrollTo = () => {};
    const aiReply = { id: "m2", role: "assistant", content: "Let me see who's around." };
    const joined = { id: "m3", role: "assistant", content: "Hi, this is Yuri. How can I help?" };
    const history = vi.fn()
      .mockResolvedValueOnce({ automationState: "ai_active", messages: [visitorMessage, aiReply] })
      .mockResolvedValueOnce({ automationState: "ai_active", messages: [visitorMessage, aiReply] })
      .mockResolvedValue({ automationState: "human_handoff", messages: [visitorMessage, aiReply, joined] });
    const encoder = new TextEncoder();
    let push: (text: string) => void = () => {};
    let end: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({ start(controller) { push = (text) => controller.enqueue(encoder.encode(text)); end = () => controller.close(); } });
    let streamInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init?: RequestInit) => {
      if (String(url).includes("/api/widget/history")) return Response.json(await history());
      if (String(url).includes("/api/widget/stream")) {
        streamInit = init;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json(config);
    }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><WidgetChatClient widgetKey="widget-key" /></QueryClientProvider>);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://business.test", data: { type: "session", token: "token", parentOrigin: "https://business.test", visitorId } }));
    });

    expect(await screen.findByText(aiReply.content)).toBeTruthy();
    // The chat has started, so the widget opens its stream with the session.
    await vi.waitFor(() => expect(streamInit).toBeDefined());
    expect(streamInit?.headers).toMatchObject({ authorization: "Bearer token", "x-widget-parent-origin": "https://business.test" });

    await act(async () => { push("event: ready\ndata: {}\n\n"); });
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(joined.content)).toBeNull();
    expect(screen.queryByText("chat.handoffBanner")).toBeNull();

    await act(async () => { push(": keepalive\n\nevent: message\ndata: {}\n\n"); });
    expect(await screen.findByText(joined.content)).toBeTruthy();
    expect(screen.getByText("chat.handoffBanner")).toBeTruthy();
    expect(history).toHaveBeenCalledTimes(3);
    end();
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

describe("links in chat replies", () => {
  const reply = "Book online at https://acme.example/book. You can also use [our booking page](https://acme.example/book).";
  const expectedLinks = [
    { text: "https://acme.example/book", href: "https://acme.example/book", target: "_blank", rel: "noreferrer noopener" },
    { text: "our booking page", href: "https://acme.example/book", target: "_blank", rel: "noreferrer noopener" },
  ];

  function openChat(respond: (url: string) => Response | undefined) {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    Element.prototype.scrollTo = () => {};
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => respond(String(url)) ?? (String(url).includes("/api/widget/stream") ? new Response(null, { status: 401 }) : Response.json(config))));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><WidgetChatClient widgetKey="widget-key" /></QueryClientProvider>);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://business.test", data: { type: "session", token: "token", parentOrigin: "https://business.test", visitorId } }));
    });
    return client;
  }

  function shownLinks(startsWith: string) {
    const content = [...document.querySelectorAll<HTMLElement>(".widget-message-content")].find((element) => element.textContent?.startsWith(startsWith));
    return content ? [...content.querySelectorAll("a")].map((anchor) => ({ text: anchor.textContent, href: anchor.getAttribute("href"), target: anchor.getAttribute("target"), rel: anchor.getAttribute("rel") })) : [];
  }

  it("turns web addresses in the receptionist's streamed reply into links", async () => {
    const client = openChat((url) => {
      if (url.includes("/api/widget/history")) return Response.json({ automationState: "ai_active", messages: [] });
      if (!url.includes("/api/widget/chat")) return undefined;
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            writer.write({ type: "start", messageId: "a1" });
            writer.write({ type: "text-start", id: "a1" });
            // In pieces, as a model streams it, so links only complete in later pieces.
            for (const delta of reply.match(/.{1,12}/g)!) writer.write({ type: "text-delta", id: "a1", delta });
            writer.write({ type: "text-end", id: "a1" });
            writer.write({ type: "finish", finishReason: "stop" });
          },
        }),
      });
    });

    const composer = await screen.findByRole("textbox", { name: "chat.composerPlaceholder" });
    await vi.waitFor(() => expect((composer as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(composer, { target: { value: "Can I book online?" } });
    await act(async () => { fireEvent.submit(composer.closest("form")!); });

    await vi.waitFor(() => expect(shownLinks("Book online")).toEqual(expectedLinks));
    client.clear();
  });

  it("turns web addresses in a team member's reply into underlined links that wrap", async () => {
    const client = openChat((url) => url.includes("/api/widget/history")
      ? Response.json({ automationState: "human_handoff", teamMemberName: "Yuri", messages: [visitorMessage, { id: "m2", role: "assistant", content: reply, fromTeam: true, teamMemberName: "Yuri" }] })
      : undefined);

    expect(await screen.findByText("chat.teamJoined Yuri")).toBeTruthy();
    expect(shownLinks("Book online")).toEqual(expectedLinks);
    // The base styles take a link's underline away, so the message gives it back.
    const content = screen.getByText("our booking page").closest(".widget-message-content")!;
    expect(content.className).toContain("[&_a]:underline");
    expect(content.closest("div")?.className).toContain("wrap-anywhere");
    client.clear();
  });
});
