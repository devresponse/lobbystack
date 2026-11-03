import { defaultAppointmentChangePolicy, RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH, RECEPTIONIST_TEXT_MAX_LENGTH } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { defaultReceptionistProfile, readReceptionistSettingsChange, sharedReceptionistFields, splitReceptionistPatch } from "./receptionistProfile";

// The dashboard answers with these messages, so moving the rules here must not reword them.
describe("readReceptionistSettingsChange", () => {
  it.each([
    [null, "A profile object is required."],
    [[], "A profile object is required."],
    [{}, "At least one profile field is required."],
    [{ greeting: "" }, "greeting is invalid."],
    [{ greeting: "   " }, "greeting is invalid."],
    [{ greeting: null }, "greeting cannot be empty."],
    [{ tone: 5 }, "tone must be a string."],
    [{ summary: "x".repeat(RECEPTIONIST_TEXT_MAX_LENGTH + 1) }, "summary is invalid."],
    [{ voiceInstructions: "x".repeat(RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH + 1) }, "voiceInstructions is invalid."],
    [{ transferMode: "sometimes" }, "transferMode is invalid."],
    [{ bookingMode: "later" }, "bookingMode is invalid."],
    [{ recordingNotice: "off" }, "recordingNotice must be true or false."],
    [{ recordingNotice: null }, "recordingNotice must be true or false."],
    [{ appointmentChangePolicy: {} }, "appointmentChangePolicy is invalid."],
    [{ appointmentChangePolicy: { enabled: true, allowCancel: true, allowReschedule: true, verificationMode: "email" } }, "appointmentChangePolicy is invalid."],
    // Serbian is a dashboard language, not one calls open in.
    [{ locale: "sr" }, "locale is invalid."],
    [{ timezone: 5 }, "timezone must be a string."],
    [{ regenerateSummary: false }, "regenerateSummary must be true."],
    [{ regenerateSummary: true, summary: "Written by hand." }, "Send summary or regenerateSummary, not both."],
    // With several problems, the first check that fails names the field, as before.
    [{ transferMode: "sometimes", greeting: "" }, "greeting is invalid."],
    [{ bookingMode: "later", transferMode: "sometimes" }, "transferMode is invalid."],
    [{ locale: "sr", bookingMode: "later" }, "bookingMode is invalid."],
    [{ regenerateSummary: false, locale: "sr" }, "locale is invalid."],
  ])("refuses %j with a 400", (body, message) => {
    expect(() => readReceptionistSettingsChange(body)).toThrow(message);
    try {
      readReceptionistSettingsChange(body);
    } catch (error) {
      expect(error).toMatchObject({ status: 400, message });
    }
  });

  it("trims text, keeps only the fields sent, and clears optional ones with null", () => {
    expect(readReceptionistSettingsChange({ greeting: "  Hi there.  ", voiceInstructions: null, transferNumber: null, bookingMode: "request", locale: "fr" })).toEqual({
      patch: { greeting: "Hi there.", voiceInstructions: null, transferNumber: null, bookingMode: "request" },
      locale: "fr",
      regenerateSummary: false,
    });
  });

  it.each(["en", "es", "de", "ja", "zh", "ar"])("takes %s as the language calls open in", (locale) => {
    expect(readReceptionistSettingsChange({ locale })).toEqual({ patch: {}, locale, regenerateSummary: false });
  });

  it("keeps only the policy's known fields, and the longest allowed text", () => {
    const policy = { enabled: true, allowCancel: false, allowReschedule: true, verificationMode: "otp_required" };
    const longest = "x".repeat(RECEPTIONIST_TEXT_MAX_LENGTH);
    expect(readReceptionistSettingsChange({ appointmentChangePolicy: { ...policy, extra: "dropped" }, tone: longest }).patch).toEqual({ tone: longest, appointmentChangePolicy: policy });
  });

  it("takes the switch for what calls say about AI and recording on its own", () => {
    expect(readReceptionistSettingsChange({ recordingNotice: false })).toEqual({ patch: { recordingNotice: false }, regenerateSummary: false });
    expect(readReceptionistSettingsChange({ recordingNotice: true, greeting: "Hi." }).patch).toEqual({ greeting: "Hi.", recordingNotice: true });
  });

  it("takes a summary regeneration on its own", () => {
    expect(readReceptionistSettingsChange({ regenerateSummary: true })).toEqual({ patch: {}, regenerateSummary: true });
  });
});

describe("defaultReceptionistProfile", () => {
  it("greets callers with the business's name until someone writes a greeting", () => {
    expect(defaultReceptionistProfile("Maple Clinic")).toMatchObject({ greeting: "Thank you for calling Maple Clinic.", summary: "Maple Clinic", summarySource: "placeholder", transferMode: "on_request", bookingMode: "instant" });
  });

  it("has calls say they're with an AI and recorded", () => {
    expect(defaultReceptionistProfile("Maple Clinic").recordingNotice).toBe(true);
  });
});

// Saving itself is covered against PostgreSQL in receptionists.integration.test.ts.
describe("splitReceptionistPatch", () => {
  it("gives the business the summary, the AI and recording notice and the appointment change rules, and the receptionist the rest", () => {
    const policy = { ...defaultAppointmentChangePolicy, allowCancel: false };
    expect(splitReceptionistPatch({ greeting: "Hi.", tone: "warm", summary: "We cut hair.", recordingNotice: false, appointmentChangePolicy: policy, transferMode: "never", transferNumber: null, bookingMode: "request" })).toEqual({
      shared: { summary: "We cut hair.", recordingNotice: false, appointmentChangePolicy: policy },
      own: { greeting: "Hi.", tone: "warm", transferMode: "never", transferNumber: null, bookingMode: "request" },
    });
  });

  it("keeps a null that clears a field and leaves out a field that wasn't sent", () => {
    // A body read without exactOptionalPropertyTypes can still carry an undefined field.
    const patch = { voiceInstructions: null, smsInstructions: undefined, summary: undefined } as unknown as Parameters<typeof splitReceptionistPatch>[0];
    expect(splitReceptionistPatch(patch)).toEqual({ shared: {}, own: { voiceInstructions: null } });
  });

  it("splits an empty change into two empty ones", () => {
    expect(splitReceptionistPatch({})).toEqual({ shared: {}, own: {} });
  });

  it("shares only what the design moves to the business", () => {
    expect(sharedReceptionistFields).toEqual(["summary", "recordingNotice", "appointmentChangePolicy"]);
  });
});
