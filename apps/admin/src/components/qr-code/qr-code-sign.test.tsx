// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { TFunction } from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async () => {
  const { cloneElement } = await import("react");
  return {
    Trans: ({ i18nKey, values, components }: { i18nKey: string; values: Record<string, string>; components: { brand: React.ReactElement } }) => <>{`${i18nKey}:`}{cloneElement(components.brand, {}, values.appName)}</>,
  };
});

import { drawQrCode } from "@/lib/qr-code";
import { estimatedTextMeasure } from "@/lib/qr-code-headline";

import { displayAddress, QR_SIGN_SHEETS, QR_SIGN_SIZES, QR_SIGN_TEMPLATES, QrSignSheet, qrSheetSize, qrSignCodeWidth, type QrSignContent } from "./qr-code-sign";

const URL_ = "https://demo.alloplace.com/profile/acme-dental";
const measures = { heavy: estimatedTextMeasure(), regular: estimatedTextMeasure() };

function content(overrides: Partial<QrSignContent> = {}): QrSignContent {
  return {
    businessName: "Acme Dental",
    message: "Questions?\nAsk us any time.",
    scanLine: "Scan to chat with us",
    url: URL_,
    drawing: drawQrCode(URL_, { mark: "name", nameWidthEm: 4.04 })!,
    appName: "AlloPlace",
    logoSrc: null,
    logoNeedsTile: false,
    t: ((key: string) => key) as unknown as TFunction<"settings">,
    ...overrides,
  };
}

afterEach(cleanup);

describe("QrSignSheet", () => {
  it.each(QR_SIGN_TEMPLATES.flatMap((template) => QR_SIGN_SIZES.map((size) => [template, size] as const)))("prints %s signs at %s size on one A4 sheet", (template, size) => {
    const { container } = render(<QrSignSheet content={content()} measures={measures} size={size} template={template} />);
    const sheet = container.querySelector<HTMLElement>("[data-qr-sheet]")!;
    const { columns, rows } = QR_SIGN_SHEETS[size];
    const paper = qrSheetSize(size);
    expect(sheet.style.width).toBe(`${paper.width}mm`);
    expect(sheet.style.height).toBe(`${paper.height}mm`);
    expect(paper.width * paper.height).toBe(210 * 297);

    const pieces = [...sheet.children].filter((child) => child.getAttribute("aria-hidden") !== "true") as HTMLElement[];
    expect(pieces).toHaveLength(columns * rows);
    // One dashed cut line between neighbouring pieces.
    expect(sheet.querySelectorAll(":scope > [aria-hidden='true']")).toHaveLength(columns - 1 + rows - 1);
    for (const piece of pieces) {
      expect(piece.querySelectorAll('svg[shape-rendering="crispEdges"]')).toHaveLength(1);
      expect(piece.textContent).toContain("Acme Dental");
      expect(piece.textContent).toContain("Scan to chat with us");
      expect(piece.textContent).toContain("demo.alloplace.com/profile/acme-dental");
      expect(piece.textContent).toContain("qrCode.sign.answeredBy:AlloPlace");
      // Laser printers leave the paper's edge blank, so nothing printed comes within 5 mm of it.
      const edges = piece.style.padding.split(" ").map((value) => Number.parseFloat(value));
      expect(Math.min(...edges)).toBeGreaterThanOrEqual((5 * 96) / 25.4);
    }
  });

  it("keeps the message's own line breaks in the headline", () => {
    const { container } = render(<QrSignSheet content={content({ message: "Walk-ins\nwelcome" })} measures={measures} size="a4" template="signal" />);
    const lines = [...container.querySelectorAll("p span[style*='nowrap']")].map((line) => line.textContent);
    expect(lines).toEqual(["Walk-ins", "welcome"]);
  });

  it("shrinks a long business name on the front desk sign, then shortens it", () => {
    const name = "The Very Long Name of a Family Dental Clinic and Orthodontics Centre";
    const { container } = render(<QrSignSheet content={content({ businessName: name })} measures={measures} size="a7" template="frontDesk" />);
    const heading = container.querySelector("[data-qr-sheet] > div p")!;
    const lines = [...heading.querySelectorAll("span")].map((line) => line.textContent ?? "");
    // The name's box is one line tall at the largest size, which holds two at the smallest.
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(name.startsWith(lines.join(" ").slice(0, -1).trimEnd())).toBe(true);
  });

  it("puts a dark logo on a white tile where the sign is black", () => {
    const logo = { logoSrc: "/brand/logo-icon.svg", logoNeedsTile: true };
    const tiles = (template: (typeof QR_SIGN_TEMPLATES)[number], overrides: Partial<QrSignContent>) => {
      const { container, unmount } = render(<QrSignSheet content={content(overrides)} measures={measures} size="a4" template={template} />);
      const brand = container.querySelector('svg[viewBox="0 0 1 1"]');
      const result = { logo: brand?.querySelector("image")?.getAttribute("href") ?? null, tile: brand?.querySelector("rect") !== null && brand !== null };
      unmount();
      return result;
    };
    expect(tiles("night", logo)).toEqual({ logo: "/brand/logo-icon.svg", tile: true });
    expect(tiles("frontDesk", logo)).toEqual({ logo: "/brand/logo-icon.svg", tile: true });
    // The yellow card shows it as it is.
    expect(tiles("signal", logo)).toEqual({ logo: "/brand/logo-icon.svg", tile: false });
    // So does black when the logo is light.
    expect(tiles("night", { ...logo, logoNeedsTile: false })).toEqual({ logo: "/brand/logo-icon.svg", tile: false });
  });

  it("leaves the headline empty when the message is", () => {
    const { container } = render(<QrSignSheet content={content({ message: "  " })} measures={measures} size="a6" template="night" />);
    expect(container.querySelectorAll("p span[style*='nowrap']")).toHaveLength(0);
    expect(container.textContent).toContain("Scan to chat with us");
  });
});

describe("qrSignCodeWidth", () => {
  it("prints codes big enough to scan, the smallest over 3 cm wide", () => {
    for (const template of QR_SIGN_TEMPLATES) {
      const widths = QR_SIGN_SIZES.map((size) => qrSignCodeWidth(template, size));
      expect(widths).toEqual([...widths].sort((a, b) => b - a));
      expect(Math.min(...widths)).toBeGreaterThan(30);
      expect(Math.max(...widths)).toBeLessThan(120);
    }
  });
});

describe("displayAddress", () => {
  it("drops the scheme and splits the address at its first slash", () => {
    expect(displayAddress("https://demo.alloplace.com/profile/acme-dental")).toEqual({ host: "demo.alloplace.com", path: "/profile/acme-dental" });
    expect(displayAddress("http://example.com/")).toEqual({ host: "example.com", path: "" });
  });
});
