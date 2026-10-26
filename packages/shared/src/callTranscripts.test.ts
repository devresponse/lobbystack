import { describe, expect, it } from "vitest";

import { callTranscriptUnavailableReason, isCallTranscriptContent, isCallTranscriptRecipients, withoutCardAndIdNumbers } from "./callTranscripts";

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

describe("card and ID numbers in the email after a call", () => {
  it("are taken out however the transcription wrote them", () => {
    expect(withoutCardAndIdNumbers("Sure, it's 4111 1111 1111 1111, and the code on the back is 123.")).toBe("Sure, it's [card number removed], and the code on the back is 123.");
    expect(withoutCardAndIdNumbers("5555-5555-5555-4444")).toBe("[card number removed]");
    expect(withoutCardAndIdNumbers("It's 378282246310005.")).toBe("It's [card number removed].");
    expect(withoutCardAndIdNumbers("4,111,111,111,111,111")).toBe("[card number removed]");
    expect(withoutCardAndIdNumbers("6 0 1 1 1 1 1 1 1 1 1 1 1 1 1 7")).toBe("[card number removed]");
    expect(withoutCardAndIdNumbers("Four one one one, one one one one, one one one one, one one one one.")).toBe("[card number removed].");
    expect(withoutCardAndIdNumbers("cuatro uno uno uno uno uno uno uno uno uno uno uno uno uno uno uno")).toBe("[card number removed]");
    // The expiry date can follow without a pause.
    expect(withoutCardAndIdNumbers("4111 1111 1111 1111 12 28")).toBe("[card number removed] 12 28");
    expect(withoutCardAndIdNumbers("My SSN is 123-45-6789.")).toBe("My SSN is [ID number removed].");
    expect(withoutCardAndIdNumbers("My SIN is 046 454 286")).toBe("My SIN is [ID number removed]");
    expect(withoutCardAndIdNumbers("zéro quatre six quatre cinq quatre deux huit six")).toBe("[ID number removed]");
    expect(withoutCardAndIdNumbers("046454286 then 4111111111111111")).toBe("[ID number removed] then [card number removed]");
  });

  it("leave phone numbers, times, prices and other numbers alone", () => {
    for (const text of [
      "Call me back at 416 555 0134.",
      "It's +1 416-555-0134, extension 22.",
      "4 1 6 5 5 5 0 1 3 4",
      "four one six, five five five, oh one three four",
      "Friday at 10:30 for $45.50, or Saturday at 9.",
      "My postal code is 90210-1234.",
      "The order number is 4111 1111 1111 1112.",
      "One moment, I have two questions.",
    ]) expect(withoutCardAndIdNumbers(text)).toBe(text);
  });

  it("say what was taken out in the reader's language", () => {
    expect(withoutCardAndIdNumbers("4111111111111111 et 046 454 286", { card: "[numéro de carte retiré]", id: "[numéro d'identité retiré]" })).toBe("[numéro de carte retiré] et [numéro d'identité retiré]");
  });
});
