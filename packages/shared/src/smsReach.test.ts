import { describe, expect, it } from "vitest";

import { canTextNumber, failedSmsProviderStatus, permanentSmsErrorCode, smsFailureReason } from "./smsReach";

describe("canTextNumber", () => {
  it("lets toll-free numbers text only US and Canadian numbers", () => {
    expect(canTextNumber("+18445550100", "+14165550134")).toBe(true);
    expect(canTextNumber("+18445550100", "+381695021111")).toBe(false);
    expect(canTextNumber("+18005550100", "+447700900123")).toBe(false);
  });

  it("leaves local numbers to the provider", () => {
    expect(canTextNumber("+14165550100", "+381695021111")).toBe(true);
  });

  it("can't text without a sender or a recipient", () => {
    expect(canTextNumber(undefined, "+14165550134")).toBe(false);
    expect(canTextNumber("+14165550100", null)).toBe(false);
  });
});

describe("permanentSmsErrorCode", () => {
  it("recognizes Twilio errors a retry can't fix", () => {
    expect(permanentSmsErrorCode(Object.assign(new Error("Permission to send an SMS has not been enabled"), { code: 21408, status: 400 }))).toBe(21408);
    expect(permanentSmsErrorCode({ code: 21211 })).toBe(21211);
  });

  it("leaves other failures to the retry", () => {
    expect(permanentSmsErrorCode(Object.assign(new Error("Too many requests"), { code: 20429, status: 429 }))).toBeUndefined();
    expect(permanentSmsErrorCode(new Error("socket hang up"))).toBeUndefined();
    expect(permanentSmsErrorCode(undefined)).toBeUndefined();
  });
});

describe("smsFailureReason", () => {
  it("reads back why a text failed before it went out", () => {
    expect(smsFailureReason(failedSmsProviderStatus({ held: "opted_out" }))).toBe("opted_out");
    expect(smsFailureReason(failedSmsProviderStatus({ held: "no_consent" }))).toBe("no_consent");
    expect(smsFailureReason(failedSmsProviderStatus({ rejected: 21610 }))).toBe("rejected");
    expect(failedSmsProviderStatus({ rejected: 21610 })).toBe("rejected:21610");
    // A country the business's number can't text is the number's setting, not the contact's.
    expect(smsFailureReason(failedSmsProviderStatus({ rejected: 21408 }))).toBe("region_blocked");
    expect(failedSmsProviderStatus({ unsent: 21617 })).toBe("unsent:21617");
    expect(smsFailureReason(failedSmsProviderStatus({ unsent: 21617 }))).toBe("unsent");
    expect(smsFailureReason(failedSmsProviderStatus({ unsent: undefined }))).toBe("unsent");
  });

  it("has no reason for a text the carrier failed, or one Twilio still has", () => {
    expect(smsFailureReason("failed")).toBeNull();
    expect(smsFailureReason("undelivered")).toBeNull();
    expect(smsFailureReason("compliance_reply")).toBeNull();
    expect(smsFailureReason("held:something_else")).toBeNull();
    expect(smsFailureReason(null)).toBeNull();
  });
});
