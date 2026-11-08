import { createHmac, randomUUID } from "node:crypto";
import twilio from "twilio";
import { Webhook } from "standardwebhooks";

import { and, eq, inArray } from "drizzle-orm";

import { businesses, createDatabaseClient, messages, outboxMessages, phoneNumbers, providerEvents } from "@lobbystack/db";
import { billingProviderOf, stripeKeyMode } from "@lobbystack/shared";

import { certificationInvoicePaid, stripeSignatureHeader } from "./lib/stripe-webhook-delivery";

const postgresPort = process.env.POSTGRES_PORT ?? "15433";
const postgresPassword = process.env.POSTGRES_PASSWORD ?? "replace-with-a-long-local-password";
const migrator = createDatabaseClient("lobbystack_migrator", {
  DATABASE_URL: process.env.REPLACEMENT_MIGRATOR_DATABASE_URL ?? `postgres://postgres:${postgresPassword}@127.0.0.1:${postgresPort}/lobbystack`,
});
const adminBaseUrl = process.env.ADMIN_BASE_URL ?? "http://127.0.0.1:13000";
// The deployment bills through one provider: its webhook takes the provider's deliveries, and the other's route answers 404.
const billingProvider = billingProviderOf(process.env);
const polarSecret = process.env.POLAR_WEBHOOK_SECRET ?? "replace-with-polar-webhook-secret";
// During a rotation STRIPE_WEBHOOK_SECRET holds two secrets, and either signs.
const stripeSecret = (process.env.STRIPE_WEBHOOK_SECRET ?? "replace-with-stripe-webhook-secret").split(",")[0]!.trim();
const twilioToken = process.env.TWILIO_AUTH_TOKEN ?? "replace-with-twilio-auth-token";
const resendSecret = process.env.RESEND_WEBHOOK_SECRET;

function polarHeaders(body: string, eventId: string): Record<string, string> {
  const signedAt = new Date();
  const timestamp = String(Math.floor(signedAt.getTime() / 1000));
  const signature = new Webhook(Buffer.from(polarSecret, "utf8").toString("base64")).sign(eventId, signedAt, body);
  return {
    "content-type": "application/json",
    "webhook-id": eventId,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  };
}

function resendHeaders(body: string, eventId: string): Record<string, string> {
  if (!resendSecret) throw new Error("Resend webhook secret is not configured.");
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const rawSecret = resendSecret.startsWith("whsec_") ? resendSecret.slice("whsec_".length) : resendSecret;
  const signature = createHmac("sha256", Buffer.from(rawSecret, "base64")).update(`${eventId}.${timestamp}.${body}`).digest("base64");
  return { "content-type": "application/json", "svix-id": eventId, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
}

/** Sends one billing delivery three times: tampered, which must be refused, then twice, the second a duplicate. */
async function checkBillingDelivery(provider: string, url: string, body: string, headers: () => Record<string, string>, tampered: Record<string, string>): Promise<void> {
  const invalid = await fetch(url, { method: "POST", headers: { ...headers(), ...tampered }, body });
  if (invalid.status !== 401) throw new Error(`Tampered ${provider} webhook returned ${invalid.status} instead of 401.`);
  const first = await fetch(url, { method: "POST", headers: headers(), body });
  const second = await fetch(url, { method: "POST", headers: headers(), body });
  const firstResult = await first.json() as { duplicate?: boolean };
  const secondResult = await second.json() as { duplicate?: boolean };
  if (!first.ok || firstResult.duplicate !== false || !second.ok || secondResult.duplicate !== true) {
    throw new Error(`${provider} duplicate delivery was not handled idempotently.`);
  }
}

async function postTwilio(url: string, params: Record<string, string>): Promise<Response> {
  const signature = twilio.getExpectedTwilioSignature(twilioToken, url, params);
  return await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(params),
  });
}

async function main(): Promise<void> {
  const suffix = randomUUID();
  const businessId = randomUUID();
  const polarEventId = `polar-${suffix}`;
  const stripeDelivery = certificationInvoicePaid({ businessId, suffix, livemode: stripeKeyMode(process.env.STRIPE_API_KEY ?? "") === "live" });
  const billingEventId = billingProvider === "stripe" ? stripeDelivery.eventId : polarEventId;
  const resendEventId = `resend-${suffix}`;
  const messageSid = `SM${suffix.replaceAll("-", "")}`;
  const businessPhone = "+15555550101";

  try {
    await migrator.db.insert(businesses).values({ id: businessId, slug: `webhook-${suffix}`, name: "Webhook Check", timezone: "UTC", businessType: "service_company" });
    await migrator.db.insert(phoneNumbers).values({ businessId, e164: businessPhone, providerPhoneId: `PN${suffix.replaceAll("-", "")}` });

    if (billingProvider === "stripe") {
      // A paid invoice of the business, as Stripe sends it to /api/webhooks/stripe.
      const stripeHeaders = () => ({ "content-type": "application/json", "stripe-signature": stripeSignatureHeader(stripeDelivery.body, stripeSecret) });
      await checkBillingDelivery("Stripe", `${adminBaseUrl}/api/webhooks/stripe`, stripeDelivery.body, stripeHeaders, { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=invalid` });
    } else {
      const polarBody = JSON.stringify({ id: polarEventId, type: "order.created", timestamp: new Date().toISOString(), data: { businessId, id: `order-${suffix}` } });
      await checkBillingDelivery("Polar", `${adminBaseUrl}/api/webhooks/polar`, polarBody, () => polarHeaders(polarBody, polarEventId), { "webhook-signature": "v1,invalid" });
    }
    // An endpoint left at the other provider is answered 404, and never stored.
    const otherRoute = `${adminBaseUrl}/api/webhooks/${billingProvider === "stripe" ? "polar" : "stripe"}`;
    const other = await fetch(otherRoute, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (other.status !== 404) throw new Error(`${otherRoute} answered ${other.status} on a deployment billed through ${billingProvider}, instead of 404.`);

    if (resendSecret) {
      const resendUrl = `${adminBaseUrl}/api/webhooks/resend`;
      const resendBody = JSON.stringify({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: `email-${suffix}` } });
      const invalidResend = await fetch(resendUrl, { method: "POST", headers: { ...resendHeaders(resendBody, resendEventId), "svix-signature": "v1,invalid" }, body: resendBody });
      if (invalidResend.status !== 401) throw new Error(`Tampered Resend webhook returned ${invalidResend.status} instead of 401.`);
      const firstResend = await fetch(resendUrl, { method: "POST", headers: resendHeaders(resendBody, resendEventId), body: resendBody });
      const secondResend = await fetch(resendUrl, { method: "POST", headers: resendHeaders(resendBody, resendEventId), body: resendBody });
      const firstResendResult = await firstResend.json() as { duplicate?: boolean };
      const secondResendResult = await secondResend.json() as { duplicate?: boolean };
      if (!firstResend.ok || firstResendResult.duplicate !== false || !secondResend.ok || secondResendResult.duplicate !== true) throw new Error("Resend duplicate delivery was not handled idempotently.");
    }

    const smsUrl = process.env.TWILIO_SMS_WEBHOOK_URL ?? `${adminBaseUrl}/api/webhooks/twilio/sms`;
    const smsParams = { MessageSid: messageSid, From: "+15555550199", To: businessPhone, Body: "Webhook certification message", NumMedia: "0" };
    const invalidSms = await fetch(smsUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "invalid" }, body: new URLSearchParams(smsParams) });
    if (invalidSms.status !== 401) throw new Error(`Tampered Twilio webhook returned ${invalidSms.status} instead of 401.`);
    const firstSms = await postTwilio(smsUrl, smsParams);
    const secondSms = await postTwilio(smsUrl, smsParams);
    if (!firstSms.ok || !secondSms.ok) throw new Error(`Twilio inbound delivery failed with statuses ${firstSms.status}/${secondSms.status}.`);

    const statusUrl = process.env.TWILIO_STATUS_CALLBACK_URL ?? `${adminBaseUrl}/api/webhooks/twilio/status`;
    const statusParams = { MessageSid: messageSid, MessageStatus: "delivered" };
    const firstStatus = await postTwilio(statusUrl, statusParams);
    const secondStatus = await postTwilio(statusUrl, statusParams);
    if (!firstStatus.ok || !secondStatus.ok) throw new Error(`Twilio status delivery failed with statuses ${firstStatus.status}/${secondStatus.status}.`);

    const eventIds = [billingEventId, messageSid, ...(resendSecret ? [resendEventId] : [])];
    const storedEvents = await migrator.db.select({ provider: providerEvents.provider, providerEventId: providerEvents.providerEventId })
      .from(providerEvents)
      .where(inArray(providerEvents.providerEventId, eventIds));
    const storedMessages = await migrator.db.select({ id: messages.id, status: messages.status, providerStatus: messages.providerStatus })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), eq(messages.providerMessageId, messageSid)));
    if (storedEvents.length !== eventIds.length || storedMessages.length !== 1 || storedMessages[0]?.status !== "delivered" || storedMessages[0]?.providerStatus !== "delivered") {
      throw new Error("Webhook persistence or delivery-state idempotency verification failed.");
    }

    console.log("webhook-signatures: ok");
    console.log(`webhook-${billingProvider}-idempotency: ok`);
    console.log("webhook-other-billing-provider-refused: ok");
    if (resendSecret) console.log("webhook-resend-idempotency: ok");
    console.log("webhook-twilio-idempotency: ok");
  } finally {
    await migrator.db.delete(outboxMessages).where(eq(outboxMessages.businessId, businessId)).catch(() => undefined);
    await migrator.db.delete(providerEvents).where(inArray(providerEvents.providerEventId, [billingEventId, messageSid, ...(resendSecret ? [resendEventId] : [])])).catch(() => undefined);
    await migrator.db.delete(businesses).where(eq(businesses.id, businessId)).catch(() => undefined);
    await migrator.pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
