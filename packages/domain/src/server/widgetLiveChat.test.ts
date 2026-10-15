import { describe, expect, it } from "vitest";

import { TEAM_CHAT_QUIET_MS, teamChatWentQuiet } from "./widgetLiveChat";

const tookOver = new Date("2026-10-15T12:00:00.000Z");
const after = (ms: number) => new Date(tookOver.getTime() + ms);

describe("teamChatWentQuiet", () => {
  it("gives the team the quiet spell from when they took the chat", () => {
    const chat = { teamRequestedAt: null, automationPausedAt: tookOver, lastTeamMessageAt: null };
    expect(teamChatWentQuiet(chat, after(TEAM_CHAT_QUIET_MS - 1))).toBe(false);
    expect(teamChatWentQuiet(chat, after(TEAM_CHAT_QUIET_MS))).toBe(true);
  });

  it("starts the quiet spell again with each message from the team", () => {
    const chat = { teamRequestedAt: null, automationPausedAt: tookOver, lastTeamMessageAt: after(30 * 60_000) };
    expect(teamChatWentQuiet(chat, after(30 * 60_000 + TEAM_CHAT_QUIET_MS - 1))).toBe(false);
    expect(teamChatWentQuiet(chat, after(30 * 60_000 + TEAM_CHAT_QUIET_MS))).toBe(true);
  });

  it("never applies while a visitor waits for someone to join", () => {
    expect(teamChatWentQuiet({ teamRequestedAt: tookOver, automationPausedAt: tookOver, lastTeamMessageAt: null }, after(24 * 60 * 60_000))).toBe(false);
  });

  it("treats a chat with no record of the team as quiet", () => {
    expect(teamChatWentQuiet({ teamRequestedAt: null, automationPausedAt: null, lastTeamMessageAt: null }, tookOver)).toBe(true);
  });
});
