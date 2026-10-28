// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveIntegrationsSurface } from "./live-integrations-surface";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";

const INVITE_URL = "https://www.make.com/en/hq/app-invitation/0a1b2c3d4e5f";
const brand = vi.hoisted(() => ({ makeUrl: null as string | null }));
vi.mock("@lobbystack/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@lobbystack/shared")>();
  return { ...shared, brandLinks: () => ({ ...shared.brandLinks(), zapierUrl: null, makeUrl: brand.makeUrl }) };
});
const telemetryRef = vi.hoisted(() => ({ current: null as ReturnType<typeof createRecordedBrowserTelemetry> | null }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => telemetryRef.current!.telemetry }));
const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/integrations", useSearchParams: () => new URLSearchParams(navigation.search), useRouter: () => ({ replace: navigation.replace }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en", resolvedLanguage: "en" }, t: (key: string, options?: { url?: string }) => options?.url ? `${key} ${options.url}` : key }) }));

const clients: QueryClient[] = [];
beforeEach(() => { telemetryRef.current = createRecordedBrowserTelemetry(); });
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; brand.makeUrl = null; navigation.search = ""; navigation.replace.mockReset(); });

function setup(role = "business_owner") {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business-1", active: true, role }] });
  client.setQueryData(["integrations", "business-1"], { calendarConnections: [], calendarOptions: [] });
  render(<QueryClientProvider client={client}><LiveIntegrationsSurface /></QueryClientProvider>);
}

describe("Make on the Integrations page", () => {
  it("has no Make card when the brand has no Make app of its own", () => {
    navigation.search = "setup=make";
    setup();
    expect(screen.getByText("integrations.cards.webhooks.title")).toBeTruthy();
    expect(screen.queryByText("integrations.cards.make.title")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("opens a dialog that links to the brand's Make invite and to a key set up for Make", async () => {
    brand.makeUrl = INVITE_URL;
    const user = userEvent.setup();
    setup();
    const card = screen.getByText("integrations.cards.make.title").closest("li")!;
    await user.click(within(card).getByRole("button", { name: "integrations.actions.connect" }));
    const dialog = await screen.findByRole("dialog");
    const invite = within(dialog).getByRole("link", { name: /integrations.make.openInvite/ });
    expect(invite.getAttribute("href")).toBe(INVITE_URL);
    expect(invite.getAttribute("target")).toBe("_blank");
    expect(invite.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(dialog).getByRole("link", { name: /integrations.make.createKey/ }).getAttribute("href")).toBe("/settings/api-keys?setup=make");
    expect(within(dialog).getByText(`integrations.make.steps.scenario ${window.location.origin}`)).toBeTruthy();
  });

  it("opens the dialog from the Make app's help link", async () => {
    brand.makeUrl = INVITE_URL;
    navigation.search = "setup=make";
    setup();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("integrations.make.title")).toBeTruthy();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/integrations", { scroll: false }));
  });

  it("keeps the card's button off for a member who can't manage integrations", () => {
    brand.makeUrl = INVITE_URL;
    setup("viewer");
    const card = screen.getByText("integrations.cards.make.title").closest("li")!;
    expect((within(card).getByRole("button", { name: "integrations.actions.connect" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
