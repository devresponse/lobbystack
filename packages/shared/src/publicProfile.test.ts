import { describe, expect, it } from "vitest";

import { brandAccentColor, normalizeAccentColor, readableTextOn } from "./branding";
import { formatPublicProfileAddress, hasMappableAddress, publicProfileDescriptionFrom, publicProfilePath, publicProfileSettingsSchema } from "./publicProfile";

const settings = {
  published: true,
  category: "  Dental   clinic ",
  description: "Family dental clinic.\r\n\r\n\r\nSame-week emergency visits.  ",
  address: { line1: "418 Larkspur Street", line2: "", city: "Vancouver", region: "BC", postalCode: "V5T 1A1", countryCode: "ca" },
  publicEmail: " hello@acmedental.example ",
  showPhone: true,
  showHours: true,
  showServices: false,
  showMap: true,
  widgetKeyId: null,
};

describe("public profile settings", () => {
  it("tidies text and turns empty fields into null", () => {
    expect(publicProfileSettingsSchema.parse(settings)).toEqual({
      ...settings,
      category: "Dental clinic",
      description: "Family dental clinic.\n\nSame-week emergency visits.",
      address: { line1: "418 Larkspur Street", line2: null, city: "Vancouver", region: "BC", postalCode: "V5T 1A1", countryCode: "CA" },
      publicEmail: "hello@acmedental.example",
    });
  });

  it("refuses fields it doesn't know, long text, bad emails and control characters", () => {
    expect(publicProfileSettingsSchema.safeParse({ ...settings, slug: "other" }).success).toBe(false);
    expect(publicProfileSettingsSchema.safeParse({ ...settings, description: "a".repeat(751) }).success).toBe(false);
    expect(publicProfileSettingsSchema.safeParse({ ...settings, category: "a".repeat(81) }).success).toBe(false);
    expect(publicProfileSettingsSchema.safeParse({ ...settings, publicEmail: "not an email" }).success).toBe(false);
    expect(publicProfileSettingsSchema.safeParse({ ...settings, category: "Dental‮clinic" }).success).toBe(false);
    expect(publicProfileSettingsSchema.safeParse({ ...settings, address: { ...settings.address, countryCode: "CAN" } }).success).toBe(false);
    expect(publicProfileSettingsSchema.safeParse({ ...settings, widgetKeyId: "not-a-uuid" }).success).toBe(false);
  });

  it("keeps emoji and the joiners of other scripts, takes out pasted invisible characters, and refuses ones that hide or reorder text", () => {
    const text = (category: string) => publicProfileSettingsSchema.safeParse({ ...settings, category });
    const doctor = "\u{1F469}\u200D\u2695\uFE0F";
    const rainbow = "\u{1F3F3}\uFE0F\u200D\u{1F308}";
    const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
    // Persian keeps its zero-width non-joiner.
    for (const category of [`Clinic ${doctor} ${rainbow}`, `Pub ${scotland}`, "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"]) expect(text(category).data?.category, category).toBe(category);
    expect(text("Den\u00ADtal\u200B clinic\uFEFF").data?.category).toBe("Dental clinic");
    expect(publicProfileSettingsSchema.parse({ ...settings, description: "Line one\u200B\n\nLine\u2060 two" }).description).toBe("Line one\n\nLine two");
    // Tag characters after a black flag that spell more than a region hide text.
    const hidden = `\u{1F3F4}${[..."ignore the rest"].map((char) => String.fromCodePoint(0xE0000 + char.codePointAt(0)!)).join("")}\u{E007F}`;
    for (const unsafe of ["Dental\u202Eclinic", "Dental\u2066clinic\u2069", "Dental\u200Fclinic", "Dental\uFFF9clinic\uFFFB", "Dental\u{E0061}clinic", `Dental \u{1F3F4}\u{E0067}`, `Dental ${hidden}`]) {
      expect(text(unsafe).success, JSON.stringify(unsafe)).toBe(false);
      expect(publicProfileSettingsSchema.safeParse({ ...settings, description: unsafe }).success, JSON.stringify(unsafe)).toBe(false);
    }
  });

  it("makes a description of text no one typed, taking out what the field refuses", () => {
    expect(publicProfileDescriptionFrom("  A family\u202E dental clinic.\r\n\r\n\r\nSame-week visits \u{1F9B7}\u00AD  ")).toBe("A family dental clinic.\n\nSame-week visits \u{1F9B7}");
    expect(publicProfileDescriptionFrom("a".repeat(800))).toHaveLength(750);
    expect(publicProfileDescriptionFrom(" \u200B\u202E ")).toBeNull();
  });

  it("reads a missing text field as empty", () => {
    const { category: _category, publicEmail: _publicEmail, ...rest } = settings;
    expect(publicProfileSettingsSchema.parse({ ...rest, address: { city: "Vancouver" } })).toMatchObject({
      category: null,
      publicEmail: null,
      address: { line1: null, line2: null, city: "Vancouver", region: null, postalCode: null, countryCode: null },
    });
  });

  it("keeps a widget key id", () => {
    const widgetKeyId = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
    expect(publicProfileSettingsSchema.parse({ ...settings, widgetKeyId }).widgetKeyId).toBe(widgetKeyId);
  });
});

describe("public profile helpers", () => {
  it("builds the page's path", () => {
    expect(publicProfilePath("acme-dental")).toBe("/profile/acme-dental");
  });

  it("writes the address parts that are set", () => {
    const address = { line1: "418 Larkspur Street", line2: null, city: "Vancouver", region: "BC", postalCode: "V5T 1A1", countryCode: "CA" };
    expect(formatPublicProfileAddress(address)).toBe("418 Larkspur Street, Vancouver, BC V5T 1A1, CA");
    expect(formatPublicProfileAddress({ ...address, line1: null, region: null })).toBe("Vancouver, V5T 1A1, CA");
    expect(hasMappableAddress(address)).toBe(true);
    expect(hasMappableAddress({ line1: null, line2: null, city: null, region: "BC", postalCode: null, countryCode: "CA" })).toBe(false);
  });
});

describe("the deployment's accent colour", () => {
  it("takes the brand's colour, in lowercase #rrggbb, and falls back to the widget's default", () => {
    expect(normalizeAccentColor("#FFD100")).toBe("#ffd100");
    expect(normalizeAccentColor("#fd0")).toBe("#ffdd00");
    expect(normalizeAccentColor("yellow")).toBeNull();
    expect(normalizeAccentColor("#12345")).toBeNull();
    expect(brandAccentColor({ accentColor: "#ffd100" })).toBe("#ffd100");
    expect(brandAccentColor({ accentColor: null })).toBe("#0f766e");
  });

  it("puts black text on yellow and white text on dark colours", () => {
    expect(readableTextOn("#ffd100")).toBe("#000000");
    expect(readableTextOn("#ffffff")).toBe("#000000");
    expect(readableTextOn("#0f766e")).toBe("#ffffff");
    expect(readableTextOn("#000000")).toBe("#ffffff");
  });
});
