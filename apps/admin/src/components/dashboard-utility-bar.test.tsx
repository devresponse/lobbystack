// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardUtilityBar } from "./dashboard-utility-bar";
import { ABANDON_INTENT_IDLE_MS, ABANDON_INTENT_MIN_DWELL_MS, ABANDON_INTENT_STORAGE_KEY } from "@/lib/abandon-intent";
import { createRecordedBrowserTelemetry } from "@/lib/telemetry-testing";

const posthog = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: posthog }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock("@/hooks/use-active-business", () => ({
  useActiveBusiness: () => ({ business: { businessId: "business", slug: "business", role: "owner" } }),
}));
vi.mock("./dashboard-test-call-widget", () => ({ DashboardTestCallWidget: () => null }));
vi.mock("./dashboard-feedback-widget", () => ({ DashboardFeedbackWidget: () => <button type="button">Feedback</button> }));
vi.mock("./screen-help-button", () => ({ ScreenHelpButton: () => null }));

const telemetryRef = vi.hoisted(() => ({ current: null as ReturnType<typeof createRecordedBrowserTelemetry> | null }));
vi.mock("@/components/product-analytics", () => ({ useTelemetry: () => telemetryRef.current!.telemetry }));

let store: Record<string, string>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  telemetryRef.current = createRecordedBrowserTelemetry();
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
  });
  // A computer with a mouse, where the survey used to ask.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: fine)", media: query, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("dashboard utility bar", () => {
  it("never pops up the Before you go survey, whether the pointer leaves through the top or the page sits untouched", async () => {
    render(<DashboardUtilityBar />);
    await vi.advanceTimersByTimeAsync(ABANDON_INTENT_MIN_DWELL_MS + 1_000);
    document.dispatchEvent(new MouseEvent("mouseout", { clientY: 0, relatedTarget: null, bubbles: true }));
    await vi.advanceTimersByTimeAsync(ABANDON_INTENT_IDLE_MS + 1_000);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("abandonIntent.title")).toBeNull();
    expect(telemetryRef.current!.events).toEqual([]);
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(store[ABANDON_INTENT_STORAGE_KEY]).toBeUndefined();
  });

  it("keeps the Feedback button for anyone who wants to write", () => {
    render(<DashboardUtilityBar />);
    expect(screen.getByRole("button", { name: "Feedback" })).toBeTruthy();
  });
});
