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
try {
  for (const id of [userId, viewerId]) await auth.db.insert(users).values({ id, email: `${id}@onboarding.invalid`, normalizedEmail: `${id}@onboarding.invalid` });
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async (tx) => {
    await tx.insert(businesses).values({ id: businessId, slug: `onboarding-${businessId}`, name: "Onboarding certification", timezone: "UTC", businessType: "service_company", onboardingStage: "website" });
    await tx.insert(businessMemberships).values([{ businessId, userId, role: "business_owner", status: "active" }, { businessId, userId: viewerId, role: "viewer", status: "active" }]);
  });
  const website = { ...actor, websiteUrl: "example.com" };
  // Double-clicked or retried submissions all land: one moves the stage, the rest only save the address.
  const saves = await Promise.all(Array.from({ length: 4 }, () => saveOnboardingWebsite(context, website)));
  assert(saves.every((saved) => saved.websiteUrl === "https://example.com/" && saved.stage === "knowledge"), "Concurrent website saves disagreed.");
  let business = await withBusinessTransaction(app.db, { ...actor, actorType: "operator" }, async (tx) => (await tx.select().from(businesses).where(eq(businesses.id, businessId)))[0]);
  assert(business?.websiteUrl === "https://example.com/" && business.onboardingStage === "knowledge", "Website URL and stage were not committed together.");
  // The website step reads nothing: no knowledge source, website import or crawl message.
  const queued = async () => await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async (tx) => ({
    documents: (await tx.select({ id: knowledgeDocuments.id }).from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, businessId))).length,
    imports: (await tx.select({ id: websiteIngestionJobs.id }).from(websiteIngestionJobs).where(eq(websiteIngestionJobs.businessId, businessId))).length,
    crawls: (await tx.select({ id: outboxMessages.id }).from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "knowledge.crawlWebsite")))).length,
  }));
  assert(JSON.stringify(await queued()) === JSON.stringify({ documents: 0, imports: 0, crawls: 0 }), "The onboarding website step queued a crawl.");
  await advanceOnboardingStage(context, { ...actor, to: "greeting" });
  // Greeting advances straight to plan; no personal phone verification gate.
  await advanceOnboardingStage(context, { ...actor, to: "plan" });
  assert((await getActiveOnboardingState(app.db, userId)).stage === "plan", "Greeting did not advance to plan without phone verification.");
  await advanceOnboardingStage(context, { ...actor, to: "knowledge" });
  const revisited = await saveOnboardingWebsite(context, { ...actor, websiteUrl: "https://www.example.org/" });
  business = await withBusinessTransaction(app.db, { ...actor, actorType: "operator" }, async (tx) => (await tx.select().from(businesses).where(eq(businesses.id, businessId)))[0]);
  assert(revisited.stage === "plan" && business?.onboardingStage === "plan", "Revisiting an earlier form regressed onboarding progress.");
  assert(business?.websiteUrl === "https://www.example.org/", "Revisiting the website step did not change the saved address.");
  assert(JSON.stringify(await queued()) === JSON.stringify({ documents: 0, imports: 0, crawls: 0 }), "Revisiting the website step queued a crawl.");
  await denied(() => advanceOnboardingStage(context, { businessId, userId: viewerId, to: "knowledge" }), "Viewer could mutate a completed onboarding step.");
  await denied(() => saveOnboardingWebsite(context, { ...website, userId: viewerId }), "Viewer could update the onboarding website.");
  await denied(() => saveOnboardingWebsite(context, { ...website, websiteUrl: "file:///etc/passwd" }), "Invalid website URL was accepted.");
  await auth.db.update(users).set({ activeBusinessId: businessId }).where(eq(users.id, userId));
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async tx => {
    await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "free_cloud" });
    await tx.update(businesses).set({ onboardingStage: "phone_number" }).where(eq(businesses.id, businessId));
  });
  assert((await getActiveOnboardingState(app.db, userId)).stage === "plan", "A legacy free-plan number stage skipped plan selection.");
  // A paid plan counts only while its subscription is live; without one it is Free.
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, tx => tx.update(billingAccounts).set({ plan: "starter", subscriptionState: "active" }).where(eq(billingAccounts.businessId, businessId)));
  assert((await getActiveOnboardingState(app.db, userId)).stage === "phone_number", "A paid number stage was incorrectly sent back to plan selection.");
  // Retired verification stages resume forward to plan instead of dead-ending.
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, tx => tx.update(businesses).set({ onboardingStage: "verify_phone_code" }).where(eq(businesses.id, businessId)));
  assert((await getActiveOnboardingState(app.db, userId)).stage === "plan", "A retired verification stage did not resume to plan.");
  await advanceOnboardingStage(context, { ...actor, to: "plan" });
  business = await withBusinessTransaction(app.db, { ...actor, actorType: "operator" }, async (tx) => (await tx.select().from(businesses).where(eq(businesses.id, businessId)))[0]);
  assert(business?.onboardingStage === "plan", "Advancing from a retired verification stage did not normalize to plan.");
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async tx => {
    await tx.update(billingAccounts).set({ plan: "free_cloud" }).where(eq(billingAccounts.businessId, businessId));
    await tx.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, businessId));
  });
  assert((await getActiveOnboardingState(app.db, userId)).stage === "complete", "Completed free onboarding was regressed.");
  console.log(JSON.stringify({ legacyFreeNumberReturnsToPlan: true, paidNumberStagePreserved: true, completedFreeStagePreserved: true, websiteAndStageAtomic: true, websiteStepQueuesNoCrawl: true, concurrentSavesAgree: true, greetingAdvancesToPlan: true, legacyVerificationResumesToPlan: true, revisitsPreserveProgress: true, viewerDenied: true, invalidUrlDenied: true }));
} finally {
  await withBusinessTransaction(worker.db, { businessId, actorType: "worker" }, async (tx) => tx.delete(businesses).where(eq(businesses.id, businessId)));
  for (const id of [userId, viewerId]) await auth.db.delete(users).where(eq(users.id, id));
  await Promise.all([auth.pool.end(), worker.pool.end(), app.pool.end()]);
}
