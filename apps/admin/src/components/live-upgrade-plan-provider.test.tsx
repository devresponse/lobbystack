// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInBillingPlanList } from "@lobbystack/shared";
import { LiveUpgradePlanProvider } from "./live-upgrade-plan-provider";
import { useOpenUpgradePlanDialog } from "./upgrade-plan-dialog-context";
import { isUpgradeInProgress } from "@/lib/upgrade-in-progress";

const alerts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: alerts }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: (key: string, options?: { minutes?: string }) => options?.minutes ? `${key}:${options.minutes}` : key }) }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });
function OpenButton() { const open = useOpenUpgradePlanDialog(); return <button onClick={open}>Open plans</button>; }

describe("restarting a plan that lapsed", () => {
  async function openPlansFor(subscriptionState: string | null) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    client.setQueryData(["billing", "business"], { plans: builtInBillingPlanList(), account: { plan: "starter", subscriptionState }, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["annual", "monthly"], pro: ["annual", "monthly"] } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Checkout unavailable" }, { status: 503 })));
    render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
  }

  it("lets a cancelled Starter buy Starter again, which is the tier that carries their number", async () => {
    await openPlansFor("canceled");
    const starter = screen.getByRole("button", { name: "billing.upgradeDialog.actions.starter" });
    expect(starter.hasAttribute("disabled")).toBe(false);
    // Free carries the current-plan marker instead, which is where a cancelled
    // account actually sits.
    expect(screen.getAllByRole("button", { name: "billing.upgradeDialog.actions.currentPlan" })).toHaveLength(1);
  });

  it("still marks a live Starter as the plan they are on", async () => {
    await openPlansFor("active");
    expect(screen.getByRole("button", { name: "billing.upgradeDialog.actions.currentPlan" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "billing.upgradeDialog.actions.starter" })).toBeNull();
  });

  it("treats a past_due Starter as still on the plan, matching the number gate", async () => {
    await openPlansFor("past_due");
    expect(screen.getByRole("button", { name: "billing.upgradeDialog.actions.currentPlan" })).toBeTruthy();
  });
});

describe("changing the plan of a business that already pays", () => {
  async function upgradeStarter(answer: () => Record<string, unknown>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    client.setQueryData(["billing", "business"], { plans: builtInBillingPlanList(), account: { plan: "starter", billingInterval: "monthly", subscriptionState: "active" }, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["annual", "monthly"], pro: ["annual", "monthly"] } });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({ requestId: "request" }) : Response.json({ checkoutUrl: null, error: null, synced: false, refusal: null, ...answer() }));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    return { client, assign, fetchMock };
  }

  it("says the subscription changes in place, closes the picker and refreshes the plan once Polar confirms it", async () => {
    let synced = false;
    const { client, assign, fetchMock } = await upgradeStarter(() => ({ status: "changed", synced }));
    expect(screen.getByText("billing.upgradeDialog.changesSubscription")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    await waitFor(() => expect(alerts.success).toHaveBeenCalledWith("billing.toast.planChanged"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(client.getQueryState(["billing", "business"])?.isInvalidated).toBe(false);
    synced = true;
    await waitFor(() => expect(client.getQueryState(["billing", "business"])?.isInvalidated).toBe(true), { timeout: 3_000 });
    const polls = fetchMock.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 1_700));
    expect(fetchMock.mock.calls.length).toBe(polls);
    expect(alerts.success).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
    expect(alerts.error).not.toHaveBeenCalled();
  });

  it("gives Polar's reason when it refuses the change", async () => {
    await upgradeStarter(() => ({ status: "error", error: "Polar couldn't charge the saved payment method for the new plan.", refusal: "payment_failed" }));
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.toast.planChangeRefused.payment_failed"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(alerts.success).not.toHaveBeenCalled();
  });

  it("says the plan didn't change, not that checkout failed, for any other error", async () => {
    await upgradeStarter(() => ({ status: "error", error: "Polar plan change failed." }));
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.toast.planChangeFailed"));
  });
});

describe("a billing email for a business Polar can't give their own", () => {
  it("asks for one when Polar has their email for another business, and starts the checkout again with it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    client.setQueryData(["billing", "business"], { plans: builtInBillingPlanList(), account: { plan: "free_cloud" }, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["annual"], pro: ["annual"] } });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const taken = { status: "error", checkoutUrl: null, error: "Polar already has a customer with this email for another business.", refusal: "billing_email_taken" };
    const answers: Record<string, Record<string, unknown>> = { "request-1": taken, "request-2": taken, "request-3": { status: "ready", checkoutUrl: "https://checkout.example/session", error: null, refusal: null } };
    let requests = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({ requestId: `request-${++requests}` }) : Response.json({ synced: false, ...answers[new URL(url, "https://app.example").searchParams.get("requestId") ?? ""] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));

    // Their own email: the picker says why and asks for another.
    expect(await screen.findByText("billing.toast.planChangeRefused.billing_email_taken")).toBeTruthy();
    const field = () => screen.getByLabelText("billing.billingEmail.label") as HTMLInputElement;
    await userEvent.type(field(), "billing@example.com");
    await userEvent.click(screen.getByRole("button", { name: "billing.billingEmail.submit" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/billing/checkout", expect.objectContaining({ body: JSON.stringify({ businessId: "business", target: "pro", billingInterval: "annual", billingEmail: "billing@example.com" }) })));

    // That one is taken too, and the field says so.
    expect(await screen.findByText("billing.billingEmail.taken")).toBeTruthy();
    expect(field().value).toBe("billing@example.com");
    await userEvent.clear(field());
    await userEvent.type(field(), "salon@example.com");
    await userEvent.click(screen.getByRole("button", { name: "billing.billingEmail.submit" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/session"), { timeout: 3_000 });
    expect(JSON.parse(String((fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").at(-1)![1] as RequestInit).body))).toMatchObject({ billingEmail: "salon@example.com" });
    expect(alerts.error).not.toHaveBeenCalled();
  });

  it("drops the question when they pick a plan again or close the picker", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    client.setQueryData(["billing", "business"], { plans: builtInBillingPlanList(), account: { plan: "free_cloud" }, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["annual"], pro: ["annual"] } });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({ requestId: "request" }) : Response.json({ status: "error", checkoutUrl: null, error: "Polar didn't accept the billing email.", synced: false, refusal: "billing_email_invalid" })));
    render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    expect(await screen.findByText("billing.toast.planChangeRefused.billing_email_invalid")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "billing.billingEmail.cancel" }));
    expect(screen.queryByLabelText("billing.billingEmail.label")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    expect(await screen.findByLabelText("billing.billingEmail.label")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "accessibility.close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    expect(screen.queryByLabelText("billing.billingEmail.label")).toBeNull();
    expect(alerts.error).not.toHaveBeenCalled();
  });
});

describe("checkout workspace isolation", () => {
  it.each(["starter", "pro"])("switches displayed prices and submits %s with the selected monthly interval", async target => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    client.setQueryData(["billing", "business"], { plans: builtInBillingPlanList(), account: { plan: "free_cloud" }, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["annual", "monthly"], pro: ["annual", "monthly"] } });
    const fetchMock = vi.fn(async () => Response.json({ error: "Checkout unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    expect(screen.getByText("$24")).toBeTruthy();
    expect(screen.getByText("$80")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "billing.upgradeDialog.billingIntervals.monthly" }));
    expect(screen.getByText("$30")).toBeTruthy();
    expect(screen.getByText("$100")).toBeTruthy();
    expect(screen.queryByText("$24")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: `billing.upgradeDialog.actions.${target}` }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/billing/checkout", expect.objectContaining({ body: JSON.stringify({ businessId: "business", target, billingInterval: "monthly" }) })));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.toast.checkoutFailed"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("says so when the business or person started too many checkouts this hour", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    client.setQueryData(["billing", "business"], { plans: builtInBillingPlanList(), account: { plan: "free_cloud" }, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["annual", "monthly"], pro: ["annual", "monthly"] } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Too many checkouts started. Try again in 12 minutes.", code: "billing_rate_limited" }, { status: 429 })));
    render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.toast.rateLimited"));
  });
  it.each(["success", "failure"])("ignores late checkout %s after changing workspaces", async outcome => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    const workspaces = (active: string) => ({ businesses: ["a", "b"].map(businessId => ({ businessId, active: businessId === active, role: "business_owner" })) });
    client.setQueryData(["businesses"], workspaces("a"));
    for (const businessId of ["a", "b"]) client.setQueryData(["billing", businessId], { plans: builtInBillingPlanList(), account: { plan: "free_cloud" }, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["annual"], pro: ["annual"] } });
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<Response>((accept, fail) => { resolve = accept; reject = fail; });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toMatchObject({ businessId: "a", target: "pro", billingInterval: "annual" });
    await act(async () => client.setQueryData(["businesses"], workspaces("b")));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    await act(async () => { if (outcome === "success") resolve(Response.json({ requestId: "old-request" })); else reject(new Error("Old workspace checkout failed")); });
    await waitFor(() => expect(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(alerts.error).not.toHaveBeenCalled();
  });
});

describe("telling the dashboard an upgrade is under way", () => {
  async function renderPlans(fetchMock: (url: string, init?: RequestInit) => Promise<Response>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    client.setQueryData(["billing", "business"], { plans: builtInBillingPlanList(), account: { plan: "free_cloud" }, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["annual"], pro: ["annual"] } });
    vi.stubGlobal("fetch", vi.fn(fetchMock));
    const view = render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    expect(isUpgradeInProgress()).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    return view;
  }

  it("holds from opening the picker until the redirect, even if the picker closes mid-checkout", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    let status = "pending";
    await renderPlans(async (_url, init) => init?.method === "POST"
      ? Response.json({ requestId: "request" })
      : Response.json({ status, checkoutUrl: status === "ready" ? "https://checkout.example/session" : null, error: null }));
    expect(isUpgradeInProgress()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    await userEvent.click(screen.getByRole("button", { name: "accessibility.close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(isUpgradeInProgress()).toBe(true);
    status = "ready";
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/session"), { timeout: 3_000 });
    expect(isUpgradeInProgress()).toBe(true);
  });

  it("lets them pick again when the back button restores the page from cache", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    await renderPlans(async (_url, init) => init?.method === "POST"
      ? Response.json({ requestId: "request" })
      : Response.json({ status: "ready", checkoutUrl: "https://checkout.example/session", error: null }));
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/session"), { timeout: 3_000 });
    // The Pro button shows its loading state while the redirect is under way.
    expect(screen.queryByRole("button", { name: "billing.upgradeDialog.actions.pro" })).toBeNull();
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    act(() => { window.dispatchEvent(restored); });
    await waitFor(() => expect(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" })).toHaveProperty("disabled", false));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(isUpgradeInProgress()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "accessibility.close" }));
    await waitFor(() => expect(isUpgradeInProgress()).toBe(false));
  });

  it("doesn't hold the survey off when billing fails and the picker never shows", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Billing unavailable" }, { status: 503 })));
    render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    await waitFor(() => expect(client.getQueryState(["billing", "business"])?.status).toBe("error"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(isUpgradeInProgress()).toBe(false);
  });

  it("lets go once a failed checkout's picker is closed, and on unmount", async () => {
    const view = await renderPlans(async () => Response.json({ error: "Checkout unavailable" }, { status: 503 }));
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.toast.checkoutFailed"));
    expect(isUpgradeInProgress()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "accessibility.close" }));
    await waitFor(() => expect(isUpgradeInProgress()).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    expect(isUpgradeInProgress()).toBe(true);
    view.unmount();
    expect(isUpgradeInProgress()).toBe(false);
  });
});

describe("starting a plan from a prepaid pack", () => {
  // On the prepaid tier the usage status counts the live packs only, while packs lists frozen ones too.
  const onPack = { effectivePlan: "prepaid", usageStatus: { pack: { secondsTotal: 60_000, secondsUsed: 30_000, secondsLeft: 30_030, nextEndsAt: null, lastEndsAt: null } }, packs: [{ status: "active", secondsTotal: 60_000, secondsLeft: 30_030 }] };
  async function openPlans(account: Record<string, unknown> | null, billing: Record<string, unknown> = onPack) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    client.setQueryData(["billing", "business"], { plans: builtInBillingPlanList(), account, ...billing, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["annual", "monthly"], pro: ["annual", "monthly"] } });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({ requestId: "request" }) : Response.json({ status: "pending", checkoutUrl: null, error: null, synced: false, refusal: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    return fetchMock;
  }

  it("marks no card current and warns that the packs and their minutes end", async () => {
    await openPlans({ plan: "free_cloud", billingInterval: null, subscriptionState: null });
    expect(screen.queryByRole("button", { name: "billing.upgradeDialog.actions.currentPlan" })).toBeNull();
    expect(screen.getByText("billing.upgradeDialog.endsPacks:500")).toBeTruthy();
    expect(screen.queryByText("billing.upgradeDialog.changesSubscription")).toBeNull();
  });

  it("counts a frozen pack's minutes with the live packs', since the new subscription ends it too", async () => {
    await openPlans({ plan: "free_cloud", billingInterval: null, subscriptionState: null }, { ...onPack, packs: [...onPack.packs, { status: "frozen", secondsTotal: 30_000, secondsLeft: 3_000 }] });
    expect(screen.getByText("billing.upgradeDialog.endsPacks:550")).toBeTruthy();
  });

  it("warns a business on Free whose only pack is frozen while a dispute is open", async () => {
    await openPlans({ plan: "free_cloud", billingInterval: null, subscriptionState: null }, { effectivePlan: "free_cloud", usageStatus: { pack: null }, packs: [{ status: "frozen", secondsTotal: 30_000, secondsLeft: 6_000 }] });
    expect(screen.getByText("billing.upgradeDialog.endsPacks:100")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "billing.upgradeDialog.actions.currentPlan" })).toHaveLength(1);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["a free business without packs", { plan: "free_cloud", billingInterval: null, subscriptionState: null }, { effectivePlan: "free_cloud", usageStatus: { pack: null }, packs: [] }],
    ["a yearly Starter business, whose plan changes in place, with a pack waiting beside it", { plan: "starter", billingInterval: "annual", subscriptionState: "active" }, { effectivePlan: "starter", usageStatus: { pack: null }, packs: [{ status: "active", secondsTotal: 30_000, secondsLeft: 6_000 }] }],
    ["a business on a managed plan with a pack waiting beside it", { source: "managed", plan: "enterprise", billingInterval: null, subscriptionState: "active" }, { effectivePlan: "enterprise", usageStatus: { pack: null }, packs: [{ status: "active", secondsTotal: 30_000, secondsLeft: 6_000 }] }],
  ])("doesn't warn %s", async (_business, account, billing) => {
    await openPlans(account, billing);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByText(/^billing\.upgradeDialog\.endsPacks/)).toBeNull();
  });

  it("opens a checkout rather than changing the subscription a pack replaced, which the provider still reports live", async () => {
    const fetchMock = await openPlans({ plan: "pro", billingInterval: "monthly", subscriptionState: "active" });
    expect(screen.queryByText("billing.upgradeDialog.changesSubscription")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "billing.upgradeDialog.actions.pro" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/billing/checkout", expect.objectContaining({ method: "POST" })));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/billing/checkout")!;
    expect(JSON.parse(String(init!.body))).toEqual({ businessId: "business", target: "pro", billingInterval: "annual" });
    expect(screen.queryByText("billing.actions.changingPlan")).toBeNull();
  });
});

describe("buying a pack from its card", () => {
  const offer = { code: "listing_1", names: { en: "One listing" }, minutes: 250, voiceSeconds: 15_000, days: 180, amountCents: 9_900, currency: "cad", smsSegments: 50, outboundCalls: 20, chatUnits: 50, knowledgeStorageBytes: 20_971_520, numbers: 1, receptionists: 1, checkoutAvailable: true };
  const planDisplay = { plans: [{ plan: "free_cloud" }, { pack: "listing_1", button: { en: "Add it to your listing" } }], comparison: [] };
  async function openPlans(account: Record<string, unknown>, packCheckout: Record<string, unknown>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role: "business_owner" }] });
    client.setQueryData(["billing", "business"], { plans: builtInBillingPlanList(), account, planDisplay, packOffers: [offer], packCheckout, availableCheckoutPlans: ["starter", "pro"], availableCheckoutIntervals: { starter: ["monthly"], pro: ["monthly"] } });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/billing/packs/checkout" && init?.method === "POST") return Response.json({ checkoutId: "pc-1" }, { status: 202 });
      if (url.startsWith("/api/billing/packs/checkout?")) return Response.json({ status: "ready", checkoutUrl: "https://pay.example/pc-1", error: null, packStatus: null, synced: false, closedForPlan: false, refusal: null, providerName: "Stripe" });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<QueryClientProvider client={client}><LiveUpgradePlanProvider><OpenButton /></LiveUpgradePlanProvider></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open plans" }));
    const bought = () => fetchMock.mock.calls.filter(([url]) => url === "/api/billing/packs/checkout").map(([, init]) => JSON.parse(String(init!.body)));
    return { assign, bought, view };
  }

  it("opens the pack's payment page, and lets go of the upgrade once it unmounts", async () => {
    const { assign, bought, view } = await openPlans({ plan: "free_cloud" }, { refusal: null, endsSubscription: null });
    await userEvent.click(screen.getByRole("button", { name: "Add it to your listing" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.example/pc-1"), { timeout: 3_000 });
    expect(bought()).toEqual([{ businessId: "business", pack: "listing_1" }]);
    expect(isUpgradeInProgress()).toBe(true);
    view.unmount();
    expect(isUpgradeInProgress()).toBe(false);
  });

  it("asks first when the pack's payment ends the business's plan", async () => {
    const { assign, bought } = await openPlans({ plan: "starter", billingInterval: "monthly", subscriptionState: "active" }, { refusal: null, endsSubscription: { plan: "starter", promo: false, periodEnd: null } });
    await userEvent.click(screen.getByRole("button", { name: "Add it to your listing" }));
    expect(await screen.findByText("billing.packs.endsPlanDialog.title")).toBeTruthy();
    expect(bought()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.endsPlanDialog.confirm" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.example/pc-1"), { timeout: 3_000 });
    expect(bought()).toEqual([{ businessId: "business", pack: "listing_1" }]);
  });

  it("shows no pack card where the business's plan sells none", async () => {
    await openPlans({ source: "managed", plan: "enterprise" }, { refusal: "managed_plan", endsSubscription: null });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add it to your listing" })).toBeNull();
  });
});
