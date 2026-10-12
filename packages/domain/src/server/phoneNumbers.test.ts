import { describe, expect, it, vi } from "vitest";

import { offerBusinessNumbers, readNumberOffer, type NumberClaimPurpose } from "./phoneNumbers";

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
    expect(() => readNumberOffer(first!.claimToken, "another-secret")).toThrow("Invalid number claim token.");
    const [payload, signature] = first!.claimToken.split(".");
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")), businessId: "biz_2" })).toString("base64url");
    expect(() => readNumberOffer(`${changed}.${signature}`, secret)).toThrow("Invalid number claim token.");
    const later = vi.spyOn(Date, "now").mockReturnValue(first!.expiresAt.getTime() + 1);
    try {
      expect(() => readNumberOffer(first!.claimToken, secret)).toThrow("Number claim token has expired or is invalid.");
    } finally {
      later.mockRestore();
    }
  });
});
