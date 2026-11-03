// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardTestCallWidget } from "./dashboard-test-call-widget";
import { receptionistChoicesQueryKey, type ReceptionistOption } from "./receptionists/receptionist-choices";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";

const startCall = vi.fn();
const forceEndCall = vi.fn();
const voice = vi.hoisted(() => ({
  onEvent: null as null | ((eventName: string, properties?: Record<string, unknown>) => void),
  getStartPayload: null as null | (() => Promise<Record<string, string>>),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const telemetryRef = vi.hoisted(() => ({ current: null as ReturnType<typeof createRecordedBrowserTelemetry> | null }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => telemetryRef.current!.telemetry }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { telemetryRef.current = createRecordedBrowserTelemetry(); });

vi.mock("@/components/web-voice/AuraVoiceDemo", () => ({
  AuraVoiceDemo: ({
    getStartPayload,
    onEvent,
    onRegisterControls,
  }: {
    getStartPayload?: () => Promise<Record<string, string>>;
    onEvent?: (eventName: string, properties?: Record<string, unknown>) => void;
    onRegisterControls?: (controls: {
      forceEndCall: () => Promise<void>;
      startCall: () => Promise<void>;
    }) => void;
  }) => {
    voice.onEvent = onEvent ?? null;
    voice.getStartPayload = getStartPayload ?? null;
    onRegisterControls?.({
      forceEndCall,
      startCall,
    });

    return <div data-testid="aura-voice-demo" />;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "testCall.trigger": "Test Call",
        "testCall.title": "Test your AI receptionist",
        "testCall.description":
          "Start a live browser call with your configured receptionist.",
        "testCall.receptionist": "Receptionist for test calls",
      };

      return translations[key] ?? key;
    },
  }),
}));

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all" });
const KITSILANO = receptionist("00000000-0000-4000-8000-0000000000a2", "Kitsilano clinic", { sortOrder: 1 });
const BILLING = receptionist("00000000-0000-4000-8000-0000000000a3", "Billing", { status: "paused", sortOrder: 2 });

/** Renders with the business's receptionists already loaded, one by default, so nothing is fetched. */
function renderWithReceptionists(ui: ReactElement, receptionists: Record<string, ReceptionistOption[]> = { "business-1": [FRONT_DESK] }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [businessId, list] of Object.entries(receptionists)) client.setQueryData(receptionistChoicesQueryKey(businessId), { receptionists: list });
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...view, client, rerender: (next: ReactElement) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>) };
}

describe("DashboardTestCallWidget", () => {
  it("renders nothing without a business slug", () => {
    const { container } = renderWithReceptionists(
      <DashboardTestCallWidget businessId={"business-1" as never} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders the test call trigger when a business slug is available", () => {
    renderWithReceptionists(
      <DashboardTestCallWidget
        businessId={"business-1" as never}
        businessSlug="acme-dental"
      />,
    );

    expect(screen.getByRole("button", { name: "Test Call" })).toBeTruthy();
  });

  it("opens the test call dialog and starts the call when the trigger is clicked", async () => {
    startCall.mockClear();

    renderWithReceptionists(
      <DashboardTestCallWidget
        businessId={"business-1" as never}
        businessSlug="acme-dental"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test Call" }));

    expect(screen.getByTestId("aura-voice-demo")).toBeTruthy();
    expect(screen.getByText("Test your AI receptionist")).toBeTruthy();
    expect(startCall).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(forceEndCall).toHaveBeenCalledTimes(1));
  });

  it("forwards web voice telemetry with the active business", () => {
    renderWithReceptionists(
      <DashboardTestCallWidget
        businessId={"business-1" as never}
        businessSlug="acme-dental"
      />,
    );

    voice.onEvent?.("web.voice.test_call_started", {
      widgetId: "lobbystack-dashboard-test-call",
    });

    telemetryRef.current!.expectEvent("web.voice.test_call_started", {
      businessId: "business-1",
    });
  });
});

describe("who answers a test call", () => {
  const widget = (businessId = "business-1") => <DashboardTestCallWidget businessId={businessId} businessSlug="acme-dental" />;
  const picker = () => screen.getByRole("combobox", { name: /^Receptionist for test calls/ });

  it("is the default receptionist, with nothing to choose while the business has one active receptionist", async () => {
    renderWithReceptionists(widget(), { "business-1": [FRONT_DESK, BILLING] });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(await voice.getStartPayload!()).toEqual({});
  });

  it("offers the active receptionists beside the button, and starts the call with the one chosen", async () => {
    renderWithReceptionists(widget(), { "business-1": [FRONT_DESK, KITSILANO, BILLING] });
    const user = userEvent.setup();
    expect(picker().textContent).toContain("Front desk");
    await user.click(picker());
    // A paused receptionist answers nothing, so it isn't offered.
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining("Front desk"), expect.stringContaining("Kitsilano clinic")]);
    await user.click(screen.getByRole("option", { name: /Kitsilano clinic/ }));
    expect(picker().textContent).toContain("Kitsilano clinic");
    expect(await voice.getStartPayload!()).toEqual({ receptionistId: KITSILANO.id });

    await user.click(screen.getByRole("button", { name: "Test Call" }));
    expect(startCall).toHaveBeenCalledTimes(1);
    // The call's dialog covers the page until it closes.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(forceEndCall).toHaveBeenCalledTimes(1));

    await user.click(picker());
    await user.click(screen.getByRole("option", { name: /Front desk/ }));
    // The default receptionist answers a call that names none.
    expect(await voice.getStartPayload!()).toEqual({});
  });

  it("goes back to the default receptionist when the one chosen is paused, or the business changes", async () => {
    const { client, rerender } = renderWithReceptionists(widget(), { "business-1": [FRONT_DESK, KITSILANO], "business-2": [receptionist("00000000-0000-4000-8000-0000000000b1", "Reception", { isDefault: true }), receptionist("00000000-0000-4000-8000-0000000000b2", "Downtown")] });
    const user = userEvent.setup();
    await user.click(picker());
    await user.click(screen.getByRole("option", { name: /Kitsilano clinic/ }));
    expect(await voice.getStartPayload!()).toEqual({ receptionistId: KITSILANO.id });

    rerender(widget("business-2"));
    expect(picker().textContent).toContain("Reception");
    expect(await voice.getStartPayload!()).toEqual({});

    rerender(widget("business-1"));
    await user.click(picker());
    await user.click(screen.getByRole("option", { name: /Kitsilano clinic/ }));
    act(() => client.setQueryData(receptionistChoicesQueryKey("business-1"), { receptionists: [FRONT_DESK, { ...KITSILANO, status: "paused" }, receptionist("00000000-0000-4000-8000-0000000000a4", "Gastown store")] }));
    await waitFor(() => expect(picker().textContent).toContain("Front desk"));
    expect(await voice.getStartPayload!()).toEqual({});
  });
});
