import { and, eq, inArray, sql } from "drizzle-orm";
import { isBillingPlanSlug, normalizeInterfaceLocale, parseDeploymentMode, type InterfaceLocale } from "@lobbystack/shared";

import { businesses, enqueueOutbox, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { requireBusinessAdmin } from "../authz";
import type { DomainContext } from "./context";
import { attributeBusiness } from "./affiliates";
import { billingProviderConfigured, limitsFor, type BillingPlanLimitBook } from "./billingPlans";
import { deploymentAppName } from "./branding";
import { normalizeWebsiteSourceUrl } from "./knowledgeUrl";
import { loadBusinessPlanLimits } from "./usage";

// French puts no "de" before the name and Serbian never declines it, because
// the name is configured (see docs/branding.md).
const ONBOARDING_FOLLOWUP_SUBJECTS: Record<InterfaceLocale, (appName: string) => string> = {
  en: (appName) => `How'd you like ${appName}?`,
  fr: (appName) => `Votre avis sur ${appName} ?`,
  es: (appName) => `¿Qué le pareció ${appName}?`,
  sr: (appName) => `Kako Vam se dopao servis ${appName}?`,
};

// The steps in the order a business takes them. The plan comes right after
// the name, so the kind of account is chosen before anything else about the
// business is asked. A deployment that takes no payments has no plan step
// (onboardingHasPlanStep), and its businesses go from the name to the website.
export type OnboardingStage =
  | "create_business"
  | "plan"
  | "website"
  | "knowledge"
  | "greeting"
  | "phone_number"
  | "phone_number_claiming"
  | "attribution"
  | "complete";

const stageRoutes: Record<OnboardingStage, string> = {
  create_business: "/onboarding/business",
  plan: "/onboarding/plan",
  website: "/onboarding/website",
  knowledge: "/onboarding/knowledge",
  greeting: "/onboarding/greeting",
  phone_number: "/onboarding/number",
  phone_number_claiming: "/onboarding/number",
  attribution: "/onboarding/attribution",
  complete: "/",
};

const stageSteps: Record<OnboardingStage, number> = {
  create_business: 2,
  plan: 3,
  website: 4,
  knowledge: 5,
  greeting: 6,
  phone_number: 7,
  phone_number_claiming: 7,
  attribution: 8,
  complete: 9,
};

// After the name comes the plan step or, where the deployment has none, the
// website step. After the greeting comes the number step or, for a plan
// without a number to pick, the last step. advanceOnboardingStage decides
// both, so a request can't choose between them.
const transitions: Record<OnboardingStage, readonly OnboardingStage[]> = {
  create_business: ["plan", "website"],
  plan: ["website"],
  website: ["knowledge"],
  knowledge: ["greeting"],
  greeting: ["phone_number", "attribution"],
  phone_number: ["attribution"],
  phone_number_claiming: ["phone_number", "attribution"],
  attribution: ["complete"],
  complete: [],
};

/**
 * Whether onboarding has a plan step on this deployment: whether it takes
 * payments from the businesses it makes. A self-hosted server's businesses get
 * its unlimited plan, and a deployment whose billing provider isn't set up
 * sells nothing, so on both the step would offer only the plan the business
 * already has. Their onboarding goes from the name to the website, with seven
 * dots where a deployment that takes payments shows eight.
 */
export function onboardingHasPlanStep(env: Record<string, string | undefined> = process.env): boolean {
  return parseDeploymentMode(env.DEPLOYMENT_MODE) !== "self_hosted_standard" && billingProviderConfigured(env);
}

/** The stage a business takes once it has its name: the plan step where the deployment has one, else the website step. */
export function onboardingStageAfterName(env: Record<string, string | undefined> = process.env): "plan" | "website" {
  return onboardingHasPlanStep(env) ? "plan" : "website";
}

// Personal phone verification was removed from onboarding. Workspaces parked on
// a verification stage before the removal normalize to plan, the step that
// followed it then, so they resume instead of looping on a step that no longer
// exists.
const legacyVerificationStages = new Set(["verify_phone", "verify_phone_code"]);

export function isOnboardingStage(value: unknown): value is OnboardingStage {
  return typeof value === "string" && Object.hasOwn(stageRoutes, value);
}

export function normalizeOnboardingStage(value: unknown): OnboardingStage {
  if (isOnboardingStage(value)) return value;
  if (typeof value === "string" && legacyVerificationStages.has(value)) return "plan";
  return "create_business";
}

export function resolveOnboardingRoute(stage: string | null | undefined): string {
  return stageRoutes[normalizeOnboardingStage(stage ?? "create_business")];
}

// The steps a business on a plan without a number, such as Free, can't take,
// so the dashboard sends it back to its plan.
const numberStages: ReadonlySet<OnboardingStage> = new Set(["phone_number", "phone_number_claiming"]);

/**
 * The stage a business is on, from the one stored: a business stored on the
 * plan step where the deployment has none, as one left there by an earlier
 * release or before the deployment stopped taking payments, is on the website
 * step, which follows it.
 */
function currentOnboardingStage(storedStage: string, planStep: boolean): OnboardingStage {
  const stage = normalizeOnboardingStage(storedStage);
  return stage === "plan" && !planStep ? "website" : stage;
}

export function resolveOnboardingStageForPlan(stage: OnboardingStage, plan: string | null, limits: BillingPlanLimitBook, planCode: string | null = null, planStep: boolean = onboardingHasPlanStep()): OnboardingStage {
  return isBillingPlanSlug(plan) ? resolveOnboardingStageForNumbers(stage, limitsFor(limits, plan, planCode).includedBusinessNumbers, planStep) : currentOnboardingStage(stage, planStep);
}

/**
 * The step the dashboard shows for a stage, from the numbers the plan in force
 * includes, as loadBusinessPlanLimits reads them, a prepaid pack's own
 * included. A number step on a plan without a number, such as Free, goes back
 * to the plan step, where the plan can be changed. A deployment without a plan
 * step leaves it on the number step, which can be skipped.
 */
export function resolveOnboardingStageForNumbers(stage: OnboardingStage, includedBusinessNumbers: number | null, planStep: boolean = onboardingHasPlanStep()): OnboardingStage {
  return planStep && numberStages.has(stage) && includedBusinessNumbers === 0 ? "plan" : currentOnboardingStage(stage, planStep);
}

// The step the dashboard shows for a business's stored stage. Only the number
// steps depend on the plan in force, so only there does this read it, first
// scoping the transaction to the business. A lapsed subscription or an ended
// managed plan is Free there, whatever plan the account keeps; a business on
// a prepaid pack has the numbers its packs include.
export async function resolveOnboardingStageInTransaction(tx: DatabaseTransaction, businessId: string, storedStage: string): Promise<OnboardingStage> {
  const planStep = onboardingHasPlanStep();
  const stage = currentOnboardingStage(storedStage, planStep);
  if (!planStep || !numberStages.has(stage)) return stage;
  await tx.execute(sql`select set_config('app.business_id', ${businessId}, true)`);
  return resolveOnboardingStageForNumbers(stage, (await loadBusinessPlanLimits(tx, businessId)).limits.includedBusinessNumbers, planStep);
}

export function isValidOnboardingTransition(from: OnboardingStage, to: OnboardingStage): boolean {
  return transitions[from].includes(to);
}

export function canVisitOnboardingStage(current: OnboardingStage, target: OnboardingStage): boolean {
  return stageSteps[target] <= stageSteps[current];
}

// Prefer a membership the user can operate; fall back to the first active one.
export function selectPreferredMembership<T extends { role: string }>(rows: readonly T[]): T | undefined {
  return rows.find((row) => row.role !== "viewer") ?? rows[0];
}

async function onboardingStateForBusiness(
  tx: DatabaseTransaction,
  businessId: string,
): Promise<{ businessId: string; stage: OnboardingStage } | null> {
  await tx.execute(sql`select set_config('app.business_id', ${businessId}, true)`);
  const business = (await tx.select({ onboardingStage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, businessId)).limit(1))[0];
  if (!business) return null;
  return { businessId, stage: await resolveOnboardingStageInTransaction(tx, businessId, business.onboardingStage) };
}

export async function getActiveOnboardingState(
  db: Database,
  userId: string,
): Promise<{ businessId: string | null; stage: OnboardingStage }> {
  return await withBusinessTransaction(db, { userId, actorType: "operator" }, async (tx) => {
    const user = (await tx.select({ activeBusinessId: users.activeBusinessId }).from(users).where(eq(users.id, userId)).limit(1))[0];
    if (user?.activeBusinessId) {
      const active = await onboardingStateForBusiness(tx, user.activeBusinessId);
      if (active) return active;
    }
    // The stored active business is missing, or its membership is no longer
    // active (for example, removed after the legacy import). Fall back to an
    // active membership so onboarding still resolves a stage instead of
    // dead-ending on create_business and looping on the first step.
    const memberships = await tx.execute<{ business_id: string; role: string }>(sql`select business_id, role from app.list_user_businesses(${userId})`);
    const preferred = selectPreferredMembership(memberships.rows ?? []);
    if (preferred) {
      const fallback = await onboardingStateForBusiness(tx, String(preferred.business_id));
      if (fallback) return fallback;
    }
    return { businessId: null, stage: "create_business" };
  });
}

export async function advanceOnboardingStageInTransaction(
  tx: DatabaseTransaction,
  input: { userId: string; businessId: string; from: OnboardingStage; to: OnboardingStage },
): Promise<void> {
  await requireBusinessAdmin(tx, input);
  await moveOnboardingStageInTransaction(tx, input);
}

/** Moves a business to the next onboarding stage. The caller has already checked who may do that. */
export async function moveOnboardingStageInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; from: OnboardingStage; to: OnboardingStage },
): Promise<void> {
  if (!isValidOnboardingTransition(input.from, input.to)) {
    throw new Error(`Invalid onboarding transition from ${input.from} to ${input.to}.`);
  }
  const changed = await tx.update(businesses)
    .set({ onboardingStage: input.to, updatedAt: new Date() })
    .where(and(eq(businesses.id, input.businessId), eq(businesses.onboardingStage, input.from)))
    .returning({ id: businesses.id });
  if (!changed.length) {
    const error = new Error("The onboarding step is no longer current.") as Error & { status: number; code: string };
    error.status = 409;
    error.code = "onboarding_stage_conflict";
    throw error;
  }
}

/**
 * Whether the number step is for this business: its plan in force is a paid
 * one, or a prepaid pack, that includes a number. Free includes none, and a
 * self-hosted business adds its number in Settings. The transaction must be
 * scoped to the business.
 */
async function takesNumberStep(tx: DatabaseTransaction, businessId: string): Promise<boolean> {
  const { plan, limits } = await loadBusinessPlanLimits(tx, businessId);
  return (plan === "starter" || plan === "pro" || plan === "enterprise" || plan === "prepaid") && limits.includedBusinessNumbers !== 0;
}

/**
 * The step a request for `to` leads to for this business, where the server
 * decides between two:
 * - after the name, the plan step where the deployment has one, else the
 *   website step, whichever of the two is asked for;
 * - the number step only for a plan in force with a number to pick
 *   (takesNumberStep), else the last step, so Free goes past it.
 */
async function onboardingStepFor(tx: DatabaseTransaction, input: { businessId: string; from: OnboardingStage; to: OnboardingStage; planStep: boolean }): Promise<OnboardingStage> {
  if (input.to === "plan" && !input.planStep) return "website";
  if (input.from === "create_business" && input.to === "website" && input.planStep) return "plan";
  if (input.to === "phone_number" && !await takesNumberStep(tx, input.businessId)) return "attribution";
  return input.to;
}

/**
 * Moves a business on to the step after the one its owner or admin finished,
 * and returns the step to open next. That is `to`, or the step that stands in
 * for it for this business (onboardingStepFor). A step the business already
 * reached moves nothing, since revisiting an earlier form never takes progress
 * back, and the answer still names the step that follows the form.
 */
export async function advanceOnboardingStage(
  context: DomainContext,
  input: { userId: string; businessId: string; to: OnboardingStage },
): Promise<OnboardingStage> {
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const current = (await tx.select({ onboardingStage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1).for("update"))[0];
    if (!current) throw new Error("Business onboarding state was not found.");
    const planStep = onboardingHasPlanStep();
    const currentStage = currentOnboardingStage(current.onboardingStage, planStep);
    // Repair a legacy verification stage, or a plan stage where the deployment
    // has no plan step, before reading or advancing it so the conditional
    // stage write below still matches the persisted value.
    if (currentStage !== current.onboardingStage) {
      await tx.update(businesses)
        .set({ onboardingStage: currentStage, updatedAt: new Date() })
        .where(and(eq(businesses.id, input.businessId), eq(businesses.onboardingStage, current.onboardingStage)));
    }
    const to = await onboardingStepFor(tx, { businessId: input.businessId, from: currentStage, to: input.to, planStep });
    // Revisiting an earlier form must never move durable onboarding progress backwards.
    if (canVisitOnboardingStage(currentStage, to)) return to;
    await advanceOnboardingStageInTransaction(tx, { ...input, from: currentStage, to });
    return to;
  });
}

/**
 * Saves the address the owner gives on onboarding's website step as the
 * business's website, and moves a business on that step to knowledge. It reads
 * nothing: no knowledge source, website import or crawl is queued, so
 * onboarding never starts the crawler. The owner adds the site as knowledge
 * later, from the Knowledge page. Revisiting the step only changes the address.
 */
export async function saveOnboardingWebsite(
  context: DomainContext,
  input: { userId: string; businessId: string; websiteUrl: string },
): Promise<{ websiteUrl: string; stage: OnboardingStage }> {
  const websiteUrl = normalizeWebsiteSourceUrl(input.websiteUrl);
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const current = (await tx.select({ onboardingStage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1).for("update"))[0];
    if (!current) throw new Error("Business onboarding state was not found.");
    // A business stored on the plan step where the deployment has none is on this step (currentOnboardingStage),
    // so it is stored here first, and the move below finds it.
    const stage = currentOnboardingStage(current.onboardingStage, onboardingHasPlanStep());
    await tx.update(businesses).set({ websiteUrl, ...(stage === "website" ? { onboardingStage: stage } : {}), updatedAt: new Date() }).where(eq(businesses.id, input.businessId));
    // A business already past the step keeps its progress, and one that hasn't reached it stays where it is.
    if (stage !== "website") return { websiteUrl, stage };
    await moveOnboardingStageInTransaction(tx, { businessId: input.businessId, from: "website", to: "knowledge" });
    return { websiteUrl, stage: "knowledge" };
  });
}

export async function submitOnboardingAttribution(
  context: DomainContext,
  input: { userId: string; businessId: string; source?: string | null; referralCode?: string | null },
): Promise<void> {
  if (input.referralCode) {
    // Attribute before the stage moves to complete, so a retry after a failed
    // attribution still finds the "attribution" stage. Only that onboarding step
    // attributes, so a finished business cannot be credited to a new referrer.
    const stage = await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
      await requireBusinessAdmin(tx, input);
      return (await tx.select({ onboardingStage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1))[0]?.onboardingStage;
    });
    // The operator transaction above proved business administration. Attribution
    // runs separately as the system actor because the referrer's profile is not
    // visible under the referred operator's RLS context. It is idempotent, so a
    // retried submission cannot double count.
    if (stage === "attribution") {
      await attributeBusiness(context, { businessId: input.businessId, referredUserId: input.userId, referralCode: input.referralCode, source: "referral_link" });
    }
  }
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const changed = await tx.update(businesses)
      .set({ onboardingAttribution: input.source?.trim().slice(0, 120) || null, onboardingStage: "complete", updatedAt: new Date() })
      .where(and(eq(businesses.id, input.businessId), inArray(businesses.onboardingStage, ["attribution", "complete"])))
      .returning({ id: businesses.id });
    if (!changed.length) {
      const error = new Error("Attribution cannot be submitted at this onboarding stage.") as Error & { status: number; code: string };
      error.status = 409;
      error.code = "onboarding_stage_conflict";
      throw error;
    }
    await scheduleOnboardingFollowupInTransaction(tx, input.businessId, new Date());
  });
}

/** Schedules the founder's check-in a day after onboarding finished. */
export async function scheduleOnboardingFollowupInTransaction(tx: DatabaseTransaction, businessId: string, completedAt: Date): Promise<void> {
  // The dedupe key keeps a revisited attribution form from scheduling a second check-in.
  await enqueueOutbox(tx, {
    topic: "onboarding.sendFollowup",
    businessId,
    aggregateType: "business",
    aggregateId: businessId,
    dedupeKey: `onboarding-followup:${businessId}`,
    availableAt: new Date(completedAt.getTime() + ONBOARDING_FOLLOWUP_DELAY_MS),
    payload: { completedAt: completedAt.toISOString() },
  });
}

export const ONBOARDING_FOLLOWUP_DELAY_MS = 24 * 60 * 60_000;

export type OnboardingFollowupSender = {
  /** RFC 5322 sender, e.g. `Yuri from AlloPlace <yuri@alloplace.com>`. Replies go here. */
  from: string;
  /** First name used in the greeting and signature. */
  name: string;
};

/**
 * Queues the founder check-in email for a business that finished onboarding,
 * unless its owner has come back since or shares the sender's email domain.
 * Returns whether an email was queued.
 */
export async function queueOnboardingFollowupEmail(
  context: DomainContext,
  input: { businessId: string; completedAt: Date; sender: OnboardingFollowupSender },
): Promise<boolean> {
  const appName = await deploymentAppName(context.db);
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const result = await tx.execute<{ user_id: string; email: string; name: string | null; preferred_locale: string; business_name: string }>(
      sql`select user_id, email, name, preferred_locale, business_name from app.resolve_onboarding_followup_recipient(${input.businessId}::uuid, ${input.completedAt.toISOString()}::timestamptz)`,
    );
    const recipient = result.rows[0];
    if (!recipient) return false;
    const senderDomain = emailDomain(input.sender.from);
    if (senderDomain && emailDomain(recipient.email) === senderDomain) return false;
    const locale = normalizeInterfaceLocale(recipient.preferred_locale) ?? "en";
    const firstName = recipient.name?.trim().split(/\s+/)[0] ?? "";
    await enqueueOutbox(tx, {
      topic: "email.send",
      businessId: input.businessId,
      aggregateType: "business",
      aggregateId: input.businessId,
      dedupeKey: `onboarding-followup:${input.businessId}:email`,
      payload: {
        template: "onboarding_followup",
        to: recipient.email,
        from: input.sender.from,
        subject: ONBOARDING_FOLLOWUP_SUBJECTS[locale](appName),
        variables: { locale, firstName, businessName: recipient.business_name, senderName: input.sender.name },
      },
    });
    return true;
  });
}

function emailDomain(address: string): string | undefined {
  const match = /@([^\s>@]+)>?\s*$/.exec(address.trim());
  return match?.[1]?.toLowerCase();
}
