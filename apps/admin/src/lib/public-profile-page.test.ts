import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import type { PublicBusinessProfile } from "@lobbystack/domain";

import type { SupportedLocale } from "./locale";
import {
  addressLines,
  bookingHint,
  closureLines,
  formatClock,
  hoursRows,
  localBusinessJsonLd,
  mapLinks,
  nextOpeningLabel,
  phoneDisplay,
  profileAlternates,
  profileDescription,
  profileLanguages,
  profileTitle,
  publicProfileUrl,
  serviceName,
  statusLine,
  timeZoneLabel,
} from "./public-profile-page";
import { serverTranslator } from "./server-translation";

const TIMEZONE = "America/Toronto";
// Wednesday, October 14, 2026, 10:00 am in Toronto.
const WEDNESDAY_MORNING = new Date("2026-10-14T14:00:00Z");

// Intl puts a narrow no-break space before "am" and "pm".
const plain = (text: string | null | undefined) => text?.replace(/\u202f/g, " ") ?? null;

function clock(now: Date = WEDNESDAY_MORNING, locale: SupportedLocale = "en") {
  return { locale, timezone: TIMEZONE, now, t: serverTranslator(locale, "profile") };
}

function local(date: { year: number; month: number; day: number; hour?: number; minute?: number }): string {
  return DateTime.fromObject(date, { zone: TIMEZONE }).toUTC().toISO()!;
}

// Monday to Friday 9 to 5, Saturday 10 to 2.
const HOURS = [
  ...[1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, openMinutes: 540, closeMinutes: 1020 })),
  { dayOfWeek: 6, openMinutes: 600, closeMinutes: 840 },
];

const ADDRESS = { line1: "123 Main St", line2: "Suite 4", city: "Toronto", region: "ON", postalCode: "M5V 2T6", countryCode: "CA" };

function profile(overrides: Partial<PublicBusinessProfile> = {}): PublicBusinessProfile {
  return {
    slug: "acme-dental",
    published: true,
    name: "Acme Dental",
    category: "Dentist",
    description: "Family dentistry near the waterfront.",
    timezone: TIMEZONE,
    defaultLocale: "en",
    address: ADDRESS,
    showMap: true,
    phone: "+14165550123",
    email: "hello@acmedental.example",
    websiteUrl: "https://acmedental.example",
    hours: HOURS,
    closures: [],
    services: [{ name: "Check-up", durationMinutes: 30, description: null }],
    bookingMode: "instant",
    personRequests: "any_time",
    widgetKey: "pk_live_acme",
    nextOpening: null,
    ...overrides,
  };
}

describe("times", () => {
  it("writes English times the brand's way and other languages their own", () => {
    const date = new Date("2026-10-14T21:30:00Z");
    expect(plain(formatClock(date, "en", TIMEZONE))).toBe("5:30 pm");
    expect(formatClock(date, "fr", TIMEZONE)).toBe("17:30");
  });

  it("says when the business closes while it's open", () => {
    expect(statusLine(profile(), clock())).toEqual({ open: true, label: "Open now", detail: expect.stringMatching(/^Closes 5:00\s?pm$/) });
  });

  it("says when the business opens next while it's closed", () => {
    expect(plain(statusLine(profile(), clock(new Date("2026-10-14T12:00:00Z")))?.detail)).toBe("Opens 9:00 am");
    expect(plain(statusLine(profile(), clock(new Date("2026-10-14T22:00:00Z")))?.detail)).toBe("Opens tomorrow at 9:00 am");
    // Saturday afternoon: Sunday is closed, so Monday is next.
    const saturday = statusLine(profile(), clock(new Date("2026-10-17T19:00:00Z")));
    expect(saturday?.label).toBe("Closed");
    expect(plain(saturday?.detail)).toBe("Opens Monday at 9:00 am");
  });

  it("shows no status for a business without hours", () => {
    expect(statusLine(profile({ hours: null }), clock())).toBeNull();
    expect(statusLine(profile({ hours: [] }), clock())).toBeNull();
  });

  it("names the next opening's day the way people say it", () => {
    const now = clock();
    expect(plain(nextOpeningLabel("2026-10-14T15:30:00Z", now))).toBe("Today, 11:30 am");
    expect(plain(nextOpeningLabel("2026-10-15T13:00:00Z", now))).toBe("Tomorrow, 9:00 am");
    expect(plain(nextOpeningLabel("2026-10-19T13:00:00Z", now))).toBe("Monday, 9:00 am");
    expect(plain(nextOpeningLabel("2026-10-27T13:00:00Z", now))).toBe("Tuesday, October 27, 9:00 am");
    expect(nextOpeningLabel("2026-10-19T13:00:00Z", clock(WEDNESDAY_MORNING, "fr"))).toBe("Lundi, 9:00");
  });

  it("points visitors to the ways they can book", () => {
    const t = serverTranslator("en", "profile");
    expect(bookingHint({ chat: true, phone: true }, t)).toBe("Book it in the chat or by phone.");
    expect(bookingHint({ chat: true, phone: false }, t)).toBe("Book it in the chat.");
    expect(bookingHint({ chat: false, phone: true }, t)).toBe("Book it by phone.");
    expect(bookingHint({ chat: false, phone: false }, t)).toBeNull();
  });
});

describe("hours", () => {
  it("lists the week from Monday with today marked", () => {
    const rows = hoursRows([...HOURS, { dayOfWeek: 3, openMinutes: 1080, closeMinutes: 1200 }], clock());
    expect(rows.map((row) => row.day)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
    expect(rows.filter((row) => row.today).map((row) => row.day)).toEqual(["Wednesday"]);
    expect(rows[2]!.times.map(plain)).toEqual(["9:00 am – 5:00 pm", "6:00 pm – 8:00 pm"]);
    expect(rows[6]!.times).toEqual([]);
  });

  it("writes a day that runs midnight to midnight as open 24 hours", () => {
    const rows = hoursRows([{ dayOfWeek: 0, openMinutes: 0, closeMinutes: 1440 }], clock());
    expect(rows[6]!.times).toEqual(["Open 24 hours"]);
  });

  it("names the business's time zone in the page's language", () => {
    expect(timeZoneLabel(TIMEZONE, "en", WEDNESDAY_MORNING)).toBe("Eastern Time");
    expect(timeZoneLabel(TIMEZONE, "fr", WEDNESDAY_MORNING)).toMatch(/^Heure de l/);
    expect(timeZoneLabel("Nowhere/Atlantis", "en", WEDNESDAY_MORNING)).toBeNull();
  });

  it("says when each closure is, whole days or part of one", () => {
    const lines = closureLines([
      { startsAt: local({ year: 2026, month: 10, day: 16, hour: 12 }), endsAt: local({ year: 2026, month: 10, day: 16, hour: 14 }), reason: "Staff training " },
      { startsAt: local({ year: 2026, month: 10, day: 16, hour: 18 }), endsAt: local({ year: 2026, month: 10, day: 17, hour: 12 }), reason: "" },
      { startsAt: local({ year: 2026, month: 11, day: 11 }), endsAt: local({ year: 2026, month: 11, day: 12 }), reason: "Remembrance Day" },
      { startsAt: local({ year: 2026, month: 12, day: 24 }), endsAt: local({ year: 2026, month: 12, day: 27 }), reason: "Holidays" },
      { startsAt: local({ year: 2027, month: 1, day: 1 }), endsAt: local({ year: 2027, month: 1, day: 2 }), reason: "" },
    ], clock());
    expect(lines.map((line) => ({ when: plain(line.when), reason: line.reason }))).toEqual([
      { when: "Closed Friday, October 16, 12:00 pm to 2:00 pm", reason: "Staff training" },
      { when: "Closed Friday, October 16, 6:00 pm to Saturday, October 17, 12:00 pm", reason: "" },
      { when: "Closed Wednesday, November 11", reason: "Remembrance Day" },
      { when: "Closed Thursday, December 24 to Saturday, December 26", reason: "Holidays" },
      { when: "Closed Friday, January 1, 2027", reason: "" },
    ]);
  });
});

describe("details", () => {
  it("names a service in the page's language when the business gave one", () => {
    const service = { name: "Check-up", localizedNames: { fr: "Examen" } };
    expect(serviceName(service, "fr")).toBe("Examen");
    expect(serviceName(service, "en")).toBe("Check-up");
    expect(serviceName(service, "es")).toBe("Check-up");
  });

  it("writes the number as people near the business dial it", () => {
    expect(phoneDisplay("+16045550199", "CA")).toBe("(604) 555-0199");
    expect(phoneDisplay("+16045550199", "US")).toBe("(604) 555-0199");
    expect(phoneDisplay("+16045550199", "FR")).toBe("+1 604 555 0199");
    expect(phoneDisplay("+16045550199", null)).toBe("+1 604 555 0199");
    expect(phoneDisplay("+1555", "CA")).toBe("+1555");
  });

  it("writes the address on lines and links to it on Google Maps", () => {
    expect(addressLines(ADDRESS)).toEqual(["123 Main St", "Suite 4", "Toronto, ON M5V 2T6"]);
    expect(addressLines({ line1: null, line2: null, city: "Toronto", region: null, postalCode: null, countryCode: null })).toEqual(["Toronto"]);
    const links = mapLinks(ADDRESS, { locale: "sr" });
    expect(links.search).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("123 Main St, Suite 4, Toronto, ON M5V 2T6, CA")}`);
    expect(links.directions).toContain("https://www.google.com/maps/dir/?api=1&destination=123%20Main%20St");
    expect(links.embed).toBeNull();
    const embed = mapLinks(ADDRESS, { locale: "sr", embedKey: " maps-key " }).embed;
    expect(embed).toContain("https://www.google.com/maps/embed/v1/place?key=maps-key&q=123%20Main%20St");
    expect(embed).toContain("&language=sr-Latn");
  });

  it("suggests the business's language first, else English or French", () => {
    expect(profileLanguages("en", "fr")).toEqual({ suggested: "fr", others: ["fr", "es", "sr"] });
    expect(profileLanguages("fr", "fr")).toEqual({ suggested: "en", others: ["en", "es", "sr"] });
    expect(profileLanguages("en", "en")).toEqual({ suggested: "fr", others: ["fr", "es", "sr"] });
    expect(profileLanguages("es", "en").suggested).toBe("en");
  });
});

describe("search engines", () => {
  it("summarizes the business as schema.org's LocalBusiness without letting its text end the script", () => {
    const json = localBusinessJsonLd(profile({
      name: "Acme </script><script>alert(1)</script>",
      hours: [{ dayOfWeek: 0, openMinutes: 0, closeMinutes: 1440 }, { dayOfWeek: 1, openMinutes: 540, closeMinutes: 1020 }],
    }), "https://app.example.com/profile/acme-dental");
    expect(json).not.toContain("<");
    const data = JSON.parse(json);
    expect(data).toMatchObject({
      "@type": "LocalBusiness",
      name: "Acme </script><script>alert(1)</script>",
      url: "https://app.example.com/profile/acme-dental",
      telephone: "+14165550123",
      sameAs: ["https://acmedental.example"],
      address: { streetAddress: "123 Main St, Suite 4", addressLocality: "Toronto", addressRegion: "ON", postalCode: "M5V 2T6", addressCountry: "CA" },
      openingHoursSpecification: [
        { dayOfWeek: "Sunday", opens: "00:00", closes: "23:59" },
        { dayOfWeek: "Monday", opens: "09:00", closes: "17:00" },
      ],
    });
  });

  it("leaves out what the business hides", () => {
    const data = JSON.parse(localBusinessJsonLd(profile({ phone: null, email: null, websiteUrl: null, address: null, hours: null, description: null }), "https://app.example.com/profile/acme-dental"));
    expect(Object.keys(data).sort()).toEqual(["@context", "@type", "name", "url"]);
  });

  it("gives the page an address in each language and the plain one as the default", () => {
    expect(profileAlternates("https://app.example.com/profile/acme-dental", "sr")).toEqual({
      canonical: "https://app.example.com/profile/acme-dental?lng=sr",
      languages: {
        en: "https://app.example.com/profile/acme-dental?lng=en",
        fr: "https://app.example.com/profile/acme-dental?lng=fr",
        es: "https://app.example.com/profile/acme-dental?lng=es",
        "sr-Latn": "https://app.example.com/profile/acme-dental?lng=sr",
        "x-default": "https://app.example.com/profile/acme-dental",
      },
    });
  });

  it("titles the page with what the business does and where", () => {
    const t = serverTranslator("en", "profile");
    expect(profileTitle(profile(), t)).toBe("Acme Dental · Dentist in Toronto");
    expect(profileTitle(profile({ address: null }), t)).toBe("Acme Dental · Dentist");
    expect(profileTitle(profile({ category: null }), t)).toBe("Acme Dental · Toronto");
    expect(profileTitle(profile({ category: null, address: null }), t)).toBe("Acme Dental");
  });

  it("describes the page in at most 160 characters, cut at a word", () => {
    const t = serverTranslator("en", "profile");
    expect(profileDescription(profile(), t)).toBe("Family dentistry near the waterfront.");
    expect(profileDescription(profile({ description: null }), t)).toBe("Hours, services and contact details for Acme Dental.");
    const long = profileDescription(profile({ description: `${"Gentle care for the whole family, ".repeat(8)}\n\nOpen late on Thursdays.` }), t);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).toMatch(/[a-z]…$/);
    expect(long).not.toContain("\n");
  });

  it("puts the page on the deployment's address", () => {
    expect(publicProfileUrl("acme-dental", { APP_BASE_URL: "https://app.example.com/" })).toBe("https://app.example.com/profile/acme-dental");
    expect(publicProfileUrl("acme-dental", {})).toBe("http://localhost:3000/profile/acme-dental");
  });
});
