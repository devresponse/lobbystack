// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import agent from "../../../../public/locales/en/agent.json";
import knowledge from "../../../../public/locales/en/knowledge.json";
import { unansweredQuestionsQueryKey, type UnansweredQuestions } from "@/components/unanswered-questions-section";
import AgentLayout from "../layout";
import AgentQuestionsPage from "./page";

vi.mock("next/navigation", () => ({ usePathname: () => "/agent/questions" }));

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); });

const open: UnansweredQuestions = {
  openCount: 2,
  questions: [
    { id: "support", question: "What is your support phone number?", timesAsked: 2, firstAskedAt: "2026-10-30T12:00:00Z", lastAskedAt: "2026-10-31T01:00:00Z", lastChannel: "voice" },
    { id: "parking", question: "Do you validate parking?", timesAsked: 1, firstAskedAt: "2026-10-30T13:00:00Z", lastAskedAt: "2026-10-30T13:00:00Z", lastChannel: "web_chat" },
  ],
};

async function openPage({ role = "business_owner", businesses = [{ businessId: "business", name: "Clinic", slug: "clinic", active: true, role }], cached = true }: { role?: string; businesses?: object[]; cached?: boolean } = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", defaultNS: "agent", interpolation: { escapeValue: false }, resources: { en: { agent, knowledge } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses });
  if (cached) client.setQueryData(unansweredQuestionsQueryKey("business"), open);
  const fetchMock = vi.fn(async (_url: string) => Response.json(open));
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><AgentLayout><AgentQuestionsPage /></AgentLayout></QueryClientProvider></I18nextProvider>);
  return { fetchMock };
}

describe("the Questions page at /agent/questions", () => {
  it("opens under its own title with the open questions, most asked first", async () => {
    await openPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(agent.sections.questions.title);
    expect(screen.getByRole("heading", { level: 2, name: knowledge.unansweredQuestions.title })).toBeTruthy();
    expect(screen.getAllByText(/\?$/u).map((element) => element.textContent)).toEqual(["What is your support phone number?", "Do you validate parking?"]);
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("lets owners and admins answer or dismiss each question", async () => {
    for (const role of ["business_owner", "business_admin"]) {
      await openPage({ role });
      expect(screen.getAllByRole("button", { name: knowledge.unansweredQuestions.answer })).toHaveLength(2);
      expect(screen.getAllByRole("button", { name: knowledge.unansweredQuestions.dismiss })).toHaveLength(2);
      cleanup();
    }
  });

  it("shows schedulers and viewers the questions without the buttons", async () => {
    for (const role of ["scheduler", "viewer"]) {
      await openPage({ role });
      expect(screen.getByText("What is your support phone number?")).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
      cleanup();
    }
  });

  it("asks only for the active business's questions", async () => {
    const { fetchMock } = await openPage({ cached: false, businesses: [{ businessId: "other", name: "Other", slug: "other", active: false, role: "business_owner" }, { businessId: "business", name: "Clinic", slug: "clinic", active: true, role: "business_owner" }] });
    expect(await screen.findByText("Do you validate parking?")).toBeTruthy();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/knowledge/questions?businessId=business"]);
  });

  it("says there's no workspace yet instead of listing questions", async () => {
    await openPage({ businesses: [] });
    expect(screen.getByText(agent.empty.description)).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });
});
