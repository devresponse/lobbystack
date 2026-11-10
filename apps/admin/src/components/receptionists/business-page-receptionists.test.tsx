// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import en from "../../../public/locales/en/receptionists.json";
import { BusinessPageReceptionists, movedAmongListed } from "./business-page-receptionists";
import { receptionistChoicesQueryKey, type ReceptionistOption } from "./receptionist-choices";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "receptionists", interpolation: { escapeValue: false }, resources: { en: { receptionists: en } } });
});

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: name.toLowerCase(), isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, handle: null, knowledgeScope: "all" });
const REPAIRS = receptionist("00000000-0000-4000-8000-0000000000a2", "Repairs", { description: "Tune-ups and fixes", sortOrder: 1, listed: false });
const SALES = receptionist("00000000-0000-4000-8000-0000000000a3", "Sales", { description: "New bikes and test rides", sortOrder: 2 });
const SUPPORT = receptionist("00000000-0000-4000-8000-0000000000a4", "Support", { description: "Repairs and fitting", sortOrder: 3 });
/** By name after the default: Repairs (unlisted), Sales, Support. */
const BY_NAME = [FRONT_DESK, REPAIRS, SALES, SUPPORT];

type Deferred = { resolve: () => void };
const clients: QueryClient[] = [];

function setup({ receptionists = BY_NAME, canEdit = true, refuse, hold = false }: { receptionists?: ReceptionistOption[]; canEdit?: boolean; refuse?: { status: number; body: Record<string, unknown> }; hold?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(receptionistChoicesQueryKey("business"), { receptionists });
  // The server's list, which a saved change updates.
  let server = receptionists.map((entry) => ({ ...entry }));
  const held: Deferred[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      if (hold) await new Promise<void>((resolve) => held.push({ resolve }));
      if (refuse) return Response.json(refuse.body, { status: refuse.status });
      const body = JSON.parse(String(init.body)) as { receptionistIds?: string[]; order?: string };
      if (url.startsWith("/api/receptionists/listed")) server = server.map((entry) => (entry.isDefault ? entry : { ...entry, listed: body.receptionistIds!.includes(entry.id) }));
      else if (body.order === "alphabetical") server = [...server].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
      else server = body.receptionistIds!.map((id) => server.find((entry) => entry.id === id)!);
      return Response.json({ receptionists: server });
    }
    if (url.startsWith("/api/receptionists/choices")) return Response.json({ receptionists: server });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><BusinessPageReceptionists businessId="business" businessLocale="en" canEdit={canEdit} /></QueryClientProvider></I18nextProvider>);
  const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([url, init]) => ({ url: url.split("?")[0], body: JSON.parse(String(init?.body)) as Record<string, unknown> }));
  return { ...view, client, fetchMock, puts, release: () => held.splice(0).forEach((entry) => entry.resolve()) };
}

afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const onPage = () => within(screen.getByRole("list", { name: "Receptionists visitors can choose, in order" })).getAllByRole("listitem").map((item) => item.querySelector(".font-medium")?.textContent);
const orderChoice = (name: "Alphabetical" | "Custom") => screen.getByRole("radio", { name }) as HTMLInputElement;

async function toggleListed(name: string) {
  await userEvent.click(screen.getByRole("combobox", { name: /^Listed/ }));
  await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(`^${name}`) }));
  await userEvent.keyboard("{Escape}");
}

describe("receptionists on the business page", () => {
  it("is hidden while the business has one receptionist", () => {
    const { container } = setup({ receptionists: [FRONT_DESK] });
    expect(container.textContent).toBe("");
  });

  it("lists the default first, then the listed ones in order, and counts the ones chosen", () => {
    setup();
    expect(screen.getByRole("button", { name: "Remove Sales" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Support" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Repairs" })).toBeNull();
    expect(screen.getByText("2 chosen")).toBeTruthy();
    expect(onPage()).toEqual(["Front desk", "Sales", "Support"]);
    const first = within(screen.getByRole("list", { name: "Receptionists visitors can choose, in order" })).getAllByRole("listitem")[0]!;
    expect(first.textContent).toContain("Default");
    expect(first.textContent).toContain("Always first");
    expect(screen.getByText("New bikes and test rides")).toBeTruthy();
  });

  it("saves who is listed in one step and shows it at once", async () => {
    const { puts, release } = setup({ hold: true });
    await toggleListed("Repairs");
    // The page shows the change before the server answers.
    expect(onPage()).toEqual(["Front desk", "Repairs", "Sales", "Support"]);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.url).toBe("/api/receptionists/listed");
    expect([...(puts()[0]!.body.receptionistIds as string[])].sort()).toEqual([REPAIRS.id, SALES.id, SUPPORT.id]);
    release();
    await waitFor(() => expect(screen.getByText("3 chosen")).toBeTruthy());
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("goes by name while the receptionists do, and moves them only after Custom is chosen", async () => {
    const { puts } = setup();
    expect(orderChoice("Alphabetical").checked).toBe(true);
    expect(screen.getByText("By name, after Front desk. A receptionist you add takes its place by name.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move Support up" })).toBeNull();

    await userEvent.click(orderChoice("Custom"));
    expect(orderChoice("Custom").checked).toBe(true);
    expect(puts()).toEqual([]);
    expect((screen.getByRole("button", { name: "Move Sales up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Support down" }) as HTMLButtonElement).disabled).toBe(true);

    // Moving Support past Sales leaves unlisted Repairs where it was.
    await userEvent.click(screen.getByRole("button", { name: "Move Support up" }));
    expect(onPage()).toEqual(["Front desk", "Support", "Sales"]);
    await waitFor(() => expect(puts()).toEqual([{ url: "/api/receptionists/order", body: { receptionistIds: [FRONT_DESK.id, REPAIRS.id, SUPPORT.id, SALES.id] } }]));
    await waitFor(() => expect(orderChoice("Custom").checked).toBe(true));
    expect(screen.getByText("In the order you set. A receptionist you add goes last.")).toBeTruthy();
  });

  it("puts a custom order back by name when Alphabetical is chosen", async () => {
    const { puts } = setup({ receptionists: [FRONT_DESK, SUPPORT, REPAIRS, SALES] });
    expect(orderChoice("Custom").checked).toBe(true);
    expect(onPage()).toEqual(["Front desk", "Support", "Sales"]);
    await userEvent.click(orderChoice("Alphabetical"));
    expect(onPage()).toEqual(["Front desk", "Sales", "Support"]);
    expect(orderChoice("Alphabetical").checked).toBe(true);
    await waitFor(() => expect(puts()).toEqual([{ url: "/api/receptionists/order", body: { order: "alphabetical" } }]));
  });

  it("says a paused receptionist is off the page until it resumes", () => {
    setup({ receptionists: [FRONT_DESK, REPAIRS, { ...SALES, status: "paused" }, SUPPORT] });
    expect(screen.getByText("Paused, so it's off the page until it resumes")).toBeTruthy();
    expect(screen.getByText("A paused receptionist stays off the page until it resumes.")).toBeTruthy();
  });

  it("says visitors don't choose when only the default is listed", () => {
    setup({ receptionists: [FRONT_DESK, { ...SALES, listed: false }] });
    expect(onPage()).toEqual(["Front desk"]);
    expect(screen.getByText("Only Front desk is on the page, so visitors don't choose.")).toBeTruthy();
    // The box shows even with one receptionist to list.
    expect(screen.getByRole("combobox", { name: /^Listed/ })).toBeTruthy();
  });

  it("shows members who can't change it the page's list and order only", () => {
    setup({ canEdit: false });
    expect(onPage()).toEqual(["Front desk", "Sales", "Support"]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains a refusal and puts the list back as the server has it", async () => {
    const { fetchMock } = setup({ refuse: { status: 404, body: { error: "Receptionist not found.", code: "receptionist_not_found" } } });
    await toggleListed("Repairs");
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("That receptionist isn't there any more. Refresh the page."));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.startsWith("/api/receptionists/choices"))).toBe(true));
    await waitFor(() => expect(onPage()).toEqual(["Front desk", "Sales", "Support"]));
  });
});

describe("moving a listed receptionist", () => {
  const all = [FRONT_DESK, SALES, REPAIRS, SUPPORT];

  it("passes the next listed one, leaving unlisted ones in their places", () => {
    expect(movedAmongListed(all, SUPPORT.id, -1)).toEqual([FRONT_DESK.id, SUPPORT.id, REPAIRS.id, SALES.id]);
    expect(movedAmongListed(all, SALES.id, 1)).toEqual([FRONT_DESK.id, SUPPORT.id, REPAIRS.id, SALES.id]);
  });

  it("goes no further than the ends, and never moves the default or an unlisted one", () => {
    expect(movedAmongListed(all, SALES.id, -1)).toBeNull();
    expect(movedAmongListed(all, SUPPORT.id, 1)).toBeNull();
    expect(movedAmongListed(all, FRONT_DESK.id, 1)).toBeNull();
    expect(movedAmongListed(all, REPAIRS.id, 1)).toBeNull();
  });
});
