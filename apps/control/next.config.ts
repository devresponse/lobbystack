import type { NextConfig } from "next";

const development = process.env.NODE_ENV !== "production";

// The panel shows every account's email and phone number, so nothing it sends is
// cached, framed, indexed or sent on to another site.
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js writes the page's data into inline scripts; the development server also evaluates code.
      `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": ["./.next/dev/**/*", "./.next/cache/**/*", "./.next/standalone/**/*"],
  },
  poweredByHeader: false,
  // One copy, few readers, and every page reads the database fresh.
  cacheMaxMemorySize: 0,
  headers: () =>
    Promise.resolve([
      { source: "/:path*", headers: securityHeaders },
      { source: "/((?!_next/static/).*)", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ]),
};

export default nextConfig;
