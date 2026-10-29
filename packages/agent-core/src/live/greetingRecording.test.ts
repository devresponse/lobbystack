import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { greetingRecordingKey, recordingMs } from "./greetingRecording";

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

  it("plays 16-bit PCM at 24 kHz for as long as its samples last", () => {
    expect(recordingMs(Buffer.alloc(24 * 1_700 * 2).toString("base64"))).toBe(1_700);
  });
});
