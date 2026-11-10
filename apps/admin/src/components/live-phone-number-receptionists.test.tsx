// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { builtInBillingPlanLimits } from "@lobbystack/shared";

import receptionistsEn from "../../public/locales/en/receptionists.json";
import settingsEn from "../../public/locales/en/settings.json";
import { LivePhoneNumberSettingsSurface } from "./live-phone-number-settings-surface";
import { receptionistChoicesQueryKey, type ReceptionistOption } from "./receptionists/receptionist-choices";

// Who answers each of the business's numbers: "Answered by" under the
// current number, and under each other number the plan includes, shown only
// while the business has several receptionists. It saves as soon as it
// changes.

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("./upgrade-plan-dialog-context", () => ({ useOpenUpgradePlanDialog: () => vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "settings", interpolation: { escapeValue: false }, resources: { en: { settings: settingsEn, receptionists: receptionistsEn } } });
});

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all" });
const KITSILANO = receptionist("00000000-0000-4000-8000-0000000000a2", "Kitsilano clinic", { sortOrder: 1 });
const BILLING = receptionist("00000000-0000-4000-8000-0000000000a3", "Billing", { status: "paused", sortOrder: 2 });
const CLINIC = [FRONT_DESK, KITSILANO, BILLING];

type PhoneNumber = { id: string; e164: string; status: string; reclaimScheduledAt: string | null; receptionistId: string | null };
function phoneNumber(id: string, e164: string, values: Partial<PhoneNumber> = {}): PhoneNumber {
  return { id, e164, status: "active", reclaimScheduledAt: null, receptionistId: null, ...values };
}

const MAIN = phoneNumber("phone-main", "+14165550100");
const SECOND = phoneNumber("phone-second", "+16045550123", { receptionistId: KITSILANO.id });

type Refusal = { status: number; body: Record<string, unknown> };
const clients: QueryClient[] = [];

beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() }); });
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup({ receptionists = CLINIC, numbers = [MAIN], role = "business_owner", refuse }: { receptionists?: ReceptionistOption[]; numbers?: PhoneNumber[]; role?: string; refuse?: Refusal } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  // The server's numbers, which a saved change updates.
  let saved = numbers.map((number) => ({ ...number }));
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", active: true, role }] });
  client.setQueryData(["phone-numbers", "business"], { phoneNumbers: saved, replacement: { usedAt: null, activeClaim: null } });
  client.setQueryData(["billing", "business"], { effectivePlan: "pro", account: { plan: "pro" }, limits: builtInBillingPlanLimits.pro });
  client.setQueryData(receptionistChoicesQueryKey("business"), { receptionists });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const patch = /\/api\/phone-numbers\/([^?]+)\?businessId=business$/.exec(url);
    if (patch && init?.method === "PATCH") {
      if (refuse) return Response.json(refuse.body, { status: refuse.status });
      const { receptionistId } = JSON.parse(String(init.body)) as { receptionistId: string };
      saved = saved.map((number) => number.id === decodeURIComponent(patch[1]!) ? { ...number, receptionistId } : number);
      const number = saved.find((entry) => entry.id === decodeURIComponent(patch[1]!))!;
      return Response.json({ phoneNumber: { id: number.id, e164: number.e164, receptionistId } });
    }
    if (url.startsWith("/api/phone-numbers?")) return Response.json({ phoneNumbers: saved, replacement: { usedAt: null, activeClaim: null } });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><LivePhoneNumberSettingsSurface /></QueryClientProvider></I18nextProvider>);
  const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> }));
  return { client, fetchMock, patches };
}

const answeredBy = (scope: HTMLElement | Document = document) => within(scope as HTMLElement).getAllByRole("combobox", { name: /^Answered by/ });
const otherNumbers = () => screen.getByText("Other numbers").closest("[data-slot='item']") as HTMLElement;

async function pick(control: HTMLElement, name: string) {
  await userEvent.click(control);
  await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(`^${name}`) }));
}

describe("who answers each phone number", () => {
  it("asks nothing while the business has one receptionist", () => {
    setup({ receptionists: [FRONT_DESK], numbers: [MAIN, SECOND] });
    expect(screen.getByText("(416) 555-0100")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /^Answered by/ })).toBeNull();
    expect(screen.queryByText("Other numbers")).toBeNull();
  });

  it("shows the default receptionist under a number that names nobody, with what the choice does", () => {
    setup();
    expect(screen.getByRole("combobox", { name: "Answered by Front desk" })).toBeTruthy();
    expect(screen.getByText("Calls and texts to this number go to the receptionist you pick. While it's paused, Front desk answers them.")).toBeTruthy();
  });

  it("saves the receptionist picked straight away and says so", async () => {
    const { patches } = setup();
    await pick(screen.getByRole("combobox", { name: "Answered by Front desk" }), "Kitsilano clinic");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Calls and texts to (416) 555-0100 go to Kitsilano clinic now."));
    expect(patches()).toEqual([{ url: "/api/phone-numbers/phone-main?businessId=business", body: { receptionistId: KITSILANO.id } }]);
    expect(screen.getByRole("combobox", { name: "Answered by Kitsilano clinic" })).toBeTruthy();
  });

  it("saves nothing when the receptionist answering now is picked again", async () => {
    const { patches } = setup();
    await pick(screen.getByRole("combobox", { name: "Answered by Front desk" }), "Front desk");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(patches()).toEqual([]);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("says the default answers while the receptionist chosen is paused", () => {
    setup({ numbers: [{ ...MAIN, receptionistId: BILLING.id }] });
    expect(screen.getByRole("combobox", { name: /^Answered by Billing/ }).textContent).toContain("(Paused)");
    expect(screen.getByRole("status").textContent).toBe("Billing is paused, so Front desk answers for now.");
  });

  it("shows schedulers and viewers who answers, without a dropdown", () => {
    setup({ role: "viewer", numbers: [{ ...MAIN, receptionistId: KITSILANO.id }] });
    expect(screen.queryByRole("combobox", { name: /^Answered by/ })).toBeNull();
    expect(screen.getByText("Kitsilano clinic").parentElement?.textContent).toBe("Answered by: Kitsilano clinic");
  });

  it("lists the plan's other numbers, each with who answers it", async () => {
    const { patches } = setup({ numbers: [MAIN, SECOND] });
    const list = otherNumbers();
    expect(within(list).getByText("Each number's calls and texts go to the receptionist you pick.")).toBeTruthy();
    expect(within(list).getByText("(604) 555-0123")).toBeTruthy();
    expect(within(list).queryByText("(416) 555-0100")).toBeNull();
    const [control] = answeredBy(list);
    expect(control!.textContent).toContain("Kitsilano clinic");
    await pick(control!, "Front desk");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Calls and texts to (604) 555-0123 go to Front desk now."));
    expect(patches()).toEqual([{ url: "/api/phone-numbers/phone-second?businessId=business", body: { receptionistId: FRONT_DESK.id } }]);
  });

  it("leaves numbers that aren't active off the list", () => {
    setup({ numbers: [MAIN, { ...SECOND, status: "provisioning" }] });
    expect(screen.queryByText("Other numbers")).toBeNull();
    expect(answeredBy()).toHaveLength(1);
  });

  it("explains a refused change in the dashboard's language and keeps who answered", async () => {
    setup({ refuse: { status: 409, body: { error: "An archived receptionist can't answer. Restore it first.", code: "receptionist_archived" } } });
    await pick(screen.getByRole("combobox", { name: "Answered by Front desk" }), "Kitsilano clinic");
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("That receptionist was archived. Refresh the page and pick another one."));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Answered by Front desk" })).toBeTruthy();
  });

  it("says a number that's gone needs a refresh", async () => {
    setup({ refuse: { status: 404, body: { error: "Phone number not found.", code: "phone_number_not_found" } } });
    await pick(screen.getByRole("combobox", { name: "Answered by Front desk" }), "Kitsilano clinic");
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("That isn't there any more. Refresh the page."));
  });
});
