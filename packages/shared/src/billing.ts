export const billingPlanSlugs = [
  "self_host",
  "free_cloud",
  "starter",
  "pro",
  "enterprise",
] as const;
export type BillingPlanSlug = (typeof billingPlanSlugs)[number];

export function isBillingPlanSlug(value: string | null | undefined): value is BillingPlanSlug {
  return (billingPlanSlugs as readonly (string | null | undefined)[]).includes(value);
}

export const cloudBillingPlanSlugs = [
  "free_cloud",
  "starter",
  "pro",
  "enterprise",
] as const;
export type CloudBillingPlanSlug = (typeof cloudBillingPlanSlugs)[number];

export const hostedCheckoutPlanSlugs = ["starter", "pro"] as const;
export type HostedCheckoutPlanSlug = (typeof hostedCheckoutPlanSlugs)[number];

export const billingIntervals = ["monthly", "annual"] as const;
export type BillingInterval = (typeof billingIntervals)[number];
export type HostedCheckoutPlanIntervals = Record<
  HostedCheckoutPlanSlug,
  Array<BillingInterval>
>;

export const billingAddonSlugs = ["ai_sms"] as const;
export type BillingAddonSlug = (typeof billingAddonSlugs)[number];

export const billingUsageKinds = [
  "voice_seconds",
  "alert_sms_segments",
  "outbound_call_attempts",
  "ai_sms_segments",
  "chat_ai_tokens",
] as const;
export type BillingUsageKind = (typeof billingUsageKinds)[number];

/**
 * States in which a subscription is paying. `past_due` counts, so a failed charge
 * does not strip the number or the voice allowance while the provider retries.
 */
export const liveSubscriptionStates = ["active", "trialing", "past_due"] as const;

/** A billable plan on a live subscription: the gate for numbers and paid prompts. */
export function isPaidSubscription(plan: string | null | undefined, state: string | null | undefined): boolean {
  return ["starter", "pro", "enterprise"].includes(plan ?? "") && (liveSubscriptionStates as readonly string[]).includes(state ?? "");
}

const planTierRank: Record<HostedCheckoutPlanSlug, number> = { starter: 1, pro: 2 };

/**
 * What moving a paying business between Starter and Pro is: an upgrade to a
 * dearer tier, or to annual billing on the same tier; a downgrade the other
 * way; or none when the plan and interval stay the same.
 */
export function planChangeDirection(
  from: { plan: HostedCheckoutPlanSlug; interval: BillingInterval },
  to: { plan: HostedCheckoutPlanSlug; interval: BillingInterval },
): "upgrade" | "downgrade" | "none" {
  const tier = planTierRank[to.plan] - planTierRank[from.plan];
  if (tier !== 0) return tier > 0 ? "upgrade" : "downgrade";
  if (from.interval === to.interval) return "none";
  return to.interval === "annual" ? "upgrade" : "downgrade";
}

/**
 * Why Polar didn't move a paying business to the plan it picked. The worker
 * stores the sentence as the checkout request's error, which API callers read;
 * the dashboard turns it back into the code to say it in the viewer's language.
 */
export const planChangeRefusals = {
  payment_failed: "Polar couldn't charge the saved payment method for the new plan. Update it in the billing portal, then try again.",
  subscription_ending: "The subscription is set to end, so its plan can't change. Resume it in the billing portal first.",
  change_pending: "Polar is still applying an earlier change to this subscription. Try again in a minute.",
  subscription_unavailable: "Polar can't change this subscription right now. Check it in the billing portal.",
  product_unavailable: "Polar refused the new plan's product. Check that the plan's POLAR_*_PRODUCT_ID names a live recurring product.",
  token_scope: "Polar refused the worker's token. Give the worker's POLAR_ACCESS_TOKEN the subscriptions:write scope.",
} as const;
export type PlanChangeRefusal = keyof typeof planChangeRefusals;

/** The refusal a checkout request's error states, or null for any other error. */
export function planChangeRefusalOf(error: string | null | undefined): PlanChangeRefusal | null {
  return (Object.keys(planChangeRefusals) as PlanChangeRefusal[]).find((code) => planChangeRefusals[code] === error) ?? null;
}

export const billingTransactionKinds = ["order", "refund"] as const;
export type BillingTransactionKind = (typeof billingTransactionKinds)[number];

export const billingErrorCodes = {
  voiceLimitReached: "voice_limit_reached",
  alertSmsLimitReached: "alert_sms_limit_reached",
  outboundCallAttemptLimitReached: "outbound_call_attempt_limit_reached",
  aiSmsNotEnabled: "ai_sms_not_enabled",
  dedicatedNumberRequiresPaidPlan: "dedicated_number_requires_paid_plan",
  chatAiLimitReached: "chat_ai_limit_reached",
} as const;

export type BillingErrorCode =
  (typeof billingErrorCodes)[keyof typeof billingErrorCodes];

/** The two Polar servers: sandbox for test payments, production for real ones. Each has its own organizations, ids and tokens. */
export const polarBaseUrls = { sandbox: "https://sandbox-api.polar.sh", production: "https://api.polar.sh" } as const;
export type PolarEnv = keyof typeof polarBaseUrls;

/** The server a POLAR_API_BASE_URL names: sandbox for sandbox-api.polar.sh, else production, as an unset one means api.polar.sh. */
export function polarEnvForBaseUrl(baseUrl: string | null | undefined): PolarEnv {
  if (!baseUrl) return "production";
  try {
    return new URL(baseUrl).hostname === "sandbox-api.polar.sh" ? "sandbox" : "production";
  } catch {
    return "production";
  }
}

export const billingMeterEventNames = {
  voiceMinutes: "billing.voice_minutes",
  alertSmsSegments: "billing.alert_sms_segments",
  outboundCallAttempts: "billing.outbound_call_attempts",
  aiSmsSegments: "billing.ai_sms_segments",
  chatAiTokens: "billing.chat_ai_tokens",
} as const;

export const billingPlanCatalog = {
  self_host: {
    hostedBilling: false,
    monthlyChargeCents: 0,
    annualChargeCents: null,
    annualEffectiveMonthlyChargeCents: null,
    knowledgeStorageBytes: null,
    voiceSecondsIncluded: null,
    alertSmsSegmentsIncluded: null,
    outboundCallAttemptsIncluded: null,
    chatAiTokensIncluded: null,
    includedBusinessNumbers: null,
    overagesBillable: false,
    voiceOverageRatePerMinuteCents: null,
    alertSmsOverageRatePerSegmentCents: null,
    outboundCallAttemptOverageRateCents: null,
  },
  free_cloud: {
    hostedBilling: true,
    monthlyChargeCents: 0,
    annualChargeCents: null,
    annualEffectiveMonthlyChargeCents: null,
    knowledgeStorageBytes: 1 * 1024 * 1024,
    voiceSecondsIncluded: 1_800,
    alertSmsSegmentsIncluded: 10,
    outboundCallAttemptsIncluded: 2,
    chatAiTokensIncluded: 5,
    includedBusinessNumbers: 0,
    overagesBillable: false,
    voiceOverageRatePerMinuteCents: null,
    alertSmsOverageRatePerSegmentCents: null,
    outboundCallAttemptOverageRateCents: null,
  },
  starter: {
    hostedBilling: true,
    monthlyChargeCents: 3_000,
    annualChargeCents: 28_800,
    annualEffectiveMonthlyChargeCents: 2_400,
    knowledgeStorageBytes: 5 * 1024 * 1024,
    voiceSecondsIncluded: 9_000,
    alertSmsSegmentsIncluded: 50,
    outboundCallAttemptsIncluded: 20,
    chatAiTokensIncluded: 50,
    includedBusinessNumbers: 1,
    overagesBillable: true,
    voiceOverageRatePerMinuteCents: 20,
    alertSmsOverageRatePerSegmentCents: 2,
    outboundCallAttemptOverageRateCents: 2,
  },
  pro: {
    hostedBilling: true,
    monthlyChargeCents: 10_000,
    annualChargeCents: 96_000,
    annualEffectiveMonthlyChargeCents: 8_000,
    knowledgeStorageBytes: 20 * 1024 * 1024,
    voiceSecondsIncluded: 30_000,
    alertSmsSegmentsIncluded: 200,
    outboundCallAttemptsIncluded: 100,
    chatAiTokensIncluded: 200,
    includedBusinessNumbers: 1,
    overagesBillable: true,
    voiceOverageRatePerMinuteCents: 18,
    alertSmsOverageRatePerSegmentCents: 2,
    outboundCallAttemptOverageRateCents: 2,
  },
  enterprise: {
    hostedBilling: true,
    monthlyChargeCents: null,
    annualChargeCents: null,
    annualEffectiveMonthlyChargeCents: null,
    knowledgeStorageBytes: null,
    voiceSecondsIncluded: null,
    alertSmsSegmentsIncluded: null,
    outboundCallAttemptsIncluded: null,
    chatAiTokensIncluded: null,
    includedBusinessNumbers: null,
    overagesBillable: true,
    voiceOverageRatePerMinuteCents: null,
    alertSmsOverageRatePerSegmentCents: null,
    outboundCallAttemptOverageRateCents: null,
  },
} as const satisfies Record<
  BillingPlanSlug,
  {
    hostedBilling: boolean;
    monthlyChargeCents: number | null;
    annualChargeCents: number | null;
    annualEffectiveMonthlyChargeCents: number | null;
    knowledgeStorageBytes: number | null;
    voiceSecondsIncluded: number | null;
    alertSmsSegmentsIncluded: number | null;
    outboundCallAttemptsIncluded: number | null;
    chatAiTokensIncluded: number | null;
    includedBusinessNumbers: number | null;
    overagesBillable: boolean;
    voiceOverageRatePerMinuteCents: number | null;
    alertSmsOverageRatePerSegmentCents: number | null;
    outboundCallAttemptOverageRateCents: number | null;
  }
>;

export function getKnowledgeStorageLimitBytes(
  plan: BillingPlanSlug,
): number | null {
  return billingPlanCatalog[plan].knowledgeStorageBytes;
}

export const contentRetentionCategories = [
  "messages",
  "transcripts",
  "recordings",
  "follow_ups",
  // Debug traces of AI turns (ADR 0009), kept only for businesses that turn them on.
  "ai_traces",
] as const;
export type ContentRetentionCategory = (typeof contentRetentionCategories)[number];

export type ContentRetentionOverrides = Partial<
  Record<ContentRetentionCategory, number | undefined>
>;

/** Free content is a hard maximum: an override can never extend it past 30 days. */
export const FREE_CONTENT_RETENTION_MAX_DAYS = 30;

export const contentRetentionDaysByPlan = {
  self_host: { messages: 365, transcripts: 90, recordings: 90, follow_ups: 365, ai_traces: 30 },
  free_cloud: { messages: 30, transcripts: 30, recordings: 30, follow_ups: 30, ai_traces: 30 },
  starter: { messages: 365, transcripts: 90, recordings: 90, follow_ups: 365, ai_traces: 30 },
  pro: { messages: 365, transcripts: 90, recordings: 90, follow_ups: 365, ai_traces: 30 },
  enterprise: { messages: 365, transcripts: 90, recordings: 90, follow_ups: 365, ai_traces: 30 },
} as const satisfies Record<
  BillingPlanSlug,
  Record<ContentRetentionCategory, number>
>;

export function contentRetentionDaysForPlan(
  plan: BillingPlanSlug,
  category: ContentRetentionCategory,
  overrides?: ContentRetentionOverrides | null,
): number {
  const base = contentRetentionDaysByPlan[plan][category];
  if (plan === "free_cloud") {
    return Math.min(base, FREE_CONTENT_RETENTION_MAX_DAYS);
  }
  return overrides?.[category] ?? base;
}

export type PolarMeteredUsagePayload = {
  eventName:
    (typeof billingMeterEventNames)[keyof typeof billingMeterEventNames];
  quantity: number;
};

export function getPolarMeteredUsagePayload(
  usageKind: BillingUsageKind,
  quantity: number,
): PolarMeteredUsagePayload {
  switch (usageKind) {
    case "voice_seconds":
      return {
        eventName: billingMeterEventNames.voiceMinutes,
        quantity: quantity / 60,
      };
    case "alert_sms_segments":
      return {
        eventName: billingMeterEventNames.alertSmsSegments,
        quantity,
      };
    case "outbound_call_attempts":
      return {
        eventName: billingMeterEventNames.outboundCallAttempts,
        quantity,
      };
    case "ai_sms_segments":
      return {
        eventName: billingMeterEventNames.aiSmsSegments,
        quantity,
      };
    case "chat_ai_tokens":
      return {
        eventName: billingMeterEventNames.chatAiTokens,
        quantity,
      };
  }
}

export type BillingUsageSnapshot = {
  periodKey: string;
  resetAt: string;
  knowledgeStorageBytesUsed: number;
  knowledgeStorageBytesIncluded: number | null;
  voiceSecondsUsed: number;
  alertSmsSegmentsUsed: number;
  outboundCallAttemptsUsed: number;
  aiSmsSegmentsUsed: number;
  chatAiTokensUsed: number;
  voiceSecondsIncluded: number | null;
  alertSmsSegmentsIncluded: number | null;
  outboundCallAttemptsIncluded: number | null;
  chatAiTokensIncluded: number | null;
  voiceSecondsRemaining: number | null;
  alertSmsSegmentsRemaining: number | null;
  outboundCallAttemptsRemaining: number | null;
  voiceBlocked: boolean;
  alertSmsBlocked: boolean;
  outboundCallAttemptsBlocked: boolean;
  chatAiBlocked: boolean;
  knowledgeStorageBlocked: boolean;
};

export type BillingTransactionSummary = {
  kind: BillingTransactionKind;
  sourceId: string;
  status: string;
  amountCents: number;
  currency: string;
  description: string | null;
  occurredAt: string;
  invoiceUrl: string | null;
};

export type BillingStatus = {
  plan: BillingPlanSlug;
  billingKey: string;
  subscriptionState: string;
  billingInterval: BillingInterval | null;
  activeAddons: Array<BillingAddonSlug>;
  aiSmsEnabled: boolean;
  aiSmsReady: boolean;
  overagesBillable: boolean;
  overageSpendingCapCents: number | null;
  overageSpendCents: number;
  overageSpendCentsComplete: boolean;
  overageSpendingCapReached: boolean;
  monthlyChargeCents: number | null;
  billingPeriodChargeCents: number | null;
  billingContactEmail: string | null;
  billingContactName: string | null;
  includedBusinessNumbers: number | null;
  phoneNumberReclaimScheduledAt: number | null;
  hasBillingManagementAccess: boolean;
  hasCustomerPortalAccess: boolean;
  hasCheckoutAccess: boolean;
  availableCheckoutPlans: Array<HostedCheckoutPlanSlug>;
  availableCheckoutIntervals: HostedCheckoutPlanIntervals;
  canPurchaseAiSmsAddon: boolean;
  usage: BillingUsageSnapshot;
  recentTransactions: Array<BillingTransactionSummary>;
};

// Voice usage exemptions. Restored from the pre-PostgreSQL billing rules, which the
// plan comparison and the public pricing pages still advertise.
export const MIN_BILLABLE_VOICE_DURATION_SECONDS = 10;

export const nonBillableCallDispositions = ["spam_ended"] as const;
export type NonBillableCallDisposition = (typeof nonBillableCallDispositions)[number];

export function isNonBillableCallDisposition(disposition: string | null | undefined): boolean {
  return typeof disposition === "string" && (nonBillableCallDispositions as readonly string[]).includes(disposition);
}

/**
 * Voice seconds a call adds to usage: wrong numbers, instant hang-ups, and spam cost the caller nothing.
 *
 * Providers report whole seconds and round up, so a 9.2 second call arrives as 10. `measuredSeconds`
 * carries the unrounded elapsed time from the call record and decides the exemption when it is shorter.
 */
export function billableVoiceSeconds(durationSeconds: number, disposition?: string | null, measuredSeconds?: number): number {
  const normalizedDurationSeconds = Math.max(0, durationSeconds);
  if (isNonBillableCallDisposition(disposition)) return 0;
  const shortestObservedSeconds = measuredSeconds === undefined ? normalizedDurationSeconds : Math.min(normalizedDurationSeconds, Math.max(0, measuredSeconds));
  return shortestObservedSeconds < MIN_BILLABLE_VOICE_DURATION_SECONDS ? 0 : normalizedDurationSeconds;
}
