// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import DashboardError from "./error";

const capture = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser-error-reporting", () => ({ captureBrowserError: capture }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key) }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// AUDIT-019: this boundary lives under (dashboard)/, so Next renders it inside
// the shell and the navigation survives a screen that can't render.
it("offers a retry, reports the error and shows the digest support can look up", async () => {
  const retry = vi.fn();
  const error = Object.assign(new Error("render failed"), { digest: "a1b2c3" });
  render(<DashboardError error={error} retry={retry} />);

  expect(screen.getByRole("alert").textContent).toContain("errorBoundary.screenTitle");
  expect(screen.getByText(/errorBoundary.reference/).textContent).toContain("a1b2c3");
  expect(capture).toHaveBeenCalledWith(error);

  await userEvent.click(screen.getByRole("button"));

  expect(retry).toHaveBeenCalledTimes(1);
});

it("says nothing about a digest when the error has none", () => {
  render(<DashboardError error={new Error("render failed")} retry={vi.fn()} />);

  expect(screen.queryByText(/errorBoundary.reference/)).toBeNull();
});
