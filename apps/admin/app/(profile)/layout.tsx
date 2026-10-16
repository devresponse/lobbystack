import { headers } from "next/headers";

import { localeTag } from "@/lib/locale";
import { localeFromRequestHeaders } from "@/lib/locale-request";
import "../globals.css";

export const dynamic = "force-dynamic";

/**
 * The root of a business's public page at /profile/<slug>. The page renders on
 * the server with its words already in it, so unlike the dashboard's root it
 * ships no translations, providers or analytics: its only scripts are the
 * share and copy buttons and the business's chat.
 */
export default async function ProfileLayout({ children }: { children: React.ReactNode }) {
  const { locale } = localeFromRequestHeaders(await headers());
  return (
    <html lang={localeTag(locale)}>
      <body>{children}</body>
    </html>
  );
}
