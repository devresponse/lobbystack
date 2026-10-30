// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../public/locales/en/settings.json";
import { LiveTeamSurface } from "./live-team-surface";
import type { Business } from "@/hooks/use-active-business";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/settings/team" }));

const copy = en.workspaceTeam.delete;
const cancelCopy = en.workspaceTeam.cancelAccount;
const clients: QueryClient[] = [];
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() }); });
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.unstubAllGlobals(); vi.clearAllMocks(); });

// An owner whose first business, Main, is their root, working in a later one, Studio.
const main: Business = { businessId: "main", name: "Main", slug: "main", role: "business_owner", active: false, isRoot: true, isAccountRoot: true };
const studio: Business = { businessId: "studio", name: "Studio", slug: "studio", role: "business_owner", active: true, isRoot: false, isAccountRoot: false };

async function setup({ businesses = [main, studio], response = undefined as Response | undefined } = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", defaultNS: "settings", resources: { en: { settings: en } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses });
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return response ?? Response.json({ ok: true });
    if (init?.method === "POST") return response ?? Response.json({ email: "owner@example.test", expiresAt: "2026-10-31T15:11:00.000Z" });
    return Response.json({ members: [], invitations: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><LiveTeamSurface /></QueryClientProvider></I18nextProvider>);
  await screen.findByText(en.workspaceTeam.members.empty);
  const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
  return { client, deletes, posts };
}

async function openDialog() {
  await userEvent.click(screen.getByRole("button", { name: copy.action }));
  return await screen.findByRole("dialog");
}

async function confirm(dialog: HTMLElement, name: string, password: string) {
  if (name) await userEvent.type(within(dialog).getByLabelText(/^Type .* to confirm$/), name);
  if (password) await userEvent.type(within(dialog).getByLabelText(copy.passwordLabel), password);
}

describe("deleting a business from the Team page", () => {
  it("warns that it's permanent and asks for the business's name and the owner's password", async () => {
    const { deletes } = await setup();
    const dialog = await openDialog();
    expect(within(dialog).getByText("Delete Studio?")).toBeTruthy();
    expect(within(dialog).getByText(copy.dialogDescription)).toBeTruthy();
    expect(within(dialog).getByTestId("delete-business-warning").textContent).toBe(copy.permanent);
    expect(within(dialog).getByText("Studio", { selector: "code" })).toBeTruthy();

    const submit = within(dialog).getByRole("button", { name: copy.submit });
    expect(submit).toHaveProperty("disabled", true);
    await confirm(dialog, "studio", "correct horse");
    // The name must match as shown, capitals and all.
    expect(submit).toHaveProperty("disabled", true);
    await userEvent.clear(within(dialog).getByLabelText(copy.passwordLabel));
    await userEvent.clear(within(dialog).getByLabelText(/^Type .* to confirm$/));
    await confirm(dialog, "Studio", "");
    expect(submit).toHaveProperty("disabled", true);
    await confirm(dialog, "", "correct horse");
    expect(submit).toHaveProperty("disabled", false);
    expect(deletes()).toHaveLength(0);
  });

  it("deletes nothing when the owner cancels", async () => {
    const { deletes } = await setup();
    const dialog = await openDialog();
    await confirm(dialog, "Studio", "correct horse");
    await userEvent.click(within(dialog).getByRole("button", { name: copy.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes()).toHaveLength(0);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("deletes the business once confirmed, then starts again from the home page", async () => {
    const { client, deletes } = await setup();
    client.setQueryData(["team", "studio"], { members: [], invitations: [] });
    await confirm(await openDialog(), "Studio", "correct horse");
    await userEvent.click(screen.getByRole("button", { name: copy.submit }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(router.refresh).toHaveBeenCalled();
    expect(deletes()).toEqual([["/api/businesses?businessId=studio", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ confirmName: "Studio", password: "correct horse" }) })]]);
    expect(toast.success).toHaveBeenCalledWith("Studio was deleted.");
    // Nothing cached for the deleted business is left to show.
    expect(client.getQueryData(["team", "studio"])).toBeUndefined();
  });

  it.each([
    ["invalid_password", 400],
    ["root_business", 403],
    ["call_in_progress", 409],
    ["plan_ending", 409],
    ["rate_limited", 429],
  ] as const)("explains a %s refusal in the dialog, which stays open", async (code, status) => {
    await setup({ response: Response.json({ error: "Refused.", code }, { status }) });
    const dialog = await openDialog();
    await confirm(dialog, "Studio", "correct horse");
    await userEvent.click(within(dialog).getByRole("button", { name: copy.submit }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(copy.errors[code]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("clears a wrong password, so the owner types it again", async () => {
    await setup({ response: Response.json({ error: "That password isn't right.", code: "invalid_password" }, { status: 400 }) });
    const dialog = await openDialog();
    await confirm(dialog, "Studio", "wrong");
    await userEvent.click(within(dialog).getByRole("button", { name: copy.submit }));
    await within(dialog).findByRole("alert");
    expect(within(dialog).getByLabelText<HTMLInputElement>(copy.passwordLabel).value).toBe("");
    expect(within(dialog).getByLabelText<HTMLInputElement>(/^Type .* to confirm$/).value).toBe("Studio");
  });

  it("says it couldn't delete on any other failure", async () => {
    await setup({ response: Response.json({ error: "Request failed." }, { status: 500 }) });
    const dialog = await openDialog();
    await confirm(dialog, "Studio", "correct horse");
    await userEvent.click(within(dialog).getByRole("button", { name: copy.submit }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(copy.errors.failed);
  });
});

describe("a business that can't be deleted", () => {
  it("explains that the account's first business can't be deleted, with no button", async () => {
    await setup({ businesses: [{ ...main, active: true }, { ...studio, active: false }] });
    expect(screen.getByText(copy.blocked.accountRoot)).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.action })).toBeNull();
  });

  it("explains that another owner's first business can't be deleted", async () => {
    await setup({ businesses: [main, { ...studio, isRoot: true }] });
    expect(screen.getByText(copy.blocked.otherOwnerRoot)).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.action })).toBeNull();
  });

  it("explains that the only business the person owns can't be deleted", async () => {
    await setup({ businesses: [{ ...main, role: "business_admin", isAccountRoot: false }, studio] });
    expect(screen.getByText(copy.blocked.onlyBusiness)).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.action })).toBeNull();
  });

  it.each(["business_admin", "viewer"])("isn't offered to a %s, since only owners can delete", async (role) => {
    await setup({ businesses: [main, { ...studio, role }] });
    expect(screen.queryByText(copy.title)).toBeNull();
    expect(screen.queryByRole("button", { name: copy.action })).toBeNull();
  });
});

// The same owner once Main is the only business they own.
const onlyMain = [{ ...main, active: true }];

async function openCancelDialog() {
  await userEvent.click(screen.getByRole("button", { name: cancelCopy.action }));
  return await screen.findByRole("dialog");
}

describe("canceling the account from the Team page", () => {
  it("offers Cancel account instead of Delete on the account's first business once it's the only one the owner owns", async () => {
    await setup({ businesses: onlyMain });
    expect(screen.getByRole("button", { name: cancelCopy.action })).toBeTruthy();
    expect(screen.getByText(cancelCopy.description)).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.action })).toBeNull();
    expect(screen.queryByText(copy.blocked.accountRoot)).toBeNull();
  });

  it("counts only the businesses the person owns, not ones they help run", async () => {
    await setup({ businesses: [...onlyMain, { ...studio, role: "business_admin", active: false }] });
    expect(screen.getByRole("button", { name: cancelCopy.action })).toBeTruthy();
  });

  it("isn't offered while the owner owns another business, which they delete first", async () => {
    await setup({ businesses: [{ ...main, active: true }, { ...studio, active: false }] });
    expect(screen.queryByRole("button", { name: cancelCopy.action })).toBeNull();
    expect(screen.getByText(copy.blocked.accountRoot)).toBeTruthy();
  });

  it.each(["business_admin", "viewer"])("isn't offered to a %s, since only owners can cancel", async (role) => {
    await setup({ businesses: [{ ...main, role, active: true }] });
    expect(screen.queryByText(cancelCopy.title)).toBeNull();
    expect(screen.queryByRole("button", { name: cancelCopy.action })).toBeNull();
  });

  it("says nothing is deleted or changes yet, and asks for the business's name before sending a link", async () => {
    const { posts } = await setup({ businesses: onlyMain });
    const dialog = await openCancelDialog();
    expect(within(dialog).getByText("Cancel Main?")).toBeTruthy();
    expect(within(dialog).getByText(cancelCopy.dialogDescription)).toBeTruthy();
    expect(within(dialog).getByTestId("cancel-account-notice").textContent).toBe(cancelCopy.notice);
    expect(within(dialog).getByText("Main", { selector: "code" })).toBeTruthy();

    const submit = within(dialog).getByRole("button", { name: cancelCopy.submit });
    expect(submit).toHaveProperty("disabled", true);
    await userEvent.type(within(dialog).getByLabelText(/^Type .* to confirm$/), "main");
    expect(submit).toHaveProperty("disabled", true);
    await userEvent.clear(within(dialog).getByLabelText(/^Type .* to confirm$/));
    await userEvent.type(within(dialog).getByLabelText(/^Type .* to confirm$/), "Main");
    expect(submit).toHaveProperty("disabled", false);
    expect(posts()).toHaveLength(0);
  });

  it("keeps the account when the owner closes the dialog", async () => {
    const { posts } = await setup({ businesses: onlyMain });
    const dialog = await openCancelDialog();
    await userEvent.type(within(dialog).getByLabelText(/^Type .* to confirm$/), "Main");
    await userEvent.click(within(dialog).getByRole("button", { name: cancelCopy.keep }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts()).toHaveLength(0);
  });

  it("asks for the link, then says where it went, and leaves the owner where they are", async () => {
    const { posts } = await setup({ businesses: onlyMain });
    const dialog = await openCancelDialog();
    await userEvent.type(within(dialog).getByLabelText(/^Type .* to confirm$/), "Main");
    await userEvent.click(within(dialog).getByRole("button", { name: cancelCopy.submit }));

    expect(await within(dialog).findByText(cancelCopy.sentTitle)).toBeTruthy();
    expect(within(dialog).getByText(cancelCopy.sentDescription.replace("{{email}}", "owner@example.test"))).toBeTruthy();
    expect(posts()).toEqual([["/api/businesses/cancellation?businessId=main", expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmName: "Main" }) })]]);
    await userEvent.click(within(dialog).getByRole("button", { name: cancelCopy.done }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    // Opened again, it asks afresh.
    expect(within(await openCancelDialog()).getByRole("button", { name: cancelCopy.submit })).toHaveProperty("disabled", true);
  });

  it.each([
    ["confirmation_mismatch", 400],
    ["other_businesses", 403],
    ["forbidden", 403],
    ["rate_limited", 429],
  ] as const)("explains a %s refusal in the dialog, which stays open", async (code, status) => {
    await setup({ businesses: onlyMain, response: Response.json({ error: "Refused.", code }, { status }) });
    const dialog = await openCancelDialog();
    await userEvent.type(within(dialog).getByLabelText(/^Type .* to confirm$/), "Main");
    await userEvent.click(within(dialog).getByRole("button", { name: cancelCopy.submit }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(cancelCopy.errors[code]);
    expect(within(dialog).queryByText(cancelCopy.sentTitle)).toBeNull();
  });

  it("says it couldn't ask on any other failure", async () => {
    await setup({ businesses: onlyMain, response: Response.json({ error: "Request failed." }, { status: 500 }) });
    const dialog = await openCancelDialog();
    await userEvent.type(within(dialog).getByLabelText(/^Type .* to confirm$/), "Main");
    await userEvent.click(within(dialog).getByRole("button", { name: cancelCopy.submit }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(cancelCopy.errors.failed);
  });
});
