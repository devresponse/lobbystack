// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentBasicSettingsPage,
  buildAppointmentChangePolicyForSave,
  resolveTransferNumberForSave,
} from "./live-agent-basic-settings-surface";

vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => ({ track: vi.fn() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/business-hours-section", () => ({
  BusinessHoursSection: () => null,
  BookingWithoutHoursAlert: () => null,
  needsHoursForBooking: () => false,
  useBusinessHours: () => ({ data: undefined }),
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
