import { BrandWordmark } from "@/components/brand-mark"
import { buttonVariants } from "@/components/ui/button"
import {
  localizeMarketingHref,
  type MarketingLocale,
} from "@/lib/marketing-site-url"
import { cn } from "@/lib/utils"
import { localizePublicPath } from "@/lib/locale-path"

const labels = {
  en: { login: "Log in", tryFree: "Try for free" },
  fr: { login: "Connexion", tryFree: "Essayer gratuitement" },
  es: { login: "Iniciar sesión", tryFree: "Pruébelo gratis" },
  sr: { login: "Prijava", tryFree: "Isprobajte besplatno" },
} satisfies Record<MarketingLocale, Record<string, string>>

type LandingNavbarProps = {
  locale?: MarketingLocale
  /** Shown left of the logo, such as the screen's help button. */
  start?: React.ReactNode
}

/**
 * Marketing header for the public demo page: logo back to the site, plus
 * sign-in and sign-up links. On a phone the sign-in link gives way, so the
 * logo keeps room beside the help button and the sign-up link; a long name
 * ends in an ellipsis rather than running into the links. The logo's side is
 * a container, so the name can give way to the logo where too little of it
 * would show.
 */
export function LandingNavbar({ locale = "en", start }: LandingNavbarProps) {
  const copy = labels[locale]

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-6">
        <div className="@container flex min-w-0 flex-1 items-center gap-2">
          {start}
          <a
            href={localizeMarketingHref(locale, "/")}
            className="flex min-w-0 items-center overflow-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <BrandWordmark />
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <a
            href={localizePublicPath("/login", locale)}
            className="hidden rounded-md text-sm font-medium whitespace-nowrap text-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:inline"
          >
            {copy.login}
          </a>
          <a
            href={localizePublicPath("/signup", locale)}
            className={cn(buttonVariants(), "rounded-full px-5")}
            data-ph-signup-cta
            data-ph-capture-attribute-section="navbar"
            data-ph-capture-attribute-action="try_for_free"
            data-ph-capture-attribute-destination="/signup"
          >
            {copy.tryFree}
          </a>
        </div>
      </div>
    </header>
  )
}
