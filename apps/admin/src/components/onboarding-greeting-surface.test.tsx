// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingGreetingSurface } from "./onboarding-greeting-surface";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";

const navigation = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }));
const telemetryRef = vi.hoisted(() => ({ current: null as ReturnType<typeof createRecordedBrowserTelemetry> | null }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => telemetryRef.current!.telemetry }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
const dashboardLanguage = vi.hoisted(() => ({ current: "en" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: dashboardLanguage.current }, t: (key: string) => key }) }));

const clients: QueryClient[] = [];
beforeEach(() => { telemetryRef.current = createRecordedBrowserTelemetry(); navigation.push.mockReset(); });
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); dashboardLanguage.current = "en"; });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true }] });
  client.setQueryData(["onboarding-agent", "business"], { profile: { greeting: "Hi there" } });
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url === "/api/businesses" ? Response.json({ businesses: [{ businessId: "business", active: true }] }) : Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QueryClientProvider client={client}><OnboardingGreetingSurface /></QueryClientProvider>);
  return fetchMock;
}

describe("onboarding greeting telemetry", () => {
  it("records the submitted greeting once the workspace save completes", async () => {
    const fetchMock = setup();
    const textarea = (await screen.findByLabelText("greeting.label")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("Hi there"));
    await userEvent.click(screen.getByRole("button", { name: "greeting.continue" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/onboarding/plan"));
    const stageCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/onboarding/stage?"));
    expect(stageCall).toBeTruthy();
    expect(JSON.parse(String(stageCall?.[1]?.body))).toEqual({ to: "plan" });
    telemetryRef.current!.expectEvent("web.onboarding.greeting_submitted", { businessId: "business" });
  });
});

describe("onboarding greeting language", () => {
  // Serbian is a dashboard language that calls can't open in.
  it.each([["en", "en"], ["fr-CA", "fr"], ["es-MX", "es"], ["sr", "en"]])("opens calls from a %s dashboard in %s", async (language, locale) => {
    dashboardLanguage.current = language;
    const fetchMock = setup();
    const textarea = (await screen.findByLabelText("greeting.label")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("Hi there"));
    await userEvent.click(screen.getByRole("button", { name: "greeting.continue" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/onboarding/plan"));
    const agentCall = fetchMock.mock.calls.find(([url, init]) => String(url).startsWith("/api/agent") && init?.method === "PATCH");
    expect(JSON.parse(String(agentCall?.[1]?.body))).toEqual({ greeting: "Hi there", locale });
  });
});
