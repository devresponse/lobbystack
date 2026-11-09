// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isUpgradeInProgress } from "@/lib/upgrade-in-progress";
import type { BillingPackOfferViewModel, BillingPackViewModel, PackCheckoutViewModel } from "@/lib/page-view-models";
import { PacksSection } from "./billing-packs";

// Settings > Plan's packs section: the picker, what a purchase posts, the one
// trip to the payment page, the question before a pack ends a subscription,
// the reasons a business may not buy one, and the billing email retry.

const alerts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: alerts }));
// Each string shows its key, then the values it was given, so a test can tell the choices apart.
const translate = vi.hoisted(() => vi.fn((key: string, options?: Record<string, unknown>) => options ? `${key} ${Object.values(options).join(" ")}` : key));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: translate }) }));

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });

const offer = (code: string, minutes: number, days: number | null, amountCents = 9_900, checkoutAvailable = true): BillingPackOfferViewModel => ({ code, names: { en: code }, minutes, voiceSeconds: minutes * 60, days, amountCents, currency: "cad", smsSegments: 50, outboundCalls: 20, chatUnits: 50, knowledgeStorageBytes: 20_971_520, numbers: 1, receptionists: 1, checkoutAvailable });
const offers = [offer("pack-500-180", 500, 180), offer("pack-500-365", 500, 365, 12_900), offer("pack-1000-365", 1_000, 365, 19_900), offer("pack-1000-ever", 1_000, null, 29_900)];
const held = (patch: Partial<BillingPackViewModel> = {}): BillingPackViewModel => ({ id: "held", code: "pack-500-180", names: { en: "500 minutes" }, status: "active", secondsTotal: 30_000, secondsLeft: 12_030, paidAt: "2026-10-01T00:00:00.000Z", endsAt: "2027-03-30T00:00:00.000Z", ...patch });
const open: PackCheckoutViewModel = { refusal: null, endsSubscription: null };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** A checkout answered as the API answers it: the POST's checkout, then each status the GET reads in turn, the last one again. */
function serve({ post = () => Response.json({ checkoutId: "pc-1" }, { status: 202 }), statuses = [{ status: "ready", checkoutUrl: "https://pay.example/pc-1" }] as Array<Record<string, unknown>> } = {}) {
  let read = 0;
  const fetchMock = vi.fn<Fetch>(async (url, init) => {
    if (init?.method === "POST") return post();
    const answer = statuses[Math.min(read, statuses.length - 1)]!;
    read += 1;
    return Response.json({ checkoutUrl: null, error: null, synced: false, refusal: null, providerName: "Stripe", ...answer });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection(props: Partial<Parameters<typeof PacksSection>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  const view = render(<QueryClientProvider client={client}><PacksSection businessId="business" eligibility={open} managesBilling offers={offers} packs={[]} {...props} /></QueryClientProvider>);
  return { assign, view, client };
}

const posted = (fetchMock: ReturnType<typeof serve>) => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => [url, JSON.parse(String(init!.body))]);

describe("buying a prepaid pack", () => {
  it("posts the pack chosen by its minutes and its length, and goes to its payment page once", async () => {
    const fetchMock = serve();
    const { assign, view, client } = renderSection();
    // The first pack on sale is chosen, at its price.
    expect(screen.getByRole("radio", { name: /minutesOption 500/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("CA$99")).toBeTruthy();
    // A thousand minutes aren't sold for 180 days, so the length moves to the first one they are sold for.
    await userEvent.click(screen.getByRole("radio", { name: /minutesOption 1000/ }));
    expect(screen.getByRole("radio", { name: "billing.packs.daysOption 365" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "billing.packs.daysOption 180" })).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("radio", { name: "billing.packs.neverEndsOption" }));
    expect(screen.getByText("CA$299")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    expect(isUpgradeInProgress()).toBe(true);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.example/pc-1"));
    expect(posted(fetchMock)).toEqual([["/api/billing/packs/checkout", { businessId: "business", pack: "pack-1000-ever" }]]);
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/packs/checkout?checkoutId=pc-1&businessId=business", expect.objectContaining({ credentials: "include" }));
    // Another render with the same ready checkout doesn't send them there again.
    view.rerender(<QueryClientProvider client={client}><PacksSection businessId="business" eligibility={open} managesBilling offers={offers} packs={[]} /></QueryClientProvider>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("waits while the payment page is being made, then goes there", async () => {
    serve({ statuses: [{ status: "pending" }, { status: "processing" }, { status: "ready", checkoutUrl: "https://pay.example/pc-1" }] });
    const { assign } = renderSection();
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    expect(screen.getByRole("button", { name: "billing.actions.openingCheckout" })).toHaveProperty("disabled", true);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.example/pc-1"), { timeout: 5_000 });
  });

  it("asks before a pack ends a Pro subscription with a promo code, and buys only once confirmed", async () => {
    const fetchMock = serve();
    const { assign } = renderSection({ eligibility: { refusal: null, endsSubscription: { plan: "pro", promo: true, periodEnd: "2026-12-01T12:00:00.000Z" } } });
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    expect(posted(fetchMock)).toEqual([]);
    expect(screen.getByText("billing.packs.endsPlanDialog.title billing.planLabels.pro")).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.planEnds billing.planLabels.pro")).toBeTruthy();
    expect(screen.getByText(/^billing\.packs\.endsPlanDialog\.noRefund .*2026/)).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.promoLost")).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.receptionistsPaused")).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.packStarts")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.endsPlanDialog.confirm" }));
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(posted(fetchMock)).toEqual([["/api/billing/packs/checkout", { businessId: "business", pack: "pack-500-180" }]]);
  });

  it("says nothing of a promo code or receptionists when a pack ends a plain Starter subscription, and buys nothing when they go back", async () => {
    const fetchMock = serve();
    renderSection({ eligibility: { refusal: null, endsSubscription: { plan: "starter", promo: false, periodEnd: null } } });
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    expect(screen.getByText("billing.packs.endsPlanDialog.title billing.planLabels.starter")).toBeTruthy();
    expect(screen.getByText("billing.packs.endsPlanDialog.noRefundUndated")).toBeTruthy();
    expect(screen.queryByText("billing.packs.endsPlanDialog.promoLost")).toBeNull();
    expect(screen.queryByText("billing.packs.endsPlanDialog.receptionistsPaused")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "billing.cancelDialog.back" }));
    await waitFor(() => expect(screen.queryByText("billing.packs.endsPlanDialog.packStarts")).toBeNull());
    expect(posted(fetchMock)).toEqual([]);
  });

  it.each(["pack_yearly_plan", "pack_past_due", "plan_change_payment_waiting"] as const)("says in plain words why the business may not buy a pack while %s, and sells none", (refusal) => {
    serve();
    renderSection({ eligibility: { refusal, endsSubscription: null }, offers: offers.map((entry) => ({ ...entry, checkoutAvailable: false })) });
    expect(screen.getByRole("button", { name: "billing.packs.buy" })).toHaveProperty("disabled", true);
    expect(screen.getByText(`billing.packs.refusals.${refusal}`)).toBeTruthy();
  });

  it("says packs can't be bought here when the provider doesn't sell the chosen one", () => {
    serve();
    renderSection({ offers: [offer("pack-500-180", 500, 180, 9_900, false)] });
    expect(screen.getByRole("button", { name: "billing.packs.buy" })).toHaveProperty("disabled", true);
    expect(screen.getByText("billing.packs.unavailable")).toBeTruthy();
  });

  it("offers Buy more beside the packs held, each with its minutes left of its total, its end, and a hold while a dispute is open", () => {
    serve();
    renderSection({ packs: [held(), held({ id: "frozen", code: "pack-1000-ever", names: { en: "1000 minutes" }, status: "frozen", secondsTotal: 60_000, secondsLeft: 60_000, endsAt: null })] });
    expect(screen.getByText("500 minutes")).toBeTruthy();
    expect(translate).toHaveBeenCalledWith("billing.packs.left", { count: 200, left: "200", total: "500" });
    expect(screen.getByText(/^billing\.packs\.endsOn .*2027/)).toBeTruthy();
    expect(screen.getByText("billing.packs.neverEnds")).toBeTruthy();
    expect(screen.getAllByText("billing.packs.frozen")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "billing.packs.buyMore" })).toHaveProperty("disabled", false);
  });

  it("shows members the packs held without selling one, and nothing when none is held", () => {
    serve();
    renderSection({ managesBilling: false, packs: [held()] });
    expect(screen.getByText("500 minutes")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    renderSection({ managesBilling: false });
    expect(screen.queryByText("billing.packs.title")).toBeNull();
  });

  it.each(["managed_plan", "pack_not_sold_on_plan"] as const)("hides the section on a plan that sells no packs (%s), unless packs are still held, which show read-only", (refusal) => {
    serve();
    renderSection({ eligibility: { refusal, endsSubscription: null } });
    expect(screen.queryByText("billing.packs.title")).toBeNull();
    cleanup();
    renderSection({ eligibility: { refusal, endsSubscription: null }, packs: [held()] });
    expect(screen.getByText("500 minutes")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says when there were too many tries, and why the checkout refused the pack", async () => {
    serve({ post: () => Response.json({ error: "Too many checkouts.", code: "billing_rate_limited" }, { status: 429 }) });
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.toast.rateLimited"));
    expect(isUpgradeInProgress()).toBe(false);
    serve({ post: () => Response.json({ error: "This pack isn't on sale right now.", code: "pack_not_on_sale" }, { status: 409 }) });
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.packs.refusals.pack_not_on_sale"));
    serve({ post: () => Response.json({ error: "Request failed." }, { status: 500 }) });
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.packs.toast.checkoutFailed"));
  });

  it("says a payment page that failed or expired didn't open, and lets them try again", async () => {
    serve({ statuses: [{ status: "failed", error: "Stripe refused the request." }] });
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.packs.toast.checkoutFailed"));
    expect(screen.getByRole("button", { name: "billing.packs.buy" })).toHaveProperty("disabled", false);
    serve({ statuses: [{ status: "expired", error: "This request waited too long to run." }] });
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.packs.toast.checkoutExpired"));
  });

  it("asks for a billing email when the provider wouldn't take the person's own, and starts again with it", async () => {
    const fetchMock = serve({ statuses: [{ status: "failed", refusal: "billing_email_taken" }, { status: "ready", checkoutUrl: "https://pay.example/pc-2" }], post: () => Response.json({ checkoutId: fetchMock.mock.calls.length > 1 ? "pc-2" : "pc-1" }, { status: 202 }) });
    const { assign } = renderSection();
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    expect(await screen.findByText("billing.toast.planChangeRefused.billing_email_taken")).toBeTruthy();
    expect(alerts.error).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole("textbox"), "billing@salon.example");
    await userEvent.click(screen.getByRole("button", { name: "billing.billingEmail.submit" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.example/pc-2"));
    expect(posted(fetchMock).map(([, body]) => body)).toEqual([{ businessId: "business", pack: "pack-500-180" }, { businessId: "business", pack: "pack-500-180", billingEmail: "billing@salon.example" }]);
  });

  it("lets them buy again when the back button restores the page from the browser's cache", async () => {
    const fetchMock = serve();
    const { assign } = renderSection();
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "billing.packs.buy" })).toBeNull();
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    act(() => { window.dispatchEvent(restored); });
    await waitFor(() => expect(screen.getByRole("button", { name: "billing.packs.buy" })).toHaveProperty("disabled", false));
    expect(isUpgradeInProgress()).toBe(false);
    // The checkout still open comes back from the POST, and its page opens again.
    await userEvent.click(screen.getByRole("button", { name: "billing.packs.buy" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    expect(posted(fetchMock)).toHaveLength(2);
  });
});
