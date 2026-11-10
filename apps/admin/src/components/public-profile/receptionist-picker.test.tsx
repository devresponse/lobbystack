// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { PickerReceptionist } from "@/lib/public-profile-page";

import { ReceptionistPicker } from "./receptionist-picker";

const LABELS = { label: "You're talking to", choose: "Choose who to talk to", search: "Search by name or what they help with", noMatches: "Nobody matches that.", current: "Talking now" };

const FRONT_DESK: PickerReceptionist = { name: "Front desk", description: "Bookings and general questions", href: "/profile/acme-dental" };
const KITSILANO: PickerReceptionist = { name: "Kitsilano clinic", description: "Our clinic on West 4th", href: "/profile/acme-dental/kitsilano" };
const BILLING: PickerReceptionist = { name: "Billing", description: "", href: "/profile/acme-dental/billing" };

/** A chain's stores: enough receptionists for the search box. */
const STORES: PickerReceptionist[] = [
  FRONT_DESK,
  ...["Gastown", "Kitsilano", "Mount Pleasant", "Yaletown", "Commercial Drive", "Main Street"].map((name) => ({ name: `${name} store`, description: `Our store in ${name}`, href: `/profile/acme-dental/${name.toLowerCase().replace(/ /g, "-")}` })),
  { name: "Recepción", description: "Atención en español", href: "/profile/acme-dental/recepcion" },
];

function setup(choices: PickerReceptionist[] = [FRONT_DESK, KITSILANO, BILLING], current: PickerReceptionist = FRONT_DESK) {
  render(<div><ReceptionistPicker current={current} choices={choices} labels={LABELS} /><p>Elsewhere on the page</p></div>);
  return { button: screen.getByRole("button", { name: "You're talking to Front desk" }) };
}

afterEach(cleanup);

describe("ReceptionistPicker", () => {
  it("says who answers, with what it helps with, and keeps the list closed", () => {
    const { button } = setup();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toContain("FD");
    expect(button.textContent).toContain("Bookings and general questions");
    expect(screen.queryByRole("list", { name: "Choose who to talk to" })).toBeNull();
  });

  it("opens a list of links to each receptionist's page, marking this page's", async () => {
    const { button } = setup();
    await userEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/profile/acme-dental", "/profile/acme-dental/kitsilano", "/profile/acme-dental/billing"]);
    expect(links[0]!.getAttribute("aria-current")).toBe("page");
    expect(links[1]!.getAttribute("aria-current")).toBeNull();
    expect(screen.getByLabelText("Talking now")).toBeTruthy();
    // Without a search box the first choice takes the focus.
    expect(document.activeElement).toBe(links[0]);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("moves through the list with the arrow keys, round from either end", async () => {
    const { button } = setup();
    await userEvent.click(button);
    const links = screen.getAllByRole("link");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(links[1]);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(links[0]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(links[2]);
  });

  it("opens from the keyboard and closes with Escape, back on the button", async () => {
    const { button } = setup();
    button.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("closes when the visitor clicks elsewhere on the page", async () => {
    const { button } = setup();
    await userEvent.click(button);
    fireEvent.pointerDown(screen.getByText("Elsewhere on the page"));
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open for a click inside the list", async () => {
    const { button } = setup();
    await userEvent.click(button);
    fireEvent.pointerDown(screen.getAllByRole("link")[1]!);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("offers a search box from 8 receptionists, by name or what they help with, ignoring accents", async () => {
    const { button } = setup(STORES);
    await userEvent.click(button);
    const search = screen.getByRole("searchbox", { name: "Search by name or what they help with" });
    expect(document.activeElement).toBe(search);
    expect(screen.getAllByRole("link")).toHaveLength(8);
    await userEvent.type(search, "yaletown");
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["YSYaletown storeOur store in Yaletown"]);
    await userEvent.clear(search);
    await userEvent.type(search, "recepcion");
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/profile/acme-dental/recepcion"]);
    await userEvent.clear(search);
    await userEvent.type(search, "ESPAÑOL");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("goes from the search box to the first match with the down arrow, and closes from it with Escape", async () => {
    const { button } = setup(STORES);
    await userEvent.click(button);
    await userEvent.type(screen.getByRole("searchbox"), "store in");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getAllByRole("link")[0]);
    expect(document.activeElement?.getAttribute("href")).toBe("/profile/acme-dental/gastown");
    screen.getByRole("searchbox").focus();
    await userEvent.keyboard("{Escape}");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("says so when nobody matches, and starts afresh when opened again", async () => {
    const { button } = setup(STORES);
    await userEvent.click(button);
    await userEvent.type(screen.getByRole("searchbox"), "dentist on mars");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("Nobody matches that.");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(button);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByRole("link")).toHaveLength(8);
  });

  it("names the receptionist whose page it is on the button", () => {
    render(<ReceptionistPicker current={KITSILANO} choices={[FRONT_DESK, KITSILANO]} labels={LABELS} />);
    expect(screen.getByRole("button", { name: "You're talking to Kitsilano clinic" })).toBeTruthy();
  });
});
