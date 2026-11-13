// @vitest-environment jsdom
import { brandFileMatched, resolveBrand, resolveBranding } from "@lobbystack/shared";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrandingProvider } from "@/components/branding-provider";
import { createI18nInstance } from "@/i18n";
import { DEFAULT_BRANDING_SNAPSHOT, brandLogoSrc, type BrandingSnapshot } from "@/lib/branding-snapshot";
import { helpWords } from "@/lib/help/registry";

import brandIndex from "../../../../../brands/index.json";
import { HelpPageShell } from "./help-page-shell";

const LOBBYSTACK_MARK = brandLogoSrc(DEFAULT_BRANDING_SNAPSHOT)!;
// Each brand besides the default, with an address its brand file claims.
const brands = [...new Map(Object.entries(brandIndex.domains).filter(([, id]) => id !== brandIndex.default).map(([domain, id]) => [id, domain])).entries()];

/** What a help page is built with for a deployment, as buildTimeBrandingSnapshot reads its build environment. */
function builtFor(input: { appBaseUrl?: string; preset?: string }): BrandingSnapshot {
  const brand = resolveBrand(input);
  const branding = resolveBranding({ saved: null, brand });
  return { appName: branding.appName, logoUrl: branding.logoUrl, final: brandFileMatched(brand) };
}

function renderShell(initial: BrandingSnapshot) {
  const i18n = createI18nInstance({ locale: "en", appName: initial.appName, resources: {} });
  return render(
    <I18nextProvider i18n={i18n}>
      <BrandingProvider i18n={i18n} initial={initial}>
        <HelpPageShell locale="en" words={helpWords("en")}><p>Help text</p></HelpPageShell>
      </BrandingProvider>
    </I18nextProvider>,
  );
}

/** The header's link home, by the name it carries. */
function homeLink(name: string): HTMLElement {
  const link = within(screen.getByRole("banner")).getByRole("link", { name });
  expect(link.getAttribute("href")).toBe("/");
  return link;
}

function lobbyStackShown(): boolean {
  const header = screen.getByRole("banner");
  return [...header.querySelectorAll("img")].some((image) => image.getAttribute("src") === LOBBYSTACK_MARK) || (header.textContent ?? "").includes(DEFAULT_BRANDING_SNAPSHOT.appName);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HelpPageShell", () => {
  it("has brands to check", () => {
    expect(brands.length).toBeGreaterThan(0);
  });

  it.each(brands)("shows the %s brand file's logo and name, never LobbyStack's", (id, domain) => {
    for (const input of [{ appBaseUrl: `https://app.${domain}` }, { preset: id }]) {
      const built = builtFor(input);
      expect(built.final).toBe(true);
      expect(built.logoUrl).toMatch(new RegExp(`^/brand/${id}/`));
      renderShell(built);

      const logo = homeLink(built.appName).querySelector("img");
      expect(logo?.getAttribute("src")).toBe(built.logoUrl);
      expect(lobbyStackShown()).toBe(false);
      cleanup();
    }
  });

  it("waits for the name and logo a deployment without a brand file saved, never showing LobbyStack's first", async () => {
    let answer: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    // What a build with no brand file knows: LobbyStack's name, to be checked with the server.
    renderShell({ ...DEFAULT_BRANDING_SNAPSHOT, final: false });

    // Until the server answers, the header names no one and has no link home.
    expect(within(screen.getByRole("banner")).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/en/help"]);
    expect(lobbyStackShown()).toBe(false);

    await act(async () => answer!(Response.json({ appName: "Acme Desk", logoUrl: "/api/branding/logo?v=abc" })));
    expect((await within(screen.getByRole("banner")).findByRole("link", { name: "Acme Desk" })).querySelector("img")?.getAttribute("src")).toBe("/api/branding/logo?v=abc");
    expect(lobbyStackShown()).toBe(false);
  });

  it("shows LobbyStack's logo only on a deployment that has no brand of its own", () => {
    renderShell(builtFor({ preset: brandIndex.default }));
    expect(homeLink(DEFAULT_BRANDING_SNAPSHOT.appName).querySelector("img")?.getAttribute("src")).toBe(LOBBYSTACK_MARK);
  });
});
