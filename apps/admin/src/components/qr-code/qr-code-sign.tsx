import type { TFunction } from "i18next";
import { useMemo, type ReactNode } from "react";
import { Trans } from "react-i18next";

import type { QrCodeDrawing } from "@/lib/qr-code";
import { layoutHeadline, type HeadlineLayout, type MeasureText } from "@/lib/qr-code-headline";

import { QrCodeGraphic } from "./qr-code-graphic";

// The printed signs: three templates in AlloPlace's Cadre style, each in four
// sizes printed on A4 paper with cut lines between the pieces. Lengths are CSS
// pixels (1/96 inch), so a sheet prints at its true size. Every piece keeps a
// white edge of at least 5 mm, since laser printers can't print to the edge of
// the paper.

export const QR_SIGN_TEMPLATES = ["signal", "frontDesk", "night"] as const;
export type QrSignTemplate = (typeof QR_SIGN_TEMPLATES)[number];

export const QR_SIGN_SIZES = ["a4", "a5", "a6", "a7"] as const;
export type QrSignSize = (typeof QR_SIGN_SIZES)[number];

const PX_PER_MM = 96 / 25.4;
const YELLOW = "#FFD100";
const GRAPHITE = "#3D3D3D";
const FINE_ON_BLACK = "#C9C9C4";
const CUT_LINE = "#A3A3A3";

/** How a size's pieces sit on an A4 sheet. */
export const QR_SIGN_SHEETS: Record<QrSignSize, { columns: number; rows: number; landscape: boolean; piece: { width: number; height: number } }> = {
  a4: { columns: 1, rows: 1, landscape: false, piece: { width: 210, height: 297 } },
  a5: { columns: 2, rows: 1, landscape: true, piece: { width: 148.5, height: 210 } },
  a6: { columns: 2, rows: 2, landscape: false, piece: { width: 105, height: 148.5 } },
  a7: { columns: 4, rows: 2, landscape: true, piece: { width: 74.25, height: 105 } },
};

type Text = { size: number; lineHeight: number };
/** A headline fitted into a box as tall as `lines` lines at the largest size. */
type Fit = { max: number; min: number; lineHeight: number; lines: number };
type Brackets = { offset: number; arm: number; thickness: number };
type Footer = Text & { brand: number; logo: number; gap: number; brandGap: number };

// Signal and Night: a coloured card with the message as the headline.
type CardTokens = {
  inset: number;
  radius: number;
  padding: [number, number, number];
  name: Text;
  nameGap: number;
  headline: Fit;
  code: number;
  codeRadius: number;
  brackets: Brackets;
  scan: Text;
  scanGap: number;
  url: Text;
  footer: Footer;
};

// Front desk: white paper, the business name as the headline, the code on a yellow stage.
type DeskTokens = {
  padding: [number, number, number];
  name: Fit;
  message: Fit;
  messageGap: number;
  stage: { marginTop: number; radius: number; paddingY: number };
  code: number;
  codeRadius: number;
  brackets: Brackets;
  scan: Text & { marginTop: number };
  url: Text & { marginTop: number };
  footer: Footer & { radius: number; padding: [number, number] };
};

const CARD: Record<QrSignSize, CardTokens> = {
  a4: { inset: 30, radius: 24, padding: [58, 64, 44], name: { size: 28, lineHeight: 32 }, nameGap: 18, headline: { max: 76, min: 40, lineHeight: 0.98, lines: 2 }, code: 420, codeRadius: 8, brackets: { offset: 30, arm: 100, thickness: 16 }, scan: { size: 40, lineHeight: 44 }, scanGap: 10, url: { size: 20, lineHeight: 28 }, footer: { size: 17, lineHeight: 24, brand: 19, logo: 24, gap: 8, brandGap: 6 } },
  a5: { inset: 22, radius: 18, padding: [42, 46, 32], name: { size: 20, lineHeight: 24 }, nameGap: 13, headline: { max: 54, min: 28, lineHeight: 0.98, lines: 2 }, code: 296, codeRadius: 6, brackets: { offset: 21, arm: 70, thickness: 11 }, scan: { size: 28, lineHeight: 32 }, scanGap: 7, url: { size: 14, lineHeight: 20 }, footer: { size: 13, lineHeight: 18, brand: 14, logo: 17, gap: 6, brandGap: 5 } },
  a6: { inset: 19, radius: 14, padding: [30, 32, 22], name: { size: 14, lineHeight: 18 }, nameGap: 9, headline: { max: 38, min: 20, lineHeight: 0.98, lines: 2 }, code: 206, codeRadius: 4, brackets: { offset: 15, arm: 50, thickness: 8 }, scan: { size: 20, lineHeight: 24 }, scanGap: 5, url: { size: 12, lineHeight: 16 }, footer: { size: 12, lineHeight: 16, brand: 12, logo: 14, gap: 5, brandGap: 4 } },
  a7: { inset: 19, radius: 12, padding: [18, 16, 13], name: { size: 12, lineHeight: 16 }, nameGap: 6, headline: { max: 22, min: 12, lineHeight: 0.98, lines: 2 }, code: 132, codeRadius: 3, brackets: { offset: 10, arm: 34, thickness: 6 }, scan: { size: 15, lineHeight: 18 }, scanGap: 4, url: { size: 12, lineHeight: 15 }, footer: { size: 12, lineHeight: 16, brand: 12, logo: 13, gap: 4, brandGap: 3 } },
};

const DESK: Record<QrSignSize, DeskTokens> = {
  a4: { padding: [52, 56, 48], name: { max: 104, min: 44, lineHeight: 0.95, lines: 1 }, message: { max: 30, min: 18, lineHeight: 1.2, lines: 2 }, messageGap: 20, stage: { marginTop: 40, radius: 28, paddingY: 64 }, code: 400, codeRadius: 8, brackets: { offset: 28, arm: 96, thickness: 14 }, scan: { size: 40, lineHeight: 44, marginTop: 36 }, url: { size: 20, lineHeight: 28, marginTop: 10 }, footer: { size: 17, lineHeight: 24, brand: 19, logo: 24, gap: 8, brandGap: 6, radius: 20, padding: [20, 28] } },
  a5: { padding: [37, 40, 34], name: { max: 74, min: 32, lineHeight: 0.95, lines: 1 }, message: { max: 21, min: 13, lineHeight: 1.2, lines: 2 }, messageGap: 14, stage: { marginTop: 28, radius: 20, paddingY: 45 }, code: 282, codeRadius: 6, brackets: { offset: 20, arm: 68, thickness: 10 }, scan: { size: 28, lineHeight: 31, marginTop: 25 }, url: { size: 14, lineHeight: 20, marginTop: 7 }, footer: { size: 12, lineHeight: 17, brand: 13, logo: 17, gap: 6, brandGap: 4, radius: 14, padding: [14, 20] } },
  a6: { padding: [26, 28, 24], name: { max: 52, min: 24, lineHeight: 0.95, lines: 1 }, message: { max: 15, min: 12, lineHeight: 1.2, lines: 2 }, messageGap: 10, stage: { marginTop: 20, radius: 14, paddingY: 32 }, code: 200, codeRadius: 4, brackets: { offset: 14, arm: 48, thickness: 7 }, scan: { size: 20, lineHeight: 22, marginTop: 18 }, url: { size: 12, lineHeight: 16, marginTop: 5 }, footer: { size: 12, lineHeight: 16, brand: 12, logo: 14, gap: 5, brandGap: 4, radius: 10, padding: [10, 14] } },
  a7: { padding: [22, 19, 19], name: { max: 36, min: 17, lineHeight: 0.95, lines: 1 }, message: { max: 12, min: 9, lineHeight: 1.2, lines: 2 }, messageGap: 7, stage: { marginTop: 14, radius: 10, paddingY: 18 }, code: 128, codeRadius: 3, brackets: { offset: 9, arm: 32, thickness: 5 }, scan: { size: 14, lineHeight: 17, marginTop: 12 }, url: { size: 12, lineHeight: 15, marginTop: 3 }, footer: { size: 12, lineHeight: 16, brand: 12, logo: 13, gap: 4, brandGap: 3, radius: 8, padding: [7, 10] } },
};

/** The sheet's width and height in millimetres. */
export function qrSheetSize(size: QrSignSize): { width: number; height: number } {
  return QR_SIGN_SHEETS[size].landscape ? { width: 297, height: 210 } : { width: 210, height: 297 };
}

/** How wide the printed code is, in millimetres, for a template and size. */
export function qrSignCodeWidth(template: QrSignTemplate, size: QrSignSize): number {
  return (template === "frontDesk" ? DESK[size].code : CARD[size].code) / PX_PER_MM;
}

/** The address as the sign prints it, without https:// and ready to wrap at its first slash. */
export function displayAddress(url: string): { host: string; path: string } {
  const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const slash = bare.indexOf("/");
  return slash < 0 ? { host: bare, path: "" } : { host: bare.slice(0, slash), path: bare.slice(slash) };
}

export type QrSignContent = {
  businessName: string;
  message: string;
  /** The call to scan, such as "Scan to chat with us". */
  scanLine: string;
  url: string;
  drawing: QrCodeDrawing;
  appName: string;
  logoSrc: string | null;
  /** Whether the logo needs a white tile to show on black. */
  logoNeedsTile: boolean;
  /** The sign's words, in the sign's language. */
  t: TFunction<"settings">;
};

export type QrSignMeasures = {
  /** Geist at 780 with the headlines' tracking. */
  heavy: MeasureText;
  /** Geist at 500, untracked. */
  regular: MeasureText;
};

// A little room for the difference between measuring and printing.
const FIT_MARGIN = 0.98;

function fit(text: string, box: Fit, width: number, measure: MeasureText): HeadlineLayout {
  return layoutHeadline(text, { width: width * FIT_MARGIN, height: box.lines * box.max * box.lineHeight, lineHeight: box.lineHeight, maxFontSize: box.max, minFontSize: box.min }, measure);
}

function Lines({ layout }: { layout: HeadlineLayout }) {
  return layout.lines.map((line, index) => <span key={index} style={{ display: "block", whiteSpace: "nowrap" }}>{line}</span>);
}

function Address({ url }: { url: string }) {
  const { host, path } = displayAddress(url);
  return (
    <>
      <span style={{ display: "inline-block", overflowWrap: "anywhere" }}>{host}</span>
      {path ? <span style={{ display: "inline-block", overflowWrap: "anywhere" }}>{path}</span> : null}
    </>
  );
}

// How much of a white tile a logo fills when it sits on one.
const TILED_LOGO = 0.72;

function Brand({ children, logoSrc, tile, footer, color }: { children?: ReactNode; logoSrc: string | null; tile: boolean; footer: Footer; color: string }) {
  const inset = tile ? (1 - TILED_LOGO) / 2 : 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: footer.brandGap, fontSize: footer.brand, fontWeight: 700, letterSpacing: "-0.01em", color }}>
      {logoSrc ? (
        <svg aria-hidden="true" height={footer.logo} style={{ display: "block", flex: "none" }} viewBox="0 0 1 1" width={footer.logo}>
          {tile ? <rect fill="#FFFFFF" height={1} rx={0.22} width={1} /> : null}
          <image height={1 - 2 * inset} href={logoSrc} preserveAspectRatio="xMidYMid meet" width={1 - 2 * inset} x={inset} y={inset} />
        </svg>
      ) : null}
      {children}
    </span>
  );
}

/** The sign-off; `dark` when it sits on black. */
function AnsweredBy({ content, footer, dark }: { content: QrSignContent; footer: Footer; dark: boolean }) {
  return <Trans components={{ brand: <Brand color={dark ? "#FFFFFF" : "#000000"} footer={footer} logoSrc={content.logoSrc} tile={dark && content.logoNeedsTile} /> }} i18nKey="qrCode.sign.answeredBy" t={content.t} values={{ appName: content.appName }} />;
}

function Code({ content, size, radius, brackets, color }: { content: QrSignContent; size: number; radius: number; brackets: Brackets; color: string }) {
  const corner = { position: "absolute", width: brackets.arm, height: brackets.arm, boxSizing: "border-box" } as const;
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
      <div aria-hidden="true" style={{ ...corner, left: -brackets.offset, top: -brackets.offset, borderTop: `${brackets.thickness}px solid ${color}`, borderLeft: `${brackets.thickness}px solid ${color}` }} />
      <div aria-hidden="true" style={{ ...corner, right: -brackets.offset, bottom: -brackets.offset, borderBottom: `${brackets.thickness}px solid ${color}`, borderRight: `${brackets.thickness}px solid ${color}` }} />
      <QrCodeGraphic drawing={content.drawing} logoSrc={content.logoSrc} name={content.appName} style={{ position: "relative", display: "block", width: size, height: size, borderRadius: radius }} />
    </div>
  );
}

function CardSign({ content, tokens, headline, dark }: { content: QrSignContent; tokens: CardTokens; headline: HeadlineLayout; dark: boolean }) {
  const ink = dark ? "#FFFFFF" : "#000000";
  const fine = dark ? FINE_ON_BLACK : "#000000";
  const [top, side, bottom] = tokens.padding;
  return (
    <div style={{ boxSizing: "border-box", padding: tokens.inset, minWidth: 0, minHeight: 0 }}>
      <div style={{ height: "100%", boxSizing: "border-box", background: dark ? "#000000" : YELLOW, borderRadius: tokens.radius, padding: `${top}px ${side}px ${bottom}px`, display: "flex", flexDirection: "column", justifyContent: "space-between", color: ink }}>
        <div style={{ display: "flex", flexDirection: "column", gap: tokens.nameGap }}>
          <p style={{ margin: 0, fontSize: tokens.name.size, lineHeight: `${tokens.name.lineHeight}px`, fontWeight: 700, letterSpacing: "-0.01em", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>{content.businessName}</p>
          <p style={{ margin: 0, height: tokens.headline.lines * tokens.headline.max * tokens.headline.lineHeight, fontSize: headline.fontSize, lineHeight: tokens.headline.lineHeight, fontWeight: 780, letterSpacing: "-0.035em" }}><Lines layout={headline} /></p>
        </div>
        <div style={{ alignSelf: "center" }}>
          <Code brackets={tokens.brackets} color={dark ? YELLOW : "#000000"} content={content} radius={tokens.codeRadius} size={tokens.code} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: tokens.scanGap, textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: tokens.scan.size, lineHeight: `${tokens.scan.lineHeight}px`, fontWeight: 720, letterSpacing: "-0.02em" }}>{content.scanLine}</p>
          <p dir="ltr" style={{ margin: 0, fontSize: tokens.url.size, lineHeight: `${tokens.url.lineHeight}px`, fontWeight: 500, color: fine }}><Address url={content.url} /></p>
        </div>
        <p style={{ margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", columnGap: tokens.footer.gap, fontSize: tokens.footer.size, lineHeight: `${tokens.footer.lineHeight}px`, fontWeight: 500, color: fine }}>
          <AnsweredBy content={content} dark={dark} footer={tokens.footer} />
        </p>
      </div>
    </div>
  );
}

function DeskSign({ content, tokens, name, message }: { content: QrSignContent; tokens: DeskTokens; name: HeadlineLayout; message: HeadlineLayout }) {
  const [top, side, bottom] = tokens.padding;
  const [footerY, footerX] = tokens.footer.padding;
  return (
    <div style={{ boxSizing: "border-box", padding: `${top}px ${side}px ${bottom}px`, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "#FFFFFF", color: "#000000" }}>
      <p style={{ margin: 0, height: tokens.name.lines * tokens.name.max * tokens.name.lineHeight, fontSize: name.fontSize, lineHeight: tokens.name.lineHeight, fontWeight: 780, letterSpacing: "-0.035em" }}><Lines layout={name} /></p>
      <p style={{ margin: `${tokens.messageGap}px 0 0`, height: tokens.message.lines * tokens.message.max * tokens.message.lineHeight, fontSize: message.fontSize, lineHeight: tokens.message.lineHeight, fontWeight: 500, color: GRAPHITE }}><Lines layout={message} /></p>
      <div style={{ marginTop: tokens.stage.marginTop, background: YELLOW, borderRadius: tokens.stage.radius, padding: `${tokens.stage.paddingY}px 0`, display: "flex", justifyContent: "center" }}>
        <Code brackets={tokens.brackets} color="#000000" content={content} radius={tokens.codeRadius} size={tokens.code} />
      </div>
      <p style={{ margin: `${tokens.scan.marginTop}px 0 0`, fontSize: tokens.scan.size, lineHeight: `${tokens.scan.lineHeight}px`, fontWeight: 720, letterSpacing: "-0.02em" }}>{content.scanLine}</p>
      <p dir="ltr" style={{ margin: `${tokens.url.marginTop}px 0 0`, fontSize: tokens.url.size, lineHeight: `${tokens.url.lineHeight}px`, fontWeight: 500, color: GRAPHITE }}><Address url={content.url} /></p>
      <p style={{ margin: "auto 0 0", display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: tokens.footer.gap, padding: `${footerY}px ${footerX}px`, borderRadius: tokens.footer.radius, background: "#000000", color: FINE_ON_BLACK, fontSize: tokens.footer.size, lineHeight: `${tokens.footer.lineHeight}px`, fontWeight: 500 }}>
        <AnsweredBy content={content} dark footer={tokens.footer} />
      </p>
    </div>
  );
}

/** One A4 sheet of signs, at its true size, with cut lines between the pieces. */
export function QrSignSheet({ template, size, content, measures }: { template: QrSignTemplate; size: QrSignSize; content: QrSignContent; measures: QrSignMeasures }) {
  const sheet = QR_SIGN_SHEETS[size];
  const paper = qrSheetSize(size);
  const pieceWidth = (paper.width * PX_PER_MM) / sheet.columns;
  const card = CARD[size];
  const desk = DESK[size];
  const layout = useMemo(() => {
    if (template === "frontDesk") {
      const width = pieceWidth - 2 * desk.padding[1];
      return { kind: "desk" as const, name: fit(content.businessName, desk.name, width, measures.heavy), message: fit(content.message, desk.message, width, measures.regular) };
    }
    return { kind: "card" as const, headline: fit(content.message, card.headline, pieceWidth - 2 * card.inset - 2 * card.padding[1], measures.heavy) };
  }, [template, pieceWidth, card, desk, content.businessName, content.message, measures]);

  const pieces = Array.from({ length: sheet.columns * sheet.rows }, (_, index) =>
    layout.kind === "desk"
      ? <DeskSign content={content} key={index} message={layout.message} name={layout.name} tokens={desk} />
      : <CardSign content={content} dark={template === "night"} headline={layout.headline} key={index} tokens={card} />,
  );
  const cuts = [
    ...Array.from({ length: sheet.columns - 1 }, (_, index) => ({ key: `x${index}`, left: `${((index + 1) * paper.width) / sheet.columns}mm`, top: 0, bottom: 0, width: 0, borderLeft: `1px dashed ${CUT_LINE}` })),
    ...Array.from({ length: sheet.rows - 1 }, (_, index) => ({ key: `y${index}`, top: `${((index + 1) * paper.height) / sheet.rows}mm`, left: 0, right: 0, height: 0, borderTop: `1px dashed ${CUT_LINE}` })),
  ];

  return (
    <div
      data-qr-sheet={size}
      style={{
        position: "relative",
        width: `${paper.width}mm`,
        height: `${paper.height}mm`,
        overflow: "hidden",
        display: "grid",
        gridTemplateColumns: `repeat(${sheet.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${sheet.rows}, minmax(0, 1fr))`,
        background: "#FFFFFF",
        color: "#000000",
        fontFamily: "var(--font-sans)",
        WebkitPrintColorAdjust: "exact",
        printColorAdjust: "exact",
      }}
    >
      {pieces}
      {cuts.map(({ key, ...style }) => <div aria-hidden="true" key={key} style={{ position: "absolute", ...style }} />)}
    </div>
  );
}
