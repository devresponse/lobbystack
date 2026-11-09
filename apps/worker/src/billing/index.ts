// The worker's billing jobs, by job type. handlers.ts sends each of them here.
import type { JobEnvelope } from "@lobbystack/contracts";
import type { JobExecution, JobResult, WorkerDependencies } from "../handlers";
import { verifyBillingCatalog } from "./catalog";
import { createBillingCheckout } from "./checkout";
import { revokeBillingSubscription } from "./deletion";
import { ensureBillingOverage } from "./overage";
import { expireBillingPacks } from "./packs";
import { endBillingPromoPlan } from "./promo";
import { reconcileBillingEvent, sweepBilling } from "./reconcile";
import { changeBillingSubscription } from "./subscription";
import { checkBillingUsageTotals } from "./totals";
import { refreshBillingUnitEconomics, syncBillingUsage } from "./usage";

export type BillingJobType = "billing.syncUsage" | "billing.reconcile" | "billing.refreshUnitEconomics" | "billing.createCheckout" | "billing.endPromoPlan" | "billing.expirePacks" | "billing.revokeSubscription" | "billing.ensureOverage" | "billing.changeSubscription" | "billing.checkUsageTotals" | "billing.sweep" | "billing.verifyCatalog";
type BillingJob = (job: JobEnvelope, dependencies: WorkerDependencies, execution: JobExecution) => Promise<JobResult>;

export const billingJobs: Record<BillingJobType, BillingJob> = {
  "billing.syncUsage": syncBillingUsage,
  "billing.reconcile": reconcileBillingEvent,
  "billing.refreshUnitEconomics": refreshBillingUnitEconomics,
  "billing.createCheckout": createBillingCheckout,
  "billing.endPromoPlan": endBillingPromoPlan,
  "billing.expirePacks": expireBillingPacks,
  "billing.revokeSubscription": revokeBillingSubscription,
  "billing.ensureOverage": ensureBillingOverage,
  "billing.changeSubscription": changeBillingSubscription,
  "billing.checkUsageTotals": checkBillingUsageTotals,
  "billing.sweep": sweepBilling,
  "billing.verifyCatalog": verifyBillingCatalog,
};
