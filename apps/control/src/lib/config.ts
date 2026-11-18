/**
 * The panel's settings, all from the environment (docs/features/control-panel.md).
 * The bootstrap script sets them on the control service.
 */

type Environment = Record<string, string | undefined>;

export type AccessSettings = {
  /** The Cloudflare Zero Trust team domain that signs the tokens, such as example.cloudflareaccess.com. */
  teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  audience: string;
  /** Who may use the panel, in lower case. Cloudflare Access lets them through first. */
  adminEmails: ReadonlySet<string>;
};

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** The emails in a list separated by commas, spaces or semicolons, in lower case. */
export function parseEmails(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean);
}

/**
 * The Cloudflare Access settings, or why they can't be used. The panel answers
 * every page with 503 until all three are right, so a deployment that is
 * missing one is closed rather than open.
 */
export function accessSettings(env: Environment = process.env): AccessSettings | { problem: string } {
  const teamDomain = (env.CONTROL_ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (!TEAM_DOMAIN.test(teamDomain)) return { problem: "CONTROL_ACCESS_TEAM_DOMAIN must be the Zero Trust team domain, such as example.cloudflareaccess.com." };
  const audience = (env.CONTROL_ACCESS_AUD ?? "").trim();
  if (!AUDIENCE.test(audience)) return { problem: "CONTROL_ACCESS_AUD must be the Access application's audience (AUD) tag." };
  const emails = parseEmails(env.CONTROL_ADMIN_EMAILS);
  if (!emails.length) return { problem: "CONTROL_ADMIN_EMAILS must name at least one email." };
  const wrong = emails.filter((email) => !EMAIL.test(email));
  if (wrong.length) return { problem: `CONTROL_ADMIN_EMAILS holds ${wrong.length === 1 ? "something that isn't an email" : "things that aren't emails"}.` };
  return { teamDomain, audience, adminEmails: new Set(emails) };
}

/**
 * Who the panel treats as signed in on a developer's computer, where Cloudflare
 * Access isn't in front of it: CONTROL_DEV_ADMIN_EMAIL, and only outside a
 * production build. `next build` writes "production" in place of NODE_ENV, so a
 * deployed panel never reads the variable.
 */
export function developmentAdmin(env: Environment = process.env): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const email = (env.CONTROL_DEV_ADMIN_EMAIL ?? "").trim().toLowerCase();
  return EMAIL.test(email) ? email : null;
}

/** The short commit the panel was built from, for the footer. */
export function displayVersion(env: Environment = process.env): string {
  const commit = env.RAILWAY_GIT_COMMIT_SHA || env.SERVICE_VERSION || "";
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : "development";
}
