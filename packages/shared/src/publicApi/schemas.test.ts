import { describe, expect, it } from "vitest";

import { RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH, RECEPTIONIST_TEXT_MAX_LENGTH } from "../receptionist";
import { CONTACT_PASSCODES_MAX_PER_REQUEST, KNOWLEDGE_UPLOAD_MAX_BYTES } from "./constants";
import { apiAppointmentCreateSchema, apiAppointmentRescheduleSchema, apiBillingCodeCreateSchema, apiCheckoutCreateSchema, apiContactCreateSchema, apiContactPasscodesGenerateSchema, apiContactPasscodesUpdateSchema, apiKnowledgeEntryCreateSchema, apiKnowledgeUploadCreateSchema, apiPublicProfileUpdateSchema, apiReceptionistUpdateSchema, parseApiInput } from "./schemas";

// API and MCP clients get these details back as error.details, so a zod upgrade must not reword them.
describe("parseApiInput", () => {
  it("reports field problems with stable paths and messages", () => {
    expect(parseApiInput(apiContactCreateSchema, { name: "", phone: "123", email: "nope", locale: "de", timezone: 5, extra: 1 })).toEqual({
      ok: false,
      details: [
        { path: "name", message: "Too small: expected string to have >=1 characters" },
        { path: "phone", message: "Use E.164 format, for example +14165550134." },
        { path: "email", message: "Invalid email address" },
        { path: "locale", message: "Invalid option: expected one of \"en\"|\"fr\"|\"es\"|\"sr\"" },
        { path: "timezone", message: "Invalid input: expected string, received number" },
        { path: "(body)", message: "Unrecognized key: \"extra\"" },
      ],
    });
    expect(parseApiInput(apiAppointmentCreateSchema, { service_id: "11111111-1111-1111-1111-111111111111", starts_at: "2026-01-01 10:00", contact_id: "3f0f6f2e-7c1a-4b8e-9a5d-2c3b4a5d6e7f" })).toEqual({
      ok: false,
      details: [
        { path: "service_id", message: "Invalid UUID" },
        { path: "starts_at", message: "Invalid ISO datetime" },
      ],
    });
    expect(parseApiInput(apiContactCreateSchema, null)).toEqual({ ok: false, details: [{ path: "(body)", message: "Invalid input: expected object, received null" }] });
  });

  it("keeps the custom refinement messages", () => {
    expect(parseApiInput(apiContactCreateSchema, {})).toEqual({ ok: false, details: [{ path: "phone", message: "Provide a phone or an email." }] });
    expect(parseApiInput(apiAppointmentCreateSchema, { service_id: "3f0f6f2e-7c1a-4b8e-9a5d-2c3b4a5d6e7f", starts_at: "2026-01-01T10:00:00-04:00" })).toEqual({
      ok: false,
      details: [{ path: "contact_phone", message: "Provide contact_id or contact_phone." }],
    });
  });

  it("says Invalid input for an unknown knowledge entry type", () => {
    expect(parseApiInput(apiKnowledgeEntryCreateSchema, { type: "video" })).toEqual({ ok: false, details: [{ path: "type", message: "Invalid input" }] });
  });

  it("checks receptionist changes with the dashboard's limits", () => {
    expect(parseApiInput(apiReceptionistUpdateSchema, { summary: "Written by hand.", regenerate_summary: true })).toEqual({ ok: false, details: [{ path: "regenerate_summary", message: "Send summary or regenerate_summary, not both." }] });
    expect(parseApiInput(apiReceptionistUpdateSchema, { greeting: "  Hello.  ", transfer_number: null, regenerate_summary: true })).toEqual({ ok: true, data: { greeting: "Hello.", transfer_number: null, regenerate_summary: true } });
    expect(parseApiInput(apiReceptionistUpdateSchema, { voice_instructions: "x".repeat(RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH) }).ok).toBe(true);
    for (const bad of [
      { greeting: "x".repeat(RECEPTIONIST_TEXT_MAX_LENGTH + 1) },
      { greeting: null },
      { transfer_number: "416-555-0134" },
      { transfer_mode: "sometimes" },
      { appointment_change_policy: { enabled: true } },
      { appointment_change_policy: { enabled: true, allow_cancel: true, allow_reschedule: true, verification_mode: "otp_required", extra: true } },
      // To remove instructions, send null.
      { voice_instructions: "" },
      { regenerate_summary: false },
      // The default caller language is locale on PATCH /business.
      { locale: "fr" },
    ]) expect(parseApiInput(apiReceptionistUpdateSchema, bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("checks public profile changes as Settings does, naming the field", () => {
    expect(parseApiInput(apiPublicProfileUpdateSchema, { category: " Dental   clinic ", description: "Family care.\r\n\r\n\r\nSame-week visits. ", address: { country_code: "ca", line2: "  " }, public_email: "" })).toEqual({
      ok: true,
      data: { category: "Dental clinic", description: "Family care.\n\nSame-week visits.", address: { country_code: "CA", line2: null }, public_email: null },
    });
    expect(parseApiInput(apiPublicProfileUpdateSchema, { public_email: "not an email", address: { country_code: "CAN" } })).toEqual({
      ok: false,
      details: [
        { path: "address.country_code", message: "Use a two-letter country code, such as CA." },
        { path: "public_email", message: "Enter an email address such as hello@example.com." },
      ],
    });
    for (const bad of [{ category: "x".repeat(81) }, { category: "Dental\u202eclinic" }, { address: { postalCode: "V5T" } }, { widget_key_id: "not-a-uuid" }, { published: "yes" }]) {
      expect(parseApiInput(apiPublicProfileUpdateSchema, bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes upload file names that name a file, up to the shared size limit", () => {
    const upload = { file_name: "prices.pdf", content_type: "application/pdf", length: KNOWLEDGE_UPLOAD_MAX_BYTES, checksum_sha256: `${"A".repeat(43)}=` };
    expect(parseApiInput(apiKnowledgeUploadCreateSchema, upload).ok).toBe(true);
    expect(parseApiInput(apiKnowledgeUploadCreateSchema, { ...upload, file_name: ".env" }).ok).toBe(true);
    for (const fileName of [".", "..", " .. "]) {
      expect(parseApiInput(apiKnowledgeUploadCreateSchema, { ...upload, file_name: fileName })).toEqual({ ok: false, details: [{ path: "file_name", message: "Use the file's name, such as prices.pdf." }] });
    }
    expect(parseApiInput(apiKnowledgeUploadCreateSchema, { ...upload, length: KNOWLEDGE_UPLOAD_MAX_BYTES + 1 }).ok).toBe(false);
  });

  it("checks keypad PINs with the dashboard's rules, one message each", () => {
    const one = (passcode: unknown) => ({ passcodes: [{ contact_id: "3f0f6f2e-7c1a-4b8e-9a5d-2c3b4a5d6e7f", passcode }] });
    expect(parseApiInput(apiContactPasscodesUpdateSchema, one("480613"))).toEqual({ ok: true, data: one("480613") });
    expect(parseApiInput(apiContactPasscodesUpdateSchema, one(null))).toEqual({ ok: true, data: one(null) });
    for (const malformed of ["123", "123456789", "12a4", "١٢٣٤٥"]) expect(parseApiInput(apiContactPasscodesUpdateSchema, one(malformed)), malformed).toEqual({ ok: false, details: [{ path: "passcodes.0.passcode", message: "Use 4 to 8 digits." }] });
    for (const guessable of ["1111", "1234", "98765432"]) expect(parseApiInput(apiContactPasscodesUpdateSchema, one(guessable)), guessable).toEqual({ ok: false, details: [{ path: "passcodes.0.passcode", message: "Too easy to guess: avoid one digit repeated or digits in a row, such as 1111 or 1234." }] });
    expect(parseApiInput(apiContactPasscodesUpdateSchema, { passcodes: Array.from({ length: CONTACT_PASSCODES_MAX_PER_REQUEST + 1 }, () => one("480613").passcodes[0]) }).ok).toBe(false);
    expect(parseApiInput(apiContactPasscodesGenerateSchema, {})).toEqual({ ok: true, data: {} });
    for (const bad of [{ length: 3 }, { length: 9 }, { length: 4.5 }, { contact_ids: [] }, { contact_ids: ["x"] }, { all: true }]) expect(parseApiInput(apiContactPasscodesGenerateSchema, bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("takes a promo code with plan promo, and only then", () => {
    expect(parseApiInput(apiCheckoutCreateSchema, { plan: "promo", interval: "monthly", promo_code: "allo-7k2q-px9m" })).toEqual({ ok: true, data: { plan: "promo", interval: "monthly", promo_code: "allo-7k2q-px9m" } });
    expect(parseApiInput(apiCheckoutCreateSchema, { plan: "promo", interval: "monthly" })).toEqual({ ok: false, details: [{ path: "promo_code", message: "Required when plan is promo." }] });
    expect(parseApiInput(apiCheckoutCreateSchema, { plan: "pro", interval: "annual", promo_code: "SPRING25" })).toEqual({ ok: false, details: [{ path: "promo_code", message: "Only allowed when plan is promo." }] });
  });

  it("takes a billing email for the business's Polar customer with any plan", () => {
    expect(parseApiInput(apiCheckoutCreateSchema, { plan: "starter", interval: "monthly", billing_email: "billing@example.com" })).toEqual({ ok: true, data: { plan: "starter", interval: "monthly", billing_email: "billing@example.com" } });
    expect(parseApiInput(apiCheckoutCreateSchema, { plan: "promo", interval: "monthly", promo_code: "allo-7k2q-px9m", billing_email: "billing@example.com" }).ok).toBe(true);
    for (const bad of ["billing", "", `${"x".repeat(320)}@example.com`]) expect(parseApiInput(apiCheckoutCreateSchema, { plan: "pro", interval: "monthly", billing_email: bad })).toMatchObject({ ok: false, details: [{ path: "billing_email" }] });
  });

  it("needs a use limit and an end for a code anyone may enter", () => {
    const business = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6";
    expect(parseApiInput(apiBillingCodeCreateSchema, { plan: "pro_launch", business_id: business }).ok).toBe(true);
    expect(parseApiInput(apiBillingCodeCreateSchema, { plan: "pro_launch", max_uses: 50, expires_at: "2026-12-31T00:00:00Z" }).ok).toBe(true);
    expect(parseApiInput(apiBillingCodeCreateSchema, { plan: "pro_launch" })).toEqual({ ok: false, details: [{ path: "max_uses", message: "Required for a shared code." }, { path: "expires_at", message: "Required for a shared code." }] });
    expect(parseApiInput(apiBillingCodeCreateSchema, { plan: "pro_launch", business_id: business, code: "SPRING25", prefix: "ALLO" })).toEqual({ ok: false, details: [{ path: "prefix", message: "Send code or prefix, not both." }] });
    expect(parseApiInput(apiBillingCodeCreateSchema, { plan: "pro_launch", business_id: business, max_uses: 0 }).ok).toBe(false);
  });

  it("accepts start times with or without seconds", () => {
    for (const starts_at of ["2026-10-09T14:00-04:00", "2026-10-09T18:00Z", "2026-10-09T14:00:00-04:00", "2026-10-09T18:00:00.000Z"]) {
      expect(parseApiInput(apiAppointmentRescheduleSchema, { starts_at })).toEqual({ ok: true, data: { starts_at } });
    }
    expect(parseApiInput(apiAppointmentRescheduleSchema, { starts_at: "2026-10-09T14:00" })).toEqual({ ok: false, details: [{ path: "starts_at", message: "Invalid ISO datetime" }] });
  });
});
