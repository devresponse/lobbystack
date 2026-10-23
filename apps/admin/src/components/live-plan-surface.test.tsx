// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtInBillingPlanLimits, builtInBillingPlanList, type BillingPlanLimits, type BillingPlanList, type BillingPlanSlug, type BillingPromoPlanView } from "@lobbystack/shared";
import { LivePlanSurface } from "./live-plan-surface";
import { UpgradePlanDialogProvider } from "./upgrade-plan-dialog-context";
const route = vi.hoisted(() => ({ router: { replace: vi.fn() }, search: new URLSearchParams() }));
const translate = vi.hoisted(() => vi.fn((key: string) => key));
vi.mock("next/navigation", () => ({ useRouter: () => route.router, useSearchParams: () => route.search }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: translate }) }));
const clients: QueryClient[] = [];
beforeEach(() => { route.search = new URLSearchParams(); vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() }); });
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });
function setup({ synced = false, checkoutFails = false, billingFails = false, plan = "pro" as BillingPlanSlug, admin = true, configured = false, transactions = false, accountMissing = false, interval = "monthly", plans = builtInBillingPlanList() as BillingPlanList, limits = undefined as BillingPlanLimits | undefined, promoPlan = null as BillingPromoPlanView | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true }] });
  const billing = { permissions: { hasBillingManagementAccess: admin, hasCheckoutAccess: admin, hasCustomerPortalAccess: admin }, effectivePlan: accountMissing ? "free_cloud" : plan, limits: limits ?? builtInBillingPlanLimits[accountMissing ? "free_cloud" : plan], promoPlan, account: accountMissing ? null : { plan, billingInterval: interval, subscriptionState: "active", overageSpendingCapCents: null }, plans, availableCheckoutPlans: configured ? ["pro"] : [], availableCheckoutIntervals: { starter: [], pro: configured ? ["monthly"] : [] }, transactions: transactions ? [{ kind: "refund", sourceId: "refund", status: "succeeded", amountCents: 1250, currency: "usd", description: "Usage credit", invoiceUrl: "https://example.invalid/invoice", occurredAt: "2026-09-04T12:00:00Z" }, { kind: "order", sourceId: "order", status: "partially_refunded", amountCents: 105_600, refundedAmountCents: 52_800, currency: "usd", description: "Pro annual", invoiceUrl: null, occurredAt: "2026-09-05T12:00:00Z" }] : [] };
  if (!billingFails) client.setQueryData(["billing", "business"], billing);
  const fetchMock = vi.fn(async (url: string) => url.includes("/checkout?") ? checkoutFails ? Response.json({ error: "Provider unavailable" }, { status: 503 }) : Response.json({ synced }) : Response.json(billing));
  if (billingFails) fetchMock.mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QueryClientProvider client={client}><UpgradePlanDialogProvider onOpen={vi.fn()}><LivePlanSurface /></UpgradePlanDialogProvider></QueryClientProvider>);
  return fetchMock;
}
describe("original billing overview behavior", () => {
  it("treats null Enterprise allowances as custom", () => {
    setup({ plan: "enterprise" });
    expect(screen.getByText("billing.currentPlan.includedVoiceCustom")).toBeTruthy();
    expect(screen.getByText("billing.currentPlan.includedSmsCustom")).toBeTruthy();
    expect(screen.queryByText(/Unlimited/)).toBeNull();
  });
  it("shows what the plan costs from the deployment's plan list, in its currency, and what it includes as the server enforces it", () => {
    const plans = builtInBillingPlanList();
    plans.currency = "cad";
    const pro = plans.plans.find(entry => entry.slug === "pro")!;
    pro.prices = [{ interval: "monthly", currency: "cad", amountCents: 12_000, monthlyAmountCents: 12_000, checkoutAvailable: true }, { interval: "annual", currency: "cad", amountCents: 115_200, monthlyAmountCents: 9_600, checkoutAvailable: true }];
    setup({ plan: "pro", interval: "annual", plans, limits: { ...builtInBillingPlanLimits.pro, voiceSecondsIncluded: 36_000, alertSmsSegmentsIncluded: 1, knowledgeStorageBytes: 2 * 1024 ** 3 } });
    expect(screen.getByText("CA$96")).toBeTruthy();
    expect(screen.getByText("billing.currentPlan.annualEffectiveSuffix")).toBeTruthy();
    expect(translate).toHaveBeenCalledWith("billing.currentPlan.includedVoice", { count: 600 });
    expect(translate).toHaveBeenCalledWith("billing.currentPlan.includedSms", { count: 1 });
    expect(translate).toHaveBeenCalledWith("billing.currentPlan.includedOutbound", { count: 100 });
    expect(translate).toHaveBeenCalledWith("billing.currentPlan.includedStorage", { amount: "2", unit: "GB" });
  });
  it("shows a promo plan by its name and price with its own allowances", () => {
    const promoPlan: BillingPromoPlanView = { plan: "salons-plus", tier: "starter", names: { en: "Salons Plus" }, discount: null, currency: "usd", ends: null, endsWith: null, prices: [{ interval: "monthly", cents: 2_500, perMonth: 2_500 }] };
    setup({ plan: "starter", promoPlan, limits: { ...builtInBillingPlanLimits.starter, voiceSecondsIncluded: 18_000, knowledgeStorageBytes: 10 * 1024 ** 2 } });
    expect(screen.getByText("Salons Plus")).toBeTruthy();
    expect(screen.getByText("$25")).toBeTruthy();
    expect(translate).toHaveBeenCalledWith("billing.currentPlan.includedVoice", { count: 300 });
    expect(translate).toHaveBeenCalledWith("billing.currentPlan.includedStorage", { amount: "10", unit: "MB" });
    expect(translate).toHaveBeenCalledWith("billing.currentPlan.includedSms", { count: 50 });
  });
  it("says when a promo plan ends and what the subscription becomes", () => {
    const promoPlan: BillingPromoPlanView = { plan: "salons-plus", tier: "starter", names: { en: "Salons Plus" }, discount: null, currency: "usd", ends: "2026-12-01T12:00:00.000Z", endsWith: "tier", prices: [{ interval: "monthly", cents: 2_500, perMonth: 2_500 }] };
    setup({ plan: "starter", promoPlan });
    expect(translate).toHaveBeenCalledWith("billing.promo.endsTier", { date: expect.stringContaining("2026"), tier: "billing.planLabels.starter" });
    cleanup();
    setup({ plan: "starter", promoPlan: { ...promoPlan, endsWith: "cancel" } });
    expect(translate).toHaveBeenCalledWith("billing.promo.endsCancel", expect.objectContaining({ date: expect.stringContaining("2026") }));
  });
  it("offers a retry after billing fails and recovers the plan", async () => {
    setup({ billingFails: true });
    expect(await screen.findByRole("alert")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "billing.actions.retry" }));
    expect(await screen.findByText("billing.planLabels.proCard")).toBeTruthy();
  });
  it("renders the free plan when the tenant has no billing account yet", () => {
    setup({ accountMissing: true, admin: false });
    expect(screen.getByText("billing.planLabels.freeCloudCard")).toBeTruthy();
    expect(screen.getByText("$0")).toBeTruthy();
    expect(screen.queryByText("billing.spendingCap.title")).toBeNull();
  });
  it("shows paid plan PAYG copy and hides empty transaction history", () => {
    setup();
    expect(screen.getByText("billing.currentPlan.paygMonthlySuffix")).toBeTruthy();
    expect(screen.queryByText("billing.transactions.title")).toBeNull();
    expect(screen.queryByText("billing.subscriptionStates.active")).toBeNull();
    expect(screen.queryByText("billing.usage.voiceTitle")).toBeNull();
  });
  it("shows refunds and the original invoice action", () => {
    setup({ transactions: true });
    expect(screen.getByText("−$12.50")).toBeTruthy();
    expect(screen.getByRole("link", { name: "billing.transactions.invoice" }).getAttribute("href")).toBe("https://example.invalid/invoice");
    expect(screen.getByRole("link", { name: "billing.transactions.invoice" }).getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("link", { name: "billing.transactions.invoice" }).getAttribute("rel")).toContain("noopener");
  });
  it("shows how much of a refunded order went back, in the active locale", () => {
    setup({ transactions: true });
    expect(screen.getByText("$1,056")).toBeTruthy();
    expect(screen.getAllByText("billing.transactions.refundedAmount")).toHaveLength(1);
    expect(translate).toHaveBeenCalledWith("billing.transactions.refundedAmount", { amount: "$528" });
  });
  it("names each transaction's status in the active language", () => {
    setup({ transactions: true });
    expect(translate).toHaveBeenCalledWith("billing.transactions.statusLabels.succeeded", { defaultValue: "succeeded" });
    expect(translate).toHaveBeenCalledWith("billing.transactions.statusLabels.partially_refunded", { defaultValue: "partially_refunded" });
    expect(screen.queryByText("partially_refunded")).toBeNull();
  });
  it("prices Free by the month after an annual plan lapses", () => {
    setup({ plan: "free_cloud", interval: "annual" });
    expect(screen.getByText("$0")).toBeTruthy();
    expect(screen.getByText("billing.currentPlan.monthlySuffix")).toBeTruthy();
    expect(screen.queryByText("billing.currentPlan.annualEffectiveSuffix")).toBeNull();
  });
  it("shows no price, rather than a custom one, once the plan list stops selling the subscription's price", () => {
    const plans = builtInBillingPlanList();
    plans.plans.find(entry => entry.slug === "starter")!.prices = [];
    setup({ plan: "starter", plans });
    expect(screen.getByText("billing.planLabels.starterCard")).toBeTruthy();
    expect(screen.queryByText("billing.currentPlan.customPricing")).toBeNull();
    expect(screen.queryByText("billing.currentPlan.monthlySuffix")).toBeNull();
  });
  it("says self-hosting has no limits or billing instead of a price and allowances", () => {
    setup({ plan: "self_host" });
    expect(screen.getByText("billing.currentPlan.selfHostNotice")).toBeTruthy();
    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.queryByText("billing.currentPlan.includedTitle")).toBeNull();
  });
  it("does not offer upgrades without a configured checkout interval", () => {
    setup({ plan: "starter" });
    expect(screen.queryByRole("button", { name: "billing.actions.upgradeToPro" })).toBeNull();
  });
  it("offers configured upgrades to administrators", () => {
    setup({ plan: "starter", configured: true });
    expect(screen.getByRole("button", { name: "billing.actions.upgradeToPro" })).toBeTruthy();
  });
  it("keeps billing management read-only for members", () => {
    setup({ admin: false, configured: true });
    expect(screen.queryByRole("button", { name: "billing.actions.manageSubscription" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it.each([false, true])("cleans checkout return parameters only after durable synchronization: %s", async synced => {
    route.search = new URLSearchParams("checkout=success&requestId=returned");
    const fetchMock = setup({ synced });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/billing/checkout?businessId=business&requestId=returned", expect.objectContaining({ credentials: "include" })));
    if (synced) await waitFor(() => expect(route.router.replace).toHaveBeenCalledWith("/settings/plan"));
    else expect(route.router.replace).not.toHaveBeenCalled();
    expect(screen.queryByText("billing.toast.checkoutSuccess")).toBeNull();
  });
  it("preserves the checkout return request when provider synchronization fails", async () => {
    route.search = new URLSearchParams("checkout=success&requestId=returned");
    const fetchMock = setup({ checkoutFails: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/billing/checkout?businessId=business&requestId=returned", expect.objectContaining({ credentials: "include" })));
    await waitFor(() => expect(clients.at(-1)?.getQueryState(["billing-checkout-return", "business", "returned"])?.status).toBe("error"));
    expect(route.router.replace).not.toHaveBeenCalled();
    expect(route.search.get("requestId")).toBe("returned");
    expect(screen.queryByText("billing.toast.checkoutSuccess")).toBeNull();
  });
});
