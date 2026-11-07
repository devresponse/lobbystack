// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import en from "../../../public/locales/en/receptionists.json";
import type { ReceptionistOption } from "./receptionist-choices";
import { ReceptionistEditor, type ReceptionistEditorValues } from "./receptionist-editor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "receptionists", interpolation: { escapeValue: false }, resources: { en: { receptionists: en } } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all", description: "Bookings and general questions" });
const KITSILANO = receptionist("00000000-0000-4000-8000-0000000000a2", "Kitsilano clinic", { handle: "kitsilano", description: "Our clinic on West 4th", locale: "fr", listed: false });
const BILLING = receptionist("00000000-0000-4000-8000-0000000000a3", "Billing", { handle: "billing", status: "paused" });

function renderEditor(props: Partial<Parameters<typeof ReceptionistEditor>[0]> = {}) {
  const save = vi.fn<(values: ReceptionistEditorValues) => void>();
  const onOpenChange = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <ReceptionistEditor open onOpenChange={onOpenChange} editing={null} receptionists={[FRONT_DESK, KITSILANO, BILLING]} businessSlug="clinic" businessLocale="en" pending={false} error={null} save={save} {...props} />
    </I18nextProvider>,
  );
  return { save, onOpenChange };
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

describe("adding a receptionist", () => {
  it("opens empty, copying the default receptionist's settings", () => {
    renderEditor();
    expect(screen.getByRole("dialog", { name: "Add a receptionist" })).toBeTruthy();
    expect(field("Name").value).toBe("");
    expect(field("Page address").placeholder).toBe("kitsilano");
    expect(screen.getByText("/profile/clinic/")).toBeTruthy();
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("option", { name: "Business language (English)" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Articles for everyone, and the ones chosen for it" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("switch", { name: "Listed on the business page" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Copy settings from Front desk" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add receptionist" })).toBeTruthy();
  });

  it("asks for a name before saving", async () => {
    const { save } = renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Give the receptionist a name.")).toBeTruthy();
    expect(field("Name").getAttribute("aria-invalid")).toBe("true");
    await userEvent.type(field("Name"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a page address that can't be one", async () => {
    const { save } = renderEditor();
    await userEvent.type(field("Name"), "Gastown store");
    await userEvent.type(field("Page address"), "gastown store!");
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Use lower-case letters and digits, joined by single dashes.")).toBeTruthy();
    await userEvent.clear(field("Page address"));
    await userEvent.type(field("Page address"), "Gastown-Store");
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    // Capitals are lowered, as the server does.
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ handle: "gastown-store" }));
  });

  it("saves what was chosen, trimmed, with the receptionist to copy", async () => {
    const { save } = renderEditor();
    await userEvent.type(field("Name"), "  Gastown store ");
    await userEvent.type(field("What it helps with"), " Our store on Water Street ");
    await userEvent.selectOptions(screen.getByLabelText("Language"), "es");
    await userEvent.click(screen.getByRole("radio", { name: "Every article" }));
    await userEvent.click(screen.getByRole("switch", { name: "Listed on the business page" }));
    await userEvent.click(screen.getByRole("combobox", { name: /^Copy settings from/ }));
    await userEvent.click(screen.getByRole("option", { name: /Kitsilano clinic/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add receptionist" }));
    expect(save).toHaveBeenCalledExactlyOnceWith({ name: "Gastown store", description: "Our store on Water Street", handle: "", locale: "es", knowledgeScope: "all", listed: false, copyFromId: KITSILANO.id });
  });

  it("shows the copy choice with the default receptionist alone", () => {
    renderEditor({ receptionists: [FRONT_DESK] });
    expect(screen.getByRole("combobox", { name: "Copy settings from Front desk" })).toBeTruthy();
  });

  it("says why the server refused, and waits while saving", () => {
    renderEditor({ pending: true, error: "Another receptionist already uses this page address." });
    expect(screen.getByRole("alert").textContent).toBe("Another receptionist already uses this page address.");
    const button = screen.getByRole("button", { name: "Adding…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("editing a receptionist", () => {
  it("opens with what it has, and nothing to copy", async () => {
    const { save } = renderEditor({ editing: KITSILANO });
    expect(screen.getByRole("dialog", { name: "Edit Kitsilano clinic" })).toBeTruthy();
    expect(field("Name").value).toBe("Kitsilano clinic");
    expect(field("What it helps with").value).toBe("Our clinic on West 4th");
    expect(field("Page address").value).toBe("kitsilano");
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("fr");
    expect((screen.getByRole("switch", { name: "Listed on the business page" }) as HTMLElement).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("combobox", { name: /^Copy settings from/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledExactlyOnceWith({ name: "Kitsilano clinic", description: "Our clinic on West 4th", handle: "kitsilano", locale: "fr", knowledgeScope: "audience", listed: false, copyFromId: null });
  });

  it("keeps the default receptionist's page, language and listing, and lets its knowledge change", async () => {
    const { save } = renderEditor({ editing: FRONT_DESK });
    expect(field("Page address").disabled).toBe(true);
    expect(screen.getByText("The default receptionist answers the business page itself.")).toBeTruthy();
    expect((screen.getByLabelText("Language") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("The default receptionist speaks the business's language, which AI settings sets.")).toBeTruthy();
    const listed = screen.getByRole("switch", { name: "Listed on the business page" });
    expect(listed.hasAttribute("data-disabled")).toBe(true);
    await userEvent.click(listed);
    expect(listed.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("The default receptionist is always listed.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Every article" }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "Articles for everyone, and the ones chosen for it" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ knowledgeScope: "audience", handle: "" }));
  });

  it("fills the form afresh each time it opens", async () => {
    const { rerender } = render(<div />);
    const save = vi.fn();
    const editor = (open: boolean, editing: ReceptionistOption | null) => (
      <I18nextProvider i18n={i18n}>
        <ReceptionistEditor open={open} onOpenChange={vi.fn()} editing={editing} receptionists={[FRONT_DESK, KITSILANO]} businessSlug="clinic" businessLocale="en" pending={false} error={null} save={save} />
      </I18nextProvider>
    );
    rerender(editor(true, null));
    await userEvent.type(field("Name"), "Draft");
    rerender(editor(false, null));
    rerender(editor(true, KITSILANO));
    expect(field("Name").value).toBe("Kitsilano clinic");
    rerender(editor(false, KITSILANO));
    rerender(editor(true, null));
    expect(field("Name").value).toBe("");
  });
});
