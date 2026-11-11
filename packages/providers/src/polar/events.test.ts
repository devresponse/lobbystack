import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { BillingWebhookRefusal } from "../billing/errors";
import { PolarWebhook, polarEventKind } from "./events";

const secret = Buffer.from("polar-events-test-secret").toString("base64");

function signed(body: string, options: { id?: string; timestamp?: number; signature?: string } = {}): Headers {
  const id = options.id ?? "delivery-1";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = options.signature ?? `v1,${createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
  return new Headers({ "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature });
}

function refusal(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof BillingWebhookRefusal) return error.reason;
    throw error;
  }
  return undefined;
}

describe("Polar's webhook", () => {
  it("takes a signed delivery, with the ID from its headers", () => {
    const body = JSON.stringify({ type: "subscription.active", timestamp: "2026-11-08T00:00:00Z", data: { id: "sub-1" } });
    expect(new PolarWebhook(secret).verify(body, signed(body))).toEqual({ id: "delivery-1", type: "subscription.active", createdAt: new Date("2026-11-08T00:00:00Z"), livemode: null, object: { id: "sub-1" } });
  });

  it("refuses without a secret, without headers, with a bad or old signature, and a body that isn't an event", () => {
    const body = JSON.stringify({ type: "subscription.active", data: {} });
    expect(refusal(() => new PolarWebhook(undefined).verify(body, signed(body)))).toBe("unconfigured");
    expect(refusal(() => new PolarWebhook(secret).verify(body, new Headers()))).toBe("missing_headers");
    expect(refusal(() => new PolarWebhook(secret).verify(body, signed(body, { signature: "v1,bad" })))).toBe("bad_signature");
    expect(refusal(() => new PolarWebhook(secret).verify(body, signed(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 })))).toBe("bad_signature");
    // Standard Webhooks parses the body as it checks the signature, so one that isn't JSON fails there, as it always has.
    expect(refusal(() => new PolarWebhook(secret).verify("not json", signed("not json")))).toBe("bad_signature");
    for (const invalid of ["[]", JSON.stringify({ type: "", data: {} }), JSON.stringify({ type: "order.paid" }), JSON.stringify({ type: "order.paid", data: [] }), JSON.stringify({ type: "order.paid", data: {}, timestamp: "yesterday" })]) {
      expect(refusal(() => new PolarWebhook(secret).verify(invalid, signed(invalid)))).toBe("invalid_payload");
    }
  });

  it("says what each event is about from its name", () => {
    expect(["subscription.updated", "order.refunded", "refund.created", "checkout.created", "customer.updated", "benefit_grant.created"].map(polarEventKind)).toEqual(["subscription", "payment", "refund", "checkout", "other", "other"]);
  });
});
