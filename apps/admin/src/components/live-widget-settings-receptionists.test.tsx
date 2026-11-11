// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import receptionistsEn from "../../public/locales/en/receptionists.json";
import settingsEn from "../../public/locales/en/settings.json";
import { LiveWidgetSettingsSurface } from "./live-widget-settings-surface";
import { receptionistChoicesQueryKey, type ReceptionistOption } from "./receptionists/receptionist-choices";

vi.mock("./live-notification-settings-surface", () => ({ LiveNotificationSettingsSurface: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// Who answers each widget key: the "Receptionist" dropdown on a new key and
// on each key's editor, shown only while the business has several.

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "settings", interpolation: { escapeValue: false }, resources: { en: { settings: settingsEn, receptionists: receptionistsEn } } });
});

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all" });
const KITSILANO = receptionist("00000000-0000-4000-8000-0000000000a2", "Kitsilano clinic", { sortOrder: 1 });
const BILLING = receptionist("00000000-0000-4000-8000-0000000000a3", "Billing", { status: "paused", sortOrder: 2 });
const ARCHIVED_ID = "00000000-0000-4000-8000-0000000000a9";

type Key = { id: string; key: string | null; label: string | null; status: "active" | "disabled" | "revoked"; allowedOrigins: string[]; config: Record<string, unknown>; lastUsedAt: string | null; createdAt: string; receptionistId: string | null };
function widgetKey(id: string, label: string, values: Partial<Key> = {}): Key {
  return { id, key: `wk_live_${id}`, label, status: "active", allowedOrigins: ["https://clinic.example"], config: {}, lastUsedAt: null, createdAt: "2026-10-01T00:00:00Z", receptionistId: null, ...values };
}

type Refusal = { status: number; body: Record<string, unknown> };
const clients: QueryClient[] = [];

function setup({ receptionists = [FRONT_DESK, KITSILANO, BILLING], keys = [] as Key[], refuseCreate, refusePatch }: { receptionists?: ReceptionistOption[]; keys?: Key[]; refuseCreate?: Refusal; refusePatch?: Refusal } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Kitsilano Physio", active: true, role: "business_owner" }] });
  client.setQueryData(["billing", "business"], { account: { plan: "pro" }, widgetIssuanceEnabled: true });
  client.setQueryData(["widget-keys", "business"], { keys });
  client.setQueryData(receptionistChoicesQueryKey("business"), { receptionists });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/widget-keys") && init?.method === "POST") return refuseCreate ? Response.json(refuseCreate.body, { status: refuseCreate.status }) : Response.json({ ok: true, key: { id: "created", key: "wk_live_created" } });
    if (url.includes("/api/widget-keys") && init?.method === "PATCH") return refusePatch ? Response.json(refusePatch.body, { status: refusePatch.status }) : Response.json({ ok: true });
    if (url.includes("/api/widget-keys")) return Response.json({ keys });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><LiveWidgetSettingsSurface /></QueryClientProvider></I18nextProvider>);
  const bodies = (method: string) => fetchMock.mock.calls.filter(([, init]) => init?.method === method).map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  return { client, fetchMock, bodies };
}

afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const createCard = () => screen.getByText("Create a widget key").closest("[data-slot='card']") as HTMLElement;
const keyEditor = (label: string) => screen.getByText(label, { selector: "p" }).closest("article") as HTMLElement;

async function pick(scope: HTMLElement, name: string) {
  await userEvent.click(within(scope).getByRole("combobox", { name: /^Receptionist/ }));
  // The open list is drawn over the page, outside the card.
  await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(`^${name}`) }));
}

describe("who answers a widget key", () => {
  it("asks nothing while the business has one receptionist", () => {
    setup({ receptionists: [FRONT_DESK], keys: [widgetKey("k1", "Clinic site")] });
    expect(screen.getByText("Create a widget key")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /^Receptionist/ })).toBeNull();
    expect(screen.queryByText(/go to the receptionist you pick/)).toBeNull();
  });

  it("starts a new key with the default receptionist and says what the choice does", () => {
    setup();
    const card = createCard();
    expect(within(card).getByRole("combobox", { name: "Receptionist Front desk" })).toBeTruthy();
    expect(within(card).getByText("Chats and calls from this widget go to the receptionist you pick. While it's paused, Front desk answers them.")).toBeTruthy();
  });

  it("leaves a new key with whoever is the default unless the owner picks another receptionist", async () => {
    const { bodies } = setup();
    fireEvent.change(screen.getByPlaceholderText("https://example.com, https://www.example.com"), { target: { value: "https://clinic.example" } });
    await userEvent.click(screen.getByRole("button", { name: "Create widget key" }));
    await screen.findByText("Widget key created");
    expect(bodies("POST")[0]).not.toHaveProperty("receptionistId");
  });

  it("creates a key for the receptionist picked, then starts the form over at the default", async () => {
    const { bodies } = setup();
    fireEvent.change(screen.getByPlaceholderText("https://example.com, https://www.example.com"), { target: { value: "https://clinic.example/kitsilano" } });
    await pick(createCard(), "Kitsilano clinic");
    await userEvent.click(screen.getByRole("button", { name: "Create widget key" }));
    await screen.findByText("Widget key created");
    expect(bodies("POST")[0]).toMatchObject({ allowedOrigins: ["https://clinic.example/kitsilano"], receptionistId: KITSILANO.id });
    expect(within(createCard()).getByRole("combobox", { name: "Receptionist Front desk" })).toBeTruthy();
  });

  it("doesn't name the default explicitly when the owner picks another receptionist and then the default again", async () => {
    const { bodies } = setup();
    fireEvent.change(screen.getByPlaceholderText("https://example.com, https://www.example.com"), { target: { value: "https://clinic.example" } });
    await pick(createCard(), "Kitsilano clinic");
    await pick(createCard(), "Front desk");
    await userEvent.click(screen.getByRole("button", { name: "Create widget key" }));
    await screen.findByText("Widget key created");
    expect(bodies("POST")[0]).not.toHaveProperty("receptionistId");
  });

  it("explains a refused receptionist in the dashboard's language instead of the server's words", async () => {
    setup({ refuseCreate: { status: 409, body: { error: "An archived receptionist can't answer. Restore it first.", code: "receptionist_archived" } } });
    fireEvent.change(screen.getByPlaceholderText("https://example.com, https://www.example.com"), { target: { value: "https://clinic.example" } });
    await pick(createCard(), "Kitsilano clinic");
    await userEvent.click(screen.getByRole("button", { name: "Create widget key" }));
    expect(await within(createCard()).findByText("That receptionist was archived. Refresh the page and pick another one.")).toBeTruthy();
    expect(screen.queryByText("An archived receptionist can't answer. Restore it first.")).toBeNull();
  });

  it("names who answers each key, the default for a key that names nobody", () => {
    setup({ keys: [widgetKey("k1", "Clinic site"), widgetKey("k2", "Kitsilano page", { receptionistId: KITSILANO.id })] });
    expect(within(keyEditor("Clinic site")).getByRole("combobox", { name: "Receptionist Front desk" })).toBeTruthy();
    expect(within(keyEditor("Kitsilano page")).getByRole("combobox", { name: "Receptionist Kitsilano clinic" })).toBeTruthy();
  });

  it("sends the receptionist with Save only when the owner picked another one", async () => {
    const { bodies } = setup({ keys: [widgetKey("k1", "Clinic site")] });
    const editor = keyEditor("Clinic site");
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies("PATCH")).toHaveLength(1));
    expect(bodies("PATCH")[0]).not.toHaveProperty("receptionistId");
    await pick(editor, "Kitsilano clinic");
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies("PATCH")).toHaveLength(2));
    expect(bodies("PATCH")[1]).toMatchObject({ label: "Clinic site", receptionistId: KITSILANO.id });
    expect(await within(editor).findByText("Saved")).toBeTruthy();
  });

  it("says who answers for a paused receptionist, and for one that was archived", () => {
    setup({ keys: [widgetKey("k1", "Billing portal", { receptionistId: BILLING.id }), widgetKey("k2", "Old store", { receptionistId: ARCHIVED_ID })] });
    expect(within(keyEditor("Billing portal")).getByRole("status").textContent).toBe("Billing is paused, so Front desk answers for now.");
    const archived = keyEditor("Old store");
    expect(within(archived).getByRole("combobox", { name: "Receptionist Choose a receptionist" })).toBeTruthy();
    expect(within(archived).getByRole("status").textContent).toBe("The receptionist chosen here was archived, so Front desk answers. Pick another one.");
  });

  it("moves a key off an archived receptionist, even to the default", async () => {
    const { bodies } = setup({ keys: [widgetKey("k1", "Old store", { receptionistId: ARCHIVED_ID })] });
    const editor = keyEditor("Old store");
    await pick(editor, "Front desk");
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies("PATCH")).toHaveLength(1));
    expect(bodies("PATCH")[0]).toMatchObject({ receptionistId: FRONT_DESK.id });
  });

  it("asks nothing for a revoked key", () => {
    setup({ keys: [widgetKey("k1", "Retired site", { status: "revoked", key: null })] });
    expect(within(keyEditor("Retired site")).queryByRole("combobox", { name: /^Receptionist/ })).toBeNull();
  });

  it("explains a refused change to who answers a key", async () => {
    setup({ keys: [widgetKey("k1", "Clinic site")], refusePatch: { status: 404, body: { error: "The widget key was not found.", code: "widget_key_not_found" } } });
    const editor = keyEditor("Clinic site");
    await pick(editor, "Kitsilano clinic");
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That isn't there any more. Refresh the page.")).toBeTruthy();
  });
});
