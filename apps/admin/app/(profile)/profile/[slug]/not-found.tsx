import { headers } from "next/headers";

import { brandLinks } from "@lobbystack/shared";

import { loadBranding } from "@/lib/branding";
import { brandLogoSrc } from "@/lib/branding-snapshot";
import { localeFromRequestHeaders } from "@/lib/locale-request";
import { serverTranslator } from "@/lib/server-translation";

/** What /profile/<slug> shows for a slug with no published page. */
export default async function ProfileNotFound() {
  const { locale } = localeFromRequestHeaders(await headers());
  const branding = await loadBranding();
  const t = serverTranslator(locale, "profile", branding.appName);
  const logoSrc = brandLogoSrc(branding);
  return (
    <div className="flex min-h-svh flex-col bg-[#fff] font-sans text-[17px] leading-[1.55] text-[#000] antialiased [color-scheme:light]">
      <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center gap-4 px-5 py-16 sm:px-8">
        <h1 className="text-[40px] leading-none font-[780] tracking-[-0.035em] text-balance lg:text-[56px]">{t("notFound.title")}</h1>
        <p className="text-[#3D3D3D]">{t("notFound.body")}</p>
      </main>
      <footer className="bg-[#000] text-[#fff]">
        <div className="mx-auto flex w-full max-w-[720px] px-5 py-4 sm:px-8">
          <a href={brandLinks().siteUrl} className="inline-flex min-h-11 items-center gap-1.5 text-[17px] font-bold tracking-[-0.01em] text-[#fff] no-underline">
            {logoSrc ? <img src={logoSrc} alt="" width={22} height={22} className={`size-[22px] flex-none rounded-[5px] object-contain${branding.logoUrl ? "" : " invert"}`} /> : null}
            {branding.appName}
          </a>
        </div>
      </footer>
    </div>
  );
}
