import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicBusinessProfile } from "@lobbystack/domain";

const mocks = vi.hoisted(() => ({
  requestHeaders: new Headers(),
  getPublicBusinessProfile: vi.fn(),
  getSession: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/headers", () => ({ headers: async () => mocks.requestHeaders }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@lobbystack/domain", () => ({ getPublicBusinessProfile: mocks.getPublicBusinessProfile }));
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
    ...overrides,
  };
}

const params = (slug = "acme-dental") => ({ params: Promise.resolve({ slug }) });

async function render(slug = "acme-dental"): Promise<string> {
  return renderToStaticMarkup(await PublicProfileRoute(params(slug)) as ReactElement);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
  vi.stubEnv("BRAND_ACCENT_COLOR", "#FFD100");
  vi.stubEnv("GOOGLE_MAPS_EMBED_API_KEY", "");
  mocks.requestHeaders = new Headers({ "x-lobbystack-locale": "en", "x-lobbystack-locale-source": "header" });
  mocks.getSession.mockResolvedValue(null);
  mocks.getPublicBusinessProfile.mockImplementation(async (_context, input: { previewUserId?: string }) => (input.previewUserId ? null : profile()));
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
    expect(html).toContain('<script src="/embed.js?key=pk_live_acme" data-inline-target="#profile-chat" data-strategy="afterInteractive"></script>');
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

  it("offers a call instead of a chat when the page shows no chat", async () => {
    mocks.getPublicBusinessProfile.mockResolvedValue(profile({ widgetKey: null }));
    const html = await render();
    expect(html).not.toContain("profile-chat");
    expect(html).not.toContain("/embed.js");
    expect(html).toContain("Call Acme Dental");
    expect(html).toContain("Book it by phone.");
  });

  it("drops what the business hides", async () => {
    mocks.getPublicBusinessProfile.mockResolvedValue(profile({ widgetKey: null, phone: null, hours: null, services: null, address: null, email: null, websiteUrl: null, nextOpening: null }));
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
    mocks.getPublicBusinessProfile.mockImplementation(async (_context, input: { previewUserId?: string }) => (input.previewUserId === "member" ? profile({ published: false }) : null));
  });

  it("doesn't exist for visitors", async () => {
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getPublicBusinessProfile).toHaveBeenCalledTimes(1);
  });

  it("doesn't exist when the session can't be read", async () => {
    mocks.getSession.mockRejectedValue(new Error("database unavailable"));
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows a member a preview without the chat or the search summary", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "member" }, session: { id: "s", userId: "member", expiresAt: NOW } });
    const html = await render();
    expect(mocks.getPublicBusinessProfile).toHaveBeenLastCalledWith(expect.anything(), { slug: "acme-dental", previewUserId: "member", now: NOW });
    expect(html).toContain("This page isn&#x27;t published. Only your team can see it.");
    expect(html).toContain('href="/settings/profile"');
    expect(html).toContain("The chat shows here once the page is published.");
    expect(html).not.toContain("/embed.js");
    expect(html).not.toContain("application/ld+json");
  });
});

it("never looks up a slug longer than any business's", async () => {
  await expect(render("a".repeat(121))).rejects.toThrow("NEXT_NOT_FOUND");
  expect(mocks.getPublicBusinessProfile).not.toHaveBeenCalled();
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
    mocks.getPublicBusinessProfile.mockImplementation(async (_context, input: { previewUserId?: string }) => (input.previewUserId === "member" ? profile({ published: false }) : null));
    expect(await generateMetadata(params())).toMatchObject({ title: "This page doesn't exist", robots: { index: false } });
    mocks.getSession.mockResolvedValue({ user: { id: "member" }, session: { id: "s", userId: "member", expiresAt: NOW } });
    expect(await generateMetadata(params())).toMatchObject({ title: "Acme Dental · Dentist in Toronto", robots: { index: false } });
  });
});
