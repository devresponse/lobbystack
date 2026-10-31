import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";

import { auditLogs, businesses, contacts, conversations, createDatabaseClient, messages } from "@lobbystack/db";

import messageCopy from "../public/locales/en/messages.json" with { type: "json" };
import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

const password = "Message-Archive-Password-123!";
const prefix = "message-archive";
const copy = messageCopy.page.archive;

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

test("an owner archives a conversation only after confirming, finds it under Archived and restores it", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const database = migrator();
  const email = `${prefix}-${randomUUID()}@example.invalid`;
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
    await page.getByLabel(onboarding.businessName.label).fill(`Message Archive ${randomUUID().slice(0, 8)}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
    await page.getByRole("button", { name: onboarding.businessName.continue }).click();
    businessId = (await (await created).json() as { businessId: string }).businessId;
    // The rest of onboarding has its own journeys; the dashboard opens once it's complete.
    await database.db.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, businessId));

    // Two customers who texted the business.
    const marie = randomUUID(), jean = randomUUID(), marieConversation = randomUUID(), jeanConversation = randomUUID();
    await database.db.insert(contacts).values([
      { id: marie, businessId, name: "Marie Tremblay", phone: "+14165550199" },
      { id: jean, businessId, name: "Jean Roy", phone: "+14165550188" },
    ]);
    await database.db.insert(conversations).values([
      { id: marieConversation, businessId, contactId: marie, channel: "sms" },
      { id: jeanConversation, businessId, contactId: jean, channel: "sms" },
    ]);
    const question = "Can you call me back about Friday?";
    await database.db.insert(messages).values([
      { businessId, conversationId: marieConversation, direction: "inbound", channel: "sms", body: question, status: "received", createdAt: new Date(Date.now() - 10 * 60_000) },
      { businessId, conversationId: jeanConversation, direction: "inbound", channel: "sms", body: "See you Friday.", status: "received", createdAt: new Date(Date.now() - 60 * 60_000) },
    ]);
    const archivedAt = async () => (await database.db.select({ archivedAt: conversations.archivedAt }).from(conversations).where(eq(conversations.id, marieConversation)))[0]?.archivedAt ?? null;
    const marieRow = page.getByRole("button", { name: /Marie Tremblay/ });
    const jeanRow = page.getByRole("button", { name: /Jean Roy/ });

    await page.goto("/messages");
    await expect(marieRow).toBeVisible();
    await expect(jeanRow).toBeVisible();
    await marieRow.click();
    await expect(page.getByText(question)).toHaveCount(2);

    // Cancelling the dialog keeps the conversation.
    const archive = page.getByRole("button", { name: copy.action, exact: true });
    const dialog = page.getByRole("alertdialog");
    await archive.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(copy.title, { exact: true })).toBeVisible();
    await expect(dialog.getByText(copy.description, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: copy.cancel, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(marieRow).toBeVisible();
    expect(await archivedAt()).toBeNull();

    // Confirming archives it: it leaves the list and its thread closes.
    await archive.click();
    const archived = page.waitForResponse((response) => response.url().includes("/api/messages?businessId=") && response.request().method() === "PATCH");
    await dialog.getByRole("button", { name: copy.confirm, exact: true }).click();
    expect((await archived).ok()).toBe(true);
    await expect(page.getByText(copy.done, { exact: true })).toBeVisible();
    await expect(marieRow).toHaveCount(0);
    await expect(jeanRow).toBeVisible();
    await expect(page.getByText(messageCopy.page.selectConversation, { exact: true })).toBeVisible();
    await page.reload();
    await expect(jeanRow).toBeVisible();
    await expect(marieRow).toHaveCount(0);

    // Nothing was deleted, and the archive is on record.
    expect(await archivedAt()).toBeInstanceOf(Date);
    expect((await database.db.select({ messages: count() }).from(messages).where(eq(messages.conversationId, marieConversation)))[0]?.messages).toBe(1);
    expect((await database.db.select({ eventType: auditLogs.eventType }).from(auditLogs).where(eq(auditLogs.entityId, marieConversation))).map((row) => row.eventType)).toEqual(["conversation.archived"]);

    // Archived lists it alone, says so in its thread, and Restore puts it back in the list.
    await page.getByRole("button", { name: messageCopy.page.filterArchived, exact: true }).click();
    await expect(marieRow).toBeVisible();
    await expect(jeanRow).toHaveCount(0);
    await marieRow.click();
    await expect(page.getByText(/^Archived on .+\. A new message brings it back\.$/)).toBeVisible();
    await expect(archive).toHaveCount(0);
    await page.getByRole("button", { name: copy.restore, exact: true }).click();
    await expect(page.getByText(copy.restored, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.empty, { exact: true })).toBeVisible();
    expect(await archivedAt()).toBeNull();
    await page.getByRole("button", { name: messageCopy.page.filterAll, exact: true }).click();
    await expect(marieRow).toBeVisible();
    await expect(jeanRow).toBeVisible();
  } finally {
    await removeFixtures(database, email, businessId);
    await database.pool.end();
  }
});
