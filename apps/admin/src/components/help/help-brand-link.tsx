"use client";

import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { useBranding } from "@/components/branding-provider";

const brandClass = "w-auto justify-start";

/**
 * The deployment's name and logo at the top of a help page, as a link home.
 * Until the name is known its space stays empty and is no link, so the first
 * stop for the keyboard is never a link without a name.
 */
export function HelpBrandLink() {
  const { ready } = useBranding();
  if (!ready) return <BrandMark className={brandClass} />;
  return (
    <Link className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" href="/">
      <BrandMark className={brandClass} />
    </Link>
  );
}
