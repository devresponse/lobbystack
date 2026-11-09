// What the billing job tests share: the mocks handlers.test.ts set up for them,
// and a job envelope. Each test file mocks with these factories:
//   vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
//   vi.mock("@lobbystack/domain", async (importOriginal) => (await import("./testing")).mockDomain(importOriginal));
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { JobEnvelope } from "@lobbystack/contracts";

// A test that names the deployment gives it the AlloPlace brand file. The
// others show LobbyStack, as BRAND_PRESET=lobbystack picks it.
export const brand = { appBaseUrl: null as string | null };

export async function mockShared(importOriginal: <T>() => Promise<T>) {
  const shared = await importOriginal<typeof import("@lobbystack/shared")>();
  return { ...shared, currentBrand: () => shared.resolveBrand(brand.appBaseUrl ? { appBaseUrl: brand.appBaseUrl } : { preset: "lobbystack" }) };
}

export async function mockDomain(importOriginal: <T>() => Promise<T>): Promise<Record<string, unknown>> {
  const actual = await importOriginal<typeof import("@lobbystack/domain")>();
  return {
    ...actual,
    claimAppointmentChangeOtp: vi.fn(),
    claimBillingCheckoutRequest: vi.fn(),
    // No other change holds the subscription unless a test says so.
    claimBillingSubscription: vi.fn(async () => ({ claimId: "subscription-claim" })),
    releaseBillingSubscription: vi.fn(),
    claimBillingUsageSync: vi.fn(),
    confirmBillingUsageSync: vi.fn(),
    expireProspectDemos: vi.fn(),
    enforceReceptionistAllowance: vi.fn(),
    generateAffiliatePayoutRun: vi.fn(),
    runDailyBillingVerify: vi.fn(),
    sweepBillingWork: vi.fn(),
    releaseBillingCheckoutRequest: vi.fn(),
    loadPromoEndWork: vi.fn(),
    loadPlanEndForPackWork: vi.fn(),
    recordPromoEnd: vi.fn(),
    recordDeletedBusinessPlanEnded: vi.fn(),
    loadAppointmentChangeOtpTarget: vi.fn(),
    loadBillingCheckoutRequest: vi.fn(),
    loadBillingEventSubject: vi.fn(),
    loadBillingUsageEvent: vi.fn(),
    loadPendingProductEvents: vi.fn(),
    loadPlanChangeProration: vi.fn(),
    // Stripe directly, as a file without a stripe block sells.
    loadStripeSelling: vi.fn(async () => ({ managedPayments: false, overage: "separate", currency: "cad", usageGraceHours: 1 })),
    // No catalog rows: checkout sells through the product variables each test sets.
    readPolarProductLinks: vi.fn(async () => actual.polarProductLinks({ plans: [], prices: [] }, process.env)),
    markBillingPlanChanged: vi.fn(),
    markBillingCheckoutCreated: vi.fn(),
    markBillingCheckoutFailed: vi.fn(),
    markAppointmentChangeOtpSent: vi.fn(),
    claimNotificationDelivery: vi.fn(),
    claimOperatorNotificationDelivery: vi.fn(),
    notificationLeaseEndsAt: vi.fn(),
    operatorNotificationLeaseEndsAt: vi.fn(),
    cancelRetiredPhoneVerificationSend: vi.fn(),
    issueOperatorPhoneVerificationCode: vi.fn(),
    markOperatorPhoneVerificationCodeSent: vi.fn(),
    releaseOperatorPhoneVerificationCodeSend: vi.fn(),
    reserveAlertSmsUsage: vi.fn(),
    correctAlertSmsUsage: vi.fn(),
    enqueueBillingUsageSync: vi.fn(),
    queueOnboardingFollowupEmail: vi.fn(),
    claimNumberProvisioning: vi.fn(),
    numberProvisioningLeaseEndsAt: vi.fn(),
    countPublishableOutboxMessages: vi.fn(),
    deleteCallRecording: vi.fn(),
    deleteCallRecordingForRetention: vi.fn(),
    deleteSentProductEventsBefore: vi.fn(),
    loadOperatorNotificationDelivery: vi.fn(),
    loadCallTranscriptEmail: vi.fn(),
    markOperatorNotificationSent: vi.fn(),
    markOperatorNotificationSkipped: vi.fn(),
    markOperatorNotificationFailed: vi.fn(),
    queueDailyOperatorSummaries: vi.fn(),
    completeNumberProvisioning: vi.fn(),
    failNumberProvisioning: vi.fn(),
    releaseOperatorNotificationDelivery: vi.fn(),
    markNotificationSent: vi.fn(),
    recordCallProviderPricing: vi.fn(),
    recheckProviderPrice: vi.fn(),
    loadLiveCallForPricing: vi.fn(),
    recordProductEvent: vi.fn(),
    recordSmsProviderPricing: vi.fn(),
    reconcileBillingProviderEvent: vi.fn(),
    transitionProcessingNotification: vi.fn(),
    resolveNotificationDelivery: vi.fn(),
    runPrivacyRetentionSweep: vi.fn(),
  };
}

export function billingJob(payload: Record<string, unknown>): JobEnvelope {
  return {
    jobId: randomUUID(),
    type: "billing.syncUsage",
    queue: "critical",
    businessId: randomUUID(),
    payload,
    trace: {},
    idempotencyKey: `test:${randomUUID()}`,
    scheduled: false,
  };
}
