// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardTestCallWidget, GREETING_WAIT_MS } from "./dashboard-test-call-widget";
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
    i18n: { language: "en" },
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

describe("the test call's greeting", () => {
  const GREETING_URL = "/api/test-call/greeting?businessId=business-1";
  const widget = (role?: string) => <DashboardTestCallWidget businessId="business-1" businessSlug="acme-dental" {...(role ? { role } : {})} />;
  const picker = () => screen.getByRole("combobox", { name: /^Receptionist for test calls/ });
  // What the route answers, in turn; the last answer repeats.
  let answers: Array<string | "unavailable" | "unreachable">;
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer === "unreachable") throw new TypeError("Failed to fetch");
    if (answer === "unavailable") return { ok: false, json: async () => ({ code: "internal_error" }) };
    return { ok: true, json: async () => ({ status: answer }) };
  });
  const asked = () => fetchMock.mock.calls.map(([url, init]) => ({ url, method: init?.method, body: JSON.parse(String(init?.body)) as unknown }));
  const startCallFromButton = () => fireEvent.click(screen.getByRole("button", { name: "Test Call" }));

  beforeEach(() => {
    answers = ["ready"];
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is asked for as the dashboard opens and for each receptionist chosen, so a missing one gets recorded", async () => {
    renderWithReceptionists(widget("business_owner"), { "business-1": [FRONT_DESK, KITSILANO] });
    await waitFor(() => expect(asked()).toEqual([{ url: GREETING_URL, method: "POST", body: {} }]));
    const user = userEvent.setup();
    await user.click(picker());
    await user.click(screen.getByRole("option", { name: /Kitsilano clinic/ }));
    await waitFor(() => expect(asked()).toHaveLength(2));
    expect(asked()[1]).toEqual({ url: GREETING_URL, method: "POST", body: { receptionistId: KITSILANO.id } });
  });

  it("is checked as the call starts, beside the microphone, so a recorded one adds no wait", async () => {
    renderWithReceptionists(widget("business_admin"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    startCallFromButton();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(startCall).toHaveBeenCalledTimes(1);
    await expect(voice.getStartPayload!()).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A call started again from the orb, after this one, checks again.
    await expect(voice.getStartPayload!()).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("holds the call while the greeting is being recorded, then starts it", async () => {
    answers = ["recording", "recording", "recording", "ready"];
    renderWithReceptionists(widget("business_owner"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let started = false;
    const payload = voice.getStartPayload!().then((value) => {
      started = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(true);
    await expect(payload).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("starts the call without it once the wait is over", async () => {
    answers = ["recording"];
    renderWithReceptionists(widget("business_owner"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let started = false;
    void voice.getStartPayload!().then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(GREETING_WAIT_MS - 1);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(true);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1 + GREETING_WAIT_MS / 1_000);
  });

  it("counts a slow answer in the wait", async () => {
    renderWithReceptionists(widget("business_owner"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // An answer that never comes, as from a worker still waking.
    fetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    let started = false;
    void voice.getStartPayload!().then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(GREETING_WAIT_MS - 1);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(true);
  });

  it("starts the call at once when the greeting is recorded, can't be, or can't be checked", async () => {
    renderWithReceptionists(widget("business_owner"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    for (const answer of ["ready", "failed", "off", "missing", "unavailable", "unreachable"]) {
      answers = [answer];
      const before = fetchMock.mock.calls.length;
      await expect(voice.getStartPayload!()).resolves.toEqual({});
      expect(fetchMock.mock.calls.length - before, answer).toBe(1);
    }
  });

  it("stops holding the call when it's closed", async () => {
    answers = ["recording"];
    renderWithReceptionists(widget("business_owner"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    startCallFromButton();
    let started = false;
    void voice.getStartPayload!().then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(started).toBe(false);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    // Within a second, long before the wait would be over.
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 1_000 });
    expect(forceEndCall).toHaveBeenCalledTimes(1);
  });

  it("is never asked for by a member who can't make test calls", async () => {
    renderWithReceptionists(widget("scheduler"));
    startCallFromButton();
    await expect(voice.getStartPayload!()).resolves.toEqual({});
    renderWithReceptionists(widget());
    await expect(voice.getStartPayload!()).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
