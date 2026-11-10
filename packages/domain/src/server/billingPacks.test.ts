import { describe, expect, it } from "vitest";

import { packBalance, packLimits, packSecondsLeft, type LivePack } from "./billingPacks";

// The pack ledger's arithmetic: what live packs add up to and the limits the
// prepaid tier takes from them. The database side is in
// billingPacks.integration.test.ts.

const DAY = 86_400_000;
const now = new Date("2026-11-09T12:00:00Z");

function live(overrides: Partial<LivePack> = {}): LivePack {
  return { id: "pack", pack: "pack_250_90", secondsTotal: 15_000, secondsUsed: 0, amountCents: 5_500, refundedCents: 0, paidAt: now, endsAt: new Date(now.getTime() + 90 * DAY), smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, ...overrides };
}

describe("prepaid pack balances", () => {
  it("has no balance without a live pack, so the business stays on its own tier", () => {
    expect(packBalance([])).toBeNull();
  });

  it("adds up the seconds the live packs hold after refunds, less what calls drew", () => {
    const balance = packBalance([live({ secondsUsed: 1_000 }), live({ id: "half", secondsTotal: 30_000, amountCents: 9_500, refundedCents: 4_750, endsAt: new Date(now.getTime() + 180 * DAY) })]);
    expect(balance).toMatchObject({ secondsTotal: 30_000, secondsUsed: 1_000, secondsLeft: 29_000 });
    expect(balance?.nextEndsAt).toEqual(new Date(now.getTime() + 90 * DAY));
    expect(balance?.lastEndsAt).toEqual(new Date(now.getTime() + 180 * DAY));
  });

  it("counts no seconds left on a pack whose partial refund took off more than calls left", () => {
    expect(packSecondsLeft({ secondsTotal: 15_000, secondsUsed: 10_000, amountCents: 5_500, refundedCents: 2_750 })).toBe(0);
  });

  it("has no last end while a pack that never ends is live", () => {
    expect(packBalance([live(), live({ id: "forever", endsAt: null })])?.lastEndsAt).toBeNull();
    expect(packBalance([live({ endsAt: null })])).toMatchObject({ nextEndsAt: null, lastEndsAt: null });
  });

  it("takes the most any live pack gives for each limit, with no monthly voice allowance and nothing billed past an allowance", () => {
    expect(packLimits([live(), live({ id: "big", smsSeg: 80, kbBytes: 50 * 1_048_576, receptionists: 2 })])).toEqual({
      knowledgeStorageBytes: 50 * 1_048_576,
      voiceSecondsIncluded: null,
      alertSmsSegmentsIncluded: 80,
      outboundCallAttemptsIncluded: 20,
      chatAiTokensIncluded: 50,
      includedBusinessNumbers: 1,
      includedReceptionists: 2,
      overagesBillable: false,
      voiceOverageRatePerMinuteCents: null,
      alertSmsOverageRatePerSegmentCents: null,
      outboundCallAttemptOverageRateCents: null,
    });
  });
});
