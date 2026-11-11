// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingBusinessSurface } from "./onboarding-business-surface";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";
const router = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }));
const pendingAnalytics = vi.hoisted(() => ({ record: vi.fn() }));
const telemetryRef = vi.hoisted(() => ({ current: null as ReturnType<typeof createRecordedBrowserTelemetry> | null }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => telemetryRef.current!.telemetry }));
vi.mock("@/lib/onboarding-analytics", () => ({ recordPendingOnboardingBusiness: pendingAnalytics.record }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options ? `${key} ${JSON.stringify(options)}` : key }) }));
const clients: QueryClient[] = [];
beforeEach(() => { telemetryRef.current = createRecordedBrowserTelemetry(); });
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("business creation onboarding", () => {
  it("waits for the created workspace to be refreshed before continuing", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
    client.setQueryData(["businesses"], { businesses: [] });
    let refresh: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({ businessId: "business" }) : new Promise<Response>(resolve => { refresh = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><OnboardingBusinessSurface /></QueryClientProvider>);
    await userEvent.type(screen.getByLabelText("businessName.label"), "Acme");
    await userEvent.click(screen.getByRole("button", { name: "businessName.continue" }));
    await waitFor(() => expect(refresh).toBeTypeOf("function"));
    expect(router.push).not.toHaveBeenCalled();
    refresh!(Response.json({ businesses: [{ businessId: "business", name: "Acme", active: true }] }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/onboarding/website"));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(pendingAnalytics.record).toHaveBeenCalledWith("business");
    expect(telemetryRef.current!.events).toEqual([]);
  });

  it("moves an existing workspace to the website step before continuing", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "demo", name: "Climco", active: true }] });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/businesses") && !init?.method) return Response.json({ businesses: [{ businessId: "demo", name: "Climco HVAC", active: true }] });
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><OnboardingBusinessSurface /></QueryClientProvider>);
    const input = screen.getByLabelText("businessName.label");
    await waitFor(() => expect(input).toHaveProperty("value", "Climco"));
    await userEvent.clear(input);
    await userEvent.type(input, "Climco HVAC");
    await userEvent.click(screen.getByRole("button", { name: "businessName.continue" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/onboarding/website"));
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method).map(([url, init]) => [url, init!.method, init!.body]);
    expect(writes).toEqual([
      ["/api/businesses?businessId=demo", "PATCH", JSON.stringify({ name: "Climco HVAC" })],
      ["/api/onboarding/stage?businessId=demo", "POST", JSON.stringify({ to: "website" })],
    ]);
    expect(telemetryRef.current!.events).toEqual([expect.objectContaining({ name: "web.onboarding.business_name_submitted" })]);
  });
});

describe("business limit", () => {
  const owned = [{ businessId: "one", name: "One", active: true, role: "business_owner" }, { businessId: "two", name: "Two", active: false, role: "business_owner" }];

  it("says the account owns the most businesses it may before a name is typed, and sends nothing", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
    client.setQueryData(["businesses"], { businesses: owned, businessLimit: { owned: 2, max: 2 } });
    const fetchMock = vi.fn(async () => Response.json({ businessId: "three" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><OnboardingBusinessSurface createNew /></QueryClientProvider>);
    expect(screen.getByText('errors.tooManyBusinesses {"count":2}')).toBeTruthy();
    await userEvent.type(screen.getByLabelText("businessName.label"), "Three");
    expect(screen.getByRole("button", { name: "businessName.continue" })).toHaveProperty("disabled", true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so when the server refuses a business another tab took the last place for, and reloads the count", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
    client.setQueryData(["businesses"], { businesses: owned, businessLimit: { owned: 2, max: 3 } });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ error: "This account already owns 3 businesses, the most one account can own.", code: "business_limit" }, { status: 409 })
      : Response.json({ businesses: owned, businessLimit: { owned: 3, max: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><OnboardingBusinessSurface createNew /></QueryClientProvider>);
    await userEvent.type(screen.getByLabelText("businessName.label"), "Three");
    await userEvent.click(screen.getByRole("button", { name: "businessName.continue" }));
    expect(await screen.findByText('errors.tooManyBusinesses {"count":3}')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "businessName.continue" })).toHaveProperty("disabled", true));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("lets an account under its limit create a business", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
    client.setQueryData(["businesses"], { businesses: owned, businessLimit: { owned: 2, max: 3 } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ businessId: "three" })));
    render(<QueryClientProvider client={client}><OnboardingBusinessSurface createNew /></QueryClientProvider>);
    expect(screen.queryByText(/errors\.tooManyBusinesses/)).toBeNull();
    await userEvent.type(screen.getByLabelText("businessName.label"), "Three");
    expect(screen.getByRole("button", { name: "businessName.continue" })).toHaveProperty("disabled", false);
  });
});
