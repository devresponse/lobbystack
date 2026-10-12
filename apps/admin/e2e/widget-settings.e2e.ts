import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { businesses, conversations, createDatabaseClient, widgetKeys } from "@lobbystack/db";

import messagesCopy from "../public/locales/en/messages.json" with { type: "json" };
import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };
import settings from "../public/locales/en/settings.json" with { type: "json" };
import widgetCopy from "../public/locales/en/widget.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";
import { startWidgetProvider } from "./fixtures/widget-provider";

const password = "Widget-Settings-Password-123!";
const prefix = "widget-settings";
const hostOrigin = "http://localhost:18090";

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

async function sessionStatus(request: APIRequestContext, widgetKey: string, origin = hostOrigin): Promise<number> {
  const response = await request.post("/api/widget/session", { headers: { origin }, data: { widgetKey, visitorId: randomUUID() } });
  return response.status();
}

test("the sidebar opens widget settings, where an owner creates, edits, pauses and revokes a widget that works on their site", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const database = migrator();
  const email = `${prefix}-${randomUUID()}@example.invalid`;
  let businessId: string | undefined;
  let provider: Awaited<ReturnType<typeof startWidgetProvider>> | undefined;
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
    await page.getByLabel(onboarding.businessName.label).fill(`Widget Settings ${randomUUID().slice(0, 8)}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
    await page.getByRole("button", { name: onboarding.businessName.continue }).click();
    businessId = (await (await created).json() as { businessId: string }).businessId;
    // The rest of onboarding has its own journeys; the dashboard opens once it's complete.
    await database.db.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, businessId));

    // The sidebar links the widget settings from any page, and only that item is active there.
    await page.goto("/");
    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByRole("link", { name: settings.sections.widget, exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/widget$/);
    await expect(sidebar.getByRole("link", { name: settings.sections.widget, exact: true })).toHaveAttribute("data-active", "");
    await expect(page.getByText(settings.widget.keys.empty, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("widget-settings-empty.png"), fullPage: true });

    // Create a widget key for the host site.
    const form = page.locator('[data-slot="card"]').filter({ hasText: settings.widget.create.title });
    await form.getByLabel(settings.widget.fields.label, { exact: true }).fill("Main website");
    await form.getByLabel(settings.widget.fields.origins, { exact: true }).fill(hostOrigin);
    await form.getByLabel(settings.widget.fields.title, { exact: true }).fill("Ask the shop");
    await form.getByLabel(settings.widget.fields.greeting, { exact: true }).fill("Hello from the shop.");
    // A select's accessible name also carries its chosen option, so match the label's start.
    await form.getByRole("combobox", { name: new RegExp(`^${settings.widget.fields.position}`) }).selectOption("bottom-left");
    const createdKey = page.waitForResponse((response) => response.url().includes("/api/widget-keys?") && response.request().method() === "POST");
    await form.getByRole("button", { name: settings.widget.create.action, exact: true }).click();
    expect((await createdKey).ok()).toBe(true);
    await expect(page.getByText(settings.widget.created.title, { exact: true })).toBeVisible();
    const widgetKey = (await page.locator("code").filter({ hasText: /^wk_live_/ }).innerText()).trim();
    const snippet = await page.locator("pre").filter({ hasText: "embed.js" }).innerText();
    expect(snippet).toContain(`data-widget-key="${widgetKey}"`);
    expect(snippet).toContain('data-position="bottom-left"');
    await page.screenshot({ path: testInfo.outputPath("widget-settings-created.png"), fullPage: true });
    await page.getByRole("button", { name: settings.widget.created.done, exact: true }).click();

    const row = async () => (await database.db.select().from(widgetKeys).where(eq(widgetKeys.businessId, businessId!)))[0];
    expect(await row()).toMatchObject({ label: "Main website", status: "active", allowedOrigins: [hostOrigin], config: expect.objectContaining({ title: "Ask the shop", greeting: "Hello from the shop.", position: "bottom-left" }) });

    // Only the allowed origin gets a session.
    expect(await sessionStatus(request, widgetKey)).toBe(200);
    expect(await sessionStatus(request, widgetKey, "https://untrusted.example.invalid")).toBe(403);

    // Edit the saved key.
    const editor = page.locator("article").filter({ hasText: "Main website" });
    await editor.getByLabel(settings.widget.fields.title, { exact: true }).fill("Ask us anything");
    const saved = page.waitForResponse((response) => response.url().includes("/api/widget-keys?") && response.request().method() === "PATCH");
    await editor.getByRole("button", { name: settings.widget.keys.save, exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(editor.getByText(settings.widget.keys.saved, { exact: true })).toBeVisible();
    await expect.poll(async () => (await row())?.config).toMatchObject({ title: "Ask us anything", greeting: "Hello from the shop." });

    // Pausing stops new sessions and resuming brings them back.
    await editor.getByRole("button", { name: settings.widget.keys.pause, exact: true }).click();
    await expect(editor.getByText(settings.widget.status.disabled, { exact: true })).toBeVisible();
    expect(await sessionStatus(request, widgetKey)).not.toBe(200);
    await editor.getByRole("button", { name: settings.widget.keys.resume, exact: true }).click();
    await expect(editor.getByText(settings.widget.status.active, { exact: true })).toBeVisible();
    expect(await sessionStatus(request, widgetKey)).toBe(200);

    // With the local AI endpoint, a visitor chats on the host site and the owner reads it in Messages.
    if (process.env.WIDGET_E2E === "1") {
      provider = await startWidgetProvider();
      const host = await page.context().newPage();
      await host.goto(`${hostOrigin}/widget-host?key=${encodeURIComponent(widgetKey)}`);
      await host.getByRole("button", { name: "Open chat", exact: true }).click();
      const frame = host.frameLocator('iframe[title="Chat with us"]');
      await expect(frame.getByText("Ask us anything", { exact: true })).toBeVisible();
      const composer = frame.getByRole("textbox", { name: widgetCopy.chat.composerPlaceholder, exact: true });
      await expect(composer).toBeEnabled();
      await composer.fill("What are your opening hours?");
      await composer.press("Enter");
      await expect(frame.getByText("We are open weekdays.", { exact: true })).toBeVisible();
      await host.close();
      await expect.poll(async () => (await database.db.select().from(conversations).where(and(eq(conversations.businessId, businessId!), eq(conversations.channel, "web_chat")))).length).toBe(1);

      await sidebar.getByRole("link", { name: messagesCopy.page.title, exact: true }).click();
      await expect(page).toHaveURL(/\/messages$/);
      await page.getByRole("button", { name: messagesCopy.page.filterWeb, exact: true }).click();
      await expect(page.getByText("We are open weekdays.").first()).toBeVisible();
      await page.goto("/settings/widget");
    }

    // Revoking is final.
    const revokeEditor = page.locator("article").filter({ hasText: "Ask us anything" }).or(page.locator("article").filter({ hasText: "Main website" })).first();
    page.once("dialog", (dialog) => void dialog.accept());
    await revokeEditor.getByRole("button", { name: settings.widget.keys.revoke, exact: true }).click();
    await expect(revokeEditor.getByText(settings.widget.status.revoked, { exact: true })).toBeVisible();
    expect((await row())?.status).toBe("revoked");
    expect(await sessionStatus(request, widgetKey)).not.toBe(200);
  } finally {
    if (provider) await new Promise<void>((resolve, reject) => provider!.server.close((error) => error ? reject(error) : resolve()));
    await removeFixtures(database, email, businessId);
    await database.pool.end();
  }
});
