import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { businesses, createDatabaseClient, users } from "@lobbystack/db";

import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };
import settings from "../public/locales/en/settings.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

const password = "Business-Deletion-Password-123!";
const prefix = "business-deletion";
const copy = settings.workspaceTeam.delete;

function migrator() {
  const databaseUrl = process.env.REPLACEMENT_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("The disposable E2E database is required.");
  return createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl });
}

// Removes only this test's user and businesses, so copies running in parallel
// keep theirs. The migrator can delete a root business; the dashboard can't.
async function removeFixtures(database: ReturnType<typeof migrator>, email: string, businessIds: string[]): Promise<void> {
  for (const businessId of businessIds) {
    await database.db.execute(sql`delete from public.outbox_messages where business_id = ${businessId} or payload->>'businessId' = ${businessId}`);
    await database.db.execute(sql`delete from public.businesses where id = ${businessId}`);
  }
  await database.db.execute(sql`delete from public.outbox_messages where aggregate_id in (select id from public.users where email = ${email})`);
  await database.db.execute(sql`delete from public.verifications where identifier = ${`email-verification-otp-${email}`}`);
  await database.db.execute(sql`delete from public.users where email = ${email}`);
}

test("an owner deletes their second business for good, and never their first", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const database = migrator();
  const email = `${prefix}-${randomUUID()}@example.invalid`;
  const suffix = randomUUID().slice(0, 8);
  const mainName = `Main ${suffix}`;
  const studioName = `Studio ${suffix}`;
  const created: string[] = [];
  const exists = async (businessId: string) => (await database.db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId))).length === 1;
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

    // The first business, the account's root, then a second one from "Create business".
    const createBusiness = async (name: string) => {
      await page.getByLabel(onboarding.businessName.label).fill(name);
      const posted = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
      await page.getByRole("button", { name: onboarding.businessName.continue }).click();
      const businessId = (await (await posted).json() as { businessId: string }).businessId;
      created.push(businessId);
      // The rest of onboarding has its own journeys; the dashboard opens once it's complete.
      await database.db.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, businessId));
      return businessId;
    };
    const mainId = await createBusiness(mainName);
    await expect(page).toHaveURL(/\/onboarding\/website$/);
    await page.goto("/onboarding/business?create=true");
    const studioId = await createBusiness(studioName);

    // Asking the API directly to delete Main, the root, with its name and the right password, is refused.
    const deleteThroughApi = async (businessId: string, confirmName: string) => await page.evaluate(async (input) => {
      const response = await fetch(`/api/businesses?businessId=${input.businessId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmName: input.confirmName, password: input.password }) });
      return { status: response.status, code: (await response.json() as { code?: string }).code };
    }, { businessId, confirmName, password });
    expect(await deleteThroughApi(mainId, mainName)).toEqual({ status: 403, code: "root_business" });
    expect(await exists(mainId)).toBe(true);

    // Studio is the active business. Its owner can delete it, after a warning that it's permanent.
    await page.goto("/settings/team");
    const remove = page.getByRole("button", { name: copy.action, exact: true });
    await expect(page.getByText(copy.description, { exact: true })).toBeVisible();
    await remove.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(`Delete ${studioName}?`, { exact: true })).toBeVisible();
    await expect(dialog.getByTestId("delete-business-warning")).toHaveText(copy.permanent);
    const submit = dialog.getByRole("button", { name: copy.submit, exact: true });
    const nameField = dialog.locator("#delete-business-name");
    const passwordField = dialog.locator("#delete-business-password");

    // A wrong password deletes nothing.
    await nameField.fill(studioName);
    await expect(submit).toBeDisabled();
    await passwordField.fill("Not-The-Password-123!");
    const refused = page.waitForResponse((response) => response.url().includes(`/api/businesses?businessId=${studioId}`) && response.request().method() === "DELETE");
    await submit.click();
    expect((await refused).status()).toBe(400);
    await expect(dialog.getByRole("alert")).toHaveText(copy.errors.invalid_password);
    await expect(passwordField).toHaveValue("");
    expect(await exists(studioId)).toBe(true);

    await passwordField.fill(password);
    const deleted = page.waitForResponse((response) => response.url().includes(`/api/businesses?businessId=${studioId}`) && response.request().method() === "DELETE");
    await submit.click();
    expect((await deleted).ok()).toBe(true);
    await expect(page.getByText(`${studioName} was deleted.`, { exact: true })).toBeVisible();
    expect(await exists(studioId)).toBe(false);
    expect(await exists(mainId)).toBe(true);
    expect((await database.db.select({ activeBusinessId: users.activeBusinessId }).from(users).where(eq(users.normalizedEmail, email)))[0]?.activeBusinessId).toBe(mainId);

    // Main, the account's root, says why it can't be deleted and offers no button.
    await page.goto("/settings/team");
    await expect(page.getByText(copy.blocked.accountRoot, { exact: true })).toBeVisible();
    await expect(remove).toHaveCount(0);

    // Now the only business the owner has, and still their root: the API refuses it as well.
    expect(await deleteThroughApi(mainId, mainName)).toEqual({ status: 403, code: "only_business" });
    expect(await exists(mainId)).toBe(true);
  } finally {
    await removeFixtures(database, email, created);
    await database.pool.end();
  }
});
