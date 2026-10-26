import { describe, expect, it } from "vitest";

import { callTranscriptUnavailableReason, isCallTranscriptContent, isCallTranscriptRecipients } from "./callTranscripts";

describe("the email after each call", () => {
  it("goes to owners and admins, everyone on the team, or nobody, as the business chooses", () => {
    expect(["business_owner", "business_admin", "scheduler", "viewer"].map((role) => callTranscriptUnavailableReason("owners_and_admins", role))).toEqual([null, null, "owners_and_admins_only", "owners_and_admins_only"]);
    expect(["business_owner", "scheduler", "viewer"].map((role) => callTranscriptUnavailableReason("team", role))).toEqual([null, null, null]);
    expect(callTranscriptUnavailableReason("nobody", "business_owner")).toBe("turned_off");
  });

  it("knows the business's choices from anything else", () => {
    expect(isCallTranscriptRecipients("team")).toBe(true);
    expect(isCallTranscriptRecipients("everyone")).toBe(false);
    expect(isCallTranscriptContent("transcript")).toBe(true);
    expect(isCallTranscriptContent(null)).toBe(false);
  });
});
