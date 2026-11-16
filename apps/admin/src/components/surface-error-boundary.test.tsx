// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SurfaceErrorBoundary } from "./surface-error-boundary";

const capture = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser-error-reporting", () => ({ captureBrowserError: capture }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// React writes a caught render error to the console; the test asserts the
// boundary, not the noise.
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

function Panel({ broken }: { broken: boolean }) {
  if (broken) throw new Error("the chart could not be drawn");
  return <p>the chart</p>;
}

it("keeps the rest of the screen when one panel fails to render, and reports the error", async () => {
  render(<div><p>the transcript</p><SurfaceErrorBoundary><Panel broken /></SurfaceErrorBoundary></div>);

  expect(screen.getByText("the transcript")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("errorBoundary.partTitle");
  expect(capture).toHaveBeenCalledWith(expect.objectContaining({ message: "the chart could not be drawn" }));
});

it("tries the panel again when asked", async () => {
  let broken = true;
  const Flaky = () => <Panel broken={broken} />;
  render(<SurfaceErrorBoundary><Flaky /></SurfaceErrorBoundary>);
  expect(screen.getByRole("alert")).toBeTruthy();

  broken = false;
  await userEvent.click(screen.getByRole("button"));

  expect(screen.getByText("the chart")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("renders its children untouched while nothing fails", () => {
  render(<SurfaceErrorBoundary><Panel broken={false} /></SurfaceErrorBoundary>);

  expect(screen.getByText("the chart")).toBeTruthy();
  expect(capture).not.toHaveBeenCalled();
});
