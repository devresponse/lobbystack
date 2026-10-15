// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "fr", resolvedLanguage: "fr" }, t: (key: string, options?: { date?: string }) => options?.date ? `${key}:${options.date}` : key }) }));
vi.mock("./live-notification-settings-surface", () => ({ LiveNotificationSettingsSurface: () => null }));

import { LiveWidgetSettingsSurface } from "./live-widget-settings-surface";

const clients: QueryClient[] = [];

function setup(issuanceEnabled: boolean, keys: Array<Record<string, unknown>> = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Acme", active: true }] });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/billing")) return Response.json({ account: { plan: "starter" }, widgetIssuanceEnabled: issuanceEnabled });
    if (url.includes("/api/widget-keys") && init?.method === "POST") return Response.json({ ok: true, key: { id: "created", key: "wk_live_created" } });
    if (url.includes("/api/widget-keys") && init?.method === "PATCH") return Response.json({ ok: true });
    if (url.includes("/api/widget-keys")) return Response.json({ keys });
    return Response.json({ businesses: [{ businessId: "business", name: "Acme", active: true }] });
  }));
  render(<QueryClientProvider client={client}><LiveWidgetSettingsSurface /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  clients.forEach(client => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

describe("website widget issuance restriction", () => {
  it("shows the restricted notice and hides the create form when issuance is disabled", async () => {
    setup(false);
    expect(await screen.findByText("widget.restricted.title")).toBeTruthy();
    expect(screen.queryByText("widget.create.action")).toBeNull();
    expect(screen.queryByText(/sessions per month/)).toBeNull();
  });

  it("offers the create form once an operator enables issuance", async () => {
    setup(true);
    expect(await screen.findByText("widget.create.action")).toBeTruthy();
    expect(screen.queryByText("widget.restricted.title")).toBeNull();
  });

  it("starts the form over after creating a key and shows the key's snippet", async () => {
    setup(true);
    const origins = await screen.findByPlaceholderText("https://example.com, https://www.example.com");
    fireEvent.change(origins, { target: { value: "https://shop.example" } });
    fireEvent.change(screen.getByPlaceholderText("widget.fields.titlePlaceholder"), { target: { value: "Ask the shop" } });
    fireEvent.change(screen.getByDisplayValue("widget.positions.bottomRight"), { target: { value: "bottom-left" } });
    fireEvent.click(screen.getByText("widget.create.action"));
    expect(await screen.findByText("widget.created.title")).toBeTruthy();
    expect(screen.getByText(/embed\.js\?key=wk_live_created" data-widget-key="wk_live_created"/)).toBeTruthy();
    expect((screen.getByPlaceholderText("widget.fields.titlePlaceholder") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByDisplayValue("widget.positions.bottomRight").length).toBe(1);
  });

  it("confirms a saved key and says when its look reaches the website", async () => {
    setup(true, [{ id: "widget", label: "Website", status: "active", allowedOrigins: ["https://a.com"], config: {}, lastUsedAt: null, createdAt: "2026-09-23T12:00:00.000Z" }]);
    expect(await screen.findByText("widget.keys.appearanceHint")).toBeTruthy();
    expect(screen.queryByText("widget.keys.saved")).toBeNull();
    fireEvent.click(screen.getByText("widget.keys.save"));
    expect(await screen.findByText("widget.keys.saved")).toBeTruthy();
  });

  it("shows and copies a saved key's snippet at any time", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    setup(true, [{ id: "widget", key: "wk_live_saved", label: "Website", status: "active", allowedOrigins: ["https://a.com"], config: {}, lastUsedAt: null, createdAt: "2026-09-23T12:00:00.000Z" }]);
    const snippet = `<script src="${window.location.origin}/embed.js?key=wk_live_saved" data-widget-key="wk_live_saved" defer></script>`;
    expect(await screen.findByText(snippet)).toBeTruthy();
    fireEvent.click(screen.getByText("widget.created.copySnippet"));
    expect(writeText).toHaveBeenCalledWith(snippet);
    expect(await screen.findByText("widget.keys.snippetCopied")).toBeTruthy();
  });

  it("explains why an older key has no snippet, and shows none for a revoked key", async () => {
    setup(true, [
      { id: "older", key: null, label: "Older", status: "active", allowedOrigins: ["https://a.com"], config: {}, lastUsedAt: null, createdAt: "2026-09-23T12:00:00.000Z" },
      { id: "revoked", key: null, label: "Gone", status: "revoked", allowedOrigins: ["https://b.com"], config: {}, lastUsedAt: null, createdAt: "2026-09-22T12:00:00.000Z" },
    ]);
    expect(await screen.findByText("widget.keys.noSnippet")).toBeTruthy();
    expect(screen.getAllByText("widget.keys.noSnippet")).toHaveLength(1);
    expect(screen.queryByText("widget.created.copySnippet")).toBeNull();
  });

  it("formats the last-used date with the active dashboard locale", async () => {
    const lastUsedAt = "2026-09-23T12:00:00.000Z";
    setup(true, [{ id: "widget", label: "Website", status: "active", allowedOrigins: ["https://example.com"], config: {}, lastUsedAt, createdAt: lastUsedAt }]);
    const expected = new Intl.DateTimeFormat("fr", { dateStyle: "medium" }).format(new Date(lastUsedAt));
    expect(await screen.findByText(`widget.keys.lastUsed:${expected}`)).toBeTruthy();
  });

  it("turns live chat with the team on for a new key and for a saved one", async () => {
    setup(true, [{ id: "widget", label: "Website", status: "active", allowedOrigins: ["https://a.com"], config: { liveChat: { enabled: false } }, lastUsedAt: null, createdAt: "2026-09-23T12:00:00.000Z" }]);
    const [newKey, savedKey] = await screen.findAllByRole("checkbox", { name: /^widget\.fields\.liveChat/ });
    expect((savedKey as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByPlaceholderText("https://example.com, https://www.example.com"), { target: { value: "https://shop.example" } });
    fireEvent.click(newKey!);
    fireEvent.click(screen.getByText("widget.create.action"));
    fireEvent.click(savedKey!);
    fireEvent.click(screen.getByText("widget.keys.save"));

    const fetchMock = vi.mocked(fetch);
    const sent = (method: string) => fetchMock.mock.calls.find(([, init]) => init?.method === method);
    await waitFor(() => expect(sent("POST") && sent("PATCH")).toBeTruthy());
    expect(JSON.parse(sent("POST")![1]!.body as string).config.liveChat).toEqual({ enabled: true });
    expect(JSON.parse(sent("PATCH")![1]!.body as string).config.liveChat).toEqual({ enabled: true });
  });

  it("keeps every saved origin separate when the operator adds another and saves", async () => {
    setup(true, [{ id: "widget", label: "Website", status: "active", allowedOrigins: ["https://a.com", "https://b.com"], config: {}, lastUsedAt: null, createdAt: "2026-09-23T12:00:00.000Z" }]);
    const field = await screen.findByDisplayValue(/a\.com/);
    fireEvent.change(field, { target: { value: `${(field as HTMLInputElement).value}, https://c.com` } });
    fireEvent.click(screen.getByText("widget.keys.save"));
    const fetchMock = vi.mocked(fetch);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(init!.body as string).allowedOrigins).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
  });
});
