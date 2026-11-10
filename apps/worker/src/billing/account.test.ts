import { StripeBilling } from "@lobbystack/providers/stripe/adapter";
import { createFakeStripe } from "@lobbystack/providers/stripe/fake";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkedBilling } from "./account";
import { polarFake } from "./polarFake";

// The worker's startup check of a Stripe deployment's key (the Stripe plan's step 13).

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the startup check of the billing account", () => {
  it("keeps billing whose key is STRIPE_ACCOUNT_ID's, and Polar's, which has no check", async () => {
    const billing = new StripeBilling(createFakeStripe({ accountId: "acct_1" }), { accountId: "acct_1", env: "sandbox" });
    const capture = vi.fn();
    await expect(checkedBilling(billing, { capture })).resolves.toBe(billing);
    const polar = polarFake({});
    await expect(checkedBilling(polar, { capture })).resolves.toBe(polar);
    await expect(checkedBilling(undefined, { capture })).resolves.toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it("runs without billing on another account's key, and tells the operator", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const capture = vi.fn(async () => undefined);
    const billing = new StripeBilling(createFakeStripe({ accountId: "acct_other" }), { accountId: "acct_1", env: "sandbox" });
    await expect(checkedBilling(billing, { capture })).resolves.toBeUndefined();
    const properties = { provider: "stripe", providerEnv: "sandbox", expectedAccount: "acct_1", foundAccount: "acct_other" };
    expect(capture).toHaveBeenCalledWith([{ event: "ops.billing.provider_mismatch", distinctId: "system:deployment", properties, timestamp: expect.any(String) }]);
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ message: "ops.billing.provider_mismatch", ...properties }));
  });

  it("bills on when Stripe can't be reached", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stripe = createFakeStripe({ accountId: "acct_1" });
    vi.spyOn(stripe.accounts, "retrieveCurrent").mockRejectedValue(new Error("connect ETIMEDOUT"));
    const billing = new StripeBilling(stripe, { accountId: "acct_1", env: "sandbox" });
    await expect(checkedBilling(billing, undefined)).resolves.toBe(billing);
    expect(warnings.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ message: "ops.billing.account_unchecked", provider: "stripe" }));
  });
});
