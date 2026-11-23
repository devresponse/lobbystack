import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { sql } from "drizzle-orm";

import { createDatabaseClient } from "@lobbystack/db";

import { respectingAuthRateLimit } from "./fixtures/auth-rate-limit";
import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

// Runs against a server started as a deployment that takes payments, by
// playwright.plan-step.config.ts: its onboarding has the plan step, right after
// the business's name (docs/features/onboarding.md). The other journeys' server
// takes none, so operator-auth.e2e.ts walks onboarding without the step.

const password = "Replacement-E2E-Password-123!";
const prefix = "plan-step-e2e";

/**
 * Best effort only. The isolated runner builds a fresh database per run, so
 * leftovers are not a correctness concern, and a tidy-up that cannot reach the
 * schema must not fail the assertion it exists to support.
 */
async function cleanup(): Promise<void> {
  const databaseUrl = process.env.REPLACEMENT_E2E_DATABASE_URL;
  if (!databaseUrl) return;
  const database = createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl });
  try {
    await database.db.execute(sql`delete from public.businesses where id in (select b.business_id from public.business_memberships b join public.users u on u.id = b.user_id where u.email like ${`${prefix}-%@example.invalid`})`);
    await database.db.execute(sql`delete from public.outbox_messages where aggregate_id in (select id from public.users where email like ${`${prefix}-%@example.invalid`})`);
    await database.db.execute(sql`delete from public.verifications where identifier like ${`email-verification-otp-${prefix}-%@example.invalid`}`);
    await database.db.execute(sql`delete from public.users where email like ${`${prefix}-%@example.invalid`}`);
  } catch {
    // A database this spec cannot reach holds nothing it created.
  } finally {
    await database.pool.end().catch(() => undefined);
  }
}

test.beforeAll(cleanup);
test.afterAll(cleanup);

const emailOf = (identity: string, testInfo: TestInfo) => `${prefix}-${identity}-${testInfo.retry}@example.invalid`;

async function signUp(page: Page, identity: string, testInfo: TestInfo): Promise<void> {
  // Playwright retries in CI, and a retry that reuses the address finds the
  // account already made and waits forever for a signup email nobody sent.
  const email = emailOf(identity, testInfo);
  await isolateAuthRateLimit(page, email, testInfo);
  await page.goto("/en/signup");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  const response = await respectingAuthRateLimit(async () => {
    const submitted = page.waitForResponse(response => response.url().endsWith("/api/auth/sign-up/email") && response.request().method() === "POST");
    await page.locator('button[type="submit"]').click();
    return await submitted;
  });
  expect(response.ok()).toBe(true);
  await completeSignupEmailVerification(page, email, password);
  await expect(page).toHaveURL(/\/onboarding\/business$/);
}

/** The stage the person's business is stored on. */
async function storedStage(email: string): Promise<string | null> {
  const databaseUrl = process.env.REPLACEMENT_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("REPLACEMENT_E2E_DATABASE_URL is required.");
  const database = createDatabaseClient("lobbystack_migrator", { DATABASE_URL: databaseUrl });
  try {
    const result = await database.db.execute<{ onboarding_stage: string | null }>(sql`
      select b.onboarding_stage
      from public.users u
      left join public.businesses b on b.id = u.active_business_id
      where u.email = ${email}
      limit 1
    `);
    return result.rows[0]?.onboarding_stage ?? null;
  } finally {
    await database.pool.end();
  }
}

const progress = (page: Page, step: number) => page.getByRole("navigation", { name: `Onboarding progress: step ${step} of 8` });
const planHeading = (page: Page) => page.getByRole("heading", { name: "Choose your plan", exact: true });

test("the plan is chosen right after the business's name, before anything else about the business", async ({ page }, testInfo) => {
  // Signup runs a full email round trip, and the walk opens every step.
  test.setTimeout(240_000);
  const email = emailOf("owner", testInfo);
  await signUp(page, "owner", testInfo);
  await expect(progress(page, 2)).toBeVisible();

  // The name is followed by the plan step, the third of eight dots.
  await page.getByLabel("Business name").fill(`Plan step ${testInfo.retry}`);
  const created = page.waitForResponse(response => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect(await (await created).json()).toMatchObject({ onboardingStage: "plan" });
  await expect(page).toHaveURL("/onboarding/plan");
  await expect(planHeading(page)).toBeVisible();
  await expect(progress(page, 3)).toBeVisible();
  expect(await storedStage(email)).toBe("plan");

  // Nothing after the plan step opens before a plan is chosen.
  for (const later of ["/onboarding/website", "/onboarding/knowledge", "/onboarding/greeting", "/onboarding/number", "/onboarding/attribution"]) {
    await page.goto(later);
    await expect(page).toHaveURL("/onboarding/plan");
  }
  await page.reload();
  await expect(planHeading(page)).toBeVisible();

  // Free goes on to the website step, the fourth dot.
  await page.getByRole("button", { name: "Start free" }).click();
  await expect(page).toHaveURL("/onboarding/website");
  await expect(progress(page, 4)).toBeVisible();
  await expect.poll(() => storedStage(email)).toBe("website");

  // The plan step opens again from a later step, and choosing there returns to that step and moves nothing.
  await page.getByRole("link", { name: "Go to onboarding step 3" }).click();
  await expect(page).toHaveURL("/onboarding/plan");
  await expect(planHeading(page)).toBeVisible();
  await page.getByRole("button", { name: "Start free" }).click();
  await expect(page).toHaveURL("/onboarding/website");
  expect(await storedStage(email)).toBe("website");

  await page.getByRole("button", { name: "I don't have a website" }).click();
  await expect(page).toHaveURL("/onboarding/knowledge");
  await expect(progress(page, 5)).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL("/onboarding/greeting");
  await expect(progress(page, 6)).toBeVisible();

  // Free has no number to pick, so the greeting is followed by the last step, and the plan step no longer follows it.
  await page.getByLabel("Greeting").fill("Thanks for calling. How can we help?");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL("/onboarding/attribution");
  await expect(progress(page, 8)).toBeVisible();
  await expect.poll(() => storedStage(email)).toBe("attribution");

  // Opened again from the last step, the plan step sends Free back to it: Free still has no number to pick.
  await page.goto("/onboarding/plan");
  await expect(planHeading(page)).toBeVisible();
  await page.getByRole("button", { name: "Start free" }).click();
  await expect(page).toHaveURL("/onboarding/attribution");
  expect(await storedStage(email)).toBe("attribution");

  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect.poll(() => storedStage(email)).toBe("complete");
});
