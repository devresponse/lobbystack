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

/** A billable plan on a live subscription: the gate for paid prompts. Numbers follow the plan's own count. */
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
 * Why Polar didn't move a paying business to the plan it picked, or make the
 * customer a new checkout is for. The worker stores the sentence as the
 * checkout request's error, which API callers read; the dashboard turns it
 * back into the code to say it in the viewer's language. The two billing email
 * ones ask for a billing email, which a new checkout request carries.
 */
export const planChangeRefusals = {
  payment_failed: "Polar couldn't charge the saved payment method for the new plan. Update it in the billing portal, then try again.",
  subscription_ending: "The subscription is set to end, so its plan can't change. Resume it in the billing portal first.",
  change_pending: "Polar is still applying an earlier change to this subscription. Try again in a minute.",
  subscription_unavailable: "Polar can't change this subscription right now. Check it in the billing portal.",
  product_unavailable: "Polar refused the new plan's product. Run pnpm billing verify to check that the plan is linked to a live recurring product.",
  token_scope: "Polar refused the worker's token. Give the worker's POLAR_ACCESS_TOKEN the subscriptions:write scope.",
  billing_email_taken: "Polar already has a customer with this email for another business. Start the checkout again with a billing email for this business.",
  billing_email_invalid: "Polar didn't accept the billing email. Start the checkout again with another one.",
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

/**
 * The Polar API version every call asks for and the webhook's payloads use.
 * Without one, Polar answers in its current version, which moves when it
 * releases another; a version it no longer serves gets 404 for every call.
 * Change it on purpose, after reading Polar's changelog: pnpm billing apply
 * then moves the webhook to it.
 */
export const POLAR_API_VERSION = "2026-10";

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

/**
 * The plans this code ships with, for a brand without a billing.json, such as
 * LobbyStack. They are only the seed: such a deployment shows and enforces
 * them until its first billing.json apply, while one whose brand has a file
 * uses the file's plans as its build carries them (brandBillingPlans), and
 * after the apply the billing catalog's rows decide prices, allowances, limits
 * and numbers. The app reads them only through builtInBillingPlanList and
 * builtInBillingPlanLimits, which billingPlans.ts falls back to; the landing
 * site's plan facts (product-capabilities.ts) and the number claims' fallback
 * in app.business_included_numbers (migration 0112) repeat them, whatever the
 * brand.
 */
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

/** What a plan includes each month and what usage past that costs: the terms usage limits enforce. Null means no limit. */
export type BillingPlanLimits = {
  knowledgeStorageBytes: number | null;
  voiceSecondsIncluded: number | null;
  alertSmsSegmentsIncluded: number | null;
  outboundCallAttemptsIncluded: number | null;
  chatAiTokensIncluded: number | null;
  includedBusinessNumbers: number | null;
  /** Usage past the allowance is billed rather than blocked. */
  overagesBillable: boolean;
  voiceOverageRatePerMinuteCents: number | null;
  alertSmsOverageRatePerSegmentCents: number | null;
  outboundCallAttemptOverageRateCents: number | null;
};

export type BillingPlanLimitTable = Record<BillingPlanSlug, BillingPlanLimits>;

const limitsOf = (plan: BillingPlanLimits): BillingPlanLimits => ({
  knowledgeStorageBytes: plan.knowledgeStorageBytes,
  voiceSecondsIncluded: plan.voiceSecondsIncluded,
  alertSmsSegmentsIncluded: plan.alertSmsSegmentsIncluded,
  outboundCallAttemptsIncluded: plan.outboundCallAttemptsIncluded,
  chatAiTokensIncluded: plan.chatAiTokensIncluded,
  includedBusinessNumbers: plan.includedBusinessNumbers,
  overagesBillable: plan.overagesBillable,
  voiceOverageRatePerMinuteCents: plan.voiceOverageRatePerMinuteCents,
  alertSmsOverageRatePerSegmentCents: plan.alertSmsOverageRatePerSegmentCents,
  outboundCallAttemptOverageRateCents: plan.outboundCallAttemptOverageRateCents,
});

/** The limits this code ships with, which a deployment whose brand has no billing.json enforces until its first catalog apply. */
export const builtInBillingPlanLimits = Object.fromEntries(billingPlanSlugs.map((slug) => [slug, limitsOf(billingPlanCatalog[slug])])) as BillingPlanLimitTable;

/** One price of a plan as the screens show it. */
export type BillingPlanPrice = {
  interval: BillingInterval;
  /** Three lowercase letters, such as cad. */
  currency: string;
  /** The price for one period. */
  amountCents: number;
  /** amountCents, or for annual amountCents / 12 rounded down. */
  monthlyAmountCents: number;
  /** A Polar product sells it here, so a plan button can start a checkout or a plan change. */
  checkoutAvailable: boolean;
};

/** A standard plan as the screens show it: what it includes, what usage past that costs, and its prices. Null means custom. */
export type BillingPlanOffer = {
  slug: CloudBillingPlanSlug;
  /** Priced by hand, with no fixed allowances. */
  custom: boolean;
  /** Usage past the allowance is billed rather than blocked. */
  overagesBillable: boolean;
  included: {
    voiceSeconds: number | null;
    alertSmsSegments: number | null;
    outboundCallAttempts: number | null;
    chatAiUnits: number | null;
    knowledgeStorageBytes: number | null;
    businessNumbers: number | null;
  };
  /** Cents for each unit past the allowance. */
  overageRates: {
    voiceMinuteCents: number | null;
    alertSmsSegmentCents: number | null;
    outboundCallAttemptCents: number | null;
  };
  sortOrder: number;
  /** None for a plan Polar doesn't sell, such as Free. */
  prices: BillingPlanPrice[];
};

/** What a plan's limits include each month, as the plan screens list it. Null means no limit. */
export function billingPlanIncluded(limits: BillingPlanLimits): BillingPlanOffer["included"] {
  return {
    voiceSeconds: limits.voiceSecondsIncluded,
    alertSmsSegments: limits.alertSmsSegmentsIncluded,
    outboundCallAttempts: limits.outboundCallAttemptsIncluded,
    chatAiUnits: limits.chatAiTokensIncluded,
    knowledgeStorageBytes: limits.knowledgeStorageBytes,
    businessNumbers: limits.includedBusinessNumbers,
  };
}

/**
 * The standard plans a deployment shows: from its billing catalog once a
 * billing.json is applied (catalog), else the ones its build carries
 * (built_in): its brand's billing.json, or for a brand without one, the
 * built-in plans in US dollars.
 */
export type BillingPlanList = {
  currency: string;
  source: "catalog" | "built_in";
  plans: BillingPlanOffer[];
};

/** The plans this code ships with, which a deployment whose brand has no billing.json shows until its first catalog apply. */
export function builtInBillingPlanList(checkoutAvailable: (plan: HostedCheckoutPlanSlug, interval: BillingInterval) => boolean = () => false): BillingPlanList {
  const currency = "usd";
  return {
    currency,
    source: "built_in",
    plans: cloudBillingPlanSlugs.map((slug, index) => {
      const plan = billingPlanCatalog[slug];
      const prices: BillingPlanPrice[] = [];
      if (slug === "starter" || slug === "pro") {
        const starterOrPro = billingPlanCatalog[slug];
        prices.push({ interval: "monthly", currency, amountCents: starterOrPro.monthlyChargeCents, monthlyAmountCents: starterOrPro.monthlyChargeCents, checkoutAvailable: checkoutAvailable(slug, "monthly") });
        prices.push({ interval: "annual", currency, amountCents: starterOrPro.annualChargeCents, monthlyAmountCents: starterOrPro.annualEffectiveMonthlyChargeCents, checkoutAvailable: checkoutAvailable(slug, "annual") });
      }
      return {
        slug,
        custom: slug === "enterprise",
        overagesBillable: plan.overagesBillable,
        included: {
          voiceSeconds: plan.voiceSecondsIncluded,
          alertSmsSegments: plan.alertSmsSegmentsIncluded,
          outboundCallAttempts: plan.outboundCallAttemptsIncluded,
          chatAiUnits: plan.chatAiTokensIncluded,
          knowledgeStorageBytes: plan.knowledgeStorageBytes,
          businessNumbers: plan.includedBusinessNumbers,
        },
        overageRates: {
          voiceMinuteCents: plan.voiceOverageRatePerMinuteCents,
          alertSmsSegmentCents: plan.alertSmsOverageRatePerSegmentCents,
          outboundCallAttemptCents: plan.outboundCallAttemptOverageRateCents,
        },
        sortOrder: index * 10,
        prices,
      };
    }),
  };
}

/** A plan's price for an interval, if it has one. */
export function billingPlanPrice(plan: Pick<BillingPlanOffer, "prices"> | undefined, interval: BillingInterval): BillingPlanPrice | undefined {
  return plan?.prices.find((price) => price.interval === interval);
}

/**
 * The whole percent annual billing saves over twelve monthly payments, as
 * every plan with both prices saves at least: null when none has both or
 * annual saves nothing.
 */
export function annualSavingPercent(list: Pick<BillingPlanList, "plans">): number | null {
  const savings = list.plans.flatMap((plan) => {
    const monthly = billingPlanPrice(plan, "monthly");
    const annual = billingPlanPrice(plan, "annual");
    const year = (monthly?.amountCents ?? 0) * 12;
    // Whole cents keep the percent exact: 1 - 0.8 in floating point floors to 19.
    return annual && year > 0 ? [Math.floor(((year - annual.amountCents) * 100) / year)] : [];
  });
  const least = savings.length ? Math.min(...savings) : 0;
  return least > 0 ? least : null;
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
