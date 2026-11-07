// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import en from "../../../public/locales/en/receptionists.json";
import { EntryPointReceptionist } from "./entry-point-receptionist";
import type { ReceptionistOption } from "./receptionist-choices";
import { entryPointErrorMessage, isEntryPointError } from "./receptionist-errors";

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

const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all" });
const KITSILANO = receptionist("00000000-0000-4000-8000-0000000000a2", "Kitsilano clinic", { sortOrder: 1 });
const BILLING = receptionist("00000000-0000-4000-8000-0000000000a3", "Billing", { status: "paused", sortOrder: 2 });
const CLINIC = [FRONT_DESK, KITSILANO, BILLING];
const ARCHIVED_ID = "00000000-0000-4000-8000-0000000000a9";
const HINT = "Calls and texts to this number go to the receptionist you pick.";

function Harness({ receptionists = CLINIC, initial = null, onChange = vi.fn(), readOnly = false, disabled = false }: { receptionists?: ReceptionistOption[]; initial?: string | null; onChange?: (id: string) => void; readOnly?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <I18nextProvider i18n={i18n}>
      <EntryPointReceptionist
        disabled={disabled}
        hint={HINT}
        label="Answered by"
        onChange={(next) => { setValue(next); onChange(next); }}
        readOnly={readOnly}
        receptionists={receptionists}
        value={value}
      />
    </I18nextProvider>
  );
}

async function pick(name: string) {
  await userEvent.click(screen.getByRole("combobox"));
  await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(`^${name}`) }));
}

describe("who answers an entry point", () => {
  it("shows nothing while the business has one receptionist, since the default answers everything", () => {
    const { container } = render(<Harness receptionists={[FRONT_DESK]} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the default receptionist for an entry point that names nobody, with what the choice does", () => {
    render(<Harness />);
    expect(screen.getByRole("combobox", { name: "Answered by Front desk" })).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the receptionist the entry point names", () => {
    render(<Harness initial={KITSILANO.id} />);
    expect(screen.getByRole("combobox", { name: "Answered by Kitsilano clinic" })).toBeTruthy();
  });

  it("passes on a different receptionist, and nothing when the one answering now is picked again", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await pick("Front desk");
    expect(onChange).not.toHaveBeenCalled();
    await pick("Kitsilano clinic");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(KITSILANO.id);
    expect(screen.getByRole("combobox", { name: "Answered by Kitsilano clinic" })).toBeTruthy();
    await pick("Kitsilano clinic");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("says the default answers while the receptionist chosen is paused", async () => {
    render(<Harness />);
    await pick("Billing");
    expect(screen.getByRole("status").textContent).toBe("Billing is paused, so Front desk answers for now.");
  });

  it("says the default answers when the receptionist chosen was archived, and lets the owner pick the default itself", async () => {
    const onChange = vi.fn();
    render(<Harness initial={ARCHIVED_ID} onChange={onChange} />);
    expect(screen.getByRole("combobox", { name: "Answered by Choose a receptionist" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("The receptionist chosen here was archived, so Front desk answers. Pick another one.");
    await pick("Front desk");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(FRONT_DESK.id);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows who answers as text to people who can't change it, without the hint", () => {
    const { unmount } = render(<Harness initial={KITSILANO.id} readOnly />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Kitsilano clinic").parentElement?.textContent).toBe("Answered by: Kitsilano clinic");
    expect(screen.queryByText(HINT)).toBeNull();
    unmount();
    render(<Harness readOnly />);
    expect(screen.getByText("Front desk").parentElement?.textContent).toBe("Answered by: Front desk");
  });

  it("still says who answers for a paused receptionist when read only", () => {
    render(<Harness initial={BILLING.id} readOnly />);
    expect(screen.getByRole("status").textContent).toBe("Billing is paused, so Front desk answers for now.");
  });

  it("can't be changed while a change is saving", () => {
    render(<Harness disabled />);
    expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("refused changes to who answers", () => {
  const t = (key: string, options: Record<string, string>) => i18n.t(key, options);

  it("knows the refusals it explains", () => {
    for (const code of ["receptionist_archived", "receptionist_not_found", "invalid_receptionist", "phone_number_not_found", "widget_key_not_found", "entry_link_not_found"]) {
      expect(isEntryPointError({ code })).toBe(true);
    }
    expect(isEntryPointError({ code: "invalid_origin" })).toBe(false);
    expect(isEntryPointError(new Error("Network down"))).toBe(false);
    expect(isEntryPointError(null)).toBe(false);
    expect(isEntryPointError("receptionist_archived")).toBe(false);
  });

  it("explains each refusal in the dashboard's language", () => {
    expect(entryPointErrorMessage({ code: "receptionist_archived" }, t)).toBe("That receptionist was archived. Refresh the page and pick another one.");
    expect(entryPointErrorMessage({ code: "receptionist_not_found" }, t)).toBe("That receptionist isn't there any more. Refresh the page.");
    for (const code of ["phone_number_not_found", "widget_key_not_found", "entry_link_not_found"]) {
      expect(entryPointErrorMessage({ code }, t)).toBe("That isn't there any more. Refresh the page.");
    }
  });

  it("names the error ID of a logged failure, and never shows the server's English words", () => {
    expect(entryPointErrorMessage({ code: "internal", message: "Request failed.", errorId: "3f2b6c1e" }, t)).toBe("That didn't work. Try again in a moment. Error ID: 3f2b6c1e");
    expect(entryPointErrorMessage({ code: "invalid_receptionist", message: "receptionistId must be a receptionist's id." }, t)).toBe("That didn't work. Try again in a moment.");
    expect(entryPointErrorMessage(new Error("Network down"), t)).toBe("That didn't work. Try again in a moment.");
  });
});
