// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const navigation = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
  usePathname: () => "/settings/qrcode",
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
}));
vi.mock("@/i18n", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/i18n")>()), loadRouteNamespaces: vi.fn(async () => undefined) }));
vi.mock("@/lib/qr-code-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/qr-code-files")>()),
  qrCodePng: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
  qrCodeSvgFile: vi.fn(async () => new Blob(["<svg/>"], { type: "image/svg+xml" })),
  saveFile: vi.fn(),
}));

import { intlLocale } from "@/lib/locale";
import { qrCodePng, saveFile } from "@/lib/qr-code-files";

import commonEn from "../../public/locales/en/common.json";
import receptionistsEn from "../../public/locales/en/receptionists.json";
import settingsEn from "../../public/locales/en/settings.json";
import type { PublicProfileSettingsResponse } from "./live-public-profile-settings-surface";
import { fileNamePart, linkFileStem, LiveQrCodeSettingsSurface } from "./live-qr-code-settings-surface";
import { entryLinkErrorMessage, entryLinkListUrl, entryLinkName, type EntryLinkView } from "./qr-code/qr-links";
import { receptionistChoicesQueryKey, type ReceptionistOption } from "./receptionists/receptionist-choices";

// Settings → QR code with QR links: the table of the business page's code and
// the links, New link and Edit, pausing, copying an address, and the sign of
// whichever row is chosen, with its scans per day.

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "settings", interpolation: { escapeValue: false }, resources: { en: { settings: settingsEn, receptionists: receptionistsEn, common: commonEn } } });
});

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: name.toLowerCase(), isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, handle: null, knowledgeScope: "all" });
const SALES = receptionist("00000000-0000-4000-8000-0000000000a2", "Sales", { sortOrder: 1 });
const REPAIRS = receptionist("00000000-0000-4000-8000-0000000000a3", "Repairs", { sortOrder: 2, status: "paused" });
const SHOP = [FRONT_DESK, SALES, REPAIRS];
const ARCHIVED_ID = "00000000-0000-4000-8000-0000000000a9";

const PAGE_URL = "https://app.example.com/profile/acme-bikes";
const KEY = "0b8f5f8e-3c55-4a43-9d6a-2f4f3f1c9a01";

/** 30 days of scans, from October 5 to November 3, with these counts at the end. */
function recent(...last: number[]) {
  return { from: "2026-10-05", counts: [...Array.from({ length: 30 - last.length }, () => 0), ...last] };
}

let sequence = 0;
function link(label: string, receptionistId: string, values: Partial<EntryLinkView> = {}): EntryLinkView {
  sequence += 1;
  const counts = values.recentScans?.counts ?? Array.from({ length: 30 }, () => 0);
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    code: `c${String(sequence).padStart(5, "0")}`,
    label,
    status: "active",
    receptionistId,
    opensReceptionistId: receptionistId,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    scansLast30Days: counts.reduce((sum, count) => sum + count, 0),
    scansKept: 0,
    lastScannedOn: null,
    recentScans: { from: "2026-10-05", counts },
    ...values,
  };
}

function view(settings: Partial<PublicProfileSettingsResponse["settings"]> = {}): PublicProfileSettingsResponse {
  return {
    saved: true,
    slug: "acme-bikes",
    businessName: "Acme Bikes",
    publishedAt: "2026-09-01T00:00:00.000Z",
    settings: {
      published: true,
      category: null,
      description: null,
      address: { line1: null, line2: null, city: null, region: null, postalCode: null, countryCode: null },
      publicEmail: null,
      showPhone: true,
      showHours: true,
      showServices: true,
      showMap: true,
      widgetKeyId: KEY,
      ...settings,
    },
    widgetKeys: [{ id: KEY, label: "Main website", lastUsedAt: null, createdAt: "2026-09-01T12:00:00.000Z" }],
    url: PAGE_URL,
    canEdit: true,
  };
}

type Refusal = { status: number; body: Record<string, unknown> };
const clients: QueryClient[] = [];
const writeText = vi.fn(async (_text: string) => undefined);

async function setup({ receptionists = SHOP, links = [] as EntryLinkView[], role = "business_owner", profile = view(), refuseCreate, refusePatch, failFirstList = false }: { receptionists?: ReceptionistOption[]; links?: EntryLinkView[]; role?: string; profile?: PublicProfileSettingsResponse; refuseCreate?: Refusal; refusePatch?: Refusal; failFirstList?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Acme Bikes", active: true, role, slug: "acme-bikes", defaultLocale: "en" }] });
  client.setQueryData(receptionistChoicesQueryKey("business"), { receptionists });
  // The server's links, newest first, which saved changes update.
  let server = links.map((entry) => ({ ...entry }));
  const opens = (entry: EntryLinkView) => {
    const named = receptionists.find((candidate) => candidate.id === entry.receptionistId);
    return entry.status === "active" && named?.status === "active" ? entry.receptionistId : FRONT_DESK.id;
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url, "https://app.example.com");
    if (pathname === "/api/business-profile") return Response.json(profile);
    if (pathname === "/api/receptionists/choices") return Response.json({ receptionists });
    if (pathname === "/api/entry-links" && init?.method === "POST") {
      if (refuseCreate) return Response.json(refuseCreate.body, { status: refuseCreate.status });
      const body = JSON.parse(String(init.body)) as { label: string; receptionistId: string };
      const created = link(body.label, body.receptionistId, { code: "new4ab" });
      server = [{ ...created, opensReceptionistId: opens(created) }, ...server];
      return Response.json({ link: server[0] }, { status: 201 });
    }
    const one = /^\/api\/entry-links\/([^/]+)$/.exec(pathname);
    if (one && init?.method === "PATCH") {
      if (refusePatch) return Response.json(refusePatch.body, { status: refusePatch.status });
      const patch = JSON.parse(String(init.body)) as Partial<EntryLinkView>;
      server = server.map((entry) => {
        if (entry.id !== one[1]) return entry;
        const changed = { ...entry, ...patch };
        return { ...changed, opensReceptionistId: opens(changed) };
      });
      return Response.json({ link: server.find((entry) => entry.id === one[1]) });
    }
    if (pathname === "/api/entry-links") {
      if (failFirstList) {
        failFirstList = false;
        return Response.json({ error: "Something went wrong." }, { status: 500 });
      }
      const search = searchParams.get("search")?.toLowerCase();
      const receptionistId = searchParams.get("receptionist");
      const page = Number(searchParams.get("page") ?? 1);
      const matching = server.filter((entry) => (!receptionistId || entry.receptionistId === receptionistId) && (!search || entry.label.toLowerCase().includes(search) || entry.code.includes(search)));
      return Response.json({ links: matching.slice((page - 1) * 10, page * 10), total: matching.length, page, pageSize: 10 });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><LiveQrCodeSettingsSurface /></QueryClientProvider></I18nextProvider>);
  // The page shows once the business page's address loads.
  await screen.findByText("Your QR codes");
  const requests = (method: string, path: string) => fetchMock.mock.calls
    .filter(([url, init]) => (init?.method ?? "GET") === method && new URL(url, "https://app.example.com").pathname.startsWith(path))
    .map(([url, init]) => {
      const parsed = new URL(url, "https://app.example.com");
      return { path: parsed.pathname, params: parsed.searchParams, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
    });
  return { client, fetchMock, requests };
}

beforeEach(() => {
  navigation.params = new URLSearchParams();
  // jsdom has no canvas, so text widths are estimated.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const linksCard = () => screen.getByText("Your QR codes").closest("[data-slot='card']") as HTMLElement;
const signCard = () => screen.getByRole("region", { name: / sign$/ }) as HTMLElement;
const rowOf = (name: string) => within(linksCard()).getByRole("button", { name }).closest("tr") as HTMLElement;
const tableText = () => within(linksCard()).getAllByRole("row").slice(1).map((row) => row.querySelector("button")?.textContent ?? row.textContent);
const preview = () => screen.getByRole("img", { name: /^Preview of the/ });
const message = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

async function openMenu(name: string) {
  await userEvent.click(within(rowOf(name)).getByRole("button", { name: `More options for ${name}` }));
  return await screen.findByRole("menu");
}

describe("the QR codes table", () => {
  it("lists the business page's code first, then each link with who answers it, where it opens and its scans", async () => {
    const frontWindow = link("Front window", SALES.id, { recentScans: recent(2, 0, 4) });
    const counter = link("Repair counter", REPAIRS.id, { opensReceptionistId: FRONT_DESK.id });
    await setup({ links: [frontWindow, counter] });
    await within(linksCard()).findByText("Front window");
    expect(within(linksCard()).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Link", "Answered by", "Opens", "Scans, 30 days", "Actions"]);
    expect(tableText()).toEqual(["Business page", "Front window", "Repair counter"]);

    const page = rowOf("Business page");
    expect(page.getAttribute("data-state")).toBe("selected");
    expect(within(page).getByText("Front desk")).toBeTruthy();
    expect(within(page).getByText("/profile/acme-bikes")).toBeTruthy();
    expect(within(page).getByText("Not counted")).toBeTruthy();

    const front = rowOf("Front window");
    expect(within(front).getByText("Sales")).toBeTruthy();
    expect(within(front).getByText(`/q/${frontWindow.code}`)).toBeTruthy();
    expect(within(front).getByText("6")).toBeTruthy();
    expect(front.querySelector("[data-slot='scans-sparkline']")).not.toBeNull();

    // Repairs is paused, so the default receptionist answers its sign meanwhile.
    expect(within(rowOf("Repair counter")).getByText("Front desk answers for now")).toBeTruthy();
    expect(within(rowOf("Repair counter")).getByText("0")).toBeTruthy();
    expect(within(linksCard()).getByText("Each row's menu changes its receptionist, pauses it or copies its address. A paused link opens your business page, and a link whose receptionist is paused or archived answers as Front desk.")).toBeTruthy();
  });

  it("marks a paused link, and a link whose receptionist was archived", async () => {
    await setup({ links: [link("Old flyer", SALES.id, { status: "paused", opensReceptionistId: FRONT_DESK.id }), link("Closed store", ARCHIVED_ID, { opensReceptionistId: FRONT_DESK.id })] });
    await within(linksCard()).findByText("Old flyer");
    const flyer = rowOf("Old flyer");
    expect(within(flyer).getByText("Paused")).toBeTruthy();
    expect(within(flyer).getByText("Front desk answers for now")).toBeTruthy();
    expect(within(rowOf("Closed store")).getByText("Archived receptionist")).toBeTruthy();
  });

  it("leaves out who answers while the business has one receptionist", async () => {
    await setup({ receptionists: [FRONT_DESK], links: [link("Front window", FRONT_DESK.id)] });
    await within(linksCard()).findByText("Front window");
    expect(within(linksCard()).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Link", "Opens", "Scans, 30 days", "Actions"]);
    expect(screen.getByText("Put them on your door, counter or tables. Each code opens your page and counts its own scans.")).toBeTruthy();
    expect(within(linksCard()).queryByRole("combobox")).toBeNull();
    expect(within(linksCard()).getByText("Each row's menu renames it, pauses it or copies its address. A paused link opens your business page.")).toBeTruthy();
  });

  it("asks for the first link when there's none", async () => {
    await setup();
    expect(await within(linksCard()).findByText("No links yet. Make one for each sign to see which one gets scanned.")).toBeTruthy();
    expect(tableText()[0]).toBe("Business page");
  });

  it("searches and pages through many links, 10 at a time", async () => {
    const many = Array.from({ length: 12 }, (_, index) => link(`Table ${12 - index}`, SALES.id));
    const { requests } = await setup({ links: many });
    await within(linksCard()).findByText("Table 12");
    expect(within(linksCard()).getByText("1–10 of 12")).toBeTruthy();
    expect(tableText()).toHaveLength(11);

    await userEvent.click(within(linksCard()).getByRole("button", { name: "Next page" }));
    await within(linksCard()).findByText("Table 2");
    // The business page's code heads the first page only.
    expect(tableText()).toEqual(["Table 2", "Table 1"]);
    expect(within(linksCard()).getByText("11–12 of 12")).toBeTruthy();
    expect((within(linksCard()).getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(linksCard()).getByPlaceholderText("Search 12 links"), { target: { value: "table 1" } });
    await waitFor(() => expect(tableText()).toEqual(["Table 12", "Table 11", "Table 10", "Table 1"]));
    const last = requests("GET", "/api/entry-links").at(-1)!;
    expect(last.params.get("search")).toBe("table 1");
    expect(last.params.get("page")).toBe("1");
  });

  it("shows one receptionist's links when the address names one", async () => {
    navigation.params = new URLSearchParams({ receptionist: SALES.id });
    const { requests } = await setup({ links: [link("Front window", SALES.id), link("Repair counter", REPAIRS.id)] });
    await within(linksCard()).findByText("Front window");
    expect(tableText()).toEqual(["Front window"]);
    expect(requests("GET", "/api/entry-links").at(-1)!.params.get("receptionist")).toBe(SALES.id);
    expect(within(linksCard()).getByRole("combobox", { name: /^Receptionist Sales/ })).toBeTruthy();
  });

  it("keeps the business page's code in the default receptionist's list", async () => {
    navigation.params = new URLSearchParams({ receptionist: FRONT_DESK.id });
    await setup({ links: [link("Desk", FRONT_DESK.id)] });
    await within(linksCard()).findByText("Desk");
    expect(tableText()).toEqual(["Business page", "Desk"]);
  });

  it("says when the links can't be loaded, and tries again", async () => {
    await setup({ links: [link("Front window", SALES.id)], failFirstList: true });
    expect(await within(linksCard()).findByText("Your QR links can't be loaded right now.")).toBeTruthy();
    // The business page's own code is still there to print.
    expect(within(signCard()).getByText("Business page sign")).toBeTruthy();
    await userEvent.click(within(linksCard()).getByRole("button", { name: "Try again" }));
    expect(await within(linksCard()).findByText("Front window")).toBeTruthy();
    expect(within(linksCard()).queryByText("Your QR links can't be loaded right now.")).toBeNull();
  });
});

describe("making and changing links", () => {
  it("makes a link for the receptionist picked and shows its sign", async () => {
    const { requests } = await setup();
    await within(linksCard()).findByText("No links yet. Make one for each sign to see which one gets scanned.");
    await userEvent.click(within(linksCard()).getByRole("button", { name: "New link" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Make a QR code that opens your page with one receptionist answering.")).toBeTruthy();
    expect((within(dialog).getByLabelText("Address") as HTMLInputElement).value).toBe("app.example.com/q/······");
    expect(within(dialog).getByRole("combobox", { name: "Answered by Front desk" })).toBeTruthy();

    // A label is needed.
    await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    expect(within(dialog).getByText("Give the link a label, such as where its sign hangs.")).toBeTruthy();
    expect(requests("POST", "/api/entry-links")).toEqual([]);

    await userEvent.type(within(dialog).getByLabelText("Label"), "  Front   window ");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Answered by Front desk" }));
    await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /^Sales/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Front window is ready. Its sign is below."));
    expect(requests("POST", "/api/entry-links").map((request) => request.body)).toEqual([{ label: "Front window", receptionistId: SALES.id }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(signCard()).getByText("Front window sign")).toBeTruthy();
    expect(within(signCard()).getByText("https://app.example.com/q/new4ab")).toBeTruthy();
    await waitFor(() => expect(rowOf("Front window").getAttribute("data-state")).toBe("selected"));
  });

  it("starts a new link with the receptionist the list shows", async () => {
    navigation.params = new URLSearchParams({ receptionist: SALES.id });
    await setup();
    await userEvent.click(await within(linksCard()).findByRole("button", { name: "New link" }));
    expect(within(screen.getByRole("dialog")).getByRole("combobox", { name: "Answered by Sales" })).toBeTruthy();
  });

  it("explains a refused link in the dialog", async () => {
    await setup({ refuseCreate: { status: 409, body: { error: "A business can keep up to 1000 QR links.", code: "entry_link_limit" } } });
    await userEvent.click(await within(linksCard()).findByRole("button", { name: "New link" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Label"), "Patio");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Your business has 1,000 QR links, the most it can keep. Change a paused one instead.");
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("changes who answers a link, sending only what changed", async () => {
    const frontWindow = link("Front window", SALES.id);
    const { requests } = await setup({ links: [frontWindow] });
    await within(linksCard()).findByText("Front window");
    await userEvent.click(within(await openMenu("Front window")).getByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Edit link")).toBeTruthy();
    expect((within(dialog).getByLabelText("Label") as HTMLInputElement).value).toBe("Front window");
    expect((within(dialog).getByLabelText("Address") as HTMLInputElement).value).toBe(`app.example.com/q/${frontWindow.code}`);
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Answered by Sales" }));
    await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /^Front desk/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Front window saved."));
    expect(requests("PATCH", "/api/entry-links/").map(({ path, body }) => ({ path, body }))).toEqual([{ path: `/api/entry-links/${frontWindow.id}`, body: { receptionistId: FRONT_DESK.id } }]);
    await waitFor(() => expect(within(rowOf("Front window")).getByText("Front desk")).toBeTruthy());
  });

  it("pauses a link and resumes it from its menu", async () => {
    const { requests } = await setup({ links: [link("Front window", SALES.id)] });
    await within(linksCard()).findByText("Front window");
    await userEvent.click(within(await openMenu("Front window")).getByRole("menuitem", { name: "Pause" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Front window is paused. Its sign opens your business page until you resume it."));
    await waitFor(() => expect(within(rowOf("Front window")).getByText("Paused")).toBeTruthy());
    await userEvent.click(within(await openMenu("Front window")).getByRole("menuitem", { name: "Resume" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Front window is on again."));
    expect(requests("PATCH", "/api/entry-links/").map((request) => request.body)).toEqual([{ status: "paused" }, { status: "active" }]);
  });

  it("explains a refused pause", async () => {
    await setup({ links: [link("Front window", SALES.id)], refusePatch: { status: 404, body: { error: "QR link not found.", code: "entry_link_not_found" } } });
    await within(linksCard()).findByText("Front window");
    await userEvent.click(within(await openMenu("Front window")).getByRole("menuitem", { name: "Pause" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("That isn't there any more. Refresh the page."));
  });

  it("copies a link's address, or says what it is when copying fails", async () => {
    const frontWindow = link("Front window", SALES.id);
    await setup({ links: [frontWindow] });
    await within(linksCard()).findByText("Front window");
    await userEvent.click(within(await openMenu("Front window")).getByRole("menuitem", { name: "Copy address" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://app.example.com/q/${frontWindow.code}`));
    expect(toasts.success).toHaveBeenCalledWith("Address copied.");

    writeText.mockRejectedValueOnce(new Error("Denied"));
    await userEvent.click(within(await openMenu("Business page")).getByRole("menuitem", { name: "Copy address" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(`The address couldn't be copied. It's ${PAGE_URL}`));
  });

  it("lets members who can't change links see them and copy their addresses", async () => {
    await setup({ role: "viewer", links: [link("Front window", SALES.id)] });
    await within(linksCard()).findByText("Front window");
    expect(within(linksCard()).queryByRole("button", { name: "New link" })).toBeNull();
    const menu = await openMenu("Front window");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy address"]);
    expect(within(linksCard()).getByText(/^Each row's menu copies its address\./)).toBeTruthy();
  });
});

describe("the sign of the chosen code", () => {
  it("starts with the business page's sign, whose scans aren't counted", async () => {
    await setup({ links: [link("Front window", SALES.id)] });
    await within(linksCard()).findByText("Front window");
    expect(within(signCard()).getByText("Business page sign")).toBeTruthy();
    expect(within(signCard()).getByText(PAGE_URL)).toBeTruthy();
    expect(within(signCard()).getByRole("link", { name: "Open page" }).getAttribute("href")).toBe(PAGE_URL);
    expect(message().value).toBe("Questions?\nAsk us any time.");
    expect(within(preview()).getByText("Scan to chat with us")).toBeTruthy();
    expect(within(signCard()).getByText("Scans of the business page sign aren't counted. Make a link for a sign to count its scans.")).toBeTruthy();
  });

  it("invites visitors to the link's receptionist by name and opens that receptionist's page", async () => {
    const frontWindow = link("Front window", SALES.id, { recentScans: recent(3, 0, 5) });
    await setup({ links: [frontWindow] });
    await userEvent.click(await within(linksCard()).findByRole("button", { name: "Front window" }));
    expect(within(signCard()).getByText("Front window sign")).toBeTruthy();
    expect(within(signCard()).getByText(`https://app.example.com/q/${frontWindow.code}`)).toBeTruthy();
    // Checking the page goes straight to it, so it doesn't count as a scan.
    expect(within(signCard()).getByRole("link", { name: "Open page" }).getAttribute("href")).toBe("https://app.example.com/profile/acme-bikes/sales");
    expect(message().value).toBe("Questions?\nAsk Sales.");
    expect(within(preview()).getByText("Scan to chat with Sales")).toBeTruthy();
    expect(within(preview()).getByText(`/q/${frontWindow.code}`)).toBeTruthy();
    expect((within(signCard()).getByLabelText("Link") as HTMLSelectElement).value).toBe(frontWindow.id);
    expect(within(signCard()).getByRole("img", { name: "Scans per day" })).toBeTruthy();
    expect(within(signCard()).getByText(/^8 scans, October 5/)).toBeTruthy();
  });

  it("keeps the general words for a link the default receptionist answers, and a page without chat", async () => {
    const desk = link("Desk", FRONT_DESK.id);
    await setup({ links: [desk], profile: view({ widgetKeyId: null }) });
    await userEvent.click(await within(linksCard()).findByRole("button", { name: "Desk" }));
    expect(message().value).toBe("Questions?\nAsk us any time.");
    expect(within(preview()).getByText("Scan to visit our page")).toBeTruthy();
    expect(within(signCard()).getByRole("link", { name: "Open page" }).getAttribute("href")).toBe(PAGE_URL);
  });

  it("says when the chosen link opens someone else for now", async () => {
    const flyer = link("Old flyer", SALES.id, { status: "paused", opensReceptionistId: FRONT_DESK.id });
    const counter = link("Repair counter", REPAIRS.id, { opensReceptionistId: FRONT_DESK.id });
    await setup({ links: [flyer, counter] });
    await userEvent.click(await within(linksCard()).findByRole("button", { name: "Old flyer" }));
    expect(within(signCard()).getByText("This link is paused, so its sign opens your business page until you resume it.")).toBeTruthy();
    expect(within(signCard()).getByRole("link", { name: "Open page" }).getAttribute("href")).toBe(PAGE_URL);
    await userEvent.click(within(linksCard()).getByRole("button", { name: "Repair counter" }));
    expect(within(signCard()).getByText("Repairs is paused, so Front desk answers for now.")).toBeTruthy();
  });

  it("starts each code's message over from its own, and switches codes from the Link dropdown", async () => {
    const frontWindow = link("Front window", SALES.id);
    const counter = link("Repair counter", REPAIRS.id, { opensReceptionistId: FRONT_DESK.id });
    await setup({ links: [frontWindow, counter] });
    await userEvent.click(await within(linksCard()).findByRole("button", { name: "Front window" }));
    fireEvent.change(message(), { target: { value: "New bike?\nAsk Sales." } });
    fireEvent.change(within(signCard()).getByLabelText("Link"), { target: { value: counter.id } });
    expect(within(signCard()).getByText("Repair counter sign")).toBeTruthy();
    expect(message().value).toBe("Questions?\nAsk Repairs.");
    expect(rowOf("Repair counter").getAttribute("data-state")).toBe("selected");
    fireEvent.change(within(signCard()).getByLabelText("Link"), { target: { value: "" } });
    expect(within(signCard()).getByText("Business page sign")).toBeTruthy();
  });

  it("downloads a link's code named after the page, the label and the code", async () => {
    const frontWindow = link("Front window", SALES.id);
    await setup({ links: [frontWindow] });
    await userEvent.click(await within(linksCard()).findByRole("button", { name: "Front window" }));
    await userEvent.click(screen.getByRole("button", { name: "Code as PNG" }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith(expect.any(Blob), `acme-bikes-front-window-${frontWindow.code}-qr-code.png`));
    const [drawing, options] = vi.mocked(qrCodePng).mock.calls[0]!;
    expect(drawing).toMatchObject({ text: `https://app.example.com/q/${frontWindow.code}` });
    expect(options.title).toBe(`QR code that opens https://app.example.com/q/${frontWindow.code}`);
  });
});

describe("QR link helpers", () => {
  const t = (key: string, options: Record<string, string>) => i18n.t(key, options);

  it("names a link by its label, or its code without one", () => {
    expect(entryLinkName({ label: "Patio", code: "ab23cd" }, t)).toBe("Patio");
    expect(entryLinkName({ label: "", code: "ab23cd" }, t)).toBe("Link ab23cd");
  });

  it("asks the server for a page of links, filtered and searched", () => {
    expect(entryLinkListUrl("business", { search: "", page: 1, receptionistId: null })).toBe("/api/entry-links?businessId=business&page=1");
    expect(entryLinkListUrl("business", { search: "front window", page: 3, receptionistId: SALES.id })).toBe(`/api/entry-links?businessId=business&page=3&search=front+window&receptionist=${SALES.id}`);
  });

  it("explains each refusal in the dashboard's words", () => {
    expect(entryLinkErrorMessage({ code: "entry_link_code_unavailable" }, t, "en")).toBe("A new code couldn't be made just now. Try again.");
    expect(entryLinkErrorMessage({ code: "invalid_label" }, t, "en")).toBe("Labels can be up to 80 characters.");
    expect(entryLinkErrorMessage({ code: "entry_link_limit" }, t, "en")).toBe("Your business has 1,000 QR links, the most it can keep. Change a paused one instead.");
    expect(entryLinkErrorMessage({ code: "entry_link_limit" }, t, "fr")).toContain(new Intl.NumberFormat(intlLocale("fr")).format(1000));
    expect(entryLinkErrorMessage({ code: "receptionist_archived" }, t, "en")).toBe("That receptionist was archived. Refresh the page and pick another one.");
    expect(entryLinkErrorMessage({ code: "entry_link_not_found" }, t, "en")).toBe("That isn't there any more. Refresh the page.");
    expect(entryLinkErrorMessage({ code: "boom", errorId: "err_1" }, t, "en")).toContain("err_1");
  });

  it("names a link's download after the page, the label in plain letters and the code", () => {
    expect(fileNamePart("Café — Front window #2")).toBe("cafe-front-window-2");
    expect(fileNamePart("Ресепција")).toBe("");
    expect(fileNamePart(`${"Very long label ".repeat(5)}`)).toBe("very-long-label-very-long-label-very-lon");
    expect(linkFileStem("acme-bikes", { label: "Front window", code: "ab23cd" })).toBe("acme-bikes-front-window-ab23cd");
    expect(linkFileStem("acme-bikes", { label: "Ресепција", code: "ab23cd" })).toBe("acme-bikes-ab23cd");
  });
});
