"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { href: "/", label: "Overview" },
  { href: "/businesses", label: "Businesses" },
  { href: "/accounts", label: "Accounts" },
  { href: "/usage", label: "Usage" },
  { href: "/billing", label: "Billing" },
];

/** The section links, the current one marked. The panel's only client component. */
export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Sections">
      {SECTIONS.map((section) => {
        const current = section.href === "/" ? pathname === "/" : pathname === section.href || pathname.startsWith(`${section.href}/`);
        return (
          <Link key={section.href} href={section.href} aria-current={current ? "page" : undefined}>
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
