import { ENTRY_LINK_LABEL_MAX_LENGTH } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { readEntryLinkCreateInput, readEntryLinkPatch } from "./entryLinks";

// What the QR links section sends. The dashboard shows these messages and codes.

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

describe("readEntryLinkCreateInput", () => {
  it("lower-cases the receptionist and tidies the label, which may be left out", () => {
    expect(readEntryLinkCreateInput({ receptionistId: id.toUpperCase(), label: "  Front\n  window " })).toEqual({ receptionistId: id, label: "Front window" });
    expect(readEntryLinkCreateInput({ receptionistId: id })).toEqual({ receptionistId: id, label: "" });
    expect(readEntryLinkCreateInput({ receptionistId: id, label: "l".repeat(ENTRY_LINK_LABEL_MAX_LENGTH) }).label).toHaveLength(ENTRY_LINK_LABEL_MAX_LENGTH);
  });

  it.each([
    ["no body", null, "invalid_body", "A QR link object is required."],
    ["no receptionist", { label: "Door" }, "invalid_receptionist", "receptionistId must name a receptionist."],
    ["a receptionist that isn't an id", { receptionistId: "front-desk" }, "invalid_receptionist", "receptionistId must name a receptionist."],
    ["a label that isn't text", { receptionistId: id, label: 4 }, "invalid_label", "label must be a string."],
    ["a label past the limit", { receptionistId: id, label: "l".repeat(ENTRY_LINK_LABEL_MAX_LENGTH + 1) }, "invalid_label", `Labels can be up to ${ENTRY_LINK_LABEL_MAX_LENGTH} characters.`],
  ])("refuses %s", (_case, body, code, message) => {
    expect(refusal(() => readEntryLinkCreateInput(body))).toMatchObject({ status: 400, code, message });
  });
});

describe("readEntryLinkPatch", () => {
  it("keeps only the fields sent; a null label clears it", () => {
    expect(readEntryLinkPatch({ status: "paused" })).toEqual({ status: "paused" });
    expect(readEntryLinkPatch({ receptionistId: id.toUpperCase(), label: null })).toEqual({ receptionistId: id, label: "" });
  });

  it.each([
    ["no body", [], "invalid_body", "A QR link object is required."],
    ["nothing to change", {}, "invalid_body", "Change the receptionist, the label or the status."],
    ["an unknown status", { status: "archived" }, "invalid_status", "status must be active or paused."],
    ["a null receptionist", { receptionistId: null }, "invalid_receptionist", "receptionistId must name a receptionist."],
  ])("refuses %s", (_case, body, code, message) => {
    expect(refusal(() => readEntryLinkPatch(body))).toMatchObject({ status: 400, code, message });
  });
});
