import { describe, expect, it, vi } from "vitest";

import type { Database } from "@lobbystack/db";

import { offerBusinessNumbers, readNumberOffer, reserveOnboardingNumberClaim, type NumberClaimPurpose } from "./phoneNumbers";

const secret = "number-claim-test-secret";
const provider = {
  listAvailablePhoneNumbers: vi.fn(async () => [
    { phoneE164: "+14165550123", locality: "Toronto", region: "ON", countryCode: "CA", capabilities: { sms: true, voice: true } },
    { phoneE164: "+14165550123", countryCode: "CA", capabilities: { sms: true, voice: true } },
    { phoneE164: "+14165550124", countryCode: "CA", capabilities: { sms: false, voice: true } },
  ]),
};

async function offer(purpose: NumberClaimPurpose = "onboarding") {
  return await offerBusinessNumbers({ businessId: "biz_1", userId: "user_1", purpose, market: { countryCode: "CA", source: "selection" }, selection: { kind: "toll_free", areaCode: "(416)" }, limit: 5, claimTokenSecret: secret }, provider);
}

describe("number offers", () => {
  it("offers each number that takes calls and texts once, signed for one person and business", async () => {
    const offers = await offer();
    expect(provider.listAvailablePhoneNumbers).toHaveBeenCalledWith({ countryCode: "CA", kind: "toll_free", areaCode: "416", limit: 5 });
    expect(offers).toEqual([expect.objectContaining({ phoneE164: "+14165550123", locality: "Toronto", kind: "toll_free", claimToken: expect.any(String), expiresAt: expect.any(Date) })]);
    expect(readNumberOffer(offers[0]!.claimToken, secret)).toMatchObject({ purpose: "onboarding", businessId: "biz_1", userId: "user_1", e164: "+14165550123", kind: "toll_free", exp: offers[0]!.expiresAt.getTime() });
  });

  it("refuses an offer signed with another secret, changed after signing, or expired", async () => {
    const [first] = await offer("replacement");
    expect(readNumberOffer(first!.claimToken, secret).purpose).toBe("replacement");
    expect(thrown(() => readNumberOffer(first!.claimToken, "another-secret"))).toMatchObject({ message: "Invalid number claim token.", status: 400, code: "number_offer_invalid" });
    const [payload, signature] = first!.claimToken.split(".");
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")), businessId: "biz_2" })).toString("base64url");
    expect(thrown(() => readNumberOffer(`${changed}.${signature}`, secret))).toMatchObject({ status: 400, code: "number_offer_invalid" });
    const later = vi.spyOn(Date, "now").mockReturnValue(first!.expiresAt.getTime() + 1);
    try {
      // A list left open past five minutes: the dashboard asks for a new search.
      expect(thrown(() => readNumberOffer(first!.claimToken, secret))).toMatchObject({ status: 400, code: "number_offer_expired" });
    } finally {
      later.mockRestore();
    }
  });
});

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a throw.");
}

// The claim function's refusal, wrapped as Drizzle wraps it, with the query parameters in the message.
function refusingDatabase(raised: string): Database {
  const refusal = Object.assign(new Error(raised), { code: "P0001" });
  return { transaction: async () => { throw new Error("Failed query: SELECT app.reserve_onboarding_number_claim($1, $2)\nparams: biz_1,+14165550123", { cause: refusal }); } } as unknown as Database;
}

describe("number claims", () => {
  it.each([
    ["number_claim_in_progress", 409, "number_claim_in_progress"],
    ["number_claim_rate_limited", 429, "number_claim_rate_limited"],
    ["daily_claim_quota_reached", 429, "daily_claim_quota_reached"],
    ["monthly_claim_quota_reached", 429, "monthly_claim_quota_reached"],
    ["business_number_exists", 409, "business_number_exists"],
    ["dedicated_number_requires_paid_plan", 409, "paid_plan_required"],
  ])("answers %s with its own status and code instead of a server failure", async (raised, status, code) => {
    const [first] = await offer();
    const refused = reserveOnboardingNumberClaim({ db: refusingDatabase(raised) }, { userId: "user_1", businessId: "biz_1", claimToken: first!.claimToken, claimTokenSecret: secret, idempotencyKey: "claim-1" });
    await expect(refused).rejects.toMatchObject({ status, code, cause: { message: raised } });
    await expect(refused).rejects.not.toMatchObject({ message: expect.stringContaining("params") });
  });

  it("keeps an error the claim function didn't raise as it is", async () => {
    const failure = new Error("Connection terminated unexpectedly");
    const [first] = await offer();
    await expect(reserveOnboardingNumberClaim({ db: { transaction: async () => { throw failure; } } as unknown as Database }, { userId: "user_1", businessId: "biz_1", claimToken: first!.claimToken, claimTokenSecret: secret, idempotencyKey: "claim-1" })).rejects.toBe(failure);
  });

  it("refuses an offer made for a replacement or another person", async () => {
    const [replacement] = await offer("replacement");
    await expect(reserveOnboardingNumberClaim({ db: refusingDatabase("unused") }, { userId: "user_1", businessId: "biz_1", claimToken: replacement!.claimToken, claimTokenSecret: secret, idempotencyKey: "claim-1" })).rejects.toMatchObject({ status: 400, code: "number_offer_mismatch" });
    const [first] = await offer();
    await expect(reserveOnboardingNumberClaim({ db: refusingDatabase("unused") }, { userId: "user_2", businessId: "biz_1", claimToken: first!.claimToken, claimTokenSecret: secret, idempotencyKey: "claim-1" })).rejects.toMatchObject({ status: 400, code: "number_offer_mismatch" });
  });
});
