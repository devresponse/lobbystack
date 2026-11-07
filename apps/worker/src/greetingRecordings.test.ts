import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordGreeting: vi.fn(async (..._args: unknown[]) => ({ audio: "UklGRg==", tries: 1 })),
  getCachedBusinessSnapshot: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown> | null> => null),
}));

vi.mock("@lobbystack/agent-core", () => ({
  GREETING_RECORDING_TTL_SECONDS: 604_800,
  LIVE_VOICE: "marin",
  greetingRecordingKey: (greeting: string, voice: string) => `recording:${voice}:${greeting}`,
  greetingRecordingFailedKey: (key: string) => `${key}:failed`,
  greetingRecordingInProgressKey: (key: string) => `${key}:recording`,
  recordingMs: () => 2_400,
  recordGreeting: mocks.recordGreeting,
}));

vi.mock("@lobbystack/domain", async () => ({
  getCachedBusinessSnapshot: mocks.getCachedBusinessSnapshot,
  snapshotForReceptionist: (await import("../../../packages/domain/src/snapshot")).snapshotForReceptionist,
}));

import { createGreetingRecordings, keepOpeningsRecorded, startOpeningRecording } from "./greetingRecordings";

// A Redis-like store with the slice greeting recordings use.
function store(entries: Record<string, string> = {}) {
  const keys = new Map(Object.entries(entries));
  return {
    keys,
    get: vi.fn(async (key: string) => keys.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _mode: "EX", _seconds: number, condition?: "NX") => {
      if (condition === "NX" && keys.has(key)) return null;
      keys.set(key, value);
      return "OK";
    }),
    expire: vi.fn(async (key: string, _seconds: number) => (keys.has(key) ? 1 : 0)),
    exists: vi.fn(async (key: string) => (keys.has(key) ? 1 : 0)),
    incr: vi.fn(async (key: string) => {
      const next = Number(keys.get(key) ?? 0) + 1;
      keys.set(key, String(next));
      return next;
    }),
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

  // Workers each run a recording sweep as they start, and the dashboard's test call asks too.
  it("marks an opening it records for two minutes, and leaves one another worker marked alone", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const redis = store({ "recording:marin:Hello there.:recording": "1" });
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    await recordings.record("Hello there.", business);
    expect(mocks.recordGreeting).not.toHaveBeenCalled();
    await recordings.record("Thanks for calling.", business);
    expect(redis.set).toHaveBeenCalledWith("recording:marin:Thanks for calling.:recording", "1", "EX", 120, "NX");
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
  });

  // Each failure was three GPT-Live sessions.
  it("records at most 200 new openings a business a day, and logs the ones past that", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const day = new Date().toISOString().slice(0, 10);
    const redis = store({ [`recording-count:business_1:${day}`]: "200" });
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    const owned = { ...(business as object), businessId: "business_1" } as never;
    await recordings.record("Thanks for calling.", owned);
    expect(mocks.recordGreeting).not.toHaveBeenCalled();
    expect(redis.keys.has("recording:marin:Thanks for calling.:recording")).toBe(false);
    expect(redis.expire).toHaveBeenCalledWith(`recording-count:business_1:${day}`, 172_800);
    expect(logLines(info)).toContainEqual(expect.objectContaining({ message: "live.greeting_recording_capped", businessId: "business_1", recordingsToday: 201 }));
    // Another business, and this one the next day, record as before.
    await recordings.record("Thanks for calling.", { ...(business as object), businessId: "business_2" } as never);
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
    expect(redis.keys.get(`recording-count:business_2:${day}`)).toBe("1");
  });

  it("logs a recording that fails without failing the call, and doesn't try that opening again for 30 minutes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.recordGreeting.mockRejectedValueOnce(new Error("GPT-Live didn't record the opening in 3 tries."));
    const redis = store();
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    await expect(recordings.record("Thanks for calling.", business)).resolves.toBeUndefined();
    expect(redis.set.mock.calls).toEqual([["recording:marin:Thanks for calling.:recording", "1", "EX", 120, "NX"], ["recording:marin:Thanks for calling.:failed", "1", "EX", 1_800]]);
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

  it("keeps a business's opening recorded, and only one with a phone number in the daily sweep", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const redis = store();
    const recordings = createGreetingRecordings({ store: redis, client: {} as never });
    const domain = { db: {} as never };
    const business = { greeting: "Thanks for calling.", defaultLocale: "en", recordingNotice: false, contactChannels: { phoneNumber: "+15551234567" } };
    mocks.getCachedBusinessSnapshot.mockResolvedValueOnce(business);
    await expect(keepOpeningsRecorded(recordings, domain, "business_1", { phoneOnly: true })).resolves.toBe(true);
    expect(mocks.getCachedBusinessSnapshot).toHaveBeenCalledWith(domain, { businessId: "business_1" });
    expect(redis.keys.get("recording:marin:Thanks for calling.")).toBe("UklGRg==");
    expect(mocks.recordGreeting).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ snapshot: business }), expect.anything());
    // A business without a phone number has only the dashboard's test calls, which the sweep leaves to the dashboard.
    mocks.getCachedBusinessSnapshot.mockResolvedValueOnce({ ...business, greeting: "Hello.", contactChannels: {} });
    await expect(keepOpeningsRecorded(recordings, domain, "business_2", { phoneOnly: true })).resolves.toBe(false);
    // Its snapshot's refresh records it all the same.
    mocks.getCachedBusinessSnapshot.mockResolvedValueOnce({ ...business, greeting: "Hello.", contactChannels: {} });
    await expect(keepOpeningsRecorded(recordings, domain, "business_2")).resolves.toBe(true);
    expect(redis.keys.get("recording:marin:Hello.")).toBe("UklGRg==");
    mocks.getCachedBusinessSnapshot.mockResolvedValueOnce({ ...business, greeting: " " });
    await expect(keepOpeningsRecorded(recordings, domain, "business_3")).resolves.toBe(false);
    mocks.getCachedBusinessSnapshot.mockResolvedValueOnce(null);
    await expect(keepOpeningsRecorded(recordings, domain, "business_4")).resolves.toBe(false);
    expect(mocks.recordGreeting).toHaveBeenCalledTimes(2);
  });

  describe("with several receptionists", () => {
    const frontDesk = "00000000-0000-4000-8000-0000000000b1";
    const kitsilano = "00000000-0000-4000-8000-0000000000b2";
    const downtown = "00000000-0000-4000-8000-0000000000b3";
    const website = "00000000-0000-4000-8000-0000000000b4";
    const receptionist = (id: string, greeting: string, overrides: Record<string, unknown> = {}) => ({
      id, name: id, description: "", isDefault: false, status: "active", listed: true, order: 1, knowledgeScope: "all", greeting,
      voiceInstructions: "", smsInstructions: "", chatInstructions: "", bookingPolicy: "", bookingMode: "instant", transferPolicy: { mode: "never" }, snippetIds: [],
      ...overrides,
    });
    const chain = {
      ...(business as object),
      receptionists: [
        receptionist(downtown, "Thanks for calling Downtown.", { order: 3 }),
        receptionist(frontDesk, "Thanks for calling.", { isDefault: true, order: 0 }),
        receptionist(kitsilano, "Thanks for calling Kitsilano.", { locale: "fr" }),
        receptionist(website, "Hi, you've reached our website desk.", { order: 2, status: "paused" }),
      ],
    };

    // A receptionist only on the website, like a second one just added, takes browser calls from the test call, its page, widget keys and QR links.
    it("records every active receptionist's opening, the default's first, then the Receptionists page's order", async () => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const redis = store();
      const recordings = createGreetingRecordings({ store: redis, client: {} as never });
      mocks.getCachedBusinessSnapshot.mockResolvedValueOnce(chain);
      await expect(keepOpeningsRecorded(recordings, { db: {} as never }, "business_1")).resolves.toBe(true);
      // A paused receptionist's calls go to the default one.
      expect(mocks.recordGreeting.mock.calls.map(([, input]) => (input as { greeting: string }).greeting)).toEqual(["Thanks for calling.", "Thanks for calling Kitsilano.", "Thanks for calling Downtown."]);
      // Each in its receptionist's own view: Kitsilano's calls open in French.
      expect((mocks.recordGreeting.mock.calls[1]![1] as { snapshot: { defaultLocale: string; receptionist: { id: string } } }).snapshot).toMatchObject({ defaultLocale: "fr", receptionist: { id: kitsilano } });
      expect([...redis.keys.keys()].filter((key) => key.startsWith("recording:") && !key.endsWith(":recording"))).toEqual(["recording:marin:Thanks for calling.", "recording:marin:Thanks for calling Kitsilano.", "recording:marin:Thanks for calling Downtown."]);
    });

    it("records an opening two receptionists share once", async () => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const recordings = createGreetingRecordings({ store: store(), client: {} as never });
      mocks.getCachedBusinessSnapshot.mockResolvedValueOnce({ ...chain, receptionists: chain.receptionists.map((entry) => ({ ...entry, greeting: "Thanks for calling.", locale: undefined })) });
      await expect(keepOpeningsRecorded(recordings, { db: {} as never }, "business_1")).resolves.toBe(true);
      expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
    });

    describe("for the dashboard's test call", () => {
      it("starts recording the chosen receptionist's opening without waiting for it", async () => {
        vi.spyOn(console, "info").mockImplementation(() => undefined);
        let finish: (value: { audio: string; tries: number }) => void = () => undefined;
        mocks.recordGreeting.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        const redis = store();
        const recordings = createGreetingRecordings({ store: redis, client: {} as never });
        const domain = { db: {} as never };
        mocks.getCachedBusinessSnapshot.mockResolvedValueOnce(chain);
        await expect(startOpeningRecording(recordings, domain, { businessId: "business_1", receptionistId: kitsilano })).resolves.toBe(true);
        expect(mocks.getCachedBusinessSnapshot).toHaveBeenCalledWith(domain, { businessId: "business_1" });
        await vi.waitFor(() => expect(mocks.recordGreeting).toHaveBeenCalledTimes(1));
        expect(mocks.recordGreeting).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ greeting: "Thanks for calling Kitsilano.", snapshot: expect.objectContaining({ defaultLocale: "fr", receptionist: expect.objectContaining({ id: kitsilano }) }) }), expect.anything());
        // Marked as under way until it's done.
        expect(redis.keys.has("recording:marin:Thanks for calling Kitsilano.:recording")).toBe(true);
        expect(redis.keys.has("recording:marin:Thanks for calling Kitsilano.")).toBe(false);
        finish({ audio: "UklGRg==", tries: 1 });
        await vi.waitFor(() => expect(redis.keys.get("recording:marin:Thanks for calling Kitsilano.")).toBe("UklGRg=="));
      });

      it("records the default's opening for a paused receptionist or none, and nothing for a business it can't load", async () => {
        vi.spyOn(console, "info").mockImplementation(() => undefined);
        const recordings = createGreetingRecordings({ store: store(), client: {} as never });
        mocks.getCachedBusinessSnapshot.mockResolvedValueOnce(chain);
        await expect(startOpeningRecording(recordings, { db: {} as never }, { businessId: "business_1", receptionistId: website })).resolves.toBe(true);
        await vi.waitFor(() => expect(mocks.recordGreeting).toHaveBeenCalledTimes(1));
        expect(mocks.recordGreeting).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ greeting: "Thanks for calling." }), expect.anything());
        mocks.getCachedBusinessSnapshot.mockResolvedValueOnce(null);
        await expect(startOpeningRecording(recordings, { db: {} as never }, { businessId: "business_2" })).resolves.toBe(false);
        mocks.getCachedBusinessSnapshot.mockResolvedValueOnce({ ...(business as object), greeting: " ", recordingNotice: false });
        await expect(startOpeningRecording(recordings, { db: {} as never }, { businessId: "business_3" })).resolves.toBe(false);
        expect(mocks.recordGreeting).toHaveBeenCalledTimes(1);
      });
    });
  });
});
