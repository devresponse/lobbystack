import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recordGreeting: vi.fn(async (..._args: unknown[]) => "UklGRg==") }));

vi.mock("@lobbystack/agent-core", () => ({
  GREETING_RECORDING_TTL_SECONDS: 604_800,
  LIVE_VOICE: "marin",
  greetingRecordingKey: (greeting: string, voice: string) => `recording:${voice}:${greeting}`,
  recordingMs: () => 2_400,
  recordGreeting: mocks.recordGreeting,
}));

import { createGreetingRecordings } from "./greetingRecordings";

// A Redis-like store with the slice greeting recordings use.
function store(entries: Record<string, string> = {}) {
  const keys = new Map(Object.entries(entries));
  return {
    keys,
    get: vi.fn(async (key: string) => keys.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _mode: "EX", _seconds: number) => { keys.set(key, value); return "OK"; }),
    expire: vi.fn(async (key: string, _seconds: number) => (keys.has(key) ? 1 : 0)),
    exists: vi.fn(async (key: string) => (keys.has(key) ? 1 : 0)),
  };
}

const logLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.recordGreeting.mockClear();
});

describe("greeting recordings", () => {
  it("loads a greeting's recording and keeps it another week", async () => {
    const redis = store({ "recording:marin:Thanks for calling.": "UklGRg==" });
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    await expect(recordings.load("Thanks for calling.")).resolves.toBe("UklGRg==");
    expect(redis.expire).toHaveBeenCalledWith("recording:marin:Thanks for calling.", 604_800);
    await expect(recordings.load("Hello there.")).resolves.toBeUndefined();
  });

  // The recording loads while the caller's browser connects, so a slow Redis can't hold up the greeting.
  it("gives up on a recording Redis doesn't return within a second, or can't read", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const redis = store();
    redis.get.mockReturnValueOnce(new Promise(() => undefined));
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    const slow = recordings.load("Thanks for calling.");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(slow).resolves.toBeUndefined();
    redis.get.mockRejectedValueOnce(new Error("Connection is closed."));
    await expect(recordings.load("Thanks for calling.")).resolves.toBeUndefined();
    expect(logLines(warn)).toEqual([expect.objectContaining({ message: "live.greeting_recording_unread", error: expect.stringContaining("Connection is closed.") })]);
  });

  it("records a greeting once, in the voice calls speak with, even when calls overlap", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const redis = store();
    const client = {} as never;
    const recordings = createGreetingRecordings({ store: redis, client });
    await Promise.all([recordings.record("Thanks for calling."), recordings.record("Thanks for calling.")]);
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
    expect(mocks.recordGreeting).toHaveBeenCalledWith(client, "Thanks for calling.", "marin", { signal: expect.any(AbortSignal) });
    expect(redis.set).toHaveBeenCalledWith("recording:marin:Thanks for calling.", "UklGRg==", "EX", 604_800);
    expect(logLines(info)).toEqual([expect.objectContaining({ message: "live.greeting_recorded", recordingMs: 2_400, renderMs: expect.any(Number) })]);
    // Another worker recorded it already.
    await recordings.record("Thanks for calling.");
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
  });

  it("logs a recording that fails without failing the call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.recordGreeting.mockRejectedValueOnce(new Error("The greeting recording came back silent."));
    const redis = store();
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    await expect(recordings.record("Thanks for calling.")).resolves.toBeUndefined();
    expect(redis.set).not.toHaveBeenCalled();
    expect(logLines(warn)).toEqual([expect.objectContaining({ message: "live.greeting_recording_failed", error: expect.stringContaining("came back silent") })]);
  });
});
