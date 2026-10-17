import type { CSSProperties } from "react";

import { QR_NAME_LETTER_SPACING_EM, QR_PLATE_COLOR, type QrCodeDrawing } from "@/lib/qr-code";

/** A drawn QR code as inline SVG, in the page's own font, for the preview and the printed sign. */
export function QrCodeGraphic({ drawing, name, logoSrc, label, className, style }: {
  drawing: QrCodeDrawing;
  /** The name on the plate. */
  name: string;
  logoSrc: string | null;
  /** What screen readers hear; leave it out when the sign already says where the code goes. */
  label?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}) {
  const { size, plate, logo } = drawing;
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={className}
      role={label ? "img" : undefined}
      shapeRendering="crispEdges"
      style={style}
      viewBox={`0 0 ${size} ${size}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#FFFFFF" height={size} width={size} />
      <path d={drawing.modules} fill="#000000" />
      {drawing.finders.map(({ x, y }) => (
        <g key={`${x}-${y}`}>
          <rect fill="#000000" height={7} width={7} x={x} y={y} />
          <rect fill="#FFFFFF" height={5} width={5} x={x + 1} y={y + 1} />
          <rect fill="#000000" height={3} width={3} x={x + 2} y={y + 2} />
        </g>
      ))}
      {plate ? (
        <>
          <rect fill={QR_PLATE_COLOR} height={plate.height} rx={plate.radius} shapeRendering="geometricPrecision" width={plate.width} x={plate.x} y={plate.y} />
          <path d={plate.brackets} fill="#000000" />
          <text
            fill="#000000"
            fontSize={plate.name.fontSize}
            fontWeight={700}
            letterSpacing={QR_NAME_LETTER_SPACING_EM * plate.name.fontSize}
            lengthAdjust={plate.name.squeezeTo ? "spacingAndGlyphs" : undefined}
            shapeRendering="geometricPrecision"
            style={{ fontFamily: "var(--font-sans)" }}
            textAnchor="middle"
            textLength={plate.name.squeezeTo ?? undefined}
            x={plate.name.x}
            y={plate.name.y}
          >
            {name}
          </text>
        </>
      ) : null}
      {logo && logoSrc ? <image height={logo.height} href={logoSrc} preserveAspectRatio="xMidYMid meet" width={logo.width} x={logo.x} y={logo.y} /> : null}
    </svg>
  );
}
