// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { SidebarProvider } from "@/components/ui/sidebar";
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const pendingAnalytics = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/workspace-analytics", () => ({ recordPendingWorkspaceSwitch: pendingAnalytics.record }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en-US" }, t: (key: string, options?: Record<string, unknown>) => options ? `${key} ${JSON.stringify(options)}` : key }) }));
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });
function setup(name = "Tim Hortons", loading = false, businessLimit?: { owned: number; max: number; upgrade?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
  const businesses = [{ businessId: "business-1", name, active: true }, { businessId: "business-2", name: "Acme Clinic", active: false }];
  if (!loading) client.setQueryData(["businesses"], { businesses, ...(businessLimit ? { businessLimit } : {}) });
  client.setQueryData(["phone-numbers", "business-1"], { phoneNumbers: [{ e164: "+14155550100", status: "active" }] });
  const fetchMock = vi.fn(async (url: string) => {
    if (loading) return new Promise<Response>(() => {});
    if (url === "/api/businesses/switch") { businesses[0]!.active = false; businesses[1]!.active = true; return Response.json({ ok: true }); }
    if (url === "/api/businesses") return Response.json({ businesses });
    return Response.json({ phoneNumbers: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<QueryClientProvider client={client}><SidebarProvider><WorkspaceSwitcher /></SidebarProvider></QueryClientProvider>);
  return { ...view, client, fetchMock };
}
describe("original workspace switcher behavior", () => {
  it("masks business names in analytics replay", async () => {
    setup();
    expect(screen.getByText("Tim Hortons").className).toContain("ph-mask");
    await userEvent.click(screen.getByRole("button", { name: /Tim Hortons/ }));
    expect((await screen.findByRole("menuitem", { name: /Acme Clinic/ })).querySelector("span.truncate")?.className).toContain("ph-mask");
  });
  it("keeps the workspace phone number out of the switcher", () => {
    const { fetchMock } = setup();
    expect(screen.queryByText("(415) 555-0100")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/phone-numbers"))).toBe(false);
  });
  it("shows the workspace initial beside its name", () => {
    setup("Plomberie Urgence Montréal (PUM)");
    expect(screen.getByText("P")).toBeTruthy();
  });
  it("keeps a long workspace name on one line, left aligned", () => {
    setup("Plomberie Urgence Montréal (PUM)");
    const name = screen.getByText("Plomberie Urgence Montréal (PUM)");
    for (const token of ["w-full", "text-left", "truncate"]) expect(name.className).toContain(token);
  });
  it("shows the original skeleton while workspaces load", () => {
    const { container } = setup("Tim Hortons", true);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("switches the workspace and discards the previous tenant's cached data", async () => {
    const { client, fetchMock } = setup();
    client.setQueryData(["contacts", "business-1"], { private: true });
    await userEvent.click(screen.getByRole("button", { name: /Tim Hortons/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Acme Clinic/ }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/businesses/switch", expect.objectContaining({ method: "POST", body: JSON.stringify({ businessId: "business-2" }) }));
    expect(client.getQueryData(["contacts", "business-1"])).toBeUndefined();
    expect(pendingAnalytics.record).toHaveBeenCalledWith("business-2", "business-1");
  });
});
describe("business limit", () => {
  it("shows how many businesses the account owns beside Create business", async () => {
    setup("Tim Hortons", false, { owned: 2, max: 10 });
    await userEvent.click(screen.getByRole("button", { name: /Tim Hortons/ }));
    const create = await screen.findByRole("menuitem", { name: /sidebar\.createBusiness/ });
    expect(create.getAttribute("href")).toBe("/onboarding/business?create=true");
    expect(create.textContent).toContain('sidebar.businessCount {"owned":2,"max":10}');
    expect(screen.queryByText("sidebar.businessLimitReached")).toBeNull();
  });
  it("turns Create business off and says why once the account owns as many as it may", async () => {
    setup("Tim Hortons", false, { owned: 3, max: 3 });
    await userEvent.click(screen.getByRole("button", { name: /Tim Hortons/ }));
    const create = await screen.findByRole("menuitem", { name: /sidebar\.createBusiness/ });
    expect(create.getAttribute("href")).toBeNull();
    expect(create.getAttribute("aria-disabled")).toBe("true");
    expect(create.textContent).toContain('sidebar.businessCount {"owned":3,"max":3}');
    expect(screen.getByText("sidebar.businessLimitReached")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /sidebar\.seePlans/ })).toBeNull();
  });
  it("points to the plans when a higher plan on one of the account's businesses would allow more", async () => {
    setup("Tim Hortons", false, { owned: 1, max: 1, upgrade: true });
    await userEvent.click(screen.getByRole("button", { name: /Tim Hortons/ }));
    const create = await screen.findByRole("menuitem", { name: /sidebar\.createBusiness/ });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("sidebar.businessLimitUpgrade")).toBeTruthy();
    expect(screen.queryByText("sidebar.businessLimitReached")).toBeNull();
    expect(screen.getByRole("menuitem", { name: /sidebar\.seePlans/ }).getAttribute("href")).toBe("/settings/plan");
  });
  it("keeps Create business as it was when the server sends no limit", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Tim Hortons/ }));
    const create = await screen.findByRole("menuitem", { name: /sidebar\.createBusiness/ });
    expect(create.getAttribute("href")).toBe("/onboarding/business?create=true");
    expect(create.textContent).not.toContain("sidebar.businessCount");
  });
});
