// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import en from "../../../public/locales/en/receptionists.json";
import type { ReceptionistOption } from "./receptionist-choices";
import { ReceptionistSelect, type ReceptionistSelectProps } from "./receptionist-select";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "receptionists", interpolation: { escapeValue: false }, resources: { en: { receptionists: en } } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

let sequence = 0;
function receptionist(name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  sequence += 1;
  return { id: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: sequence, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("Front desk", { isDefault: true, knowledgeScope: "all", description: "Bookings and general questions" });
const KITSILANO = receptionist("Kitsilano clinic", { description: "Our clinic on West 4th" });
const BILLING = receptionist("Billing", { description: "Invoices and insurance claims", status: "paused" });
const CLINIC = [FRONT_DESK, KITSILANO, BILLING];
/** A chain with enough stores for the search box. */
const STORES = [FRONT_DESK, ...["Gastown", "Yaletown", "Mount Pleasant", "Commercial Drive", "Main Street", "Kerrisdale"].map((name) => receptionist(`${name} store`, { description: `Our store in ${name}` })), receptionist("Recepción", { description: "Atención en español" })];

function Harness(props: Partial<ReceptionistSelectProps> & { initial?: string | null; onChange?: (id: string | null) => void }) {
  const { initial = FRONT_DESK.id, onChange, ...rest } = props;
  const [value, setValue] = useState<string | null>(initial);
  return (
    <I18nextProvider i18n={i18n}>
      <ReceptionistSelect label="Who answers" receptionists={CLINIC} value={value} onChange={(next) => { setValue(next); onChange?.(next); }} {...rest} />
      <p>Elsewhere on the page</p>
      <button type="button">Next field</button>
    </I18nextProvider>
  );
}

const combobox = (name: RegExp | string = /^Who answers/) => screen.getByRole("combobox", { name });
const options = () => within(screen.getByRole("listbox")).getAllByRole("option");
const activeOption = (control: HTMLElement) => document.getElementById(control.getAttribute("aria-activedescendant") ?? "");

describe("the receptionist dropdown", () => {
  it("is hidden while the business has one receptionist, unless asked for", () => {
    const { unmount } = render(<Harness receptionists={[FRONT_DESK]} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    unmount();
    render(<Harness receptionists={[FRONT_DESK]} alwaysShow />);
    expect(combobox("Who answers Front desk")).toBeTruthy();
  });

  it("names the label and the receptionist chosen, closed", () => {
    render(<Harness initial={KITSILANO.id} />);
    const button = combobox("Who answers Kitsilano clinic");
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toContain("KC");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("lists the default first, then the business's order, each with what it helps with, the chosen one selected", async () => {
    render(<Harness initial={KITSILANO.id} />);
    await userEvent.click(combobox());
    const listed = options();
    expect(listed.map((option) => option.textContent)).toEqual([
      "FDFront deskDefaultBookings and general questions",
      "KCKitsilano clinicOur clinic on West 4th",
      "BBillingPausedInvoices and insurance claims",
    ]);
    expect(listed.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(combobox().getAttribute("aria-expanded")).toBe("true");
    expect(activeOption(combobox())).toBe(listed[1]);
  });

  it("is used from the keyboard: arrows move, Enter picks and closes, the focus stays on the button", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    combobox().focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(activeOption(combobox())).toBe(options()[0]);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    // The list stops at its ends.
    expect(activeOption(combobox())).toBe(options()[2]);
    await userEvent.keyboard("{Home}");
    expect(activeOption(combobox())).toBe(options()[0]);
    await userEvent.keyboard("{End}{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(KITSILANO.id);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(combobox("Who answers Kitsilano clinic"));
  });

  it("picks with the space bar, and closes with Escape without changing anything", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    combobox().focus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}{ArrowDown} ");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(KITSILANO.id);
  });

  it("jumps to the receptionist the letters typed in a moment start", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-03T12:00:00Z") });
    try {
      render(<Harness />);
      combobox().focus();
      await userEvent.keyboard("b");
      expect(combobox().getAttribute("aria-expanded")).toBe("true");
      expect(activeOption(combobox())?.textContent).toContain("Billing");
      vi.setSystemTime(new Date("2026-11-03T12:00:01Z"));
      await userEvent.keyboard("k");
      expect(activeOption(combobox())?.textContent).toContain("Kitsilano clinic");
      vi.setSystemTime(new Date("2026-11-03T12:00:02Z"));
      // Typed together, "fr" is the front desk; "f" then "x" matches nobody and stays.
      await userEvent.keyboard("fr");
      expect(activeOption(combobox())?.textContent).toContain("Front desk");
      await userEvent.keyboard("x");
      expect(activeOption(combobox())?.textContent).toContain("Front desk");
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't report picking the receptionist already chosen", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(combobox());
    await userEvent.click(options()[0]!);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes when the owner clicks elsewhere, or tabs on", async () => {
    render(<Harness />);
    await userEvent.click(combobox());
    fireEvent.pointerDown(screen.getByText("Elsewhere on the page"));
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.click(combobox());
    await userEvent.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next field" }));
  });

  it("marks a paused receptionist on the button", () => {
    render(<Harness initial={BILLING.id} />);
    expect(combobox().textContent).toContain("(Paused)");
  });

  it("says so when the receptionist chosen isn't listed any more", () => {
    render(<Harness initial="00000000-0000-4000-8000-0000000000ff" />);
    expect(combobox("Who answers A receptionist that's no longer listed")).toBeTruthy();
  });
});

describe("as a filter", () => {
  it("offers All receptionists first, which picks nobody in particular", async () => {
    const onChange = vi.fn();
    render(<Harness initial={KITSILANO.id} allLabel="All receptionists" onChange={onChange} />);
    await userEvent.click(combobox());
    expect(options()[0]!.textContent).toBe("All receptionists");
    await userEvent.click(options()[0]!);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(combobox("Who answers All receptionists")).toBeTruthy();
  });
});

describe("with 8 receptionists or more", () => {
  it("opens with a search box that takes the focus and filters by name or what each helps with, ignoring accents", async () => {
    render(<Harness receptionists={STORES} />);
    await userEvent.click(combobox());
    const search = screen.getByRole("combobox", { name: "Search receptionists" });
    expect(document.activeElement).toBe(search);
    expect(options()).toHaveLength(8);
    await userEvent.type(search, "yaletown");
    expect(options().map((option) => option.textContent)).toEqual(["YSYaletown storeOur store in Yaletown"]);
    await userEvent.clear(search);
    await userEvent.type(search, "recepcion");
    expect(options()).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.type(search, "ESPAÑOL");
    expect(options().map((option) => option.textContent)).toEqual(["RRecepciónAtención en español"]);
  });

  it("picks the first match with Enter, and the next with the down arrow", async () => {
    const onChange = vi.fn();
    render(<Harness receptionists={STORES} onChange={onChange} />);
    await userEvent.click(combobox());
    await userEvent.keyboard("store in{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(STORES[2]!.id);
    expect(document.activeElement).toBe(combobox("Who answers Yaletown store"));
  });

  it("starts the search with a letter typed on the closed button", async () => {
    render(<Harness receptionists={STORES} />);
    combobox().focus();
    await userEvent.keyboard("m");
    const search = screen.getByRole("combobox", { name: "Search receptionists" }) as HTMLInputElement;
    expect(search.value).toBe("m");
    expect(options().map((option) => option.textContent?.slice(2, 16))).toEqual(["Mount Pleasant", "Commercial Dri", "Main Street st"]);
  });

  it("says so when nobody matches, and starts afresh when opened again", async () => {
    render(<Harness receptionists={STORES} />);
    await userEvent.click(combobox());
    await userEvent.keyboard("dentist on mars");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("No receptionist matches that.");
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(combobox());
    await userEvent.click(combobox());
    expect((screen.getByRole("combobox", { name: "Search receptionists" }) as HTMLInputElement).value).toBe("");
    expect(options()).toHaveLength(8);
  });
});

describe("for owners and admins", () => {
  it("ends the list with Add receptionist and Manage receptionists, which open the Receptionists page", async () => {
    render(<Harness showManage />);
    await userEvent.click(combobox());
    expect(options().slice(-2).map((option) => option.textContent)).toEqual(["Add receptionist", "Manage receptionists"]);
    await userEvent.click(screen.getByRole("option", { name: "Manage receptionists" }));
    expect(router.push).toHaveBeenLastCalledWith("/agent/receptionists");
    combobox().focus();
    await userEvent.keyboard("{End}{ArrowUp}{Enter}");
    expect(router.push).toHaveBeenLastCalledWith("/agent/receptionists?add=1");
  });

  it("keeps them for the search's empty result", async () => {
    render(<Harness receptionists={STORES} showManage />);
    await userEvent.click(combobox());
    await userEvent.keyboard("nobody");
    expect(options().map((option) => option.textContent)).toEqual(["Add receptionist", "Manage receptionists"]);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
