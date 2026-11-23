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

/** `moved` is the server's answer to the step asked for: the step to open next. */
function setup(moved: Record<string, unknown> = { ok: true, stage: "phone_number" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true }] });
  client.setQueryData(["onboarding-agent", "business"], { profile: { greeting: "Hi there" } });
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/businesses") return Response.json({ businesses: [{ businessId: "business", active: true }] });
    return Response.json(url.startsWith("/api/onboarding/stage?") ? moved : { ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<QueryClientProvider client={client}><OnboardingGreetingSurface /></QueryClientProvider>);
  return fetchMock;
}

async function submitGreeting() {
  const textarea = (await screen.findByLabelText("greeting.label")) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.value).toBe("Hi there"));
  await userEvent.click(screen.getByRole("button", { name: "greeting.continue" }));
}

describe("onboarding greeting telemetry", () => {
  it("records the submitted greeting once the workspace save completes", async () => {
    const fetchMock = setup();
    await submitGreeting();
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/onboarding/number"));
    const stageCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/onboarding/stage?"));
    expect(stageCall).toBeTruthy();
    expect(JSON.parse(String(stageCall?.[1]?.body))).toEqual({ to: "phone_number" });
    telemetryRef.current!.expectEvent("web.onboarding.greeting_submitted", { businessId: "business" });
  });
});

describe("the step after the greeting", () => {
  // The plan was chosen before the greeting, so the server knows whether there is a number to pick.
  it("asks for the number step and opens it on a plan with a number to pick", async () => {
    const fetchMock = setup({ ok: true, stage: "phone_number" });
    await submitGreeting();
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/onboarding/number"));
    expect(navigation.push).toHaveBeenCalledTimes(1);
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method).map(([url, init]) => [url, init!.method]);
    expect(writes).toEqual([["/api/agent", "PATCH"], ["/api/onboarding/stage?businessId=business", "POST"]]);
  });

  it("opens the last step when the server answers that the plan has no number to pick", async () => {
    setup({ ok: true, stage: "attribution" });
    await submitGreeting();
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/onboarding/attribution"));
    expect(navigation.push).toHaveBeenCalledTimes(1);
  });

  it("never opens the plan step, which now comes before the greeting", async () => {
    setup({ ok: true });
    await submitGreeting();
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/onboarding/attribution"));
    expect(navigation.push).not.toHaveBeenCalledWith("/onboarding/plan");
  });

  it("warms both steps that can follow, and not the plan step", async () => {
    setup();
    await waitFor(() => expect(navigation.prefetch).toHaveBeenCalledWith("/onboarding/number"));
    expect(navigation.prefetch).toHaveBeenCalledWith("/onboarding/attribution");
    expect(navigation.prefetch).not.toHaveBeenCalledWith("/onboarding/plan");
  });
});

describe("onboarding greeting language", () => {
  // Serbian is a dashboard language that calls can't open in.
  it.each([["en", "en"], ["fr-CA", "fr"], ["es-MX", "es"], ["sr", "en"]])("opens calls from a %s dashboard in %s", async (language, locale) => {
    dashboardLanguage.current = language;
    const fetchMock = setup();
    await submitGreeting();
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/onboarding/number"));
    const agentCall = fetchMock.mock.calls.find(([url, init]) => String(url).startsWith("/api/agent") && init?.method === "PATCH");
    expect(JSON.parse(String(agentCall?.[1]?.body))).toEqual({ greeting: "Hi there", locale });
  });
});
