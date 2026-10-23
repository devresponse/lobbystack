// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingCodeView } from "@lobbystack/shared";
import { isUpgradeInProgress, setUpgradeInProgress } from "@/lib/upgrade-in-progress";
import { PromoCodeEntry } from "./promo-code-entry";

const translate = vi.hoisted(() => vi.fn((key: string, options?: Record<string, unknown>) => options ? `${key} ${JSON.stringify(options)}` : key));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: translate }) }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const view: BillingCodeView = {
  code: "SALONS-2026",
  plan: "salons-half-off",
  tier: "starter",
  names: { en: "Salons half off" },
  discount: { type: "percentage", basis_points: 5000, duration: "repeating", duration_in_months: 3 },
  currency: "cad",
  current: false,
  prices: [{ interval: "monthly", cents: 2900, discountedCents: 1450, checkoutAvailable: true }, { interval: "annual", cents: 29000, discountedCents: 14500, checkoutAvailable: false }],
  included: { voiceSeconds: 18_000, alertSmsSegments: 50, outboundCallAttempts: 20, chatAiUnits: 50, knowledgeStorageBytes: 10 * 1024 ** 2, businessNumbers: 1 },
  moreThanTier: ["voiceSeconds", "knowledgeStorageBytes"],
};
let store: Record<string, string> = {};
const clients: QueryClient[] = [];
beforeEach(() => {
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
  });
});
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; window.history.replaceState(null, "", "/"); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function setup(answer: (url: string, init?: RequestInit) => Response, props: { changesPlan?: boolean } = {}) {
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, href: window.location.href, assign });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(url, init));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><PromoCodeEntry businessId="business" {...props} /></QueryClientProvider>);
  return { assign, fetchMock };
}
const body = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;

describe("Have a promo code?", () => {
  it("shows the plan a typed code unlocks and buys it at the discounted price", async () => {
    const { assign, fetchMock } = setup((url, init) => {
      if (url.startsWith("/api/billing/promo?")) return Response.json(view);
      if (url === "/api/billing/checkout" && init?.method === "POST") return Response.json({ requestId: "promo-checkout" });
      return Response.json({ status: "ready", checkoutUrl: "https://checkout.example/promo", error: null, synced: false, refusal: null });
    });
    await userEvent.click(screen.getByRole("button", { name: "billing.promo.link" }));
    await userEvent.type(screen.getByLabelText("billing.promo.label"), "salons-2026");
    await userEvent.click(screen.getByRole("button", { name: "billing.promo.apply" }));
    await screen.findByText("CA$14.50");
    expect(screen.getByText("CA$29").className).toContain("line-through");
    // The plan's own allowances, those above Starter's marked.
    const voice = screen.getByText('billing.currentPlan.includedVoice {"count":300}').closest("li")!;
    expect(voice.textContent).toContain("billing.promo.moreThanTier");
    expect(screen.getByText('billing.currentPlan.includedStorage {"amount":"10","unit":"MB"}').closest("li")!.textContent).toContain("billing.promo.moreThanTier");
    expect(screen.getByText('billing.currentPlan.includedSms {"count":50}').closest("li")!.textContent).not.toContain("billing.promo.moreThanTier");
    expect(body(fetchMock.mock.calls[0]![1])).toEqual({ code: "salons-2026" });
    expect(screen.getByRole("button", { name: "billing.promo.unavailable" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "billing.promo.subscribe.monthly" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/promo"), { timeout: 3_000 });
    const checkout = fetchMock.mock.calls.find(([url, init]) => url === "/api/billing/checkout" && init?.method === "POST");
    expect(body(checkout![1])).toEqual({ businessId: "business", target: "starter", billingInterval: "monthly", promoCode: "SALONS-2026" });
  });

  it("checks a promo link's code at once and forgets it when it doesn't work", async () => {
    window.history.replaceState(null, "", "/settings/plan?promo=nope-1234");
    setup(() => Response.json({ error: "That code isn't valid.", code: "promo_invalid" }, { status: 400 }));
    await screen.findByText("billing.promo.errors.invalid");
    expect(screen.getByLabelText<HTMLInputElement>("billing.promo.label").value).toBe("NOPE-1234");
    expect(store["lobbystack.billing.promoCode"]).toBeUndefined();
  });

  it("forgets a promo link's code for the plan the business already has", async () => {
    store["lobbystack.billing.promoCode"] = "SALONS-2026";
    setup(() => Response.json({ ...view, current: true }));
    await screen.findByText("billing.promo.errors.current");
    expect(screen.queryByRole("button", { name: "billing.promo.subscribe.monthly" })).toBeNull();
    expect(store["lobbystack.billing.promoCode"]).toBeUndefined();
  });

  it("moves a paying business's subscription without a checkout page", async () => {
    store["lobbystack.billing.promoCode"] = "SALONS-2026";
    const { assign } = setup((url, init) => {
      if (url.startsWith("/api/billing/promo?")) return Response.json(view);
      if (url === "/api/billing/checkout" && init?.method === "POST") return Response.json({ requestId: "promo-change" });
      return Response.json({ status: "changed", checkoutUrl: null, error: null, synced: true, refusal: null });
    }, { changesPlan: true });
    await userEvent.click(await screen.findByRole("button", { name: "billing.promo.change.monthly" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("billing.toast.planChanged"));
    await screen.findByRole("button", { name: "billing.promo.link" });
    expect(assign).not.toHaveBeenCalled();
    expect(store["lobbystack.billing.promoCode"]).toBeUndefined();
  });

  it("holds off the leaving survey while a code's plan change waits for Polar, without clearing the upgrade dialog's hold", async () => {
    store["lobbystack.billing.promoCode"] = "SALONS-2026";
    setup((url, init) => {
      if (url.startsWith("/api/billing/promo?")) return Response.json(view);
      if (url === "/api/billing/checkout" && init?.method === "POST") return Response.json({ requestId: "promo-change" });
      return Response.json({ status: "changed", checkoutUrl: null, error: null, synced: false, refusal: null });
    }, { changesPlan: true });
    const change = await screen.findByRole("button", { name: "billing.promo.change.monthly" });
    expect(isUpgradeInProgress()).toBe(false);
    setUpgradeInProgress(true);
    await userEvent.click(change);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("billing.toast.planChanged"));
    setUpgradeInProgress(false);
    expect(isUpgradeInProgress()).toBe(true);
    cleanup();
    expect(isUpgradeInProgress()).toBe(false);
  });
});
