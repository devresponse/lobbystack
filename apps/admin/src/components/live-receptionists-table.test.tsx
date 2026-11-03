// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const navigation = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
const openUpgradePlanDialog = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
  usePathname: () => "/agent/receptionists",
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
}));
vi.mock("./upgrade-plan-dialog-context", () => ({ useOpenUpgradePlanDialog: () => openUpgradePlanDialog }));

import agentEn from "../../public/locales/en/agent.json";
import commonEn from "../../public/locales/en/common.json";
import receptionistsEn from "../../public/locales/en/receptionists.json";
import { LiveReceptionistsSurface, type ReceptionistAllowance, type ReceptionistRow } from "./live-receptionists-surface";

// The Receptionists page as owners, admins and viewers see it: the table
// with its search, status filter and pages, the plan's allowance, adding and
// editing, pausing, archiving, restoring, making one the default and the
// order. A small server in the fetch mock keeps the rows, so each change
// shows the way the real page shows it, after the list reloads.

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "receptionists", interpolation: { escapeValue: false }, resources: { en: { receptionists: receptionistsEn, agent: agentEn, common: commonEn } } });
});

const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

function row(n: number, name: string, values: Partial<ReceptionistRow> = {}): ReceptionistRow {
  return {
    id: ID(n), name, description: "", handle: name.toLowerCase().replace(/\s+/g, "-"), isDefault: false, status: "active", listed: true, sortOrder: n, locale: null, knowledgeScope: "audience",
    archivedAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", phoneNumbers: 0, widgetKeys: 0, entryLinks: 0,
    ...values,
  };
}

const FRONT_DESK = row(1, "Front desk", { isDefault: true, handle: null, knowledgeScope: "all", sortOrder: 0, phoneNumbers: 1, widgetKeys: 1 });
const SALES = row(2, "Sales", { description: "New bikes and test rides", entryLinks: 2 });
const REPAIRS = row(3, "Repairs", { status: "paused", listed: false, locale: "fr" });
const SHOP = [FRONT_DESK, SALES, REPAIRS];

type Plan = { limit: number; cap?: number; plan?: string };
type Refusal = { status: number; body: Record<string, unknown> };
const clients: QueryClient[] = [];

async function setup({ rows = SHOP, role = "business_owner", plan = { limit: 5 } as Plan, refuse, failList = false, wait = "Front desk" }: { rows?: ReceptionistRow[]; role?: string; plan?: Plan; refuse?: Refusal; failList?: boolean; wait?: string | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Acme Bikes", active: true, role, slug: "acme-bikes", defaultLocale: "en" }] });
  // The server's receptionists, in the page's order; saved changes update them.
  let server = rows.map((entry) => ({ ...entry }));
  const current = () => server.filter((entry) => !entry.archivedAt);
  const allowance = (): ReceptionistAllowance => {
    const active = server.filter((entry) => !entry.archivedAt && entry.status === "active").length;
    const cap = plan.cap ?? 50;
    return { plan: plan.plan ?? "pro", limit: plan.limit, cap, active, current: current().length, canAdd: active < plan.limit && current().length < cap };
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url, "https://app.example.com");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (method !== "GET" && refuse) return Response.json(refuse.body, { status: refuse.status });
    if (pathname === "/api/receptionists" && method === "GET") {
      if (failList) return Response.json({ error: "Something went wrong." }, { status: 500 });
      const archived = searchParams.get("view") === "archived";
      const status = searchParams.get("status");
      const search = searchParams.get("search")?.toLowerCase();
      const page = Number(searchParams.get("page"));
      const pageSize = Number(searchParams.get("pageSize"));
      const matching = server.filter((entry) => (archived ? entry.archivedAt : !entry.archivedAt) && (!status || entry.status === status) && (!search || `${entry.name} ${entry.description}`.toLowerCase().includes(search)));
      return Response.json({
        receptionists: matching.slice((page - 1) * pageSize, page * pageSize),
        total: matching.length,
        page,
        pageSize,
        counts: { active: current().filter((entry) => entry.status === "active").length, paused: current().filter((entry) => entry.status === "paused").length, archived: server.length - current().length },
        allowance: allowance(),
      });
    }
    if (pathname === "/api/receptionists/choices") return Response.json({ receptionists: current() });
    if (pathname === "/api/receptionists" && method === "POST") {
      const added = row(server.length + 1, String(body.name), { description: String(body.description ?? ""), sortOrder: server.length + 1 });
      server = [...server, added];
      return Response.json({ receptionist: { name: added.name } }, { status: 201 });
    }
    if (pathname === "/api/receptionists/order" && method === "PUT") {
      if (body.order === "alphabetical") server = [...server].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
      else server = (body.receptionistIds as string[]).map((id) => server.find((entry) => entry.id === id)!).concat(server.filter((entry) => entry.archivedAt));
      return Response.json({ receptionists: current() });
    }
    const one = /^\/api\/receptionists\/([^/]+)$/.exec(pathname);
    if (one && method === "PATCH") {
      server = server.map((entry) => (entry.id === one[1] ? { ...entry, ...body } : entry));
      return Response.json({ receptionist: { name: server.find((entry) => entry.id === one[1])!.name } });
    }
    if (one && method === "POST") {
      const action = body.action as string;
      server = server.map((entry) => {
        if (action === "make_default") return { ...entry, isDefault: entry.id === one[1] };
        if (entry.id !== one[1]) return entry;
        if (action === "pause") return { ...entry, status: "paused" as const };
        if (action === "resume") return { ...entry, status: "active" as const };
        if (action === "archive") return { ...entry, archivedAt: "2026-11-02T10:00:00.000Z" };
        if (action === "restore") return { ...entry, archivedAt: null };
        return entry;
      });
      const changed = server.find((entry) => entry.id === one[1])!;
      return Response.json({ receptionist: action === "archive" ? null : { name: changed.name, status: changed.status } });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><LiveReceptionistsSurface /></QueryClientProvider></I18nextProvider>);
  if (wait) await screen.findByText(wait, { selector: "span" });
  const requests = (method: string, path: string) => fetchMock.mock.calls
    .filter(([url, init]) => (init?.method ?? "GET") === method && new URL(url, "https://app.example.com").pathname === path)
    .map(([url, init]) => ({ params: new URL(url, "https://app.example.com").searchParams, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null }));
  return { client, fetchMock, requests };
}

beforeEach(() => {
  navigation.params = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const rowOf = (name: string) => screen.getByText(name, { selector: "span.font-medium[title]" }).closest("tr") as HTMLElement;
const names = () => Array.from(document.querySelectorAll("tbody tr span.font-medium[title]")).map((cell) => cell.textContent);

async function choose(name: string, item: string) {
  await userEvent.click(within(rowOf(name)).getByRole("button", { name: `More options for ${name}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("the receptionists table", () => {
  it("lists each receptionist with its page, status, what it answers on and its language", async () => {
    await setup();
    expect(names()).toEqual(["Front desk", "Sales", "Repairs"]);
    const desk = rowOf("Front desk");
    expect(within(desk).getByText("Default")).toBeTruthy();
    expect(within(desk).getByRole("link", { name: "/profile/acme-bikes" }).getAttribute("target")).toBe("_blank");
    expect(within(desk).getByText("1 phone number")).toBeTruthy();
    expect(within(desk).getByText("1 website widget")).toBeTruthy();
    expect(within(desk).getByText("Business language")).toBeTruthy();

    const sales = rowOf("Sales");
    expect(within(sales).getByText("New bikes and test rides")).toBeTruthy();
    expect(within(sales).getByRole("link", { name: "/profile/acme-bikes/sales" })).toBeTruthy();
    expect(within(sales).getByText("2 QR links")).toBeTruthy();
    expect(within(sales).getByText("Active")).toBeTruthy();

    const repairs = rowOf("Repairs");
    expect(within(repairs).getByText("Paused")).toBeTruthy();
    expect(within(repairs).getByText("Not listed on the business page")).toBeTruthy();
    expect(within(repairs).getByText("Its page only")).toBeTruthy();
    expect(within(repairs).getByText("Français")).toBeTruthy();
    expect(screen.getByText("2 of 5 active receptionists on your plan")).toBeTruthy();
  });

  it("asks the server for a search and a status, and says when nothing matches", async () => {
    const { requests } = await setup();
    fireEvent.change(screen.getByLabelText("Search by name or what it helps with"), { target: { value: "bikes" } });
    await waitFor(() => expect(names()).toEqual(["Sales"]));
    expect(requests("GET", "/api/receptionists").at(-1)!.params.get("search")).toBe("bikes");

    fireEvent.change(screen.getByLabelText("Search by name or what it helps with"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "paused" } });
    await waitFor(() => expect(names()).toEqual(["Repairs"]));
    expect(requests("GET", "/api/receptionists").at(-1)!.params.get("status")).toBe("paused");
    expect(Array.from((screen.getByLabelText("Status") as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(["All (3)", "Active (2)", "Paused (1)", "Archived (0)"]);

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "archived" } });
    expect(await screen.findByText("No archived receptionists.")).toBeTruthy();
    expect(requests("GET", "/api/receptionists").at(-1)!.params.get("view")).toBe("archived");
  });

  it("pages through more than 10", async () => {
    const many = [FRONT_DESK, ...Array.from({ length: 11 }, (_, index) => row(index + 10, `Store ${index + 1}`))];
    const { requests } = await setup({ rows: many, plan: { limit: 50 } });
    expect(names()).toHaveLength(10);
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(names()).toEqual(["Store 10", "Store 11"]));
    expect(requests("GET", "/api/receptionists").at(-1)!.params.get("page")).toBe("2");
  });

  it("says when the receptionists can't be loaded", async () => {
    await setup({ failList: true, wait: null });
    expect(await screen.findByText("Receptionists couldn't be loaded. Try again in a moment.")).toBeTruthy();
  });

  it("shows members who can't change receptionists the table only", async () => {
    await setup({ role: "viewer" });
    expect(screen.queryByRole("button", { name: "Add receptionist" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sort A–Z" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^More options/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
  });
});

describe("the plan's receptionists", () => {
  it("offers plans to a business whose plan has one, and opens them instead of the form", async () => {
    await setup({ rows: [FRONT_DESK], plan: { limit: 1, plan: "starter" } });
    expect(screen.getByText("A receptionist for each location, team or language")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "See plans" }));
    expect(openUpgradePlanDialog).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(openUpgradePlanDialog).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks members who can't upgrade to ask an owner or admin", async () => {
    await setup({ rows: [FRONT_DESK], role: "viewer", plan: { limit: 1, plan: "free" } });
    expect(screen.getByText(/An owner or admin of the business can upgrade\.$/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See plans" })).toBeNull();
  });

  it("says when every active receptionist the plan includes is in use", async () => {
    await setup({ plan: { limit: 2 } });
    expect(screen.getByText("2 of 2 active receptionists on your plan All the active receptionists your plan includes are in use. Pause one or upgrade to add another.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(toasts.error).toHaveBeenCalledWith("All the active receptionists your plan includes are in use. Pause one or upgrade to add another.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when the business keeps as many as the deployment allows", async () => {
    await setup({ plan: { limit: 50, cap: 3 } });
    expect(screen.getByText(/A business can keep up to 3 receptionists\. Archive one to add another\.$/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(toasts.error).toHaveBeenCalledWith("This business keeps as many receptionists as it can. Archive one to add another.");
  });
});

describe("adding and changing receptionists", () => {
  it("adds a receptionist from the form", async () => {
    const { requests } = await setup();
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Add a receptionist")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Add receptionist" }));
    expect(within(dialog).getByText("Give the receptionist a name.")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Rentals");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add receptionist" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Rentals added."));
    expect(requests("POST", "/api/receptionists")[0]!.body).toMatchObject({ name: "Rentals", copyFromId: FRONT_DESK.id });
    await waitFor(() => expect(names()).toContain("Rentals"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the form when another page sends the owner here with ?add=1", async () => {
    navigation.params = new URLSearchParams({ add: "1" });
    await setup();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(navigation.replace).toHaveBeenCalledWith("/agent/receptionists", { scroll: false });
  });

  it("saves only what an edit changed", async () => {
    const { requests } = await setup();
    await choose("Sales", "Edit details");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit Sales")).toBeTruthy();
    const name = within(dialog).getByLabelText(/^Name/) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, "Bike sales");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Bike sales saved."));
    expect(requests("PATCH", `/api/receptionists/${SALES.id}`).map((request) => request.body)).toEqual([{ name: "Bike sales" }]);
  });

  it("opens a receptionist's AI settings", async () => {
    await setup();
    await choose("Sales", "AI settings");
    expect(navigation.push).toHaveBeenCalledWith(`/agent?receptionist=${SALES.id}`);
  });

  it("pauses and resumes a receptionist", async () => {
    const { requests } = await setup();
    await choose("Sales", "Pause");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Sales paused. Its phone numbers, widgets and QR links answer as the default receptionist."));
    await waitFor(() => expect(within(rowOf("Sales")).getByText("Paused")).toBeTruthy());
    await choose("Sales", "Resume");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Sales answers again."));
    expect(requests("POST", `/api/receptionists/${SALES.id}`).map((request) => request.body)).toEqual([{ action: "pause" }, { action: "resume" }]);
  });

  it("never offers to pause, archive or move the default receptionist", async () => {
    await setup();
    await userEvent.click(within(rowOf("Front desk")).getByRole("button", { name: "More options for Front desk" }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items).toEqual(["Edit details", "AI settings"]);
    expect(within(rowOf("Front desk")).queryByRole("button", { name: /^Move / })).toBeNull();
  });

  it("archives a receptionist after asking, and restores it from Archived", async () => {
    const { requests } = await setup();
    await choose("Sales", "Archive");
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Archive Sales?")).toBeTruthy();
    await userEvent.click(within(confirm).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Sales archived."));
    await waitFor(() => expect(names()).toEqual(["Front desk", "Repairs"]));

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "archived" } });
    await waitFor(() => expect(names()).toEqual(["Sales"]));
    expect(within(rowOf("Sales")).getByText(/^Archived Nov 2, 2026$/)).toBeTruthy();
    await choose("Sales", "Restore");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Sales restored."));
    expect(requests("POST", `/api/receptionists/${SALES.id}`).map((request) => request.body)).toEqual([{ action: "archive" }, { action: "restore" }]);
  });

  it("makes another receptionist the default after asking", async () => {
    const { requests } = await setup();
    await choose("Sales", "Make default");
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Make Sales the default receptionist?")).toBeTruthy();
    expect(within(confirm).getByText(/Front desk keeps its phone numbers, widgets and QR links, and gets a page of its own\.$/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Sales is the default receptionist now."));
    expect(requests("POST", `/api/receptionists/${SALES.id}`).map((request) => request.body)).toEqual([{ action: "make_default" }]);
  });

  it("explains a refused change in the dashboard's language", async () => {
    await setup({ refuse: { status: 409, body: { error: "Plan limit reached.", code: "receptionist_limit" } } });
    await choose("Repairs", "Resume");
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("All the active receptionists your plan includes are in use. Pause one or upgrade to add another."));
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

describe("the order", () => {
  it("moves a receptionist a place, the default staying first", async () => {
    const { requests } = await setup();
    expect((within(rowOf("Sales")).getByRole("button", { name: "Move Sales up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rowOf("Repairs")).getByRole("button", { name: "Move Repairs down" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(rowOf("Repairs")).getByRole("button", { name: "Move Repairs up" }));
    await waitFor(() => expect(names()).toEqual(["Front desk", "Repairs", "Sales"]));
    expect(requests("PUT", "/api/receptionists/order").map((request) => request.body)).toEqual([{ receptionistIds: [FRONT_DESK.id, REPAIRS.id, SALES.id] }]);
  });

  it("sorts them by name after asking, from now on", async () => {
    const { requests } = await setup();
    await userEvent.click(screen.getByRole("button", { name: "Sort A–Z" }));
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Sort A–Z" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Receptionists sorted A–Z."));
    expect(requests("PUT", "/api/receptionists/order").map((request) => request.body)).toEqual([{ order: "alphabetical" }]);
    await waitFor(() => expect(names()).toEqual(["Front desk", "Repairs", "Sales"]));
  });

  it("leaves the order alone while the list is searched or filtered, or has fewer than 3", async () => {
    await setup();
    fireEvent.change(screen.getByLabelText("Search by name or what it helps with"), { target: { value: "s" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Move / })).toBeNull());
    cleanup();
    await setup({ rows: [FRONT_DESK, SALES] });
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sort A–Z" })).toBeNull();
  });
});
