import type { BillingPlanLimits, BillingPlanSlug } from "@lobbystack/shared";
import type { AnalyticsChannelCounts } from "./analytics-channels";

export type WorkspaceViewModel = {
  businessId: string;
  name: string;
  slug?: string;
  role: string;
  active: boolean;
  timezone?: string;
  businessType?: string;
};

export type AnalyticsMetricViewModel = {
  current: number;
  previous: number;
};

export type AnalyticsViewModel = {
  periodDays: number;
  from: string;
  to: string;
  granularity: "hour" | "day" | "week" | "month" | "year";
  calls: AnalyticsMetricViewModel;
  appointments: AnalyticsMetricViewModel;
  messages: AnalyticsMetricViewModel;
  averageCallDurationSeconds: number;
  agentResponseSeconds: AnalyticsMetricViewModel;
  series: Array<{
    bucket: string;
    agentResponseSeconds: number;
    calls: number;
    appointments: number;
    messages: number;
  }>;
  channels: AnalyticsChannelCounts;
  outcomes: Array<{ outcome: string; count: number }>;
};

export type CalendarOptionViewModel = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole?: string;
  selected: boolean;
};

export type CalendarConnectionViewModel = {
  id: string;
  provider: string;
  externalAccountId: string | null;
  status: string;
  staffId: string | null;
  selectedCalendarId: string | null;
  selectedCalendarSummary?: string | null;
  lastSyncedAt?: string | null;
  lastSyncError: string | null;
};

export type IntegrationsViewModel = {
  calendarConnections: CalendarConnectionViewModel[];
  staff: Array<{ id: string; name: string }>;
  calendarOptions: CalendarOptionViewModel[];
  discoveryError: string | null;
};

export type TeamMemberViewModel = {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  joinedAt: string;
};

export type TeamInvitationViewModel = {
  invitationId: string;
  email: string;
  role: string;
  status: string;
  /** A claim link: accepting it hands the business over to the invitee. */
  transfersOwnership?: boolean;
  expiresAt: string;
  invitedAt: string;
};

export type PhoneNumberViewModel = {
  id: string;
  e164: string;
  voiceEnabled: boolean;
  smsEnabled: boolean;
  status: string;
  reclaimScheduledAt: string | null;
  reclaimReason: string | null;
  /** Who answers the number's calls and texts. */
  receptionistId?: string | null;
};

export type BillingUsageViewModel = {
  knowledgeStorageBytesUsed: number;
  effectivePlan: BillingPlanSlug;
  /** What the effective plan includes, as the server enforces it. */
  limits: BillingPlanLimits;
  account: {
    plan: string | null;
    billingInterval: string | null;
    subscriptionState: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    overageSpendingCapCents: number | null;
  } | null;
  usage: Array<{
    periodKey: string;
    usageKind: string;
    quantity: number;
    isFinal: boolean;
    syncStatus: string;
  }>;
  usageStatus: {
    voiceSecondsUsed: number;
    alertSmsSegmentsUsed: number;
    outboundCallAttemptsUsed: number;
    voiceBlocked: boolean;
    alertSmsBlocked: boolean;
    outboundCallAttemptsBlocked: boolean;
    overageSpendCents: number;
    overageSpendingCapCents: number | null;
    overageSpendingCapReached: boolean;
    usageComplete: boolean;
    /** The live prepaid packs' balances on the prepaid tier, which every use draws instead of a monthly allowance; absent or null otherwise. */
    pack?: PackUsageViewModel | null;
  } | null;
};

/** What a pack holds of one allowance for its whole length: its total after refunds, what was used, and what is left. */
export type PackAllowanceViewModel = { total: number; used: number; left: number };
/** What a business's live packs hold, as GET /api/billing's usage status reports it on the prepaid tier. */
export type PackUsageViewModel = {
  secondsTotal: number;
  secondsUsed: number;
  secondsLeft: number;
  /** The live packs' texts, transfers and chats, which last their whole length as their minutes do. */
  alertSmsSegments: PackAllowanceViewModel;
  outboundCallAttempts: PackAllowanceViewModel;
  chatAiUnits: PackAllowanceViewModel;
  /** When the live pack that ends first ends; null when none ends. */
  nextEndsAt: string | null;
  /** When the last live pack ends; null when one never ends. */
  lastEndsAt: string | null;
};

/** A prepaid pack on sale, as GET /api/billing answers it. */
export type BillingPackOfferViewModel = {
  code: string;
  /** Display names by language: en, fr, es and sr. */
  names: Record<string, string>;
  /** The voice minutes the pack holds for its whole length. */
  minutes: number;
  voiceSeconds: number;
  /** How long it lasts from the payment, in days; null when it never ends. */
  days: number | null;
  amountCents: number;
  currency: string;
  /** What else it gives for its whole length, as its minutes are. */
  smsSegments: number;
  outboundCalls: number;
  chatUnits: number;
  /** Its limits while it lasts. */
  knowledgeStorageBytes: number;
  numbers: number;
  receptionists: number;
  /** The provider sells it here and the viewer may buy it now. */
  checkoutAvailable: boolean;
};

/** A pack the business holds with time left: live, or frozen while a dispute holds its payment. */
export type BillingPackViewModel = {
  id: string;
  code: string;
  names: Record<string, string>;
  status: "active" | "frozen";
  /** Its length in days, as bought; null when it never ends. */
  days: number | null;
  /** What was paid for it, in currency. */
  amountCents: number;
  currency: string;
  /** The seconds it holds after refunds. */
  secondsTotal: number;
  secondsLeft: number;
  paidAt: string;
  /** null when it never ends. */
  endsAt: string | null;
};

/** Why a business may not buy a pack now, as GET /api/billing answers it. */
export type PackCheckoutRefusal = "managed_plan" | "pack_not_sold_on_plan" | "pack_yearly_plan" | "pack_past_due" | "plan_change_payment_waiting";

/** Whether the business may buy a pack now, and the Starter or Pro subscription a pack's payment would end. */
export type PackCheckoutViewModel = {
  refusal: PackCheckoutRefusal | null;
  endsSubscription: { plan: "starter" | "pro"; promo: boolean; periodEnd: string | null } | null;
};
