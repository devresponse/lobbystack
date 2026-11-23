import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { billingAccounts, businesses, businessMemberships, createDatabaseClient, knowledgeDocuments, outboxMessages, users, websiteIngestionJobs, withBusinessTransaction } from "@lobbystack/db";
import { advanceOnboardingStage, getActiveOnboardingState, saveOnboardingWebsite } from "@lobbystack/domain";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function denied(action: () => Promise<unknown>, message: string) {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  assert(rejected, message);
}
const auth = createDatabaseClient("lobbystack_auth"), worker = createDatabaseClient("lobbystack_worker"), app = createDatabaseClient("lobbystack_app");
const userId = randomUUID(), viewerId = randomUUID(), businessId = randomUUID();
const actor = { userId, businessId };
const context = { db: app.db };
// A deployment that takes payments has a plan step right after the name, and one that takes none has not
// (onboardingHasPlanStep reads these each time). The check runs as the first, then as the second.
function planStep(on: boolean) {
  process.env.DEPLOYMENT_MODE = "cloud";
  delete process.env.BILLING_PROVIDER;
  if (on) Object.assign(process.env, { POLAR_ACCESS_TOKEN: "certification-token", POLAR_ORGANIZATION_ID: "certification-organization" });
  else { delete process.env.POLAR_ACCESS_TOKEN; delete process.env.POLAR_ORGANIZATION_ID; }
}
const stored = async () => await withBusinessTransaction(app.db, { ...actor, actorType: "operator" }, async (tx) => (await tx.select().from(businesses).where(eq(businesses.id, businessId)))[0]);
const store = async (stage: string) => { await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, tx => tx.update(businesses).set({ onboardingStage: stage }).where(eq(businesses.id, businessId))); };
const shown = async () => (await getActiveOnboardingState(app.db, userId)).stage;
try {
  planStep(true);
  for (const id of [userId, viewerId]) await auth.db.insert(users).values({ id, email: `${id}@onboarding.invalid`, normalizedEmail: `${id}@onboarding.invalid` });
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async (tx) => {
    // As the name step leaves a new business where the deployment takes payments: on the plan step.
    await tx.insert(businesses).values({ id: businessId, slug: `onboarding-${businessId}`, name: "Onboarding certification", timezone: "UTC", businessType: "service_company", onboardingStage: "plan" });
    await tx.insert(businessMemberships).values([{ businessId, userId, role: "business_owner", status: "active" }, { businessId, userId: viewerId, role: "viewer", status: "active" }]);
  });
  await auth.db.update(users).set({ activeBusinessId: businessId }).where(eq(users.id, userId));
  // The plan comes right after the name, and only the website step follows it.
  assert(await shown() === "plan", "A new business did not start on the plan step.");
  await denied(() => advanceOnboardingStage(context, { ...actor, to: "knowledge" }), "The plan step led straight to the documents.");
  await denied(() => advanceOnboardingStage(context, { ...actor, to: "phone_number" }), "The plan step led straight past the steps after it.");
  assert(await advanceOnboardingStage(context, { ...actor, to: "website" }) === "website" && (await stored())?.onboardingStage === "website", "The plan step did not lead to the website step.");
  const website = { ...actor, websiteUrl: "example.com" };
  // Double-clicked or retried submissions all land: one moves the stage, the rest only save the address.
  const saves = await Promise.all(Array.from({ length: 4 }, () => saveOnboardingWebsite(context, website)));
  assert(saves.every((saved) => saved.websiteUrl === "https://example.com/" && saved.stage === "knowledge"), "Concurrent website saves disagreed.");
  let business = await stored();
  assert(business?.websiteUrl === "https://example.com/" && business.onboardingStage === "knowledge", "Website URL and stage were not committed together.");
  // The website step reads nothing: no knowledge source, website import or crawl message.
  const queued = async () => await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async (tx) => ({
    documents: (await tx.select({ id: knowledgeDocuments.id }).from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, businessId))).length,
    imports: (await tx.select({ id: websiteIngestionJobs.id }).from(websiteIngestionJobs).where(eq(websiteIngestionJobs.businessId, businessId))).length,
    crawls: (await tx.select({ id: outboxMessages.id }).from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "knowledge.crawlWebsite")))).length,
  }));
  assert(JSON.stringify(await queued()) === JSON.stringify({ documents: 0, imports: 0, crawls: 0 }), "The onboarding website step queued a crawl.");
  await advanceOnboardingStage(context, { ...actor, to: "greeting" });
  // The greeting asks for the number step, with no personal phone verification gate. The plan was chosen
  // before it: Free has no number to pick, so the last step follows.
  assert(await advanceOnboardingStage(context, { ...actor, to: "phone_number" }) === "attribution" && await shown() === "attribution", "The greeting on Free did not go on to the last step.");
  // An earlier form opens again, the plan step included, and moves nothing.
  assert(await advanceOnboardingStage(context, { ...actor, to: "plan" }) === "plan" && await advanceOnboardingStage(context, { ...actor, to: "knowledge" }) === "knowledge", "An earlier step did not open again.");
  const revisited = await saveOnboardingWebsite(context, { ...actor, websiteUrl: "https://www.example.org/" });
  business = await stored();
  assert(revisited.stage === "attribution" && business?.onboardingStage === "attribution", "Revisiting an earlier form regressed onboarding progress.");
  assert(business?.websiteUrl === "https://www.example.org/", "Revisiting the website step did not change the saved address.");
  assert(JSON.stringify(await queued()) === JSON.stringify({ documents: 0, imports: 0, crawls: 0 }), "Revisiting the website step queued a crawl.");
  await denied(() => advanceOnboardingStage(context, { businessId, userId: viewerId, to: "knowledge" }), "Viewer could mutate a completed onboarding step.");
  await denied(() => saveOnboardingWebsite(context, { ...website, userId: viewerId }), "Viewer could update the onboarding website.");
  await denied(() => saveOnboardingWebsite(context, { ...website, websiteUrl: "file:///etc/passwd" }), "Invalid website URL was accepted.");
  // On a paid plan with a number, the greeting is followed by the number step.
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async tx => { await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "starter", subscriptionState: "active" }); });
  await store("greeting");
  assert(await advanceOnboardingStage(context, { ...actor, to: "phone_number" }) === "phone_number" && await shown() === "phone_number", "The greeting on a paid plan did not go on to the number step.");
  // A number step on Free goes back to the plan step, where the plan can be changed.
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, tx => tx.update(billingAccounts).set({ plan: "free_cloud", subscriptionState: null }).where(eq(billingAccounts.businessId, businessId)));
  assert(await shown() === "plan", "A legacy free-plan number stage skipped plan selection.");
  // A paid plan counts only while its subscription is live; without one it is Free.
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, tx => tx.update(billingAccounts).set({ plan: "starter", subscriptionState: "active" }).where(eq(billingAccounts.businessId, businessId)));
  assert(await shown() === "phone_number", "A paid number stage was incorrectly sent back to plan selection.");
  // Retired verification stages resume at the plan step instead of dead-ending, and go on from it.
  await store("verify_phone_code");
  assert(await shown() === "plan", "A retired verification stage did not resume to plan.");
  await advanceOnboardingStage(context, { ...actor, to: "website" });
  assert((await stored())?.onboardingStage === "website", "Advancing from a retired verification stage did not go on from the plan step.");

  // Without a plan step: a business stored on it is on the website step, and a number step on Free stays, since it can be skipped.
  planStep(false);
  await store("plan");
  assert(await shown() === "website", "A business stored on the plan step did not show the website step where there is no plan step.");
  assert(await advanceOnboardingStage(context, { ...actor, to: "plan" }) === "website" && (await stored())?.onboardingStage === "website", "Asking for the plan step did not open the website step where there is no plan step.");
  await store("create_business");
  assert(await advanceOnboardingStage(context, { ...actor, to: "plan" }) === "website" && (await stored())?.onboardingStage === "website", "The name was not followed by the website step where there is no plan step.");
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, tx => tx.update(billingAccounts).set({ plan: "free_cloud", subscriptionState: null }).where(eq(billingAccounts.businessId, businessId)));
  await store("phone_number");
  assert(await shown() === "phone_number", "A free-plan number stage was sent to a plan step the deployment hasn't.");
  planStep(true);
  await store("create_business");
  assert(await advanceOnboardingStage(context, { ...actor, to: "website" }) === "plan" && (await stored())?.onboardingStage === "plan", "The name was not followed by the plan step.");
  await store("complete");
  assert(await shown() === "complete", "Completed free onboarding was regressed.");
  console.log(JSON.stringify({ planFollowsName: true, planLeadsOnlyToWebsite: true, noPlanStepWithoutPayments: true, legacyFreeNumberReturnsToPlan: true, paidNumberStagePreserved: true, completedFreeStagePreserved: true, websiteAndStageAtomic: true, websiteStepQueuesNoCrawl: true, concurrentSavesAgree: true, greetingAdvancesToNumberOrLastStep: true, legacyVerificationResumesToPlan: true, revisitsPreserveProgress: true, viewerDenied: true, invalidUrlDenied: true }));
} finally {
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async (tx) => tx.delete(businesses).where(eq(businesses.id, businessId)));
  for (const id of [userId, viewerId]) await auth.db.delete(users).where(eq(users.id, id));
  await Promise.all([auth.pool.end(), worker.pool.end(), app.pool.end()]);
}
