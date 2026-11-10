import { describe, expect, it } from "vitest";
import { snapshotSchema } from "./index";
const snapshot = {
  businessId: "00000000-0000-4000-8000-000000000001", version: "1", generatedAt: "2026-09-05T12:00:00Z", displayName: "Clinic", timezone: "UTC", defaultLocale: "en", businessType: "clinic", greeting: "Hello", voiceInstructions: "", smsInstructions: "", chatInstructions: "", summary: "", bookingPolicy: "", knowledgeDigest: "", transferPolicy: { mode: "on_urgent", transferNumber: "+14165550100" }, hours: [], closures: [], services: [], contactChannels: {},
};
describe("voice policy snapshot contract", () => {
  it("preserves stored appointment restrictions through transport parsing", () => {
    const policy = { enabled: true, allowCancel: false, allowReschedule: true, verificationMode: "otp_required" };
    const parsed = snapshotSchema.parse({ ...snapshot, appointmentChangePolicy: policy });
    expect(parsed.appointmentChangePolicy).toEqual(policy);
    expect(parsed.transferPolicy.mode).toBe("on_urgent");
  });
  it("keeps the keypad PIN mode, so calls ask for the caller's PIN", () => {
    const policy = { enabled: true, allowCancel: true, allowReschedule: true, verificationMode: "passcode_required" };
    expect(snapshotSchema.parse({ ...snapshot, appointmentChangePolicy: policy }).appointmentChangePolicy).toEqual(policy);
  });
  it("keeps the booking mode so browser calls don't offer bookings the backend won't make", () => {
    expect(snapshotSchema.parse({ ...snapshot, bookingMode: "request" }).bookingMode).toBe("request");
  });
  it("keeps the switch for what calls say about AI and recording, so a call doesn't say it once turned off", () => {
    expect(snapshotSchema.parse({ ...snapshot, recordingNotice: false }).recordingNotice).toBe(false);
    // Snapshots built before the switch have none, and their calls say it.
    expect(snapshotSchema.parse(snapshot)).not.toHaveProperty("recordingNotice");
  });
  it("rejects unknown transfer and appointment verification modes", () => {
    expect(snapshotSchema.safeParse({ ...snapshot, transferPolicy: { mode: "unknown" } }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...snapshot, appointmentChangePolicy: { enabled: true, allowCancel: true, allowReschedule: true, verificationMode: "skip" } }).success).toBe(false);
  });
});

describe("receptionists in the snapshot contract", () => {
  const receptionist = {
    id: "00000000-0000-4000-8000-0000000000a1", name: "Front desk", description: "", isDefault: true, status: "active", listed: true, order: 0, knowledgeScope: "all",
    greeting: "Hello", voiceInstructions: "", smsInstructions: "", chatInstructions: "", bookingPolicy: "", bookingMode: "instant", transferPolicy: { mode: "never" }, snippetIds: ["s1"],
  };
  const store = { ...receptionist, id: "00000000-0000-4000-8000-0000000000a2", name: "Gastown", description: "Gastown orders", pageUrl: "https://demo.example/profile/cafe/gastown", isDefault: false, status: "paused", order: 1, locale: "fr", knowledgeScope: "audience", snippetIds: ["s1", "s2"] };
  const stored = {
    ...snapshot,
    knowledgeSnippets: [{ id: "s1", title: "Hours", content: "9 to 5", tags: [], priority: 1 }],
    extraKnowledgeSnippets: [{ id: "s2", title: "Gastown parking", content: "Behind the store", tags: [], priority: 0 }],
    knowledgeDocuments: [{ title: "Menu", sourceUrl: null, tags: [], revision: 2, audience: "chosen", receptionistIds: [store.id] }],
    receptionists: [receptionist, store],
    publicPageUrl: "https://demo.example/profile/cafe",
  };

  // A web call parses the stored snapshot before cutting its receptionist's view, so nothing may be dropped.
  it("keeps every receptionist, the entries only some use, and the documents' audiences through parsing", () => {
    expect(snapshotSchema.parse(stored)).toEqual(stored);
  });

  it("keeps a cut view's receptionist and the others it can send visitors to", () => {
    const view = { ...snapshot, receptionist: { id: store.id, name: "Gastown", description: "Gastown orders", isDefault: false }, otherReceptionists: [{ name: "Front desk", description: "" }], moreReceptionists: 3 };
    expect(snapshotSchema.parse(view)).toEqual(view);
  });

  it("refuses a receptionist with an unknown status, scope or language", () => {
    for (const change of [{ status: "archived" }, { knowledgeScope: "some" }, { locale: "sr" }]) {
      expect(snapshotSchema.safeParse({ ...stored, receptionists: [{ ...store, ...change }] }).success).toBe(false);
    }
    expect(snapshotSchema.safeParse({ ...stored, knowledgeDocuments: [{ ...stored.knowledgeDocuments[0], audience: "some" }] }).success).toBe(false);
  });
});
