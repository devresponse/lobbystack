import { describe, expect, it } from "vitest";

import { pageNumber, personRequestsFor, toPublicBusinessProfile, type PublicProfileReceptionistRow, type PublicProfileRows } from "./publicProfiles";

const now = new Date("2026-10-14T17:00:00Z");

const receptionistRow = (overrides: Partial<PublicProfileReceptionistRow> & Pick<PublicProfileReceptionistRow, "id" | "name">): PublicProfileReceptionistRow => ({
  description: "", handle: null, isDefault: false, status: "active", listed: true, bookingMode: "instant", transferMode: "on_request", transferNumber: "+16045550199", ...overrides,
});
const frontDesk = receptionistRow({ id: "r-front", name: "Front desk", description: "Everything about the clinic.", handle: "front-desk", isDefault: true });
const kitsilano = receptionistRow({ id: "r-kits", name: "Kitsilano", description: "The Kitsilano office.", handle: "kitsilano" });
const billing = receptionistRow({ id: "r-billing", name: "Billing", description: "Invoices and insurance.", handle: "billing", listed: false });
const downtown = receptionistRow({ id: "r-down", name: "Downtown", description: "The downtown office.", handle: "downtown", status: "paused" });

function rows(overrides: Partial<PublicProfileRows> = {}, profile: Partial<PublicProfileRows["profile"]> = {}): PublicProfileRows {
  return {
    business: { slug: "acme-dental", name: "Acme Dental", timezone: "America/Vancouver", defaultLocale: "en", websiteUrl: "https://acmedental.example" },
    profile: {
      businessId: "b1", published: true, publishedAt: now, category: "Dental clinic", description: "Family dental clinic.",
      addressLine1: "418 Larkspur Street", addressLine2: null, city: "Vancouver", region: "BC", postalCode: "V5T 1A1", countryCode: "CA",
      publicEmail: "hello@acmedental.example", showPhone: true, showHours: true, showServices: true, showMap: true, widgetKeyId: "k1",
      createdAt: now, updatedAt: now, ...profile,
    },
    receptionist: { bookingMode: "instant", transferMode: "on_request", transferNumber: "+16045550199" },
    receptionists: [frontDesk],
    pageReceptionistId: null,
    hours: [{ dayOfWeek: 3, openMinutes: 480, closeMinutes: 1020 }],
    closures: [
      { startsAt: new Date("2026-11-11T08:00:00Z"), endsAt: new Date("2026-11-12T08:00:00Z"), reason: "Remembrance Day" },
      { startsAt: new Date("2026-10-01T07:00:00Z"), endsAt: new Date("2026-10-02T07:00:00Z"), reason: "Past" },
      { startsAt: new Date("2026-12-24T08:00:00Z"), endsAt: new Date("2026-12-27T08:00:00Z"), reason: "Holidays" },
    ],
    services: [{ id: "s1", name: "Check-up and cleaning", localizedNames: { fr: "Examen et nettoyage", es: "ignored" }, description: "Exam and a cleaning. ", durationMinutes: 60 }],
    phone: "+16045550142",
    widgetKey: { keyValue: "wk_live_abc", status: "active" },
    ...overrides,
  };
}

describe("the public profile's shape", () => {
  // Every field the page gets. A new one must be something an owner can see,
  // and switch off where it's sensitive, in Settings: add it here only then.
  it("has a fixed set of fields", () => {
    expect(Object.keys(toPublicBusinessProfile(rows(), { now })).sort()).toEqual([
      "address", "bookingMode", "category", "closures", "defaultLocale", "description", "email", "hours", "name", "nextOpening",
      "personRequests", "phone", "published", "receptionist", "receptionists", "services", "showMap", "slug", "timezone", "websiteUrl", "widgetKey",
    ]);
  });

  it("carries the business's details and upcoming closures only", () => {
    const profile = toPublicBusinessProfile(rows(), { now, nextOpening: { startsAt: "2026-10-15T15:00:00.000Z", serviceName: "Check-up and cleaning" } });
    expect(profile).toMatchObject({
      slug: "acme-dental",
      name: "Acme Dental",
      address: { line1: "418 Larkspur Street", city: "Vancouver", countryCode: "CA" },
      phone: "+16045550142",
      email: "hello@acmedental.example",
      websiteUrl: "https://acmedental.example/",
      services: [{ name: "Check-up and cleaning", localizedNames: { fr: "Examen et nettoyage" }, durationMinutes: 60, description: "Exam and a cleaning." }],
      bookingMode: "instant",
      personRequests: "any_time",
      widgetKey: "wk_live_abc",
      nextOpening: { startsAt: "2026-10-15T15:00:00.000Z", serviceName: "Check-up and cleaning" },
    });
    expect(profile.closures).toEqual([{ startsAt: "2026-11-11T08:00:00.000Z", endsAt: "2026-11-12T08:00:00.000Z", reason: "Remembrance Day" }]);
  });

  it("suggests the page in the business's language when the page has it, else in English", () => {
    const language = (defaultLocale: string) => toPublicBusinessProfile(rows({ business: { ...rows().business, defaultLocale } }), { now }).defaultLocale;
    expect(language("fr")).toBe("fr");
    expect(language("es")).toBe("es");
    expect(language("de")).toBe("en");
  });

  it("leaves out the sections the owner switched off", () => {
    const profile = toPublicBusinessProfile(rows({}, { showPhone: false, showHours: false, showServices: false, showMap: false }), { now });
    expect(profile).toMatchObject({ phone: null, hours: null, closures: null, services: null, showMap: false });
  });

  it("shows the widget only for an active key it can build a snippet for", () => {
    expect(toPublicBusinessProfile(rows({ widgetKey: { keyValue: "wk_live_abc", status: "disabled" } }), { now }).widgetKey).toBeNull();
    expect(toPublicBusinessProfile(rows({ widgetKey: { keyValue: null, status: "active" } }), { now }).widgetKey).toBeNull();
    expect(toPublicBusinessProfile(rows({ widgetKey: null }), { now }).widgetKey).toBeNull();
  });

  it("has no address without one, and no link for a website that isn't http", () => {
    const profile = toPublicBusinessProfile(rows({ business: { ...rows().business, websiteUrl: "javascript:alert(1)" } }, { addressLine1: null, city: null, region: null, postalCode: null, countryCode: null }), { now });
    expect(profile.address).toBeNull();
    expect(profile.websiteUrl).toBeNull();
  });

  it("says when callers can ask for a person, without the number they'd reach", () => {
    expect(personRequestsFor("on_request", "+16045550199")).toBe("any_time");
    expect(personRequestsFor("always", "+16045550199")).toBe("any_time");
    expect(personRequestsFor("during_business_hours", "+16045550199")).toBe("business_hours");
    expect(personRequestsFor("on_urgent", "+16045550199")).toBe("never");
    expect(personRequestsFor("on_request", null)).toBe("never");
    expect(JSON.stringify(toPublicBusinessProfile(rows(), { now }))).not.toContain("6045550199");
  });
});

describe("a page's receptionists", () => {
  const several = { receptionists: [frontDesk, kitsilano, billing, downtown] };

  it("names the default receptionist on the business page, without a handle of its own", () => {
    const profile = toPublicBusinessProfile(rows(several), { now });
    expect(profile.receptionist).toEqual({ name: "Front desk", description: "Everything about the clinic.", handle: null, isDefault: true });
  });

  it("offers the default receptionist first, then the listed, active ones: never an unlisted or paused one", () => {
    const profile = toPublicBusinessProfile(rows({ receptionists: [kitsilano, billing, downtown, frontDesk] }), { now });
    expect(profile.receptionists.map((entry) => entry.name)).toEqual(["Front desk", "Kitsilano"]);
    expect(profile.receptionists[1]).toEqual({ name: "Kitsilano", description: "The Kitsilano office.", handle: "kitsilano", isDefault: false });
  });

  it("names the page's own receptionist on its page, listed or not", () => {
    expect(toPublicBusinessProfile(rows({ ...several, pageReceptionistId: "r-kits" }), { now }).receptionist).toMatchObject({ name: "Kitsilano", handle: "kitsilano" });
    const unlisted = toPublicBusinessProfile(rows({ ...several, pageReceptionistId: "r-billing" }), { now });
    expect(unlisted.receptionist).toMatchObject({ name: "Billing", handle: "billing" });
    expect(unlisted.receptionists.map((entry) => entry.name)).toEqual(["Front desk", "Kitsilano"]);
  });

  it("names nobody for a business without a default receptionist yet", () => {
    const profile = toPublicBusinessProfile(rows({ receptionists: [] }), { now });
    expect(profile.receptionist).toBeNull();
    expect(profile.receptionists).toEqual([]);
  });

  it("shows the number that rings the page's receptionist, else the business's newest", () => {
    const numbers = [{ e164: "+16045550101", receptionistId: "r-front" }, { e164: "+16045550102", receptionistId: "r-kits" }, { e164: "+16045550103", receptionistId: "r-down" }];
    expect(pageNumber(numbers, several.receptionists, null)).toBe("+16045550101");
    expect(pageNumber(numbers, several.receptionists, "r-kits")).toBe("+16045550102");
    // Billing has no number of its own; the business's newest still reaches someone.
    expect(pageNumber(numbers, several.receptionists, "r-billing")).toBe("+16045550101");
    // A paused receptionist's number rings the default one, so it is the business page's number too.
    expect(pageNumber([numbers[2]!, numbers[0]!], several.receptionists, null)).toBe("+16045550103");
    // A number that names no receptionist rings the default one.
    expect(pageNumber([{ e164: "+16045550104", receptionistId: null }], several.receptionists, null)).toBe("+16045550104");
    expect(pageNumber([], several.receptionists, "r-kits")).toBeNull();
  });
});
