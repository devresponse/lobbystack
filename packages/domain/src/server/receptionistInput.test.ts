import { randomUUID } from "node:crypto";

import { MAX_RECEPTIONISTS_PER_REQUEST, RECEPTIONIST_DESCRIPTION_MAX_LENGTH, RECEPTIONIST_HANDLE_MAX_LENGTH, RECEPTIONIST_NAME_MAX_LENGTH } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { readListedReceptionists, readReceptionistCreateInput, readReceptionistIdentityPatch, readReceptionistOrder, readReceptionistStatus } from "./receptionistInput";

// The dashboard shows these messages and codes, so moving the rules must not change them.

/** The error a reader throws, or a failed test when it accepts the value. */
function refusal(read: () => unknown): Error & { status?: unknown; code?: unknown } {
  try {
    read();
  } catch (error) {
    return error as Error & { status?: unknown; code?: unknown };
  }
  throw new Error("The reader accepted the value.");
}

const id = "0b0e7a52-8f5d-4c47-9a39-1f1d3c8a2b6e";
const upperId = id.toUpperCase();
const tooMany = () => Array.from({ length: MAX_RECEPTIONISTS_PER_REQUEST + 1 }, () => randomUUID());

describe("readReceptionistCreateInput", () => {
  it("keeps the fields sent, tidied", () => {
    expect(readReceptionistCreateInput({ name: "  Main   Street ", description: " Rentals\n and  returns ", handle: " Main-Street ", locale: "fr", knowledgeScope: "audience", listed: false, copyFromId: upperId }))
      .toEqual({ name: "Main Street", description: "Rentals and returns", handle: "main-street", locale: "fr", knowledgeScope: "audience", listed: false, copyFromId: id });
  });

  it("leaves out what the body leaves out, and reads an empty handle or copyFromId as none", () => {
    expect(readReceptionistCreateInput({ name: "Gastown" })).toEqual({ name: "Gastown" });
    expect(readReceptionistCreateInput({ name: "Gastown", handle: "", copyFromId: null })).toEqual({ name: "Gastown" });
    expect(readReceptionistCreateInput({ name: "Gastown", handle: null })).toEqual({ name: "Gastown" });
    // A null description is an empty one; a null or empty language means the business's.
    expect(readReceptionistCreateInput({ name: "Gastown", description: null, locale: null })).toEqual({ name: "Gastown", description: "", locale: null });
    expect(readReceptionistCreateInput({ name: "Gastown", locale: "" })).toEqual({ name: "Gastown", locale: null });
  });

  it("accepts each field at its limit", () => {
    const body = { name: "n".repeat(RECEPTIONIST_NAME_MAX_LENGTH), description: "d".repeat(RECEPTIONIST_DESCRIPTION_MAX_LENGTH), handle: "h".repeat(RECEPTIONIST_HANDLE_MAX_LENGTH) };
    expect(readReceptionistCreateInput(body)).toEqual(body);
  });

  it.each([
    ["no body", null, "invalid_body", "A receptionist object is required."],
    ["an array", [], "invalid_body", "A receptionist object is required."],
    ["no name", {}, "invalid_name", "name must be a string."],
    ["a name that isn't text", { name: 7 }, "invalid_name", "name must be a string."],
    ["a blank name", { name: " \n " }, "invalid_name", "Give the receptionist a name."],
    ["a name past the limit", { name: "n".repeat(RECEPTIONIST_NAME_MAX_LENGTH + 1) }, "invalid_name", `Names can be up to ${RECEPTIONIST_NAME_MAX_LENGTH} characters.`],
    ["a description that isn't text", { name: "Gastown", description: 3 }, "invalid_description", "description must be a string."],
    ["a description past the limit", { name: "Gastown", description: "d".repeat(RECEPTIONIST_DESCRIPTION_MAX_LENGTH + 1) }, "invalid_description", `"What it helps with" can be up to ${RECEPTIONIST_DESCRIPTION_MAX_LENGTH} characters.`],
    ["a handle that isn't text", { name: "Gastown", handle: 5 }, "invalid_handle", "handle must be a string."],
    ["a handle with a space", { name: "Gastown", handle: "main street" }, "invalid_handle", `A page address is up to ${RECEPTIONIST_HANDLE_MAX_LENGTH} lower-case letters and digits, joined by single dashes.`],
    ["a handle with a double dash", { name: "Gastown", handle: "main--street" }, "invalid_handle", `A page address is up to ${RECEPTIONIST_HANDLE_MAX_LENGTH} lower-case letters and digits, joined by single dashes.`],
    ["a handle past the limit", { name: "Gastown", handle: "h".repeat(RECEPTIONIST_HANDLE_MAX_LENGTH + 1) }, "invalid_handle", `A page address is up to ${RECEPTIONIST_HANDLE_MAX_LENGTH} lower-case letters and digits, joined by single dashes.`],
    ["a language calls don't open in", { name: "Gastown", locale: "xx" }, "invalid_locale", "locale is not a language calls support."],
    ["an unknown knowledge setting", { name: "Gastown", knowledgeScope: "own" }, "invalid_knowledge_scope", "knowledgeScope must be all or audience."],
    ["listed as text", { name: "Gastown", listed: "true" }, "invalid_listed", "listed must be true or false."],
    ["a copyFromId that isn't an id", { name: "Gastown", copyFromId: "front-desk" }, "invalid_copy_from", "copyFromId must be a receptionist id."],
  ])("refuses %s", (_case, body, code, message) => {
    expect(refusal(() => readReceptionistCreateInput(body))).toMatchObject({ status: 400, code, message });
  });
});

describe("readReceptionistIdentityPatch", () => {
  it("keeps only the fields sent", () => {
    expect(readReceptionistIdentityPatch({ listed: true })).toEqual({ listed: true });
    expect(readReceptionistIdentityPatch({ name: " Yaletown ", description: "", handle: "Yaletown", locale: null, knowledgeScope: "all" }))
      .toEqual({ name: "Yaletown", description: "", handle: "yaletown", locale: null, knowledgeScope: "all" });
  });

  it.each([
    ["no body", "Yaletown", "invalid_body", "A receptionist object is required."],
    ["nothing to change", {}, "invalid_body", "Send at least one field to change."],
    // Only the fields the Receptionists page changes count; the rest belong to other routes.
    ["only fields it doesn't change", { copyFromId: id, status: "paused" }, "invalid_body", "Send at least one field to change."],
    // Adding one reads an empty handle as "make it from the name"; a change can't empty it.
    ["an empty handle", { handle: "" }, "invalid_handle", `A page address is up to ${RECEPTIONIST_HANDLE_MAX_LENGTH} lower-case letters and digits, joined by single dashes.`],
    ["a null handle", { handle: null }, "invalid_handle", "handle must be a string."],
    ["a blank name", { name: "" }, "invalid_name", "Give the receptionist a name."],
    ["listed as a number", { listed: 1 }, "invalid_listed", "listed must be true or false."],
  ])("refuses %s", (_case, body, code, message) => {
    expect(refusal(() => readReceptionistIdentityPatch(body))).toMatchObject({ status: 400, code, message });
  });
});

describe("readReceptionistStatus", () => {
  it.each(["active", "paused"])("reads %s", (status) => {
    expect(readReceptionistStatus(status)).toBe(status);
  });

  // Archiving has its own route, so it isn't a status.
  it.each(["archived", "ACTIVE", "", null, undefined])("refuses %j", (value) => {
    expect(refusal(() => readReceptionistStatus(value))).toMatchObject({ status: 400, code: "invalid_status", message: "status must be active or paused." });
  });
});

describe("readReceptionistOrder", () => {
  it("lower-cases the ids and keeps their order", () => {
    const second = randomUUID();
    expect(readReceptionistOrder([upperId, second])).toEqual([id, second]);
  });

  it.each([
    ["no list", undefined, "receptionistIds must list the receptionists in order."],
    ["an empty list", [], "receptionistIds must list the receptionists in order."],
    ["more ids than a request takes", tooMany(), "receptionistIds must list the receptionists in order."],
    ["something that isn't an id", [id, "front-desk"], "receptionistIds must list receptionist ids."],
    ["the same receptionist twice, in any letter case", [id, upperId], "A receptionist appears twice in the order."],
  ])("refuses %s", (_case, value, message) => {
    expect(refusal(() => readReceptionistOrder(value))).toMatchObject({ status: 400, code: "invalid_order", message });
  });
});

describe("readListedReceptionists", () => {
  it("allows none at all, and lower-cases the ids", () => {
    expect(readListedReceptionists([])).toEqual([]);
    expect(readListedReceptionists([upperId])).toEqual([id]);
  });

  it.each([
    ["no list", null, "receptionistIds must list the receptionists the business page shows."],
    ["more ids than a request takes", tooMany(), "receptionistIds must list the receptionists the business page shows."],
    ["something that isn't an id", [7], "receptionistIds must list receptionist ids."],
    ["the same receptionist twice", [id, upperId], "A receptionist appears twice."],
  ])("refuses %s", (_case, value, message) => {
    expect(refusal(() => readListedReceptionists(value))).toMatchObject({ status: 400, code: "invalid_listed", message });
  });
});
