import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { businessHours, businesses, createDatabaseClient, phoneNumbers, services } from "@lobbystack/db";

import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };
import profileCopy from "../public/locales/en/profile.json" with { type: "json" };
import frenchProfileCopy from "../public/locales/fr/profile.json" with { type: "json" };
import settings from "../public/locales/en/settings.json" with { type: "json" };
import widgetCopy from "../public/locales/en/widget.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

const password = "Public-Profile-Password-123!";
const prefix = "public-profile";

function migrator() {
  const databaseUrl = process.env.REPLACEMENT_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("The disposable E2E database is required.");
  return createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl });
}

// Removes only this test's user and business, so copies running in parallel keep theirs.
async function removeFixtures(database: ReturnType<typeof migrator>, email: string, businessId: string | undefined): Promise<void> {
  if (businessId) {
    await database.db.execute(sql`delete from public.outbox_messages where business_id = ${businessId}`);
    await database.db.execute(sql`delete from public.businesses where id = ${businessId}`);
  }
  await database.db.execute(sql`delete from public.outbox_messages where aggregate_id in (select id from public.users where email = ${email})`);
  await database.db.execute(sql`delete from public.verifications where identifier = ${`email-verification-otp-${email}`}`);
  await database.db.execute(sql`delete from public.users where email = ${email}`);
}

test("an owner publishes the business's public profile, where visitors read its details and chat, until it's unpublished", async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const database = migrator();
  const email = `${prefix}-${randomUUID()}@example.invalid`;
  const name = `Acme Dental ${randomUUID().slice(0, 8)}`;
  let businessId: string | undefined;
  try {
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
    await page.getByLabel(onboarding.businessName.label).fill(name);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
    await page.getByRole("button", { name: onboarding.businessName.continue }).click();
    businessId = (await (await created).json() as { businessId: string }).businessId;
    // The rest of onboarding has its own journeys; here the business gets hours, a service and a number directly.
    await database.db.update(businesses).set({ onboardingStage: "complete", timezone: "America/Toronto" }).where(eq(businesses.id, businessId));
    await database.db.insert(businessHours).values([1, 2, 3, 4, 5].map((dayOfWeek) => ({ businessId: businessId!, dayOfWeek, openMinutes: 540, closeMinutes: 1020 })));
    await database.db.insert(services).values({ businessId, name: "Check-up", slug: "check-up", durationMinutes: 30, description: "A cleaning and an exam." });
    const e164 = `+1416${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
    await database.db.insert(phoneNumbers).values({ businessId, e164 });
    const slug = (await database.db.select({ slug: businesses.slug }).from(businesses).where(eq(businesses.id, businessId)))[0]!.slug;

    // A website widget for the page's chat.
    const widget = await page.request.post(`/api/widget-keys?businessId=${encodeURIComponent(businessId)}`, {
      headers: { origin: new URL(page.url()).origin },
      data: { label: "Main website", allowedOrigins: ["https://acmedental.example"], config: { title: "Ask Acme" } },
    });
    expect(widget.ok()).toBe(true);
    const widgetKey = (await widget.json() as { key: { key: string } }).key.key;

    // The page doesn't exist for visitors until it's published.
    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    const hidden = await visitorPage.goto(`/profile/${slug}`);
    expect(hidden?.status()).toBe(404);
    await expect(visitorPage.getByRole("heading", { name: profileCopy.notFound.title })).toBeVisible();

    // The settings tab shows its address and offers the widget.
    await page.goto("/settings/usage");
    await page.getByRole("link", { name: settings.sections.publicPage, exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(page.getByText(`/profile/${slug}`)).toBeVisible();
    await expect(page.getByLabel(settings.publicPage.chat.widget)).toHaveValue(/.+/);

    // Members preview the page before it's published, without the chat.
    const preview = await page.context().newPage();
    await preview.goto(`/profile/${slug}`);
    await expect(preview.getByText(profileCopy.preview.banner)).toBeVisible();
    await expect(preview.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(preview.getByText(profileCopy.preview.chat)).toBeVisible();
    await preview.close();

    await page.getByLabel(settings.publicPage.details.category).fill("Dental clinic");
    await page.getByLabel(settings.publicPage.details.line1).fill("123 Main St");
    await page.getByLabel(settings.publicPage.details.city).fill("Toronto");
    await page.getByLabel(settings.publicPage.details.region).fill("ON");
    await page.getByLabel(settings.publicPage.details.country).selectOption("CA");
    await page.getByRole("switch", { name: settings.publicPage.publish.label }).click();
    const saved = page.waitForResponse((response) => response.url().includes("/api/business-profile?") && response.request().method() === "PUT");
    await page.getByRole("button", { name: settings.publicPage.save, exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: settings.publicPage.saved })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("public-profile-settings.png"), fullPage: true });

    // Visitors now see the business, its hours, services and location, and chat with it in the page.
    const live = await visitorPage.goto(`/profile/${slug}`);
    expect(live?.status()).toBe(200);
    expect(live?.headers()["content-security-policy"]).toContain("https://www.google.com");
    await expect(visitorPage.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(visitorPage.getByText("Dental clinic · Toronto")).toBeVisible();
    await expect(visitorPage.getByRole("heading", { name: profileCopy.hours.title })).toBeVisible();
    await expect(visitorPage.getByText("Check-up", { exact: true }).first()).toBeVisible();
    await expect(visitorPage.getByText("123 Main St")).toBeVisible();
    await expect(visitorPage.locator(`a[href="tel:${e164}"]`).first()).toBeVisible();
    expect(await visitorPage.locator('script[type="application/ld+json"]').textContent()).toContain(`"name":"${name}"`);
    const chat = visitorPage.frameLocator("#profile-chat iframe");
    await expect(chat.getByRole("textbox", { name: widgetCopy.chat.composerPlaceholder, exact: true })).toBeEnabled();
    await expect(chat.getByText(widgetCopy.errors.originDenied)).toHaveCount(0);
    expect(await visitorPage.locator(`script[src="/embed.js?key=${widgetKey}"]`).count()).toBe(1);
    // The chat sits in the page, not in a bubble.
    await expect(visitorPage.getByRole("button", { name: "Open chat", exact: true })).toHaveCount(0);
    await visitorPage.setViewportSize({ width: 1440, height: 1000 });
    await visitorPage.screenshot({ path: testInfo.outputPath("public-profile-desktop.png"), fullPage: true });
    await visitorPage.setViewportSize({ width: 390, height: 844 });
    await visitorPage.screenshot({ path: testInfo.outputPath("public-profile-phone.png"), fullPage: true });

    // The page offers its other languages.
    await visitorPage.getByRole("link", { name: "Français" }).first().click();
    await expect(visitorPage.getByRole("heading", { name: frenchProfileCopy.hours.title })).toBeVisible();

    // Unpublishing takes the page down on the next request.
    await page.getByRole("switch", { name: settings.publicPage.publish.label }).click();
    const unpublished = page.waitForResponse((response) => response.url().includes("/api/business-profile?") && response.request().method() === "PUT");
    await page.getByRole("button", { name: settings.publicPage.save, exact: true }).click();
    expect((await unpublished).ok()).toBe(true);
    const gone = await visitorPage.goto(`/profile/${slug}`);
    expect(gone?.status()).toBe(404);
    // The widget no longer answers on the page's origin.
    const session = await visitorPage.request.post("/api/widget/session", { headers: { origin: new URL(visitorPage.url()).origin }, data: { widgetKey, visitorId: randomUUID() } });
    expect(session.status()).toBe(403);
    await visitor.close();
  } finally {
    await removeFixtures(database, email, businessId);
    await database.pool.end();
  }
});
