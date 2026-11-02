import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";

import { businesses, createDatabaseClient, outboxMessages } from "@lobbystack/db";

import auth from "../public/locales/en/auth.json" with { type: "json" };
import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };
import settings from "../public/locales/en/settings.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

const password = "Business-Cancellation-Password-123!";
const prefix = "business-cancellation";
const copy = settings.workspaceTeam.cancelAccount;
const pageCopy = auth.cancelAccount;

function migrator() {
  const databaseUrl = process.env.REPLACEMENT_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("The disposable E2E database is required.");
  return createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl });
}

// Removes only this test's user and businesses, so copies running in parallel
// keep theirs. The migrator can delete a canceled business; nobody else can.
async function removeFixtures(database: ReturnType<typeof migrator>, email: string, businessIds: string[]): Promise<void> {
  for (const businessId of businessIds) {
    await database.db.execute(sql`delete from public.outbox_messages where business_id = ${businessId} or payload->>'businessId' = ${businessId}`);
    await database.db.execute(sql`delete from public.businesses where id = ${businessId}`);
  }
  await database.db.execute(sql`delete from public.outbox_messages where aggregate_id in (select id from public.users where email = ${email})`);
  await database.db.execute(sql`delete from public.verifications where identifier = ${`email-verification-otp-${email}`}`);
  await database.db.execute(sql`delete from public.users where email = ${email}`);
}

test("an owner cancels their only business from its Team page and a link, and starts again as a new account", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const database = migrator();
  const email = `${prefix}-${randomUUID()}@example.invalid`;
  const suffix = randomUUID().slice(0, 8);
  const mainName = `Main ${suffix}`;
  const created: string[] = [];
  const status = async (businessId: string) => (await database.db.select({ status: businesses.status, canceledAt: businesses.canceledAt }).from(businesses).where(eq(businesses.id, businessId)))[0];
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

    const createBusiness = async (name: string) => {
      await page.getByLabel(onboarding.businessName.label).fill(name);
      const posted = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
      await page.getByRole("button", { name: onboarding.businessName.continue }).click();
      const businessId = (await (await posted).json() as { businessId: string }).businessId;
      created.push(businessId);
      return businessId;
    };
    const mainId = await createBusiness(mainName);
    await expect(page).toHaveURL(/\/onboarding\/website$/);
    // The rest of onboarding has its own journeys; the dashboard opens once it's complete.
    await database.db.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, mainId));

    // The account's first business, and the only one its owner owns: Cancel account, not Delete.
    await page.goto("/settings/team");
    await expect(page.getByText(copy.description, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: settings.workspaceTeam.delete.action, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: copy.action, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(`Cancel ${mainName}?`, { exact: true })).toBeVisible();
    await expect(dialog.getByTestId("cancel-account-notice")).toHaveText(copy.notice);
    const submit = dialog.getByRole("button", { name: copy.submit, exact: true });
    await expect(submit).toBeDisabled();
    await dialog.locator("#cancel-account-name").fill(mainName);
    const requested = page.waitForResponse((response) => response.url().includes(`/api/businesses/cancellation?businessId=${mainId}`) && response.request().method() === "POST");
    await submit.click();
    expect((await requested).ok()).toBe(true);
    await expect(dialog.getByText(copy.sentTitle, { exact: true })).toBeVisible();
    await expect(dialog.getByText(copy.sentDescription.replace("{{email}}", email), { exact: true })).toBeVisible();
    // Asking changes nothing.
    expect(await status(mainId)).toEqual({ status: "active", canceledAt: null });

    // The owner's email carries the link.
    const [message] = await database.db.select({ payload: outboxMessages.payload }).from(outboxMessages)
      .where(and(eq(outboxMessages.businessId, mainId), eq(outboxMessages.topic, "email.send"), sql`${outboxMessages.payload}->>'template' = 'cancellation_confirm'`))
      .orderBy(desc(outboxMessages.createdAt)).limit(1);
    expect(message?.payload).toMatchObject({ email, variables: { businessName: mainName } });
    const link = new URL(String(message!.payload.url));
    expect(link.pathname).toBe("/cancel-account");

    // It opens in the owner's language, signed in, and asks for their password.
    await page.goto(`${link.pathname}${link.search}`);
    await expect(page).toHaveURL(/\/en\/cancel-account\?token=/);
    await expect(page.getByText(`Enter your password to cancel ${mainName}.`, { exact: true })).toBeVisible();
    await expect(page.getByTestId("cancel-account-effects")).toHaveText(pageCopy.effects);
    const passwordField = page.locator("#cancel-account-password");
    const cancel = page.getByRole("button", { name: pageCopy.submit, exact: true });

    // A wrong password cancels nothing.
    await passwordField.fill("Not-The-Password-123!");
    const refused = page.waitForResponse((response) => response.url().endsWith("/api/businesses/cancellation/confirm") && response.request().method() === "POST");
    await cancel.click();
    expect((await refused).status()).toBe(400);
    // Next.js keeps a route announcer with the same role on every page.
    await expect(page.locator("form").getByRole("alert")).toHaveText(pageCopy.errors.invalid_password);
    expect((await status(mainId))?.status).toBe("active");

    await passwordField.fill(password);
    const confirmed = page.waitForResponse((response) => response.url().endsWith("/api/businesses/cancellation/confirm") && response.request().method() === "POST");
    await cancel.click();
    expect((await confirmed).ok()).toBe(true);
    await expect(page.getByText(pageCopy.canceledTitle, { exact: true })).toBeVisible();
    // Canceled, not deleted.
    expect(await status(mainId)).toEqual({ status: "canceled", canceledAt: expect.any(Date) });

    // Closed to its owner too: the API refuses it, and the dashboard starts onboarding.
    const teamStatus = await page.evaluate(async (businessId) => (await fetch(`/api/team?businessId=${businessId}`)).status, mainId);
    expect([403, 404]).toContain(teamStatus);
    await page.getByRole("button", { name: pageCopy.startOver, exact: true }).click();
    await expect(page).toHaveURL(/\/onboarding\/business$/);
    const freshId = await createBusiness(`Fresh ${suffix}`);
    expect(freshId).not.toBe(mainId);
    await expect(page).toHaveURL(/\/onboarding\/website$/);

    // The link has been used.
    await page.goto(`${link.pathname}${link.search}`);
    await expect(page.getByText(`${mainName} is already canceled.`, { exact: true })).toBeVisible();
    await expect(page.locator("#cancel-account-password")).toHaveCount(0);
  } finally {
    await removeFixtures(database, email, created);
    await database.pool.end();
  }
});
