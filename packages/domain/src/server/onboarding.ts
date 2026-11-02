import { and, eq, inArray, sql } from "drizzle-orm";
import { isBillingPlanSlug, normalizeInterfaceLocale, type InterfaceLocale } from "@lobbystack/shared";

import { businesses, enqueueOutbox, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { requireBusinessAdmin } from "../authz";
import type { DomainContext } from "./context";
import { attributeBusiness } from "./affiliates";
import { limitsFor, readBillingPlanLimitBook, type BillingPlanLimitBook } from "./billingPlans";
import { deploymentAppName } from "./branding";
import { loadBillingContext } from "./usage";

// French puts no "de" before the name and Serbian never declines it, because
// the name is configured (see docs/branding.md).
const ONBOARDING_FOLLOWUP_SUBJECTS: Record<InterfaceLocale, (appName: string) => string> = {
  en: (appName) => `How'd you like ${appName}?`,
  fr: (appName) => `Votre avis sur ${appName} ?`,
  es: (appName) => `¿Qué le pareció ${appName}?`,
  sr: (appName) => `Kako Vam se dopao servis ${appName}?`,
};

export type OnboardingStage =
  | "create_business"
  | "knowledge"
  | "greeting"
  | "plan"
  | "phone_number"
  | "phone_number_claiming"
  | "attribution"
  | "complete";

const stageRoutes: Record<OnboardingStage, string> = {
  create_business: "/onboarding/business",
  knowledge: "/onboarding/knowledge",
  greeting: "/onboarding/greeting",
  plan: "/onboarding/plan",
  phone_number: "/onboarding/number",
  phone_number_claiming: "/onboarding/number",
  attribution: "/onboarding/attribution",
  complete: "/",
};

const stageSteps: Record<OnboardingStage, number> = {
  create_business: 2,
  knowledge: 3,
  greeting: 4,
  plan: 5,
  phone_number: 6,
  phone_number_claiming: 6,
  attribution: 7,
  complete: 8,
};

const transitions: Record<OnboardingStage, readonly OnboardingStage[]> = {
  create_business: ["knowledge"],
  knowledge: ["greeting"],
  greeting: ["plan"],
  plan: ["phone_number", "attribution"],
  phone_number: ["attribution"],
  phone_number_claiming: ["phone_number", "attribution"],
  attribution: ["complete"],
  complete: [],
};

// Steps removed from onboarding, and the step each resumes on, so a workspace
// parked on one before its removal moves on instead of looping on a step that
// no longer exists. Personal phone verification went first. The website step
// went next: onboarding no longer reads a website, and the Knowledge page
// still does.
const retiredStages: Readonly<Record<string, OnboardingStage>> = {
  verify_phone: "plan",
  verify_phone_code: "plan",
  website: "knowledge",
};

export function isOnboardingStage(value: unknown): value is OnboardingStage {
  return typeof value === "string" && Object.hasOwn(stageRoutes, value);
}

export function normalizeOnboardingStage(value: unknown): OnboardingStage {
  if (isOnboardingStage(value)) return value;
  if (typeof value === "string" && Object.hasOwn(retiredStages, value)) return retiredStages[value]!;
  return "create_business";
}

export function resolveOnboardingRoute(stage: string | null | undefined): string {
  return stageRoutes[normalizeOnboardingStage(stage ?? "create_business")];
}

// The steps a business on a plan without a number, such as Free, can't take,
// so the dashboard sends it back to its plan.
const numberStages: ReadonlySet<OnboardingStage> = new Set(["phone_number", "phone_number_claiming"]);

export function resolveOnboardingStageForPlan(stage: OnboardingStage, plan: string | null, limits: BillingPlanLimitBook, planCode: string | null = null): OnboardingStage {
  return numberStages.has(stage) && isBillingPlanSlug(plan) && limitsFor(limits, plan, planCode).includedBusinessNumbers === 0 ? "plan" : stage;
}

// The step the dashboard shows for a business's stored stage. Only the number
// steps depend on the plan in force, so only there does this read it, first
// scoping the transaction to the business. A lapsed subscription or an ended
// managed plan is Free there, whatever plan the account keeps.
export async function resolveOnboardingStageInTransaction(tx: DatabaseTransaction, businessId: string, storedStage: string): Promise<OnboardingStage> {
  const stage = normalizeOnboardingStage(storedStage);
  if (!numberStages.has(stage)) return stage;
  await tx.execute(sql`select set_config('app.business_id', ${businessId}, true)`);
  const { plan, planCode } = await loadBillingContext(tx, businessId);
  return resolveOnboardingStageForPlan(stage, plan, await readBillingPlanLimitBook(tx), planCode);
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

export async function advanceOnboardingStage(
  context: DomainContext,
  input: { userId: string; businessId: string; to: OnboardingStage },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const current = (await tx.select({ onboardingStage: businesses.onboardingStage }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1).for("update"))[0];
    if (!current) throw new Error("Business onboarding state was not found.");
    const currentStage = normalizeOnboardingStage(current.onboardingStage);
    // Repair a retired stage, such as a verification step or the website step,
    // before reading or advancing it so the conditional stage write below still
    // matches the persisted value.
    if (currentStage !== current.onboardingStage) {
      await tx.update(businesses)
        .set({ onboardingStage: currentStage, updatedAt: new Date() })
        .where(and(eq(businesses.id, input.businessId), eq(businesses.onboardingStage, current.onboardingStage)));
    }
    // Revisiting an earlier form must never move durable onboarding progress backwards.
    if (canVisitOnboardingStage(currentStage, input.to)) return;
    await advanceOnboardingStageInTransaction(tx, { ...input, from: currentStage });
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
