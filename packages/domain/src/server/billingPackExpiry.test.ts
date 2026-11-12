import { describe, expect, it } from "vitest";

import { packBalance } from "./billingPacks";
import { packRemindersDue, type NoticedLivePack } from "./billingPackExpiry";

// When the owners hear about their packs: 30 and 7 days before a pack ends,
// at a fifth of the live balance left and at none, each once a pack. The
// database side is in billingPackExpiry.integration.test.ts.

const day = 86_400_000;
const now = new Date("2026-11-09T12:00:00.000Z");
const at = (offsetDays: number) => new Date(now.getTime() + offsetDays * day);

/** A 90-day pack of 250 minutes bought 60 days ago, so it ends in 30, with nothing used and no reminder sent. */
function pack(overrides: Partial<NoticedLivePack> = {}): NoticedLivePack {
  return { id: "pack", pack: "pack_250_90", secondsTotal: 15_000, secondsUsed: 0, amountCents: 5_500, refundedCents: 0, paidAt: at(-60), endsAt: at(30), smsSeg: 150, smsUsed: 0, callsOut: 60, callsUsed: 0, chatUnits: 150, chatUsed: 0, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1, notices: [], ...overrides };
}

const remindersDue = (live: NoticedLivePack[], when = now) => packRemindersDue({ live, balance: packBalance(live), now: when });

describe("prepaid pack reminders", () => {
  it("come 30 days before a pack ends, then 7 days before, once each", () => {
    expect(remindersDue([pack()], at(-1))).toEqual([]);
    expect(remindersDue([pack()])).toEqual([{ packId: "pack", reminder: "ends_30", record: ["ends_30"] }]);
    expect(remindersDue([pack({ notices: ["ends_30"] })], at(22))).toEqual([]);
    expect(remindersDue([pack({ notices: ["ends_30"] })], at(23))).toEqual([{ packId: "pack", reminder: "ends_7", record: ["ends_7"] }]);
    expect(remindersDue([pack({ notices: ["ends_30", "ends_7"] })], at(29))).toEqual([]);
  });

  it("send only the week's reminder when a run finds both due, as after missed days, and record both", () => {
    expect(remindersDue([pack({ endsAt: at(5) })])).toEqual([{ packId: "pack", reminder: "ends_7", record: ["ends_30", "ends_7"] }]);
    // The month's reminder never follows the week's.
    expect(remindersDue([pack({ endsAt: at(20), notices: ["ends_7"] })])).toEqual([]);
  });

  it("skip a reminder that would fall before the purchase, so a 20-day pack only hears a week before its end", () => {
    const short = pack({ paidAt: now, endsAt: at(20) });
    expect(remindersDue([short])).toEqual([]);
    expect(remindersDue([short], at(12))).toEqual([]);
    expect(remindersDue([short], at(13))).toEqual([{ packId: "pack", reminder: "ends_7", record: ["ends_7"] }]);
    // A 7-day pack would warn as it is bought, so it never does, nor does a 30-day one a month ahead.
    expect(remindersDue([pack({ paidAt: now, endsAt: at(7) })], at(1))).toEqual([]);
    expect(remindersDue([pack({ paidAt: now, endsAt: at(30) })], at(1))).toEqual([]);
  });

  it("never come about the end of a pack that never ends", () => {
    expect(remindersDue([pack({ paidAt: at(-400), endsAt: null })])).toEqual([]);
  });

  it("come at a fifth of the whole live balance left, then at none, recorded on the newest pack", () => {
    const older = pack({ id: "older", paidAt: at(-20), endsAt: at(160), secondsUsed: 15_000 });
    const newer = (overrides: Partial<NoticedLivePack> = {}) => pack({ id: "newer", paidAt: at(-5), endsAt: at(175), ...overrides });
    // 6,001 of 30,000 seconds left is more than a fifth; 6,000 is a fifth.
    expect(remindersDue([older, newer({ secondsUsed: 8_999 })])).toEqual([]);
    expect(remindersDue([older, newer({ secondsUsed: 9_000 })])).toEqual([{ packId: "newer", reminder: "low", record: ["low"] }]);
    expect(remindersDue([older, newer({ secondsUsed: 12_000, notices: ["low"] })])).toEqual([]);
    expect(remindersDue([older, newer({ secondsUsed: 15_000, notices: ["low"] })])).toEqual([{ packId: "newer", reminder: "empty", record: ["empty"] }]);
    expect(remindersDue([older, newer({ secondsUsed: 15_000, notices: ["low", "empty"] })])).toEqual([]);
  });

  it("send only the empty reminder when the balance went from above a fifth to none, and record the low one with it", () => {
    expect(remindersDue([pack({ paidAt: at(-5), endsAt: at(175), secondsUsed: 15_000 })])).toEqual([{ packId: "pack", reminder: "empty", record: ["low", "empty"] }]);
    // Seconds a call gave back lift the balance off none, which reminds of nothing new.
    expect(remindersDue([pack({ paidAt: at(-5), endsAt: at(175), secondsUsed: 14_000, notices: ["low", "empty"] })])).toEqual([]);
  });

  it("come again once another pack is bought, since it becomes the newest", () => {
    const reminded = pack({ id: "first", paidAt: at(-20), endsAt: at(160), secondsUsed: 15_000, notices: ["low", "empty"] });
    // A new pack lifts the balance above a fifth: nothing yet.
    expect(remindersDue([reminded, pack({ id: "second", paidAt: at(-1), endsAt: at(179) })])).toEqual([]);
    expect(remindersDue([reminded, pack({ id: "second", paidAt: at(-1), endsAt: at(179), secondsUsed: 12_000 })])).toEqual([{ packId: "second", reminder: "low", record: ["low"] }]);
    expect(remindersDue([reminded, pack({ id: "second", paidAt: at(-1), endsAt: at(179), secondsUsed: 15_000 })])).toEqual([{ packId: "second", reminder: "empty", record: ["low", "empty"] }]);
  });

  it("come for a pack's end and the balance on the same run, each recorded on its own pack", () => {
    const ending = pack({ id: "ending", paidAt: at(-85), endsAt: at(5), secondsUsed: 15_000, notices: ["ends_30"] });
    const newest = pack({ id: "newest", paidAt: at(-2), endsAt: at(88), secondsUsed: 13_000 });
    expect(remindersDue([ending, newest])).toEqual([
      { packId: "ending", reminder: "ends_7", record: ["ends_7"] },
      { packId: "newest", reminder: "low", record: ["low"] },
    ]);
  });

  it("are none without a live pack", () => {
    expect(packRemindersDue({ live: [], balance: null, now })).toEqual([]);
  });
});
