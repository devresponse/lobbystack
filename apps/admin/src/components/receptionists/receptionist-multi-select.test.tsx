// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import en from "../../../public/locales/en/receptionists.json";
import sr from "../../../public/locales/sr/receptionists.json";
import type { ReceptionistOption } from "./receptionist-choices";
import { ReceptionistMultiSelect, type ReceptionistMultiSelectProps } from "./receptionist-multi-select";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "receptionists", interpolation: { escapeValue: false }, resources: { en: { receptionists: en }, sr: { receptionists: sr } } });
});
afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});

let sequence = 0;
function receptionist(name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  sequence += 1;
  return { id: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: sequence, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("Front desk", { isDefault: true, knowledgeScope: "all" });
const GASTOWN = receptionist("Gastown store", { description: "Water Street" });
const KITSILANO = receptionist("Kitsilano store", { description: "West 4th" });
const YALETOWN = receptionist("Yaletown store", { description: "Hamilton Street" });
const MAIN = receptionist("Main Street store", { description: "Main and 22nd" });
const CHAIN = [FRONT_DESK, GASTOWN, KITSILANO, YALETOWN, MAIN];
const BIG_CHAIN = [...CHAIN, ...["Kerrisdale", "Commercial Drive", "Mount Pleasant"].map((name) => receptionist(`${name} store`, { description: `Our store in ${name}` }))];
const ARCHIVED = "00000000-0000-4000-8000-0000000000ee";

function Harness(props: Partial<ReceptionistMultiSelectProps> & { initial?: string[]; onChange?: (ids: string[]) => void }) {
  const { initial = [GASTOWN.id], onChange, ...rest } = props;
  const [value, setValue] = useState<string[]>(initial);
  return (
    <I18nextProvider i18n={i18n}>
      <ReceptionistMultiSelect label="Available to" receptionists={CHAIN} value={value} onChange={(next) => { setValue(next); onChange?.(next); }} {...rest} />
      <p>Elsewhere on the page</p>
    </I18nextProvider>
  );
}

const combobox = () => screen.getByRole("combobox", { name: /^Available to/ });
const options = () => within(screen.getByRole("listbox")).getAllByRole("option");
const names = () => options().map((option) => option.textContent?.replace(/^[A-Z]{1,2}/, "").replace(/(store|desk).*$/, "$1"));

describe("the receptionists multiselect", () => {
  it("is hidden while the business has one receptionist, unless asked for", () => {
    const { unmount } = render(<Harness receptionists={[FRONT_DESK]} initial={[]} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    unmount();
    render(<Harness receptionists={[FRONT_DESK]} initial={[]} alwaysShow />);
    expect(combobox()).toBeTruthy();
  });

  it("sums the choice up in its name, by default or as the screen words it", () => {
    const { unmount } = render(<Harness initial={[GASTOWN.id, KITSILANO.id]} />);
    expect(combobox().getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Available to 2 of 5 receptionists" })).toBeTruthy();
    unmount();
    render(<Harness initial={[GASTOWN.id]} summary={(chosen, total) => `Available to ${chosen} of ${total} receptionists`} label="Who it's for" />);
    expect(screen.getByRole("combobox", { name: "Who it's for Available to 1 of 5 receptionists" })).toBeTruthy();
  });

  it("shows up to 3 chosen as removable tokens, and past 3 shows 2 and how many more", async () => {
    const { unmount } = render(<Harness initial={[GASTOWN.id, KITSILANO.id, YALETOWN.id]} />);
    expect(screen.getAllByRole("button", { name: /^Remove / }).map((button) => button.getAttribute("aria-label"))).toEqual(["Remove Gastown store", "Remove Kitsilano store", "Remove Yaletown store"]);
    unmount();
    render(<Harness initial={[MAIN.id, GASTOWN.id, KITSILANO.id, YALETOWN.id]} />);
    // In the business's order, whatever order they were chosen in.
    expect(screen.getAllByRole("button", { name: /^Remove / }).map((button) => button.getAttribute("aria-label"))).toEqual(["Remove Gastown store", "Remove Kitsilano store"]);
    await userEvent.click(screen.getByRole("button", { name: "+2 more" }));
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true");
  });

  it("drops a receptionist with its token's button", async () => {
    const onChange = vi.fn();
    render(<Harness initial={[GASTOWN.id, KITSILANO.id]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove Gastown store" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([KITSILANO.id]);
    expect(screen.queryByRole("button", { name: "Remove Gastown store" })).toBeNull();
  });

  it("opens with the chosen ones on top, and keeps the rows still while they are ticked", async () => {
    const onChange = vi.fn();
    render(<Harness initial={[YALETOWN.id]} onChange={onChange} />);
    await userEvent.click(combobox());
    expect(names()).toEqual(["Yaletown store", "Front desk", "Gastown store", "Kitsilano store", "Main Street store"]);
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
    await userEvent.click(screen.getByRole("option", { name: /Main Street store/ }));
    expect(onChange).toHaveBeenLastCalledWith([YALETOWN.id, MAIN.id]);
    await userEvent.click(screen.getByRole("option", { name: /Yaletown store/ }));
    expect(onChange).toHaveBeenLastCalledWith([MAIN.id]);
    expect(names()).toEqual(["Yaletown store", "Front desk", "Gastown store", "Kitsilano store", "Main Street store"]);
    // Opened again, the chosen ones come first.
    await userEvent.click(combobox());
    await userEvent.click(combobox());
    expect(names()[0]).toBe("Main Street store");
  });

  it("is used from the keyboard: arrows move, the space bar and Enter tick, Escape closes", async () => {
    const onChange = vi.fn();
    render(<Harness initial={[]} onChange={onChange} />);
    combobox().focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.getElementById(combobox().getAttribute("aria-activedescendant")!)?.textContent).toContain("Front desk");
    await userEvent.keyboard("{ArrowDown} {ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([GASTOWN.id, KITSILANO.id]);
    await userEvent.keyboard("{End} {Home}");
    expect(onChange).toHaveBeenLastCalledWith([GASTOWN.id, KITSILANO.id, MAIN.id]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(combobox());
  });

  it("selects every receptionist shown, and clears them all", async () => {
    const onChange = vi.fn();
    render(<Harness initial={[GASTOWN.id]} onChange={onChange} />);
    await userEvent.click(combobox());
    await userEvent.click(screen.getByRole("button", { name: "Select all shown" }));
    expect(onChange).toHaveBeenLastCalledWith(CHAIN.map((item) => item.id));
    expect((screen.getByRole("button", { name: "Select all shown" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps receptionists it doesn't list, such as archived ones, out of the count but never drops them", async () => {
    const onChange = vi.fn();
    render(<Harness initial={[ARCHIVED, GASTOWN.id]} onChange={onChange} />);
    expect(screen.getByRole("combobox", { name: "Available to 1 of 5 receptionists" })).toBeTruthy();
    await userEvent.click(combobox());
    await userEvent.click(screen.getByRole("option", { name: /Kitsilano store/ }));
    expect(onChange).toHaveBeenLastCalledWith([GASTOWN.id, KITSILANO.id, ARCHIVED]);
  });

  it("closes when the owner clicks elsewhere", async () => {
    render(<Harness />);
    await userEvent.click(combobox());
    fireEvent.pointerDown(screen.getByText("Elsewhere on the page"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("marks the field when it is wrong, and points to why", () => {
    render(<Harness initial={[]} invalid describedBy="why" />);
    expect(combobox().getAttribute("aria-invalid")).toBe("true");
    expect(combobox().getAttribute("aria-describedby")).toBe("why");
  });

  it("counts in Serbian Latin script", async () => {
    await i18n.changeLanguage("sr");
    render(<Harness initial={[GASTOWN.id, KITSILANO.id]} />);
    expect(screen.getByRole("combobox", { name: "Available to 2 od 5 recepcionera" })).toBeTruthy();
  });
});

describe("with 8 receptionists or more", () => {
  it("searches, and Select all shown takes only the matches", async () => {
    const onChange = vi.fn();
    render(<Harness receptionists={BIG_CHAIN} initial={[FRONT_DESK.id]} onChange={onChange} />);
    await userEvent.click(combobox());
    const search = screen.getByRole("combobox", { name: "Search receptionists" });
    expect(document.activeElement).toBe(search);
    await userEvent.type(search, "street");
    expect(names()).toEqual(["Gastown store", "Yaletown store", "Main Street store"]);
    await userEvent.click(screen.getByRole("button", { name: "Select all shown" }));
    expect(onChange).toHaveBeenLastCalledWith([FRONT_DESK.id, GASTOWN.id, YALETOWN.id, MAIN.id]);
  });

  it("ticks the highlighted match with Enter while the space bar types in the search", async () => {
    const onChange = vi.fn();
    render(<Harness receptionists={BIG_CHAIN} initial={[]} onChange={onChange} />);
    await userEvent.click(combobox());
    await userEvent.keyboard("mount pleasant{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([BIG_CHAIN[7]!.id]);
    expect((screen.getByRole("combobox", { name: "Search receptionists" }) as HTMLInputElement).value).toBe("mount pleasant");
    await userEvent.keyboard("xyz");
    expect(screen.getByRole("status").textContent).toBe("No receptionist matches that.");
  });
});
