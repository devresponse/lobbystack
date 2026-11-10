// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { toast } from "sonner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MAX_ARTICLES_PER_AUDIENCE_CHANGE } from "@lobbystack/shared";

import agentEn from "../../public/locales/en/agent.json";
import receptionistsEn from "../../public/locales/en/receptionists.json";
import {
  articleReceptionistIds,
  audienceErrorMessage,
  chosenByRule,
  isAudienceError,
  KnowledgeAudienceDialog,
  KnowledgeAvailableTo,
  KnowledgeBulkAudience,
  receptionistList,
  type KnowledgeArticle,
  type KnowledgeAudienceLinks,
} from "./knowledge-audience";
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
const RENTALS = receptionist("00000000-0000-4000-8000-0000000000a4", "Rentals", { sortOrder: 3 });
const TEAM = [FRONT_DESK, SALES, SUPPORT, RENTALS];
const ARCHIVED = "00000000-0000-4000-8000-0000000000ee";
const RULE = "00000000-0000-4000-8000-0000000000f1";

const PRICE_LIST: KnowledgeArticle = { kind: "document", id: "doc-price-list", title: "2026 price list.pdf", audience: "chosen" };
const E_BIKES: KnowledgeArticle = { kind: "document", id: "doc-e-bikes", title: "northsidebikes.ca/bikes/e-bikes", audience: "chosen" };
const HOURS: KnowledgeArticle = { kind: "snippet", id: "snippet-hours", title: "Opening hours and holidays", audience: "everyone" };
const PRICE_MATCH: KnowledgeArticle = { kind: "snippet", id: "snippet-price-match", title: "Do you price-match?", audience: "chosen" };
const LINKS: KnowledgeAudienceLinks = {
  documents: {
    [PRICE_LIST.id]: [{ receptionistId: SALES.id, websiteRuleId: null }],
    [E_BIKES.id]: [{ receptionistId: SALES.id, websiteRuleId: RULE }],
  },
  snippets: { [PRICE_MATCH.id]: [SALES.id, SUPPORT.id, ARCHIVED] },
};

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}>{node}</QueryClientProvider></I18nextProvider>);
}

function stubFetch(response: () => Response = () => Response.json({ documents: 1, snippets: 1 })) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const sentBody = (fetchMock: ReturnType<typeof stubFetch>, call = 0) => JSON.parse(String(fetchMock.mock.calls[call]![1]!.body));

async function choose(combobox: HTMLElement, ...names: string[]) {
  await userEvent.click(combobox);
  for (const name of names) await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(name) }));
}

describe("who an article is for, from the links the server lists", () => {
  it("names the receptionists each article is chosen for, archived ones included, and nobody for articles for everyone", () => {
    expect(articleReceptionistIds(LINKS, PRICE_LIST)).toEqual([SALES.id]);
    expect(articleReceptionistIds(LINKS, PRICE_MATCH)).toEqual([SALES.id, SUPPORT.id, ARCHIVED]);
    expect(articleReceptionistIds(LINKS, HOURS)).toEqual([]);
    expect(articleReceptionistIds(undefined, PRICE_LIST)).toEqual([]);
  });

  it("tells a page a website rule chose for a listed receptionist from one chosen by hand", () => {
    expect(chosenByRule(LINKS, E_BIKES, TEAM)).toBe(true);
    expect(chosenByRule(LINKS, PRICE_LIST, TEAM)).toBe(false);
    expect(chosenByRule(LINKS, PRICE_MATCH, TEAM)).toBe(false);
    // A rule for a receptionist since archived chooses nothing the page shows.
    expect(chosenByRule(LINKS, E_BIKES, [FRONT_DESK, SUPPORT])).toBe(false);
  });

  it("lists names in a sentence, and past three the first two and how many more", () => {
    const t = i18n.getFixedT("en");
    expect(receptionistList(["Sales"], "en", t)).toBe("Sales");
    expect(receptionistList(["Sales", "Support"], "en", t)).toBe("Sales and Support");
    expect(receptionistList(["Sales", "Support", "Rentals"], "en", t)).toBe("Sales, Support, and Rentals");
    expect(receptionistList(["Sales", "Support", "Rentals", "Repairs", "Kids"], "en", t)).toBe("Sales, Support +3");
  });
});

describe("the reasons the server refuses a change, in the dashboard's words", () => {
  const t = () => i18n.getFixedT("en");
  it.each([
    ["receptionist_archived", "One of the chosen receptionists was archived. Refresh the page and choose again."],
    ["receptionist_not_found", "That receptionist isn't there any more. Refresh the page."],
    ["knowledge_not_found", "That article isn't there any more. Refresh the page."],
    ["invalid_audience", "Choose at least one receptionist, or make it available to everyone."],
    ["invalid_articles", `Select between 1 and ${MAX_ARTICLES_PER_AUDIENCE_CHANGE} articles.`],
    ["website_rule_exists", "This site already gives that path to that receptionist."],
    ["invalid_website_rule", "Enter a path on the site, such as /stores/kitsilano/."],
    ["website_rule_not_found", "That rule isn't there any more. Refresh the page."],
  ])("explains %s", (code, message) => {
    const error = Object.assign(new Error("Refused."), { code });
    expect(isAudienceError(error)).toBe(true);
    expect(audienceErrorMessage(error, t())).toBe(message);
  });

  it("gives anything else a general message, with the error ID a logged failure came with", () => {
    expect(isAudienceError(new Error("Internal error."))).toBe(false);
    expect(isAudienceError(Object.assign(new Error("Plan limit."), { code: "receptionist_limit" }))).toBe(false);
    expect(audienceErrorMessage(new Error("Internal error."), t())).toBe("That didn't work. Try again in a moment.");
    expect(audienceErrorMessage(Object.assign(new Error("Internal error."), { errorId: "err_51c2" }), t())).toBe("That didn't work. Try again in a moment. Error ID: err_51c2");
    expect(audienceErrorMessage("offline", t())).toBe("That didn't work. Try again in a moment.");
  });
});

describe("the Available to cell", () => {
  it("shows Everyone, up to two names and how many more, and marks a page a rule chose", () => {
    wrap(<ul>
      <li data-testid="hours"><KnowledgeAvailableTo article={HOURS} links={LINKS} receptionists={TEAM} /></li>
      <li data-testid="price-match"><KnowledgeAvailableTo article={PRICE_MATCH} links={LINKS} receptionists={TEAM} /></li>
      <li data-testid="e-bikes"><KnowledgeAvailableTo article={E_BIKES} links={LINKS} receptionists={TEAM} /></li>
      <li data-testid="price-list"><KnowledgeAvailableTo article={PRICE_LIST} links={LINKS} receptionists={TEAM} /></li>
      <li data-testid="nobody"><KnowledgeAvailableTo article={{ kind: "snippet", id: "snippet-old", title: "Old promo", audience: "chosen" }} links={{ documents: {}, snippets: { "snippet-old": [ARCHIVED] } }} receptionists={TEAM} /></li>
    </ul>);
    expect(screen.getByTestId("hours").textContent).toBe("Everyone");
    expect(screen.getByTestId("price-match").textContent).toBe("Sales, Support");
    expect(screen.getByTestId("e-bikes").textContent).toBe("Salesby rule");
    expect(screen.getByTestId("price-list").textContent).toBe("Sales");
    // Chosen only for archived receptionists: the default receptionist alone uses it.
    expect(screen.getByTestId("nobody").textContent).toBe("Default receptionist only");
  });
});

describe("Available to for the selected articles", () => {
  const selected = [HOURS, PRICE_LIST, PRICE_MATCH];

  function bulk(articles: KnowledgeArticle[] = selected) {
    const onChanged = vi.fn();
    const onClear = vi.fn();
    wrap(<KnowledgeBulkAudience articles={articles} businessId="business" onChanged={onChanged} onClear={onClear} receptionists={TEAM} />);
    return { onChanged, onClear };
  }
  const openPanel = () => userEvent.click(screen.getByRole("button", { name: "Available to" }));
  const multiselect = () => screen.getByRole("combobox", { name: /^Receptionists it's available to/ });
  const apply = () => screen.getByRole("button", { name: /^Apply to/ });

  it("says how many are selected and clears them", async () => {
    const { onClear } = bulk();
    expect(screen.getByRole("status").textContent).toBe("3 selected");
    expect(screen.queryByRole("region")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("adds receptionists to the chosen articles and leaves articles for everyone as they are", async () => {
    const fetchMock = stubFetch(() => Response.json({ documents: 1, snippets: 2 }));
    const { onChanged } = bulk();
    await openPanel();
    expect(screen.getByRole("button", { name: "Available to" }).getAttribute("aria-expanded")).toBe("true");
    expect((screen.getByRole("radio", { name: "Add" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Articles for everyone already include every receptionist, so they stay as they are.")).toBeTruthy();
    expect(apply().hasAttribute("disabled")).toBe(true);
    await choose(multiselect(), "Support");
    expect(screen.getByText("Adds Support to 3 articles.")).toBeTruthy();
    await userEvent.click(apply());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/knowledge/audience?businessId=business");
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
    expect(sentBody(fetchMock)).toEqual({ documentIds: [PRICE_LIST.id], snippetIds: [HOURS.id, PRICE_MATCH.id], audience: "chosen", mode: "add", receptionistIds: [SUPPORT.id] });
    expect(toast.success).toHaveBeenCalledWith("Available to changed for 3 articles.");
    // The panel closes once it's done.
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("removes receptionists and says what happens to articles for everyone and articles left with nobody", async () => {
    const fetchMock = stubFetch();
    bulk();
    await openPanel();
    await userEvent.click(screen.getByRole("radio", { name: "Remove" }));
    expect(screen.getByText("Articles for everyone become available to every other receptionist. An article left with no receptionist is used only by the default receptionist.")).toBeTruthy();
    await choose(multiselect(), "Sales", "Support");
    expect(screen.getByText("Removes Sales and Support from 3 articles.")).toBeTruthy();
    await userEvent.click(apply());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toMatchObject({ audience: "chosen", mode: "remove", receptionistIds: [SALES.id, SUPPORT.id] });
  });

  it("replaces who the articles are for, naming four receptionists as two and how many more", async () => {
    const fetchMock = stubFetch(() => Response.json({ documents: 1, snippets: 0 }));
    bulk([PRICE_LIST]);
    await openPanel();
    await userEvent.click(screen.getByRole("radio", { name: "Replace" }));
    await choose(multiselect(), "Front desk", "Sales", "Support", "Rentals");
    expect(screen.getByText("Makes 1 article available to Front desk, Sales +2 only.")).toBeTruthy();
    expect(apply().textContent).toBe("Apply to 1 article");
    await userEvent.click(apply());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toEqual({ documentIds: [PRICE_LIST.id], snippetIds: [], audience: "chosen", mode: "replace", receptionistIds: [FRONT_DESK.id, SALES.id, SUPPORT.id, RENTALS.id] });
    expect(toast.success).toHaveBeenCalledWith("Available to changed for 1 article.");
  });

  it("opens the articles to everyone without choosing anyone", async () => {
    const fetchMock = stubFetch();
    bulk();
    await openPanel();
    await userEvent.click(screen.getByRole("radio", { name: "Everyone" }));
    expect(screen.queryByRole("radio", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Makes 3 articles available to everyone.")).toBeTruthy();
    await userEvent.click(apply());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toEqual({ documentIds: [PRICE_LIST.id], snippetIds: [HOURS.id, PRICE_MATCH.id], audience: "everyone" });
  });

  it("holds back a change to more articles than one change covers", async () => {
    const fetchMock = stubFetch();
    const many = Array.from({ length: MAX_ARTICLES_PER_AUDIENCE_CHANGE + 1 }, (_, index): KnowledgeArticle => ({ kind: "snippet", id: `snippet-${index}`, title: `Entry ${index}`, audience: "everyone" }));
    bulk(many);
    await openPanel();
    await userEvent.click(screen.getByRole("radio", { name: "Everyone" }));
    expect(screen.getByText(`Select up to ${MAX_ARTICLES_PER_AUDIENCE_CHANGE} articles to change them at once.`)).toBeTruthy();
    expect(apply().hasAttribute("disabled")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says why the server refused, and keeps the panel and the choice", async () => {
    stubFetch(() => Response.json({ error: "An archived receptionist can't be chosen. Restore it first.", code: "receptionist_archived" }, { status: 409 }));
    const { onChanged } = bulk();
    await openPanel();
    await choose(multiselect(), "Rentals");
    await userEvent.click(apply());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("One of the chosen receptionists was archived. Refresh the page and choose again."));
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("region")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Rentals" })).toBeTruthy();
  });
});

describe("Available to for one article", () => {
  function dialog(article: KnowledgeArticle | null, links: KnowledgeAudienceLinks = LINKS) {
    const onChanged = vi.fn();
    const onOpenChange = vi.fn();
    wrap(<KnowledgeAudienceDialog article={article} businessId="business" links={links} onChanged={onChanged} onOpenChange={onOpenChange} receptionists={TEAM} />);
    return { onChanged, onOpenChange };
  }

  it("opens on who the article is for now, without archived receptionists, and replaces it on save", async () => {
    const fetchMock = stubFetch(() => Response.json({ documents: 0, snippets: 1 }));
    const { onChanged, onOpenChange } = dialog(PRICE_MATCH);
    expect(screen.getByRole("dialog", { name: "Available to" })).toBeTruthy();
    expect(screen.getByText("Who can use “Do you price-match?”.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Chosen receptionists" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("2 of 4 chosen")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove Support" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toEqual({ documentIds: [], snippetIds: [PRICE_MATCH.id], audience: "chosen", mode: "replace", receptionistIds: [SALES.id] });
    expect(toast.success).toHaveBeenCalledWith("Available to saved.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens an article to everyone", async () => {
    const fetchMock = stubFetch();
    dialog(PRICE_LIST);
    await userEvent.click(screen.getByRole("radio", { name: "Everyone" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toEqual({ documentIds: [PRICE_LIST.id], snippetIds: [], audience: "everyone" });
  });

  it("asks for a receptionist before saving one chosen for nobody", async () => {
    const fetchMock = stubFetch();
    dialog(HOURS);
    await userEvent.click(screen.getByRole("radio", { name: "Chosen receptionists" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Choose at least one receptionist, or make it available to everyone.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says when a website rule chose the page", () => {
    dialog(E_BIKES);
    expect(screen.getByText("A website rule chose this page. What you save here stays if the rule is deleted, and the rule adds its receptionist again each time the site is crawled.")).toBeTruthy();
  });

  it("says why the server refused and stays open", async () => {
    stubFetch(() => Response.json({ error: "Knowledge snippet not found.", code: "knowledge_not_found" }, { status: 404 }));
    const { onOpenChange } = dialog(PRICE_MATCH);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That article isn't there any more. Refresh the page."));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("closes without saving on Cancel", async () => {
    const fetchMock = stubFetch();
    const { onOpenChange } = dialog(PRICE_MATCH);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays closed without an article", () => {
    dialog(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
