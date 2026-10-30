// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../public/locales/en/auth.json";
import { CancelAccountSurface } from "./cancel-account-surface";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); window.history.replaceState({}, "", "/"); });

const copy = en.cancelAccount;
const pending = { businessName: "Main", email: "owner@example.test", expiresAt: "2026-10-31T15:11:00.000Z", state: "pending" };

/** Opens the page from the owner's email, signed in or not, with what the link's preview and the confirmation answer. */
async function open({ token = "fixture-token", signedIn = true, cancellation = pending as typeof pending | null, confirm = Response.json({ ok: true, businessName: "Main" }) as Response } = {}) {
  window.history.replaceState({}, "", token ? `/en/cancel-account?token=${token}` : "/en/cancel-account");
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("get-session")) return Response.json(signedIn ? { user: { id: "owner" } } : null);
    if (url.includes("sign-out")) return Response.json({ success: true });
    if (init?.method === "POST") return confirm;
    return Response.json({ cancellation });
  });
  vi.stubGlobal("fetch", fetchMock);
  const i18n = createInstance();
  await i18n.init({ lng: "en", defaultNS: "auth", resources: { en: { auth: en } } });
  render(<I18nextProvider i18n={i18n}><CancelAccountSurface /></I18nextProvider>);
  await waitFor(() => expect(screen.queryByText(copy.loading)).toBeNull());
  const confirmations = () => fetchMock.mock.calls.filter(([url]) => url === "/api/businesses/cancellation/confirm");
  return { fetchMock, confirmations };
}

async function cancelWith(password: string) {
  await userEvent.type(await screen.findByLabelText(copy.passwordLabel), password);
  await userEvent.click(screen.getByRole("button", { name: copy.submit }));
}

describe("the page an owner's cancellation email opens", () => {
  it("asks a signed-out owner to sign in as the address the link went to, then brings them back to the link", async () => {
    const { fetchMock } = await open({ signedIn: false });
    expect(await screen.findByText("To cancel Main, sign in as owner@example.test.")).toBeTruthy();
    const signIn = screen.getByRole("link", { name: copy.signIn });
    expect(signIn.getAttribute("href")).toBe(`/en/login?returnTo=${encodeURIComponent("/en/cancel-account?token=fixture-token")}`);
    expect(screen.queryByLabelText(copy.passwordLabel)).toBeNull();
    // The preview asks by the link's token.
    expect(fetchMock).toHaveBeenCalledWith("/api/businesses/cancellation?token=fixture-token");
  });

  it("says what canceling does and asks the signed-in owner for their password before canceling", async () => {
    const { confirmations } = await open();
    expect(await screen.findByText("Enter your password to cancel Main.")).toBeTruthy();
    expect(screen.getByTestId("cancel-account-effects").textContent).toBe(copy.effects);
    expect(screen.getByRole("button", { name: copy.submit })).toHaveProperty("disabled", true);
    expect(screen.getByRole("link", { name: copy.keep }).getAttribute("href")).toBe("/");

    await cancelWith("correct horse");
    expect(await screen.findByText(copy.canceledTitle)).toBeTruthy();
    expect(screen.getByText("Main is closed, and nothing was deleted. To use the service again, start a new business.")).toBeTruthy();
    expect(confirmations()).toEqual([["/api/businesses/cancellation/confirm", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "fixture-token", password: "correct horse" }) })]]);
  });

  it("starts over from the home page, which has no business left to open and so starts onboarding", async () => {
    await open();
    await cancelWith("correct horse");
    await userEvent.click(await screen.findByRole("button", { name: copy.startOver }));
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("clears a wrong password, so the owner types it again", async () => {
    await open({ confirm: Response.json({ error: "That password isn't right.", code: "invalid_password" }, { status: 400 }) });
    await cancelWith("wrong");
    expect((await screen.findByRole("alert")).textContent).toBe(copy.errors.invalid_password);
    expect(screen.getByLabelText<HTMLInputElement>(copy.passwordLabel).value).toBe("");
    expect(screen.queryByText(copy.canceledTitle)).toBeNull();
  });

  it.each([
    ["other_businesses", 403],
    ["call_in_progress", 409],
    ["number_in_progress", 409],
    ["checkout_open", 409],
    ["expired", 410],
    ["rate_limited", 429],
  ] as const)("explains a %s refusal and cancels nothing", async (code, status) => {
    await open({ confirm: Response.json({ error: "Refused.", code }, { status }) });
    await cancelWith("correct horse");
    expect((await screen.findByRole("alert")).textContent).toBe(copy.errors[code]);
    expect(screen.queryByText(copy.canceledTitle)).toBeNull();
  });

  it("says it couldn't cancel on any other failure", async () => {
    await open({ confirm: Response.json({ error: "Request failed." }, { status: 500 }) });
    await cancelWith("correct horse");
    expect((await screen.findByRole("alert")).textContent).toBe(copy.errors.failed);
  });

  it("lets an owner signed in with another account switch to the one the link went to", async () => {
    const { fetchMock } = await open({ confirm: Response.json({ error: "Sign in as the owner who asked to cancel the business.", code: "wrong_account" }, { status: 403 }) });
    await cancelWith("correct horse");
    expect(await screen.findByText("This link was sent to owner@example.test. Sign in with that account to cancel the business.")).toBeTruthy();
    expect(screen.queryByLabelText(copy.passwordLabel)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: copy.switchAccount }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/en/login?returnTo=${encodeURIComponent("/en/cancel-account?token=fixture-token")}`));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-out", expect.objectContaining({ method: "POST" }));
  });

  it.each([
    ["expired", copy.expired],
    ["replaced", copy.replaced],
    ["canceled", "Main is already canceled."],
  ] as const)("explains a link that's %s, with nothing to confirm", async (state, message) => {
    await open({ cancellation: { ...pending, state } });
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByLabelText(copy.passwordLabel)).toBeNull();
    expect(screen.getByRole("link", { name: copy.backToDashboard }).getAttribute("href")).toBe("/");
  });

  it("calls a link without a token, or one that matches none, not valid", async () => {
    const { fetchMock } = await open({ token: "" });
    expect(await screen.findByText(copy.invalidLink)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith("/api/businesses/cancellation"))).toBe(false);
    cleanup();
    await open({ signedIn: false, cancellation: null });
    expect(await screen.findByText(copy.invalidLink)).toBeTruthy();
    expect(screen.getByRole("link", { name: copy.backToLogin }).getAttribute("href")).toBe("/en/login");
  });
});
