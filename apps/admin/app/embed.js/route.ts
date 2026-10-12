import { readFile } from "node:fs/promises";
import path from "node:path";

import { WIDGET_APPEARANCE_GLOBAL, type WidgetAppearance } from "@lobbystack/shared";

import { loadWidgetAppearance } from "@/lib/widget-keys";

export const runtime = "nodejs";

const STUB = "/* LobbyStack widget loader is unavailable. Run `pnpm --filter @lobbystack/embed build`. */";
const EMBED_FILE = path.join(process.cwd(), "public", "embed", "embed.js");
// Widget keys are base64url after their prefix; anything else is not a key.
const WIDGET_KEY_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * With `?key=`, the loader starts by recording the bubble look the dashboard
 * saved for that key, so a change there reaches the website without a new
 * snippet. A failed lookup serves the plain loader, which falls back to the
 * script tag's attributes.
 */
async function appearancePrelude(key: string | null): Promise<string> {
  if (!key || !WIDGET_KEY_PATTERN.test(key)) return "";
  let appearance: WidgetAppearance | null = null;
  try {
    appearance = await loadWidgetAppearance(key);
  } catch {
    return "";
  }
  if (!appearance) return "";
  const global = `window[${JSON.stringify(WIDGET_APPEARANCE_GLOBAL)}]`;
  return `${global}=${global}||{};${global}[${JSON.stringify(key)}]=${JSON.stringify(appearance)};\n`;
}

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  try {
    const body = await readFile(EMBED_FILE, "utf8");
    return new Response(`${await appearancePrelude(key)}${body}`, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        // A keyed loader carries the saved look, so it may only be cached briefly.
        "cache-control": key ? "public, max-age=60, s-maxage=60" : "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    // The generated asset is copied into public/embed during the build.
  }

  return new Response(STUB, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}
