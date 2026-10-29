import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordGreeting: vi.fn(async (..._args: unknown[]) => ({ audio: "UklGRg==", tries: 1 })),
  getCachedBusinessSnapshot: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown> | null> => null),
}));

vi.mock("@lobbystack/agent-core", () => ({
  GREETING_RECORDING_TTL_SECONDS: 604_800,
  LIVE_VOICE: "marin",
  greetingRecordingKey: (greeting: string, voice: string) => `recording:${voice}:${greeting}`,
  recordingMs: () => 2_400,
  recordGreeting: mocks.recordGreeting,
}));

vi.mock("@lobbystack/domain", () => ({ getCachedBusinessSnapshot: mocks.getCachedBusinessSnapshot }));

import { createGreetingRecordings, keepOpeningRecorded } from "./greetingRecordings";

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

// The business whose calls open with the greeting: the recording session has its instructions.
const business = { greeting: "Thanks for calling.", defaultLocale: "en", recordingNotice: false, contactChannels: { phoneNumber: "+15551234567" } } as never;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.recordGreeting.mockClear();
  mocks.getCachedBusinessSnapshot.mockReset();
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

  it("records a greeting once, in the voice calls speak with and the business's session, even when calls overlap", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const redis = store();
    const client = {} as never;
    const recordings = createGreetingRecordings({ store: redis, client });
    await Promise.all([recordings.record("Thanks for calling.", business), recordings.record("Thanks for calling.", business)]);
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
    expect(mocks.recordGreeting).toHaveBeenCalledWith(client, { greeting: "Thanks for calling.", voice: "marin", snapshot: business }, { signal: expect.any(AbortSignal) });
    expect(redis.set).toHaveBeenCalledWith("recording:marin:Thanks for calling.", "UklGRg==", "EX", 604_800);
    expect(logLines(info)).toEqual([expect.objectContaining({ message: "live.greeting_recorded", recordingMs: 2_400, renderMs: expect.any(Number), tries: 1 })]);
    // Another worker recorded it already.
    await recordings.record("Thanks for calling.", business);
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
  });

  // Each failure was three GPT-Live sessions.
  it("logs a recording that fails without failing the call, and doesn't try that opening again for 6 hours", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.recordGreeting.mockRejectedValueOnce(new Error("GPT-Live didn't record the opening in 3 tries."));
    const redis = store();
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    await expect(recordings.record("Thanks for calling.", business)).resolves.toBeUndefined();
    expect(redis.set.mock.calls).toEqual([["recording:marin:Thanks for calling.:failed", "1", "EX", 21_600]]);
    expect(logLines(warn)).toEqual([expect.objectContaining({ message: "live.greeting_recording_failed", error: expect.stringContaining("in 3 tries") })]);
    await recordings.record("Thanks for calling.", business);
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
    // A changed opening is a new one.
    await recordings.record("Thanks for calling Ace Plumbing.", business);
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(2);
  });

  it("keeps a recording another week, and records one that's gone", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const redis = store({ "recording:marin:Thanks for calling.": "UklGRg==" });
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    await recordings.keep("Thanks for calling.", business);
    expect(redis.expire).toHaveBeenCalledWith("recording:marin:Thanks for calling.", 604_800);
    expect(mocks.recordGreeting).not.toHaveBeenCalled();
    await recordings.keep("Hello there.", business);
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith("recording:marin:Hello there.", "UklGRg==", "EX", 604_800);
  });

  it("keeps the opening of a business with a phone number recorded", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const redis = store();
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    const domain = { db: {} as never };
    const business = { greeting: "Thanks for calling.", defaultLocale: "en", recordingNotice: false, contactChannels: { phoneNumber: "+15551234567" } };
    mocks.getCachedBusinessSnapshot.mockResolvedValueOnce(business);
    await expect(keepOpeningRecorded(recordings, domain, "business_1")).resolves.toBe(true);
    expect(mocks.getCachedBusinessSnapshot).toHaveBeenCalledWith(domain, { businessId: "business_1" });
    expect(redis.keys.get("recording:marin:Thanks for calling.")).toBe("UklGRg==");
    expect(mocks.recordGreeting).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ snapshot: business }), expect.anything());
    // A business without a phone number only has browser calls, which record their opening as they end.
    mocks.getCachedBusinessSnapshot.mockResolvedValueOnce({ ...business, contactChannels: {} });
    await expect(keepOpeningRecorded(recordings, domain, "business_2")).resolves.toBe(false);
    mocks.getCachedBusinessSnapshot.mockResolvedValueOnce({ ...business, greeting: " " });
    await expect(keepOpeningRecorded(recordings, domain, "business_3")).resolves.toBe(false);
    mocks.getCachedBusinessSnapshot.mockResolvedValueOnce(null);
    await expect(keepOpeningRecorded(recordings, domain, "business_4")).resolves.toBe(false);
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
  });
});
