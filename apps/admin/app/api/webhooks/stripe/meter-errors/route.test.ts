import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";

import { POST } from "./route";

// Stripe's meter error destination (the Stripe plan's step 12): thin events
// signed with their own secret, logged for the operator.

const secret = "whsec_meter_test";
let warned: MockInstance<typeof console.warn>;
const warnings = () => warned.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

function signed(body: string, key = secret) {
  const at = Math.floor(Date.now() / 1000);
  return new Request("https://app.example.test/api/webhooks/stripe/meter-errors", { method: "POST", body, headers: { "stripe-signature": `t=${at},v1=${createHmac("sha256", key).update(`${at}.${body}`).digest("hex")}` } });
}

const thin = JSON.stringify({ id: "evt_thin_1", object: "v2.core.event", type: "v1.billing.meter.error_report_triggered", created: new Date().toISOString(), livemode: false, related_object: { id: "mtr_1", type: "billing.meter", url: "/v1/billing/meters/mtr_1" } });

beforeEach(() => {
  vi.stubEnv("BILLING_PROVIDER", "stripe");
  vi.stubEnv("STRIPE_API_KEY", "rk_test_admin123");
  vi.stubEnv("STRIPE_METER_WEBHOOK_SECRET", secret);
  warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("logs a meter error Stripe signed with the destination's secret", async () => {
  const response = await POST(signed(thin));
  expect(response.status).toBe(200);
  expect(warnings()).toEqual([expect.objectContaining({ message: "ops.billing.meter_error", provider: "stripe", eventType: "v1.billing.meter.error_report_triggered", eventId: "evt_thin_1", relatedObject: "mtr_1" })]);
});

it("refuses the endpoint's secret, a body that isn't a thin event, and a Polar deployment", async () => {
  expect((await POST(signed(thin, "whsec_endpoint"))).status).toBe(401);
  expect(warnings()).toEqual([expect.objectContaining({ message: "ops.billing.webhook_refused", provider: "stripe", reason: "bad_signature" })]);
  expect((await POST(signed(JSON.stringify({ id: "evt_1" })))).status).toBe(400);
  vi.unstubAllEnvs();
  expect((await POST(signed(thin))).status).toBe(404);
});
