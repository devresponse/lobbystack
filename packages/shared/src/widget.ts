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

/** The script tag that puts the chat widget on a website, served from the dashboard's origin. */
export function widgetEmbedSnippet(appOrigin: string, key: string, config: { position?: WidgetPosition | undefined; color?: string | undefined }): string {
  const position = config.position ?? "bottom-right";
  const color = config.color ?? "#0f766e";
  return `<script src="${appOrigin}/embed.js" data-widget-key="${key}" data-position="${position}" data-color="${color}" defer></script>`;
}
