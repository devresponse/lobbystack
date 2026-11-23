// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { onboardingStepPaths } from "@/lib/onboarding-steps";
import { ReplacementOnboardingShell as OnboardingShell } from "./replacement-onboarding-shell";
afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en", resolvedLanguage: "en" },
    t: (key: string) => key,
  }),
}));

function renderShell(progress: { current: number; navigableUntil?: number }, planStep = true) {
  return render(
      <OnboardingShell progress={{ ...progress, paths: onboardingStepPaths(planStep) }} title="Step title">
        <div>Step body</div>
      </OnboardingShell>
,
  );
}

describe("OnboardingShell", () => {
  it("renders the eight-step progress, with the plan right after the name", () => {
    renderShell({ current: 8, navigableUntil: 8 });

    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("navigation", { name: "Onboarding progress: step 8 of 8" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 2" }).getAttribute("href"),
    ).toBe("/onboarding/business");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 3" }).getAttribute("href"),
    ).toBe("/onboarding/plan");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 4" }).getAttribute("href"),
    ).toBe("/onboarding/website");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 6" }).getAttribute("href"),
    ).toBe("/onboarding/greeting");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 7" }).getAttribute("href"),
    ).toBe("/onboarding/number");
    // Sign-up has no page to go back to, and the step shown is no link.
    expect(screen.queryByRole("link", { name: "Go to onboarding step 1" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Go to onboarding step 8" })).toBeNull();
  });

  it("routes every reached step while revisiting earlier steps", () => {
    renderShell({ current: 4, navigableUntil: 8 });

    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 3" }).getAttribute("href"),
    ).toBe("/onboarding/plan");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 8" }).getAttribute("href"),
    ).toBe("/onboarding/attribution");
  });

  it("does not link to steps beyond the current navigable stage", () => {
    // On the plan step, with the name behind it and the website still ahead.
    renderShell({ current: 3, navigableUntil: 3 });

    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 2" }).getAttribute("href"),
    ).toBe("/onboarding/business");
    expect(screen.queryByRole("link", { name: "Go to onboarding step 4" })).toBeNull();
  });

  it("renders seven steps and no plan step where the deployment takes no payments", () => {
    renderShell({ current: 7, navigableUntil: 7 }, false);

    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.getByRole("navigation", { name: "Onboarding progress: step 7 of 7" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 3" }).getAttribute("href"),
    ).toBe("/onboarding/website");
    expect(
      screen.getByRole("link", { name: "Go to onboarding step 6" }).getAttribute("href"),
    ).toBe("/onboarding/number");
    expect(screen.queryAllByRole("link").map((link) => link.getAttribute("href"))).not.toContain("/onboarding/plan");
  });
});
