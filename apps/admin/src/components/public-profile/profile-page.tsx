import { CalendarX, ExternalLink, Globe, Mail, MapPin, Navigation, Phone, Share2 } from "lucide-react";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import type { PublicBusinessProfile } from "@lobbystack/domain";
import { formatPublicProfileAddress, hasMappableAddress } from "@lobbystack/shared";

import type { SupportedLocale } from "@/lib/locale";
import { localeTag } from "@/lib/locale";
import { addressLines, bookingHint, closureLines, hoursRows, localBusinessJsonLd, mapLinks, nextOpeningLabel, phoneDisplay, profileLanguages, serviceName, statusLine, timeZoneLabel } from "@/lib/public-profile-page";
import type { Translate } from "@/lib/server-translation";

import { CopyButton, ShareButton } from "./profile-buttons";

// A business's public page at /profile/<slug>, in the "Front desk" layout:
// the business on the left and its receptionist's chat on the right, framed on
// the deployment's accent, then its hours, services and location. On a phone
// the chat comes right after the business's name. The words, the business's
// details and the brand are worked out by the page and passed in.

/** The element the widget loader puts the chat in. */
export const PROFILE_CHAT_ID = "profile-chat";

export type ProfilePageProps = {
  profile: PublicBusinessProfile;
  locale: SupportedLocale;
  t: Translate;
  now: Date;
  pageUrl: string;
  /** The deployment's accent, and black or white for text on it. */
  accent: string;
  onAccent: string;
  /** The deployment's name and logo; LobbyStack's own logo is dark, so the black footer turns it white. */
  brand: { appName: string; logoSrc: string | null; invertLogo: boolean; siteUrl: string };
  /** A Google Maps Embed API key; without one, the map links out. */
  mapsEmbedKey: string | null;
  languageNames: Record<SupportedLocale, string>;
};

const HAIRLINE = "border-[#D6D6D2]";
const MUTED = "text-[#3D3D3D]";
const PILL = "inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded-full px-[26px] text-[17px] leading-[1.1] font-semibold no-underline";
const TEXT_LINK = "inline-flex min-h-11 items-center gap-2 text-base font-semibold underline decoration-1 underline-offset-[0.22em] hover:decoration-2";
const SECTION_TITLE = "text-[28px] leading-[1.1] font-[720] tracking-[-0.025em] text-balance";

function LanguageLink({ locale, name, className }: { locale: SupportedLocale; name: string; className: string }) {
  return <a href={`?lng=${locale}`} lang={localeTag(locale)} hrefLang={localeTag(locale)} className={className}>{name}</a>;
}

/** Two of the brand's corner brackets, framing what's inside them. */
function Brackets({ children }: { children: ReactNode }) {
  const corner = "pointer-events-none absolute size-9 border-[var(--on-accent)] lg:size-12";
  return (
    <div className="relative">
      <div aria-hidden="true" className={`${corner} -top-[18px] -left-[18px] border-t-[10px] border-l-[10px] lg:-top-6 lg:-left-6 lg:border-t-[12px] lg:border-l-[12px]`} />
      <div aria-hidden="true" className={`${corner} -right-[18px] -bottom-[18px] border-r-[10px] border-b-[10px] lg:-right-6 lg:-bottom-6 lg:border-r-[12px] lg:border-b-[12px]`} />
      {children}
    </div>
  );
}

function ContactRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className={`flex min-h-[52px] items-center gap-4 border-b ${HAIRLINE} py-1.5`}>{icon}{children}</div>;
}

export function ProfilePage({ profile, locale, t, now, pageUrl, accent, onAccent, brand, mapsEmbedKey, languageNames }: ProfilePageProps) {
  const clock = { locale, timezone: profile.timezone, now, t };
  const status = statusLine(profile, clock);
  const phone = profile.phone ? { href: `tel:${profile.phone}`, display: phoneDisplay(profile.phone, profile.address?.countryCode) } : null;
  const mappable = profile.address && hasMappableAddress(profile.address) ? profile.address : null;
  const maps = mappable ? mapLinks(mappable, { embedKey: mapsEmbedKey, locale }) : null;
  const stage = profile.widgetKey ? (profile.published ? "chat" : "chatPreview") : phone ? "call" : null;
  const hint = bookingHint({ chat: stage === "chat", phone: Boolean(phone) }, t);
  const nextService = profile.nextOpening && profile.services ? serviceName({ name: profile.nextOpening.serviceName, localizedNames: profile.nextOpening.serviceLocalizedNames }, locale) : null;
  const eyebrow = [profile.category, profile.address?.city].filter(Boolean).join(" · ");
  const languages = profileLanguages(locale, profile.defaultLocale);
  const website = profile.websiteUrl ? { href: profile.websiteUrl, host: new URL(profile.websiteUrl).host.replace(/^www\./, "") } : null;
  const hours = profile.hours?.length ? hoursRows(profile.hours, clock) : null;
  const closures = profile.closures?.length ? closureLines(profile.closures, clock) : [];
  const zone = hours ? timeZoneLabel(profile.timezone, locale, now) : null;
  const person = profile.personRequests === "any_time" ? t("footer.personAnyTime") : profile.personRequests === "business_hours" ? t("footer.personDuringHours") : null;
  const hasContact = Boolean(profile.address || phone || profile.email || website);
  const style = { "--accent": accent, "--on-accent": onAccent } as CSSProperties;

  return (
    <div style={style} className="flex min-h-svh flex-col bg-[#fff] font-sans text-[17px] leading-[1.55] text-[#000] antialiased [color-scheme:light]">
      {profile.published ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: localBusinessJsonLd(profile, pageUrl) }} /> : (
        <div className="bg-[#000] text-[#fff]">
          <p className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-[15px] leading-[22px] sm:px-8 lg:px-12">
            {t("preview.banner")}
            <Link href="/settings/profile" className="font-semibold text-[#fff] underline underline-offset-[0.22em]">{t("preview.settings")}</Link>
          </p>
        </div>
      )}

      <div className="mx-auto w-full max-w-[1280px] px-5 sm:px-8 lg:px-12">
        <div className="flex flex-wrap items-center justify-end gap-x-7 pt-2 lg:py-3">
          {phone ? (
            <a href={phone.href} className="hidden min-h-11 items-center gap-2 text-base font-semibold text-[#000] no-underline tabular-nums lg:inline-flex">
              <Phone aria-hidden="true" className="size-[18px] flex-none" />{phone.display}
            </a>
          ) : null}
          <LanguageLink locale={languages.suggested} name={languageNames[languages.suggested]} className="inline-flex min-h-11 items-center text-[15px] font-semibold text-[#000] underline decoration-1 underline-offset-[0.22em] lg:text-base" />
        </div>

        <section aria-labelledby="profile-name" className={stage ? "grid grid-cols-1 pt-1 lg:grid-cols-[minmax(0,540fr)_minmax(0,580fr)] lg:grid-rows-[auto_1fr] lg:gap-x-16 lg:gap-y-5 lg:pt-4 lg:pb-24" : "grid max-w-[760px] grid-cols-1 pt-1 pb-12 lg:gap-y-5 lg:pt-4 lg:pb-24"}>
          <div className="flex min-w-0 flex-col gap-3 pb-7 lg:col-start-1 lg:row-start-1 lg:gap-5 lg:pb-0">
            {eyebrow ? <p className="text-[13px] leading-[18px] font-[650] tracking-[0.06em] uppercase lg:text-sm lg:leading-5">{eyebrow}</p> : null}
            <h1 id="profile-name" className="text-[48px] leading-[0.95] font-[780] tracking-[-0.035em] text-balance [overflow-wrap:anywhere] lg:text-[clamp(56px,6.4vw,88px)]">{profile.name}</h1>
            {status ? (
              <p className="text-base leading-[22px] lg:text-[17px] lg:leading-6">
                <strong className="font-bold">{status.label}</strong>
                {status.detail ? <> · {status.detail}</> : null}
              </p>
            ) : null}
            {profile.description ? <p className={`${MUTED} whitespace-pre-line lg:max-w-[40ch] lg:text-[19px] lg:leading-normal`}>{profile.description}</p> : null}
          </div>

          {stage ? (
            <div className="-mx-5 bg-[var(--accent)] px-7 py-10 sm:-mx-8 sm:px-10 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mx-0 lg:rounded-[28px] lg:px-12 lg:py-14">
              <Brackets>
                {stage === "chat" ? (
                  <section id={PROFILE_CHAT_ID} aria-label={t("stage.chat", { name: profile.name })} className="relative flex h-[520px] flex-col items-center justify-center overflow-hidden rounded-[20px] bg-[#fff] text-sm text-[#71717a] lg:h-[600px]">
                    {t("stage.chatLoading")}
                  </section>
                ) : stage === "chatPreview" ? (
                  <div className="relative flex h-[520px] items-center justify-center rounded-[20px] bg-[#fff] p-8 text-center text-[15px] leading-[22px] text-[#3D3D3D] lg:h-[600px]">{t("preview.chat")}</div>
                ) : (
                  <div className="relative flex min-h-[320px] flex-col justify-center gap-4 rounded-[20px] bg-[#fff] p-8 lg:min-h-[420px] lg:p-12">
                    <h2 className={SECTION_TITLE}>{t("stage.call", { name: profile.name })}</h2>
                    <p className="text-[34px] leading-[1.1] font-[780] tracking-[-0.02em] tabular-nums lg:text-[44px]">{phone!.display}</p>
                    <p className={`${MUTED} text-[15px] leading-[22px]`}>{t("stage.callNote")}</p>
                    <a href={phone!.href} className={`${PILL} self-start bg-[#000] text-[#fff]`}><Phone aria-hidden="true" className="size-5 flex-none" />{t("actions.callNow")}</a>
                  </div>
                )}
              </Brackets>
              {stage === "chat" ? <script src={`/embed.js?key=${encodeURIComponent(profile.widgetKey!)}`} data-inline-target={`#${PROFILE_CHAT_ID}`} defer /> : null}
            </div>
          ) : null}

          <nav aria-label={t("actions.label", { name: profile.name })} className="flex min-w-0 flex-col gap-3 pt-7 lg:col-start-1 lg:row-start-2 lg:gap-5 lg:pt-0">
            {profile.nextOpening ? (
              <div className={`order-first mb-2 flex flex-col gap-1 border-b ${HAIRLINE} pb-5 lg:order-last lg:mt-auto lg:mb-0 lg:border-t lg:pt-5`}>
                <p className={`${MUTED} text-[15px] leading-5 font-medium`}>{t("nextOpening.label")}</p>
                <p className="text-[26px] leading-8 font-[720] tracking-[-0.02em] lg:text-[28px] lg:leading-[34px]">{nextOpeningLabel(profile.nextOpening.startsAt, clock)}</p>
                {nextService || hint ? <p className={`${MUTED} text-[15px] leading-[22px]`}>{[nextService ? t("nextOpening.service", { service: nextService }) : null, hint].filter(Boolean).join(" ")}</p> : null}
              </div>
            ) : null}
            {phone || maps ? (
              <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap">
                {phone ? (
                  <a href={phone.href} className={`${PILL} bg-[#000] text-[#fff] tabular-nums`}>
                    <Phone aria-hidden="true" className="size-5 flex-none" />
                    <span className="lg:hidden">{t("actions.callNow")}</span>
                    <span className="hidden lg:inline">{t("actions.call", { phone: phone.display })}</span>
                  </a>
                ) : null}
                {maps ? <a href={maps.directions} target="_blank" rel="noopener noreferrer" className={`${PILL} border-2 border-[#000] bg-[#fff] text-[#000]`}><Navigation aria-hidden="true" className="size-5 flex-none" />{t("actions.directions")}</a> : null}
              </div>
            ) : null}
            <div className="flex flex-wrap justify-center gap-x-7 lg:justify-start">
              {website ? <a href={website.href} target="_blank" rel="noopener noreferrer" className={`${TEXT_LINK} text-[#000]`}><Globe aria-hidden="true" className="size-[18px] flex-none" />{t("actions.website")}</a> : null}
              <ShareButton url={pageUrl} title={profile.name} label={t("actions.share")} copiedLabel={t("actions.linkCopied")} className={`${TEXT_LINK} cursor-pointer border-0 bg-transparent p-0 text-[#000]`}>
                <Share2 aria-hidden="true" className="size-[18px] flex-none" />
              </ShareButton>
            </div>
          </nav>
        </section>
      </div>

      {hours || profile.services?.length || hasContact ? (
        <section aria-label={t("details")} className={`border-t ${HAIRLINE} mt-10 lg:mt-0`}>
          <div className="mx-auto grid w-full max-w-[1280px] grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] items-start gap-10 px-5 py-10 sm:px-8 lg:gap-12 lg:px-12 lg:py-20">
            {hours ? (
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 id="profile-hours" className={SECTION_TITLE}>{t("hours.title")}</h2>
                  {zone ? <span className={`${MUTED} text-right text-[15px] leading-5`}>{zone}</span> : null}
                </div>
                <dl aria-labelledby="profile-hours" className="flex flex-col">
                  {hours.map((row) => (
                    <div key={row.dayOfWeek} className={row.today ? "-mx-3 my-1 flex items-baseline justify-between gap-4 rounded-xl bg-[var(--accent)] px-3 py-2.5 text-[var(--on-accent)]" : `flex items-baseline justify-between gap-4 border-b ${HAIRLINE} py-2.5`}>
                      <dt className={row.today ? "flex flex-wrap items-baseline gap-x-2 font-bold" : undefined}>
                        {row.day}
                        {row.today ? <span className="text-sm font-medium">{t("hours.today")}</span> : null}
                      </dt>
                      <dd className={`text-right tabular-nums ${row.today ? "font-bold" : row.times.length ? "" : MUTED}`}>
                        {row.times.length ? row.times.map((time) => <span key={time} className="block">{time}</span>) : t("hours.closed")}
                      </dd>
                    </div>
                  ))}
                </dl>
                {closures.length ? (
                  <ul className="flex flex-col gap-2 rounded-[14px] bg-[#F4F4F1] px-4 py-3.5">
                    {closures.map((closure) => (
                      <li key={`${closure.when}${closure.reason}`} className="flex items-start gap-3 text-[15px] leading-[22px]">
                        <CalendarX aria-hidden="true" className="mt-px size-5 flex-none" />
                        <p className="min-w-0">
                          <strong className="font-[650]">{closure.when}</strong>
                          {closure.reason ? <span className="block">{closure.reason}</span> : null}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {profile.services?.length ? (
              <div className="flex min-w-0 flex-col gap-3">
                <h2 id="profile-services" className={SECTION_TITLE}>{t("services.title")}</h2>
                <ul aria-labelledby="profile-services" className={`flex flex-col border-t ${HAIRLINE}`}>
                  {profile.services.map((service, index) => (
                    <li key={`${service.name}-${index}`} className={`flex flex-col gap-1 border-b ${HAIRLINE} py-3.5`}>
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="min-w-0 text-[17px] leading-6 font-[650] tracking-[-0.01em] [overflow-wrap:anywhere]">{serviceName(service, locale)}</span>
                        <span className={`${MUTED} flex-none text-[15px] leading-[22px] tabular-nums`}>{t("services.minutes", { count: service.durationMinutes })}</span>
                      </div>
                      {service.description ? <span className={`${MUTED} text-[15px] leading-[22px]`}>{service.description}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {hasContact ? (
              <div className="flex min-w-0 flex-col gap-3.5">
                <h2 className={SECTION_TITLE}>{profile.address ? t("location.title") : t("location.contactTitle")}</h2>
                {maps && profile.showMap ? (
                  maps.embed ? (
                    <iframe src={maps.embed} title={t("location.map", { address: formatPublicProfileAddress(mappable!) })} loading="lazy" referrerPolicy="strict-origin-when-cross-origin" className="h-[200px] w-full rounded-[20px] border-0 bg-[#ECECE7]" />
                  ) : (
                    <div className="relative h-[200px] overflow-hidden rounded-[20px] bg-[#ECECE7] bg-[linear-gradient(90deg,transparent_0_124px,#fff_124px_132px),linear-gradient(0deg,transparent_0_96px,#fff_96px_104px)] bg-[length:132px_104px]">
                      <div aria-hidden="true" className="absolute -top-[30px] left-[62%] h-[120px] w-[170px] rounded-[22px] bg-[#DDE3D4]" />
                      <div aria-hidden="true" className="absolute -bottom-[110px] -left-[90px] h-[210px] w-[300px] rounded-[50%] bg-[#D5DEE1]" />
                      <div aria-hidden="true" className="absolute top-[52%] -left-[10%] h-3.5 w-[130%] -rotate-[14deg] bg-[#fff] shadow-[0_0_0_1px_#D6D6D2]" />
                      <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" className="absolute top-1/2 left-[46%] -translate-x-1/2 -translate-y-full">
                        <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" fill="#000" stroke="#fff" strokeWidth="1.5" />
                        <circle cx="12" cy="10" r="3" fill="#fff" />
                      </svg>
                      <a href={maps.search} target="_blank" rel="noopener noreferrer" className="absolute right-3 bottom-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-[#D6D6D2] bg-[#fff] px-3.5 text-[15px] font-semibold text-[#000] no-underline">
                        <ExternalLink aria-hidden="true" className="size-4 flex-none" />{t("location.openInMaps")}
                      </a>
                    </div>
                  )
                ) : null}
                <div className={`flex flex-col border-t ${HAIRLINE}`}>
                  {profile.address ? (
                    <ContactRow icon={<MapPin aria-hidden="true" className="size-5 flex-none" />}>
                      <p className="min-w-0 flex-1 py-0.5 text-[17px] leading-6">
                        {addressLines(profile.address).map((line) => <span key={line} className="block">{line}</span>)}
                      </p>
                      <CopyButton text={formatPublicProfileAddress(profile.address, "\n")} label={t("actions.copyAddress")} copiedLabel={t("actions.addressCopied")} className={`inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-xl border ${HAIRLINE} bg-[#fff] text-[#000]`} />
                    </ContactRow>
                  ) : null}
                  {phone ? <ContactRow icon={<Phone aria-hidden="true" className="size-5 flex-none" />}><a href={phone.href} className="text-[17px] leading-6 text-[#000] no-underline tabular-nums">{phone.display}</a></ContactRow> : null}
                  {profile.email ? <ContactRow icon={<Mail aria-hidden="true" className="size-5 flex-none" />}><a href={`mailto:${profile.email}`} className="min-w-0 text-[17px] leading-6 text-[#000] no-underline [overflow-wrap:anywhere]">{profile.email}</a></ContactRow> : null}
                  {website ? <ContactRow icon={<Globe aria-hidden="true" className="size-5 flex-none" />}><a href={website.href} target="_blank" rel="noopener noreferrer" className="min-w-0 text-[17px] leading-6 text-[#000] no-underline [overflow-wrap:anywhere]">{website.host}</a></ContactRow> : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <footer className="mt-auto bg-[#000] text-[#fff]">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-3 px-5 pt-10 pb-7 sm:px-8 lg:px-12">
          <p className="max-w-[72ch] text-[15px] leading-[22px] text-[#C9C9C4]">
            {t("footer.disclosure", { name: profile.name })}
            {person ? <> {person}</> : null}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-x-6 border-t border-[#333] pt-2">
            <p className="flex flex-wrap items-center gap-2 text-[15px] leading-5 font-medium">
              {t("footer.answeredBy")}
              <a href={brand.siteUrl} className="inline-flex min-h-11 items-center gap-1.5 text-[17px] font-bold tracking-[-0.01em] text-[#fff] no-underline">
                {brand.logoSrc ? <img src={brand.logoSrc} alt="" width={22} height={22} className={`size-[22px] flex-none rounded-[5px] object-contain${brand.invertLogo ? " invert" : ""}`} /> : null}
                {brand.appName}
              </a>
            </p>
            <nav aria-label={t("footer.languages")} className="flex flex-wrap gap-x-5">
              {languages.others.map((other) => <LanguageLink key={other} locale={other} name={languageNames[other]} className="inline-flex min-h-11 items-center text-[15px] font-semibold text-[#fff] underline decoration-1 underline-offset-[0.22em]" />)}
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
