// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import agentEn from "../../public/locales/en/agent.json";
import knowledgeEn from "../../public/locales/en/knowledge.json";
import receptionistsEn from "../../public/locales/en/receptionists.json";
import { AddKnowledgeSheet } from "./add-knowledge-sheet";
import { ImportWebsiteKnowledgeSheet } from "./import-website-knowledge-sheet";
import type { ReceptionistOption } from "./receptionists/receptionist-choices";
import { UploadKnowledgeDocumentSheet } from "./upload-knowledge-document-sheet";

// The text entry, upload and Import Website dialogs of a business with
// several receptionists: who each new article is for, and page rules for a
// new site. With one receptionist none of it shows (knowledge-forms.test.tsx
// covers the dialogs as they were).

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", defaultNS: "agent", interpolation: { escapeValue: false }, resources: { en: { agent: agentEn, knowledge: knowledgeEn, receptionists: receptionistsEn } } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 1, locale: null, knowledgeScope: "audience", ...values };
}
const FRONT_DESK = receptionist("00000000-0000-4000-8000-0000000000a1", "Front desk", { isDefault: true, knowledgeScope: "all", sortOrder: 0 });
const SALES = receptionist("00000000-0000-4000-8000-0000000000a2", "Sales", { sortOrder: 1 });
const SUPPORT = receptionist("00000000-0000-4000-8000-0000000000a3", "Support", { sortOrder: 2 });
const TEAM = [FRONT_DESK, SALES, SUPPORT];
const ARCHIVED = "00000000-0000-4000-8000-0000000000ee";

const wrap = (node: ReactNode) => render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const audienceBox = () => screen.getByRole("combobox", { name: /^Receptionists it's available to/ });

async function choose(combobox: HTMLElement, ...names: string[]) {
  await userEvent.click(combobox);
  for (const name of names) await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(name) }));
}

function refused(code: string, message = "Refused."): Error {
  return Object.assign(new Error(message), { code });
}

describe("who a new or edited text entry is for", () => {
  async function fill(title = "Test ride policy", content = "Test rides are free and last up to 30 minutes.") {
    await userEvent.type(screen.getByLabelText("Title"), title);
    await userEvent.type(screen.getByLabelText("Content"), content);
  }

  it("leaves a new entry for everyone and says what chosen receptionists mean", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    wrap(<AddKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Available to" });
    expect((within(group).getByRole("radio", { name: "Everyone" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Front desk answers from everything. Articles for chosen receptionists stay out of the business summary.")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ title: "Test ride policy", content: "Test rides are free and last up to 30 minutes.", tags: [], priority: 75, active: true });
  });

  it("saves a new entry for the receptionists chosen", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    wrap(<AddKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={close} />);
    await fill();
    await userEvent.click(screen.getByRole("radio", { name: "Chosen receptionists" }));
    expect(screen.getByText("0 of 3 chosen")).toBeTruthy();
    await choose(audienceBox(), "Sales", "Support");
    expect(screen.getByText("2 of 3 chosen")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: "Test ride policy", audience: { audience: "chosen", receptionistIds: [SALES.id, SUPPORT.id] } }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  });

  it("asks for a receptionist before saving an entry for chosen receptionists", async () => {
    const save = vi.fn();
    wrap(<AddKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={vi.fn()} />);
    await fill();
    await userEvent.click(screen.getByRole("radio", { name: "Chosen receptionists" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = screen.getByText("Choose at least one receptionist, or make it available to everyone.");
    expect(audienceBox().getAttribute("aria-invalid")).toBe("true");
    expect(audienceBox().getAttribute("aria-describedby")).toContain(alert.id);
    expect(save).not.toHaveBeenCalled();
    // Back to everyone, the entry saves for everyone.
    await userEvent.click(screen.getByRole("radio", { name: "Everyone" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith(expect.not.objectContaining({ audience: expect.anything() }));
  });

  it("edits an entry's text without touching who it's for", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    wrap(<AddKnowledgeSheet audience={{ audience: "chosen", receptionistIds: [SUPPORT.id] }} mode="edit" open receptionists={TEAM} save={save} snippet={{ title: "Warranty claims", content: "Bring the receipt.", tags: ["warranty"], priority: 50, active: true }} onOpenChange={vi.fn()} />);
    expect((screen.getByRole("radio", { name: "Chosen receptionists" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Remove Support" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "Bring the receipt and the bike." } });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledWith({ title: "Warranty claims", content: "Bring the receipt and the bike.", tags: ["warranty"], priority: 50, active: true });
  });

  it("saves an entry left for archived receptionists only without asking again, until the owner changes it", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    // audienceValueOf keeps only listed receptionists, so the field opens on chosen with nobody.
    wrap(<AddKnowledgeSheet audience={{ audience: "chosen", receptionistIds: [] }} mode="edit" open receptionists={TEAM} save={save} snippet={{ title: "Old promo", content: "Ten percent off.", priority: 75, active: true }} onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledWith(expect.not.objectContaining({ audience: expect.anything() }));
    save.mockClear();
    await choose(audienceBox(), "Sales");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ audience: { audience: "chosen", receptionistIds: [SALES.id] } }));
  });

  it("opens an edited entry to everyone again", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    wrap(<AddKnowledgeSheet audience={{ audience: "chosen", receptionistIds: [SALES.id] }} mode="edit" open receptionists={TEAM} save={save} snippet={{ title: "Do you price-match?", content: "Yes, within 30 days.", priority: 75, active: true }} onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Everyone" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ audience: { audience: "everyone" } }));
  });

  it("keeps the owner's choice when the entry's audience is read again while the dialog is open", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const snippet = { title: "Returns", content: "Within 30 days.", priority: 75, active: true };
    const view = wrap(<AddKnowledgeSheet audience={{ audience: "chosen", receptionistIds: [SALES.id] }} mode="edit" open receptionists={TEAM} save={save} snippet={snippet} onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Everyone" }));
    // A refetch hands the dialog a new audience object; the owner's change stays.
    view.rerender(<I18nextProvider i18n={i18n}><AddKnowledgeSheet audience={{ audience: "chosen", receptionistIds: [SALES.id] }} mode="edit" open receptionists={TEAM} save={save} snippet={snippet} onOpenChange={vi.fn()} /></I18nextProvider>);
    expect((screen.getByRole("radio", { name: "Everyone" }) as HTMLInputElement).checked).toBe(true);
  });

  it.each([
    ["receptionist_archived", "One of the chosen receptionists was archived. Refresh the page and choose again."],
    ["receptionist_not_found", "That receptionist isn't there any more. Refresh the page."],
    ["knowledge_not_found", "That article isn't there any more. Refresh the page."],
  ])("keeps the dialog open with what was typed when the server refuses with %s", async (code, message) => {
    const save = vi.fn().mockRejectedValue(refused(code));
    const close = vi.fn();
    wrap(<AddKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={close} />);
    await fill();
    await userEvent.click(screen.getByRole("radio", { name: "Chosen receptionists" }));
    await choose(audienceBox(), "Sales");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Test ride policy");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows a server failure with the error ID it was logged under", async () => {
    const save = vi.fn().mockRejectedValue(Object.assign(new Error("Internal error."), { errorId: "err_7f3a" }));
    wrap(<AddKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={vi.fn()} />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That didn't work. Try again in a moment. Error ID: err_7f3a")).toBeTruthy();
  });

  it("asks nothing about receptionists while the business has one", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    wrap(<AddKnowledgeSheet open receptionists={[FRONT_DESK]} save={save} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Available to")).toBeNull();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith(expect.not.objectContaining({ audience: expect.anything() }));
  });

  it("starts the next new entry for everyone again", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const view = wrap(<AddKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Chosen receptionists" }));
    view.rerender(<I18nextProvider i18n={i18n}><AddKnowledgeSheet open={false} receptionists={TEAM} save={save} onOpenChange={vi.fn()} /></I18nextProvider>);
    view.rerender(<I18nextProvider i18n={i18n}><AddKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={vi.fn()} /></I18nextProvider>);
    expect((screen.getByRole("radio", { name: "Everyone" }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("page rules for a new website", () => {
  const url = () => screen.getByLabelText("Website URL");
  const importButton = () => screen.getByRole("button", { name: "Import Website" });

  it("imports a site with a rule per section, each going to one receptionist", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    wrap(<ImportWebsiteKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={vi.fn()} />);
    await userEvent.type(url(), "https://northsidebikes.ca");
    expect(screen.getByText("Pages whose address starts with a rule's path go to its receptionist, on this crawl and every later one.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Path of rule 1" }), "bikes");
    await choose(screen.getByRole("combobox", { name: /^Who rule 1 goes to/ }), "Sales");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Path of rule 2" }), "https://northsidebikes.ca/service");
    await choose(screen.getByRole("combobox", { name: /^Who rule 2 goes to/ }), "Support");
    await userEvent.click(importButton());
    expect(save).toHaveBeenCalledWith("https://northsidebikes.ca", [
      { pathPrefix: "/bikes/", receptionistId: SALES.id },
      { pathPrefix: "/service/", receptionistId: SUPPORT.id },
    ]);
  });

  it("skips rule rows left empty and imports with the address alone", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    wrap(<ImportWebsiteKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={vi.fn()} />);
    await userEvent.type(url(), "https://northsidebikes.ca");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await userEvent.click(importButton());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual(["https://northsidebikes.ca"]);
  });

  it("asks to finish or remove a rule with a path but no receptionist, or a path rules can't use", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    wrap(<ImportWebsiteKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={vi.fn()} />);
    await userEvent.type(url(), "https://northsidebikes.ca");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Path of rule 1" }), "/bikes/");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Path of rule 2" }), "/menu?drinks");
    await choose(screen.getByRole("combobox", { name: /^Who rule 2 goes to/ }), "Sales");
    await userEvent.click(importButton());
    expect(screen.getAllByText("Give the rule a path, such as /bikes/, and a receptionist, or remove it.")).toHaveLength(2);
    expect(screen.getByRole("textbox", { name: "Path of rule 1" }).getAttribute("aria-invalid")).toBe("true");
    expect(save).not.toHaveBeenCalled();
    // Fixing a row clears its message; removing the other lets the import go.
    await choose(screen.getByRole("combobox", { name: /^Who rule 1 goes to/ }), "Support");
    expect(screen.getAllByText("Give the rule a path, such as /bikes/, and a receptionist, or remove it.")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Remove rule 2" }));
    await userEvent.click(importButton());
    expect(save).toHaveBeenCalledWith("https://northsidebikes.ca", [{ pathPrefix: "/bikes/", receptionistId: SUPPORT.id }]);
  });

  it("explains a rule the server refuses and keeps the dialog open", async () => {
    const save = vi.fn().mockRejectedValue(refused("receptionist_archived"));
    const close = vi.fn();
    wrap(<ImportWebsiteKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={close} />);
    await userEvent.type(url(), "https://northsidebikes.ca");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Path of rule 1" }), "/bikes/");
    await choose(screen.getByRole("combobox", { name: /^Who rule 1 goes to/ }), "Sales");
    await userEvent.click(importButton());
    expect(await screen.findByText("One of the chosen receptionists was archived. Refresh the page and choose again.")).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
  });

  it("still shows the server's own words for a site it can't import", async () => {
    const save = vi.fn().mockRejectedValue(new Error("That website couldn't be reached."));
    wrap(<ImportWebsiteKnowledgeSheet open receptionists={TEAM} save={save} onOpenChange={vi.fn()} />);
    await userEvent.type(url(), "https://northsidebikes.ca");
    await userEvent.click(importButton());
    expect(await screen.findByText("That website couldn't be reached.")).toBeTruthy();
  });

  it("has no page rules while the business has one receptionist", () => {
    wrap(<ImportWebsiteKnowledgeSheet open receptionists={[FRONT_DESK]} save={vi.fn()} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Page rules")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
  });
});

describe("who an uploaded file is for", () => {
  const pick = (file = new File(["Opening hours"], "hours.txt", { type: "text/plain" })) => {
    fireEvent.change(document.getElementById("knowledge-document-file")!, { target: { files: [file] } });
    return file;
  };

  it("uploads a file for the receptionists chosen", async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    wrap(<UploadKnowledgeDocumentSheet open receptionists={TEAM} upload={upload} onOpenChange={vi.fn()} />);
    const file = pick();
    await userEvent.click(screen.getByRole("radio", { name: "Chosen receptionists" }));
    await choose(audienceBox(), "Support");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(upload).toHaveBeenCalledWith({ file, contentType: "text/plain", title: "hours", tags: [], audience: { audience: "chosen", receptionistIds: [SUPPORT.id] } });
  });

  it("uploads a file for everyone without naming an audience", async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    wrap(<UploadKnowledgeDocumentSheet open receptionists={TEAM} upload={upload} onOpenChange={vi.fn()} />);
    const file = pick();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(upload).toHaveBeenCalledWith({ file, contentType: "text/plain", title: "hours", tags: [] });
  });

  it("asks for a receptionist before uploading a file for chosen receptionists", async () => {
    const upload = vi.fn();
    wrap(<UploadKnowledgeDocumentSheet open receptionists={TEAM} upload={upload} onOpenChange={vi.fn()} />);
    pick();
    await userEvent.click(screen.getByRole("radio", { name: "Chosen receptionists" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Choose at least one receptionist, or make it available to everyone.")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it("explains a receptionist the server no longer has, and keeps the server's upload limits as they are", async () => {
    const upload = vi.fn().mockRejectedValueOnce(refused("receptionist_not_found")).mockRejectedValueOnce(new Error("Documents must be 10 MB or smaller."));
    wrap(<UploadKnowledgeDocumentSheet open receptionists={TEAM} upload={upload} onOpenChange={vi.fn()} />);
    pick();
    await userEvent.click(screen.getByRole("radio", { name: "Chosen receptionists" }));
    await choose(audienceBox(), "Sales");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That receptionist isn't there any more. Refresh the page.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Documents must be 10 MB or smaller.")).toBeTruthy();
  });

  it("drops a chosen receptionist the business no longer lists", async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    const view = wrap(<UploadKnowledgeDocumentSheet open receptionists={TEAM} upload={upload} onOpenChange={vi.fn()} />);
    const file = pick();
    await userEvent.click(screen.getByRole("radio", { name: "Chosen receptionists" }));
    await choose(audienceBox(), "Sales", "Support");
    // Support is archived while the dialog is open: the list no longer has it.
    view.rerender(<I18nextProvider i18n={i18n}><UploadKnowledgeDocumentSheet open receptionists={[FRONT_DESK, SALES, receptionist(ARCHIVED, "Pop-up")]} upload={upload} onOpenChange={vi.fn()} /></I18nextProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(upload).toHaveBeenCalledWith({ file, contentType: "text/plain", title: "hours", tags: [], audience: { audience: "chosen", receptionistIds: [SALES.id] } });
  });
});
