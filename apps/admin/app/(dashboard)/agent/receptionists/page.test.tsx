// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import agent from "../../../../public/locales/en/agent.json";
import receptionistsCopy from "../../../../public/locales/en/receptionists.json";
import type { ReceptionistAllowance, ReceptionistRow } from "@/components/live-receptionists-surface";
import { UpgradePlanDialogProvider } from "@/components/upgrade-plan-dialog-context";
import AgentLayout from "../layout";
import AgentReceptionistsPage from "./page";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/agent/receptionists",
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => navigation.params,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const clients: QueryClient[] = [];
beforeEach(() => { navigation.params = new URLSearchParams(); });
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function row(id: string, name: string, values: Partial<ReceptionistRow> = {}): ReceptionistRow {
  return {
    id: `00000000-0000-4000-8000-0000000000${id}`,
    name,
    description: "",
    handle: null,
    isDefault: false,
    status: "active",
    listed: true,
    sortOrder: 0,
    locale: null,
    knowledgeScope: "audience",
    archivedAt: null,
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: "2026-10-01T12:00:00Z",
    phoneNumbers: 0,
    widgetKeys: 0,
    entryLinks: 0,
    ...values,
  };
}

const FRONT_DESK = row("a1", "Front desk", { isDefault: true, knowledgeScope: "all", description: "Bookings and general questions", sortOrder: 1, phoneNumbers: 1, widgetKeys: 1 });
const KITSILANO = row("a2", "Kitsilano clinic", { handle: "kitsilano", description: "Our clinic on West 4th", locale: "fr", sortOrder: 2, phoneNumbers: 1, entryLinks: 2 });
const GASTOWN = row("a3", "Gastown store", { handle: "gastown", listed: false, sortOrder: 3 });
const BILLING = row("a4", "Billing", { handle: "billing", status: "paused", sortOrder: 4, widgetKeys: 2 });
const OLD_STORE = row("a5", "Old store", { handle: "old-store", archivedAt: "2026-10-01T12:00:00Z" });
const PRO: ReceptionistAllowance = { plan: "pro", limit: 5, cap: 50, active: 3, current: 4, canAdd: true };

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Reply = { status: number; body: unknown };

/** A stand-in for the receptionists API: lists, filters and pages its rows, and records every request. */
function fakeApi(options: { current?: ReceptionistRow[]; archived?: ReceptionistRow[]; allowance?: ReceptionistAllowance; reply?: (call: Call) => Reply | undefined } = {}) {
  const current = options.current ?? [FRONT_DESK, KITSILANO, GASTOWN, BILLING];
  const archived = options.archived ?? [OLD_STORE];
  const allowance = options.allowance ?? PRO;
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const address = new URL(url, "https://admin.example.invalid");
    const call: Call = { method: init?.method ?? "GET", path: address.pathname, query: address.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const replied = options.reply?.(call);
    if (replied) return Response.json(replied.body, { status: replied.status });
    if (call.method === "GET" && call.path === "/api/receptionists/choices") {
      return Response.json({ receptionists: current.map(({ archivedAt: _a, createdAt: _c, updatedAt: _u, phoneNumbers: _p, widgetKeys: _w, entryLinks: _e, ...choice }) => choice) });
    }
    if (call.method === "GET" && call.path === "/api/receptionists") {
      const view = call.query.get("view") === "archived" ? archived : current;
      const status = call.query.get("status");
      const search = call.query.get("search")?.toLowerCase() ?? "";
      const matching = view.filter((item) => (!status || item.status === status) && (!search || `${item.name} ${item.description}`.toLowerCase().includes(search)));
      const page = Number(call.query.get("page") ?? 1);
      const pageSize = Number(call.query.get("pageSize") ?? 10);
      return Response.json({
        receptionists: matching.slice((page - 1) * pageSize, page * pageSize),
        total: matching.length,
        page,
        pageSize,
        counts: { active: current.filter((item) => item.status === "active").length, paused: current.filter((item) => item.status === "paused").length, archived: archived.length },
        allowance,
      });
    }
    if (call.method === "POST" && call.path === "/api/receptionists") return Response.json({ receptionist: { ...(call.body as object), id: "00000000-0000-4000-8000-0000000000b1" } }, { status: 201 });
    if (call.method === "PATCH") {
      const id = call.path.split("/").at(-1);
      return Response.json({ receptionist: { ...current.find((item) => item.id === id), ...(call.body as object) } });
    }
    if (call.method === "POST") {
      const id = call.path.split("/").at(-1);
      const target = [...current, ...archived].find((item) => item.id === id)!;
      const action = (call.body as { action: string }).action;
      if (action === "archive") return Response.json({ receptionist: null });
      return Response.json({ receptionist: { ...target, status: action === "pause" ? "paused" : "active" } });
    }
    if (call.method === "PUT") return Response.json({ receptionists: [] });
    return Response.json({ error: "Not found." }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, requests: (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path) };
}

async function openPage({ role = "business_owner", businesses }: { role?: string; businesses?: object[] } = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", defaultNS: "receptionists", interpolation: { escapeValue: false }, resources: { en: { agent, receptionists: receptionistsCopy } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: businesses ?? [{ businessId: "business", name: "Clinic", slug: "clinic", active: true, role, defaultLocale: "en" }] });
  const openUpgrade = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <UpgradePlanDialogProvider onOpen={openUpgrade}>
          <AgentLayout><AgentReceptionistsPage /></AgentLayout>
        </UpgradePlanDialogProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { openUpgrade };
}

const bodyRows = () => screen.getAllByRole("row").slice(1);
const rowOf = (name: string) => screen.getByText(name, { selector: "span" }).closest("tr")!;
async function openMenu(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: `More options for ${name}` }));
  return await screen.findByRole("menu");
}

describe("the Receptionists page at /agent/receptionists", () => {
  it("opens under its own title, the default first, with each one's page, status, entry points and language", async () => {
    const api = fakeApi();
    await openPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Receptionists");
    await screen.findByText("Kitsilano clinic");
    expect(bodyRows().map((item) => within(item).getAllByText(/./, { selector: "span.font-medium" })[0]!.textContent)).toEqual(["Front desk", "Kitsilano clinic", "Gastown store", "Billing"]);

    const frontDesk = within(rowOf("Front desk"));
    expect(frontDesk.getByText("Default")).toBeTruthy();
    expect(frontDesk.getByText("Bookings and general questions")).toBeTruthy();
    expect(frontDesk.getByRole("link", { name: "/profile/clinic" }).getAttribute("href")).toBe("/profile/clinic");
    expect(frontDesk.getByText("Active")).toBeTruthy();
    expect(frontDesk.getByText("1 phone number")).toBeTruthy();
    expect(frontDesk.getByText("1 website widget")).toBeTruthy();
    expect(frontDesk.getByText("Business language")).toBeTruthy();

    const kitsilano = within(rowOf("Kitsilano clinic"));
    expect(kitsilano.getByRole("link", { name: "/profile/clinic/kitsilano" }).getAttribute("target")).toBe("_blank");
    expect(kitsilano.getByText("2 QR links")).toBeTruthy();
    expect(kitsilano.getByText("Français")).toBeTruthy();
    expect(within(rowOf("Gastown store")).getByText("Not listed on the business page")).toBeTruthy();
    expect(within(rowOf("Gastown store")).getByText("Its page only")).toBeTruthy();
    expect(within(rowOf("Billing")).getByText("Paused")).toBeTruthy();
    expect(within(rowOf("Billing")).getByText("2 website widgets")).toBeTruthy();

    expect(screen.getByText("3 of 5 active receptionists on your plan")).toBeTruthy();
    expect(within(screen.getByLabelText("Status")).getAllByRole("option").map((option) => option.textContent)).toEqual(["All (4)", "Active (3)", "Paused (1)", "Archived (1)"]);
    expect(api.requests("GET", "/api/receptionists")[0]!.query.toString()).toBe("businessId=business&page=1&pageSize=10");
  });

  it("offers a business on Free or Starter an upgrade beside its one receptionist", async () => {
    fakeApi({ current: [FRONT_DESK], archived: [], allowance: { plan: "free", limit: 1, cap: 50, active: 1, current: 1, canAdd: false } });
    const { openUpgrade } = await openPage();
    await screen.findByText("Front desk");
    expect(screen.getByText("A receptionist for each location, team or language")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByLabelText("Status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sort A–Z" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "See plans" }));
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(openUpgrade).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tells the rest of the team who can upgrade, and shows them the list without changes", async () => {
    fakeApi({ current: [FRONT_DESK], archived: [], allowance: { plan: "starter", limit: 1, cap: 50, active: 1, current: 1, canAdd: false } });
    await openPage({ role: "viewer" });
    await screen.findByText("Front desk");
    expect(screen.getByText(/An owner or admin of the business can upgrade\./)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows schedulers and viewers every receptionist without the buttons that change them", async () => {
    for (const role of ["scheduler", "viewer"]) {
      fakeApi();
      await openPage({ role });
      await screen.findByText("Kitsilano clinic");
      expect(screen.queryByRole("button", { name: "Add receptionist" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Sort A–Z" })).toBeNull();
      expect(screen.queryByRole("button", { name: /^More options for/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
      expect(screen.getByRole("searchbox")).toBeTruthy();
      cleanup();
    }
  });

  it("says when the list can't be loaded", async () => {
    fakeApi({ reply: (call) => (call.path === "/api/receptionists" ? { status: 500, body: { error: "Request failed.", errorId: "e-1" } } : undefined) });
    await openPage();
    expect(await screen.findByText("Receptionists couldn't be loaded. Try again in a moment.")).toBeTruthy();
  });

  it("asks for a business first when there is none", async () => {
    fakeApi();
    await openPage({ businesses: [] });
    expect(screen.getByText(agent.empty.description)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("adding and editing", () => {
  it("adds a receptionist with the default one's settings, then lists it", async () => {
    const api = fakeApi();
    await openPage();
    await screen.findByText("Kitsilano clinic");
    const listsBefore = api.requests("GET", "/api/receptionists").length;
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a receptionist" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Yaletown store");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add receptionist" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Yaletown store added."));
    const [created] = api.requests("POST", "/api/receptionists");
    expect(created!.query.get("businessId")).toBe("business");
    expect(created!.body).toEqual({ name: "Yaletown store", description: "", locale: null, knowledgeScope: "audience", listed: true, copyFromId: FRONT_DESK.id });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(api.requests("GET", "/api/receptionists").length).toBeGreaterThan(listsBefore));
  });

  it("keeps the dialog open with the reason the server gave", async () => {
    fakeApi({ reply: (call) => (call.method === "POST" && call.path === "/api/receptionists" ? { status: 409, body: { error: "Another receptionist already uses this page address.", code: "handle_taken" } } : undefined) });
    await openPage();
    await screen.findByText("Kitsilano clinic");
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a receptionist" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Kitsilano");
    await userEvent.type(within(dialog).getByLabelText("Page address"), "kitsilano");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add receptionist" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Another receptionist already uses this page address.");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("sends only what changed, and nothing when nothing did", async () => {
    const api = fakeApi();
    await openPage();
    await screen.findByText("Kitsilano clinic");
    await userEvent.click(within(await openMenu("Kitsilano clinic")).getByRole("menuitem", { name: "Edit details" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit Kitsilano clinic" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.requests("PATCH", `/api/receptionists/${KITSILANO.id}`)).toHaveLength(0);

    await userEvent.click(within(await openMenu("Kitsilano clinic")).getByRole("menuitem", { name: "Edit details" }));
    dialog = await screen.findByRole("dialog", { name: "Edit Kitsilano clinic" });
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Kitsilano");
    await userEvent.selectOptions(within(dialog).getByLabelText("Language"), "");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(toast.success).toHaveBeenLastCalledWith("Kitsilano saved."));
    const [patched] = api.requests("PATCH", `/api/receptionists/${KITSILANO.id}`);
    expect(patched!.body).toEqual({ name: "Kitsilano", locale: null });
  });

  it("opens Add receptionist from a dropdown's link, once, and clears it from the address", async () => {
    navigation.params = new URLSearchParams("add=1");
    fakeApi();
    await openPage();
    expect(await screen.findByRole("dialog", { name: "Add a receptionist" })).toBeTruthy();
    expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("/agent/receptionists", { scroll: false });
  });

  it("only clears the link for someone who can't add receptionists", async () => {
    navigation.params = new URLSearchParams("add=1");
    fakeApi();
    await openPage({ role: "viewer" });
    await screen.findByText("Kitsilano clinic");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/agent/receptionists", { scroll: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("what stops another receptionist", () => {
  it("says the plan's receptionists are all active, and Add explains instead of opening", async () => {
    fakeApi({ allowance: { plan: "pro", limit: 5, cap: 50, active: 5, current: 6, canAdd: false } });
    await openPage();
    await screen.findByText("Kitsilano clinic");
    expect(screen.getByText(/^5 of 5 active receptionists on your plan All the active receptionists your plan includes are in use\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "See plans" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(receptionistsCopy.errors.limit);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when the business keeps the deployment's cap", async () => {
    fakeApi({ allowance: { plan: "enterprise", limit: 50, cap: 4, active: 3, current: 4, canAdd: false } });
    await openPage();
    await screen.findByText("Kitsilano clinic");
    expect(screen.getByText(/A business can keep up to 4 receptionists\. Archive one to add another\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See plans" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(receptionistsCopy.errors.cap);
  });
});

describe("a receptionist's menu", () => {
  it("keeps the default receptionist answering: no pause, archive or make default", async () => {
    fakeApi();
    await openPage();
    await screen.findByText("Kitsilano clinic");
    expect(within(await openMenu("Front desk")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Edit details", "AI settings"]);
    await userEvent.keyboard("{Escape}");
    expect(within(await openMenu("Billing")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Edit details", "AI settings", "Resume", "Archive"]);
    await userEvent.keyboard("{Escape}");
    expect(within(await openMenu("Kitsilano clinic")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Edit details", "AI settings", "Pause", "Make default", "Archive"]);
  });

  it("opens AI settings for that receptionist", async () => {
    fakeApi();
    await openPage();
    await screen.findByText("Kitsilano clinic");
    await userEvent.click(within(await openMenu("Kitsilano clinic")).getByRole("menuitem", { name: "AI settings" }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith(`/agent?receptionist=${KITSILANO.id}`);
  });

  it("pauses a receptionist, and explains a resume the plan has no room for", async () => {
    const api = fakeApi({ reply: (call) => ((call.body as { action?: string } | undefined)?.action === "resume" ? { status: 409, body: { error: "Your plan includes 5 active receptionists.", code: "receptionist_limit" } } : undefined) });
    await openPage();
    await screen.findByText("Kitsilano clinic");
    await userEvent.click(within(await openMenu("Kitsilano clinic")).getByRole("menuitem", { name: "Pause" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Kitsilano clinic paused. Its phone numbers, widgets and QR links answer as the default receptionist."));
    expect(api.requests("POST", `/api/receptionists/${KITSILANO.id}`)[0]!.body).toEqual({ action: "pause" });
    await userEvent.click(within(await openMenu("Billing")).getByRole("menuitem", { name: "Resume" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(receptionistsCopy.errors.limit));
  });

  it("archives after saying what happens, and restores from Archived", async () => {
    const api = fakeApi({ reply: (call) => ((call.body as { action?: string } | undefined)?.action === "restore" ? { status: 200, body: { receptionist: { ...OLD_STORE, status: "paused" } } } : undefined) });
    await openPage();
    await screen.findByText("Kitsilano clinic");
    await userEvent.click(within(await openMenu("Gastown store")).getByRole("menuitem", { name: "Archive" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Archive Gastown store?")).toBeTruthy();
    expect(within(confirm).getByText(receptionistsCopy.archive.description)).toBeTruthy();
    expect(api.requests("POST", `/api/receptionists/${GASTOWN.id}`)).toHaveLength(0);
    await userEvent.click(within(confirm).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Gastown store archived."));
    expect(api.requests("POST", `/api/receptionists/${GASTOWN.id}`)[0]!.body).toEqual({ action: "archive" });

    await userEvent.selectOptions(screen.getByLabelText("Status"), "archived");
    await screen.findByText("Old store");
    expect(api.requests("GET", "/api/receptionists").at(-1)!.query.toString()).toBe("businessId=business&view=archived&page=1&pageSize=10");
    const archivedRow = within(rowOf("Old store"));
    expect(archivedRow.getByText("Archived")).toBeTruthy();
    expect(archivedRow.getByText(/^Archived Oct 1, 2026$/)).toBeTruthy();
    expect(archivedRow.queryByRole("link")).toBeNull();
    expect(within(await openMenu("Old store")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Restore"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Old store restored, paused: the active receptionists your plan includes are all in use."));
  });

  it("makes another receptionist the default after naming what the current one keeps", async () => {
    const api = fakeApi();
    await openPage();
    await screen.findByText("Kitsilano clinic");
    await userEvent.click(within(await openMenu("Kitsilano clinic")).getByRole("menuitem", { name: "Make default" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Make Kitsilano clinic the default receptionist?")).toBeTruthy();
    await waitFor(() => expect(within(confirm).getByText(/Front desk keeps its phone numbers, widgets and QR links, and gets a page of its own\./)).toBeTruthy());
    await userEvent.click(within(confirm).getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Kitsilano clinic is the default receptionist now."));
    expect(api.requests("POST", `/api/receptionists/${KITSILANO.id}`)[0]!.body).toEqual({ action: "make_default" });
  });
});

describe("the order", () => {
  it("moves receptionists with the arrows, the default staying first", async () => {
    const api = fakeApi();
    await openPage();
    await screen.findByText("Kitsilano clinic");
    await waitFor(() => expect((screen.getByRole("button", { name: "Move Kitsilano clinic down" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Move Front desk up" })).toBeNull();
    expect((screen.getByRole("button", { name: "Move Kitsilano clinic up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Billing down" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Move Kitsilano clinic down" }));
    await waitFor(() => expect(api.requests("PUT", "/api/receptionists/order")).toHaveLength(1));
    expect(api.requests("PUT", "/api/receptionists/order")[0]!.body).toEqual({ receptionistIds: [FRONT_DESK.id, GASTOWN.id, KITSILANO.id, BILLING.id] });
  });

  it("hides the arrows while a search or a status filter leaves rows out", async () => {
    fakeApi();
    await openPage();
    await screen.findByText("Kitsilano clinic");
    await userEvent.type(screen.getByRole("searchbox"), "store");
    await waitFor(() => expect(screen.queryByText("Kitsilano clinic")).toBeNull());
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.selectOptions(screen.getByLabelText("Status"), "paused");
    await waitFor(() => expect(screen.queryByText("Kitsilano clinic")).toBeNull());
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
  });

  it("sorts A–Z after a confirmation, the default first", async () => {
    const api = fakeApi();
    await openPage();
    await screen.findByText("Kitsilano clinic");
    await userEvent.click(screen.getByRole("button", { name: "Sort A–Z" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Sort receptionists A–Z?")).toBeTruthy();
    await userEvent.click(within(confirm).getByRole("button", { name: "Sort A–Z" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Receptionists sorted A–Z."));
    expect(api.requests("PUT", "/api/receptionists/order")[0]!.body).toEqual({ receptionistIds: [FRONT_DESK.id, BILLING.id, GASTOWN.id, KITSILANO.id] });
  });
});

describe("with many receptionists", () => {
  const chain = [FRONT_DESK, ...Array.from({ length: 11 }, (_, index) => row(`c${index.toString(16)}`, `Store ${index + 1}`, { handle: `store-${index + 1}`, sortOrder: index + 2 }))];

  it("pages through them 10 at a time, and searches from the first page", async () => {
    const api = fakeApi({ current: chain, archived: [], allowance: { plan: "enterprise", limit: 50, cap: 50, active: 12, current: 12, canAdd: true } });
    await openPage();
    await screen.findByText("Store 9");
    expect(bodyRows()).toHaveLength(10);
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Store 11")).toBeTruthy();
    expect(api.requests("GET", "/api/receptionists").at(-1)!.query.get("page")).toBe("2");
    await userEvent.type(screen.getByRole("searchbox"), "Store 1");
    await waitFor(() => expect(api.requests("GET", "/api/receptionists").at(-1)!.query.toString()).toBe("businessId=business&search=Store+1&page=1&pageSize=10"));
  });

  it("filters by status from the first page", async () => {
    const api = fakeApi({ current: chain, archived: [], allowance: { plan: "enterprise", limit: 50, cap: 50, active: 12, current: 12, canAdd: true } });
    await openPage();
    await screen.findByText("Store 9");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Store 11");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "active");
    await waitFor(() => expect(api.requests("GET", "/api/receptionists").at(-1)!.query.toString()).toBe("businessId=business&status=active&page=1&pageSize=10"));
  });
});
