// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import english from "../../public/locales/en/common.json";
import { ScreenHelpButton } from "./screen-help-button";

const navigation = vi.hoisted(() => ({ pathname: "/agent/rules" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

const language = vi.hoisted(() => ({ current: "en" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: language.current, resolvedLanguage: language.current },
    t: (key: string) => key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], english) ?? key,
  }),
}));

afterEach(() => {
  cleanup();
  navigation.pathname = "/agent/rules";
  language.current = "en";
});

/**
 * Opens the panel and waits for its articles to arrive. The first opening
 * loads every article, which can take a while on a busy machine.
 */
async function openHelp() {
  fireEvent.click(screen.getByRole("button", { name: "Help for this screen" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("link", { name: /Open in a new tab/ }, { timeout: 15_000 });
  return dialog;
}

/** Uses a button as the keyboard does, with the focus on it. */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

/**
 * Records the panel title's text each time it takes the focus, so a test can
 * tell that the new view was drawn before the focus moved.
 */
function watchTitleFocus(dialog: HTMLElement): string[] {
  const title = within(dialog).getByRole("heading", { level: 2 });
  const focusedAs: string[] = [];
  title.addEventListener("focus", () => focusedAs.push(title.textContent ?? ""));
  return focusedAs;
}

/** The panel's title, which should hold the focus after each move, and read the new view's name as it took it. */
function expectTitleFocused(dialog: HTMLElement, name: string, focusedAs: string[]) {
  const title = within(dialog).getByRole("heading", { level: 2 });
  expect(title.textContent).toBe(name);
  expect(document.activeElement).toBe(title);
  expect(focusedAs.at(-1)).toBe(name);
}

describe("ScreenHelpButton", () => {
  it("opens the screen's own help page in a panel, with a close button", async () => {
    render(<ScreenHelpButton />);

    const dialog = await openHelp();
    expect(within(dialog).getByRole("heading", { level: 2, name: "Rules" })).toBeTruthy();
    expect(within(dialog).getByText("Help for this screen")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { level: 3, name: "What this screen is for" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /Open in a new tab/ }).getAttribute("href")).toBe("/en/help/rules");
    expect(within(dialog).getByRole("link", { name: /Open in a new tab/ }).getAttribute("target")).toBe("_blank");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("finds the page for an address with a language, a trailing slash or a query", async () => {
    navigation.pathname = "/en/agent/rules/?tab=all";
    render(<ScreenHelpButton />);

    const dialog = await openHelp();
    expect(within(dialog).getByRole("heading", { level: 2, name: "Rules" })).toBeTruthy();
  });

  it("lists every topic when no page explains the screen", async () => {
    navigation.pathname = "/no-such-screen";
    render(<ScreenHelpButton />);

    const dialog = await openHelp();
    expect(within(dialog).getByRole("heading", { level: 2, name: "Help center" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /^Rules/ })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /Open in a new tab/ }).getAttribute("href")).toBe("/en/help");
    expect(within(dialog).queryByRole("button", { name: "All help topics" })).toBeNull();
  });

  it("moves to all topics and another page inside the panel, and back, with the title taking the focus", async () => {
    render(<ScreenHelpButton />);

    const dialog = await openHelp();
    const focusedAs = watchTitleFocus(dialog);
    // The new view is drawn by the time the title takes the focus, so the title reads its new name.
    press(within(dialog).getByRole("button", { name: "All help topics" }));
    expectTitleFocused(dialog, "Help center", focusedAs);

    press(within(dialog).getByRole("button", { name: /^Rules/ }));
    expectTitleFocused(dialog, "Rules", focusedAs);

    press(within(dialog).getByRole("button", { name: "Back" }));
    expectTitleFocused(dialog, "Help center", focusedAs);
    press(within(dialog).getByRole("button", { name: "Back" }));
    expectTitleFocused(dialog, "Rules", focusedAs);
    expect(within(dialog).queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("opens a related page in the panel", async () => {
    render(<ScreenHelpButton />);

    const dialog = await openHelp();
    const focusedAs = watchTitleFocus(dialog);
    const related = within(dialog).getByRole("region", { name: "Related help" });
    press(within(related).getByRole("button", { name: /^Knowledge/ }));
    expectTitleFocused(dialog, "Knowledge", focusedAs);
    // A page opened from another shows its section above the title, in the page's language.
    expect(within(dialog).getByText("Agent").getAttribute("lang")).toBe("en");

    press(within(dialog).getByRole("button", { name: "Back" }));
    expectTitleFocused(dialog, "Rules", focusedAs);
  });

  it("says the help is in English when the interface is in another language", async () => {
    language.current = "fr";
    render(<ScreenHelpButton />);

    const dialog = await openHelp();
    expect(within(dialog).getByText("Help is in English for now.")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /Open in a new tab/ }).getAttribute("href")).toBe("/en/help/rules");
  });

  it("closes when the person moves to another screen", async () => {
    const view = render(<ScreenHelpButton />);
    await openHelp();

    navigation.pathname = "/agent/knowledge";
    view.rerender(<ScreenHelpButton />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Coming back doesn't reopen it.
    navigation.pathname = "/agent/rules";
    view.rerender(<ScreenHelpButton />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
