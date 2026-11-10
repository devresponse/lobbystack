import { describe, expect, it } from "vitest";

import type { SnapshotReceptionist } from "@lobbystack/shared";

import {
  buildBusinessContextSnapshot,
  channelInstructions,
  knowledgeDigestOf,
  snapshotForReceptionist,
  MAX_AGENT_RULE_CONTENT_CHARS,
  MAX_AGENT_RULE_TITLE_CHARS,
  MAX_AGENT_RULES_PER_SNAPSHOT,
} from "./snapshot";

describe("buildBusinessContextSnapshot", () => {
  it("includes the knowledge digest, prioritized snippets, and contact channels", () => {
    const snapshot = buildBusinessContextSnapshot({
      businessId: "biz-1",
      version: "v1",
      generatedAt: "2026-03-08T12:00:00.000Z",
      displayName: "Maple Family Clinic",
      timezone: "America/Toronto",
      defaultLocale: "en",
      businessType: "clinic",
      greeting: "Hello",
      tone: "warm",
      bookingPolicy: "Only confirm after booking.",
      summary: "General clinic",
      knowledgeDigest: "Parking is behind the building.",
      hours: [{ dayOfWeek: 1, openMinutes: 540, closeMinutes: 1020 }],
      closures: [],
      services: [{ id: "svc-1", name: "Checkup", durationMinutes: 30 }],
      rules: [
        { id: "rule-2", title: "Second", content: "Ask for call volume.", order: 2000 },
        { id: "rule-1", title: "First", content: "Ask business type.", order: 1000 },
      ],
      snippets: [
        { id: "snippet-1", title: "Parking", content: "Rear lot", tags: [], priority: 2 },
        { id: "snippet-2", title: "Masks", content: "Optional", tags: [], priority: 10 },
      ],
      transferPolicy: { mode: "on_urgent", transferNumber: "+14165551234" },
      appointmentChangePolicy: { enabled: true, allowCancel: false, allowReschedule: true, verificationMode: "otp_required" },
      phoneNumber: "+14165550000",
      smsNumber: "+14165550000",
      chatInstructions: "Be concise in the chat widget.",
    });

    expect(snapshot.transferPolicy.mode).toBe("on_urgent");
    expect(snapshot.appointmentChangePolicy).toEqual({ enabled: true, allowCancel: false, allowReschedule: true, verificationMode: "otp_required" });
    expect(snapshot.knowledgeDigest).toBe("Parking is behind the building.");
    expect(snapshot.chatInstructions).toBe("Be concise in the chat widget.");
    expect(snapshot.knowledgeSnippets?.map((snippet) => snippet.id)).toEqual([
      "snippet-2",
      "snippet-1",
    ]);
    expect(snapshot.rules?.map((rule) => rule.id)).toEqual(["rule-1", "rule-2"]);
    expect(snapshot.contactChannels.phoneNumber).toBe("+14165550000");
    // Calls say they're with an AI and recorded unless the business turned it off.
    expect(snapshot.recordingNotice).toBe(true);
  });

  it("keeps a business's choice to have calls not say they're with an AI and recorded", () => {
    const snapshot = buildBusinessContextSnapshot({
      businessId: "biz-1",
      version: "v1",
      generatedAt: "2026-03-08T12:00:00.000Z",
      displayName: "Maple Family Clinic",
      timezone: "America/Toronto",
      defaultLocale: "en",
      businessType: "clinic",
      greeting: "Hello",
      recordingNotice: false,
      tone: "warm",
      bookingPolicy: "Only confirm after booking.",
      summary: "General clinic",
      hours: [],
      closures: [],
      services: [],
      rules: [],
      snippets: [],
      transferPolicy: { mode: "never" },
    });

    expect(snapshot.recordingNotice).toBe(false);
  });

  it("caps rule count and text stored in snapshots", () => {
    const snapshot = buildBusinessContextSnapshot({
      businessId: "biz-1",
      version: "v1",
      generatedAt: "2026-03-08T12:00:00.000Z",
      displayName: "Maple Family Clinic",
      timezone: "America/Toronto",
      defaultLocale: "en",
      businessType: "clinic",
      greeting: "Hello",
      tone: "warm",
      bookingPolicy: "Only confirm after booking.",
      summary: "General clinic",
      hours: [],
      closures: [],
      services: [],
      rules: Array.from({ length: MAX_AGENT_RULES_PER_SNAPSHOT + 1 }, (_, index) => ({
        id: `rule-${index}`,
        title: `${index} ${"T".repeat(MAX_AGENT_RULE_TITLE_CHARS + 20)}`,
        content: `${index} ${"C".repeat(MAX_AGENT_RULE_CONTENT_CHARS + 20)}`,
        order: index,
      })),
      snippets: [],
      transferPolicy: { mode: "never" },
    });

    expect(snapshot.rules).toHaveLength(MAX_AGENT_RULES_PER_SNAPSHOT);
    expect(snapshot.rules?.at(-1)?.id).toBe(`rule-${MAX_AGENT_RULES_PER_SNAPSHOT - 1}`);
    expect(snapshot.rules?.every((rule) => rule.title.length <= MAX_AGENT_RULE_TITLE_CHARS)).toBe(
      true,
    );
    expect(
      snapshot.rules?.every((rule) => rule.content.length <= MAX_AGENT_RULE_CONTENT_CHARS),
    ).toBe(true);
  });
});

describe("snapshotForReceptionist", () => {
  const ids = { front: "00000000-0000-4000-8000-0000000000f1", gastown: "00000000-0000-4000-8000-0000000000f2", kitsilano: "00000000-0000-4000-8000-0000000000f3", catering: "00000000-0000-4000-8000-0000000000f4" };
  const base = { displayName: "Kitsilano Coffee", timezone: "America/Vancouver", tone: "warm" };
  function receptionist(id: string, values: Partial<SnapshotReceptionist>): SnapshotReceptionist {
    return {
      id, name: "Receptionist", description: "", isDefault: false, status: "active", listed: true, order: 1, knowledgeScope: "audience",
      greeting: "Hello", ...channelInstructions(base), bookingPolicy: "Confirm availability before booking.", bookingMode: "instant", transferPolicy: { mode: "on_request" }, snippetIds: [],
      ...values,
    };
  }
  const front = receptionist(ids.front, { name: "Front desk", isDefault: true, order: 0, knowledgeScope: "all", greeting: "Thanks for calling Kitsilano Coffee.", snippetIds: ["hours", "gastown-parking", "kits-patio"] });
  const gastown = receptionist(ids.gastown, { name: "Gastown store", description: "Orders and pickup at Gastown", pageUrl: "https://demo.example/profile/kitsilano-coffee/gastown", locale: "fr", greeting: "Bonjour, Gastown!", ...channelInstructions({ ...base, chatInstructions: "Answer as the Gastown store." }), bookingPolicy: "Gastown books pickups only.", bookingMode: "request", transferPolicy: { mode: "never" }, snippetIds: ["hours", "gastown-parking", "gastown-hours"] });
  const kitsilano = receptionist(ids.kitsilano, { name: "Kitsilano store", status: "paused", order: 2 });
  const catering = receptionist(ids.catering, { name: "Catering", listed: false, order: 3, snippetIds: ["hours"] });
  const documents = [
    { title: "Menu", sourceUrl: "https://kitsilanocoffee.ca/menu", tags: [], revision: 3 },
    { title: "Gastown store", sourceUrl: "https://kitsilanocoffee.ca/stores/gastown", tags: [], revision: 1, audience: "chosen" as const, receptionistIds: [ids.gastown] },
    { title: "Kitsilano store", sourceUrl: "https://kitsilanocoffee.ca/stores/kitsilano", tags: [], revision: 1, audience: "chosen" as const, receptionistIds: [ids.kitsilano] },
    { title: "Old store", sourceUrl: "https://kitsilanocoffee.ca/stores/old", tags: [], revision: 1, audience: "chosen" as const, receptionistIds: [] },
  ];
  function stored(receptionists = [front, gastown, kitsilano, catering]) {
    return buildBusinessContextSnapshot({
      businessId: "00000000-0000-4000-8000-0000000000b1", version: "v1", generatedAt: "2026-11-03T12:00:00.000Z", ...base, defaultLocale: "en", businessType: "other",
      greeting: front.greeting, bookingPolicy: front.bookingPolicy, summary: "Coffee and pastries in Vancouver.",
      hours: [], closures: [], services: [], transferPolicy: front.transferPolicy, bookingMode: "instant", recordingNotice: false,
      snippets: [
        { id: "hours", title: "Hours", content: "Every day 7 to 7.", tags: [], priority: 5 },
        { id: "gastown-parking", title: "Gastown parking", content: "Behind the store.", tags: [], priority: 3 },
        { id: "kits-patio", title: "Kitsilano patio", content: "Open in summer.", tags: [], priority: 1 },
      ],
      extraSnippets: [{ id: "gastown-hours", title: "Gastown hours", content: "Gastown closes at 5.", tags: [], priority: 0 }],
      knowledgeDigest: knowledgeDigestOf(documents),
      knowledgeDocuments: documents,
      receptionists,
      publicPageUrl: "https://demo.example/profile/kitsilano-coffee",
    });
  }

  it("cuts the default receptionist's view from the stored fields, naming the other listed receptionists that answer", () => {
    const view = snapshotForReceptionist(stored(), null);
    expect(view).toMatchObject({ greeting: "Thanks for calling Kitsilano Coffee.", bookingMode: "instant", defaultLocale: "en", summary: "Coffee and pastries in Vancouver.", recordingNotice: false, publicPageUrl: "https://demo.example/profile/kitsilano-coffee" });
    expect(view.receptionist).toEqual({ id: ids.front, name: "Front desk", description: "", isDefault: true });
    expect(view.knowledgeSnippets?.map((entry) => entry.id)).toEqual(["hours", "gastown-parking", "kits-patio"]);
    // A paused receptionist doesn't answer, and an unlisted one isn't named.
    expect(view.otherReceptionists).toEqual([{ name: "Gastown store", description: "Orders and pickup at Gastown", pageUrl: "https://demo.example/profile/kitsilano-coffee/gastown" }]);
    expect(view.knowledgeDigest.split("\n").map((line) => JSON.parse(line).title)).toEqual(["Menu", "Gastown store", "Kitsilano store", "Old store"]);
    expect(view).not.toHaveProperty("moreReceptionists");
  });

  it("leaves nothing about other receptionists in a view: their settings, entries and the documents' audiences stay in the stored snapshot", () => {
    const view = snapshotForReceptionist(stored(), ids.gastown);
    expect(view).not.toHaveProperty("receptionists");
    expect(view).not.toHaveProperty("extraKnowledgeSnippets");
    expect(view).not.toHaveProperty("knowledgeDocuments");
    expect(JSON.stringify(view)).not.toContain(ids.kitsilano);
    expect(JSON.stringify(view)).not.toContain("Kitsilano patio");
  });

  it("gives another receptionist its own settings and language, its entries and only the documents it may use", () => {
    const view = snapshotForReceptionist(stored(), ids.gastown);
    expect(view).toMatchObject({ greeting: "Bonjour, Gastown!", chatInstructions: "Answer as the Gastown store.", bookingPolicy: "Gastown books pickups only.", bookingMode: "request", transferPolicy: { mode: "never" }, defaultLocale: "fr" });
    // The settings every receptionist shares come with it.
    expect(view).toMatchObject({ summary: "Coffee and pastries in Vancouver.", recordingNotice: false, timezone: "America/Vancouver" });
    expect(view.receptionist).toEqual({ id: ids.gastown, name: "Gastown store", description: "Orders and pickup at Gastown", isDefault: false });
    expect(view.knowledgeSnippets?.map((entry) => entry.id)).toEqual(["hours", "gastown-parking", "gastown-hours"]);
    expect(view.knowledgeDigest.split("\n").map((line) => JSON.parse(line).title)).toEqual(["Menu", "Gastown store"]);
    expect(view.otherReceptionists).toEqual([{ name: "Front desk", description: "" }]);
  });

  it("answers as the default receptionist for a paused, unknown or missing one", () => {
    const snapshot = stored();
    const frontView = snapshotForReceptionist(snapshot);
    for (const id of [ids.kitsilano, "00000000-0000-4000-8000-00000000dead", undefined, null]) {
      expect(snapshotForReceptionist(snapshot, id)).toEqual(frontView);
    }
  });

  it("leaves documents chosen only for archived receptionists to a default receptionist limited to its audience", () => {
    const view = snapshotForReceptionist(stored([{ ...front, knowledgeScope: "audience" }, gastown]), ids.front);
    expect(view.knowledgeDigest.split("\n").map((line) => JSON.parse(line).title)).toEqual(["Menu", "Old store"]);
  });

  it("names at most 12 other listed receptionists, in order, and counts the rest", () => {
    const stores = Array.from({ length: 14 }, (_, index) => receptionist(`00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`, { name: `Store ${index + 1}`, order: index + 1 }));
    const view = snapshotForReceptionist(stored([front, ...stores]), stores[0]!.id);
    expect(view.otherReceptionists?.map((entry) => entry.name)).toEqual(["Front desk", ...stores.slice(1, 12).map((entry) => entry.name)]);
    expect(view.moreReceptionists).toBe(2);
  });

  it("returns a snapshot from before receptionists as the default's view it already is", () => {
    const old = buildBusinessContextSnapshot({
      businessId: "00000000-0000-4000-8000-0000000000b1", version: "v0", generatedAt: "2026-10-01T12:00:00.000Z", ...base, defaultLocale: "en", businessType: "other",
      greeting: "Hi", bookingPolicy: "Book.", summary: "", hours: [], closures: [], services: [], transferPolicy: { mode: "never" },
      snippets: [{ id: "hours", title: "Hours", content: "7 to 7", tags: [], priority: 1 }],
    });
    expect(snapshotForReceptionist(old, ids.gastown)).toEqual(old);
  });
});
