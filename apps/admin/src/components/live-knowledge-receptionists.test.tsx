// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import agentEn from "../../public/locales/en/agent.json";
import commonEn from "../../public/locales/en/common.json";
import receptionistsEn from "../../public/locales/en/receptionists.json";
import { knowledgeAudienceQueryKey, type KnowledgeAudienceLinks } from "./knowledge-audience";
import { LiveKnowledgeSurface } from "./live-knowledge-surface";
import { receptionistChoicesQueryKey, type ReceptionistOption } from "./receptionists/receptionist-choices";
import { testNavigation } from "@/lib/navigation-testing";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";

// The Knowledge page of a business with several receptionists: the Available
// to column, the receptionist filter, bulk changes, Available to for one
// article, website page rules, and who a new article is for.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => createRecordedBrowserTelemetry().telemetry }));
vi.mock("@/lib/browser-error-reporting", () => ({ captureBrowserError: vi.fn() }));
vi.mock("next/navigation", async () => (await import("@/lib/navigation-testing")).nextNavigationMock);

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "agent", interpolation: { escapeValue: false }, resources: { en: { agent: agentEn, common: commonEn, receptionists: receptionistsEn } } });
});
const clients: QueryClient[] = [];
beforeEach(() => { testNavigation.reset("/agent/knowledge"); });
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 1, locale: null, knowledgeScope: "audience", ...values };
}
const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all", sortOrder: 0 });
const SALES = receptionist("00000000-0000-4000-8000-0000000000a2", "Sales", { sortOrder: 1 });
const SUPPORT = receptionist("00000000-0000-4000-8000-0000000000a3", "Support", { sortOrder: 2 });
const TEAM = [FRONT_DESK, SALES, SUPPORT];
const ARCHIVED = "00000000-0000-4000-8000-0000000000ee";
const RULE = "00000000-0000-4000-8000-0000000000f1";

const at = (day: number) => `2026-10-${day.toString().padStart(2, "0")}T12:00:00Z`;
const knowledgeDocument = (id: string, title: string, day: number, values: Record<string, unknown> = {}) => ({ id, title, sourceType: "upload", sourceUrl: null, storageObjectId: null, status: "indexed", active: true, textContent: `${title} text`, processingProgress: null, audience: "everyone", websiteImport: null, createdAt: at(day), updatedAt: at(day), ...values });
const PRICE_LIST = knowledgeDocument("00000000-0000-4000-8000-0000000000c1", "2026 price list.pdf", 28, { audience: "chosen" });
const E_BIKES = knowledgeDocument("00000000-0000-4000-8000-0000000000c2", "northsidebikes.ca/bikes/e-bikes", 27, { sourceType: "website", sourceUrl: "https://northsidebikes.ca/bikes/e-bikes", audience: "chosen" });
const SPRING_SALE = knowledgeDocument("00000000-0000-4000-8000-0000000000c3", "Spring sale.pdf", 5, { audience: "chosen" });
const SITE = knowledgeDocument("00000000-0000-4000-8000-0000000000c4", "northsidebikes.ca", 2, { sourceType: "website", sourceUrl: "https://northsidebikes.ca/", websiteImport: { id: "job", status: "completed", websiteUrl: "https://northsidebikes.ca/", importedCount: 12, indexedCount: 12 } });
const snippet = (id: string, title: string, day: number, values: Record<string, unknown> = {}) => ({ id, title, content: `${title}: details.`, tags: [], priority: 75, active: true, audience: "everyone", createdAt: at(day), ...values });
const HOURS = snippet("00000000-0000-4000-8000-0000000000b1", "Opening hours and holidays", 30);
const WARRANTY = snippet("00000000-0000-4000-8000-0000000000b2", "Warranty claims", 20, { audience: "chosen" });
const LINKS: KnowledgeAudienceLinks = {
  documents: {
    [PRICE_LIST.id]: [{ receptionistId: SALES.id, websiteRuleId: null }],
    [E_BIKES.id]: [{ receptionistId: SALES.id, websiteRuleId: RULE }],
    [SPRING_SALE.id]: [{ receptionistId: ARCHIVED, websiteRuleId: null }],
  },
  snippets: { [WARRANTY.id]: [SUPPORT.id] },
};
const BIKES_RULE = { id: RULE, rootDocumentId: SITE.id, siteUrl: "https://northsidebikes.ca/", pathPrefix: "/bikes/", receptionistId: SALES.id, createdAt: at(27), pages: 9 };

type Setup = { receptionists?: ReceptionistOption[]; role?: string; documents?: Array<Record<string, unknown>>; snippets?: Array<Record<string, unknown>> };
function setup({ receptionists = TEAM, role = "business_owner", documents = [PRICE_LIST, E_BIKES, SPRING_SALE, SITE], snippets = [HOURS, WARRANTY] }: Setup = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Northside Bikes", slug: "northside-bikes", active: true, role }] });
  client.setQueryData(receptionistChoicesQueryKey("business"), { receptionists });
  client.setQueryData(["knowledge", "business"], { documents });
  client.setQueryData(["knowledge-snippets", "business"], { snippets });
  client.setQueryData(knowledgeAudienceQueryKey("business"), LINKS);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/uploads" && init?.method === "POST") return Response.json({ objectId: "object", url: "https://uploads.example.invalid/object" });
    if (url === "https://uploads.example.invalid/object") return new Response(null, { status: 200 });
    if (init?.method && init.method !== "GET") return Response.json({ ok: true, documents: 1, snippets: 1 });
    if (url.startsWith("/api/knowledge/website-rules")) return Response.json({ rules: [BIKES_RULE] });
    if (url.startsWith("/api/knowledge/audience")) return Response.json(LINKS);
    if (url.startsWith("/api/knowledge/snippets")) return Response.json({ snippets });
    if (url.startsWith("/api/receptionists/choices")) return Response.json({ receptionists });
    if (url.startsWith("/api/knowledge?")) return Response.json({ documents });
    return Response.json({ document: documents[0], content: "Readable extracted content" });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><LiveKnowledgeSurface /></QueryClientProvider></I18nextProvider>);
  const sent = (method: string, prefix: string) => fetchMock.mock.calls.filter(([url, init]) => init?.method === method && url.startsWith(prefix)).map(([url, init]) => ({ url, body: JSON.parse(String(init!.body ?? "null")) }));
  return { fetchMock, client, sent };
}

const table = () => screen.getByRole("table");
const titles = () => within(table()).getAllByRole("row").slice(1).map((row) => within(row).queryAllByRole("cell")[1]?.textContent ?? row.textContent);
const rowOf = (title: string) => screen.getByText(title, { selector: "span[title]" }).closest("tr")!;
const filter = () => screen.getByRole("combobox", { name: /^Receptionist/ });

async function choose(combobox: HTMLElement, ...names: string[]) {
  await userEvent.click(combobox);
  for (const name of names) await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(name) }));
}

describe("who each article is for", () => {
  it("puts Available to where the preview was, with Everyone, names, a rule's page and an article left to the default receptionist", () => {
    setup();
    const headers = within(table()).getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toContain("Available to");
    expect(headers).not.toContain("Preview");
    expect(titles()).toEqual(["Opening hours and holidays", "2026 price list.pdf", "northsidebikes.ca/bikes/e-bikes", "Warranty claims", "Spring sale.pdf", "northsidebikes.ca"]);
    const availableTo = (title: string) => within(rowOf(title)).getAllByRole("cell")[2]!.textContent;
    expect(availableTo("Opening hours and holidays")).toBe("Everyone");
    expect(availableTo("2026 price list.pdf")).toBe("Sales");
    expect(availableTo("northsidebikes.ca/bikes/e-bikes")).toBe("Salesby rule");
    expect(availableTo("Warranty claims")).toBe("Support");
    expect(availableTo("Spring sale.pdf")).toBe("Default receptionist only");
    expect(availableTo("northsidebikes.ca")).toBe("Everyone");
  });

  it("keeps the page as it was while the business has one receptionist", () => {
    const { fetchMock } = setup({ receptionists: [FRONT_DESK] });
    const headers = within(table()).getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toContain("Preview");
    expect(headers).not.toContain("Available to");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Website rules" })).toBeNull();
    expect(screen.queryByText("Showing every article. Pick a receptionist to see exactly what it can use.")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith("/api/knowledge/audience"))).toBe(false);
  });
});

describe("the receptionist filter", () => {
  it("shows what one receptionist can use, kept in the address", async () => {
    setup();
    expect(screen.getByText("Showing every article. Pick a receptionist to see exactly what it can use.")).toBeTruthy();
    await choose(filter(), "Sales");
    expect(testNavigation.router.replace).toHaveBeenLastCalledWith(`/agent/knowledge?receptionist=${SALES.id}`, { scroll: false });
    expect(titles()).toEqual(["Opening hours and holidays", "2026 price list.pdf", "northsidebikes.ca/bikes/e-bikes", "northsidebikes.ca"]);
    expect(screen.getByText("Showing what Sales can use: articles for everyone and the ones chosen for it.")).toBeTruthy();
  });

  it("opens on the receptionist a shared link names, and shows everything for one that answers from every article", () => {
    testNavigation.set(`/agent/knowledge?receptionist=${SUPPORT.id}`);
    setup();
    expect(titles()).toEqual(["Opening hours and holidays", "Warranty claims", "northsidebikes.ca"]);
    cleanup();
    testNavigation.set(`/agent/knowledge?receptionist=${FRONT_DESK.id}`);
    setup();
    expect(titles()).toHaveLength(6);
    expect(screen.getByText("Front desk answers from every article.")).toBeTruthy();
  });

  it("says nothing matches when a search and the filter leave no article", async () => {
    testNavigation.set(`/agent/knowledge?receptionist=${SUPPORT.id}`);
    setup();
    await userEvent.type(screen.getByPlaceholderText("Search entries"), "price");
    expect(screen.getByText("No matching entries found.")).toBeTruthy();
  });

  it("starts again from the first page when the filter changes", async () => {
    const many = Array.from({ length: 12 }, (_, index) => snippet(`00000000-0000-4000-8000-0000000002${index.toString().padStart(2, "0")}`, `Store ${index + 1} hours`, 30 - index));
    setup({ documents: [], snippets: many });
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getAllByText("Page 2 of 2").length).toBeGreaterThan(0);
    await choose(filter(), "Support");
    expect(screen.getAllByText("Page 1 of 2").length).toBeGreaterThan(0);
  });
});

describe("Available to for the selected articles", () => {
  it("selects articles row by row or a page at a time", async () => {
    setup();
    const pageBox = screen.getByRole("checkbox", { name: "Select the articles on this page" });
    await userEvent.click(screen.getByRole("checkbox", { name: "Select 2026 price list.pdf" }));
    expect(screen.getByRole("status").textContent).toBe("1 selected");
    expect(pageBox.getAttribute("aria-checked")).toBe("mixed");
    expect(rowOf("2026 price list.pdf").getAttribute("data-state")).toBe("selected");
    await userEvent.click(pageBox);
    expect(screen.getByRole("status").textContent).toBe("6 selected");
    expect(pageBox.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("changes who the selected files, pages and text entries are for in one request, then clears the selection", async () => {
    const { sent } = setup();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select 2026 price list.pdf" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Warranty claims" }));
    await userEvent.click(screen.getByRole("button", { name: "Available to" }));
    await userEvent.click(screen.getByRole("radio", { name: "Replace" }));
    await choose(screen.getByRole("combobox", { name: /^Receptionists it's available to/ }), "Support");
    await userEvent.click(screen.getByRole("button", { name: "Apply to 2 articles" }));
    await waitFor(() => expect(sent("POST", "/api/knowledge/audience")).toEqual([{ url: "/api/knowledge/audience?businessId=business", body: { documentIds: [PRICE_LIST.id], snippetIds: [WARRANTY.id], audience: "chosen", mode: "replace", receptionistIds: [SUPPORT.id] } }]));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("opening a row's checkbox never opens the row", async () => {
    setup();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Warranty claims" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Available to and page rules from a row", () => {
  it("changes who one article is for from its menu", async () => {
    const { sent } = setup();
    await userEvent.click(within(rowOf("Warranty claims")).getByRole("button", { name: "More options" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Available to" }));
    const dialog = await screen.findByRole("dialog", { name: "Available to" });
    expect(within(dialog).getByText("Who can use “Warranty claims”.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Remove Support" })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Everyone" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent("POST", "/api/knowledge/audience").map((request) => request.body)).toEqual([{ documentIds: [], snippetIds: [WARRANTY.id], audience: "everyone" }]));
  });

  it("opens a website's page rules from its row, and every site's from the toolbar", async () => {
    setup();
    expect(within(rowOf("2026 price list.pdf")).queryByRole("button", { name: "More options" })).toBeTruthy();
    await userEvent.click(within(rowOf("2026 price list.pdf")).getByRole("button", { name: "More options" }));
    expect(screen.queryByRole("menuitem", { name: "Page rules" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(rowOf("northsidebikes.ca")).getByRole("button", { name: "More options" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Page rules" }));
    const dialog = await screen.findByRole("dialog", { name: "Website rules" });
    expect(await within(dialog).findByText("/bikes/")).toBeTruthy();
    expect(within(dialog).getByText("Goes to Sales · 9 pages")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Website rules" }));
    expect(await within(await screen.findByRole("dialog", { name: "Website rules" })).findByText("northsidebikes.ca/bikes/")).toBeTruthy();
  });
});

describe("who a new or edited article is for", () => {
  async function addKnowledge(option: "Upload" | "Website" | "Text") {
    await userEvent.click(screen.getByRole("button", { name: "Add Knowledge" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: option }));
    return await screen.findByRole("dialog");
  }

  it("adds a text entry for the receptionists chosen", async () => {
    const { sent } = setup();
    const dialog = await addKnowledge("Text");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Test ride policy");
    await userEvent.type(within(dialog).getByLabelText("Content"), "Test rides are free.");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Chosen receptionists" }));
    await choose(within(dialog).getByRole("combobox", { name: /^Receptionists it's available to/ }), "Sales");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("POST", "/api/knowledge/snippets")).toEqual([{ url: "/api/knowledge/snippets?businessId=business", body: { title: "Test ride policy", content: "Test rides are free.", tags: [], priority: 75, active: true, audience: "chosen", receptionistIds: [SALES.id] } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits a text entry and who it's for in one save", async () => {
    const { sent } = setup();
    await userEvent.click(screen.getByText("Warranty claims", { selector: "span[title]" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Knowledge" });
    expect((within(dialog).getByRole("radio", { name: "Chosen receptionists" }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Remove Support" })).toBeTruthy();
    await choose(within(dialog).getByRole("combobox", { name: /^Receptionists it's available to/ }), "Sales");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent("PATCH", `/api/knowledge/snippets/${WARRANTY.id}`)).toEqual([{ url: `/api/knowledge/snippets/${WARRANTY.id}?businessId=business`, body: { id: WARRANTY.id, title: "Warranty claims", content: "Warranty claims: details.", tags: [], priority: 75, active: true, audience: "chosen", receptionistIds: [SALES.id, SUPPORT.id] } }]));
  });

  it("shows a refused text entry in its dialog instead of a general toast", async () => {
    const { fetchMock } = setup();
    const defaultFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST" && url.startsWith("/api/knowledge/snippets")
      ? Response.json({ error: "An archived receptionist can't be chosen. Restore it first.", code: "receptionist_archived" }, { status: 409 })
      : await defaultFetch(url, init));
    const dialog = await addKnowledge("Text");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Pop-up hours");
    await userEvent.type(within(dialog).getByLabelText("Content"), "Saturdays only.");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Chosen receptionists" }));
    await choose(within(dialog).getByRole("combobox", { name: /^Receptionists it's available to/ }), "Support");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("One of the chosen receptionists was archived. Refresh the page and choose again.")).toBeTruthy();
  });

  it("imports a website with page rules in the same request", async () => {
    const { sent } = setup();
    const dialog = await addKnowledge("Website");
    await userEvent.type(within(dialog).getByLabelText("Website URL"), "https://northsidebikes.ca");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Path of rule 1" }), "/service/");
    await choose(within(dialog).getByRole("combobox", { name: /^Who rule 1 goes to/ }), "Support");
    await userEvent.click(within(dialog).getByRole("button", { name: "Import Website" }));
    await waitFor(() => expect(sent("POST", "/api/knowledge?")).toEqual([{ url: "/api/knowledge?businessId=business", body: { businessId: "business", sourceType: "website", title: "https://northsidebikes.ca", sourceUrl: "https://northsidebikes.ca", websiteRules: [{ pathPrefix: "/service/", receptionistId: SUPPORT.id }] } }]));
  });

  it("uploads a file for the receptionists chosen in the step that saves it", async () => {
    vi.stubGlobal("crypto", { subtle: { digest: async () => new ArrayBuffer(32) } });
    const { sent } = setup();
    const dialog = await addKnowledge("Upload");
    fireEvent.change(document.getElementById("knowledge-document-file")!, { target: { files: [new File(["Repairs from $40"], "repair-menu.txt", { type: "text/plain" })] } });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Chosen receptionists" }));
    await choose(within(dialog).getByRole("combobox", { name: /^Receptionists it's available to/ }), "Support");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("PUT", "/api/uploads")).toHaveLength(1));
    expect(sent("PUT", "/api/uploads")[0]!.body).toMatchObject({ businessId: "business", objectId: "object", title: "repair-menu", audience: "chosen", receptionistIds: [SUPPORT.id] });
    // Reserving the upload says nothing about who it's for.
    expect(sent("POST", "/api/uploads")[0]!.body).not.toHaveProperty("audience");
  });
});

describe("people who can't change knowledge", () => {
  it("see who each article is for and read a text entry, without selecting or changing anything", async () => {
    setup({ role: "viewer" });
    expect(within(table()).getAllByRole("columnheader").map((header) => header.textContent)).toContain("Available to");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Website rules" })).toBeNull();
    expect(filter()).toBeTruthy();
    await userEvent.click(screen.getByText("Warranty claims", { selector: "span[title]" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByRole("textbox", { name: "Warranty claims" }) as HTMLTextAreaElement).value).toBe("Warranty claims: details.");
  });
});
