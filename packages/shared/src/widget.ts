// The website chat widget's positions, allowed origins and script tag, which
// the dashboard and the API share.

export type WidgetPosition = "bottom-right" | "bottom-left" | "bottom-center";

export const widgetPositions = [
  "bottom-right",
  "bottom-left",
  "bottom-center",
] as const satisfies ReadonlyArray<WidgetPosition>;

/**
 * A website origin as widget keys keep it: scheme, host and port, with no
 * trailing slash. A bare host, as people type it, means its https origin;
 * without that it would never match a browser's Origin header.
 */
export function normalizeWidgetOrigin(value: string): string {
  const trimmed = value.trim();
  // A sandboxed page sends the opaque origin null, which is no host.
  if (trimmed === "null") return trimmed;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const origin = new URL(withScheme).origin;
    if (origin !== "null") return origin.replace(/\/$/, "");
  } catch {
    // Kept as typed below.
  }
  return trimmed.replace(/\/$/, "");
}

/**
 * The script tag that puts the chat widget on a website, served from the
 * dashboard's origin. The loader URL names the key, so the loader arrives with
 * the bubble's color and position as the dashboard last saved them.
 */
export function widgetEmbedSnippet(appOrigin: string, key: string): string {
  return `<script src="${appOrigin}/embed.js?key=${encodeURIComponent(key)}" data-widget-key="${key}" defer></script>`;
}

/** The bubble look the loader takes from the dashboard. Only fields the key's config sets. */
export type WidgetAppearance = { color?: string; position?: WidgetPosition };

/** The global the keyed loader fills before its own code runs, one entry per widget key. */
export const WIDGET_APPEARANCE_GLOBAL = "__lobbyStackWidgetAppearance";
