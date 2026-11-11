// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentBasicSettingsPage, agentSettingsQueryKey } from "./live-agent-basic-settings-surface";
import { buildAppointmentChangePolicyForSave } from "./agent-settings/business-settings";
import { resolveTransferNumberForSave } from "./agent-settings/receptionist-settings";
import { testNavigation } from "@/lib/navigation-testing";

vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => ({ track: vi.fn() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: (key: string, options?: Record<string, unknown>) => options?.language ? `${key} (${String(options.language)})` : key }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/business-hours-section", () => ({
  BusinessHoursSection: () => <section aria-label="hours" />,
  BookingWithoutHoursAlert: () => null,
  needsHoursForBooking: () => false,
  useBusinessHours: () => ({ data: undefined }),
}));
vi.mock("next/navigation", async () => (await import("@/lib/navigation-testing")).nextNavigationMock);

beforeEach(() => { testNavigation.reset("/agent"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("resolveTransferNumberForSave", () => {
  it("rejects partial visible input instead of silently keeping the old value", () => {
    expect(
      resolveTransferNumberForSave({
        rawInputValue: "(855) 747-77",
        validTransferNumber: "",
      }),
    ).toEqual({
      ok: false,
      errorKey: "agent:fields.transferNumber.errors.invalid",
    });
  });

  it("clears the transfer number when the visible input is empty", () => {
    expect(
      resolveTransferNumberForSave({
        rawInputValue: "",
        validTransferNumber: "",
      }),
    ).toEqual({
      ok: true,
      value: null,
    });
  });

  it("saves the normalized transfer number when the current input is valid", () => {
    expect(
      resolveTransferNumberForSave({
        rawInputValue: "(514) 555-0123",
        validTransferNumber: "+15145550123",
      }),
    ).toEqual({
      ok: true,
      value: "+15145550123",
    });
  });
});

describe("buildAppointmentChangePolicyForSave", () => {
  it("enables appointment changes when at least one change type is allowed", () => {
    expect(
      buildAppointmentChangePolicyForSave({
        allowCancel: true,
        allowReschedule: false,
        verificationMode: "phone_match_and_facts",
      }),
    ).toEqual({
      enabled: true,
      allowCancel: true,
      allowReschedule: false,
      verificationMode: "phone_match_and_facts",
    });
  });

  it("stores the verification mode the operator picked", () => {
    expect(
      buildAppointmentChangePolicyForSave({
        allowCancel: true,
        allowReschedule: true,
        verificationMode: "otp_required",
      }),
    ).toEqual({
      enabled: true,
      allowCancel: true,
      allowReschedule: true,
      verificationMode: "otp_required",
    });
  });

  it("disables the policy when both change toggles are off", () => {
    expect(
      buildAppointmentChangePolicyForSave({
        allowCancel: false,
        allowReschedule: false,
        verificationMode: "otp_required",
      }),
    ).toEqual({
      enabled: false,
      allowCancel: false,
      allowReschedule: false,
      verificationMode: "otp_required",
    });
  });

  it("stores the keypad PIN mode", () => {
    expect(
      buildAppointmentChangePolicyForSave({
        allowCancel: true,
        allowReschedule: false,
        verificationMode: "passcode_required",
      }),
    ).toEqual({
      enabled: true,
      allowCancel: true,
      allowReschedule: false,
      verificationMode: "passcode_required",
    });
  });
});

describe("AgentBasicSettingsPage saves", () => {
  it("sends only the changed setting, not a cancelled greeting draft", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return Response.json({ profile: {} });
      }
      return Response.json({
        business: { defaultLocale: "en" },
        profile: { greeting: "Thanks for calling.", summary: "Clinic", summarySource: "operator", transferNumber: "+15145550123", transferMode: "on_request", appointmentChangePolicy: null, bookingMode: "instant" },
      });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AgentBasicSettingsPage businessId="business" canManageTenant /></QueryClientProvider>);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "agent:actions.editField" })[0]?.hasAttribute("disabled")).toBe(false));
    await user.click(screen.getAllByRole("button", { name: "agent:actions.editField" })[0]!);
    await user.type(await screen.findByPlaceholderText("agent:fields.greeting.placeholder"), " Discarded.");
    await user.click(screen.getByRole("button", { name: "agent:actions.cancel" }));

    await user.click(screen.getByRole("switch", { name: "agent:appointmentChanges.allowCancel.label" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    await user.selectOptions(screen.getByRole("combobox", { name: "agent:fields.defaultLocale.label" }), "fr");
    await waitFor(() => expect(patches).toHaveLength(2));

    expect(patches).toEqual([
      { businessId: "business", appointmentChangePolicy: { enabled: true, allowCancel: false, allowReschedule: true, verificationMode: "phone_match_and_facts" } },
      { businessId: "business", locale: "fr" },
    ]);
    client.clear();
  });

  it("offers each language calls can open in, by its own name, and saves the one picked", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return Response.json({ profile: {} });
      }
      // A language calls can't open in, saved before the list was checked, shows as English.
      return Response.json({
        business: { defaultLocale: "sr" },
        profile: { greeting: "Thanks for calling.", summary: "Clinic", summarySource: "operator", transferNumber: "+15145550123", transferMode: "on_request", appointmentChangePolicy: null, bookingMode: "instant" },
      });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AgentBasicSettingsPage businessId="business" canManageTenant /></QueryClientProvider>);

    const user = userEvent.setup();
    const language = await screen.findByRole("combobox", { name: "agent:fields.defaultLocale.label" });
    await waitFor(() => expect((language as HTMLSelectElement).value).toBe("en"));
    const options = within(language).getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((option) => option.value)).toEqual(["en", "es", "fr", "de", "hi", "ja", "ko", "pt", "zh", "it", "uk", "ru", "ar"]);
    expect(options.map((option) => option.textContent)).toEqual(expect.arrayContaining(["English", "Español", "Deutsch", "日本語", "العربية"]));
    expect(options.find((option) => option.value === "ar")?.lang).toBe("ar");

    await user.selectOptions(language, "ja");
    await waitFor(() => expect(patches).toEqual([{ businessId: "business", locale: "ja" }]));
    client.clear();
  });

  it("saves the keypad PIN check picked for appointment changes", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return Response.json({ profile: {} });
      }
      return Response.json({
        business: { defaultLocale: "en" },
        profile: { greeting: "Thanks for calling.", summary: "Clinic", summarySource: "operator", transferNumber: null, transferMode: "on_request", appointmentChangePolicy: { enabled: true, allowCancel: true, allowReschedule: false, verificationMode: "otp_required" }, bookingMode: "instant" },
      });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AgentBasicSettingsPage businessId="business" canManageTenant /></QueryClientProvider>);

    const user = userEvent.setup();
    const select = await screen.findByRole("combobox", { name: "agent:appointmentChanges.verification.label" });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("otp_required"));
    expect(screen.queryByRole("option", { name: "agent:appointmentChanges.verification.options.operator_only" })).toBeNull();
    await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
    await user.selectOptions(select, "passcode_required");
    await waitFor(() => expect(patches).toHaveLength(1));

    expect(patches).toEqual([
      { businessId: "business", appointmentChangePolicy: { enabled: true, allowCancel: true, allowReschedule: false, verificationMode: "passcode_required" } },
    ]);
    expect(screen.getByText("agent:appointmentChanges.verification.descriptions.passcode_required")).toBeTruthy();
    client.clear();
  });

  // A profile saved before the switch existed has no value, and calls say the notice.
  it("shows the switch for what calls say about AI and recording on, saves it off, and turns it back when the save fails", async () => {
    const patches: Array<{ recordingNotice?: boolean }> = [];
    let saved: boolean | undefined;
    let failSave = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as { recordingNotice?: boolean };
        patches.push(patch);
        if (failSave) return Response.json({ error: "Receptionist profile could not be saved." }, { status: 500 });
        saved = patch.recordingNotice;
        return Response.json({ profile: {} });
      }
      return Response.json({
        business: { defaultLocale: "en" },
        profile: { greeting: "Thanks for calling.", summary: "Clinic", summarySource: "operator", transferNumber: null, transferMode: "on_request", appointmentChangePolicy: null, bookingMode: "instant", ...(saved === undefined ? {} : { recordingNotice: saved }) },
      });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AgentBasicSettingsPage businessId="business" canManageTenant /></QueryClientProvider>);

    const user = userEvent.setup();
    const notice = await screen.findByRole("switch", { name: "agent:fields.recordingNotice.label" });
    await waitFor(() => expect(notice.hasAttribute("disabled")).toBe(false));
    expect(notice.getAttribute("aria-checked")).toBe("true");
    await user.click(notice);
    await waitFor(() => expect(patches).toEqual([{ businessId: "business", recordingNotice: false }]));
    await waitFor(() => expect(screen.getByRole("switch", { name: "agent:fields.recordingNotice.label" }).getAttribute("aria-checked")).toBe("false"));

    failSave = true;
    await waitFor(() => expect(screen.getByRole("switch", { name: "agent:fields.recordingNotice.label" }).hasAttribute("disabled")).toBe(false));
    await user.click(screen.getByRole("switch", { name: "agent:fields.recordingNotice.label" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ businessId: "business", recordingNotice: true });
    await waitFor(() => expect(screen.getByRole("switch", { name: "agent:fields.recordingNotice.label" }).getAttribute("aria-checked")).toBe("false"));
    client.clear();
  });

  it("keeps showing operator-only checks set through the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      business: { defaultLocale: "en" },
      profile: { greeting: "Thanks for calling.", summary: "Clinic", summarySource: "operator", transferNumber: null, transferMode: "on_request", appointmentChangePolicy: { enabled: true, allowCancel: true, allowReschedule: true, verificationMode: "operator_only" }, bookingMode: "instant" },
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AgentBasicSettingsPage businessId="business" canManageTenant /></QueryClientProvider>);

    const select = await screen.findByRole("combobox", { name: "agent:appointmentChanges.verification.label" });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("operator_only"));
    expect(screen.getByRole("option", { name: "agent:appointmentChanges.verification.options.operator_only" })).toBeTruthy();
    client.clear();
  });
});

describe("AgentBasicSettingsPage refetches", () => {
  const settings = (overrides: { greeting?: string; transferNumber?: string | null } = {}) => ({
    business: { defaultLocale: "en" },
    profile: { greeting: "Thanks for calling.", summary: "Clinic", summarySource: "operator", transferNumber: "+15145550123", transferMode: "on_request", appointmentChangePolicy: null, bookingMode: "instant", ...overrides },
  });
  function renderPage(saved: () => ReturnType<typeof settings> = () => settings()) {
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      return Response.json(saved());
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AgentBasicSettingsPage businessId="business" canManageTenant /></QueryClientProvider>);
    return { client, patches };
  }
  const transferInput = () => document.getElementById("agent-transfer-number") as HTMLInputElement | null;

  it("keeps a number being typed when a refetch of the saved settings lands", async () => {
    const { client, patches } = renderPage();
    const user = userEvent.setup();
    await waitFor(() => expect(transferInput()?.value.replace(/\D/g, "")).toBe("5145550123"));
    await user.clear(transferInput()!);
    await user.type(transferInput()!, "+15145550199");
    // The refetch an earlier save started arrives late, with the number that save stored.
    act(() => client.setQueryData(["agent-settings", "business"], settings({ transferNumber: "+15145550177" })));
    await user.click(screen.getByRole("button", { name: "agent:actions.save" }));

    await waitFor(() => expect(patches).toEqual([{ businessId: "business", transferNumber: "+15145550199" }]));
    client.clear();
  });

  it("keeps a cleared number empty when a refetch lands, even if none was saved before", async () => {
    const { client, patches } = renderPage(() => settings({ transferNumber: null }));
    const user = userEvent.setup();
    await waitFor(() => expect(transferInput()).toBeTruthy());
    await user.type(transferInput()!, "+15145550100");
    await user.clear(transferInput()!);
    // The field is empty again, as it was when the page loaded, when a late refetch brings a saved number.
    act(() => client.setQueryData(["agent-settings", "business"], settings({ transferNumber: "+15145550177" })));
    expect(transferInput()!.value).toBe("");
    await user.type(transferInput()!, "+15145550199");
    await user.click(screen.getByRole("button", { name: "agent:actions.save" }));

    await waitFor(() => expect(patches).toEqual([{ businessId: "business", transferNumber: "+15145550199" }]));
    client.clear();
  });

  it("keeps a greeting being edited when a refetch lands, and takes a saved one while the field is untouched", async () => {
    const { client, patches } = renderPage();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "agent:actions.editField" })[0]?.hasAttribute("disabled")).toBe(false));
    await user.click(screen.getAllByRole("button", { name: "agent:actions.editField" })[0]!);
    const field = await screen.findByPlaceholderText("agent:fields.greeting.placeholder");
    await user.type(field, " Ask away.");
    // Coming back to the tab refetches the settings; another change saved meanwhile comes with them.
    act(() => client.setQueryData(["agent-settings", "business"], settings({ transferNumber: "+15145550177" })));
    expect((field as HTMLTextAreaElement).value).toBe("Thanks for calling. Ask away.");
    await waitFor(() => expect(transferInput()?.value.replace(/\D/g, "")).toBe("5145550177"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "agent:actions.save" }));

    await waitFor(() => expect(patches).toEqual([{ businessId: "business", greeting: "Thanks for calling. Ask away." }]));
    client.clear();
  });

  it("shows the next business's number, not one typed for the last, after switching business", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(settings({ transferNumber: url.includes("business-b") ? "+15145550222" : "+15145550111" }))));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (businessId: string) => <QueryClientProvider client={client}><AgentBasicSettingsPage businessId={businessId} canManageTenant /></QueryClientProvider>;
    const { rerender } = render(page("business-a"));

    const user = userEvent.setup();
    await waitFor(() => expect(transferInput()?.value.replace(/\D/g, "")).toBe("5145550111"));
    await user.clear(transferInput()!);
    await user.type(transferInput()!, "+15145550199");
    // The workspace switcher keeps the page mounted and only changes the business.
    rerender(page("business-b"));

    await waitFor(() => expect(transferInput()?.value.replace(/\D/g, "")).toBe("5145550222"));
    client.clear();
  });
});

describe("AgentBasicSettingsPage with several receptionists", () => {
  const FRONT_DESK_ID = "00000000-0000-4000-8000-0000000000a1";
  const KITSILANO_ID = "00000000-0000-4000-8000-0000000000a2";
  const BILLING_ID = "00000000-0000-4000-8000-0000000000a3";
  const choice = (id: string, name: string, values: Record<string, unknown> = {}) => ({ id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values });
  const RECEPTIONISTS = [
    choice(FRONT_DESK_ID, "Front desk", { isDefault: true, knowledgeScope: "all" }),
    choice(KITSILANO_ID, "Kitsilano clinic", { locale: "fr", sortOrder: 1 }),
    choice(BILLING_ID, "Billing", { status: "paused", sortOrder: 2 }),
  ];
  const shared = { summary: "Clinic", summarySource: "operator", recordingNotice: true, appointmentChangePolicy: null };
  const PROFILES: Record<string, Record<string, unknown>> = {
    [FRONT_DESK_ID]: { id: FRONT_DESK_ID, isDefault: true, name: "Front desk", locale: null, greeting: "Thanks for calling.", transferNumber: "+15145550123", transferMode: "on_request", bookingMode: "instant", ...shared },
    [KITSILANO_ID]: { id: KITSILANO_ID, isDefault: false, name: "Kitsilano clinic", locale: "fr", greeting: "Bonjour, Kitsilano.", transferNumber: "+16045550100", transferMode: "on_request", bookingMode: "request", ...shared },
    [BILLING_ID]: { id: BILLING_ID, isDefault: false, name: "Billing", locale: null, greeting: "Billing, hello.", transferNumber: null, transferMode: "on_request", bookingMode: "off", ...shared },
  };
  type Request = { url: string; body?: unknown };

  function renderPage({ receptionists = RECEPTIONISTS, address = "", canManageTenant = true }: { receptionists?: unknown[]; address?: string; canManageTenant?: boolean } = {}) {
    testNavigation.search = address;
    const reads: Request[] = [];
    const patches: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost:3000");
      const path = `${url.pathname}${url.search}`;
      if (init?.method === "PATCH") {
        patches.push({ url: path, body: JSON.parse(String(init.body)) });
        return Response.json({ profile: {} });
      }
      reads.push({ url: path });
      if (url.pathname === "/api/receptionists/choices") return Response.json({ receptionists });
      const profile = PROFILES[url.searchParams.get("receptionist") ?? FRONT_DESK_ID];
      if (!profile) return Response.json({ error: "Receptionist not found." }, { status: 404 });
      return Response.json({ business: { defaultLocale: "en", timezone: "America/Vancouver" }, profile });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AgentBasicSettingsPage businessId="business" canManageTenant={canManageTenant} /></QueryClientProvider>);
    return { client, reads, patches };
  }
  const picker = () => screen.getByRole("combobox", { name: /^agent:receptionists\.picker/ });
  const section = (title: string) => screen.getByRole("heading", { name: title }).closest("section")!;
  const select = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;
  const transferInput = () => document.getElementById("agent-transfer-number") as HTMLInputElement | null;
  async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(picker());
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(name) }));
  }

  it("keeps the page as it was while the business has one receptionist", async () => {
    renderPage({ receptionists: [RECEPTIONISTS[0]] });
    await waitFor(() => expect((select("agent:fields.defaultLocale.label")).value).toBe("en"));
    expect(screen.getByRole("heading", { name: "agent:fields.defaults.title" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "agent:booking.title" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "agent:receptionists.shared.title" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /^agent:receptionists\.picker/ })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "agent:receptionists.language.label" })).toBeNull();
  });

  it("puts the shared settings first, then the dropdown and the default receptionist's own", async () => {
    const { reads } = renderPage();
    await waitFor(() => expect(picker().textContent).toContain("Front desk"));
    expect(screen.queryByRole("heading", { name: "agent:fields.defaults.title" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "agent:booking.title" })).toBeNull();

    const sharedSection = section("agent:receptionists.shared.title");
    const ownSection = section("agent:receptionists.own.title");
    expect(within(sharedSection).getByText("agent:receptionists.shared.description")).toBeTruthy();
    for (const label of ["agent:fields.summary.label", "agent:fields.recordingNotice.label", "agent:receptionists.businessLanguage.label", "agent:fields.timezone.label"]) {
      expect(within(sharedSection).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(within(sharedSection).queryByText("agent:fields.greeting.label")).toBeNull();
    for (const label of ["agent:fields.greeting.label", "agent:receptionists.language.label", "agent:fields.transferNumber.label", "agent:booking.mode.label"]) {
      expect(within(ownSection).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(within(ownSection).getByRole("combobox", { name: /^agent:receptionists\.picker/ })).toBeTruthy();
    // Opening hours and appointment changes are shared too, and come before the dropdown.
    const order = [sharedSection, screen.getByRole("region", { name: "hours" }), section("agent:appointmentChanges.title"), ownSection];
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    // The default receptionist speaks the business's language.
    await waitFor(() => expect(select("agent:receptionists.language.label").disabled).toBe(true));
    expect(select("agent:receptionists.language.label").value).toBe("");
    expect(screen.getByRole("option", { name: "agent:receptionists.language.business (English)" })).toBeTruthy();
    expect(screen.getByText("agent:receptionists.language.defaultHint")).toBeTruthy();
    expect(reads.filter((read) => read.url.startsWith("/api/agent")).map((read) => read.url)).toEqual(["/api/agent?businessId=business"]);
  });

  it("shows the receptionist picked in the dropdown, and saves its own settings as its own", async () => {
    const { patches } = renderPage();
    const user = userEvent.setup();
    await waitFor(() => expect(transferInput()?.value.replace(/\D/g, "")).toBe("5145550123"));
    await choose(user, "Kitsilano clinic");
    expect(testNavigation.router.replace).toHaveBeenLastCalledWith(`/agent?receptionist=${KITSILANO_ID}`, { scroll: false });

    await waitFor(() => expect(transferInput()?.value.replace(/\D/g, "")).toBe("6045550100"));
    expect(picker().textContent).toContain("Kitsilano clinic");
    expect(select("agent:receptionists.language.label").value).toBe("fr");
    expect(select("agent:receptionists.language.label").disabled).toBe(false);
    expect(select("agent:booking.mode.label").value).toBe("request");
    await user.click(within(section("agent:receptionists.own.title")).getByRole("button", { name: "agent:actions.editField" }));
    expect(((await screen.findByPlaceholderText("agent:fields.greeting.placeholder")) as HTMLTextAreaElement).value).toBe("Bonjour, Kitsilano.");
    await user.click(screen.getByRole("button", { name: "agent:actions.cancel" }));

    await user.selectOptions(select("agent:booking.mode.label"), "off");
    await waitFor(() => expect(patches).toHaveLength(1));
    // Back to the business's language.
    await waitFor(() => expect(select("agent:receptionists.language.label").disabled).toBe(false));
    await user.selectOptions(select("agent:receptionists.language.label"), "");
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches).toEqual([
      { url: `/api/agent?businessId=business&receptionist=${KITSILANO_ID}`, body: { businessId: "business", bookingMode: "off" } },
      { url: `/api/agent?businessId=business&receptionist=${KITSILANO_ID}`, body: { businessId: "business", locale: null } },
    ]);
  });

  it("saves the shared settings for the business, whichever receptionist is open", async () => {
    const { patches } = renderPage({ address: `receptionist=${KITSILANO_ID}` });
    const user = userEvent.setup();
    await waitFor(() => expect(select("agent:receptionists.language.label").value).toBe("fr"));
    const notice = screen.getByRole("switch", { name: "agent:fields.recordingNotice.label" });
    await waitFor(() => expect(notice.hasAttribute("disabled")).toBe(false));
    await user.click(notice);
    await waitFor(() => expect(patches).toHaveLength(1));
    await user.selectOptions(select("agent:receptionists.businessLanguage.label"), "es");
    await waitFor(() => expect(patches).toHaveLength(2));
    await user.click(screen.getByRole("switch", { name: "agent:appointmentChanges.allowCancel.label" }));
    await waitFor(() => expect(patches).toHaveLength(3));
    expect(patches).toEqual([
      { url: "/api/agent?businessId=business", body: { businessId: "business", recordingNotice: false } },
      { url: "/api/agent?businessId=business", body: { businessId: "business", locale: "es" } },
      { url: "/api/agent?businessId=business", body: { businessId: "business", appointmentChangePolicy: { enabled: true, allowCancel: false, allowReschedule: true, verificationMode: "phone_match_and_facts" } } },
    ]);
  });

  it("starts the next receptionist's number afresh, not with one typed for the last", async () => {
    renderPage();
    const user = userEvent.setup();
    await waitFor(() => expect(transferInput()?.value.replace(/\D/g, "")).toBe("5145550123"));
    await user.clear(transferInput()!);
    await user.type(transferInput()!, "+15145550199");
    await choose(user, "Billing");
    await waitFor(() => expect(select("agent:booking.mode.label").value).toBe("off"));
    // Billing has no transfer number.
    expect(transferInput()!.value).toBe("");
    await choose(user, "Front desk");
    expect(testNavigation.router.replace).toHaveBeenLastCalledWith("/agent", { scroll: false });
    await waitFor(() => expect(transferInput()?.value.replace(/\D/g, "")).toBe("5145550123"));
  });

  it.each([
    ["the default receptionist", FRONT_DESK_ID],
    ["a receptionist the business doesn't list", "00000000-0000-4000-8000-0000000000ff"],
  ])("drops %s from the address and shows the default receptionist", async (_, receptionistId) => {
    const { reads } = renderPage({ address: `receptionist=${receptionistId}` });
    await waitFor(() => expect(testNavigation.router.replace).toHaveBeenCalledWith("/agent", { scroll: false }));
    await waitFor(() => expect(transferInput()?.value.replace(/\D/g, "")).toBe("5145550123"));
    expect(picker().textContent).toContain("Front desk");
    expect(reads.at(-1)).toEqual({ url: "/api/agent?businessId=business" });
  });

  it("lets the team look at each receptionist, without the links to manage them", async () => {
    renderPage({ canManageTenant: false });
    const user = userEvent.setup();
    await waitFor(() => expect(picker().textContent).toContain("Front desk"));
    await user.click(picker());
    const listed = within(screen.getByRole("listbox")).getAllByRole("option").map((option) => option.textContent);
    expect(listed).toEqual([expect.stringContaining("Front desk"), expect.stringContaining("Kitsilano clinic"), expect.stringContaining("Billing")]);
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: /Kitsilano clinic/ }));
    await waitFor(() => expect(select("agent:receptionists.language.label").value).toBe("fr"));
    expect(select("agent:receptionists.language.label").disabled).toBe(true);
    expect(select("agent:booking.mode.label").disabled).toBe(true);
  });

  it("keeps the default receptionist's settings where they always were", () => {
    expect(agentSettingsQueryKey("business", null)).toEqual(["agent-settings", "business"]);
    expect(agentSettingsQueryKey("business", KITSILANO_ID)).toEqual(["agent-settings", "business", KITSILANO_ID]);
  });
});
