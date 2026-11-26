import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/billing/top-ups with the domain stubbed: what it answers for a
// top-up code, how it refuses one, and that each try counts against the promo
// code limits before the code is read.

type Callback = (input: { session: { user: { id: string } }; businessId: string; tx: unknown }) => Promise<unknown>;
const fixture = vi.hoisted(() => ({
  redeem: vi.fn(),
  limit: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/api-helpers", () => ({
  asApiResponse: (error: unknown) => error instanceof Response ? error : Response.json({ error: (error as Error).message, code: (error as { code?: string }).code }, { status: (error as { status?: number }).status ?? 500 }),
  readJson: async (request: Request) => await request.json() as unknown,
  withOperatorTransaction: fixture.transaction,
}));
vi.mock("@lobbystack/domain", () => ({
  redeemTopUpCodeInTransaction: fixture.redeem,
  // As the domain's own: every way a code fails reads as invalid, and an added one as used.
  topUpCodeRefusalError: (refusal: "invalid" | "used") => Object.assign(new Error(refusal === "used" ? "This code was already added." : "This code isn't valid."), refusal === "used" ? { status: 409, code: "promo_used" } : { status: 400, code: "promo_invalid" }),
}));
vi.mock("@/lib/promo-code-limit", () => ({
  checkPromoCodeLimit: fixture.limit,
  promoCodeLimitResponse: (status: number) => NextResponse.json({ error: "Too many promo codes tried. Try again later.", code: "promo_rate_limited" }, { status }),
}));
vi.mock("@/lib/trusted-client-ip", () => ({ trustedClientIp: () => "203.0.113.7" }));

import { POST } from "./route";

const post = async (body: unknown) => await POST(new Request("http://localhost:3000/api/billing/top-ups", { method: "POST", body: JSON.stringify(body) }));
const topUp = { id: "top-up", source: "code", code: "SPRING-30", note: null, gives: { voiceSeconds: 1_800, alertSmsSegments: 0, outboundCallAttempts: 0, chatAiUnits: 0 }, used: { voiceSeconds: 0, alertSmsSegments: 0, outboundCallAttempts: 0, chatAiUnits: 0 }, status: "active", startsAt: "2026-11-26T00:00:00.000Z", endsAt: "2026-12-26T00:00:00.000Z", createdAt: "2026-11-26T00:00:00.000Z", revokedAt: null };

beforeEach(() => {
  fixture.transaction.mockImplementation(async (_request: Request, callback: Callback) => await callback({ session: { user: { id: "user" } }, businessId: "business", tx: {} }));
  fixture.limit.mockResolvedValue({ allowed: true });
  fixture.redeem.mockResolvedValue({ topUp });
});
afterEach(() => { vi.clearAllMocks(); });

describe("adding a top-up code from the dashboard", () => {
  it("adds the code's top-up for the person and business in the transaction, for owners and admins only", async () => {
    const response = await post({ businessId: "business", code: "spring-30" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ topUp });
    expect(fixture.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Request), expect.any(Function), { minimumRole: "business_admin" });
    expect(fixture.redeem).toHaveBeenCalledExactlyOnceWith({}, { businessId: "business", userId: "user", code: "spring-30" });
  });

  it("counts each try against the promo code limits, and reads no code once they refuse", async () => {
    await post({ businessId: "business", code: "SPRING-30" });
    expect(fixture.limit).toHaveBeenCalledExactlyOnceWith({ businessId: "business", userId: "user", ip: "203.0.113.7" });
    fixture.redeem.mockClear();
    fixture.limit.mockResolvedValueOnce({ allowed: false, status: 429 });
    const limited = await post({ businessId: "business", code: "SPRING-30" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "promo_rate_limited" });
    expect(fixture.redeem).not.toHaveBeenCalled();
  });

  it("answers a code that doesn't work with 400 promo_invalid and one already added with 409 promo_used", async () => {
    fixture.redeem.mockResolvedValueOnce({ refusal: "invalid" });
    const invalid = await post({ businessId: "business", code: "NOPE" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "This code isn't valid.", code: "promo_invalid" });
    fixture.redeem.mockResolvedValueOnce({ refusal: "used" });
    const used = await post({ businessId: "business", code: "SPRING-30" });
    expect(used.status).toBe(409);
    expect(await used.json()).toEqual({ error: "This code was already added.", code: "promo_used" });
  });

  it("refuses an empty or missing code as invalid without opening a transaction", async () => {
    for (const body of [{ businessId: "business", code: "  " }, { businessId: "business" }, { businessId: "business", code: 30 }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "promo_invalid" });
    }
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.limit).not.toHaveBeenCalled();
  });
});
