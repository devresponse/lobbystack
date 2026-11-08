// The worker's billing jobs, by job type. handlers.ts sends each of them here.
import type { JobEnvelope } from "@lobbystack/contracts";
import type { JobExecution, JobResult, WorkerDependencies } from "../handlers";
import { verifyBillingCatalog } from "./catalog";
import { createBillingCheckout } from "./checkout";
import { revokeBillingSubscription } from "./deletion";
import { endBillingPromoPlan } from "./promo";
import { reconcileBillingEvent, sweepBilling } from "./reconcile";
import { refreshBillingUnitEconomics, syncBillingUsage } from "./usage";

export type BillingJobType = "billing.syncUsage" | "billing.reconcile" | "billing.refreshUnitEconomics" | "billing.createCheckout" | "billing.endPromoPlan" | "billing.revokeSubscription" | "billing.sweep" | "billing.verifyCatalog";
type BillingJob = (job: JobEnvelope, dependencies: WorkerDependencies, execution: JobExecution) => Promise<JobResult>;

export const billingJobs: Record<BillingJobType, BillingJob> = {
  "billing.syncUsage": syncBillingUsage,
  "billing.reconcile": reconcileBillingEvent,
  "billing.refreshUnitEconomics": refreshBillingUnitEconomics,
  "billing.createCheckout": createBillingCheckout,
  "billing.endPromoPlan": endBillingPromoPlan,
  "billing.revokeSubscription": revokeBillingSubscription,
  "billing.sweep": sweepBilling,
  "billing.verifyCatalog": verifyBillingCatalog,
};
