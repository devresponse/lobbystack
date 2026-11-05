import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { greetingRecordingFailedKey, greetingRecordingInProgressKey, greetingRecordingKey, recordedGreetingEnabled, recordingMs } from "./greetingRecording";

afterEach(() => { vi.unstubAllEnvs(); });

describe("greeting recordings", () => {
  // A changed greeting or voice needs a new recording.
  it("keys a recording by the greeting and the voice, under REDIS_PREFIX", () => {
    const key = greetingRecordingKey("Thanks for calling.", "marin");
    expect(key).toMatch(/^lobbystack:live:greeting-recording:[0-9a-f]{64}$/);
    expect(greetingRecordingKey("Thanks for calling.", "marin")).toBe(key);
    expect(greetingRecordingKey("Thanks for calling!", "marin")).not.toBe(key);
    expect(greetingRecordingKey("Thanks for calling.", "cedar")).not.toBe(key);
    vi.stubEnv("REDIS_PREFIX", "staging");
    expect(greetingRecordingKey("Thanks for calling.", "marin")).toBe(key.replace(/^lobbystack:/, "staging:"));
  });

  // So every opening is recorded again by GPT-Live.
  it("doesn't find the recordings OpenAI's speech model made", () => {
    const speechModelKey = createHash("sha256").update(JSON.stringify(["gpt-4o-mini-tts", "Speak warmly and naturally, like a receptionist answering a call.", "marin", "Thanks for calling."])).digest("hex");
    expect(greetingRecordingKey("Thanks for calling.", "marin")).not.toBe(`lobbystack:live:greeting-recording:${speechModelKey}`);
  });

  // Its failures and a recording under way sit next to it, so the admin and every worker find them.
  it("keeps a failed recording's and a recording under way's marks next to its key", () => {
    const key = greetingRecordingKey("Thanks for calling.", "marin");
    expect(greetingRecordingFailedKey(key)).toBe(`${key}:failed`);
    expect(greetingRecordingInProgressKey(key)).toBe(`${key}:recording`);
  });

  // GPT-Live skips the spoken greeting on about one call in three, so calls open with the recording unless it's turned off.
  it("opens calls with the recording unless LIVE_RECORDED_GREETING is false", () => {
    expect(recordedGreetingEnabled({})).toBe(true);
    expect(recordedGreetingEnabled({ LIVE_RECORDED_GREETING: "" })).toBe(true);
    expect(recordedGreetingEnabled({ LIVE_RECORDED_GREETING: "true" })).toBe(true);
    expect(recordedGreetingEnabled({ LIVE_RECORDED_GREETING: "false" })).toBe(false);
    expect(recordedGreetingEnabled({ LIVE_RECORDED_GREETING: " FALSE " })).toBe(false);
    vi.stubEnv("LIVE_RECORDED_GREETING", "false");
    expect(recordedGreetingEnabled()).toBe(false);
  });

  it("plays 16-bit PCM at 24 kHz for as long as its samples last", () => {
    expect(recordingMs(Buffer.alloc(24 * 1_700 * 2).toString("base64"))).toBe(1_700);
  });
});
