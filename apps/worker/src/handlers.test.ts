import { randomUUID } from "node:crypto";

import { UnrecoverableError } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import type { JobEnvelope } from "@lobbystack/contracts";
import { PolarRequestError, type PolarSubscription } from "@lobbystack/providers/polar/polarBilling";
import { planChangeRefusalOf, planChangeRefusals } from "@lobbystack/shared";
import { claimAppointmentChangeOtp, claimBillingCheckoutRequest, claimBillingSubscription, claimBillingUsageSync, claimNotificationDelivery, confirmBillingUsageSync, countPublishableOutboxMessages, deleteCallRecording, deleteCallRecordingForRetention, deleteSentProductEventsBefore, expireProspectDemos, generateAffiliatePayoutRun, loadAppointmentChangeOtpTarget, loadBillingCheckoutRequest, loadBillingUsageEvent, loadPendingProductEvents, loadPlanChangeProration, markAppointmentChangeOtpSent, polarProductLinks, readPolarProductLinks, markBillingCheckoutCreated, markBillingCheckoutFailed, markBillingPlanChanged, markNotificationSent, loadLiveCallForPricing, recordCallProviderPricing, recordProductEvent, recordSmsProviderPricing, reconcileBillingProviderEvent, resolveNotificationDelivery, runPrivacyRetentionSweep, transitionProcessingNotification } from "@lobbystack/domain";
import { claimOperatorNotificationDelivery, loadOperatorNotificationDelivery, markOperatorNotificationSent, notificationLeaseEndsAt, operatorNotificationLeaseEndsAt, queueDailyOperatorSummaries } from "@lobbystack/domain";
import { cancelRetiredPhoneVerificationSend, queueOnboardingFollowupEmail } from "@lobbystack/domain";
import { correctAlertSmsUsage, enqueueBillingUsageSync, issueOperatorPhoneVerificationCode, markOperatorPhoneVerificationCodeSent, releaseOperatorPhoneVerificationCodeSend, reserveAlertSmsUsage } from "@lobbystack/domain";
import { claimNumberProvisioning, completeNumberProvisioning, failNumberProvisioning, numberProvisioningLeaseEndsAt } from "@lobbystack/domain";
import { PROVIDER_PRICE_RECHECKS, recheckProviderPrice } from "@lobbystack/domain";
import { releaseBillingCheckoutRequest, releaseBillingSubscription, runDailyBillingVerify, sweepBillingWork } from "@lobbystack/domain";
import { loadPromoEndWork, recordPromoEnd, type PromoEndWork } from "@lobbystack/domain";

// A test that names the deployment gives it the AlloPlace brand file.
const brand = vi.hoisted(() => ({ appBaseUrl: null as string | null }));
vi.mock("@lobbystack/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@lobbystack/shared")>();
  return { ...shared, currentBrand: () => brand.appBaseUrl ? shared.resolveBrand({ appBaseUrl: brand.appBaseUrl }) : shared.currentBrand() };
});

vi.mock("@lobbystack/domain", async (importOriginal) => {
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
    generateAffiliatePayoutRun: vi.fn(),
    runDailyBillingVerify: vi.fn(),
    sweepBillingWork: vi.fn(),
    releaseBillingCheckoutRequest: vi.fn(),
    loadPromoEndWork: vi.fn(),
    recordPromoEnd: vi.fn(),
    loadAppointmentChangeOtpTarget: vi.fn(),
    loadBillingCheckoutRequest: vi.fn(),
    loadBillingUsageEvent: vi.fn(),
    loadPendingProductEvents: vi.fn(),
    loadPlanChangeProration: vi.fn(),
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
    markOperatorNotificationSent: vi.fn(),
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
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  brand.appBaseUrl = null;
});

import { handleJob, type WorkerDependencies } from "./handlers";

function billingJob(payload: Record<string, unknown>): JobEnvelope {
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

function notificationJob(payload: Record<string, unknown>): JobEnvelope {
  return {
    jobId: randomUUID(),
    type: "notification.dispatch",
    queue: "default",
    businessId: randomUUID(),
    payload,
    trace: {},
    idempotencyKey: `test:${randomUUID()}`,
    scheduled: false,
  };
}

function pricingJob(type: "sms.syncPrice" | "call.syncPrice", payload: Record<string, unknown>): JobEnvelope {
  return {
    jobId: randomUUID(),
    type,
    queue: "critical",
    businessId: randomUUID(),
    payload,
    trace: {},
    idempotencyKey: `test:${randomUUID()}`,
    scheduled: false,
  };
}

describe("worker handlers", () => {
  it.each(["verify_email", "password_reset", "existing_account"])("fails %s delivery when SMTP is missing", async template => {
    await expect(handleJob({ jobId: randomUUID(), businessId: null, type: "email.send", queue: "default", payload: { template }, trace: {}, idempotencyKey: randomUUID(), scheduled: false }, { domain: { db: undefined as never } })).rejects.toThrow("SMTP configuration");
  });
  it("skips the onboarding follow-up when no founder sender is configured", async () => {
    const businessId = randomUUID();
    const job = { jobId: randomUUID(), type: "onboarding.sendFollowup" as const, queue: "default" as const, businessId, payload: { completedAt: new Date().toISOString() }, trace: {}, idempotencyKey: `onboarding-followup:${businessId}`, scheduled: false };
    await expect(handleJob(job, { domain: { db: undefined as never }, email: { sendTemplate: vi.fn() } })).resolves.toEqual({ status: "skipped" });
    expect(queueOnboardingFollowupEmail).not.toHaveBeenCalled();
  });
  it("queues the onboarding follow-up through the domain with the configured sender", async () => {
    const businessId = randomUUID(); const domain = { db: undefined as never };
    const completedAt = "2026-09-24T10:00:00.000Z";
    const sender = { from: "Raphael from LobbyStack <raphael@lobbystack.com>", name: "Raphael" };
    vi.mocked(queueOnboardingFollowupEmail).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const job = { jobId: randomUUID(), type: "onboarding.sendFollowup" as const, queue: "default" as const, businessId, payload: { completedAt }, trace: {}, idempotencyKey: `onboarding-followup:${businessId}`, scheduled: false };
    await expect(handleJob(job, { domain, email: { sendTemplate: vi.fn() }, onboardingFollowupSender: sender })).resolves.toEqual({ status: "completed", entityId: businessId });
    expect(queueOnboardingFollowupEmail).toHaveBeenCalledWith(domain, { businessId, completedAt: new Date(completedAt), sender });
    await expect(handleJob(job, { domain, email: { sendTemplate: vi.fn() }, onboardingFollowupSender: sender })).resolves.toEqual({ status: "skipped", entityId: businessId });
    await expect(handleJob({ ...job, payload: {} }, { domain, email: { sendTemplate: vi.fn() }, onboardingFollowupSender: sender })).rejects.toThrow("Invalid onboarding follow-up payload.");
  });
  it("sends onboarding follow-up email from the founder sender", async () => {
    const sendTemplate = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const payload = { template: "onboarding_followup", to: "owner@example.test", from: "Raphael <raphael@lobbystack.com>", subject: "How'd you like LobbyStack?", variables: { businessName: "Acme" } };
    await handleJob({ jobId: randomUUID(), businessId: randomUUID(), type: "email.send", queue: "default", payload, trace: {}, idempotencyKey: "onboarding-followup:x:email", scheduled: false }, { domain: { db: undefined as never }, email: { sendTemplate } });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ template: "onboarding_followup", to: "owner@example.test", from: "Raphael <raphael@lobbystack.com>", appName: "LobbyStack" }));
  });
  it("names the deployment in emails and gives invitations their own subject", async () => {
    brand.appBaseUrl = "https://demo.alloplace.com";
    const sendTemplate = vi.fn().mockResolvedValue({ messageId: "provider-id" });
    const invitation = { invitationId: randomUUID(), email: "agent@example.test", token: "token", template: "invitation", url: "https://app.example.test/invite/token" };
    await handleJob({ jobId: randomUUID(), businessId: randomUUID(), type: "email.send", queue: "default", payload: invitation, trace: {}, idempotencyKey: "invitation:x:send", scheduled: false }, { domain: { db: undefined as never }, email: { sendTemplate } });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ template: "invitation", to: "agent@example.test", subject: "You're invited to join AlloPlace", appName: "AlloPlace" }));
    // An invitation that names its business says so, in the inviter's language.
    const named = { ...invitation, variables: { url: invitation.url, businessName: "Maple Dental", role: "viewer", transfersOwnership: "false", locale: "fr" } };
    await handleJob({ jobId: randomUUID(), businessId: randomUUID(), type: "email.send", queue: "default", payload: named, trace: {}, idempotencyKey: "invitation:y:send", scheduled: false }, { domain: { db: undefined as never }, email: { sendTemplate } });
    expect(sendTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ template: "invitation", subject: "Invitation à rejoindre Maple Dental sur AlloPlace", variables: named.variables }));
    await handleJob({ jobId: randomUUID(), businessId: randomUUID(), type: "email.send", queue: "default", payload: { template: "operator_alert", to: "owner@example.test", message: "Hi" }, trace: {}, idempotencyKey: "alert:x", scheduled: false }, { domain: { db: undefined as never }, email: { sendTemplate } });
    expect(sendTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ subject: "AlloPlace notification", appName: "AlloPlace" }));
  });
  it("drains a retired phone verification send without contacting the provider", async () => {
    const businessId = randomUUID(); const attemptId = randomUUID(); const domain = { db: undefined as never };
    const verifyPhone = vi.fn();
    const result = await handleJob({ jobId: randomUUID(), type: "phoneVerification.send", queue: "critical", businessId, payload: { attemptId }, trace: {}, idempotencyKey: `phone:${attemptId}`, scheduled: false }, { domain, twilio: { sendSms: vi.fn(), verifyPhone } });
    expect(result).toEqual({ status: "skipped", entityId: attemptId });
    expect(cancelRetiredPhoneVerificationSend).toHaveBeenCalledWith(domain, { businessId, attemptId });
    expect(verifyPhone).not.toHaveBeenCalled();
  });

  describe("operator phone verification codes", () => {
    const codeJob = (businessId: string, attemptId: string, locale?: string): JobEnvelope => ({ jobId: randomUUID(), type: "phoneVerification.sendCode", queue: "critical", businessId, payload: { attemptId, ...(locale ? { locale } : {}) }, trace: {}, idempotencyKey: `phone-code:${attemptId}`, scheduled: false });

    it("texts the code from the restricted alert sender and marks it sent", async () => {
      const businessId = randomUUID(); const attemptId = randomUUID(); const domain = { db: undefined as never };
      brand.appBaseUrl = "https://demo.alloplace.com";
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue({ to: "+14165550123", from: "+14165550100", code: "482913" });
      const alertSms = vi.fn().mockResolvedValue({ providerMessageId: "SMalert" }); const mainSms = vi.fn();
      const result = await handleJob(codeJob(businessId, attemptId), { domain, twilio: { sendSms: mainSms }, twilioAlerts: { from: "+14165550100", sendSms: alertSms } });
      expect(result).toEqual({ status: "completed", entityId: attemptId });
      expect(issueOperatorPhoneVerificationCode).toHaveBeenCalledWith(domain, { businessId, attemptId });
      expect(alertSms).toHaveBeenCalledWith({ to: "+14165550123", from: "+14165550100", body: "AlloPlace verification code: 482913. It expires in 10 minutes." });
      expect(mainSms).not.toHaveBeenCalled();
      expect(markOperatorPhoneVerificationCodeSent).toHaveBeenCalledWith(domain, { businessId, attemptId });
    });

    it("texts the code in the operator's language", async () => {
      const businessId = randomUUID(); const attemptId = randomUUID(); const sendSms = vi.fn().mockResolvedValue({ providerMessageId: "SM1" });
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue({ to: "+14165550123", from: "+14165550100", code: "482913" });
      await handleJob(codeJob(businessId, attemptId, "fr"), { domain: { db: undefined as never }, twilio: { sendSms } });
      expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ body: "Code de vérification LobbyStack : 482913. Il expire dans 10 minutes." }));
    });

    it("meters the code against the alert SMS quota", async () => {
      const businessId = randomUUID(); const attemptId = randomUUID(); const domain = { db: {} as never };
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue({ to: "+14165550123", from: "+14165550100", code: "482913" });
      vi.mocked(reserveAlertSmsUsage).mockResolvedValue({ allowed: true, usageEventId: "usage-1" } as never);
      vi.mocked(correctAlertSmsUsage).mockResolvedValue("usage-1");
      const sendSms = vi.fn().mockResolvedValue({ providerMessageId: "SM1" });
      await expect(handleJob(codeJob(businessId, attemptId), { domain, twilio: { sendSms } })).resolves.toEqual({ status: "completed", entityId: attemptId });
      expect(reserveAlertSmsUsage).toHaveBeenCalledWith(domain, { businessId, sourceKey: `alert_sms:phone_verification:${attemptId}`, estimatedSegments: 1 });
      // No delivery report comes back for a code, so the estimate settles its usage before it syncs.
      expect(correctAlertSmsUsage).toHaveBeenCalledWith(domain, { businessId, sourceKey: `alert_sms:phone_verification:${attemptId}`, segments: 1 });
      expect(enqueueBillingUsageSync).toHaveBeenCalledWith(domain, { businessId, usageEventId: "usage-1" });
    });

    it("fails the attempt without texting when the alert SMS quota is used up", async () => {
      const businessId = randomUUID(); const attemptId = randomUUID(); const domain = { db: {} as never };
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue({ to: "+14165550123", from: "+14165550100", code: "482913" });
      vi.mocked(reserveAlertSmsUsage).mockResolvedValue({ allowed: false, errorCode: "alert_sms_quota_reached" } as never);
      const sendSms = vi.fn();
      await expect(handleJob(codeJob(businessId, attemptId), { domain, twilio: { sendSms } })).resolves.toEqual({ status: "skipped", entityId: attemptId });
      expect(sendSms).not.toHaveBeenCalled();
      expect(releaseOperatorPhoneVerificationCodeSend).toHaveBeenCalledWith(domain, { businessId, attemptId, retry: false, error: "alert_sms_quota_reached" });
    });

    it("gives back the reserved usage when the send fails", async () => {
      const businessId = randomUUID(); const attemptId = randomUUID(); const domain = { db: {} as never };
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue({ to: "+14165550123", from: "+14165550100", code: "482913" });
      vi.mocked(reserveAlertSmsUsage).mockResolvedValue({ allowed: true, usageEventId: "usage-1" } as never);
      vi.mocked(correctAlertSmsUsage).mockResolvedValue("usage-1");
      const sendSms = vi.fn().mockRejectedValue(new Error("timeout"));
      await expect(handleJob(codeJob(businessId, attemptId), { domain, twilio: { sendSms } }, { isFinalAttempt: false })).rejects.toThrow("timeout");
      expect(correctAlertSmsUsage).toHaveBeenCalledWith(domain, { businessId, sourceKey: `alert_sms:phone_verification:${attemptId}`, segments: 0 });
    });

    it("uses the business's own number when it is the alert sender", async () => {
      const businessId = randomUUID(); const attemptId = randomUUID(); const domain = { db: undefined as never };
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue({ to: "+14165550123", from: "+14165550199", code: "482913" });
      const alertSms = vi.fn(); const mainSms = vi.fn().mockResolvedValue({ providerMessageId: "SMmain" });
      await handleJob(codeJob(businessId, attemptId), { domain, twilio: { sendSms: mainSms }, twilioAlerts: { from: "+14165550100", sendSms: alertSms } });
      expect(mainSms).toHaveBeenCalledWith(expect.objectContaining({ from: "+14165550199" }));
      expect(alertSms).not.toHaveBeenCalled();
    });

    it("skips an attempt that was replaced before the send", async () => {
      const attemptId = randomUUID(); const sendSms = vi.fn();
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue(null);
      await expect(handleJob(codeJob(randomUUID(), attemptId), { domain: { db: undefined as never }, twilio: { sendSms } })).resolves.toEqual({ status: "skipped", entityId: attemptId });
      expect(sendSms).not.toHaveBeenCalled();
    });

    it("marks a code sent when a retry finds the text already went out", async () => {
      const businessId = randomUUID(); const attemptId = randomUUID(); const domain = { db: undefined as never }; const sendSms = vi.fn();
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue(null);
      await expect(handleJob(codeJob(businessId, attemptId), { domain, twilio: { sendSms } })).resolves.toEqual({ status: "skipped", entityId: attemptId });
      expect(sendSms).not.toHaveBeenCalled();
      expect(markOperatorPhoneVerificationCodeSent).toHaveBeenCalledWith(domain, { businessId, attemptId });
    });

    it("fails the attempt without a retry when Twilio rejects the number", async () => {
      const businessId = randomUUID(); const attemptId = randomUUID(); const domain = { db: undefined as never };
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue({ to: "+14165550123", from: "+14165550100", code: "482913" });
      const sendSms = vi.fn().mockRejectedValue(Object.assign(new Error("unreachable"), { code: 21614 }));
      await expect(handleJob(codeJob(businessId, attemptId), { domain, twilio: { sendSms } }, { isFinalAttempt: false })).resolves.toEqual({ status: "skipped", entityId: attemptId });
      expect(releaseOperatorPhoneVerificationCodeSend).toHaveBeenCalledWith(domain, { businessId, attemptId, retry: false, error: "Twilio error 21614." });
      expect(markOperatorPhoneVerificationCodeSent).not.toHaveBeenCalled();
    });

    it("requeues a transient failure until the final attempt", async () => {
      const businessId = randomUUID(); const attemptId = randomUUID(); const domain = { db: undefined as never };
      vi.mocked(issueOperatorPhoneVerificationCode).mockResolvedValue({ to: "+14165550123", from: "+14165550100", code: "482913" });
      const sendSms = vi.fn().mockRejectedValue(new Error("timeout"));
      await expect(handleJob(codeJob(businessId, attemptId), { domain, twilio: { sendSms } }, { isFinalAttempt: false })).rejects.toThrow("timeout");
      expect(releaseOperatorPhoneVerificationCodeSend).toHaveBeenLastCalledWith(domain, { businessId, attemptId, retry: true, error: "Verification delivery failed." });
      await expect(handleJob(codeJob(businessId, attemptId), { domain, twilio: { sendSms } }, { isFinalAttempt: true })).rejects.toThrow("timeout");
      expect(releaseOperatorPhoneVerificationCodeSend).toHaveBeenLastCalledWith(domain, { businessId, attemptId, retry: false, error: "Verification delivery failed." });
    });
  });

  it("reconciles an owned Twilio number and puts it on the SIP trunk", async () => {
    const businessId = randomUUID(); const claimId = randomUUID(); const phoneNumberId = randomUUID(); const domain = { db: undefined as never };
    vi.stubEnv("APP_BASE_URL", "https://app.example.test");
    vi.stubEnv("TWILIO_SIP_TRUNK_SID", "TK123");
    vi.mocked(claimNumberProvisioning).mockResolvedValue({ id: claimId, e164: "+14165550199" });
    vi.mocked(completeNumberProvisioning).mockResolvedValue(phoneNumberId);
    const findOwnedPhoneNumber = vi.fn().mockResolvedValue({ providerPhoneId: "PN123", e164: "+14165550199" }); const purchasePhoneNumber = vi.fn();
    const addNumberToSipTrunk = vi.fn().mockResolvedValue(undefined);
    const result = await handleJob({ jobId: randomUUID(), type: "phoneNumber.provision", queue: "critical", businessId, payload: { claimId }, trace: {}, idempotencyKey: `claim:${claimId}`, scheduled: false }, { domain, twilio: { sendSms: vi.fn(), findOwnedPhoneNumber, purchasePhoneNumber, addNumberToSipTrunk } });
    expect(result).toEqual({ status: "completed", entityId: phoneNumberId });
    expect(purchasePhoneNumber).not.toHaveBeenCalled();
    expect(addNumberToSipTrunk).toHaveBeenCalledWith({ trunkSid: "TK123", providerPhoneId: "PN123" });
    expect(completeNumberProvisioning).toHaveBeenCalledWith(domain, expect.objectContaining({ businessId, claimId, providerPhoneId: "PN123", e164: "+14165550199", voiceUrl: "sip-trunk:TK123" }));
  });

  it("buys a number with SMS webhooks and no voice URL, then adds it to the SIP trunk", async () => {
    const businessId = randomUUID(); const claimId = randomUUID(); const phoneNumberId = randomUUID(); const domain = { db: undefined as never };
    vi.stubEnv("APP_BASE_URL", "https://app.example.test/");
    vi.stubEnv("TWILIO_SIP_TRUNK_SID", "TK123");
    vi.mocked(claimNumberProvisioning).mockResolvedValue({ id: claimId, e164: "+14165550199" });
    vi.mocked(completeNumberProvisioning).mockResolvedValue(phoneNumberId);
    const findOwnedPhoneNumber = vi.fn().mockResolvedValue(null);
    const purchasePhoneNumber = vi.fn().mockResolvedValue({ providerPhoneId: "PN456", e164: "+14165550199" });
    const addNumberToSipTrunk = vi.fn().mockResolvedValue(undefined);

    await handleJob({ jobId: randomUUID(), type: "phoneNumber.provision", queue: "critical", businessId, payload: { claimId }, trace: {}, idempotencyKey: `claim:${claimId}`, scheduled: false }, { domain, twilio: { sendSms: vi.fn(), findOwnedPhoneNumber, purchasePhoneNumber, addNumberToSipTrunk } });

    expect(purchasePhoneNumber).toHaveBeenCalledWith({
      e164: "+14165550199",
      friendlyName: `LobbyStack ${businessId}`,
      smsUrl: "https://app.example.test/api/webhooks/twilio/sms",
      statusCallbackUrl: "https://app.example.test/api/webhooks/twilio/status",
    });
    expect(addNumberToSipTrunk).toHaveBeenCalledWith({ trunkSid: "TK123", providerPhoneId: "PN456" });
  });

  it("releases a purchased number when it can't join the SIP trunk", async () => {
    const businessId = randomUUID(); const claimId = randomUUID(); const domain = { db: undefined as never };
    vi.stubEnv("APP_BASE_URL", "https://app.example.test");
    vi.stubEnv("TWILIO_SIP_TRUNK_SID", "TK123");
    vi.mocked(claimNumberProvisioning).mockResolvedValue({ id: claimId, e164: "+14165550199" });
    const purchasePhoneNumber = vi.fn().mockResolvedValue({ providerPhoneId: "PN789", e164: "+14165550199" });
    const addNumberToSipTrunk = vi.fn().mockRejectedValue(new Error("trunk unavailable"));
    const releasePhoneNumber = vi.fn().mockResolvedValue(undefined);

    await expect(handleJob({ jobId: randomUUID(), type: "phoneNumber.provision", queue: "critical", businessId, payload: { claimId }, trace: {}, idempotencyKey: `claim:${claimId}`, scheduled: false }, { domain, twilio: { sendSms: vi.fn(), findOwnedPhoneNumber: vi.fn().mockResolvedValue(null), purchasePhoneNumber, addNumberToSipTrunk, releasePhoneNumber } })).rejects.toThrow("trunk unavailable");
    expect(releasePhoneNumber).toHaveBeenCalledWith({ providerPhoneId: "PN789" });
    expect(failNumberProvisioning).toHaveBeenCalledWith(domain, expect.objectContaining({ businessId, claimId }));
  });

  it("retries a claim another attempt still holds once its lease ends", async () => {
    const businessId = randomUUID(); const claimId = randomUUID(); const domain = { db: undefined as never }; const retryAt = new Date(Date.now() + 60_000);
    vi.stubEnv("TWILIO_SIP_TRUNK_SID", "TK123");
    vi.mocked(claimNumberProvisioning).mockResolvedValue(null);
    vi.mocked(numberProvisioningLeaseEndsAt).mockResolvedValue(retryAt);
    const purchasePhoneNumber = vi.fn();

    await expect(handleJob({ jobId: randomUUID(), type: "phoneNumber.provision", queue: "critical", businessId, payload: { claimId }, trace: {}, idempotencyKey: `claim:${claimId}`, scheduled: false }, { domain, twilio: { sendSms: vi.fn(), findOwnedPhoneNumber: vi.fn(), purchasePhoneNumber, addNumberToSipTrunk: vi.fn() } })).resolves.toEqual({ status: "deferred", entityId: claimId, retryAt });
    expect(purchasePhoneNumber).not.toHaveBeenCalled();
  });

  it("refuses to provision a number when no SIP trunk is configured, and ends the claim", async () => {
    const businessId = randomUUID(); const claimId = randomUUID(); const domain = { db: undefined as never };
    vi.stubEnv("APP_BASE_URL", "https://app.example.test");
    vi.stubEnv("TWILIO_SIP_TRUNK_SID", "");
    vi.mocked(claimNumberProvisioning).mockClear();
    vi.mocked(failNumberProvisioning).mockClear();
    const purchasePhoneNumber = vi.fn();

    // Failing the job is better than buying a number that cannot answer.
    const failure = handleJob({ jobId: randomUUID(), type: "phoneNumber.provision", queue: "critical", businessId, payload: { claimId }, trace: {}, idempotencyKey: `claim:${claimId}`, scheduled: false }, { domain, twilio: { sendSms: vi.fn(), findOwnedPhoneNumber: vi.fn(), purchasePhoneNumber, addNumberToSipTrunk: vi.fn() } });
    await expect(failure).rejects.toThrow(/TWILIO_SIP_TRUNK_SID/);
    // No retry can fix the setup, and a claim left reserved would refuse the business's next pick.
    await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
    expect(failNumberProvisioning).toHaveBeenCalledWith(domain, { businessId, claimId, unavailable: false, error: "This server isn't set up to buy phone numbers." });
    expect(claimNumberProvisioning).not.toHaveBeenCalled();
    expect(purchasePhoneNumber).not.toHaveBeenCalled();
  });

  it("ends the claim when the worker has no Twilio account", async () => {
    const businessId = randomUUID(); const claimId = randomUUID(); const domain = { db: undefined as never };
    vi.stubEnv("TWILIO_SIP_TRUNK_SID", "TK123");
    vi.mocked(claimNumberProvisioning).mockClear();
    vi.mocked(failNumberProvisioning).mockClear();

    await expect(handleJob({ jobId: randomUUID(), type: "phoneNumber.provision", queue: "critical", businessId, payload: { claimId }, trace: {}, idempotencyKey: `claim:${claimId}`, scheduled: false }, { domain })).rejects.toThrow(/TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN/);
    expect(failNumberProvisioning).toHaveBeenCalledWith(domain, { businessId, claimId, unavailable: false, error: "This server isn't set up to buy phone numbers." });
    expect(claimNumberProvisioning).not.toHaveBeenCalled();
  });

  it("runs all tenant retention work from the hourly privacy job", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(runPrivacyRetentionSweep).mockResolvedValue({ scrubbedFollowUps: 1, scrubbedMessages: 2, scrubbedOperatorDeliveries: 1, deletedTranscripts: 3, deletedAiTraces: 0, queuedRecordings: 1 });
    vi.mocked(deleteSentProductEventsBefore).mockResolvedValueOnce(1_000).mockResolvedValueOnce(7);

    const result = await handleJob({
      jobId: randomUUID(),
      type: "privacy.scrubMessage",
      queue: "maintenance",
      businessId,
      payload: {},
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: true,
      recurring: true,
    }, { domain });

    expect(result).toEqual({ status: "completed", entityId: JSON.stringify({ scrubbedFollowUps: 1, scrubbedMessages: 2, scrubbedOperatorDeliveries: 1, deletedTranscripts: 3, deletedAiTraces: 0, queuedRecordings: 1 }) });
    expect(runPrivacyRetentionSweep).toHaveBeenCalledWith(domain, { businessId });
    expect(deleteSentProductEventsBefore).toHaveBeenCalledWith(domain, {
      businessId,
      before: expect.any(Date),
      limit: 1_000,
    });
    expect(deleteSentProductEventsBefore).toHaveBeenCalledTimes(2);
  });

  it("routes manual recording deletion around the automatic retention switch", async () => {
    const businessId = randomUUID(); const callId = randomUUID(); const objectId = randomUUID();
    const domain = { db: undefined as never }; const storage = { deleteObject: vi.fn() } as never;
    vi.mocked(deleteCallRecording).mockResolvedValue(true);

    const result = await handleJob({ jobId: randomUUID(), type: "privacy.deleteRecording", queue: "maintenance", businessId, payload: { callId, objectId, source: "manual" }, trace: {}, idempotencyKey: `manual:${objectId}`, scheduled: false }, { domain, storage });

    expect(result).toEqual({ status: "completed", entityId: callId });
    expect(deleteCallRecording).toHaveBeenCalledWith(domain, { businessId, callId, objectId }, storage);
    expect(deleteCallRecordingForRetention).not.toHaveBeenCalled();
  });

  it("treats legacy recording deletion jobs as gated retention work", async () => {
    const businessId = randomUUID(); const callId = randomUUID(); const objectId = randomUUID();
    const domain = { db: undefined as never }; const storage = { deleteObject: vi.fn() } as never;
    vi.mocked(deleteCallRecordingForRetention).mockResolvedValue(false);

    const result = await handleJob({ jobId: randomUUID(), type: "privacy.deleteRecording", queue: "maintenance", businessId, payload: { callId, objectId }, trace: {}, idempotencyKey: `retention:${objectId}`, scheduled: false }, { domain, storage });

    expect(result).toEqual({ status: "skipped", entityId: callId });
    expect(deleteCallRecordingForRetention).toHaveBeenCalledWith(domain, { businessId, callId, objectId }, storage);
    expect(deleteCallRecording).not.toHaveBeenCalled();
  });

  it("queues a bounded continuation when expired product events remain", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    const enqueueProductEventRetentionContinuation = vi.fn().mockResolvedValue(undefined);
    const queuedAtMs = Date.parse("2026-09-21T12:00:00.000Z");
    vi.mocked(runPrivacyRetentionSweep).mockResolvedValue({ scrubbedFollowUps: 0, scrubbedMessages: 0, scrubbedOperatorDeliveries: 0, deletedTranscripts: 0, deletedAiTraces: 0, queuedRecordings: 0 });
    vi.mocked(deleteSentProductEventsBefore).mockResolvedValue(1_000);

    await handleJob({
      jobId: randomUUID(),
      type: "privacy.scrubMessage",
      queue: "maintenance",
      businessId,
      payload: {},
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: true,
      recurring: true,
    }, { domain, enqueueProductEventRetentionContinuation }, {
      queueJobId: "repeat:privacy-retention:1726920000000",
      queuedAtMs,
    });

    expect(deleteSentProductEventsBefore).toHaveBeenCalledTimes(10);
    expect(enqueueProductEventRetentionContinuation).toHaveBeenCalledWith({
      businessId,
      before: new Date("2026-09-14T12:00:00.000Z"),
      chainId: expect.stringMatching(/^[a-f0-9]{32}$/),
      sequence: 1,
      availableAt: expect.any(Date),
    });
  });

  it("runs a retention continuation without repeating the full privacy sweep or start event", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    const chainId = "a".repeat(32);
    vi.mocked(deleteSentProductEventsBefore).mockResolvedValue(23);

    const result = await handleJob({
      jobId: randomUUID(),
      type: "privacy.scrubMessage",
      queue: "maintenance",
      businessId,
      payload: {
        productEventRetentionContinuation: true,
        retentionBefore: "2026-09-14T12:00:00.000Z",
        retentionChainId: chainId,
        retentionSequence: 1,
      },
      trace: {},
      idempotencyKey: `product-event-retention:${businessId}:${chainId}:1`,
      scheduled: false,
    }, { domain });

    expect(result).toEqual({ status: "completed", entityId: `${businessId}:23` });
    expect(runPrivacyRetentionSweep).not.toHaveBeenCalled();
    expect(deleteSentProductEventsBefore).toHaveBeenCalledWith(domain, {
      businessId,
      before: new Date("2026-09-14T12:00:00.000Z"),
      limit: 1_000,
    });
    expect(recordProductEvent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "workflow.started" }));
  });

  it("does not recreate usage work when Polar is not configured", async () => {
    const result = await handleJob(billingJob({ usageEventId: randomUUID() }), {
      domain: { db: undefined as never },
    });

    expect(result.status).toBe("skipped");
  });

  it("skips malformed usage jobs without touching the database", async () => {
    const result = await handleJob(billingJob({}), {
      domain: { db: undefined as never },
      polar: { recordUsage: async () => undefined },
    });

    expect(result.status).toBe("skipped");
  });

  it("reconciles a persisted Polar provider event", async () => {
    const businessId = randomUUID();
    const providerEventId = randomUUID();
    vi.mocked(reconcileBillingProviderEvent).mockResolvedValue("processed");

    const result = await handleJob({
      jobId: randomUUID(),
      type: "billing.reconcile",
      queue: "default",
      businessId,
      payload: { providerEventId },
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: false,
    }, { domain: { db: undefined as never } });

    expect(result).toEqual({ status: "completed", entityId: providerEventId });
    expect(reconcileBillingProviderEvent).toHaveBeenCalledWith({ db: undefined as never }, { businessId, providerEventId });
  });

  it("leaves a held Polar event for the sweep to run again", async () => {
    const businessId = randomUUID();
    const providerEventId = randomUUID();
    vi.mocked(reconcileBillingProviderEvent).mockResolvedValue("held");

    const result = await handleJob({ jobId: randomUUID(), type: "billing.reconcile", queue: "default", businessId, payload: { providerEventId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false }, { domain: { db: undefined as never } });

    expect(result).toEqual({ status: "skipped", entityId: providerEventId });
  });

  it("fails checkout requests instead of leaving them pending when Polar is unavailable", async () => {
    const businessId = randomUUID();
    const requestId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
    vi.mocked(markBillingCheckoutFailed).mockResolvedValue(true);

    const result = await handleJob({
      jobId: randomUUID(),
      type: "billing.createCheckout",
      queue: "critical",
      businessId,
      payload: { requestId },
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: false,
    }, { domain });

    expect(result).toEqual({ status: "skipped", entityId: requestId });
    expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, requestId, error: "Billing checkout provider is not configured." });
    expect(loadBillingCheckoutRequest).not.toHaveBeenCalled();
    expect(markBillingCheckoutCreated).not.toHaveBeenCalled();
  });

  it("sends Polar's back arrow to the plan page without marking checkout successful", async () => {
    const businessId = randomUUID();
    const requestId = randomUUID();
    const domain = { db: undefined as never };
    vi.stubEnv("APP_BASE_URL", "https://app.example/");
    vi.stubEnv("POLAR_STARTER_MONTHLY_PRODUCT_ID", "product-starter-monthly");
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
    vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: "starter", billingInterval: "monthly", status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: null, subscription: null });
    vi.mocked(markBillingCheckoutCreated).mockResolvedValue(true as never);
    const createCheckout = vi.fn().mockResolvedValue({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });

    const result = await handleJob({
      jobId: randomUUID(),
      type: "billing.createCheckout",
      queue: "critical",
      businessId,
      payload: { requestId },
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: false,
    }, { domain, polar: { recordUsage: vi.fn(), createCheckout } });

    expect(result).toEqual({ status: "completed", entityId: requestId });
    expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({
      productId: "product-starter-monthly",
      customer: { email: "owner@example.com", externalId: `business:${businessId}` },
      metadata: { lobbystack_business: businessId },
      successUrl: `https://app.example/settings/plan?checkout=success&requestId=${requestId}`,
      returnUrl: "https://app.example/settings/plan",
    }));
    vi.unstubAllEnvs();
  });

  it("waits for a checkout another run holds until that run's claim goes stale, and skips one that is done", async () => {
    const businessId = randomUUID();
    const requestId = randomUUID();
    const retryAt = new Date("2026-10-24T12:05:00Z");
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
    const createCheckout = vi.fn();
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValueOnce({ claimed: false, retryAt }).mockResolvedValueOnce({ claimed: false, retryAt: null });

    expect(await handleJob(job, { domain: { db: undefined as never }, polar: { recordUsage: vi.fn(), createCheckout } })).toEqual({ status: "deferred", entityId: requestId, retryAt });
    expect(await handleJob(job, { domain: { db: undefined as never }, polar: { recordUsage: vi.fn(), createCheckout } })).toEqual({ status: "skipped", entityId: requestId });
    expect(loadBillingCheckoutRequest).not.toHaveBeenCalled();
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("reports a checkout that waited too long for its job, which failed it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const businessId = randomUUID();
    const requestId = randomUUID();
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValueOnce({ claimed: false, retryAt: null, expired: true });

    expect(await handleJob(job, { domain: { db: undefined as never }, polar: { recordUsage: vi.fn(), createCheckout: vi.fn() } })).toEqual({ status: "skipped", entityId: requestId });
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/\] exception: Billing work waited longer than it should\.$/), operation: "job.billing.createCheckout", businessId, requestId, alertable: true }));
    expect(loadBillingCheckoutRequest).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("hands a checkout back while Polar fails and the job will try again, and fails it on the last try", async () => {
    const businessId = randomUUID();
    const requestId = randomUUID();
    const domain = { db: undefined as never };
    vi.stubEnv("POLAR_STARTER_MONTHLY_PRODUCT_ID", "product-starter-monthly");
    vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
    vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: "starter", billingInterval: "monthly", status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: null, subscription: null });
    const error = new PolarRequestError(503, null);
    const createCheckout = vi.fn().mockRejectedValue(error);
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };

    await expect(handleJob(job, { domain, polar: { recordUsage: vi.fn(), createCheckout } }, { isFinalAttempt: false })).rejects.toBe(error);
    expect(releaseBillingCheckoutRequest).toHaveBeenCalledWith(domain, { businessId, requestId });
    expect(markBillingCheckoutFailed).not.toHaveBeenCalled();

    await expect(handleJob(job, { domain, polar: { recordUsage: vi.fn(), createCheckout } }, { isFinalAttempt: true })).rejects.toBe(error);
    expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, requestId, error: "Polar checkout creation failed." });
    expect(releaseBillingCheckoutRequest).toHaveBeenCalledTimes(1);
  });

  describe("a checkout's Polar customer", () => {
    function checkout(input: { billingEmail?: string; isFinalAttempt?: boolean; polar: Partial<NonNullable<WorkerDependencies["polar"]>> }) {
      const businessId = randomUUID();
      const requestId = randomUUID();
      const domain = { db: undefined as never };
      vi.stubEnv("POLAR_STARTER_MONTHLY_PRODUCT_ID", "product-starter-monthly");
      vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
      vi.mocked(markBillingCheckoutFailed).mockResolvedValue(true);
      vi.mocked(markBillingCheckoutCreated).mockResolvedValue(true as never);
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: "starter", billingInterval: "monthly", status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: input.billingEmail ?? null, businessName: "Allo Salon", onboardingStage: "complete", planCode: null, subscription: null });
      const createCheckout = vi.fn().mockResolvedValue({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });
      const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
      const run = handleJob(job, { domain, polar: { recordUsage: vi.fn(), createCheckout, findCustomerByExternalId: vi.fn().mockResolvedValue(null), createCustomer: vi.fn(), ...input.polar } }, { isFinalAttempt: input.isFinalAttempt ?? true });
      return { businessId, requestId, domain, createCheckout, run };
    }

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("makes the checkout out to the business's own customer, found by its billing key", async () => {
      const findCustomerByExternalId = vi.fn().mockResolvedValue({ id: "customer-1", externalId: "business:1" });
      const createCustomer = vi.fn();
      const { businessId, requestId, createCheckout, run } = checkout({ polar: { findCustomerByExternalId, createCustomer } });

      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(findCustomerByExternalId).toHaveBeenCalledWith(`business:${businessId}`);
      expect(createCustomer).not.toHaveBeenCalled();
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: { id: "customer-1" }, metadata: { lobbystack_business: businessId } }));
    });

    it("makes the business its customer with the billing email it was given, else the person's own", async () => {
      const createCustomer = vi.fn().mockResolvedValue({ id: "customer-2", externalId: null });
      const given = checkout({ billingEmail: "billing@example.com", polar: { createCustomer } });
      await expect(given.run).resolves.toEqual({ status: "completed", entityId: given.requestId });
      expect(createCustomer).toHaveBeenCalledWith({ externalId: `business:${given.businessId}`, email: "billing@example.com", name: "Allo Salon" });
      expect(given.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: { id: "customer-2" } }));

      const own = checkout({ polar: { createCustomer } });
      await expect(own.run).resolves.toEqual({ status: "completed", entityId: own.requestId });
      expect(createCustomer).toHaveBeenLastCalledWith({ externalId: `business:${own.businessId}`, email: "owner@example.com", name: "Allo Salon" });
    });

    it("uses the customer another run made first", async () => {
      const findCustomerByExternalId = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "customer-3", externalId: "business:1" });
      const createCustomer = vi.fn().mockRejectedValue(new PolarRequestError(422, "PolarRequestValidationError", ["email", "external_id"]));
      const { requestId, createCheckout, run } = checkout({ polar: { findCustomerByExternalId, createCustomer } });

      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(findCustomerByExternalId).toHaveBeenCalledTimes(2);
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: { id: "customer-3" } }));
    });

    it("fails a checkout whose email Polar has for another business's customer, or doesn't take, so the person gives another", async () => {
      const taken = checkout({ polar: { createCustomer: vi.fn().mockRejectedValue(new PolarRequestError(422, "PolarRequestValidationError", ["email"])) } });
      await expect(taken.run).resolves.toEqual({ status: "skipped", entityId: taken.requestId });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(taken.domain, { businessId: taken.businessId, requestId: taken.requestId, error: planChangeRefusals.billing_email_taken });
      expect(taken.createCheckout).not.toHaveBeenCalled();

      const invalid = checkout({ billingEmail: "billing@example.invalid", polar: { createCustomer: vi.fn().mockRejectedValue(new PolarRequestError(422, "RequestValidationError", ["email"])) } });
      await expect(invalid.run).resolves.toEqual({ status: "skipped", entityId: invalid.requestId });
      expect(markBillingCheckoutFailed).toHaveBeenLastCalledWith(invalid.domain, { businessId: invalid.businessId, requestId: invalid.requestId, error: planChangeRefusals.billing_email_invalid });
      expect(planChangeRefusalOf(planChangeRefusals.billing_email_taken)).toBe("billing_email_taken");
      expect(releaseBillingCheckoutRequest).not.toHaveBeenCalled();
    });

    it("leaves the customer to Polar's email match, and warns, when the worker's token can't read or make customers", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { businessId, requestId, createCheckout, run } = checkout({ polar: { findCustomerByExternalId: vi.fn().mockRejectedValue(new PolarRequestError(403, "insufficient_scope")) } });

      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: { email: "owner@example.com", externalId: `business:${businessId}` }, metadata: { lobbystack_business: businessId } }));
      const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(lines).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringMatching(/customers:write scope\.$/), operation: "job.billing.createCheckout", businessId, requestId }));
      warn.mockRestore();
    });

    it("tries again when Polar can't be reached, as any checkout does", async () => {
      const error = new PolarRequestError(503, null);
      const { businessId, requestId, domain, createCheckout, run } = checkout({ isFinalAttempt: false, polar: { findCustomerByExternalId: vi.fn().mockRejectedValue(error) } });

      await expect(run).rejects.toBe(error);
      expect(createCheckout).not.toHaveBeenCalled();
      expect(releaseBillingCheckoutRequest).toHaveBeenCalledWith(domain, { businessId, requestId });
      expect(markBillingCheckoutFailed).not.toHaveBeenCalled();
    });
  });

  describe("the billing sweep", () => {
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.sweep", queue: "maintenance", businessId: null, payload: {}, trace: {}, idempotencyKey: "billing-sweep", scheduled: true };
    const counts = (values: Partial<Record<"provider_event" | "usage_event" | "checkout_request", number>> = {}) => ({ provider_event: 0, usage_event: 0, checkout_request: 0, ...values });
    const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

    it("does nothing out loud when no billing work waits", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.mocked(sweepBillingWork).mockResolvedValue({ queued: counts(), overdue: counts(), failed: 0 });

      expect(await handleJob(job, { domain: { db: undefined as never } })).toEqual({ status: "skipped", entityId: "0:0" });
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      info.mockRestore();
      error.mockRestore();
    });

    it("logs work it queued again, and reports to PostHog only work that waited longer than it should", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.mocked(sweepBillingWork).mockResolvedValueOnce({ queued: counts({ checkout_request: 1 }), overdue: counts(), failed: 0 });

      expect(await handleJob(job, { domain: { db: undefined as never } })).toEqual({ status: "completed", entityId: "1:0" });
      expect(lines(info)).toEqual([expect.objectContaining({ level: "info", message: "ops.billing.sweep", checkoutsQueued: 1, eventsOverdue: 0 })]);
      expect(error).not.toHaveBeenCalled();

      vi.mocked(sweepBillingWork).mockResolvedValueOnce({ queued: counts({ provider_event: 2, usage_event: 1 }), overdue: counts({ provider_event: 1, checkout_request: 1 }), failed: 0 });
      expect(await handleJob(job, { domain: { db: undefined as never } })).toEqual({ status: "completed", entityId: "3:1" });
      expect(lines(warn)).toContainEqual(expect.objectContaining({ message: "ops.billing.sweep", eventsQueued: 2, usageQueued: 1, eventsOverdue: 1, checkoutsExpired: 1 }));
      // A worker without Polar's settings sends no usage and fails no job, so the report says so.
      expect(lines(error)).toContainEqual(expect.objectContaining({ level: "error", message: expect.stringMatching(/\] exception: Billing work waited longer than it should\.$/), operation: "job.billing.sweep", polarConfigured: false, eventsOverdue: 1, checkoutsExpired: 1, alertable: true }));
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    });

    it("fails the job with the first error once the rest is queued, so the next try picks up what it couldn't", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const failure = new Error("connection terminated");
      vi.mocked(sweepBillingWork).mockResolvedValue({ queued: counts({ usage_event: 3 }), overdue: counts(), failed: 1, error: failure });

      await expect(handleJob(job, { domain: { db: undefined as never } })).rejects.toBe(failure);
      expect(lines(warn)).toEqual([expect.objectContaining({ message: "ops.billing.sweep", usageQueued: 3, failed: 1 })]);
      warn.mockRestore();
    });
  });

  describe("a business that already pays", () => {
    const productEnv = { POLAR_STARTER_MONTHLY_PRODUCT_ID: "product-starter-monthly", POLAR_STARTER_ANNUAL_PRODUCT_ID: "product-starter-annual", POLAR_PRO_MONTHLY_PRODUCT_ID: "product-pro-monthly", POLAR_PRO_ANNUAL_PRODUCT_ID: "product-pro-annual" };
    const liveSubscription = (productId: string, extra: Partial<PolarSubscription> = {}): PolarSubscription => ({ id: "sub-1", status: "active", productId, cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null, discountId: null, currentPeriodEnd: null, ...extra });

    function changePlan(input: { target: "starter" | "pro"; billingInterval: "monthly" | "annual"; plan: "starter" | "pro"; planCode?: string; subscriptionPlanCode?: string; polar: Partial<NonNullable<WorkerDependencies["polar"]>>; isFinalAttempt?: boolean }) {
      const businessId = randomUUID();
      const requestId = randomUUID();
      const domain = { db: undefined as never };
      for (const [key, value] of Object.entries(productEnv)) vi.stubEnv(key, value);
      vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
      vi.mocked(markBillingCheckoutFailed).mockResolvedValue(true);
      vi.mocked(markBillingPlanChanged).mockResolvedValue(true);
      vi.mocked(loadPlanChangeProration).mockResolvedValue({ upgrade: "invoice", downgrade: "next_period" });
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: input.target, billingInterval: input.billingInterval, status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: input.planCode ?? null, subscription: { id: "sub-1", plan: input.plan, billingInterval: "monthly", planCode: input.subscriptionPlanCode ?? null } });
      const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
      const run = handleJob(job, { domain, polar: { recordUsage: vi.fn(), createCheckout: vi.fn(), ...input.polar } }, input.isFinalAttempt === undefined ? {} : { isFinalAttempt: input.isFinalAttempt });
      return { businessId, requestId, domain, run };
    }

    it("moves Starter to Pro on the same subscription, invoiced now, instead of a second checkout", async () => {
      const createCheckout = vi.fn();
      const getSubscription = vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly"));
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("product-pro-annual"));
      const { businessId, requestId, domain, run } = await changePlan({ target: "pro", billingInterval: "annual", plan: "starter", polar: { createCheckout, getSubscription, changeSubscriptionProduct } });

      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(getSubscription).toHaveBeenCalledWith("sub-1");
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "product-pro-annual", prorationBehavior: "invoice" });
      expect(markBillingPlanChanged).toHaveBeenCalledWith(domain, { businessId, requestId });
      expect(createCheckout).not.toHaveBeenCalled();
    });

    it("moves Pro to Starter from the next period, going by Polar's product rather than the stored plan", async () => {
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly", { pendingProductId: "product-starter-monthly" }));
      const { run } = await changePlan({ target: "starter", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly")), changeSubscriptionProduct } });

      await expect(run).resolves.toMatchObject({ status: "completed" });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith(expect.objectContaining({ productId: "product-starter-monthly", prorationBehavior: "next_period" }));
    });

    it("marks a change Polar already made without making it twice", async () => {
      const changeSubscriptionProduct = vi.fn();
      const { run } = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly")), changeSubscriptionProduct } });

      await expect(run).resolves.toMatchObject({ status: "completed" });
      expect(changeSubscriptionProduct).not.toHaveBeenCalled();
      expect(markBillingPlanChanged).toHaveBeenCalled();
    });

    it("tells the business why when Polar can't charge the change, without retrying", async () => {
      const changeSubscriptionProduct = vi.fn().mockRejectedValue(new PolarRequestError(402, "PaymentFailed"));
      const { businessId, requestId, domain, run } = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly")), changeSubscriptionProduct } });

      await expect(run).resolves.toEqual({ status: "skipped", entityId: requestId });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, requestId, error: planChangeRefusals.payment_failed });
      expect(markBillingPlanChanged).not.toHaveBeenCalled();
    });

    it("refuses a subscription set to end, and names a token without write access as the operator's to fix", async () => {
      const ending = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly", { cancelAtPeriodEnd: true })), changeSubscriptionProduct: vi.fn() } });
      await expect(ending.run).resolves.toMatchObject({ status: "skipped" });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(ending.domain, { businessId: ending.businessId, requestId: ending.requestId, error: planChangeRefusals.subscription_ending });

      const scope = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockRejectedValue(new PolarRequestError(403, "insufficient_scope")), changeSubscriptionProduct: vi.fn() } });
      await expect(scope.run).resolves.toMatchObject({ status: "skipped" });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(scope.domain, { businessId: scope.businessId, requestId: scope.requestId, error: planChangeRefusals.token_scope });
    });

    it("retries when Polar fails for another reason, and the page keeps waiting until the last try fails", async () => {
      const error = new PolarRequestError(503, null);
      const polar = () => ({ getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly")), changeSubscriptionProduct: vi.fn().mockRejectedValue(error) });
      const retrying = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: polar(), isFinalAttempt: false });

      await expect(retrying.run).rejects.toBe(error);
      expect(releaseBillingCheckoutRequest).toHaveBeenCalledWith(retrying.domain, { businessId: retrying.businessId, requestId: retrying.requestId });
      expect(markBillingCheckoutFailed).not.toHaveBeenCalled();

      const last = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: polar(), isFinalAttempt: true });
      await expect(last.run).rejects.toBe(error);
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(last.domain, { businessId: last.businessId, requestId: last.requestId, error: "Polar plan change failed." });
      expect(releaseBillingCheckoutRequest).toHaveBeenCalledTimes(1);
    });

    it("waits while another change holds the subscription, handing the request back, and hands the subscription back after", async () => {
      const retryAt = new Date(Date.now() + 15_000);
      vi.mocked(claimBillingSubscription).mockResolvedValueOnce({ retryAt });
      const getSubscription = vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly"));
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly"));
      const held = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription, changeSubscriptionProduct } });
      await expect(held.run).resolves.toEqual({ status: "deferred", entityId: held.requestId, retryAt });
      expect(getSubscription).not.toHaveBeenCalled();
      expect(releaseBillingCheckoutRequest).toHaveBeenCalledWith(held.domain, { businessId: held.businessId, requestId: held.requestId });
      expect(releaseBillingSubscription).not.toHaveBeenCalled();

      const free = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription, changeSubscriptionProduct } });
      await expect(free.run).resolves.toMatchObject({ status: "completed" });
      expect(claimBillingSubscription).toHaveBeenLastCalledWith(free.domain, { businessId: free.businessId });
      expect(releaseBillingSubscription).toHaveBeenCalledWith(free.domain, { businessId: free.businessId, claimId: "subscription-claim" });

      // A failed try hands it back too, and a failed hand-back leaves the claim to run out.
      vi.mocked(releaseBillingSubscription).mockRejectedValueOnce(new Error("connection terminated"));
      const error = new PolarRequestError(503, null);
      const failing = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription, changeSubscriptionProduct: vi.fn().mockRejectedValue(error) }, isFinalAttempt: false });
      await expect(failing.run).rejects.toBe(error);
      expect(releaseBillingSubscription).toHaveBeenLastCalledWith(failing.domain, { businessId: failing.businessId, claimId: "subscription-claim" });
    });

    it("opens a checkout when Polar's subscription has already ended", async () => {
      vi.mocked(markBillingCheckoutCreated).mockResolvedValue(true as never);
      const createCheckout = vi.fn().mockResolvedValue({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });
      const changeSubscriptionProduct = vi.fn();
      const { run } = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { createCheckout, getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-starter-monthly", { status: "canceled", endedAt: "2026-10-01T00:00:00Z" })), changeSubscriptionProduct } });

      await expect(run).resolves.toMatchObject({ status: "completed" });
      expect(changeSubscriptionProduct).not.toHaveBeenCalled();
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ productId: "product-pro-monthly" }));
    });

    it("sells through the catalog's linked products once a link made the plan active, and reads Polar's product through them", async () => {
      const linked = (code: "starter" | "pro") => ({ code, status: "active" as const, sold: true, custom: false, overage: true, voice_sec: null, sms_seg: null, calls_out: null, chat_units: null, kb_bytes: null, numbers: null, voice_rate: null, sms_rate: null, call_rate: null, sort: 0 });
      const price = (plan: "starter" | "pro", period: "monthly" | "annual", polarId: string, retired = false) => ({ plan, tier: plan, status: "active", period, currency: "cad", cents: 1, per_month: 1, polar_id: polarId, retired });
      const catalog = { plans: [linked("starter"), linked("pro")], prices: [price("starter", "monthly", "catalog-starter-monthly"), price("starter", "annual", "catalog-starter-annual"), price("pro", "annual", "catalog-pro-annual"), price("pro", "annual", "old-pro-annual", true)] };
      const links = async () => polarProductLinks(catalog, process.env);
      vi.mocked(readPolarProductLinks).mockImplementationOnce(links).mockImplementationOnce(links);
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("old-pro-annual", { pendingProductId: "catalog-starter-annual" }));
      // Polar's product is a retired Pro annual price, so the move to Starter annual waits for the
      // next period, though the account still says Starter monthly.
      const { run } = await changePlan({ target: "starter", billingInterval: "annual", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("old-pro-annual")), changeSubscriptionProduct } });

      await expect(run).resolves.toMatchObject({ status: "completed" });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "catalog-starter-annual", prorationBehavior: "next_period" });

      // Pro monthly has no linked product, so its variable no longer sells it.
      const unlinked = await changePlan({ target: "pro", billingInterval: "monthly", plan: "starter", polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("catalog-starter-monthly")), changeSubscriptionProduct: vi.fn() } });
      await expect(unlinked.run).rejects.toThrow("No Polar product sells pro monthly");
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(unlinked.domain, { businessId: unlinked.businessId, requestId: unlinked.requestId, error: "Polar plan change failed." });
    });
  });

  describe("a promo plan", () => {
    const promoPrice = { plan: "salons-half-off", tier: "starter", status: "active", period: "monthly" as const, currency: "cad", cents: 3000, per_month: 3000, polar_id: "promo-starter-monthly", retired: false };
    const catalog = (status: "draft" | "active") => ({ plans: [], prices: [promoPrice], others: [{ code: "salons-half-off", tier: "starter", status, polar_disc: "disc-half-off" }] });
    const metadata = (businessId: string, requestId: string) => ({ lobbystack_business: businessId, lobbystack_plan: "salons-half-off", lobbystack_checkout: requestId });

    function promoCheckout(input: { status?: "draft" | "active"; subscription?: { plan: "starter" | "pro"; planCode: string | null } | null; planCode?: string | null; polar: Partial<NonNullable<WorkerDependencies["polar"]>> }) {
      const businessId = randomUUID();
      const requestId = randomUUID();
      const domain = { db: undefined as never };
      vi.stubEnv("APP_BASE_URL", "https://app.example");
      vi.mocked(claimBillingCheckoutRequest).mockResolvedValue({ claimed: true });
      vi.mocked(markBillingCheckoutFailed).mockResolvedValue(true);
      vi.mocked(markBillingCheckoutCreated).mockResolvedValue(true as never);
      vi.mocked(markBillingPlanChanged).mockResolvedValue(true);
      vi.mocked(loadPlanChangeProration).mockResolvedValue({ upgrade: "invoice", downgrade: "next_period" });
      const links = async () => polarProductLinks(catalog(input.status ?? "active"), process.env);
      vi.mocked(readPolarProductLinks).mockImplementation(links);
      const subscription = input.subscription ? { id: "sub-1", billingInterval: "monthly" as const, ...input.subscription } : null;
      vi.mocked(loadBillingCheckoutRequest).mockResolvedValue({ id: requestId, businessId, target: "starter", billingInterval: "monthly", status: "processing", checkoutId: null, checkoutUrl: null, error: null, customerEmail: "owner@example.com", externalCustomerId: `business:${businessId}`, billingEmail: null, businessName: "Allo Salon", onboardingStage: "complete", planCode: input.planCode === undefined ? "salons-half-off" : input.planCode, subscription });
      const job: JobEnvelope = { jobId: randomUUID(), type: "billing.createCheckout", queue: "critical", businessId, payload: { requestId }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
      const run = handleJob(job, { domain, polar: { recordUsage: vi.fn(), createCheckout: vi.fn(), ...input.polar } });
      return { businessId, requestId, domain, run };
    }

    afterEach(() => {
      vi.mocked(readPolarProductLinks).mockImplementation(async () => polarProductLinks({ plans: [], prices: [] }, process.env));
      vi.unstubAllEnvs();
    });

    it("sells its own product with its discount and the checkout's metadata, and never lets a typed code stack on it", async () => {
      const createCheckout = vi.fn().mockResolvedValue({ checkoutId: "checkout-1", checkoutUrl: "https://polar.example/checkout-1" });
      const { businessId, requestId, run } = promoCheckout({ polar: { createCheckout } });
      await expect(run).resolves.toEqual({ status: "completed", entityId: requestId });
      expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ productId: "promo-starter-monthly", discountId: "disc-half-off", metadata: metadata(businessId, requestId) }));
    });

    it("fails the request when the plan isn't on sale, without asking Polar", async () => {
      const createCheckout = vi.fn();
      const { businessId, requestId, domain, run } = promoCheckout({ status: "draft", polar: { createCheckout } });
      await expect(run).resolves.toEqual({ status: "skipped", entityId: requestId });
      expect(markBillingCheckoutFailed).toHaveBeenCalledWith(domain, { businessId, requestId, error: "This promo plan isn't on sale right now." });
      expect(createCheckout).not.toHaveBeenCalled();
    });

    it("moves a paying business's subscription onto it with its discount, and drops the discount when it leaves for a standard plan", async () => {
      const liveSubscription = (productId: string): PolarSubscription => ({ id: "sub-1", status: "active", productId, cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null, discountId: null, currentPeriodEnd: null });
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(liveSubscription("promo-starter-monthly"));
      const onto = promoCheckout({ subscription: { plan: "pro", planCode: null }, polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("product-pro-monthly")), changeSubscriptionProduct } });
      await expect(onto.run).resolves.toEqual({ status: "completed", entityId: onto.requestId });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "promo-starter-monthly", prorationBehavior: expect.any(String), discountId: "disc-half-off", metadata: metadata(onto.businessId, onto.requestId) });

      vi.stubEnv("POLAR_STARTER_MONTHLY_PRODUCT_ID", "product-starter-monthly");
      changeSubscriptionProduct.mockClear();
      const off = promoCheckout({ planCode: null, subscription: { plan: "starter", planCode: "salons-half-off" }, polar: { getSubscription: vi.fn().mockResolvedValue(liveSubscription("promo-starter-monthly")), changeSubscriptionProduct } });
      await expect(off.run).resolves.toEqual({ status: "completed", entityId: off.requestId });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "product-starter-monthly", prorationBehavior: expect.any(String), discountId: null });
    });
  });

  describe("a promo plan's end", () => {
    const productEnv = { POLAR_STARTER_MONTHLY_PRODUCT_ID: "product-starter-monthly", POLAR_PRO_MONTHLY_PRODUCT_ID: "product-pro-monthly" };
    const promoPrice = { plan: "salons-half-off", tier: "starter", status: "active", period: "monthly" as const, currency: "cad", cents: 3000, per_month: 3000, polar_id: "promo-starter-monthly", retired: false };
    const otherPromoPrice = { ...promoPrice, plan: "pro-launch", tier: "pro", polar_id: "promo-pro-monthly" };
    const planEnds = new Date(Date.now() + 5 * 86_400_000);
    const periodEnd = new Date(Date.now() + 6 * 86_400_000).toISOString();
    const subscription = (extra: Partial<PolarSubscription> = {}): PolarSubscription => ({ id: "sub-1", status: "active", productId: "promo-starter-monthly", cancelAtPeriodEnd: false, endedAt: null, pendingProductId: null, discountId: "disc-half-off", currentPeriodEnd: periodEnd, ...extra });
    const work = (extra: Partial<PromoEndWork> = {}): PromoEndWork => ({ planCode: "salons-half-off", planEnds, tier: "starter", interval: "monthly", subscriptionId: "sub-1", ending: "tier", endsAt: planEnds, set: true, notify: true, overdue: false, ...extra });

    function endPromo(input: { work: PromoEndWork | null; polar: Partial<NonNullable<WorkerDependencies["polar"]>>; payload?: Record<string, unknown> }) {
      const businessId = randomUUID();
      const domain = { db: undefined as never };
      for (const [key, value] of Object.entries(productEnv)) vi.stubEnv(key, value);
      vi.stubEnv("APP_BASE_URL", "https://app.example");
      vi.mocked(readPolarProductLinks).mockImplementation(async () => polarProductLinks({ plans: [], prices: [promoPrice, otherPromoPrice], others: [{ code: "salons-half-off", tier: "starter", status: "active", polar_disc: "disc-half-off" }, { code: "pro-launch", tier: "pro", status: "active", polar_disc: "disc-launch" }] } as never, process.env));
      vi.mocked(loadPromoEndWork).mockResolvedValue(input.work);
      vi.mocked(recordPromoEnd).mockResolvedValue(1);
      const job: JobEnvelope = { jobId: randomUUID(), type: "billing.endPromoPlan", queue: "default", businessId, payload: input.payload ?? {}, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: true };
      const run = handleJob(job, { domain, polar: { recordUsage: vi.fn(), getSubscription: vi.fn(), changeSubscriptionProduct: vi.fn(), cancelSubscriptionAtPeriodEnd: vi.fn(), removeSubscriptionDiscount: vi.fn(), ...input.polar } });
      return { businessId, domain, run };
    }

    afterEach(() => {
      vi.mocked(readPolarProductLinks).mockImplementation(async () => polarProductLinks({ plans: [], prices: [] }, process.env));
    });

    it("moves the subscription to its tier's standard product from the next period, without the discount, then emails the owners", async () => {
      const changeSubscriptionProduct = vi.fn().mockResolvedValue(subscription());
      const { businessId, domain, run } = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription()), changeSubscriptionProduct } });
      await expect(run).resolves.toEqual({ status: "completed", entityId: `${businessId}:salons-half-off:1` });
      expect(changeSubscriptionProduct).toHaveBeenCalledWith({ subscriptionId: "sub-1", productId: "product-starter-monthly", prorationBehavior: "next_period", discountId: null });
      // The email names Polar's renewal date.
      expect(recordPromoEnd).toHaveBeenCalledWith(domain, { businessId, planCode: "salons-half-off", planEnds, set: true, notice: { ending: "tier", endsAt: new Date(periodEnd), tier: "starter", interval: "monthly", quiet: false }, appUrl: "https://app.example" });
    });

    it("cancels at the period's end for a plan that ends that way, and leaves a cancellation or a plan change the business chose", async () => {
      const cancelSubscriptionAtPeriodEnd = vi.fn().mockResolvedValue(subscription({ cancelAtPeriodEnd: true }));
      const cancel = endPromo({ work: work({ ending: "cancel" }), polar: { getSubscription: vi.fn().mockResolvedValue(subscription()), cancelSubscriptionAtPeriodEnd } });
      await expect(cancel.run).resolves.toMatchObject({ status: "completed" });
      expect(cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith("sub-1");

      const changeSubscriptionProduct = vi.fn();
      const canceling = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ cancelAtPeriodEnd: true })), changeSubscriptionProduct } });
      await expect(canceling.run).resolves.toMatchObject({ status: "completed" });
      expect(recordPromoEnd).toHaveBeenLastCalledWith(canceling.domain, expect.objectContaining({ notice: expect.objectContaining({ ending: "cancel" }) }));

      const chosen = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ pendingProductId: "product-pro-monthly" })), changeSubscriptionProduct } });
      await expect(chosen.run).resolves.toMatchObject({ status: "completed" });
      expect(recordPromoEnd).toHaveBeenLastCalledWith(chosen.domain, expect.objectContaining({ notice: { ending: "tier", endsAt: new Date(periodEnd), tier: "pro", interval: "monthly", quiet: false } }));
      // Another promo plan the business chose for the renewal stands too, and its owners saw its terms when they chose it.
      const promo = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ pendingProductId: "promo-pro-monthly" })), changeSubscriptionProduct } });
      await expect(promo.run).resolves.toMatchObject({ status: "completed" });
      expect(recordPromoEnd).toHaveBeenLastCalledWith(promo.domain, expect.objectContaining({ set: true, notice: { ending: "tier", endsAt: new Date(periodEnd), tier: "pro", interval: "monthly", quiet: true } }));
      expect(changeSubscriptionProduct).not.toHaveBeenCalled();
    });

    it("emails only once Polar is told, and leaves a refusal or an ended subscription for the next day's check", async () => {
      const refused = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription()), changeSubscriptionProduct: vi.fn().mockRejectedValue(new PolarRequestError(403, "insufficient_scope")) } });
      await expect(refused.run).resolves.toEqual({ status: "skipped", entityId: refused.businessId });
      const ended = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ status: "canceled", endedAt: "2026-10-01T00:00:00Z" })) } });
      await expect(ended.run).resolves.toEqual({ status: "skipped", entityId: ended.businessId });
      expect(recordPromoEnd).not.toHaveBeenCalled();
      // Polar fails some other way: the job's retries take it.
      await expect(endPromo({ work: work(), polar: { getSubscription: vi.fn().mockRejectedValue(new PolarRequestError(500, null)) } }).run).rejects.toThrow("status 500");

      const getSubscription = vi.fn();
      const told = endPromo({ work: work({ set: false }), polar: { getSubscription } });
      await expect(told.run).resolves.toMatchObject({ status: "completed" });
      expect(getSubscription).not.toHaveBeenCalled();
      expect(recordPromoEnd).toHaveBeenCalledWith(told.domain, expect.objectContaining({ set: false, notice: { ending: "tier", endsAt: planEnds, tier: "starter", interval: "monthly", quiet: false } }));
      vi.mocked(recordPromoEnd).mockClear();
      // The rest of the last week: Polar was told and the owners heard.
      const done = endPromo({ work: work({ set: false, notify: false }), polar: { getSubscription } });
      await expect(done.run).resolves.toEqual({ status: "completed", entityId: `${done.businessId}:salons-half-off:0` });
      expect(recordPromoEnd).not.toHaveBeenCalled();
      expect(getSubscription).not.toHaveBeenCalled();
      await expect(endPromo({ work: null, polar: {} }).run).resolves.toMatchObject({ status: "skipped" });
    });

    it("leaves a subscription that left the promo plan, as after an upgrade the account hasn't heard of yet", async () => {
      const changeSubscriptionProduct = vi.fn();
      const cancelSubscriptionAtPeriodEnd = vi.fn();
      const upgraded = endPromo({ work: work(), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId: "product-pro-monthly", discountId: null })), changeSubscriptionProduct, cancelSubscriptionAtPeriodEnd } });
      await expect(upgraded.run).resolves.toEqual({ status: "skipped", entityId: upgraded.businessId });
      // Another promo plan's product, and one the catalog doesn't know.
      for (const productId of ["promo-pro-monthly", "made-in-polar"]) {
        await expect(endPromo({ work: work({ ending: "cancel" }), polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId })), changeSubscriptionProduct, cancelSubscriptionAtPeriodEnd } }).run).resolves.toMatchObject({ status: "skipped" });
      }
      expect(changeSubscriptionProduct).not.toHaveBeenCalled();
      expect(cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
      expect(recordPromoEnd).not.toHaveBeenCalled();
    });

    it("waits while another change holds the subscription, and hands it back after", async () => {
      const retryAt = new Date(Date.now() + 15_000);
      const getSubscription = vi.fn().mockResolvedValue(subscription());
      vi.mocked(claimBillingSubscription).mockResolvedValueOnce({ retryAt });
      const held = endPromo({ work: work(), polar: { getSubscription } });
      await expect(held.run).resolves.toEqual({ status: "deferred", entityId: held.businessId, retryAt });
      vi.mocked(claimBillingSubscription).mockResolvedValueOnce({ retryAt });
      const heldDrop = endPromo({ work: null, payload: { dropDiscount: "disc-half-off", subscriptionId: "sub-1" }, polar: { getSubscription } });
      await expect(heldDrop.run).resolves.toEqual({ status: "deferred", entityId: heldDrop.businessId, retryAt });
      expect(getSubscription).not.toHaveBeenCalled();
      expect(recordPromoEnd).not.toHaveBeenCalled();

      const ending = endPromo({ work: work(), polar: { getSubscription, changeSubscriptionProduct: vi.fn().mockResolvedValue(subscription()) } });
      await expect(ending.run).resolves.toMatchObject({ status: "completed" });
      expect(releaseBillingSubscription).toHaveBeenLastCalledWith(ending.domain, { businessId: ending.businessId, claimId: "subscription-claim" });
      const failing = endPromo({ work: null, payload: { dropDiscount: "disc-half-off", subscriptionId: "sub-1" }, polar: { getSubscription: vi.fn().mockRejectedValue(new PolarRequestError(500, null)) } });
      await expect(failing.run).rejects.toThrow("status 500");
      expect(releaseBillingSubscription).toHaveBeenLastCalledWith(failing.domain, { businessId: failing.businessId, claimId: "subscription-claim" });

      // An email with nothing to tell Polar claims nothing.
      vi.mocked(claimBillingSubscription).mockClear();
      await expect(endPromo({ work: work({ set: false }), polar: { getSubscription } }).run).resolves.toMatchObject({ status: "completed" });
      expect(claimBillingSubscription).not.toHaveBeenCalled();
    });

    it("removes a promo plan's discount from a standard product, and nowhere else", async () => {
      const removeSubscriptionDiscount = vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly" }));
      const payload = { dropDiscount: "disc-half-off", subscriptionId: "sub-1" };
      const standard = endPromo({ work: null, payload, polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly" })), removeSubscriptionDiscount } });
      await expect(standard.run).resolves.toEqual({ status: "completed", entityId: `${standard.businessId}:disc-half-off` });
      expect(removeSubscriptionDiscount).toHaveBeenCalledWith("sub-1");
      removeSubscriptionDiscount.mockClear();
      await expect(endPromo({ work: null, payload, polar: { getSubscription: vi.fn().mockResolvedValue(subscription()), removeSubscriptionDiscount } }).run).resolves.toMatchObject({ status: "skipped" });
      await expect(endPromo({ work: null, payload, polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly", discountId: null })), removeSubscriptionDiscount } }).run).resolves.toMatchObject({ status: "skipped" });
      // A standard product waiting to move to a promo plan keeps the discount that plan's change brought.
      await expect(endPromo({ work: null, payload, polar: { getSubscription: vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly", pendingProductId: "promo-starter-monthly" })), removeSubscriptionDiscount } }).run).resolves.toMatchObject({ status: "skipped" });
      expect(removeSubscriptionDiscount).not.toHaveBeenCalled();
      expect(loadPromoEndWork).not.toHaveBeenCalled();
    });

    it("tries a discount removal again while Polar holds an earlier change, as nothing queues it again", async () => {
      const payload = { dropDiscount: "disc-half-off", subscriptionId: "sub-1" };
      const getSubscription = vi.fn().mockResolvedValue(subscription({ productId: "product-starter-monthly" }));
      await expect(endPromo({ work: null, payload, polar: { getSubscription, removeSubscriptionDiscount: vi.fn().mockRejectedValue(new PolarRequestError(409, null)) } }).run).rejects.toThrow("status 409");
      await expect(endPromo({ work: null, payload, polar: { getSubscription, removeSubscriptionDiscount: vi.fn().mockRejectedValue(new PolarRequestError(403, "insufficient_scope")) } }).run).resolves.toMatchObject({ status: "skipped" });
    });
  });

  it("runs the global affiliate payout job without a business context", async () => {
    const payoutRunId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(generateAffiliatePayoutRun).mockResolvedValue({ payoutRunId, periodKey: "2026-07", status: "draft", assignedCommissions: 0, totalCents: 0 });

    const result = await handleJob({
      jobId: randomUUID(),
      type: "affiliate.generatePayoutRun",
      queue: "maintenance",
      businessId: null,
      payload: { periodKey: "2026-07", createdAt: "2026-08-01T00:00:00.000Z" },
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: true,
    }, { domain });

    expect(result).toEqual({ status: "completed", entityId: payoutRunId });
    expect(generateAffiliatePayoutRun).toHaveBeenCalledWith(domain, { periodKey: "2026-07", createdAt: "2026-08-01T00:00:00.000Z" });
  });

  it("runs the daily billing check for the deployment and tells PostHog about a drift, a failure and the first pass after", async () => {
    const domain = { db: undefined as never };
    const job: JobEnvelope = { jobId: randomUUID(), type: "billing.verifyCatalog", queue: "maintenance", businessId: null, payload: {}, trace: {}, idempotencyKey: "billing-verify", scheduled: true };
    const capture = vi.fn(async () => undefined);
    const readSnapshot = vi.fn(async () => { throw new Error("not read in this test"); });
    // Without a Polar token there's nothing to compare with.
    expect(await handleJob(job, { domain })).toEqual({ status: "skipped" });
    expect(runDailyBillingVerify).not.toHaveBeenCalled();

    const drift = { code: "product", pair: "file_polar", level: "drift", subject: "Product \"Pro monthly\"", message: "x" } as const;
    const warn = { code: "code_hash", pair: "file_postgres", level: "warn", subject: "code", message: "y" } as const;
    vi.mocked(runDailyBillingVerify)
      .mockResolvedValueOnce({ status: "skipped", reason: "nothing was linked yet" })
      .mockResolvedValueOnce({ status: "drift", previousStatus: "passed", problems: [drift, { ...drift, code: "linked_id", pair: "postgres_polar" }, { ...drift, subject: "Product \"Pro annual\"" }, warn], polarEnv: "sandbox", runId: "run-1" })
      .mockResolvedValueOnce({ status: "failed", previousStatus: "drift", problems: [{ ...drift, code: "unreadable", subject: "Polar" }], polarEnv: "sandbox", runId: "run-2" })
      .mockResolvedValueOnce({ status: "passed", previousStatus: "failed", problems: [warn], polarEnv: "sandbox", runId: "run-3" })
      .mockResolvedValueOnce({ status: "passed", previousStatus: "passed", problems: [], polarEnv: "sandbox", runId: "run-4" });
    const dependencies = { domain, polarCatalog: { readSnapshot }, productAnalytics: { capture } };
    expect(await handleJob(job, dependencies)).toEqual({ status: "skipped" });
    expect(runDailyBillingVerify).toHaveBeenLastCalledWith(domain, { brand: expect.any(String), env: process.env, readPolar: expect.any(Function) });
    await vi.mocked(runDailyBillingVerify).mock.calls[0]![1].readPolar().catch(() => undefined);
    // Never the webhook, whose listing carries its signing secret.
    expect(readSnapshot).toHaveBeenCalledExactlyOnceWith({ webhooks: false });

    expect(await handleJob(job, dependencies)).toEqual({ status: "completed", entityId: "run-1:drift" });
    expect(await handleJob(job, dependencies)).toEqual({ status: "completed", entityId: "run-2:failed" });
    expect(await handleJob(job, dependencies)).toEqual({ status: "completed", entityId: "run-3:passed" });
    expect(await handleJob(job, dependencies)).toEqual({ status: "completed", entityId: "run-4:passed" });
    expect(capture.mock.calls.map((call) => (call as unknown as [Array<{ event: string; distinctId: string; properties: unknown }>])[0].map(({ event, distinctId, properties }) => ({ event, distinctId, properties })))).toEqual([
      [{ event: "ops.billing.profile_drift", distinctId: "system:deployment", properties: { status: "drift", problemCodes: ["linked_id", "product"], problemCount: 3, polarEnv: "sandbox" } }],
      [{ event: "ops.billing.profile_drift", distinctId: "system:deployment", properties: { status: "failed", problemCodes: ["unreadable"], problemCount: 1, polarEnv: "sandbox" } }],
      [{ event: "ops.billing.profile_drift_recovered", distinctId: "system:deployment", properties: { status: "passed", problemCodes: [], problemCount: 0, polarEnv: "sandbox" } }],
    ]);
  });

  it("expires due prospect demos without a business context", async () => {
    const domain = { db: undefined as never };
    vi.mocked(expireProspectDemos).mockResolvedValue(2);

    const result = await handleJob({
      jobId: randomUUID(),
      type: "prospectDemo.expire",
      queue: "maintenance",
      businessId: null,
      payload: {},
      trace: {},
      idempotencyKey: "prospect-demo-expiry",
      scheduled: true,
    }, { domain });

    expect(result).toEqual({ status: "completed", entityId: "2" });
    expect(expireProspectDemos).toHaveBeenCalledWith(domain);
  });

  it("sends an appointment change OTP through the Twilio dependency", async () => {
    const businessId = randomUUID();
    const verificationId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(claimAppointmentChangeOtp).mockResolvedValue(true);
    vi.mocked(loadAppointmentChangeOtpTarget).mockResolvedValue({ to: "+15555550123", from: "+15555550124", code: "123456", businessName: "Cedar & Stone Plumbing" });
    vi.mocked(markAppointmentChangeOtpSent).mockResolvedValue(true);
    const sendSms = vi.fn().mockResolvedValue({ providerMessageId: "SMOTP" });

    const result = await handleJob({
      jobId: randomUUID(),
      type: "appointment.sendChangeOtp",
      queue: "critical",
      businessId,
      payload: { verificationId, code: "123456", to: "+15555550123", from: "+15555550124" },
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: false,
    }, { domain, twilio: { sendSms } });

    expect(result).toEqual({ status: "completed", entityId: verificationId });
    expect(sendSms).toHaveBeenCalledWith({ to: "+15555550123", from: "+15555550124", body: "Cedar & Stone Plumbing verification code: 123456. It expires in 10 minutes." });
    expect(markAppointmentChangeOtpSent).toHaveBeenCalledWith(domain, { businessId, verificationId });
  });

  it("never sends a managed enterprise plan's usage to Polar", async () => {
    const job = billingJob({ usageEventId: randomUUID() });
    vi.mocked(loadBillingUsageEvent).mockResolvedValue({ id: String(job.payload.usageEventId), sourceKey: "voice:call-1", isFinal: true, plan: "enterprise", businessId: job.businessId!, usageKind: "voice_seconds", quantity: 120, billableQuantity: null, billingIntervalAtRecordTime: null, createdAt: new Date("2026-01-01T00:00:00.000Z"), syncStatus: "pending", billingKey: "business-key", customerId: "polar-customer-id" });
    const recordUsage = vi.fn();

    expect(await handleJob(job, { domain: { db: undefined as never }, polar: { recordUsage } })).toEqual({ status: "skipped", entityId: String(job.payload.usageEventId) });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("sends a usage row to Polar as numbered events, a correction as its difference", async () => {
    const job = billingJob({ usageEventId: randomUUID() });
    const domain = { db: undefined as never };
    vi.mocked(loadBillingUsageEvent).mockResolvedValue({
      id: String(job.payload.usageEventId),
      sourceKey: "alert_sms:operator_notification:delivery-1",
      isFinal: true,
      plan: "starter",
      businessId: job.businessId!,
      usageKind: "alert_sms_segments",
      quantity: 2,
      billableQuantity: null,
      billingIntervalAtRecordTime: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      syncStatus: "pending",
      billingKey: "business-key",
      customerId: "polar-customer-id",
    });
    vi.mocked(claimBillingUsageSync).mockResolvedValue({ externalId: "alert_sms:operator_notification:delivery-1", quantity: 2, seq: 0 });
    vi.mocked(confirmBillingUsageSync).mockResolvedValue(true);
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const usage = { businessId: job.businessId, usageEventId: String(job.payload.usageEventId) };

    const result = await handleJob(job, { domain, polar: { recordUsage } });

    expect(result).toEqual({ status: "completed", entityId: String(job.payload.usageEventId) });
    expect(claimBillingUsageSync).toHaveBeenCalledWith(domain, usage);
    expect(recordUsage).toHaveBeenCalledWith({
      eventName: "billing.alert_sms_segments",
      externalCustomerId: "business-key",
      quantity: 2,
      timestamp: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "alert_sms:operator_notification:delivery-1",
      businessId: job.businessId,
      usageKind: "alert_sms_segments",
    });
    expect(confirmBillingUsageSync).toHaveBeenCalledWith(domain, { ...usage, seq: 0 });

    // A correction after Polar took the first event: one segment fewer, under the row's next number.
    vi.mocked(claimBillingUsageSync).mockResolvedValue({ externalId: "alert_sms:operator_notification:delivery-1:2", quantity: -1, seq: 2 });
    await handleJob(job, { domain, polar: { recordUsage } });
    expect(recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: -1, idempotencyKey: "alert_sms:operator_notification:delivery-1:2", timestamp: "2026-01-01T00:00:00.000Z" }));
    expect(confirmBillingUsageSync).toHaveBeenLastCalledWith(domain, { ...usage, seq: 2 });

    const event = vi.mocked(loadBillingUsageEvent).mock.results[0]!.value;
    const original = await event;
    vi.mocked(loadBillingUsageEvent).mockResolvedValue({ ...original!, usageKind: "voice_seconds", quantity: 180, billableQuantity: 30, billingIntervalAtRecordTime: "annual" });
    vi.mocked(claimBillingUsageSync).mockResolvedValue({ externalId: "voice:call-1", quantity: 30, seq: 0 });
    await handleJob(job, { domain, polar: { recordUsage } });
    expect(recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({ eventName: "billing.voice_minutes", quantity: 0.5, externalCustomerId: "business-key" }));

    // Nothing left to send, as when a correction came back to what Polar has.
    recordUsage.mockClear();
    vi.mocked(confirmBillingUsageSync).mockClear();
    vi.mocked(claimBillingUsageSync).mockResolvedValue(null);
    expect(await handleJob(job, { domain, polar: { recordUsage } })).toEqual({ status: "completed", entityId: String(job.payload.usageEventId) });
    expect(recordUsage).not.toHaveBeenCalled();
    expect(confirmBillingUsageSync).not.toHaveBeenCalled();

    for (const change of [{ isFinal: false }, { customerId: null }, { syncStatus: "skipped" }, { plan: "free_cloud" }]) {
      vi.mocked(claimBillingUsageSync).mockClear();
      vi.mocked(loadBillingUsageEvent).mockResolvedValue({ ...original!, ...change });
      expect((await handleJob(job, { domain, polar: { recordUsage } })).status).toBe("skipped");
      expect(claimBillingUsageSync).not.toHaveBeenCalled();
      expect(recordUsage).not.toHaveBeenCalled();
    }
  });

  it("records complete Twilio SMS pricing only for terminal messages", async () => {
    const job = pricingJob("sms.syncPrice", { providerMessageId: "SM123", providerStatus: "delivered" });
    vi.mocked(recordSmsProviderPricing).mockResolvedValue(true);
    const getMessagePricing = vi.fn().mockResolvedValue({ providerPrice: -0.0045, providerPriceUnit: "usd", providerCostUsd: 0.0045, providerNumSegments: 1 });

    const result = await handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getMessagePricing } });

    expect(result).toEqual({ status: "completed", entityId: "SM123" });
    expect(getMessagePricing).toHaveBeenCalledWith({ providerMessageId: "SM123" });
    expect(recordSmsProviderPricing).toHaveBeenCalledWith({ db: undefined as never }, { businessId: job.businessId, providerMessageId: "SM123", providerPrice: -0.0045, providerPriceUnit: "usd", providerCostUsd: 0.0045, providerNumSegments: 1 });
  });

  it("does not fetch SMS pricing before the provider reaches a terminal status", async () => {
    const getMessagePricing = vi.fn();
    const job = pricingJob("sms.syncPrice", { providerMessageId: "SM123", providerStatus: "queued" });

    const result = await handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getMessagePricing } });

    expect(result).toEqual({ status: "skipped", entityId: "SM123" });
    expect(getMessagePricing).not.toHaveBeenCalled();
  });

  it("records complete Twilio call pricing for terminal calls", async () => {
    const job = pricingJob("call.syncPrice", { providerCallId: "CA123", providerCallStatus: "completed" });
    vi.mocked(recordCallProviderPricing).mockResolvedValue(true);
    const getCallPricing = vi.fn().mockResolvedValue({ providerPrice: "ignored", providerPriceUnit: "usd", providerCostUsd: 0.12 });

    const result = await handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getCallPricing } });

    expect(result).toEqual({ status: "completed", entityId: "CA123" });
    expect(getCallPricing).toHaveBeenCalledWith({ providerCallId: "CA123" });
    expect(recordCallProviderPricing).toHaveBeenCalledWith({ db: undefined as never }, { businessId: job.businessId, providerCallId: "CA123", providerPrice: "ignored", providerPriceUnit: "usd", providerCostUsd: 0.12 });
  });

  it("prices a GPT-Live phone call by finding its Twilio call on the trunk", async () => {
    const job = pricingJob("call.syncPrice", { callId: "call_1", providerCallStatus: "completed" });
    const startedAt = new Date("2026-09-26T12:00:00Z");
    vi.stubEnv("TWILIO_SIP_TRUNK_SID", "TK123");
    vi.mocked(loadLiveCallForPricing).mockResolvedValue({ startedAt, callerPhone: "+14165550134" });
    vi.mocked(recordCallProviderPricing).mockResolvedValue(true);
    const findTrunkCall = vi.fn().mockResolvedValue("CA777");
    const getCallPricing = vi.fn().mockResolvedValue({ providerPriceUnit: "usd", providerCostUsd: 0.02 });

    const result = await handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getCallPricing, findTrunkCall } });

    expect(result).toEqual({ status: "completed", entityId: "call_1" });
    expect(findTrunkCall).toHaveBeenCalledWith({ trunkSid: "TK123", near: startedAt, from: "+14165550134" });
    vi.unstubAllEnvs();
    expect(recordCallProviderPricing).toHaveBeenCalledWith({ db: undefined as never }, expect.objectContaining({ providerCallId: "CA777", callId: "call_1", providerCostUsd: 0.02 }));
  });

  it("checks a text's price again later while Twilio hasn't filled it in", async () => {
    const getMessagePricing = vi.fn().mockResolvedValue({ providerNumSegments: 1 });
    for (const [priceRecheck, recheck] of [[undefined, 1], [4, 5]] as const) {
      const job = pricingJob("sms.syncPrice", { providerMessageId: "SM123", providerStatus: "sent", ...(priceRecheck ? { priceRecheck } : {}) });

      const result = await handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getMessagePricing } });

      expect(result).toEqual({ status: "skipped", entityId: `SM123:recheck:${recheck}` });
      expect(recheckProviderPrice).toHaveBeenLastCalledWith({ db: undefined as never }, { topic: "sms.syncPrice", businessId: job.businessId, entityId: "SM123", payload: job.payload, recheck });
    }
    expect(recordSmsProviderPricing).not.toHaveBeenCalled();
  });

  it("reports a text Twilio never priced as a warning, not an error, once the rechecks run out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const job = pricingJob("sms.syncPrice", { providerMessageId: "SM123", providerStatus: "failed", priceRecheck: PROVIDER_PRICE_RECHECKS });
    const getMessagePricing = vi.fn().mockResolvedValue({ providerNumSegments: 1 });

    const result = await handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getMessagePricing } }, { queueJobId: "job_1" });

    expect(result).toEqual({ status: "skipped", entityId: "SM123" });
    expect(recheckProviderPrice).not.toHaveBeenCalled();
    expect(recordSmsProviderPricing).not.toHaveBeenCalled();
    const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringMatching(/\] warning: Twilio SMS pricing is incomplete for SM123\.$/), operation: "job.sms.syncPrice", jobType: "sms.syncPrice", jobId: "job_1", rechecks: PROVIDER_PRICE_RECHECKS, alertable: false }));
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it("still fails the job when Twilio can't be reached", async () => {
    const job = pricingJob("sms.syncPrice", { providerMessageId: "SM123", providerStatus: "delivered" });
    const getMessagePricing = vi.fn().mockRejectedValue(new Error("connect ECONNRESET"));

    await expect(handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getMessagePricing } })).rejects.toThrow("connect ECONNRESET");
    expect(recheckProviderPrice).not.toHaveBeenCalled();
  });

  it("checks a call's price again later, then reports it as a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getCallPricing = vi.fn().mockResolvedValue({ providerPriceUnit: "usd" });
    const job = pricingJob("call.syncPrice", { providerCallId: "CA123", providerCallStatus: "completed" });

    await expect(handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getCallPricing } })).resolves.toEqual({ status: "skipped", entityId: "CA123:recheck:1" });
    expect(recheckProviderPrice).toHaveBeenCalledWith({ db: undefined as never }, { topic: "call.syncPrice", businessId: job.businessId, entityId: "CA123", payload: job.payload, recheck: 1 });

    const last = pricingJob("call.syncPrice", { providerCallId: "CA123", providerCallStatus: "completed", priceRecheck: PROVIDER_PRICE_RECHECKS });
    await expect(handleJob(last, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getCallPricing } })).resolves.toEqual({ status: "skipped", entityId: "CA123" });
    expect(recheckProviderPrice).toHaveBeenCalledTimes(1);
    expect(recordCallProviderPricing).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringMatching(/\] warning: Twilio call pricing is incomplete for CA123\.$/), operation: "job.call.syncPrice", rechecks: PROVIDER_PRICE_RECHECKS }));
    warn.mockRestore();
  });

  it("checks a GPT-Live call's price again later while Twilio hasn't listed or priced the call", async () => {
    vi.stubEnv("TWILIO_SIP_TRUNK_SID", "TK123");
    vi.mocked(loadLiveCallForPricing).mockResolvedValue({ startedAt: new Date("2026-09-26T12:00:00Z"), callerPhone: "+14165550134" });
    const job = pricingJob("call.syncPrice", { callId: "call_1", providerCallStatus: "completed" });
    const getCallPricing = vi.fn().mockResolvedValue({});

    await expect(handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getCallPricing, findTrunkCall: vi.fn().mockResolvedValue(undefined) } })).resolves.toEqual({ status: "skipped", entityId: "call_1:recheck:1" });
    expect(getCallPricing).not.toHaveBeenCalled();
    await expect(handleJob(job, { domain: { db: undefined as never }, twilio: { sendSms: vi.fn(), getCallPricing, findTrunkCall: vi.fn().mockResolvedValue("CA777") } })).resolves.toEqual({ status: "skipped", entityId: "call_1:recheck:1" });

    expect(recheckProviderPrice).toHaveBeenCalledTimes(2);
    expect(recheckProviderPrice).toHaveBeenCalledWith({ db: undefined as never }, { topic: "call.syncPrice", businessId: job.businessId, entityId: "call_1", payload: job.payload, recheck: 1 });
    expect(recordCallProviderPricing).not.toHaveBeenCalled();
  });

  it("delivers a resolved SMS notification and records the provider id", async () => {
    const businessId = randomUUID();
    const notificationId = randomUUID();
    vi.mocked(resolveNotificationDelivery).mockResolvedValue({
      kind: "ready",
      delivery: {
        notificationId,
        businessId,
        channel: "sms",
        kind: "appointment_confirmation",
        relatedId: "appointment_1",
        to: "+15555550123",
        from: "+15555550124",
        subject: "Appointment confirmed",
        body: "Your appointment is confirmed.",
      },
    });
    vi.mocked(markNotificationSent).mockResolvedValue(true);
    vi.mocked(claimNotificationDelivery).mockResolvedValue(true);
    const sendSms = vi.fn().mockResolvedValue({ providerMessageId: "SM123" });
    const domain = { db: undefined as never };

    const result = await handleJob({ ...notificationJob({ notificationId }), businessId }, {
      domain,
      twilio: { sendSms },
    });

    expect(result).toEqual({ status: "completed", entityId: notificationId });
    expect(sendSms).toHaveBeenCalledWith({ to: "+15555550123", from: "+15555550124", body: "Your appointment is confirmed." });
    expect(markNotificationSent).toHaveBeenCalledWith(domain, { businessId, notificationId, providerMessageId: "SM123" });
  });

  it("sends a customer's appointment text from the shared sender through the alert account that owns it", async () => {
    const businessId = randomUUID();
    const notificationId = randomUUID();
    const delivery = { notificationId, businessId, channel: "sms" as const, kind: "appointment_reminder", relatedId: "appointment_1", to: "+15555550123", from: "+18446562290", subject: "Appointment reminder", body: "Reminder." };
    vi.mocked(resolveNotificationDelivery).mockResolvedValue({ kind: "ready", delivery });
    vi.mocked(claimNotificationDelivery).mockResolvedValue(true);
    vi.mocked(markNotificationSent).mockResolvedValue(true);
    const mainSend = vi.fn().mockResolvedValue({ providerMessageId: "SMmain" });
    const defaultSend = vi.fn().mockResolvedValue({ providerMessageId: "SMdefault" });
    const domain = { db: undefined as never };
    const job = { ...notificationJob({ notificationId }), businessId };

    await expect(handleJob(job, { domain, twilio: { sendSms: defaultSend }, twilioAlerts: { from: "+18446562290", sendSms: mainSend } })).resolves.toEqual({ status: "completed", entityId: notificationId });
    expect(mainSend).toHaveBeenCalledWith(expect.objectContaining({ to: "+15555550123", from: "+18446562290", body: "Reminder." }));
    expect(defaultSend).not.toHaveBeenCalled();
    expect(markNotificationSent).toHaveBeenCalledWith(domain, { businessId, notificationId, providerMessageId: "SMmain" });
    // Without a default account, the shared sender still goes out.
    await expect(handleJob(job, { domain, twilioAlerts: { from: "+18446562290", sendSms: mainSend } })).resolves.toEqual({ status: "completed", entityId: notificationId });
    expect(mainSend).toHaveBeenCalledTimes(2);
    // A self-hosted business's own number uses the default account.
    vi.mocked(resolveNotificationDelivery).mockResolvedValue({ kind: "ready", delivery: { ...delivery, from: "+14165550124" } });
    await handleJob(job, { domain, twilio: { sendSms: defaultSend }, twilioAlerts: { from: "+18446562290", sendSms: mainSend } });
    expect(defaultSend).toHaveBeenCalledWith(expect.objectContaining({ from: "+14165550124" }));
    expect(mainSend).toHaveBeenCalledTimes(2);
  });

  it("sends an appointment change code from the shared sender through the alert account", async () => {
    const businessId = randomUUID();
    const verificationId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(claimAppointmentChangeOtp).mockResolvedValue(true);
    vi.mocked(loadAppointmentChangeOtpTarget).mockResolvedValue({ to: "+15555550123", from: "+18446562290", code: "123456", businessName: "  " });
    brand.appBaseUrl = "https://demo.alloplace.com";
    vi.mocked(markAppointmentChangeOtpSent).mockResolvedValue(true);
    const mainSend = vi.fn().mockResolvedValue({ providerMessageId: "SMmain" });
    const defaultSend = vi.fn();
    const job: JobEnvelope = { jobId: randomUUID(), type: "appointment.sendChangeOtp", queue: "critical", businessId, payload: { verificationId, code: "123456", to: "+15555550123", from: "+18446562290" }, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };

    await expect(handleJob(job, { domain, twilio: { sendSms: defaultSend }, twilioAlerts: { from: "+18446562290", sendSms: mainSend } })).resolves.toEqual({ status: "completed", entityId: verificationId });
    // A business without a usable name falls back to the deployment's.
    expect(mainSend).toHaveBeenCalledWith({ to: "+15555550123", from: "+18446562290", body: "AlloPlace verification code: 123456. It expires in 10 minutes." });
    expect(defaultSend).not.toHaveBeenCalled();
  });

  it("delivers a durable operator email and records completion", async () => {
    const businessId = randomUUID();
    const deliveryId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(claimOperatorNotificationDelivery).mockResolvedValue(true);
    vi.mocked(loadOperatorNotificationDelivery).mockResolvedValue({ id: deliveryId, businessId, userId: randomUUID(), eventKind: "voiceMessage", eventKey: "voice:1", channel: "email", status: "processing", destination: "operator@example.test", sender: null, subject: "New message", body: "A caller left a message.", providerMessageId: null, scheduledFor: new Date(), sentAt: null, contentExpiresAt: new Date(), lastError: null, createdAt: new Date(), updatedAt: new Date(), businessName: "Maple Dental" });
    vi.stubEnv("APP_BASE_URL", "https://app.example.test");
    const sendTemplate = vi.fn().mockResolvedValue({ messageId: "email-123" });

    const result = await handleJob({ ...notificationJob({ operatorDeliveryId: deliveryId }), businessId }, { domain, email: { sendTemplate } });

    expect(result).toEqual({ status: "completed", entityId: deliveryId });
    // The email names the business and the alert, and links into the dashboard.
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      template: "operator_alert",
      to: "operator@example.test",
      subject: "New message",
      variables: { message: "A caller left a message.", eventKind: "voiceMessage", appUrl: "https://app.example.test", businessName: "Maple Dental" },
      idempotencyKey: `operator-notification:${deliveryId}`,
    }));
    expect(markOperatorNotificationSent).toHaveBeenCalledWith(domain, { businessId, deliveryId, providerMessageId: "email-123" });
  });

  it("uses separate main-account credentials only for the configured operator alert sender", async () => {
    const businessId = randomUUID(); const deliveryId = randomUUID(); const domain = { db: undefined as never };
    vi.mocked(claimOperatorNotificationDelivery).mockResolvedValue(true);
    vi.mocked(loadOperatorNotificationDelivery).mockResolvedValue({ id: deliveryId, businessId, userId: randomUUID(), eventKind: "voiceMessage", eventKey: "voice:1", channel: "sms", status: "processing", destination: "+14165550100", sender: "+14165550101", subject: "New message", body: "A caller left a message.", providerMessageId: null, scheduledFor: new Date(), sentAt: null, contentExpiresAt: new Date(), lastError: null, createdAt: new Date(), updatedAt: new Date(), businessName: null });
    const mainSend = vi.fn().mockResolvedValue({ providerMessageId: "SMmain" });
    const stagingSend = vi.fn().mockResolvedValue({ providerMessageId: "SMstaging" });
    const job = { ...notificationJob({ operatorDeliveryId: deliveryId }), businessId };
    await handleJob(job, { domain, twilio: { sendSms: stagingSend }, twilioAlerts: { from: "+14165550101", sendSms: mainSend } });
    expect(mainSend).toHaveBeenCalledOnce();
    expect(stagingSend).not.toHaveBeenCalled();
    await handleJob(job, { domain, twilio: { sendSms: stagingSend }, twilioAlerts: { from: "+14165550999", sendSms: mainSend } });
    expect(stagingSend).toHaveBeenCalledOnce();
  });

  it("runs the tenant-scoped daily operator summary job", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(queueDailyOperatorSummaries).mockResolvedValue({ eligible: 1, queued: 1 });

    const result = await handleJob({ ...notificationJob({}), type: "notification.dailySummary", queue: "maintenance", businessId }, { domain });

    expect(result).toEqual({ status: "completed", entityId: `${businessId}:1` });
    expect(queueDailyOperatorSummaries).toHaveBeenCalledWith(domain, { businessId });
  });

  it("does not call a provider when another worker owns the notification lease", async () => {
    const businessId = randomUUID();
    const notificationId = randomUUID();
    vi.mocked(claimNotificationDelivery).mockResolvedValue(false);
    const sendSms = vi.fn();

    const result = await handleJob({ ...notificationJob({ notificationId }), businessId }, {
      domain: { db: undefined as never },
      twilio: { sendSms },
    });

    expect(result).toEqual({ status: "skipped", entityId: notificationId });
    expect(sendSms).not.toHaveBeenCalled();
    expect(resolveNotificationDelivery).not.toHaveBeenCalled();
  });

  it("runs a notification again when the lease of a crashed send ends", async () => {
    const businessId = randomUUID();
    const notificationId = randomUUID();
    const deliveryId = randomUUID();
    const retryAt = new Date(Date.now() + 240_000);
    const domain = { db: undefined as never };
    vi.mocked(claimNotificationDelivery).mockResolvedValue(false);
    vi.mocked(notificationLeaseEndsAt).mockResolvedValue(retryAt);
    vi.mocked(claimOperatorNotificationDelivery).mockResolvedValue(false);
    vi.mocked(operatorNotificationLeaseEndsAt).mockResolvedValue(retryAt);
    const sendSms = vi.fn();

    await expect(handleJob({ ...notificationJob({ notificationId }), businessId }, { domain, twilio: { sendSms } })).resolves.toEqual({ status: "deferred", entityId: notificationId, retryAt });
    await expect(handleJob({ ...notificationJob({ operatorDeliveryId: deliveryId }), businessId }, { domain, twilio: { sendSms } })).resolves.toEqual({ status: "deferred", entityId: deliveryId, retryAt });
    expect(notificationLeaseEndsAt).toHaveBeenCalledWith(domain, { businessId, notificationId });
    expect(operatorNotificationLeaseEndsAt).toHaveBeenCalledWith(domain, { businessId, deliveryId });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("releases the notification lease when provider delivery fails", async () => {
    const businessId = randomUUID();
    const notificationId = randomUUID();
    vi.mocked(claimNotificationDelivery).mockResolvedValue(true);
    vi.mocked(resolveNotificationDelivery).mockResolvedValue({
      kind: "ready",
      delivery: {
        notificationId,
        businessId,
        channel: "sms",
        kind: "appointment_confirmation",
        relatedId: "appointment_1",
        to: "+15555550123",
        from: "+15555550124",
        subject: "Appointment confirmed",
        body: "Your appointment is confirmed.",
      },
    });
    const error = new Error("provider unavailable");
    const sendSms = vi.fn().mockRejectedValue(error);

    await expect(handleJob({ ...notificationJob({ notificationId }), businessId }, {
      domain: { db: undefined as never },
      twilio: { sendSms },
    })).rejects.toThrow(error);
    expect(transitionProcessingNotification).toHaveBeenCalledWith({ db: undefined as never }, { businessId, notificationId }, "pending");
  });

  it("stops retrying a text Twilio rejects for good, such as a country the account can't text", async () => {
    const businessId = randomUUID();
    const notificationId = randomUUID();
    vi.mocked(claimNotificationDelivery).mockResolvedValue(true);
    vi.mocked(resolveNotificationDelivery).mockResolvedValue({
      kind: "ready",
      delivery: { notificationId, businessId, channel: "sms", kind: "booking_confirmation", relatedId: "appointment_1", to: "+381695021111", from: "+14165550124", subject: "Appointment confirmed", body: "Your appointment is confirmed." },
    });
    const sendSms = vi.fn().mockRejectedValue(Object.assign(new Error("Permission to send an SMS has not been enabled for the region"), { code: 21408, status: 400 }));

    await expect(handleJob({ ...notificationJob({ notificationId }), businessId }, { domain: { db: undefined as never }, twilio: { sendSms } })).resolves.toEqual({ status: "skipped", entityId: notificationId });
    expect(transitionProcessingNotification).toHaveBeenCalledWith({ db: undefined as never }, { businessId, notificationId }, "failed");
    expect(transitionProcessingNotification).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "pending");
    expect(recordProductEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "notification.delivery_failed", businessId }));
  });

  it("emits workflow.started for an event-driven business-scoped job", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(claimNotificationDelivery).mockResolvedValue(false);

    await handleJob({ ...notificationJob({}), businessId }, { domain });

    expect(recordProductEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: "workflow.started",
      businessId,
      properties: { workflowName: "notification.dispatch", scope: "business" },
    }));
    expect(recordProductEvent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "workflow.failed" }));
  });

  it("does not emit workflow.started for a scheduled maintenance tick", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(queueDailyOperatorSummaries).mockResolvedValue({ eligible: 0, queued: 0 });

    const result = await handleJob({
      ...notificationJob({}),
      type: "notification.dailySummary",
      queue: "maintenance",
      businessId,
      scheduled: true,
      recurring: true,
    }, { domain });

    expect(result).toEqual({ status: "skipped", entityId: `${businessId}:0` });
    expect(recordProductEvent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "workflow.started" }));
  });

  it("does not make a scheduled telemetry flush generate telemetry about itself", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    const capture = vi.fn();
    vi.mocked(loadPendingProductEvents).mockResolvedValue([]);

    const result = await handleJob({
      ...notificationJob({}),
      type: "telemetry.flush",
      queue: "maintenance",
      businessId,
      scheduled: true,
      recurring: true,
    }, { domain, productAnalytics: { capture } });

    expect(result).toEqual({ status: "skipped", entityId: businessId });
    expect(capture).not.toHaveBeenCalled();
    expect(recordProductEvent).not.toHaveBeenCalled();
  });

  it("keeps workflow.started for delayed jobs whose type also has a recurring schedule", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(queueDailyOperatorSummaries).mockResolvedValue({ eligible: 0, queued: 0 });

    await handleJob({
      ...notificationJob({}),
      type: "notification.dailySummary",
      queue: "maintenance",
      businessId,
      scheduled: true,
    }, { domain });

    expect(recordProductEvent).toHaveBeenCalledWith(domain, expect.objectContaining({
      name: "workflow.started",
      businessId,
      properties: { workflowName: "notification.dailySummary", scope: "business" },
    }));
  });

  it("still emits workflow.failed when a scheduled maintenance job fails", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    const error = new Error("summary failed");
    vi.mocked(queueDailyOperatorSummaries).mockRejectedValueOnce(error);

    await expect(handleJob({
      ...notificationJob({}),
      type: "notification.dailySummary",
      queue: "maintenance",
      businessId,
      scheduled: true,
      recurring: true,
    }, { domain })).rejects.toThrow(error);

    expect(recordProductEvent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "workflow.started" }));
    expect(recordProductEvent).toHaveBeenCalledWith(domain, expect.objectContaining({
      name: "workflow.failed",
      businessId,
      properties: { workflowName: "notification.dailySummary", scope: "business" },
    }));
  });

  it("emits workflow.failed and notification.delivery_failed when a notification provider fails", async () => {
    const businessId = randomUUID();
    const notificationId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(claimNotificationDelivery).mockResolvedValue(true);
    vi.mocked(resolveNotificationDelivery).mockResolvedValue({
      kind: "ready",
      delivery: {
        notificationId,
        businessId,
        channel: "sms",
        kind: "appointment_reminder",
        relatedId: "appointment_9",
        to: "+15555550123",
        from: "+15555550124",
        subject: "Appointment reminder",
        body: "Reminder.",
      },
    });
    const error = new Error("provider unavailable");
    const sendSms = vi.fn().mockRejectedValue(error);

    await expect(handleJob({ ...notificationJob({ notificationId }), businessId }, { domain, twilio: { sendSms } })).rejects.toThrow(error);

    expect(recordProductEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: "workflow.started",
      businessId,
      properties: { workflowName: "notification.dispatch", scope: "business" },
    }));
    expect(recordProductEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: "workflow.failed",
      businessId,
      properties: { workflowName: "notification.dispatch", scope: "business" },
    }));
    expect(recordProductEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: "notification.delivery_failed",
      businessId,
      properties: { kind: "appointment_reminder", appointmentId: "appointment_9" },
    }));
  });

  it("does not emit durable workflow events for global jobs", async () => {
    const domain = { db: undefined as never };
    vi.mocked(expireProspectDemos).mockResolvedValue(0);

    await handleJob({
      jobId: randomUUID(),
      type: "prospectDemo.expire",
      queue: "maintenance",
      businessId: null,
      payload: {},
      trace: {},
      idempotencyKey: "prospect-demo-expiry",
      scheduled: true,
    }, { domain });

    expect(recordProductEvent).not.toHaveBeenCalled();
  });

  it("emits notification.delivery_failed with the operator event kind", async () => {
    const businessId = randomUUID();
    const deliveryId = randomUUID();
    const domain = { db: undefined as never };
    vi.mocked(claimOperatorNotificationDelivery).mockResolvedValue(true);
    vi.mocked(loadOperatorNotificationDelivery).mockResolvedValue({ id: deliveryId, businessId, userId: randomUUID(), eventKind: "voiceMessage", eventKey: "voice:1", channel: "email", status: "processing", destination: "operator@example.test", sender: null, subject: "New message", body: "A caller left a message.", providerMessageId: null, scheduledFor: new Date(), sentAt: null, contentExpiresAt: new Date(), lastError: null, createdAt: new Date(), updatedAt: new Date(), businessName: "Maple Dental" });
    const error = new Error("smtp down");
    const sendTemplate = vi.fn().mockRejectedValue(error);

    await expect(handleJob({ ...notificationJob({ operatorDeliveryId: deliveryId }), businessId }, { domain, email: { sendTemplate } })).rejects.toThrow(error);

    expect(recordProductEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: "notification.delivery_failed",
      businessId,
      properties: { kind: "voiceMessage" },
    }));
  });

  it("emits ops.billing.usage_sync_failed without fabricating a recovery event", async () => {
    const job = billingJob({ usageEventId: randomUUID() });
    const domain = { db: undefined as never };
    vi.mocked(loadBillingUsageEvent).mockResolvedValue({
      id: String(job.payload.usageEventId),
      sourceKey: "voice:call_1",
      isFinal: true,
      plan: "starter",
      businessId: job.businessId!,
      usageKind: "voice_seconds",
      quantity: 120,
      billableQuantity: null,
      billingIntervalAtRecordTime: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      syncStatus: "pending",
      billingKey: "business-key",
      customerId: "polar-customer-id",
    });
    vi.mocked(claimBillingUsageSync).mockResolvedValue({ externalId: "voice:call_1", quantity: 120, seq: 0 });
    const error = new Error("polar unavailable");
    const recordUsage = vi.fn().mockRejectedValue(error);

    await expect(handleJob(job, { domain, polar: { recordUsage } })).rejects.toThrow(error);

    expect(recordProductEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: "ops.billing.usage_sync_failed",
      businessId: job.businessId,
      properties: { provider: "polar" },
    }));
    expect(recordProductEvent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "ops.billing.usage_sync_recovered" }));
    expect(confirmBillingUsageSync).not.toHaveBeenCalled();
  });

  it("samples a tenant outbox backlog and records a durable product event only when non-empty", async () => {
    const businessId = randomUUID();
    const domain = { db: undefined as never };
    const backlogJob = {
      jobId: randomUUID(),
      type: "outbox.backlogSample" as const,
      queue: "maintenance" as const,
      businessId,
      payload: {},
      trace: {},
      idempotencyKey: `test:${randomUUID()}`,
      scheduled: true,
      recurring: true,
    };

    vi.mocked(countPublishableOutboxMessages).mockResolvedValue(0);
    const idle = await handleJob(backlogJob, { domain });

    expect(idle).toEqual({ status: "skipped", entityId: `${businessId}:0` });
    expect(countPublishableOutboxMessages).toHaveBeenCalledWith(domain, { businessId });
    expect(recordProductEvent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "ops.outbox.backlog_sample" }));

    vi.mocked(countPublishableOutboxMessages).mockResolvedValue(4);
    const backlogged = await handleJob(backlogJob, { domain });

    expect(backlogged).toEqual({ status: "completed", entityId: `${businessId}:1_9` });
    expect(recordProductEvent).toHaveBeenCalledWith(domain, expect.objectContaining({
      name: "ops.outbox.backlog_sample",
      businessId,
      distinctId: `system:business:${businessId}`,
      actorType: "worker",
      properties: { backlogBucket: "1_9" },
    }));
  });
});
