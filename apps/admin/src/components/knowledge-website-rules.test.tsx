// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { toast } from "sonner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import agentEn from "../../public/locales/en/agent.json";
import receptionistsEn from "../../public/locales/en/receptionists.json";
import { draftRulesForSave, newDraftRule, siteLabel, WebsiteRulesDialog, type WebsiteRule, type WebsiteSource } from "./knowledge-website-rules";
import type { ReceptionistOption } from "./receptionists/receptionist-choices";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "agent", interpolation: { escapeValue: false }, resources: { en: { agent: agentEn, receptionists: receptionistsEn } } });
});
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 1, locale: null, knowledgeScope: "audience", ...values };
}
const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all", sortOrder: 0 });
const SALES = receptionist("00000000-0000-4000-8000-0000000000a2", "Sales", { sortOrder: 1 });
const SUPPORT = receptionist("00000000-0000-4000-8000-0000000000a3", "Support", { sortOrder: 2 });
const TEAM = [FRONT_DESK, SALES, SUPPORT];
const ARCHIVED = "00000000-0000-4000-8000-0000000000ee";

const BIKES_SITE: WebsiteSource = { id: "00000000-0000-4000-8000-0000000000d1", url: "https://www.northsidebikes.ca/" };
const RENTALS_SITE: WebsiteSource = { id: "00000000-0000-4000-8000-0000000000d2", url: "https://rentals.northsidebikes.ca/fleet/" };

function rule(id: number, site: WebsiteSource, pathPrefix: string, receptionistId: string, pages: number): WebsiteRule {
  return { id: `00000000-0000-4000-8000-0000000001${id.toString().padStart(2, "0")}`, rootDocumentId: site.id, siteUrl: site.url, pathPrefix, receptionistId, createdAt: "2026-10-27T10:00:00Z", pages };
}
const E_BIKES = rule(1, BIKES_SITE, "/bikes/", SALES.id, 14);
const SERVICE = rule(2, BIKES_SITE, "/service/", SUPPORT.id, 1);
const FLEET = rule(3, RENTALS_SITE, "/fleet/kids/", ARCHIVED, 3);

describe("rules as the Import Website dialog drafts them", () => {
  it("sends complete rows as rules, skips empty ones, and names the rows to fix", () => {
    const [bikes, empty, noReceptionist, badPath, noPath] = [newDraftRule(), newDraftRule(), newDraftRule(), newDraftRule(), newDraftRule()];
    expect(new Set([bikes, empty, noReceptionist, badPath, noPath].map((draft) => draft.key)).size).toBe(5);
    const result = draftRulesForSave([
      { ...bikes!, path: " bikes ", receptionistId: SALES.id },
      empty!,
      { ...noReceptionist!, path: "/service/" },
      { ...badPath!, path: "/menu#drinks", receptionistId: SUPPORT.id },
      { ...noPath!, receptionistId: SUPPORT.id },
    ]);
    expect(result).toEqual({ rules: [{ pathPrefix: "/bikes/", receptionistId: SALES.id }], invalid: [noReceptionist!.key, badPath!.key, noPath!.key] });
  });

  it("names a site by its host and path, without the scheme or www", () => {
    expect(siteLabel("https://www.northsidebikes.ca/")).toBe("northsidebikes.ca");
    expect(siteLabel("https://rentals.northsidebikes.ca/fleet/")).toBe("rentals.northsidebikes.ca/fleet");
    expect(siteLabel("not a url")).toBe("not a url");
  });
});

describe("the Website rules dialog", () => {
  type Handler = (url: string, init?: RequestInit) => Response;
  function setup({ rules = [E_BIKES, SERVICE, FLEET], sites = [BIKES_SITE, RENTALS_SITE], siteId, handle }: { rules?: WebsiteRule[]; sites?: WebsiteSource[]; siteId?: string | null; handle?: Handler } = {}) {
    let listed = rules;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const custom = handle?.(url, init);
      if (custom) return custom;
      if (!init?.method) return Response.json({ rules: listed });
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body)) as { rootDocumentId: string; pathPrefix: string; receptionistId: string };
        const site = sites.find((source) => source.id === body.rootDocumentId)!;
        const created = { ...rule(9, site, body.pathPrefix, body.receptionistId, 6) };
        listed = [...listed, created];
        return Response.json({ rule: created }, { status: 201 });
      }
      listed = listed.filter((entry) => !url.includes(entry.id));
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    const onOpenChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    clients.push(client);
    const wrap = (node: ReactNode) => <I18nextProvider i18n={i18n}><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nextProvider>;
    render(wrap(<WebsiteRulesDialog businessId="business" onChanged={onChanged} onOpenChange={onOpenChange} open receptionists={TEAM} siteId={siteId} sites={sites} />));
    return { fetchMock, onChanged, onOpenChange };
  }
  const list = async () => within(await screen.findByRole("list"));

  it("lists every site's rules with how many pages each gave its receptionist", async () => {
    const { fetchMock } = setup();
    expect(screen.getByRole("dialog", { name: "Website rules" })).toBeTruthy();
    const rows = (await list()).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "northsidebikes.ca/bikes/Goes to Sales · 14 pages",
      "northsidebikes.ca/service/Goes to Support · 1 page",
      // A rule for an archived receptionist gives its pages to nobody the list shows.
      "rentals.northsidebikes.ca/fleet/fleet/kids/Goes to A receptionist that's no longer listed · 3 pages",
    ]);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/knowledge/website-rules?businessId=business");
  });

  it("shows one site's rules from that site's row, with its paths alone", async () => {
    setup({ siteId: BIKES_SITE.id });
    const rows = (await list()).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/^\//).textContent)).toEqual(["/bikes/", "/service/"]);
    // From a site's row the rule goes to that site, so there is no site to pick.
    expect(screen.queryByRole("combobox", { name: "Website" })).toBeNull();
  });

  it("shows five rules, then all of them on request", async () => {
    const many = Array.from({ length: 7 }, (_, index) => rule(index + 10, BIKES_SITE, `/stores/store-${index + 1}/`, SALES.id, 2));
    setup({ rules: many });
    expect((await list()).getAllByRole("listitem")).toHaveLength(5);
    await userEvent.click(screen.getByRole("button", { name: "Show all 7 rules" }));
    expect((await list()).getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
  });

  it("adds a rule to the site picked, applies it, and refreshes the page", async () => {
    const { fetchMock, onChanged } = setup();
    await list();
    await userEvent.selectOptions(screen.getByLabelText("Website"), RENTALS_SITE.id);
    await userEvent.type(screen.getByLabelText("Path"), "https://rentals.northsidebikes.ca/fleet/adults");
    await userEvent.click(screen.getByRole("combobox", { name: /^Goes to/ }));
    await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /Support/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Rule added. 6 pages go to Support."));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/api/knowledge/website-rules?businessId=business");
    expect(JSON.parse(String(post[1]!.body))).toEqual({ rootDocumentId: RENTALS_SITE.id, pathPrefix: "/fleet/adults/", receptionistId: SUPPORT.id });
    expect(onChanged).toHaveBeenCalled();
    // The form empties for the next rule, and the list shows the new one.
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("");
    await waitFor(async () => expect((await list()).getAllByRole("listitem")).toHaveLength(4));
  });

  it("asks for a usable path and a receptionist before adding", async () => {
    const { fetchMock } = setup();
    await list();
    await userEvent.type(screen.getByLabelText("Path"), "/menu?drinks");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getByText("Enter a path on the site, such as /stores/kitsilano/.")).toBeTruthy();
    expect(screen.getByLabelText("Path").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Choose who the pages go to.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("says why the server refused a rule", async () => {
    setup({ handle: (_url, init) => init?.method === "POST" ? Response.json({ error: "This site already gives that path to that receptionist.", code: "website_rule_exists" }, { status: 409 }) : undefined as unknown as Response });
    await list();
    await userEvent.type(screen.getByLabelText("Path"), "/bikes/");
    await userEvent.click(screen.getByRole("combobox", { name: /^Goes to/ }));
    await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /Sales/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This site already gives that path to that receptionist."));
  });

  it("deletes a rule only after confirming, and says where its pages go", async () => {
    const { fetchMock, onChanged } = setup();
    await list();
    await userEvent.click(screen.getByRole("button", { name: "Delete the rule for /bikes/" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete the rule for /bikes/?" });
    expect(within(confirm).getByText("The pages it gave to its receptionist go back to everyone, unless another rule or your own choice also gives them to someone.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete rule" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Rule deleted."));
    const deleted = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(deleted[0]).toBe(`/api/knowledge/website-rules/${E_BIKES.id}?businessId=business`);
    expect(onChanged).toHaveBeenCalled();
    await waitFor(async () => expect((await list()).queryByText("northsidebikes.ca/bikes/")).toBeNull());
  });

  it("says when the business has no rules, or no website to make one for", async () => {
    setup({ rules: [] });
    expect(await screen.findByText("No rules yet.")).toBeTruthy();
    cleanup();
    setup({ rules: [], sites: [] });
    expect(screen.getByText("Import a website first. A rule gives a section of its pages to one receptionist.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
  });
});
