import { expect, test, type Page, type Response } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { createDatabaseClient } from "@lobbystack/db";

import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

// Runs against the two servers playwright.script-nonce.config.ts starts, one
// for each step of the script nonce (AUDIT-008, docs/development/README.md):
// the project named "reporting" has CSP_SCRIPT_NONCE, and "enforced" has
// CSP_SCRIPT_NONCE_ENFORCED as well. A unit test can say what the proxy sends.
// Only a browser can say whether Next put the nonce on the scripts it wrote,
// whether the page still works, and whether an injected script still runs.

const password = "Script-Nonce-Password-123!";
const prefix = "script-nonce";

/** One thing a policy blocked, or would have: "enforce script-src-attr inline /calls". */
type PolicyReport = string;

/** Everything the browser says a policy blocked, or would have, in any page or frame this one opens. */
async function policyReports(page: Page): Promise<PolicyReport[]> {
  const reports: PolicyReport[] = [];
  await page.exposeFunction("reportPolicyViolation", (report: PolicyReport) => { reports.push(report); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      // A frame written into the page has no address of its own: the browser calls it "about".
      const where = event.documentURI.startsWith("http") ? new URL(event.documentURI).pathname : event.documentURI;
      void (window as unknown as { reportPolicyViolation: (report: PolicyReport) => Promise<void> })
        .reportPolicyViolation(`${event.disposition} ${event.effectiveDirective} ${event.blockedURI} ${where}`);
    });
  });
  return reports;
}

// zod asks whether it may use `eval` as each page loads, and every policy the
// admin has ever sent says no. That refusal is not the nonce's, so it is the
// one report left out here; the report-only policy doesn't make it at all.
// A browser may report one thing twice, so each kind of report is read once.
const worthReading = (reports: PolicyReport[]) => [...new Set(reports)].filter((report) => !report.startsWith("enforce script-src eval ")).sort();

const scriptSources = (policy: string | undefined, directive = "script-src") =>
  (policy ?? "").split("; ").find((entry) => entry.startsWith(`${directive} `)) ?? "";

// A browser reads <SCRIPT> as it reads <script>, so a tag in any case has to carry the nonce.
async function scriptTags(response: Response | null): Promise<string[]> {
  return [...(await response!.text()).matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
}

async function removeFixtures(email: string, businessId: string | undefined): Promise<void> {
  const databaseUrl = process.env.REPLACEMENT_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("The disposable E2E database is required.");
  const database = createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl });
  try {
    if (businessId) {
      await database.db.execute(sql`delete from public.outbox_messages where business_id = ${businessId}`);
      await database.db.execute(sql`delete from public.businesses where id = ${businessId}`);
    }
    await database.db.execute(sql`delete from public.outbox_messages where aggregate_id in (select id from public.users where email = ${email})`);
    await database.db.execute(sql`delete from public.verifications where identifier = ${`email-verification-otp-${email}`}`);
    await database.db.execute(sql`delete from public.users where email = ${email}`);
  } finally {
    await database.pool.end();
  }
}

test("a page keeps working under the nonce, and markup a stranger added does not run", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const enforced = testInfo.project.name === "enforced";
  const reports = await policyReports(page);
  const email = `${prefix}-${randomUUID()}@example.invalid`;
  let businessId: string | undefined;
  try {
    await page.addInitScript(() => localStorage.setItem("lobbystack.locale", "en"));
    await isolateAuthRateLimit(page, email, testInfo);

    // A sign-in page is built ahead of time, so Next has no request in which to
    // put a nonce on its scripts. It keeps the policy it had, in both steps.
    const signIn = await page.goto("/en/login");
    expect(scriptSources(signIn?.headers()["content-security-policy"])).toMatch(/^script-src 'self' 'unsafe-inline' /);
    expect(signIn?.headers()["content-security-policy"]).not.toContain("nonce-");
    expect(signIn?.headers()["content-security-policy-report-only"]).toBeUndefined();
    expect(signIn?.headers()["cache-control"]).toContain("public");

    // Signing up there is the page's own scripts at work.
    await page.goto("/en/signup");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    const signedUp = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-up/email") && response.request().method() === "POST");
    await page.locator('button[type="submit"]').click();
    expect((await signedUp).ok()).toBe(true);
    await completeSignupEmailVerification(page, email, password);
    await expect(page).toHaveURL(/\/onboarding\/business$/);

    // Onboarding is rendered for this request. Its policy names a nonce, and
    // every script Next wrote into the page carries that nonce.
    const first = await page.goto("/onboarding/business");
    const headers = first!.headers();
    const strict = headers[enforced ? "content-security-policy" : "content-security-policy-report-only"];
    const nonce = /'nonce-([^']+)'/.exec(scriptSources(strict))?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(scriptSources(strict)).toContain(`'nonce-${nonce}' 'strict-dynamic'`);
    expect(scriptSources(strict)).not.toContain("'unsafe-inline'");
    expect(headers["cache-control"]).toBe("private, no-store");
    if (enforced) {
      expect(headers["content-security-policy-report-only"]).toBeUndefined();
    } else {
      // Still asked about 'unsafe-inline', so nothing new is blocked yet.
      expect(scriptSources(headers["content-security-policy"], "script-src-elem")).toMatch(/^script-src-elem 'self' 'unsafe-inline' /);
      expect(scriptSources(headers["content-security-policy"], "script-src-attr")).toBe("script-src-attr 'unsafe-inline'");
    }
    const tags = await scriptTags(first);
    expect(tags.length).toBeGreaterThan(5);
    expect(tags.filter((tag) => !tag.includes(`nonce="${nonce}"`))).toEqual([]);

    // The next request gets a nonce of its own.
    const second = await page.goto("/onboarding/business");
    const again = second!.headers()[enforced ? "content-security-policy" : "content-security-policy-report-only"];
    expect(/'nonce-([^']+)'/.exec(scriptSources(again))?.[1]).not.toBe(nonce);

    // The page works: its own script sends the form.
    await page.getByLabel(onboarding.businessName.label).fill(`Nonce Check ${randomUUID().slice(0, 8)}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
    await page.getByRole("button", { name: onboarding.businessName.continue }).click();
    const creation = await created;
    expect(creation.ok()).toBe(true);
    businessId = (await creation.json() as { businessId: string }).businessId;
    await expect(page).not.toHaveURL(/\/onboarding\/business$/);
    await page.waitForLoadState("networkidle");

    // Through all of that, neither policy had anything to say.
    expect(worthReading(reports)).toEqual([]);

    // Now what a cross-site scripting hole lets a stranger add, which is
    // markup: an inline handler, a javascript: link, and a frame whose own
    // markup holds a script. (A script element made by a script that is
    // already running is that script's doing, and 'strict-dynamic' lets it
    // through on purpose.)
    await page.evaluate(async () => {
      const holder = document.createElement("div");
      holder.innerHTML = [
        '<button onclick="window.injectedHandler = true"></button>',
        '<a href="javascript:void(window.injectedLink = true)"></a>',
        '<iframe srcdoc="<script>parent.injectedFrame = true</script>"></iframe>',
      ].join("");
      document.body.append(holder);
      holder.querySelector("button")!.click();
      holder.querySelector("a")!.click();
      await new Promise((resolve) => holder.querySelector("iframe")!.addEventListener("load", resolve, { once: true }));
    });
    // The policy has something to say about each of the three, and nothing else.
    const step = enforced ? "enforce" : "report";
    const path = new URL(page.url()).pathname;
    await expect.poll(() => worthReading(reports)).toEqual([
      `${step} script-src-attr inline ${path}`,
      `${step} script-src-elem inline ${path}`,
      `${step} script-src-elem inline about`,
    ].sort());
    // Enforced, none of the three ran. Reported on, all three still do.
    const ran = await page.evaluate(() => {
      const marks = window as unknown as { injectedHandler?: boolean; injectedLink?: boolean; injectedFrame?: boolean };
      return { handler: marks.injectedHandler === true, link: marks.injectedLink === true, frame: marks.injectedFrame === true };
    });
    expect(ran).toEqual({ handler: !enforced, link: !enforced, frame: !enforced });

    // An address nothing answers gets Next's own 404, which is built ahead of
    // time as well, so its scripts carry no nonce. It still says what it has to.
    const missing = await page.goto("/no-such-page");
    expect(missing?.status()).toBe(404);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
  } finally {
    await removeFixtures(email, businessId);
  }
});
