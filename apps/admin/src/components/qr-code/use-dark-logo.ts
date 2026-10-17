"use client";

import { useEffect, useState } from "react";

// The sample a logo's colours are judged on, in pixels.
const SAMPLE_SIZE = 32;
// Below this average lightness (0 black, 1 white) a logo disappears on black.
const DARK_LIGHTNESS = 0.35;

/** Whether a logo's visible pixels, as RGBA bytes, are mostly dark. A logo with none counts as dark. */
export function logoPixelsAreDark(pixels: Uint8ClampedArray): boolean {
  let weight = 0;
  let lightness = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255;
    if (alpha < 0.1) continue;
    weight += alpha;
    lightness += (alpha * (0.2126 * pixels[index]! + 0.7152 * pixels[index + 1]! + 0.0722 * pixels[index + 2]!)) / 255;
  }
  return weight === 0 || lightness / weight < DARK_LIGHTNESS;
}

async function logoIsDark(src: string): Promise<boolean> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return true;
  context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  // Throws for a logo from another site that doesn't allow reading it.
  return logoPixelsAreDark(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
}

/**
 * Whether the logo needs a white tile to show on the signs' black surfaces:
 * true for a dark logo, and for one the page can't look at.
 */
export function useDarkLogo(src: string | null): boolean {
  const [dark, setDark] = useState<{ src: string; dark: boolean } | null>(null);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    logoIsDark(src).catch(() => true).then((value) => {
      if (!cancelled) setDark({ src, dark: value });
    });
    return () => {
      cancelled = true;
    };
  }, [src]);
  return dark?.src === src ? dark.dark : false;
}
