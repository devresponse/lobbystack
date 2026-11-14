import { describe, expect, it } from "vitest";

import { buildWidgetRateLimits, widgetChatDailyPercent } from "./widget-policy";

const keyFor = (operation: "config" | "chat", name: string) =>
  buildWidgetRateLimits({ businessId: "business", widgetKeyId: "key", operation }).find((entry) => entry.name === `${operation}-${name}`)!.key;

describe("widget policy", () => {
  it("gives chat its own per-key counters so widget opens do not spend the chat budget", () => {
    expect(keyFor("chat", "key-minute")).not.toBe(keyFor("config", "key-minute"));
    expect(keyFor("chat", "key-hour")).not.toBe(keyFor("config", "key-hour"));
  });

  it("has no platform-wide counter shared by every business", () => {
    const first = buildWidgetRateLimits({ businessId: "first", widgetKeyId: "key", operation: "chat" }).map((entry) => entry.key);
    const second = buildWidgetRateLimits({ businessId: "second", widgetKeyId: "key", operation: "chat" }).map((entry) => entry.key);
    expect(first.filter((key) => second.includes(key))).toEqual([]);
  });
});

describe("the share of a month's chats one day may start (AUDIT-004)", () => {
  it("is a quarter unless the deployment says otherwise", () => {
    expect(widgetChatDailyPercent({})).toBe(25);
    expect(widgetChatDailyPercent({ WIDGET_CHAT_DAILY_PERCENT: " " })).toBe(25);
  });

  it.each([["1", 1], ["10", 10], [" 50 ", 50], ["99", 99]])("follows WIDGET_CHAT_DAILY_PERCENT=%s", (value, percent) => {
    expect(widgetChatDailyPercent({ WIDGET_CHAT_DAILY_PERCENT: value })).toBe(percent);
  });

  it.each(["100", "250", "off", "OFF", "false"])("turns the daily limit off with %s", (value) => {
    expect(widgetChatDailyPercent({ WIDGET_CHAT_DAILY_PERCENT: value })).toBeNull();
  });

  // A typo keeps the protection rather than dropping it.
  it.each(["0", "-5", "12.5", "lots", "true"])("keeps the default for a value it can't use (%s)", (value) => {
    expect(widgetChatDailyPercent({ WIDGET_CHAT_DAILY_PERCENT: value })).toBe(25);
  });
});

describe("the chat's check", () => {
  it("has its own counters, apart from the chat's and the session's", () => {
    const verify = buildWidgetRateLimits({ businessId: "business", widgetKeyId: "key", visitorId: "visitor", ipHash: "ip", operation: "verify" }).map((entry) => entry.key);
    const chat = buildWidgetRateLimits({ businessId: "business", widgetKeyId: "key", visitorId: "visitor", ipHash: "ip", operation: "chat" }).map((entry) => entry.key);
    const session = buildWidgetRateLimits({ businessId: "business", widgetKeyId: "key", visitorId: "visitor", ipHash: "ip", operation: "session" }).map((entry) => entry.key);
    expect(verify.length).toBeGreaterThan(0);
    expect(verify.filter((key) => chat.includes(key) || session.includes(key))).toEqual([]);
  });
});
