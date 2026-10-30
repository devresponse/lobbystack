import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";

import { auditLogs, businesses, calls, contacts, conversations, createDatabaseClient, transcripts } from "@lobbystack/db";

import callCopy from "../public/locales/en/calls.json" with { type: "json" };
import commonCopy from "../public/locales/en/common.json" with { type: "json" };
import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

const password = "Call-Archive-Password-123!";
const prefix = "call-archive";
const copy = callCopy.detail.archive;

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

test("an owner archives a call only after confirming, and it leaves the Calls list with its transcript kept", async ({ page }, testInfo) => {
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
    await page.getByLabel(onboarding.businessName.label).fill(`Call Archive ${randomUUID().slice(0, 8)}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
    await page.getByRole("button", { name: onboarding.businessName.continue }).click();
    businessId = (await (await created).json() as { businessId: string }).businessId;
    // The rest of onboarding has its own journeys; the dashboard opens once it's complete.
    await database.db.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, businessId));

    // A browser test call with its transcript, and a phone call from a customer.
    const contactId = randomUUID(), testCall = randomUUID(), customerCall = randomUUID();
    const testConversation = randomUUID(), customerConversation = randomUUID();
    await database.db.insert(contacts).values({ id: contactId, businessId, name: "Marie Tremblay", phone: "+14165550199" });
    await database.db.insert(conversations).values([
      { id: testConversation, businessId, channel: "voice" },
      { id: customerConversation, businessId, contactId, channel: "voice" },
    ]);
    await database.db.insert(calls).values([
      { id: testCall, businessId, conversationId: testConversation, provider: "openai_live", providerCallId: `rtc_${testCall}`, transport: "web_voice", status: "completed", startedAt: new Date(Date.now() - 10 * 60_000), endedAt: new Date(Date.now() - 10 * 60_000 + 15_000), providerDurationSeconds: 15 },
      { id: customerCall, businessId, conversationId: customerConversation, contactId, provider: "openai_live", providerCallId: `rtc_${customerCall}`, transport: "voice", status: "completed", startedAt: new Date(Date.now() - 60 * 60_000), endedAt: new Date(Date.now() - 59 * 60_000), providerDurationSeconds: 60 },
    ]);
    const greeting = "Thank you for calling. I'm your AI assistant. How can I help you?";
    await database.db.insert(transcripts).values([
      { businessId, callId: testCall, sequence: 1, speaker: "assistant", text: greeting },
      { businessId, callId: testCall, sequence: 2, speaker: "caller", text: "Just testing." },
    ]);
    const archivedAt = async () => (await database.db.select({ archivedAt: calls.archivedAt }).from(calls).where(eq(calls.id, testCall)))[0]?.archivedAt ?? null;
    const rows = page.getByRole("row");
    const testRow = rows.filter({ hasText: commonCopy.channels.webCall });
    const customerRow = rows.filter({ hasText: "Marie Tremblay" });

    await page.goto("/calls");
    await expect(testRow).toHaveCount(1);
    await expect(customerRow).toHaveCount(1);
    await testRow.click();
    await expect(page).toHaveURL(new RegExp(`/calls/${testCall}$`));
    await expect(page.getByText(greeting)).toBeVisible();

    // Cancelling the dialog keeps the call.
    const archive = page.getByRole("button", { name: copy.action, exact: true });
    const dialog = page.getByRole("alertdialog");
    await archive.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(copy.title, { exact: true })).toBeVisible();
    await expect(dialog.getByText(copy.description, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: copy.cancel, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/calls/${testCall}$`));
    expect(await archivedAt()).toBeNull();

    // Confirming archives it and goes back to the list, which no longer shows it.
    await archive.click();
    const archived = page.waitForResponse((response) => response.url().includes(`/api/calls/${testCall}?`) && response.request().method() === "PATCH");
    await dialog.getByRole("button", { name: copy.confirm, exact: true }).click();
    expect((await archived).ok()).toBe(true);
    await expect(page).toHaveURL(/\/calls$/);
    await expect(page.getByText(copy.done, { exact: true })).toBeVisible();
    await expect(customerRow).toHaveCount(1);
    await expect(testRow).toHaveCount(0);
    await page.reload();
    await expect(customerRow).toHaveCount(1);
    await expect(testRow).toHaveCount(0);

    // Nothing was deleted, and the archive is on record.
    expect(await archivedAt()).toBeInstanceOf(Date);
    expect((await database.db.select({ lines: count() }).from(transcripts).where(eq(transcripts.callId, testCall)))[0]?.lines).toBe(2);
    expect((await database.db.select({ eventType: auditLogs.eventType }).from(auditLogs).where(eq(auditLogs.entityId, testCall))).map((row) => row.eventType)).toEqual(["call.archived"]);

    // Its page still opens from a link, marked archived, and restores it to the list.
    await page.goto(`/calls/${testCall}`);
    await expect(page.getByText(copy.badge, { exact: true })).toBeVisible();
    await expect(page.getByText(greeting)).toBeVisible();
    await expect(archive).toHaveCount(0);
    await page.getByRole("button", { name: copy.restore, exact: true }).click();
    await expect(page.getByText(copy.restored, { exact: true })).toBeVisible();
    await expect(archive).toBeVisible();
    expect(await archivedAt()).toBeNull();
    await page.goto("/calls");
    await expect(testRow).toHaveCount(1);
    await expect(customerRow).toHaveCount(1);
  } finally {
    await removeFixtures(database, email, businessId);
    await database.pool.end();
  }
});
