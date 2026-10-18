// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AcceptInviteSurface } from "./accept-invite-surface";

const spies = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("sonner", () => ({ toast: spies }));
vi.mock("next/navigation", () => ({ useRouter: () => spies }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en", resolvedLanguage: "en" }, t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); window.history.replaceState({}, "", "/"); });

it("preserves main's success toast and navigates to team settings after accepting", async () => {
  window.history.replaceState({}, "", "/accept-invite?token=fixture-token");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("get-session")) return Response.json({ user: { id: "fixture" } });
    if (init?.method === "POST") return Response.json({ businessId: "business", alreadyMember: false });
    return Response.json({ invitation: { businessName: "Clinic", email: "invitee@example.invalid", expired: false, status: "pending" } });
  }));
  render(<AcceptInviteSurface />);
  const submit = await screen.findByRole("button", { name: "acceptInvite.submit" });
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  await userEvent.click(submit);
  await waitFor(() => expect(spies.success).toHaveBeenCalledWith("acceptInvite.success"));
  expect(spies.replace).toHaveBeenCalledWith("/settings/team");
  expect(screen.queryByText("acceptInvite.success")).toBeNull();
  expect(spies.info).not.toHaveBeenCalled();
});

it("tells a new owner which of the previous manager's connections the handover turned off", async () => {
  window.history.replaceState({}, "", "/accept-invite?token=fixture-token");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("get-session")) return Response.json({ user: { id: "fixture" } });
    if (init?.method === "POST") return Response.json({ businessId: "business", role: "business_owner", turnedOff: { webhookEndpoints: 2, calendarConnections: 0 } });
    return Response.json({ invitation: { businessName: "Clinic", email: "invitee@example.invalid", expired: false, status: "pending" } });
  }));
  render(<AcceptInviteSurface />);
  const submit = await screen.findByRole("button", { name: "acceptInvite.submit" });
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  await userEvent.click(submit);
  await waitFor(() => expect(spies.info).toHaveBeenCalledWith("acceptInvite.handover.title", expect.objectContaining({ action: expect.objectContaining({ label: "acceptInvite.handover.review" }) })));
  const [, options] = spies.info.mock.calls[0] as [string, { description: ReactNode; action: { onClick: () => void } }];
  render(<>{options.description}</>);
  expect(screen.getByText("acceptInvite.handover.webhooksOff")).toBeTruthy();
  expect(screen.queryByText("acceptInvite.handover.calendarsOff")).toBeNull();
  options.action.onClick();
  expect(spies.push).toHaveBeenCalledWith("/integrations");
});

it("settles a failed preview into the original invalid-link state", async () => {
  window.history.replaceState({}, "", "/accept-invite?token=fixture-token");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("get-session")) return Response.json({ user: { id: "fixture" } });
    throw new Error("Offline");
  }));
  render(<AcceptInviteSurface />);
  await screen.findByText("acceptInvite.invalidLink");
  expect((await screen.findByRole("button", { name: "acceptInvite.submit" })).hasAttribute("disabled")).toBe(true);
});

it("explains a 403 and lets the user sign in with the invited account", async () => {
  window.history.replaceState({}, "", "/accept-invite?token=fixture-token");
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("get-session")) return Response.json({ user: { id: "fixture" } });
    if (url.includes("sign-out")) return Response.json({ success: true });
    if (init?.method === "POST") return Response.json({ error: "Sign in with the verified email address this invitation was sent to." }, { status: 403 });
    return Response.json({ invitation: { businessName: "Clinic", email: "invitee@example.invalid", expired: false, status: "pending" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<AcceptInviteSurface />);
  const submit = await screen.findByRole("button", { name: "acceptInvite.submit" });
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  await userEvent.click(submit);
  await screen.findByText("acceptInvite.wrongAccount");
  await userEvent.click(screen.getByRole("button", { name: "acceptInvite.switchAccount" }));
  await waitFor(() => expect(spies.replace).toHaveBeenCalledWith(expect.stringContaining("/login?returnTo=")));
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-out", expect.objectContaining({ method: "POST" }));
});
