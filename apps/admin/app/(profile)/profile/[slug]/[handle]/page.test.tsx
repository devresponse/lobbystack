import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicBusinessProfile, PublicProfileAccess, PublicProfileLookup, PublicProfileReceptionist } from "@lobbystack/domain";

import { verifyReceptionistPageToken } from "@/lib/widget-keys";

const mocks = vi.hoisted(() => ({
  requestHeaders: new Headers(),
  getPublicProfilePage: vi.fn(),
  getSession: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));

vi.mock("next/headers", () => ({ headers: async () => mocks.requestHeaders }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@lobbystack/domain", () => ({ getPublicProfilePage: mocks.getPublicProfilePage }));
vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({ db: {} }) }));
vi.mock("@/lib/branding", () => ({ loadBranding: async () => ({ appName: "AlloPlace", logoUrl: "/brand/alloplace/logo.svg" }) }));
vi.mock("next/script", async () => {
  const { createElement } = await import("react");
  return { default: ({ strategy, ...props }: Record<string, unknown>) => createElement("script", { ...props, "data-strategy": strategy }) };
});

import ReceptionistProfileRoute, { generateMetadata } from "./page";

const NOW = new Date("2026-10-14T14:00:00Z");
const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const WIDGET_KEY_ID = "22222222-2222-4222-8222-222222222222";
const KITSILANO_ID = "44444444-4444-4444-8444-444444444444";

const FRONT_DESK: PublicProfileReceptionist = { name: "Front desk", description: "Bookings and general questions", handle: null, isDefault: true };
const KITSILANO: PublicProfileReceptionist = { name: "Kitsilano clinic", description: "Our clinic on West 4th", handle: "kitsilano", isDefault: false };
const BILLING: PublicProfileReceptionist = { name: "Billing", description: "Invoices and insurance claims", handle: "billing", isDefault: false };

function profile(overrides: Partial<PublicBusinessProfile> = {}): PublicBusinessProfile {
  return {
    slug: "acme-dental",
    published: true,
    name: "Acme Dental",
    category: "Dentist",
    description: "Family dentistry near the waterfront.",
    timezone: "America/Toronto",
    defaultLocale: "en",
    address: { line1: "123 Main St", line2: null, city: "Toronto", region: "ON", postalCode: "M5V 2T6", countryCode: "CA" },
    showMap: true,
    phone: "+16045550188",
    email: null,
    websiteUrl: null,
    hours: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, openMinutes: 540, closeMinutes: 1020 })),
    closures: [],
    services: [{ name: "Check-up", durationMinutes: 30, description: null }],
    bookingMode: "instant",
    personRequests: "never",
    widgetKey: "pk_live_acme",
    nextOpening: null,
    receptionist: KITSILANO,
    receptionists: [FRONT_DESK, KITSILANO],
    ...overrides,
  };
}

function page(overrides: Partial<PublicBusinessProfile> = {}, access: Partial<PublicProfileAccess> = {}): PublicProfileLookup {
  return { kind: "page", profile: profile(overrides), access: { businessId: BUSINESS_ID, widgetKeyId: WIDGET_KEY_ID, receptionistId: KITSILANO_ID, listed: true, ...access } };
}

const params = (handle = "kitsilano", slug = "acme-dental") => ({ params: Promise.resolve({ slug, handle }) });

async function render(handle = "kitsilano"): Promise<string> {
  return renderToStaticMarkup(await ReceptionistProfileRoute(params(handle)) as ReactElement);
}

function pageToken(html: string): string | null {
  return /data-receptionist-token="([^"]+)"/.exec(html)?.[1] ?? null;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
  vi.stubEnv("NEXT_PUBLIC_BRAND_BASE_URL", "https://demo.alloplace.com");
  vi.stubEnv("GOOGLE_MAPS_EMBED_API_KEY", "");
  mocks.requestHeaders = new Headers({ "x-lobbystack-locale": "en", "x-lobbystack-locale-source": "header" });
  mocks.getSession.mockResolvedValue(null);
  mocks.getPublicProfilePage.mockImplementation(async (_context, input: { previewUserId?: string }) => (input.previewUserId ? null : page()));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("a receptionist's page", () => {
  it("is the business page answered by the receptionist", async () => {
    const html = await render();
    expect(mocks.getPublicProfilePage).toHaveBeenCalledWith(expect.anything(), { slug: "acme-dental", handle: "kitsilano", now: NOW });
    expect(html).toContain(">Acme Dental</h1>");
    expect(html).toContain('<section id="profile-chat" aria-label="Chat with Kitsilano clinic"');
    expect(html).toContain("(604) 555-0188");
  });

  it("signs its chat's token for the receptionist and the page's widget", async () => {
    const token = pageToken(await render());
    expect(verifyReceptionistPageToken(token!)).toMatchObject({ businessId: BUSINESS_ID, widgetKeyId: WIDGET_KEY_ID, receptionistId: KITSILANO_ID });
  });

  it("says who answers in the dropdown and links back to the business page", async () => {
    const html = await render();
    expect(html).toContain("You&#x27;re talking to");
    expect(html).toContain('<a href="/profile/acme-dental/kitsilano" aria-current="page"');
    expect(html).toContain('<a href="/profile/acme-dental"');
    expect(html).toContain('aria-label="Talking now"');
  });

  it("names the receptionist on the call card when the page shows no chat", async () => {
    mocks.getPublicProfilePage.mockResolvedValue(page({ widgetKey: null }, { widgetKeyId: null }));
    const html = await render();
    expect(html).toContain("Call Kitsilano clinic");
    expect(html).not.toContain("/embed.js");
  });

  it("leaves the search engines' business summary to the business page", async () => {
    expect(await render()).not.toContain("application/ld+json");
  });

  it("lists an unlisted receptionist after the default on its own page, so the visitor sees who answers", async () => {
    mocks.getPublicProfilePage.mockResolvedValue(page({ receptionist: BILLING, receptionists: [FRONT_DESK, KITSILANO] }, { listed: false }));
    const html = await render("billing");
    const links = [...html.matchAll(/<a href="(\/profile\/[^"]*)"/g)].map((match) => match[1]);
    expect(links).toEqual(["/profile/acme-dental", "/profile/acme-dental/billing", "/profile/acme-dental/kitsilano"]);
    expect(html).toContain('<a href="/profile/acme-dental/billing" aria-current="page"');
  });
});

describe("a page the receptionist doesn't have", () => {
  it("sends a paused, archived or default receptionist's visitors to the business page", async () => {
    mocks.getPublicProfilePage.mockResolvedValue({ kind: "businessPage", slug: "acme-dental" });
    await expect(render("gastown")).rejects.toThrow("NEXT_REDIRECT /profile/acme-dental");
    expect(mocks.redirect).toHaveBeenCalledWith("/profile/acme-dental");
  });

  it("doesn't exist for an unknown handle", async () => {
    mocks.getPublicProfilePage.mockResolvedValue(null);
    await expect(render("nobody")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("never looks up what can't be a handle", async () => {
    for (const handle of ["two words", "-kitsilano", "a".repeat(61), "kits_ilano"]) {
      await expect(render(handle)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(mocks.getPublicProfilePage).not.toHaveBeenCalled();
  });

  it("reads a handle written in capitals as the same page", async () => {
    await render("Kitsilano");
    expect(mocks.getPublicProfilePage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ handle: "Kitsilano" }));
  });

  it("shows a member the preview of a page that isn't published", async () => {
    mocks.getPublicProfilePage.mockImplementation(async (_context, input: { previewUserId?: string }) => (input.previewUserId === "member" ? page({ published: false }) : null));
    mocks.getSession.mockResolvedValue({ user: { id: "member" }, session: { id: "s", userId: "member", expiresAt: NOW } });
    const html = await render();
    expect(mocks.getPublicProfilePage).toHaveBeenLastCalledWith(expect.anything(), { slug: "acme-dental", handle: "kitsilano", previewUserId: "member", now: NOW });
    expect(html).toContain("This page isn&#x27;t published. Only your team can see it.");
    expect(pageToken(html)).toBeNull();
  });
});

describe("metadata", () => {
  it("titles the page with the receptionist, describes what it helps with and points to its own address", async () => {
    expect(await generateMetadata(params())).toMatchObject({
      title: "Kitsilano clinic · Acme Dental · Dentist in Toronto",
      description: "Our clinic on West 4th",
      alternates: { canonical: "https://app.example.com/profile/acme-dental/kitsilano?lng=en" },
      robots: { index: true, follow: true },
      openGraph: { url: "https://app.example.com/profile/acme-dental/kitsilano" },
    });
  });

  it("keeps the receptionist's stored handle in its address", async () => {
    expect(await generateMetadata(params("KITSILANO"))).toMatchObject({ alternates: { canonical: "https://app.example.com/profile/acme-dental/kitsilano?lng=en" } });
  });

  it("describes the business when the receptionist says nothing about what it helps with", async () => {
    mocks.getPublicProfilePage.mockResolvedValue(page({ receptionist: { ...KITSILANO, description: "  " } }));
    expect(await generateMetadata(params())).toMatchObject({ description: "Family dentistry near the waterfront." });
  });

  it("keeps an unlisted receptionist's page out of search results", async () => {
    mocks.getPublicProfilePage.mockResolvedValue(page({ receptionist: BILLING }, { listed: false }));
    expect(await generateMetadata(params("billing"))).toMatchObject({ title: "Billing · Acme Dental · Dentist in Toronto", robots: { index: false, follow: false } });
  });

  it("keeps a page that sends visitors elsewhere, or doesn't exist, out of search results", async () => {
    mocks.getPublicProfilePage.mockResolvedValue({ kind: "businessPage", slug: "acme-dental" });
    expect(await generateMetadata(params("gastown"))).toMatchObject({ robots: { index: false } });
    mocks.getPublicProfilePage.mockResolvedValue(null);
    expect(await generateMetadata(params("nobody"))).toMatchObject({ title: "This page doesn't exist", robots: { index: false } });
  });
});
