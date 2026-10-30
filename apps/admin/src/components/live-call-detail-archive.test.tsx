// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../public/locales/en/calls.json";
import { LiveCallDetailSurface } from "./live-call-detail-surface";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/calls/call-1" }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => createRecordedBrowserTelemetry().telemetry }));
vi.mock("@/lib/realtime-query", () => ({ subscribeRealtimeQuery: () => () => {} }));

const copy = en.detail.archive;
const clients: QueryClient[] = [];
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() }); });
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });

const detail = (archivedAt: string | null) => ({
  call: { id: "call-1", legacyConvexId: null, providerCallId: "rtc_1", provider: "openai_live", transport: "web_voice", status: "completed", disposition: null, transferState: null, startedAt: "2026-10-29T23:09:00Z", endedAt: "2026-10-29T23:09:15Z", providerDurationSeconds: 15, gatewaySessionId: null, archivedAt },
  contact: null,
  outcome: null,
  timeline: [],
  transcript: [{ id: "line-1", sequence: 1, speaker: "assistant", text: "Thank you for calling.", confidence: null, final: true, createdAt: "2026-10-29T23:09:01Z" }],
  recording: { state: "missing" },
  appointments: [],
  followUpTasks: [],
});

async function setup({ role = "business_owner", archivedAt = null as string | null, response = undefined as Response | undefined } = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", defaultNS: "calls", resources: { en: { calls: en } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Clinic", slug: "clinic", role, active: true }] });
  // The Calls list as it was cached before the operator opened the call.
  client.setQueryData(["calls", "business", "", 0, 10], { calls: [{ id: "call-1" }, { id: "call-2" }], pagination: { total: 2 } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return response ?? Response.json({ archivedAt: JSON.parse(String(init.body)).action === "archive" ? "2026-10-30T06:30:00Z" : null });
    return Response.json(detail(archivedAt));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><LiveCallDetailSurface callId="call-1" /></QueryClientProvider></I18nextProvider>);
  await screen.findByText("Thank you for calling.");
  const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  return { client, fetchMock, invalidate, patches };
}

describe("archiving a call", () => {
  it("asks in a modal dialog first, and keeps the call when the operator cancels", async () => {
    const { patches } = await setup();
    await userEvent.click(screen.getByRole("button", { name: copy.action }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(copy.title)).toBeTruthy();
    expect(within(dialog).getByText(copy.description)).toBeTruthy();
    expect(patches()).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: copy.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(patches()).toHaveLength(0);
    expect(router.push).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // Still on the call, which can be archived later.
    expect(screen.getByRole("button", { name: copy.action })).toBeTruthy();
  });

  it("doesn't archive when the operator presses Escape", async () => {
    const { patches } = await setup();
    await userEvent.click(screen.getByRole("button", { name: copy.action }));
    await screen.findByRole("alertdialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(patches()).toHaveLength(0);
  });

  it("archives once the operator confirms, then goes back to the Calls list without the call", async () => {
    const { client, invalidate, patches } = await setup();
    await userEvent.click(screen.getByRole("button", { name: copy.action }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: copy.confirm }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/calls"));
    expect(patches()).toEqual([["/api/calls/call-1?businessId=business", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "archive" }) })]]);
    expect(toast.success).toHaveBeenCalledWith(copy.done);
    expect(client.getQueryData<{ calls: Array<{ id: string }> }>(["calls", "business", "", 0, 10])?.calls.map((row) => row.id)).toEqual(["call-2"]);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["calls", "business"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["call", "business", "call-1"] });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("keeps the dialog open and says so when archiving fails", async () => {
    const { client, patches } = await setup({ response: Response.json({ error: "Request failed." }, { status: 500 }) });
    await userEvent.click(screen.getByRole("button", { name: copy.action }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: copy.confirm }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.failed));
    expect(patches()).toHaveLength(1);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    expect(client.getQueryData<{ calls: Array<{ id: string }> }>(["calls", "business", "", 0, 10])?.calls).toHaveLength(2);
  });

  it.each(["scheduler", "viewer"])("isn't offered to a %s, since only owners and admins can archive", async (role) => {
    await setup({ role });
    expect(screen.queryByRole("button", { name: copy.action })).toBeNull();
  });

  it("is offered to an admin", async () => {
    await setup({ role: "business_admin" });
    expect(screen.getByRole("button", { name: copy.action })).toBeTruthy();
  });
});

describe("an archived call", () => {
  it("says it's archived and since when, and restores it without leaving the page", async () => {
    const { invalidate, patches } = await setup({ archivedAt: "2026-10-30T06:30:00Z" });
    expect(screen.getByText(copy.badge)).toBeTruthy();
    expect(screen.getByText(/^Archived on Oct 30, 2026/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.action })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: copy.restore }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(copy.restored));
    expect(patches()).toEqual([["/api/calls/call-1?businessId=business", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "restore" }) })]]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["call", "business", "call-1"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["calls", "business"] });
  });

  it("keeps its transcript", async () => {
    await setup({ archivedAt: "2026-10-30T06:30:00Z" });
    expect(screen.getByText("Thank you for calling.")).toBeTruthy();
  });
});
