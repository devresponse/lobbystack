// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { BrandSignInPage } from "@lobbystack/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthShell, brandScopeStyle } from "./auth-shell";

const state = vi.hoisted(() => ({
  language: "en",
  branding: { appName: "Northwind Clinics", logoUrl: null as string | null, ready: true },
  page: { panel: "accent", headline: null, description: null, points: null, exampleCall: null } as BrandSignInPage,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/login" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: state.language, resolvedLanguage: state.language } }) }));
vi.mock("@/components/branding-provider", () => ({ useBranding: () => ({ ...state.branding, setBranding: () => undefined }) }));
vi.mock("@lobbystack/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@lobbystack/shared")>();
  return { ...shared, currentBrand: () => ({ ...shared.currentBrand(), signInPage: state.page }) };
});

const words = (en: string, fr: string) => ({ en, fr, es: `${en} (es)`, sr: `${en} (sr)` });
const panel = () => document.querySelector("section.auth-brand-panel") as HTMLElement;

afterEach(() => {
  cleanup();
  state.language = "en";
  state.branding = { appName: "Northwind Clinics", logoUrl: null, ready: true };
  state.page = { panel: "accent", headline: null, description: null, points: null, exampleCall: null };
});

describe("AuthShell", () => {
  it("shows the form's title beside the brand's panel, with the shared words when the brand file has none", () => {
    render(<AuthShell description="Sign in to continue." title="Welcome back"><button type="submit">Sign in</button></AuthShell>);
    expect(screen.getByRole("heading", { level: 1, name: "Welcome back" })).toBeTruthy();
    expect(screen.getByText("Sign in to continue.")).toBeTruthy();
    const brand = within(panel());
    expect(brand.getByText("panel.headline")).toBeTruthy();
    expect(brand.getByText("panel.description")).toBeTruthy();
    expect(brand.getByText("panel.preview.caller1")).toBeTruthy();
    expect(brand.getByText("panel.preview.agent2")).toBeTruthy();
    expect(brand.getByText("panel.preview.booked")).toBeTruthy();
    expect(brand.getByText("panel.points.book")).toBeTruthy();
    expect(panel().classList.contains("dark")).toBe(false);
  });

  it("shows the brand's name with its first letter on the tile when it has no logo, and its logo when it has one", () => {
    const { unmount } = render(<AuthShell title="Welcome back" />);
    const lockup = screen.getByLabelText("Northwind Clinics");
    expect(within(lockup).getByText("N")).toBeTruthy();
    expect(lockup.querySelector("img")).toBeNull();
    unmount();
    state.branding = { appName: "Northwind Clinics", logoUrl: "/brand/northwind/logo.svg?v=1", ready: true };
    render(<AuthShell title="Welcome back" />);
    expect(screen.getByLabelText("Northwind Clinics").querySelector("img")?.getAttribute("src")).toBe("/brand/northwind/logo.svg?v=1");
  });

  it("holds the name's place until a prerendered page knows it", () => {
    state.branding = { appName: "LobbyStack", logoUrl: null, ready: false };
    render(<AuthShell title="Welcome back" />);
    expect(screen.queryByLabelText("LobbyStack")).toBeNull();
  });

  it("shows a brand's own words in the reader's language, its own example call and a dark panel", () => {
    state.language = "fr";
    state.page = {
      panel: "dark",
      headline: words("The AI receptionist for real estate agents.", "La réceptionniste IA des courtiers immobiliers."),
      description: null,
      points: [words("Answers calls", "Répond aux appels"), words("Learns each listing", "Apprend chaque propriété"), words("Books showings", "Planifie les visites")],
      exampleCall: { lines: [words("Is it still for sale?", "Est-elle toujours à vendre?"), words("Yes. Saturday?", "Oui. Samedi?"), words("Yes please.", "Oui, merci.")], booked: words("Showing booked", "Visite planifiée") },
    };
    render(<AuthShell title="Bon retour" />);
    const brand = within(panel());
    expect(brand.getByText("La réceptionniste IA des courtiers immobiliers.")).toBeTruthy();
    // A part the brand leaves out keeps the shared words.
    expect(brand.getByText("panel.description")).toBeTruthy();
    expect(brand.getByText("Apprend chaque propriété")).toBeTruthy();
    expect(brand.getByText("Visite planifiée")).toBeTruthy();
    expect(brand.queryByText("panel.preview.caller1")).toBeNull();
    // The lines take turns from the caller's: the caller's on the left, the receptionist's on the right.
    const lines = brand.getAllByRole("listitem").filter((item) => item.classList.contains("auth-rise"));
    expect(lines.map((line) => [line.textContent, line.classList.contains("justify-end")])).toEqual([
      ["Est-elle toujours à vendre?", false],
      ["Oui. Samedi?", true],
      ["Oui, merci.", false],
    ]);
    expect(panel().classList.contains("dark")).toBe(true);
  });

  it("shows a spinner in place of the form while the session is checked", () => {
    render(<AuthShell pending="Checking your session" />);
    expect(screen.getByRole("status").textContent).toBe("Checking your session");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(within(panel()).getByText("panel.headline")).toBeTruthy();
  });

  it("puts a note above the title, the progress dots under the form, and a page's own legal footer", () => {
    render(<AuthShell eyebrow="Requested by app.example.com" legalFooter={<p>By continuing you agree.</p>} progress={{ current: 1, total: 8 }} title="Allow access?" />);
    expect(screen.getByText("Requested by app.example.com")).toBeTruthy();
    expect(screen.getByLabelText("Onboarding step 1, current step").getAttribute("aria-current")).toBe("step");
    expect(screen.getAllByRole("img", { name: /^Onboarding step \d$/ })).toHaveLength(7);
    expect(screen.getByText("By continuing you agree.")).toBeTruthy();
    expect(screen.queryByText("shell.terms")).toBeNull();
  });
});

describe("brandScopeStyle", () => {
  it("sets the accent as text and lines only on the page where it contrasts enough", () => {
    expect(brandScopeStyle({ accent: "#ffd100", onAccent: "#000000", text: { light: null, dark: "#ffd100" }, line: { light: null, dark: "#ffd100" } })).toEqual({
      "--brand": "#ffd100",
      "--brand-foreground": "#000000",
      "--brand-text-dark": "#ffd100",
      "--brand-line-dark": "#ffd100",
    });
  });
});
