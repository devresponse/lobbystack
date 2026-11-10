// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../public/locales/en/knowledge.json";
import enAgent from "../../public/locales/en/agent.json";
import enCommon from "../../public/locales/en/common.json";
import enReceptionists from "../../public/locales/en/receptionists.json";
import es from "../../public/locales/es/knowledge.json";
import fr from "../../public/locales/fr/knowledge.json";
import sr from "../../public/locales/sr/knowledge.json";
import { receptionistChoicesQueryKey, type ReceptionistOption } from "./receptionists/receptionist-choices";
import { UnansweredQuestionsSection, unansweredQuestionsQueryKey, type UnansweredQuestions } from "./unanswered-questions-section";
import { testNavigation } from "@/lib/navigation-testing";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", async () => (await import("@/lib/navigation-testing")).nextNavigationMock);

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });
beforeEach(() => { testNavigation.reset("/agent/questions"); });

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}
const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all" });
const KITSILANO = receptionist("00000000-0000-4000-8000-0000000000a2", "Kitsilano clinic", { sortOrder: 1 });
const GASTOWN = receptionist("00000000-0000-4000-8000-0000000000a3", "Gastown store", { sortOrder: 2 });

const listed: UnansweredQuestions = {
  openCount: 2,
  questions: [
    { id: "parking", question: "Do you validate parking?", timesAsked: 3, firstAskedAt: "2026-10-01T12:00:00Z", lastAskedAt: "2026-10-27T12:00:00Z", lastChannel: "voice" },
    { id: "dogs", question: "Can I bring my dog?", timesAsked: 1, firstAskedAt: "2026-10-20T12:00:00Z", lastAskedAt: "2026-10-20T12:00:00Z", lastChannel: "web_chat" },
  ],
};

type Setup = { strings?: typeof en; data?: UnansweredQuestions; list?: (url: string) => UnansweredQuestions; canManage?: boolean; locale?: "en" | "fr" | "es" | "sr"; patch?: () => Response; cached?: boolean; receptionists?: ReceptionistOption[] };
/** The list's first page, as it opens. */
const FIRST_PAGE = { pageIndex: 0, pageSize: 10 };
async function setup({ strings = en, data = listed, list, canManage = true, locale = "en", patch = () => Response.json({ ok: true }), cached = true, receptionists = [FRONT_DESK] }: Setup = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: locale, defaultNS: "knowledge", interpolation: { escapeValue: false }, resources: { en: { knowledge: strings, common: enCommon, receptionists: enReceptionists, agent: enAgent }, fr: { knowledge: fr }, es: { knowledge: es }, sr: { knowledge: sr } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  if (cached) client.setQueryData(unansweredQuestionsQueryKey("business", null, FIRST_PAGE), data);
  client.setQueryData(receptionistChoicesQueryKey("business"), { receptionists });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => init?.method ? patch() : Response.json(list ? list(url) : data));
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><UnansweredQuestionsSection businessId="business" canManage={canManage} /></QueryClientProvider></I18nextProvider>);
  return { fetchMock, i18n, client };
}
const listRequests = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method);

describe("the unanswered questions list", () => {
  it("lists open questions in the order the server ranks them, with how often and when they were last asked", async () => {
    await setup();
    expect(screen.getAllByText(/\?$/u).map((element) => element.textContent)).toEqual(["Do you validate parking?", "Can I bring my dog?"]);
    expect(screen.getByText("Asked 3 times · Last asked Oct 27, 2026")).toBeTruthy();
    expect(screen.getByText("Asked 1 time · Last asked Oct 20, 2026")).toBeTruthy();
  });

  it("formats dates and plurals in Serbian Latin script", async () => {
    await setup({ locale: "sr" });
    const line = screen.getByText(/^Postavljeno 3 puta · Poslednji put /u).textContent!;
    expect(line).toContain("27.");
    expect(line).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it("saves an answer for the question it was written for", async () => {
    const { fetchMock } = await setup();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Answer" })[0]!);
    const save = screen.getByRole("button", { name: "Save Answer" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Answer to: Do you validate parking?" }), "Two hours free at the front desk.");
    await user.click(save);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/knowledge/questions/parking?businessId=business", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "answer", answer: "Two hours free at the front desk." }) })));
  });

  it("dismisses a question", async () => {
    const { fetchMock } = await setup();
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Dismiss" })[1]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/knowledge/questions/dogs?businessId=business", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "dismiss" }) })));
  });

  it.each([["fr", "Posée 3 fois · Dernière fois le "], ["es", "Preguntada 3 veces · Última vez el "]] as const)("joins how often and when in %s", async (locale, start) => {
    await setup({ locale });
    expect(screen.getByText((text) => text.startsWith(start))).toBeTruthy();
  });

  it("lets each language order and join how often and when", async () => {
    await setup({ strings: { ...en, unansweredQuestions: { ...en.unansweredQuestions, askedSummary: "{{lastAsked}} / {{asked}}" } } });
    expect(screen.getByText("Last asked Oct 27, 2026 / Asked 3 times")).toBeTruthy();
  });

  it("refreshes the list and says so when someone else already answered the question", async () => {
    const { fetchMock } = await setup({ patch: () => Response.json({ error: "This question was already answered or dismissed.", code: "question_resolved" }, { status: 409 }) });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Answer" })[0]!);
    await user.type(screen.getByRole("textbox", { name: "Answer to: Do you validate parking?" }), "Two hours free.");
    await user.click(screen.getByRole("button", { name: "Save Answer" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(en.unansweredQuestions.toast.alreadyHandled));
    await waitFor(() => expect(listRequests(fetchMock)).toHaveLength(1));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("refreshes the list and says so when someone else already dismissed the question", async () => {
    const { fetchMock } = await setup({ patch: () => Response.json({ error: "This question was already answered or dismissed.", code: "question_resolved" }, { status: 409 }) });
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(en.unansweredQuestions.toast.alreadyHandled));
    await waitFor(() => expect(listRequests(fetchMock)).toHaveLength(1));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says at the answer box when the answer is too long, and keeps the draft", async () => {
    await setup({ patch: () => Response.json({ error: "Answers can be up to 5000 characters.", code: "answer_too_long" }, { status: 400 }) });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Answer" })[0]!);
    const box = screen.getByRole("textbox", { name: "Answer to: Do you validate parking?" });
    await user.type(box, "Two hours free.");
    await user.click(screen.getByRole("button", { name: "Save Answer" }));
    const message = await screen.findByRole("alert");
    expect(message.textContent).toBe("Shorten your answer to 5,000 characters or fewer.");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe(message.id);
    expect((box as HTMLTextAreaElement).value).toBe("Two hours free.");
    expect(toast.error).not.toHaveBeenCalled();
    await user.type(box, "!");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the generic error for any other failure", async () => {
    await setup({ patch: () => Response.json({ error: "Boom." }, { status: 500 }) });
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(enCommon.errors.unexpected));
  });

  it("loads its business's list when nothing is cached", async () => {
    const { fetchMock } = await setup({ cached: false });
    expect(await screen.findByText("Do you validate parking?")).toBeTruthy();
    expect(listRequests(fetchMock).map(([url]) => url)).toEqual(["/api/knowledge/questions?businessId=business&limit=10&offset=0"]);
  });

  it("lists 10 questions a page and asks the server for the page picked", async () => {
    const questions = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `q${from + index}`, question: `Question ${from + index + 1}?`, timesAsked: 1, firstAskedAt: "2026-10-01T12:00:00Z", lastAskedAt: "2026-10-01T12:00:00Z", lastChannel: "voice" }));
    const pages: Record<string, UnansweredQuestions> = { 0: { openCount: 23, questions: questions(0, 10) }, 10: { openCount: 23, questions: questions(10, 10) }, 20: { openCount: 23, questions: questions(20, 3) } };
    const { fetchMock } = await setup({ cached: false, list: (url) => pages[new URL(url, "https://admin.example").searchParams.get("offset") ?? "0"]! });
    expect(await screen.findByText("Question 1?")).toBeTruthy();
    expect(screen.getAllByText(/^Question \d+\?$/u)).toHaveLength(10);
    expect(screen.getAllByText("Page 1 of 3").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Question 11?")).toBeTruthy();
    expect(screen.queryByText("Question 1?")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Go to page 3/ }));
    expect(await screen.findByText("Question 23?")).toBeTruthy();
    expect(screen.getAllByText(/^Question \d+\?$/u)).toHaveLength(3);
    expect(listRequests(fetchMock).map(([url]) => new URL(url, "https://admin.example").search)).toEqual(["?businessId=business&limit=10&offset=0", "?businessId=business&limit=10&offset=10", "?businessId=business&limit=10&offset=20"]);
  });

  it("shows teammates who can't edit knowledge the questions without actions", async () => {
    await setup({ canManage: false });
    expect(screen.getByText("Do you validate parking?")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says what will show up here when nothing is open", async () => {
    await setup({ data: { questions: [], openCount: 0 } });
    expect(screen.getByText("No unanswered questions")).toBeTruthy();
    expect(screen.getByText(en.unansweredQuestions.emptyDescription)).toBeTruthy();
  });
});

describe("questions with several receptionists", () => {
  const heard: UnansweredQuestions = {
    openCount: 2,
    openByReceptionist: { [FRONT_DESK.id]: 1, [KITSILANO.id]: 2, [GASTOWN.id]: 1 },
    questions: [
      { ...listed.questions[0]!, askedOf: [
        { receptionistId: KITSILANO.id, name: "Kitsilano clinic", archived: false, timesAsked: 2, lastAskedAt: "2026-10-27T12:00:00Z" },
        { receptionistId: GASTOWN.id, name: "Gastown store", archived: false, timesAsked: 1, lastAskedAt: "2026-10-20T12:00:00Z" },
        { receptionistId: "00000000-0000-4000-8000-0000000000a9", name: "Old Main St", archived: true, timesAsked: 1, lastAskedAt: "2026-10-02T12:00:00Z" },
      ] },
      { ...listed.questions[1]!, askedOf: [{ receptionistId: "00000000-0000-4000-8000-0000000000a9", name: "Old Main St", archived: true, timesAsked: 1, lastAskedAt: "2026-10-20T12:00:00Z" }] },
    ],
  };
  const several = [FRONT_DESK, KITSILANO, GASTOWN];

  it("keeps the list as it was while the business has one receptionist", async () => {
    await setup({ data: heard });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(/^Heard by/u)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Answer" })[0]!);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("says who heard each question, archived receptionists too", async () => {
    await setup({ data: heard, receptionists: several });
    expect(screen.getByText("Heard by Kitsilano clinic, Gastown store +1")).toBeTruthy();
    expect(screen.getByText("Heard by Old Main St (archived)")).toBeTruthy();
  });

  it("filters by receptionist, with how many open questions each one heard", async () => {
    const { fetchMock } = await setup({ data: heard, receptionists: several });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Receptionist All receptionists" }));
    const kitsilano = screen.getByRole("option", { name: /Kitsilano clinic/u });
    expect(kitsilano.textContent).toContain("2");
    expect(kitsilano.textContent).toContain("2 questions your receptionist couldn't answer");
    await user.click(kitsilano);
    expect(testNavigation.router.replace).toHaveBeenLastCalledWith(`/agent/questions?receptionist=${KITSILANO.id}`, { scroll: false });
    await waitFor(() => expect(listRequests(fetchMock).map(([url]) => url)).toContain(`/api/knowledge/questions?businessId=business&receptionist=${KITSILANO.id}&limit=10&offset=0`));
  });

  it("saves an answer for only the receptionists that heard it, once asked to", async () => {
    const { fetchMock } = await setup({ data: heard, receptionists: several });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Answer" })[0]!);
    const everyone = screen.getByRole("radio", { name: "Every receptionist" }) as HTMLInputElement;
    expect(everyone.checked).toBe(true);
    // The archived one can't take the answer.
    await user.click(screen.getByRole("radio", { name: "Only the 2 receptionists that heard it" }));
    await user.type(screen.getByRole("textbox", { name: "Answer to: Do you validate parking?" }), "Validated at the front desk.");
    await user.click(screen.getByRole("button", { name: "Save Answer" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/knowledge/questions/parking?businessId=business", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "answer", answer: "Validated at the front desk.", audience: "asked" }) })));
  });

  it("saves an answer for everyone unless asked otherwise", async () => {
    const { fetchMock } = await setup({ data: heard, receptionists: several });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Answer" })[0]!);
    await user.type(screen.getByRole("textbox", { name: "Answer to: Do you validate parking?" }), "Two hours free.");
    await user.click(screen.getByRole("button", { name: "Save Answer" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/knowledge/questions/parking?businessId=business", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "answer", answer: "Two hours free." }) })));
  });

  it("names the choice for one receptionist when only one that heard it is left", async () => {
    const one: UnansweredQuestions = { ...heard, questions: [{ ...heard.questions[0]!, askedOf: heard.questions[0]!.askedOf!.filter((asker) => asker.receptionistId !== GASTOWN.id) }] };
    await setup({ data: one, receptionists: several });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getByRole("radio", { name: "Only the receptionist that heard it" })).toBeTruthy();
  });

  it("offers no choice when every receptionist that heard it is archived", async () => {
    await setup({ data: heard, receptionists: several });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Answer" })[1]!);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("goes back to every receptionist when the ones that heard it were archived meanwhile", async () => {
    await setup({ data: heard, receptionists: several, patch: () => Response.json({ error: "No receptionist that asked is left to answer.", code: "no_receptionists_asked" }, { status: 409 }) });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Answer" })[0]!);
    await user.click(screen.getByRole("radio", { name: "Only the 2 receptionists that heard it" }));
    await user.type(screen.getByRole("textbox", { name: "Answer to: Do you validate parking?" }), "Two hours free.");
    await user.click(screen.getByRole("button", { name: "Save Answer" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.unansweredQuestions.toast.noneHeard));
    expect((screen.getByRole("textbox", { name: "Answer to: Do you validate parking?" }) as HTMLTextAreaElement).value).toBe("Two hours free.");
  });
});
