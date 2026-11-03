import { describe, expect, it } from "vitest";

import en from "../../public/locales/en/receptionists.json";
import { alphabeticalReceptionistOrder, movedReceptionistOrder, receptionistIdentityPatch, receptionistListUrl } from "./live-receptionists-surface";
import type { ReceptionistOption } from "./receptionists/receptionist-choices";
import type { ReceptionistEditorValues } from "./receptionists/receptionist-editor";
import { receptionistErrorMessage } from "./receptionists/receptionist-errors";

function receptionist(id: string, name: string, values: Partial<ReceptionistOption> = {}): ReceptionistOption {
  return { id, name, description: "", handle: null, isDefault: false, status: "active", listed: true, sortOrder: 0, locale: null, knowledgeScope: "audience", ...values };
}

const FRONT_DESK = receptionist("front", "Front desk", { isDefault: true, knowledgeScope: "all" });
const KITSILANO = receptionist("kits", "Kitsilano clinic", { handle: "kitsilano", description: "West 4th", locale: "fr" });
const ECLAIR = receptionist("eclair", "Éclair counter", { handle: "eclair" });
const STORE_2 = receptionist("store-2", "Store 2", { handle: "store-2" });
const STORE_10 = receptionist("store-10", "store 10", { handle: "store-10" });
const values = (overrides: Partial<ReceptionistEditorValues> = {}): ReceptionistEditorValues => ({ name: "Kitsilano clinic", description: "West 4th", handle: "kitsilano", locale: "fr", knowledgeScope: "audience", listed: true, copyFromId: null, ...overrides });

describe("the table's API address", () => {
  it("asks for the receptionists that aren't archived, a status, a search and a page", () => {
    expect(receptionistListUrl("business", { status: "all", search: "", page: 1, pageSize: 10 })).toBe("/api/receptionists?businessId=business&page=1&pageSize=10");
    expect(receptionistListUrl("business", { status: "paused", search: "west 4th", page: 2, pageSize: 20 })).toBe("/api/receptionists?businessId=business&status=paused&search=west+4th&page=2&pageSize=20");
  });

  it("asks for the archived ones as their own view", () => {
    expect(receptionistListUrl("a&b", { status: "archived", search: "", page: 1, pageSize: 10 })).toBe("/api/receptionists?businessId=a%26b&view=archived&page=1&pageSize=10");
  });
});

describe("what an edit sends", () => {
  it("is only what changed", () => {
    expect(receptionistIdentityPatch(KITSILANO, values())).toEqual({});
    expect(receptionistIdentityPatch(KITSILANO, values({ name: "Kitsilano", locale: null, listed: false, knowledgeScope: "all" }))).toEqual({ name: "Kitsilano", locale: null, listed: false, knowledgeScope: "all" });
    expect(receptionistIdentityPatch(KITSILANO, values({ handle: "kits", description: "" }))).toEqual({ handle: "kits", description: "" });
  });

  it("keeps the page address when it is emptied", () => {
    expect(receptionistIdentityPatch(KITSILANO, values({ handle: "" }))).toEqual({});
  });

  it("never changes the default receptionist's page, language or listing", () => {
    expect(receptionistIdentityPatch(FRONT_DESK, { name: "Reception", description: "Everything", handle: "front", locale: "es", knowledgeScope: "audience", listed: false, copyFromId: null })).toEqual({ name: "Reception", description: "Everything", knowledgeScope: "audience" });
  });
});

describe("the order", () => {
  const all = [FRONT_DESK, KITSILANO, ECLAIR, STORE_2];

  it("moves one receptionist a place, the default staying first", () => {
    expect(movedReceptionistOrder(all, ECLAIR.id, -1)).toEqual([FRONT_DESK.id, ECLAIR.id, KITSILANO.id, STORE_2.id]);
    expect(movedReceptionistOrder(all, ECLAIR.id, 1)).toEqual([FRONT_DESK.id, KITSILANO.id, STORE_2.id, ECLAIR.id]);
  });

  it("goes no further than the ends, and never moves the default", () => {
    expect(movedReceptionistOrder(all, KITSILANO.id, -1)).toBeNull();
    expect(movedReceptionistOrder(all, STORE_2.id, 1)).toBeNull();
    expect(movedReceptionistOrder(all, FRONT_DESK.id, 1)).toBeNull();
    expect(movedReceptionistOrder(all, "gone", 1)).toBeNull();
  });

  it("sorts by name as people read it: accents and case aside, numbers by value", () => {
    expect(alphabeticalReceptionistOrder([STORE_10, FRONT_DESK, KITSILANO, STORE_2, ECLAIR], "fr")).toEqual([FRONT_DESK.id, ECLAIR.id, KITSILANO.id, STORE_2.id, STORE_10.id]);
  });
});

describe("a refused change, in the dashboard's language", () => {
  const t = (key: string, options: Record<string, string>) => {
    const [section, name] = key.split(".") as [keyof typeof en, string];
    const text = (en[section] as Record<string, string>)[name] ?? key;
    return text.replace(/\{\{(\w+)\}\}/g, (_, variable: string) => options[variable] ?? "");
  };
  const refusal = (code: string) => Object.assign(new Error("English words from the server."), { code });

  it("explains the plan's limit, as the plan words it", () => {
    expect(receptionistErrorMessage(refusal("receptionist_limit"), t, "add", 1)).toBe(en.errors.limitOne);
    expect(receptionistErrorMessage(refusal("receptionist_limit"), t, "resume", 5)).toBe(en.errors.limit);
  });

  it("says why the default receptionist can't do what was asked", () => {
    expect(receptionistErrorMessage(refusal("default_receptionist"), t, "pause")).toBe(en.errors.defaultPaused);
    expect(receptionistErrorMessage(refusal("default_receptionist"), t, "archive")).toBe(en.errors.defaultArchived);
    expect(receptionistErrorMessage(refusal("default_receptionist"), t, "edit")).toBe(en.errors.defaultListed);
    expect(receptionistErrorMessage(refusal("default_receptionist"), t, "order")).toBe(en.errors.generic);
  });

  it("names the other refusals the server sends", () => {
    expect(receptionistErrorMessage(refusal("handle_taken"), t, "edit")).toBe(en.errors.handleTaken);
    expect(receptionistErrorMessage(refusal("receptionist_cap"), t, "restore")).toBe(en.errors.cap);
    expect(receptionistErrorMessage(refusal("receptionist_paused"), t, "make_default")).toBe(en.errors.resumeFirst);
    expect(receptionistErrorMessage(refusal("receptionist_not_found"), t, "pause")).toBe(en.errors.notFound);
    expect(receptionistErrorMessage(refusal("invalid_handle"), t, "add")).toBe(en.errors.invalid);
  });

  it("gives a logged failure's error ID, and a general message for anything else", () => {
    expect(receptionistErrorMessage(Object.assign(new Error("Request failed."), { errorId: "4f1c" }), t, "add")).toBe(`${en.errors.generic} Error ID: 4f1c`);
    expect(receptionistErrorMessage(refusal("something_new"), t, "add")).toBe(en.errors.generic);
    expect(receptionistErrorMessage(new TypeError("Failed to fetch"), t, "add")).toBe(en.errors.generic);
    expect(receptionistErrorMessage(null, t, "add")).toBe(en.errors.generic);
  });
});
