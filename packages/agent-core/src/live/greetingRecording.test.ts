import { afterEach, describe, expect, it, vi } from "vitest";

import { greetingRecordingKey, recordGreeting, recordingMs } from "./greetingRecording";

// 16-bit PCM at 24 kHz, as the speech API returns it: near-silence on each side of a sound.
function speech(options: { quietMs: number; loudMs: number }): Buffer {
  const quiet = new Int16Array(options.quietMs * 24).fill(20);
  const loud = new Int16Array(options.loudMs * 24).map((_, index) => (index % 2 ? 3_000 : -3_000));
  return Buffer.concat([quiet, loud, quiet].map((part) => Buffer.from(part.buffer)));
}

const speechClient = (pcm: Buffer) => ({ audio: { speech: { create: vi.fn(async (..._args: unknown[]) => new Response(new Uint8Array(pcm))) } } });

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

  it("renders the greeting in the voice as 24 kHz PCM and trims the quiet around it to 100 ms", async () => {
    const client = speechClient(speech({ quietMs: 800, loudMs: 1_500 }));
    const audio = await recordGreeting(client as never, "Thanks for calling.", "marin");
    expect(client.audio.speech.create).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4o-mini-tts", voice: "marin", input: "Thanks for calling.", response_format: "pcm" }), undefined);
    expect(recordingMs(audio)).toBe(1_700);
  });

  it("refuses a silent recording, and one longer than the 30 seconds OpenAI plays", async () => {
    await expect(recordGreeting(speechClient(speech({ quietMs: 500, loudMs: 0 })) as never, "Hi.", "marin")).rejects.toThrow("silent");
    await expect(recordGreeting(speechClient(speech({ quietMs: 0, loudMs: 31_000 })) as never, "Hi.", "marin")).rejects.toThrow("30 seconds");
  });
});
