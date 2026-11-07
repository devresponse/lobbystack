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
// Shows which loading strategy the page gives the widget loader.
vi.mock("next/script", async () => {
  const { createElement } = await import("react");
  return { default: ({ strategy, ...props }: Record<string, unknown>) => createElement("script", { ...props, "data-strategy": strategy }) };
});

import PublicProfileRoute, { generateMetadata } from "./page";

const NOW = new Date("2026-10-14T14:00:00Z");
const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const WIDGET_KEY_ID = "22222222-2222-4222-8222-222222222222";
const FRONT_DESK_ID = "33333333-3333-4333-8333-333333333333";

const FRONT_DESK: PublicProfileReceptionist = { name: "Front desk", description: "Bookings and general questions", handle: null, isDefault: true };
const KITSILANO: PublicProfileReceptionist = { name: "Kitsilano clinic", description: "Our clinic on West 4th", handle: "kitsilano", isDefault: false };

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
    phone: "+14165550123",
    email: "hello@acmedental.example",
    websiteUrl: "https://www.acmedental.example",
    hours: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, openMinutes: 540, closeMinutes: 1020 })),
    closures: [],
    services: [{ name: "Check-up", durationMinutes: 30, description: "A cleaning and an exam." }],
    bookingMode: "instant",
    personRequests: "any_time",
    widgetKey: "pk_live_acme",
    nextOpening: { startsAt: "2026-10-15T13:00:00Z", serviceName: "Check-up" },
    receptionist: FRONT_DESK,
    receptionists: [FRONT_DESK],
    ...overrides,
  };
}

function page(overrides: Partial<PublicBusinessProfile> = {}, access: Partial<PublicProfileAccess> = {}): PublicProfileLookup {
  return { kind: "page", profile: profile(overrides), access: { businessId: BUSINESS_ID, widgetKeyId: WIDGET_KEY_ID, receptionistId: FRONT_DESK_ID, listed: true, ...access } };
}

/** The receptionist token the page gave its chat's loader, or null without one. */
function pageToken(html: string): string | null {
  return /data-receptionist-token="([^"]+)"/.exec(html)?.[1] ?? null;
}

const params = (slug = "acme-dental") => ({ params: Promise.resolve({ slug }) });

async function render(slug = "acme-dental"): Promise<string> {
  return renderToStaticMarkup(await PublicProfileRoute(params(slug)) as ReactElement);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
  // The build's address picks the AlloPlace brand, whose accent is yellow.
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

describe("a published page", () => {
  it("shows the business with its chat on the deployment's accent", async () => {
    const html = await render();
    expect(html).toContain('<h1 id="profile-name"');
    expect(html).toContain(">Acme Dental</h1>");
    expect(html).toContain("<strong class=\"font-bold\">Open now</strong>");
    expect(html).toContain("--accent:#ffd100;--on-accent:#000000");
    expect(html).toContain('<section id="profile-chat" aria-label="Chat with Acme Dental"');
    // The loader changes the page, so it waits until React has hydrated it.
    expect(html).toMatch(/<script src="\/embed\.js\?key=pk_live_acme" data-inline-target="#profile-chat" data-receptionist-token="[^"]+" data-strategy="afterInteractive"><\/script>/);
    expect(html).toContain("Tomorrow, 9:00");
    expect(html).toContain("Check-up. Book it in the chat or by phone.");
    expect(html).toContain('href="tel:+14165550123"');
    expect(html).toContain("(416) 555-0123");
    expect(html).toContain("acmedental.example");
    expect(html).toContain("Acme Dental&#x27;s calls and chats are answered by an AI receptionist. Ask for a person at any time.");
    expect(html).toContain("Answered by");
    expect(html).not.toContain("This page isn&#x27;t published");
    // Only the published page is summarized for search engines.
    expect(html).toContain('<script type="application/ld+json">');
  });

  it("links to the map without a Maps key and embeds it with one", async () => {
    expect(await render()).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=123%20Main%20St');
    vi.stubEnv("GOOGLE_MAPS_EMBED_API_KEY", "maps-key");
    const html = await render();
    expect(html).toContain('<iframe src="https://www.google.com/maps/embed/v1/place?key=maps-key&amp;q=123%20Main%20St');
    expect(html).toContain('title="Map of 123 Main St, Toronto, ON M5V 2T6, CA"');
  });

  it("gives the chat a token naming the default receptionist, signed for the page's widget", async () => {
    const token = pageToken(await render());
    expect(token).not.toBeNull();
    expect(verifyReceptionistPageToken(token!)).toMatchObject({ purpose: "receptionist_page", businessId: BUSINESS_ID, widgetKeyId: WIDGET_KEY_ID, receptionistId: FRONT_DESK_ID });
    expect(mocks.getPublicProfilePage).toHaveBeenCalledWith(expect.anything(), { slug: "acme-dental", handle: null, now: NOW });
  });

  it("leaves the chat to its widget for a business without a default receptionist yet", async () => {
    mocks.getPublicProfilePage.mockResolvedValue(page({ receptionist: null, receptionists: [] }, { receptionistId: null }));
    const html = await render();
    expect(html).toContain('<script src="/embed.js?key=pk_live_acme" data-inline-target="#profile-chat" data-strategy="afterInteractive"></script>');
    expect(html).not.toContain("You&#x27;re talking to");
  });

  it("shows no dropdown when the default receptionist is the only one", async () => {
    const html = await render();
    expect(html).not.toContain("You&#x27;re talking to");
    expect(html).not.toContain("aria-current");
  });

  it("lets the visitor pick another listed receptionist, each on its own page", async () => {
    mocks.getPublicProfilePage.mockResolvedValue(page({ receptionists: [FRONT_DESK, KITSILANO] }));
    const html = await render();
    expect(html).toContain("You&#x27;re talking to");
    expect(html).toContain('aria-label="Choose who to talk to"');
    expect(html).toContain('<a href="/profile/acme-dental" aria-current="page"');
    expect(html).toContain('<a href="/profile/acme-dental/kitsilano"');
    expect(html).toContain("Our clinic on West 4th");
    // The chat on the business page stays the default receptionist's.
    expect(html).toContain('aria-label="Chat with Acme Dental"');
    expect(verifyReceptionistPageToken(pageToken(html)!)?.receptionistId).toBe(FRONT_DESK_ID);
  });

  it("offers a call instead of a chat when the page shows no chat", async () => {
    mocks.getPublicProfilePage.mockResolvedValue(page({ widgetKey: null }, { widgetKeyId: null }));
    const html = await render();
    expect(html).not.toContain("profile-chat");
    expect(html).not.toContain("/embed.js");
    expect(html).toContain("Call Acme Dental");
    expect(html).toContain("Book it by phone.");
  });

  it("drops what the business hides", async () => {
    mocks.getPublicProfilePage.mockResolvedValue(page({ widgetKey: null, phone: null, hours: null, services: null, address: null, email: null, websiteUrl: null, nextOpening: null }, { widgetKeyId: null }));
    const html = await render();
    expect(html).toContain(">Acme Dental</h1>");
    for (const text of ["Open now", "Hours", "Services", "Location and contact", "tel:", "Directions", "Next opening"]) expect(html).not.toContain(text);
  });

  it("renders in the visitor's language", async () => {
    mocks.requestHeaders = new Headers({ "x-lobbystack-locale": "fr", "x-lobbystack-locale-source": "query" });
    const html = await render();
    expect(html).toContain("Ouvert");
    expect(html).toContain('hrefLang="en"');
    expect(html).toContain(">English</a>");
    expect(html).not.toContain(">Français</a>");
  });
});

describe("a page that isn't published", () => {
  beforeEach(() => {
    mocks.getPublicProfilePage.mockImplementation(async (_context, input: { previewUserId?: string }) => (input.previewUserId === "member" ? page({ published: false }) : null));
  });

  it("doesn't exist for visitors", async () => {
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getPublicProfilePage).toHaveBeenCalledTimes(1);
  });

  it("doesn't exist when the session can't be read", async () => {
    mocks.getSession.mockRejectedValue(new Error("database unavailable"));
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows a member a preview without the chat or the search summary", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "member" }, session: { id: "s", userId: "member", expiresAt: NOW } });
    const html = await render();
    expect(mocks.getPublicProfilePage).toHaveBeenLastCalledWith(expect.anything(), { slug: "acme-dental", handle: null, previewUserId: "member", now: NOW });
    expect(html).toContain("This page isn&#x27;t published. Only your team can see it.");
    expect(html).toContain('href="/settings/profile"');
    expect(html).toContain("The chat shows here once the page is published.");
    expect(html).not.toContain("/embed.js");
    expect(pageToken(html)).toBeNull();
    expect(html).not.toContain("application/ld+json");
  });
});

it("never looks up a slug longer than any business's", async () => {
  await expect(render("a".repeat(121))).rejects.toThrow("NEXT_NOT_FOUND");
  expect(mocks.getPublicProfilePage).not.toHaveBeenCalled();
});

describe("metadata", () => {
  it("titles, describes and indexes a published page", async () => {
    const metadata = await generateMetadata(params());
    expect(metadata).toMatchObject({
      title: "Acme Dental · Dentist in Toronto",
      description: "Family dentistry near the waterfront.",
      alternates: { canonical: "https://app.example.com/profile/acme-dental?lng=en" },
      robots: { index: true, follow: true },
      openGraph: { url: "https://app.example.com/profile/acme-dental", title: "Acme Dental · Dentist in Toronto" },
      twitter: { card: "summary", title: "Acme Dental · Dentist in Toronto" },
      icons: { icon: "/brand/alloplace/logo.svg" },
    });
  });

  it("keeps a preview and a missing page out of search results", async () => {
    mocks.getPublicProfilePage.mockImplementation(async (_context, input: { previewUserId?: string }) => (input.previewUserId === "member" ? page({ published: false }) : null));
    expect(await generateMetadata(params())).toMatchObject({ title: "This page doesn't exist", robots: { index: false } });
    mocks.getSession.mockResolvedValue({ user: { id: "member" }, session: { id: "s", userId: "member", expiresAt: NOW } });
    expect(await generateMetadata(params())).toMatchObject({ title: "Acme Dental · Dentist in Toronto", robots: { index: false } });
  });
});
