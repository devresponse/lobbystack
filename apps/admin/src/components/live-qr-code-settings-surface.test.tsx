// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock("react-i18next", () => {
  const i18n = { language: "en", resolvedLanguage: "en" };
  const format = (key: string, options?: Record<string, unknown>) => (options && Object.keys(options).length ? `${key}:${JSON.stringify(options)}` : key);
  return {
    // Words in a language other than English carry it, so the sign's words can be told from the dashboard's.
    useTranslation: (_namespace?: unknown, options?: { lng?: string }) => ({
      i18n,
      t: (key: string, values?: Record<string, unknown>) => `${options?.lng && options.lng !== "en" ? `${options.lng}:` : ""}${format(key, values)}`,
    }),
    Trans: ({ i18nKey, t }: { i18nKey: string; t: (key: string) => string }) => t(i18nKey),
  };
});
vi.mock("@/i18n", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/i18n")>()), loadRouteNamespaces: vi.fn(async () => undefined) }));
vi.mock("@/lib/qr-code-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/qr-code-files")>()),
  qrCodePng: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
  qrCodeSvgFile: vi.fn(async () => new Blob(["<svg/>"], { type: "image/svg+xml" })),
  saveFile: vi.fn(),
}));

import { loadRouteNamespaces } from "@/i18n";
import { DEFAULT_BRANDING_SNAPSHOT } from "@/lib/branding-snapshot";
import { qrCodePng, qrCodeSvgFile, saveFile } from "@/lib/qr-code-files";

import type { PublicProfileSettingsResponse } from "./live-public-profile-settings-surface";
import { LiveQrCodeSettingsSurface } from "./live-qr-code-settings-surface";

const clients: QueryClient[] = [];
const URL_ = "https://app.example.com/profile/acme-dental";
const KEY = "0b8f5f8e-3c55-4a43-9d6a-2f4f3f1c9a01";

function view(overrides: Partial<PublicProfileSettingsResponse> = {}, settings: Partial<PublicProfileSettingsResponse["settings"]> = {}): PublicProfileSettingsResponse {
  return {
    saved: true,
    slug: "acme-dental",
    businessName: "Acme Dental",
    publishedAt: null,
    settings: {
      published: false,
      category: null,
      description: null,
      address: { line1: null, line2: null, city: null, region: null, postalCode: null, countryCode: null },
      publicEmail: null,
      showPhone: true,
      showHours: true,
      showServices: true,
      showMap: true,
      widgetKeyId: null,
      ...settings,
    },
    widgetKeys: [{ id: KEY, label: "Main website", lastUsedAt: null, createdAt: "2026-09-01T12:00:00.000Z" }],
    url: URL_,
    canEdit: true,
    ...overrides,
  };
}

async function setup(initial: PublicProfileSettingsResponse | Response) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["businesses"], { businesses: [{ businessId: "business", name: "Acme Dental", active: true }] });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/business-profile")) return initial instanceof Response ? initial : Response.json(initial);
    return Response.json({ businesses: [{ businessId: "business", name: "Acme Dental", active: true }] });
  }));
  render(<QueryClientProvider client={client}><LiveQrCodeSettingsSurface /></QueryClientProvider>);
}

const preview = () => screen.getByRole("img", { name: /^qrCode\.previewLabel/ });
const codes = () => preview().querySelectorAll('svg[shape-rendering="crispEdges"]');
const message = () => screen.getByLabelText("qrCode.message.label") as HTMLTextAreaElement;
const printStyle = () => document.querySelector(".qr-print-root style")?.textContent ?? "";

beforeEach(() => {
  // jsdom has no canvas, so text widths are estimated.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(qrCodePng).mockClear();
  vi.mocked(qrCodeSvgFile).mockClear();
  vi.mocked(saveFile).mockClear();
  vi.mocked(loadRouteNamespaces).mockClear();
});

describe("QR code settings", () => {
  it("shows where the code goes and says the page isn't published yet", async () => {
    await setup(view());
    expect(await screen.findByText(URL_)).toBeTruthy();
    expect(screen.getByRole("link", { name: "qrCode.preview" }).getAttribute("href")).toBe(URL_);
    const note = screen.getByRole("status");
    expect(within(note).getByText("qrCode.unpublished.title")).toBeTruthy();
    expect(within(note).getByRole("link", { name: "qrCode.unpublished.link" }).getAttribute("href")).toBe("/settings/profile");
    // The code is still there, ready to print before the page goes live.
    expect(codes()).toHaveLength(1);
  });

  it("asks members who can't publish the page to ask an admin", async () => {
    await setup(view({ canEdit: false }));
    expect(await screen.findByText("qrCode.unpublished.askAdmin")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "qrCode.unpublished.link" })).toBeNull();
  });

  it("opens the published page and leaves the note out", async () => {
    await setup(view({}, { published: true }));
    expect((await screen.findByRole("link", { name: "qrCode.open" })).getAttribute("href")).toBe(URL_);
    expect(screen.queryByText("qrCode.unpublished.title")).toBeNull();
  });

  it("says when the page's address can't be loaded", async () => {
    await setup(Response.json({ error: "Nope" }, { status: 500 }));
    expect(await screen.findByText("qrCode.unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "qrCode.print" })).toBeNull();
  });

  it("prints whatever message the owner types, line breaks included", async () => {
    await setup(view());
    await screen.findByText(URL_);
    expect(message().tagName).toBe("TEXTAREA");
    expect(message().maxLength).toBe(80);
    expect(message().value).toBe("qrCode.sign.defaultMessage");

    fireEvent.change(message(), { target: { value: "Walk-ins welcome\nAsk at the desk" } });

    expect(within(preview()).getByText("Walk-ins welcome")).toBeTruthy();
    expect(within(preview()).getByText("Ask at the desk")).toBeTruthy();
    expect(screen.getByText('qrCode.message.count:{"count":32,"max":80}')).toBeTruthy();
  });

  it("lays out each size on one A4 sheet, turned sideways for the A5 and A7 pieces", async () => {
    await setup(view());
    await screen.findByText(URL_);
    expect(codes()).toHaveLength(1);
    expect(printStyle()).toContain("size: A4 portrait");

    for (const [size, pieces, orientation] of [["a5", 2, "landscape"], ["a6", 4, "portrait"], ["a7", 8, "landscape"], ["a4", 1, "portrait"]] as const) {
      fireEvent.click(screen.getByRole("radio", { name: `qrCode.size.${size}` }));
      expect(codes()).toHaveLength(pieces);
      expect(document.querySelectorAll(".qr-print-root [data-qr-sheet] svg[shape-rendering='crispEdges']")).toHaveLength(pieces);
      expect(printStyle()).toContain(`size: A4 ${orientation}`);
    }
  });

  it("draws each template", async () => {
    await setup(view());
    await screen.findByText(URL_);
    for (const template of ["frontDesk", "night", "signal"]) {
      const choice = screen.getByRole("radio", { name: `qrCode.template.${template}` });
      expect(choice.getAttribute("aria-describedby") && document.getElementById(choice.getAttribute("aria-describedby")!)?.textContent).toBe(`qrCode.template.${template}Hint`);
      fireEvent.click(choice);
      expect(preview().getAttribute("aria-label")).toContain(`"template":"qrCode.template.${template}"`);
      expect(codes()).toHaveLength(1);
      expect(within(preview()).getByText("qrCode.sign.scanPage")).toBeTruthy();
    }
  });

  it("puts the app's name, its logo or nothing in the middle of the code", async () => {
    await setup(view());
    await screen.findByText(URL_);
    const middle = () => ({ name: codes()[0]?.querySelector("text")?.textContent ?? null, logo: codes()[0]?.querySelector("image") !== null });
    expect(middle()).toEqual({ name: DEFAULT_BRANDING_SNAPSHOT.appName, logo: false });

    fireEvent.click(screen.getByRole("radio", { name: "qrCode.mark.logo" }));
    expect(middle()).toEqual({ name: null, logo: true });

    fireEvent.click(screen.getByRole("radio", { name: "qrCode.mark.none" }));
    expect(middle()).toEqual({ name: null, logo: false });
  });

  it("invites visitors to chat when the page has a chat", async () => {
    await setup(view({}, { widgetKeyId: KEY }));
    await screen.findByText(URL_);
    expect(within(preview()).getByText("qrCode.sign.scanChat")).toBeTruthy();
  });

  it("writes the sign in the language picked for it, keeping a typed message", async () => {
    await setup(view());
    await screen.findByText(URL_);

    fireEvent.change(screen.getByLabelText("qrCode.language.label"), { target: { value: "fr" } });

    expect(message().value).toBe("fr:qrCode.sign.defaultMessage");
    expect(within(preview()).getByText("fr:qrCode.sign.scanPage")).toBeTruthy();
    expect(within(preview()).getAllByText("fr:qrCode.sign.answeredBy")).toHaveLength(1);
    expect(loadRouteNamespaces).toHaveBeenCalledWith(expect.anything(), "fr", ["settings"]);
    // The dashboard stays in its own language.
    expect(screen.getByRole("button", { name: "qrCode.print" })).toBeTruthy();

    fireEvent.change(message(), { target: { value: "Bienvenue" } });
    fireEvent.change(screen.getByLabelText("qrCode.language.label"), { target: { value: "es" } });
    expect(message().value).toBe("Bienvenue");
    expect(within(preview()).getByText("es:qrCode.sign.scanPage")).toBeTruthy();
  });

  it("prints with the browser's print dialog", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    await setup(view());
    fireEvent.click(await screen.findByRole("button", { name: "qrCode.print" }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("downloads the code as a PNG or an SVG named after the page", async () => {
    await setup(view());
    fireEvent.click(await screen.findByRole("button", { name: "qrCode.png" }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith(expect.any(Blob), "acme-dental-qr-code.png"));
    const [drawing, options] = vi.mocked(qrCodePng).mock.calls[0]!;
    expect(drawing).toMatchObject({ text: URL_, mark: "name" });
    expect(options).toEqual({ name: DEFAULT_BRANDING_SNAPSHOT.appName, logoSrc: null, fontFamily: '"Geist Variable", sans-serif', title: `qrCode.codeLabel:${JSON.stringify({ url: URL_ })}` });

    fireEvent.click(screen.getByRole("radio", { name: "qrCode.mark.logo" }));
    fireEvent.click(screen.getByRole("button", { name: "qrCode.svg" }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith(expect.any(Blob), "acme-dental-qr-code.svg"));
    const [logoDrawing, logoOptions] = vi.mocked(qrCodeSvgFile).mock.calls[0]!;
    expect(logoDrawing.mark).toBe("logo");
    expect(logoOptions.logoSrc).toMatch(/logo/);
  });

  it("says when a download fails", async () => {
    vi.mocked(qrCodePng).mockRejectedValueOnce(new Error("No canvas"));
    await setup(view());
    fireEvent.click(await screen.findByRole("button", { name: "qrCode.png" }));
    expect((await screen.findByRole("alert")).textContent).toBe("qrCode.downloadFailed");
    expect(saveFile).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "qrCode.png" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
