// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messagesEn from "../../public/locales/en/messages.json";
import receptionistsEn from "../../public/locales/en/receptionists.json";
import { LiveMessagesSurface } from "./live-messages-surface";
import { receptionistChoicesQueryKey, type ReceptionistOption } from "./receptionists/receptionist-choices";
import { testNavigation } from "@/lib/navigation-testing";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => createRecordedBrowserTelemetry().telemetry }));
vi.mock("@/lib/realtime-query", () => ({ subscribeRealtimeQuery: () => () => {} }));
vi.mock("next/navigation", async () => (await import("@/lib/navigation-testing")).nextNavigationMock);

const clients: QueryClient[] = [];
beforeEach(() => {
  testNavigation.reset("/messages");
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
});
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}
const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all" });
const KITSILANO = receptionist("00000000-0000-4000-8000-0000000000a2", "Kitsilano clinic", { sortOrder: 1 });

/** A conversation's latest message, as the list and its thread return it, with the receptionist that answered. */
const row = (conversationId: string, contactName: string, body: string, answeredBy: ReceptionistOption, archivedAt: string | null = null) => ({ id: `m-${conversationId}`, conversationId, contactName, contactPhone: "+14155550100", visitorName: null, visitorEmail: null, channel: "sms", conversationStatus: "open", automationState: "ai_active", teamRequestedAt: null, archivedAt, receptionistId: answeredBy.id, receptionistName: answeredBy.name, messageChannel: "sms", body, direction: "inbound", status: "received", createdAt: "2026-10-30T12:00:00Z" });
const ADA = row("conversation-1", "Ada Caller", "Can you call me back?", FRONT_DESK);
const BEA = row("conversation-2", "Bea Texter", "Are you open on Sunday?", KITSILANO);
const CY = row("conversation-3", "Cy Archived", "Thanks, all sorted.", KITSILANO, "2026-10-30T18:30:00Z");

/**
 * Shows the inbox as the server would: ?receptionist=<id> keeps the
 * conversations that receptionist answered, ?archived=true the archived ones.
 */
async function setup({ receptionists = [FRONT_DESK, KITSILANO] }: { receptionists?: ReceptionistOption[] } = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", defaultNS: "messages", resources: { en: { messages: messagesEn, receptionists: receptionistsEn } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Clinic", slug: "clinic", role: "business_owner", active: true }] });
  client.setQueryData(receptionistChoicesQueryKey("business"), { receptionists });
  const fetchMock = vi.fn(async (url: string) => {
    const params = new URL(url, "http://admin.test").searchParams;
    const conversationId = params.get("conversationId");
    if (conversationId) return Response.json({ messages: [ADA, BEA, CY].filter((message) => message.conversationId === conversationId), newerConversationId: null, smsReplyHold: null });
    const archived = params.get("archived") === "true";
    const answeredBy = params.get("receptionist");
    return Response.json({ messages: [ADA, BEA, CY].filter((message) => (message.archivedAt !== null) === archived && (!answeredBy || message.receptionistId === answeredBy)), hasNext: false });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><LiveMessagesSurface /></QueryClientProvider></I18nextProvider>);
  const listUrls = () => fetchMock.mock.calls.map(([url]) => url).filter((url) => url.startsWith("/api/messages?limit="));
  return { fetchMock, listUrls };
}

const filter = () => screen.getByRole("combobox", { name: /^Receptionist/ });

describe("messages with several receptionists", () => {
  it("names the receptionist that answered each conversation in the list", async () => {
    await setup();
    expect((await screen.findByRole("button", { name: /Ada Caller/ })).textContent).toContain("Front desk");
    expect(screen.getByRole("button", { name: /Bea Texter/ }).textContent).toContain("Kitsilano clinic");
  });

  it("filters the list to one receptionist, keeping the filter in the address", async () => {
    const { listUrls } = await setup();
    await screen.findByRole("button", { name: /Ada Caller/ });
    expect(filter().textContent).toContain("All receptionists");

    await userEvent.click(filter());
    await userEvent.click(screen.getByRole("option", { name: /Kitsilano clinic/ }));

    expect(testNavigation.router.replace).toHaveBeenLastCalledWith(`/messages?receptionist=${KITSILANO.id}`, { scroll: false });
    await waitFor(() => expect(listUrls()).toContain(`/api/messages?limit=50&offset=0&channel=all&search=&receptionist=${KITSILANO.id}`));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Ada Caller/ })).toBeNull());
    // Every conversation left is the filtered receptionist's, so the rows don't repeat its name.
    expect(screen.getByRole("button", { name: /Bea Texter/ }).textContent).not.toContain("Kitsilano clinic");
    expect(filter().textContent).toContain("Kitsilano clinic");
  });

  it("asks for the receptionist the address names when the page opens, as after a reload or from a shared link", async () => {
    testNavigation.set(`/messages?receptionist=${KITSILANO.id}`);
    const { listUrls } = await setup();
    await screen.findByRole("button", { name: /Bea Texter/ });
    expect(listUrls()).toEqual([`/api/messages?limit=50&offset=0&channel=all&search=&receptionist=${KITSILANO.id}`]);
    expect(screen.queryByRole("button", { name: /Ada Caller/ })).toBeNull();
  });

  it("keeps the receptionist filter on Archived", async () => {
    testNavigation.set(`/messages?receptionist=${KITSILANO.id}`);
    const { listUrls } = await setup();
    await screen.findByRole("button", { name: /Bea Texter/ });
    await userEvent.click(screen.getByRole("button", { name: messagesEn.page.filterArchived }));
    await waitFor(() => expect(listUrls()).toContain(`/api/messages?limit=50&offset=0&channel=all&search=&archived=true&receptionist=${KITSILANO.id}`));
    expect(await screen.findByRole("button", { name: /Cy Archived/ })).toBeTruthy();
  });

  it("says in the open conversation which receptionist answered it", async () => {
    await setup();
    await userEvent.click(await screen.findByRole("button", { name: /Bea Texter/ }));
    // The list shows the latest message too, above the thread's.
    await waitFor(() => expect(screen.getAllByText(BEA.body)).toHaveLength(2));
    expect(screen.getByText("Receptionist: Kitsilano clinic")).toBeTruthy();
  });

  it("clears the filter from All receptionists, back to every conversation", async () => {
    testNavigation.set(`/messages?receptionist=${KITSILANO.id}`);
    const { listUrls } = await setup();
    await screen.findByRole("button", { name: /Bea Texter/ });
    await userEvent.click(filter());
    await userEvent.click(screen.getByRole("option", { name: /All receptionists/ }));
    expect(testNavigation.router.replace).toHaveBeenLastCalledWith("/messages", { scroll: false });
    expect(await screen.findByRole("button", { name: /Ada Caller/ })).toBeTruthy();
    expect(listUrls().at(-1)).toBe("/api/messages?limit=50&offset=0&channel=all&search=");
  });
});

describe("messages with one receptionist", () => {
  it("look as they did before receptionists: no filter, no names", async () => {
    await setup({ receptionists: [FRONT_DESK] });
    const ada = await screen.findByRole("button", { name: /Ada Caller/ });
    expect(ada.textContent).not.toContain("Front desk");
    expect(screen.queryByRole("combobox")).toBeNull();

    await userEvent.click(ada);
    await waitFor(() => expect(screen.getAllByText(ADA.body)).toHaveLength(2));
    expect(screen.queryByText(/^Receptionist:/)).toBeNull();
    expect(within(screen.getByRole("button", { name: /Bea Texter/ })).queryByText("Kitsilano clinic")).toBeNull();
  });
});
