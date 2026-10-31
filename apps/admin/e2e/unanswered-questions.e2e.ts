import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { businesses, createDatabaseClient, knowledgeSnippets, unansweredQuestions } from "@lobbystack/db";

import agent from "../public/locales/en/agent.json" with { type: "json" };
import knowledge from "../public/locales/en/knowledge.json" with { type: "json" };
import onboarding from "../public/locales/en/onboarding.json" with { type: "json" };

import { completeSignupEmailVerification, isolateAuthRateLimit } from "./fixtures/email-verification";

const password = "Unanswered-Questions-Password-123!";
const prefix = "unanswered-questions";
const copy = knowledge.unansweredQuestions;

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

test("the Questions page sits below Knowledge, lists what the receptionist couldn't answer, and turns an answer into knowledge", async ({ page }, testInfo) => {
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
    await page.getByLabel(onboarding.businessName.label).fill(`Unanswered Questions ${randomUUID().slice(0, 8)}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/businesses") && response.request().method() === "POST");
    await page.getByRole("button", { name: onboarding.businessName.continue }).click();
    businessId = (await (await created).json() as { businessId: string }).businessId;
    // The rest of onboarding has its own journeys; the dashboard opens once it's complete.
    await database.db.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, businessId));

    // Two questions the receptionist couldn't answer, the first asked more often.
    const parking = randomUUID(), dogs = randomUUID();
    await database.db.insert(unansweredQuestions).values([
      { id: parking, businessId, question: "Do you validate parking?", normalizedQuestion: "do you validate parking", lastChannel: "voice", timesAsked: 3 },
      { id: dogs, businessId, question: "Can I bring my dog?", normalizedQuestion: "can i bring my dog", lastChannel: "web_chat" },
    ]);
    const stored = async (id: string) => (await database.db.select({ status: unansweredQuestions.status, snippetId: unansweredQuestions.knowledgeSnippetId }).from(unansweredQuestions).where(eq(unansweredQuestions.id, id)))[0];
    const questionRequests: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/knowledge/questions")) questionRequests.push(request.url()); });
    const sidebar = page.locator('[data-slot="sidebar"]');
    const knowledgeLink = sidebar.getByRole("link", { name: agent.sections.knowledge.title, exact: true });
    const questionsLink = sidebar.getByRole("link", { name: agent.sections.questions.title, exact: true });
    const list = page.getByRole("region", { name: copy.title });

    // Home counts the open questions and links them to the Questions page.
    await page.goto("/");
    await expect(page.getByRole("link", { name: copy.home.count_other.replace("{{count}}", "2") })).toHaveAttribute("href", "/agent/questions");

    // The Knowledge page stays as it was before the questions: no list, and no request for one.
    questionRequests.length = 0;
    await knowledgeLink.click();
    await expect(page).toHaveURL(/\/agent\/knowledge$/);
    await expect(page.getByRole("heading", { level: 1, name: agent.sections.knowledge.title, exact: true })).toBeVisible();
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("heading", { name: copy.title })).toHaveCount(0);
    expect(questionRequests).toEqual([]);

    // The sidebar lists Questions right below Knowledge, and marks it active on its own page.
    const labels = (await sidebar.getByRole("link").allInnerTexts()).map((label) => label.trim());
    expect(labels.indexOf(agent.sections.knowledge.title)).toBeGreaterThan(-1);
    expect(labels.indexOf(agent.sections.questions.title)).toBe(labels.indexOf(agent.sections.knowledge.title) + 1);
    await questionsLink.click();
    await expect(page).toHaveURL(/\/agent\/questions$/);
    await expect(page.getByRole("heading", { level: 1, name: agent.sections.questions.title, exact: true })).toBeVisible();
    await expect(questionsLink).toHaveAttribute("data-active", "");
    await expect(knowledgeLink).not.toHaveAttribute("data-active");
    await expect(list.getByText(/\?$/u)).toHaveText(["Do you validate parking?", "Can I bring my dog?"]);
    await expect(list.getByText(/^Asked 3 times · Last asked /u)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("questions-page.png"), fullPage: true });

    // An answer leaves the list and becomes a text entry titled with the question.
    await list.getByRole("button", { name: copy.answer, exact: true }).first().click();
    await list.getByRole("textbox", { name: copy.answerLabel.replace("{{question}}", "Do you validate parking?") }).fill("Two hours free with a stamp from the front desk.");
    const answered = page.waitForResponse((response) => response.url().includes(`/api/knowledge/questions/${parking}?`) && response.request().method() === "PATCH");
    await list.getByRole("button", { name: copy.saveAnswer, exact: true }).click();
    expect((await answered).ok()).toBe(true);
    await expect(page.getByText(copy.toast.answered, { exact: true })).toBeVisible();
    await expect(list.getByText("Do you validate parking?", { exact: true })).toHaveCount(0);
    const answer = await stored(parking);
    expect(answer?.status).toBe("answered");
    expect((await database.db.select({ title: knowledgeSnippets.title, content: knowledgeSnippets.content }).from(knowledgeSnippets).where(eq(knowledgeSnippets.id, answer!.snippetId!)))[0]).toEqual({ title: "Do you validate parking?", content: "Two hours free with a stamp from the front desk." });

    // Dismissing the other empties the list.
    const dismissed = page.waitForResponse((response) => response.url().includes(`/api/knowledge/questions/${dogs}?`) && response.request().method() === "PATCH");
    await list.getByRole("button", { name: copy.dismiss, exact: true }).click();
    expect((await dismissed).ok()).toBe(true);
    await expect(list.getByText(copy.emptyTitle, { exact: true })).toBeVisible();
    expect((await stored(dogs))?.status).toBe("dismissed");

    // The answer is on the Knowledge page with the rest of the knowledge.
    await knowledgeLink.click();
    await expect(page).toHaveURL(/\/agent\/knowledge$/);
    await expect(page.getByRole("row").filter({ hasText: "Do you validate parking?" })).toHaveCount(1);
    await expect(page.getByRole("heading", { name: copy.title })).toHaveCount(0);

    // The page opens directly from its address too.
    await page.goto("/agent/questions");
    await expect(page.getByRole("heading", { level: 1, name: agent.sections.questions.title, exact: true })).toBeVisible();
    await expect(list.getByText(copy.emptyTitle, { exact: true })).toBeVisible();
  } finally {
    await removeFixtures(database, email, businessId);
    await database.pool.end();
  }
});
