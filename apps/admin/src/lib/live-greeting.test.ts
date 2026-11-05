import { greetingRecordingKey } from "@lobbystack/agent-core/live/greetingRecording";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redis: { exists: vi.fn(async (_key: string) => 1) } as { exists: ReturnType<typeof vi.fn> } | undefined,
  waitForRedis: vi.fn(async (_store: unknown) => undefined),
}));

// The keys Redis has, for greetingRecordingStatus.
function redisWith(...keys: string[]) {
  mocks.redis = { exists: vi.fn(async (key: string) => (keys.includes(key) ? 1 : 0)) };
}

vi.mock("./redis", () => ({ getRedis: () => mocks.redis, waitForRedis: mocks.waitForRedis }));

import { greetingRecordingStatus, recordedGreetingFor } from "./live-greeting";

const snapshot = { greeting: " Thanks for calling Northside Plumbing. ", defaultLocale: "en" as const };
// The greeting, then the notice that the call is with an AI and recorded.
const opening = "Thanks for calling Northside Plumbing. You're speaking with an AI assistant, and this call is recorded and transcribed.";

beforeEach(() => {
  mocks.redis = { exists: vi.fn(async (_key: string) => 1) };
  mocks.waitForRedis.mockReset().mockResolvedValue(undefined);
  // On unless a test turns it off, as in a deployment that never set it.
  vi.stubEnv("LIVE_RECORDED_GREETING", undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("recordedGreetingFor", () => {
  it("plays the opening's recording once the worker has made one", async () => {
    await expect(recordedGreetingFor(snapshot)).resolves.toEqual({ text: opening, play: true });
    expect(mocks.redis!.exists).toHaveBeenCalledWith(greetingRecordingKey(opening, "marin"));
  });

  // Turning the notice off changes the words, so the worker records them anew.
  it("looks for a recording of the greeting alone once the business turns the notice off", async () => {
    await expect(recordedGreetingFor({ ...snapshot, recordingNotice: false })).resolves.toEqual({ text: "Thanks for calling Northside Plumbing.", play: true });
    expect(mocks.redis!.exists).toHaveBeenCalledWith(greetingRecordingKey("Thanks for calling Northside Plumbing.", "marin"));
  });

  // The worker records it during this call, for the next one.
  it("opens the call as before when there's no recording yet, or Redis can't say", async () => {
    mocks.redis!.exists.mockResolvedValueOnce(0);
    await expect(recordedGreetingFor(snapshot)).resolves.toEqual({ text: opening, play: false });
    mocks.redis!.exists.mockRejectedValueOnce(new Error("Connection is closed."));
    await expect(recordedGreetingFor(snapshot)).resolves.toMatchObject({ play: false });
    mocks.waitForRedis.mockRejectedValueOnce(new Error("Redis readiness timed out."));
    await expect(recordedGreetingFor(snapshot)).resolves.toMatchObject({ play: false });
  });

  // A phone caller hears it ring while the admin checks.
  it("opens the call as before when Redis doesn't answer within a second", async () => {
    vi.useFakeTimers();
    mocks.redis!.exists.mockReturnValueOnce(new Promise(() => undefined));
    const checking = recordedGreetingFor(snapshot, { phone: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(checking).resolves.toEqual({ text: opening, play: false });
  });

  // Phone calls follow LIVE_RECORDED_GREETING, and their own switch turns off only them.
  it("opens phone calls with the recording too, unless LIVE_RECORDED_GREETING_PHONE is false", async () => {
    await expect(recordedGreetingFor(snapshot, { phone: true })).resolves.toEqual({ text: opening, play: true });
    vi.stubEnv("LIVE_RECORDED_GREETING_PHONE", "false");
    await expect(recordedGreetingFor(snapshot, { phone: true })).resolves.toBeUndefined();
    await expect(recordedGreetingFor(snapshot)).resolves.toEqual({ text: opening, play: true });
    vi.stubEnv("LIVE_RECORDED_GREETING_PHONE", "true");
    vi.stubEnv("LIVE_RECORDED_GREETING", "false");
    await expect(recordedGreetingFor(snapshot, { phone: true })).resolves.toBeUndefined();
  });

  // A deployment that never set it, as the Railway template and the setup script leave it, opens calls with the recording.
  it("opens calls with the recording unless LIVE_RECORDED_GREETING is false", async () => {
    await expect(recordedGreetingFor(snapshot)).resolves.toEqual({ text: opening, play: true });
    vi.stubEnv("LIVE_RECORDED_GREETING", "true");
    await expect(recordedGreetingFor(snapshot)).resolves.toEqual({ text: opening, play: true });
    vi.stubEnv("LIVE_RECORDED_GREETING", "false");
    await expect(recordedGreetingFor(snapshot)).resolves.toBeUndefined();
  });

  it("does nothing when the call opens with nothing to say or Redis isn't set up", async () => {
    await expect(recordedGreetingFor({ greeting: " ", defaultLocale: "en", recordingNotice: false })).resolves.toBeUndefined();
    mocks.redis = undefined;
    await expect(recordedGreetingFor(snapshot)).resolves.toBeUndefined();
  });
});

describe("greetingRecordingStatus", () => {
  const key = greetingRecordingKey(opening, "marin");

  it("says whether the opening is recorded, being recorded, failed, or nobody is recording it", async () => {
    redisWith(key);
    await expect(greetingRecordingStatus(snapshot)).resolves.toBe("ready");
    // A recording made, after an earlier failure or while another worker still holds its mark, plays.
    redisWith(key, `${key}:failed`, `${key}:recording`);
    await expect(greetingRecordingStatus(snapshot)).resolves.toBe("ready");
    redisWith(`${key}:recording`);
    await expect(greetingRecordingStatus(snapshot)).resolves.toBe("recording");
    redisWith(`${key}:failed`, `${key}:recording`);
    await expect(greetingRecordingStatus(snapshot)).resolves.toBe("failed");
    redisWith();
    await expect(greetingRecordingStatus(snapshot)).resolves.toBe("missing");
    // Each receptionist's opening is its own.
    redisWith(key);
    await expect(greetingRecordingStatus({ ...snapshot, greeting: "Thanks for calling Northside Plumbing downtown." })).resolves.toBe("missing");
  });

  // The test call then starts at once, as it would without a recording.
  it("is off when no recording would play", async () => {
    vi.stubEnv("LIVE_RECORDED_GREETING", "false");
    await expect(greetingRecordingStatus(snapshot)).resolves.toBe("off");
    vi.stubEnv("LIVE_RECORDED_GREETING", undefined);
    await expect(greetingRecordingStatus({ greeting: " ", defaultLocale: "en", recordingNotice: false })).resolves.toBe("off");
    mocks.waitForRedis.mockRejectedValueOnce(new Error("Redis readiness timed out."));
    await expect(greetingRecordingStatus(snapshot)).resolves.toBe("off");
    mocks.redis = undefined;
    await expect(greetingRecordingStatus(snapshot)).resolves.toBe("off");
  });

  it("is off when Redis doesn't answer within a second", async () => {
    vi.useFakeTimers();
    mocks.redis = { exists: vi.fn(() => new Promise(() => undefined)) };
    const checking = greetingRecordingStatus(snapshot);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(checking).resolves.toBe("off");
  });
});
