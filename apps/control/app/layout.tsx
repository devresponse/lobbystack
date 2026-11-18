import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Nav } from "@/components/nav";
import { displayVersion } from "@/lib/config";
import { database } from "@/lib/db";
import { deploymentName } from "@/lib/queries";
import { currentAdmin } from "@/lib/session";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Control panel", template: "%s · Control panel" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const admin = await currentAdmin();
  // The deployment's name, from the branding its operator saved; a database that
  // can't be reached shows up on the page itself.
  const name = await database().then(deploymentName).catch(() => null);
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="brand">
            <strong>Control panel</strong>
            <span>{name ?? "LobbyStack"}</span>
          </div>
          <Nav />
          <div className="who">
            {admin} · <a href="/cdn-cgi/access/logout">Sign out</a>
          </div>
        </header>
        <main>{children}</main>
        <footer>Read-only. Times and months are UTC. Version {displayVersion()}.</footer>
      </body>
    </html>
  );
}
