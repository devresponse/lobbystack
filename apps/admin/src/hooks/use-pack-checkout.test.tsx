// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BillingEmailForm } from "@/components/billing-email-form";
import { Button } from "@/components/ui/button";
import { isUpgradeInProgress } from "@/lib/upgrade-in-progress";
import { usePackCheckout } from "./use-pack-checkout";

// A prepaid pack's checkout, as the plan step and the Upgrade plan dialog run
// it from a pack's card: what a purchase posts, the one trip to the payment
// page, the toasts for a refusal or a page that didn't open, and the billing
// email retry. Buy stands for a pack card's button.

const alerts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: alerts }));
const translate = vi.hoisted(() => vi.fn((key: string, options?: Record<string, unknown>) => options ? `${key} ${Object.values(options).join(" ")}` : key));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: translate }) }));

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });

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

/** A pack card's button and the billing email form, as the screens wire them to the hook. */
function Buyer({ pack }: { pack: string }) {
  const checkout = usePackCheckout("business");
  const prompt = checkout.emailPrompt;
  return <>
    <Button disabled={checkout.pending} loading={checkout.pending} loadingLabel="billing.actions.openingCheckout" onClick={() => checkout.start(pack)} type="button">Buy</Button>
    {prompt ? <BillingEmailForm onCancel={checkout.dismissEmailPrompt} onSubmit={(billingEmail) => checkout.start(prompt.pack, billingEmail)} pending={checkout.pending} refusal={prompt.refusal} refusedEmail={prompt.email} /> : null}
  </>;
}

function renderBuyer(pack = "pack-500-180") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  const view = render(<QueryClientProvider client={client}><Buyer pack={pack} /></QueryClientProvider>);
  return { assign, view, client };
}

const posted = (fetchMock: ReturnType<typeof serve>) => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => [url, JSON.parse(String(init!.body))]);

describe("buying a prepaid pack from its card", () => {
  it("posts the card's pack and goes to its payment page once", async () => {
    const fetchMock = serve();
    const { assign, view, client } = renderBuyer("pack-1000-ever");
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    expect(isUpgradeInProgress()).toBe(true);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.example/pc-1"));
    expect(posted(fetchMock)).toEqual([["/api/billing/packs/checkout", { businessId: "business", pack: "pack-1000-ever" }]]);
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/packs/checkout?checkoutId=pc-1&businessId=business", expect.objectContaining({ credentials: "include" }));
    // Another render with the same ready checkout doesn't send them there again.
    view.rerender(<QueryClientProvider client={client}><Buyer pack="pack-1000-ever" /></QueryClientProvider>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("waits while the payment page is being made, then goes there", async () => {
    serve({ statuses: [{ status: "pending" }, { status: "processing" }, { status: "ready", checkoutUrl: "https://pay.example/pc-1" }] });
    const { assign } = renderBuyer();
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    expect(screen.getByRole("button", { name: "billing.actions.openingCheckout" })).toHaveProperty("disabled", true);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.example/pc-1"), { timeout: 5_000 });
  });

  it("says when there were too many tries, and why the checkout refused the pack", async () => {
    serve({ post: () => Response.json({ error: "Too many checkouts.", code: "billing_rate_limited" }, { status: 429 }) });
    renderBuyer();
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.toast.rateLimited"));
    expect(isUpgradeInProgress()).toBe(false);
    serve({ post: () => Response.json({ error: "This pack isn't on sale right now.", code: "pack_not_on_sale" }, { status: 409 }) });
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.packs.refusals.pack_not_on_sale"));
    serve({ post: () => Response.json({ error: "Request failed." }, { status: 500 }) });
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.packs.toast.checkoutFailed"));
  });

  it("says a payment page that failed or expired didn't open, and lets them try again", async () => {
    serve({ statuses: [{ status: "failed", error: "Stripe refused the request." }] });
    renderBuyer();
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.packs.toast.checkoutFailed"));
    expect(screen.getByRole("button", { name: "Buy" })).toHaveProperty("disabled", false);
    serve({ statuses: [{ status: "expired", error: "This request waited too long to run." }] });
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.packs.toast.checkoutExpired"));
  });

  it("says a payment page a plan's start closed was closed for the plan", async () => {
    serve({ statuses: [{ status: "expired", error: "A plan started for this business, so this pack's checkout closed.", closedForPlan: true }] });
    renderBuyer();
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    await waitFor(() => expect(alerts.error).toHaveBeenCalledWith("billing.packs.toast.closedForPlan"));
    expect(alerts.error).not.toHaveBeenCalledWith("billing.packs.toast.checkoutExpired");
  });

  it.each([
    [{ synced: true, packStatus: "active" }, "success", "billing.packs.toast.added"],
    [{ synced: true, packStatus: null }, "success", "billing.packs.toast.added"],
    [{ synced: false, packStatus: "replaced" }, "error", "billing.packs.toast.gaveWay"],
    [{ synced: false, packStatus: "refunded" }, "error", "billing.packs.toast.refundedFirst"],
  ] as const)("says what came of a checkout already paid in another tab (%o)", async (answer, kind, key) => {
    serve({ statuses: [{ status: "paid", ...answer }] });
    renderBuyer();
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    await waitFor(() => expect(alerts[kind]).toHaveBeenCalledWith(key));
    expect(alerts[kind === "success" ? "error" : "success"]).not.toHaveBeenCalled();
  });

  it("asks for a billing email when the provider wouldn't take the person's own, and starts again with it", async () => {
    const fetchMock = serve({ statuses: [{ status: "failed", refusal: "billing_email_taken" }, { status: "ready", checkoutUrl: "https://pay.example/pc-2" }], post: () => Response.json({ checkoutId: fetchMock.mock.calls.length > 1 ? "pc-2" : "pc-1" }, { status: 202 }) });
    const { assign } = renderBuyer();
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    expect(await screen.findByText("billing.toast.planChangeRefused.billing_email_taken")).toBeTruthy();
    expect(alerts.error).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole("textbox"), "billing@salon.example");
    await userEvent.click(screen.getByRole("button", { name: "billing.billingEmail.submit" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.example/pc-2"));
    expect(posted(fetchMock).map(([, body]) => body)).toEqual([{ businessId: "business", pack: "pack-500-180" }, { businessId: "business", pack: "pack-500-180", billingEmail: "billing@salon.example" }]);
  });

  it("lets them buy again when the back button restores the page from the browser's cache", async () => {
    const fetchMock = serve();
    const { assign } = renderBuyer();
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Buy" })).toBeNull();
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    act(() => { window.dispatchEvent(restored); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Buy" })).toHaveProperty("disabled", false));
    expect(isUpgradeInProgress()).toBe(false);
    // The checkout still open comes back from the POST, and its page opens again.
    await userEvent.click(screen.getByRole("button", { name: "Buy" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    expect(posted(fetchMock)).toHaveLength(2);
  });
});
