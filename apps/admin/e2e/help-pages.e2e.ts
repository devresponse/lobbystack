import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { businesses, createDatabaseClient } from "@lobbystack/db";

import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };
import { helpArticles } from "../src/lib/help/registry";

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

// The help center: one page per screen, the index, the Markdown file for AI
// assistants, and the panel the question mark opens beside a screen.

const articles = helpArticles("en");
const password = "Help-Pages-Password-123!";

function migrator() {
  const databaseUrl = process.env.REPLACEMENT_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("The disposable E2E database is required.");
  return createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl });
}

type Database = ReturnType<typeof migrator>;

/** Signs up, names the business, and skips the rest of onboarding, which has its own journeys. */
async function signUpWithBusiness(page: Page, testInfo: TestInfo, database: Database, email: string): Promise<string> {
  await page.addInitScript(() => localStorage.setItem("lobbystack.locale", "en"));
  await isolateAuthRateLimit(page, email, testInfo);
  await page.goto("/en/signup");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  const signedUp = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-up/email") && response.request().method() === "POST");
  await page.locator('button[type="submit"]').click();
  expect((await signedUp).ok()).toBe(true);
  await completeSignupEmailVerification(page, email, password);
  await expect(page).toHaveURL(/\/onboarding\/business$/);
  await page.getByLabel(onboarding.businessName.label).fill(`Help Desk ${randomUUID().slice(0, 8)}`);
  const created = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
  await page.getByRole("button", { name: onboarding.businessName.continue }).click();
  const businessId = (await (await created).json() as { businessId: string }).businessId;
  await database.db.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, businessId));
  return businessId;
}

// Removes only this test's user and business, so copies running in parallel keep theirs.
async function removeFixtures(database: Database, email: string, businessId: string | undefined): Promise<void> {
  if (businessId) {
    await database.db.execute(sql`delete from public.outbox_messages where business_id = ${businessId}`);
    await database.db.execute(sql`delete from public.businesses where id = ${businessId}`);
  }
  await database.db.execute(sql`delete from public.outbox_messages where aggregate_id in (select id from public.users where email = ${email})`);
  await database.db.execute(sql`delete from public.verifications where identifier = ${`email-verification-otp-${email}`}`);
  await database.db.execute(sql`delete from public.users where email = ${email}`);
}

/** The text of a page's first-level heading, from its HTML. */
function headingText(html: string): string | undefined {
  const inner = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1];
  return inner?.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

test("serves the help index with every page, and a page for every screen", async ({ page }) => {
  await page.goto("/en/help");
  await expect(page.getByRole("heading", { level: 1, name: "Help center" })).toBeVisible();
  for (const article of articles) {
    await expect(page.locator(`main a[href="/en/help/${article.slug}"]`)).toContainText(article.title);
  }

  for (const article of articles) {
    const response = await page.request.get(`/en/help/${article.slug}`);
    expect(response.status(), article.slug).toBe(200);
    const html = await response.text();
    expect(html, article.slug).toContain(`lang="en"`);
    expect(headingText(html), article.slug).toBe(article.title);
  }
  expect((await page.request.get("/en/help/no-such-page")).status()).toBe(404);
});

test("shows a help page's parts in order, with links to related help", async ({ page }) => {
  await page.goto("/en/help/rules");
  await expect(page.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings.slice(0, 2)).toEqual(["What this screen is for", "What you see"]);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Help center" })).toHaveAttribute("href", "/en/help");
  await expect(page.getByRole("region", { name: "Related help" }).getByRole("link", { name: /^Knowledge/ })).toHaveAttribute("href", "/en/help/knowledge");
});

test("sends help addresses in other languages to English, for now", async ({ page }) => {
  const response = await page.request.get("/fr/help/rules", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toBe("/en/help/rules");

  const legacy = await page.request.get("/help", { maxRedirects: 0, headers: { "accept-language": "fr-CA,fr;q=0.9" } });
  expect(legacy.status()).toBe(308);
  expect(legacy.headers().location).toBe("/en/help");
});

test("exports every help page in one Markdown file", async ({ page }) => {
  const response = await page.request.get("/en/help.md");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/markdown");
  const markdown = await response.text();
  for (const article of articles) expect(markdown).toContain(`\n# ${article.title}\n`);
});

test("opens the screen's help beside it from the question mark, and closes it", async ({ page }) => {
  await page.goto("/en/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  await page.getByRole("button", { name: "Help for this screen", exact: true }).click();
  const panel = page.getByRole("dialog");
  await expect(panel.getByRole("heading", { level: 2, name: "Log in" })).toBeVisible();
  await expect(panel.getByRole("link", { name: /Open in a new tab/ })).toHaveAttribute("href", "/en/help/log-in");
  // About a third of a large screen, at its left edge once it has slid in.
  await expect.poll(async () => Math.round((await panel.boundingBox())?.x ?? -1)).toBe(0);
  const box = await panel.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(448);
  expect(box?.width ?? 0).toBeLessThanOrEqual(640);

  // The title has the focus, and the keys that scroll a page work from it.
  const title = panel.getByRole("heading", { level: 2, name: "Log in" });
  await expect(title).toBeFocused();
  await page.keyboard.press("PageDown");
  await expect.poll(() => title.evaluate((heading) => heading.closest(".overflow-y-auto")?.scrollTop ?? 0)).toBeGreaterThan(0);
  await expect(title).toBeInViewport();

  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("keeps the help panel's header clear of the page it scrolls over", async ({ page }) => {
  await page.goto("/en/login");
  await page.getByRole("button", { name: "Help for this screen", exact: true }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("button", { name: "All help topics", exact: true }).click();
  const title = panel.getByRole("heading", { level: 2, name: "Help center" });
  await expect(title).toBeFocused();

  const scroller = panel.locator(".overflow-y-auto");
  const measure = () => scroller.evaluate((element) => {
    const header = element.querySelector<HTMLElement>('[data-slot="sheet-header"]');
    return { scrollTop: element.scrollTop, clientHeight: element.clientHeight, headerHeight: header?.offsetHeight ?? 0 };
  });

  // Page Down moves by no more than what shows under the header, so no line is skipped.
  const start = await measure();
  await page.keyboard.press("PageDown");
  await expect.poll(async () => (await measure()).scrollTop).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect((await measure()).scrollTop - start.scrollTop).toBeLessThanOrEqual(start.clientHeight - start.headerHeight);

  // Going back up the topics from the keyboard, the focused one is never under the header.
  await panel.getByRole("link", { name: /Open in a new tab/ }).focus();
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Shift+Tab");
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      const header = active.closest('[role="dialog"]')?.querySelector('[data-slot="sheet-header"]');
      return { inHeader: Boolean(header?.contains(active)), top: active.getBoundingClientRect().top, headerBottom: header?.getBoundingClientRect().bottom ?? 0, name: active.textContent ?? "" };
    });
    if (focused.inHeader) break;
    expect(focused.top, focused.name).toBeGreaterThanOrEqual(focused.headerBottom - 1);
  }

  // The header's own controls are always in view, so taking the focus doesn't move the page.
  await scroller.evaluate((element) => { element.scrollTop = 600; });
  const scrolled = (await measure()).scrollTop;
  expect(scrolled).toBeGreaterThan(0);
  await panel.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Back", exact: true })).toBeFocused();
  expect((await measure()).scrollTop).toBe(scrolled);
  const titleBox = await title.boundingBox();
  await page.mouse.click((titleBox?.x ?? 0) + 8, (titleBox?.y ?? 0) + (titleBox?.height ?? 0) / 2);
  await expect(title).toBeFocused();
  expect((await measure()).scrollTop).toBe(scrolled);
});

test("keeps the help panel readable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en/signup");

  await page.getByRole("button", { name: "Help for this screen", exact: true }).click();
  const panel = page.getByRole("dialog");
  await expect(panel.getByRole("heading", { level: 2, name: "Sign up" })).toBeVisible();
  // All but a strip of the screen, which stays in view and closes the panel when tapped.
  await expect.poll(async () => Math.round((await panel.boundingBox())?.x ?? -1)).toBe(0);
  expect(Math.round((await panel.boundingBox())?.width ?? 0)).toBe(390 - 56);
  await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await page.mouse.click(372, 422);
  await expect(panel).toBeHidden();
});

test("opens a dashboard screen's help from the question mark at its top left, on a large screen and a phone", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const database = migrator();
  const email = `help-pages-${randomUUID()}@example.invalid`;
  let businessId: string | undefined;
  try {
    businessId = await signUpWithBusiness(page, testInfo, database, email);

    await page.goto("/agent/rules");
    const help = page.getByRole("button", { name: "Help for this screen", exact: true });
    await expect(help).toBeVisible();
    // Left of the screen's content and in its top bar, away from the business's own tools on the right.
    const desktopBox = await help.boundingBox();
    expect(desktopBox?.x ?? Infinity).toBeLessThan(1280 / 2);
    expect(desktopBox?.y ?? Infinity).toBeLessThan(64);

    await help.click();
    const panel = page.getByRole("dialog");
    await expect(panel.getByRole("heading", { level: 2, name: "Rules" })).toBeVisible();
    await expect(panel.getByRole("link", { name: /Open in a new tab/ })).toHaveAttribute("href", "/en/help/rules");
    // A related page opens in the panel, and Back returns to the screen's own.
    await panel.getByRole("region", { name: "Related help" }).getByRole("button", { name: /^Knowledge/ }).click();
    await expect(panel.getByRole("heading", { level: 2, name: "Knowledge" })).toBeVisible();
    await panel.getByRole("button", { name: "Back", exact: true }).click();
    await expect(panel.getByRole("heading", { level: 2, name: "Rules" })).toBeVisible();
    // So does the list of every topic.
    await panel.getByRole("button", { name: "All help topics", exact: true }).click();
    await expect(panel.getByRole("heading", { level: 2, name: "Help center" })).toBeVisible();
    await panel.getByRole("button", { name: "Back", exact: true }).click();
    await expect(panel.getByRole("heading", { level: 2, name: "Rules" })).toBeVisible();
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).toBeHidden();

    // On a phone, beside the menu button.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/agent/knowledge");
    await expect(help).toBeVisible();
    const phoneBox = await help.boundingBox();
    expect(phoneBox?.x ?? Infinity).toBeLessThan(390 / 3);
    expect(phoneBox?.y ?? Infinity).toBeLessThan(64);
    await help.click();
    await expect(panel.getByRole("heading", { level: 2, name: "Knowledge" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  } finally {
    await removeFixtures(database, email, businessId);
    await database.pool.end();
  }
});
