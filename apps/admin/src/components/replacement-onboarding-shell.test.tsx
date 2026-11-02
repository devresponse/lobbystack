// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReplacementOnboardingShell as OnboardingShell } from "./replacement-onboarding-shell";
afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en", resolvedLanguage: "en" },
    t: (key: string) => key,
  }),
}));

function renderShell(progress: { current: number; navigableUntil?: number; total: number }) {
  return render(
      <OnboardingShell progress={progress} title="Step title">
        <div>Step body</div>
      </OnboardingShell>
,
  );
}

describe("OnboardingShell", () => {
  it("renders the seven-step progress without verification or website dots", () => {
    renderShell({ current: 7, navigableUntil: 7, total: 7 });

    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 3" }).getAttribute("href"),
    ).toBe("/onboarding/knowledge");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 5" }).getAttribute("href"),
    ).toBe("/onboarding/plan");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 6" }).getAttribute("href"),
    ).toBe("/onboarding/number");
    expect(screen.queryByRole("link", { name: "Go to onboarding step 7" })).toBeNull();
  });

  it("routes every reached step while revisiting earlier steps", () => {
    renderShell({ current: 3, navigableUntil: 7, total: 7 });

    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 2" }).getAttribute("href"),
    ).toBe("/onboarding/business");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 5" }).getAttribute("href"),
    ).toBe("/onboarding/plan");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 7" }).getAttribute("href"),
    ).toBe("/onboarding/attribution");
  });

  it("does not link to steps beyond the current navigable stage", () => {
    renderShell({ current: 4, navigableUntil: 5, total: 7 });

    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 5" }).getAttribute("href"),
    ).toBe("/onboarding/plan");
    expect(screen.queryByRole("link", { name: "Go to onboarding step 6" })).toBeNull();
  });
});
