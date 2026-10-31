// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../public/locales/en/messages.json";
import { LiveMessagesSurface } from "./live-messages-surface";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => createRecordedBrowserTelemetry().telemetry }));
vi.mock("@/lib/realtime-query", () => ({ subscribeRealtimeQuery: () => () => {} }));

const copy = en.page.archive;
const clients: QueryClient[] = [];
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() }); });
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });

const ARCHIVED_AT = "2026-10-30T18:30:00Z";

/** A conversation's latest message, as the list and its thread return it. */
const row = (conversationId: string, contactName: string, body: string) => ({ id: `m-${conversationId}`, conversationId, contactName, contactPhone: "+14155550100", visitorName: null, visitorEmail: null, channel: "sms", conversationStatus: "open", automationState: "ai_active", teamRequestedAt: null, messageChannel: "sms", body, direction: "inbound", status: "received", createdAt: "2026-10-30T12:00:00Z" });
const conversations = [row("conversation-1", "Ada Caller", "Can you call me back?"), row("conversation-2", "Bea Texter", "Thanks, see you Friday.")];

/**
 * Shows the inbox as the server would: archiving or restoring moves a
 * conversation between the list and Archived, unless `response` answers the
 * change instead. `archived` names the conversations archived to begin with.
 */
async function setup({ role = "business_owner", archived = [] as string[], response = undefined as Response | undefined } = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", defaultNS: "messages", resources: { en: { messages: en } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Clinic", slug: "clinic", role, active: true }] });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const archivedIds = new Set(archived);
  const withArchive = (message: ReturnType<typeof row>) => ({ ...message, archivedAt: archivedIds.has(message.conversationId) ? ARCHIVED_AT : null });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      if (response) return response;
      const { conversationId, action } = JSON.parse(String(init.body)) as { conversationId: string; action: string };
      if (action === "archive") archivedIds.add(conversationId); else archivedIds.delete(conversationId);
      return Response.json({ archivedAt: action === "archive" ? ARCHIVED_AT : null });
    }
    const params = new URL(url, "http://admin.test").searchParams;
    const conversationId = params.get("conversationId");
    if (conversationId) return Response.json({ messages: conversations.filter((message) => message.conversationId === conversationId).map(withArchive), newerConversationId: null, smsReplyHold: null });
    const listArchived = params.get("archived") === "true";
    return Response.json({ messages: conversations.filter((message) => archivedIds.has(message.conversationId) === listArchived).map(withArchive), hasNext: false });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><LiveMessagesSurface /></QueryClientProvider></I18nextProvider>);
  const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  return { fetchMock, invalidate, patches };
}

/** Opens a conversation from the list and waits for its thread. */
async function open(contactName: string, body: string) {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(contactName) }));
  // The list shows the latest message too, above the thread's.
  await waitFor(() => expect(screen.getAllByText(body)).toHaveLength(2));
}

describe("archiving a conversation", () => {
  it("asks in a modal dialog first, and keeps the conversation when the operator cancels", async () => {
    const { patches } = await setup();
    await open("Ada Caller", "Can you call me back?");
    await userEvent.click(screen.getByRole("button", { name: copy.action }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(copy.title)).toBeTruthy();
    expect(within(dialog).getByText(copy.description)).toBeTruthy();
    expect(patches()).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: copy.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(patches()).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
    // Still open, and still in the list.
    expect(screen.getByRole("button", { name: copy.action })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ada Caller/ })).toBeTruthy();
  });

  it("doesn't archive when the operator presses Escape", async () => {
    const { patches } = await setup();
    await open("Ada Caller", "Can you call me back?");
    await userEvent.click(screen.getByRole("button", { name: copy.action }));
    await screen.findByRole("alertdialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(patches()).toHaveLength(0);
  });

  it("archives once the operator confirms: the conversation leaves the list and its thread closes", async () => {
    const { invalidate, patches } = await setup();
    await open("Ada Caller", "Can you call me back?");
    await userEvent.click(screen.getByRole("button", { name: copy.action }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: copy.confirm }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(copy.done));
    expect(patches()).toEqual([["/api/messages?businessId=business", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ conversationId: "conversation-1", action: "archive" }) })]]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Ada Caller/ })).toBeNull());
    expect(screen.getByRole("button", { name: /Bea Texter/ })).toBeTruthy();
    expect(screen.getByText(en.page.selectConversation)).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["messages", "business"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("keeps the dialog open and says so when archiving fails", async () => {
    const { patches } = await setup({ response: Response.json({ error: "Request failed." }, { status: 500 }) });
    await open("Ada Caller", "Can you call me back?");
    await userEvent.click(screen.getByRole("button", { name: copy.action }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: copy.confirm }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.failed));
    expect(patches()).toHaveLength(1);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    // Still in the list, which the open dialog hides from assistive technology.
    expect(screen.getByRole("button", { name: /Ada Caller/, hidden: true })).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each(["scheduler", "viewer"])("isn't offered to a %s, since only owners and admins can archive", async (role) => {
    await setup({ role });
    await open("Ada Caller", "Can you call me back?");
    expect(screen.queryByRole("button", { name: copy.action })).toBeNull();
  });

  it("is offered to an admin", async () => {
    await setup({ role: "business_admin" });
    await open("Ada Caller", "Can you call me back?");
    expect(screen.getByRole("button", { name: copy.action })).toBeTruthy();
  });
});

describe("archived conversations", () => {
  it("are listed under Archived, say since when, and Restore puts one back in the list", async () => {
    const { fetchMock, invalidate, patches } = await setup({ archived: ["conversation-1"] });
    await screen.findByRole("button", { name: /Bea Texter/ });
    expect(screen.queryByRole("button", { name: /Ada Caller/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: en.page.filterArchived }));
    await open("Ada Caller", "Can you call me back?");
    expect(fetchMock).toHaveBeenCalledWith("/api/messages?limit=50&offset=0&channel=all&search=&archived=true", expect.anything());
    expect(screen.queryByRole("button", { name: /Bea Texter/ })).toBeNull();
    expect(screen.getByText("Archived on Oct 30, 2026. A new message brings it back.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.action })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: copy.restore }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(copy.restored));
    expect(patches()).toEqual([["/api/messages?businessId=business", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ conversationId: "conversation-1", action: "restore" }) })]]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.getByText(copy.empty)).toBeTruthy());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["messages", "business"] });

    await userEvent.click(screen.getByRole("button", { name: en.page.filterAll }));
    expect(await screen.findByRole("button", { name: /Ada Caller/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Bea Texter/ })).toBeTruthy();
  });

  it("says so when there are none", async () => {
    await setup();
    await screen.findByRole("button", { name: /Ada Caller/ });
    await userEvent.click(screen.getByRole("button", { name: en.page.filterArchived }));
    expect(await screen.findByText(copy.empty)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ada Caller/ })).toBeNull();
  });

  it("can be read by a scheduler, who can't restore them", async () => {
    await setup({ role: "scheduler", archived: ["conversation-1"] });
    await screen.findByRole("button", { name: /Bea Texter/ });
    await userEvent.click(screen.getByRole("button", { name: en.page.filterArchived }));
    await open("Ada Caller", "Can you call me back?");
    expect(screen.getByText("Archived on Oct 30, 2026. A new message brings it back.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.restore })).toBeNull();
  });
});
