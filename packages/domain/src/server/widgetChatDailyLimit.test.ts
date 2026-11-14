import { describe, expect, it } from "vitest";

import { billingPlanCatalog } from "@lobbystack/shared";

import { WIDGET_CHAT_DAILY_MINIMUM, widgetChatDailyLimit } from "./billing";

// AUDIT-004: how many website chats the receptionist may start in a UTC day.
describe("the website chat's daily limit", () => {
  it("is the day's share of the month's chats, rounded up", () => {
    expect(widgetChatDailyLimit(200, 25)).toBe(50);
    expect(widgetChatDailyLimit(50, 25)).toBe(13);
    expect(widgetChatDailyLimit(1_000, 3)).toBe(30);
  });

  it("is never under ten, so an owner trying the chat on a small plan never meets it", () => {
    expect(WIDGET_CHAT_DAILY_MINIMUM).toBe(10);
    expect(widgetChatDailyLimit(5, 25)).toBe(10);
    expect(widgetChatDailyLimit(0, 25)).toBe(10);
  });

  it("follows each plan's own allowance", () => {
    expect(widgetChatDailyLimit(billingPlanCatalog.starter.chatAiTokensIncluded, 25)).toBe(Math.max(10, Math.ceil(billingPlanCatalog.starter.chatAiTokensIncluded! / 4)));
    expect(widgetChatDailyLimit(billingPlanCatalog.pro.chatAiTokensIncluded, 25)).toBe(Math.max(10, Math.ceil(billingPlanCatalog.pro.chatAiTokensIncluded! / 4)));
  });

  it.each([
    ["an unlimited plan", null, 25],
    ["an allowance it can't read", undefined, 25],
    ["an endless allowance", Number.POSITIVE_INFINITY, 25],
    ["a deployment that turned it off", 200, null],
    ["a share of the whole month", 200, 100],
  ])("has no limit for %s", (_label, allowance, percent) => {
    expect(widgetChatDailyLimit(allowance, percent)).toBeNull();
  });
});
