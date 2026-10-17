"use client";

import { useEffect, useState } from "react";

import { canvasTextMeasure, estimatedTextMeasure, type MeasureText } from "@/lib/qr-code-headline";

/** The sign's font, as the canvas names it; the page's --font-sans. */
export const QR_SIGN_FONT_FAMILY = '"Geist Variable", sans-serif';

/**
 * Measures text in the sign's font at a weight and letter spacing. Until the
 * font has loaded, and where the page has no canvas, widths are estimated.
 */
export function useTextMeasure(weight: number, letterSpacingEm: number): MeasureText {
  const [measure, setMeasure] = useState<MeasureText>(() => estimatedTextMeasure());
  useEffect(() => {
    let cancelled = false;
    const loaded = typeof document !== "undefined" && document.fonts ? document.fonts.load(`${weight} 100px ${QR_SIGN_FONT_FAMILY}`).catch(() => []) : Promise.resolve([]);
    void loaded.then(() => {
      if (cancelled) return;
      const measured = canvasTextMeasure({ family: QR_SIGN_FONT_FAMILY, weight, letterSpacingEm });
      if (measured) setMeasure(() => measured);
    });
    return () => {
      cancelled = true;
    };
  }, [weight, letterSpacingEm]);
  return measure;
}
