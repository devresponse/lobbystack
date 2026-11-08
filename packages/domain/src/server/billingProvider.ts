import type { BillingProviderId } from "@lobbystack/providers/billing/types";
import type { BillingCatalogLinkRequest, BillingProfile } from "@lobbystack/shared";

import { billingDeploymentPolar, providerEnvOfPolar, type BillingDeploymentPolar, type DesiredBillingPlan } from "./billingCatalog";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans, type DesiredPolarCatalog, type PolarPlanOptions, type PolarRefusal, type PolarStep } from "./billingPolar";
import { verifyBillingCatalog, type BillingVerifyInput, type BillingVerifyResult } from "./billingVerify";

// The catalog seam (ADR 0010): what pnpm billing and the daily check decide
// for a deployment's provider, pure, beside the catalog client in
// packages/providers that makes the calls.

export type CatalogPlanOptions = PolarPlanOptions;
export type CatalogRefusal = PolarRefusal;

export interface CatalogPlanner<Desired, Snapshot, Step> {
  readonly provider: BillingProviderId;
  /** What the brand's billing.json makes the provider sell. */
  desired(input: { brand: string; profile: Pick<BillingProfile, "currency" | "polar">; plans: readonly DesiredBillingPlan[]; webhookUrl: string | null }): Desired;
  /** The calls that take the provider's account from the snapshot to what's desired, and what stops them. */
  plan(input: { desired: Desired; snapshot: Snapshot; options: CatalogPlanOptions }): { steps: Step[]; refusals: CatalogRefusal[] };
  /** The file, the tables and the provider's account, compared two at a time. */
  verify(input: BillingVerifyInput): BillingVerifyResult;
  /** The link request's plans, in the provider's names, for a snapshot taken once the account sells what's desired, and what has no single object. */
  linkBody(input: { desired: Desired; snapshot: Snapshot; plans: readonly DesiredBillingPlan[] }): { plans: BillingCatalogLinkRequest["plans"]; missing: string[] };
}

/** Polar's planner: today's functions, unchanged. */
export const polarPlanner: CatalogPlanner<DesiredPolarCatalog, Parameters<typeof planPolarChanges>[0]["snapshot"], PolarStep> = {
  provider: "polar",
  desired: (input) => desiredPolarCatalog(input),
  plan: (input) => planPolarChanges({ catalog: input.desired, snapshot: input.snapshot, options: input.options }),
  verify: (input) => verifyBillingCatalog(input),
  linkBody: (input) => polarLinkPlans({ catalog: input.desired, plans: input.plans, snapshot: input.snapshot }),
};

/** The planner for a deployment's provider. */
export function plannerFor(provider: BillingProviderId): typeof polarPlanner {
  if (provider === "polar") return polarPlanner;
  throw new Error("Stripe's catalog planner isn't available yet: Stripe billing is still being built.");
}

/** The deployment's billing provider and its settings, as the catalog and the daily check read them. */
export type BillingDeployment = BillingDeploymentPolar & { provider: BillingProviderId; providerEnv: "sandbox" | "live" };

/** The deployment's billing settings from its variables: Polar's, the only provider until Stripe arrives. */
export function readBillingDeployment(env: Record<string, string | undefined>, options: { withSecret: boolean } = { withSecret: true }): BillingDeployment {
  const polar = billingDeploymentPolar(env, options);
  return { ...polar, provider: "polar", providerEnv: providerEnvOfPolar(polar.env) };
}
