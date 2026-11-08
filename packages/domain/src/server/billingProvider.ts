import type { BillingProviderId } from "@lobbystack/providers/billing/types";
import { billingProviderOf, type BillingCatalogLinkRequest, type BillingProfile, type BillingProviderEnv } from "@lobbystack/shared";

import { billingDeploymentPolar, billingDeploymentStripe, providerEnvOfPolar, type BillingDeploymentPolar, type BillingDeploymentStripe, type DesiredBillingPlan } from "./billingCatalog";
import { desiredPolarCatalog, planPolarChanges, polarLinkPlans, type DesiredPolarCatalog, type PolarPlanOptions, type PolarRefusal, type PolarStep } from "./billingPolar";
import { stripePlanner, type StripeRefusal } from "./billingStripe";
import { verifyBillingCatalog, type BillingVerifyInput, type BillingVerifyResult } from "./billingVerify";

// The catalog seam (ADR 0010): what pnpm billing and the daily check decide
// for a deployment's provider, pure, beside the catalog client in
// packages/providers that makes the calls.

/** adopt is Polar's: no older script made Stripe objects. */
export type CatalogPlanOptions = PolarPlanOptions;
export type CatalogRefusal = PolarRefusal | StripeRefusal;

/** What a planner builds the desired catalog from: the brand's file and plans, and the deployment's addresses. */
export type CatalogDesiredInput = {
  brand: string;
  profile: Pick<BillingProfile, "currency" | "polar" | "stripe">;
  plans: readonly DesiredBillingPlan[];
  /** The address the provider's webhook calls; null when the instance's address isn't known, and then not checked. */
  webhookUrl: string | null;
  /** The brand's terms and privacy pages, which Stripe's billing portal links to; absent or null leaves the provider's as they are. */
  links?: { termsUrl: string | null; privacyUrl: string | null };
};

export interface CatalogPlanner<Desired, Snapshot, Step, VerifyInput, Refusal extends CatalogRefusal> {
  readonly provider: BillingProviderId;
  /** What the brand's billing.json makes the provider sell. */
  desired(input: CatalogDesiredInput): Desired;
  /** The calls that take the provider's account from the snapshot to what's desired, and what stops them. */
  plan(input: { desired: Desired; snapshot: Snapshot; options: CatalogPlanOptions }): { steps: Step[]; refusals: Refusal[] };
  /** The file, the tables and the provider's account, compared two at a time. */
  verify(input: VerifyInput): BillingVerifyResult;
  /**
   * The link request's plans, in the provider's names, for a snapshot taken
   * once the account sells what's desired; the deployment-wide objects a link
   * records beyond them, on providers other than Polar; and what has no single object.
   */
  linkBody(input: { desired: Desired; snapshot: Snapshot; plans: readonly DesiredBillingPlan[] }): { plans: BillingCatalogLinkRequest["plans"]; objects?: Record<string, unknown>; missing: string[] };
}

/** Polar's planner: today's functions, unchanged. */
export const polarPlanner: CatalogPlanner<DesiredPolarCatalog, Parameters<typeof planPolarChanges>[0]["snapshot"], PolarStep, BillingVerifyInput, PolarRefusal> = {
  provider: "polar",
  desired: (input) => desiredPolarCatalog(input),
  plan: (input) => planPolarChanges({ catalog: input.desired, snapshot: input.snapshot, options: input.options }),
  verify: (input) => verifyBillingCatalog(input),
  linkBody: (input) => polarLinkPlans({ catalog: input.desired, plans: input.plans, snapshot: input.snapshot }),
};

/** The planner for a deployment's provider: polarPlanner, or stripePlanner in billingStripe.ts. */
export function plannerFor(provider: "polar"): typeof polarPlanner;
export function plannerFor(provider: "stripe"): typeof stripePlanner;
export function plannerFor(provider: BillingProviderId): typeof polarPlanner | typeof stripePlanner;
export function plannerFor(provider: BillingProviderId): typeof polarPlanner | typeof stripePlanner {
  // Read when called: billingStripe.ts and this file import each other.
  return provider === "stripe" ? stripePlanner : polarPlanner;
}

/** The deployment's billing provider and its settings, as the catalog and the daily check read them. */
export type BillingDeployment = {
  provider: BillingProviderId;
  providerEnv: BillingProviderEnv;
  /** The provider's account: POLAR_ORGANIZATION_ID or STRIPE_ACCOUNT_ID. Null when unset. */
  account: string | null;
  /** Polar's settings on a Polar deployment, else null. */
  polar: BillingDeploymentPolar | null;
  /** Stripe's settings on a Stripe deployment, else null. */
  stripe: BillingDeploymentStripe | null;
};

/** The deployment's billing settings from its variables: BILLING_PROVIDER's, Polar when unset. */
export function readBillingDeployment(env: Record<string, string | undefined>, options: { withSecret: boolean } = { withSecret: true }): BillingDeployment {
  if (billingProviderOf(env) === "stripe") {
    const stripe = billingDeploymentStripe(env, options);
    return { provider: "stripe", providerEnv: stripe.env, account: stripe.account, polar: null, stripe };
  }
  const polar = billingDeploymentPolar(env, options);
  return { provider: "polar", providerEnv: providerEnvOfPolar(polar.env), account: polar.org, polar, stripe: null };
}
