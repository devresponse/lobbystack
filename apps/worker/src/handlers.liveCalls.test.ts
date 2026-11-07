import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobEnvelope, JobType } from "@lobbystack/contracts";
import { getCachedBusinessSnapshot, LIVE_RECORDING_ATTEMPTS, listBusinessesWithOpenLiveCalls, listOpenLiveCalls, liveCallHasRecording, persistCallRecording, refreshBusinessSnapshot, retryLiveCallRecording, type OpenLiveCall } from "@lobbystack/domain";
import type { BusinessContextSnapshot } from "@lobbystack/shared";

vi.mock("@lobbystack/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lobbystack/domain")>()),
  getCachedBusinessSnapshot: vi.fn(),
  refreshBusinessSnapshot: vi.fn(async () => "version_2"),
  listBusinessesWithOpenLiveCalls: vi.fn(),
  listOpenLiveCalls: vi.fn(),
  liveCallHasRecording: vi.fn(async () => false),
  persistCallRecording: vi.fn(async () => "object_1"),
  retryLiveCallRecording: vi.fn(async () => undefined),
}));

import { handleJob } from "./handlers";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const businessId = randomUUID();
const job = (type: JobType, payload: Record<string, unknown> = {}): JobEnvelope => ({ jobId: randomUUID(), type, queue: "default", businessId, payload, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false });
const notReady = (status: number) => Object.assign(new Error(`${status}`), { status });

describe("call.saveRecording", () => {
  const recordingJob = (attempt: number) => job("call.saveRecording", { callId: "call_1", sessionId: "live_1", durationMs: 90_000, attempt });
  const dependencies = (downloadRecording: ReturnType<typeof vi.fn>) => ({ domain: { db: {} as never }, storage: {} as never, liveSessions: { downloadRecording } as never });

  it("copies the recording once OpenAI has it", async () => {
    const download = vi.fn(async () => new Response(new Uint8Array([82, 73, 70, 70])));
    await expect(handleJob(recordingJob(1), dependencies(download))).resolves.toEqual({ status: "completed", entityId: "call_1" });
    expect(download).toHaveBeenCalledWith("live_1");
    expect(persistCallRecording).toHaveBeenCalledWith(expect.anything(), { businessId, callId: "call_1", durationMs: 90_000, contentType: "audio/wav", body: new Uint8Array([82, 73, 70, 70]) }, expect.anything());
  });

  it("queues another attempt while OpenAI says the recording isn't ready", async () => {
    for (const status of [404, 409]) {
      vi.mocked(retryLiveCallRecording).mockClear();
      await expect(handleJob(recordingJob(2), dependencies(vi.fn(async () => { throw notReady(status); })))).resolves.toEqual({ status: "skipped", entityId: "call_1:retry:3" });
      expect(retryLiveCallRecording).toHaveBeenCalledWith(expect.anything(), { businessId, callId: "call_1", sessionId: "live_1", durationMs: 90_000, attempt: 3 });
    }
    expect(persistCallRecording).not.toHaveBeenCalled();
  });

  it("gives up after the last attempt, or at once on any other error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(handleJob(recordingJob(LIVE_RECORDING_ATTEMPTS), dependencies(vi.fn(async () => { throw notReady(404); })))).resolves.toEqual({ status: "skipped", entityId: "call_1" });
    expect(error).toHaveBeenCalledWith(JSON.stringify({ level: "error", message: "live.recording_never_available", callId: "call_1", sessionId: "live_1", attempt: LIVE_RECORDING_ATTEMPTS }));
    await expect(handleJob(recordingJob(1), dependencies(vi.fn(async () => { throw notReady(401); })))).resolves.toEqual({ status: "skipped", entityId: "call_1" });
    expect(error).toHaveBeenLastCalledWith(JSON.stringify({ level: "error", message: "live.recording_unavailable", callId: "call_1", sessionId: "live_1", status: 401, error: "401" }));
    expect(retryLiveCallRecording).not.toHaveBeenCalled();
    expect(persistCallRecording).not.toHaveBeenCalled();
  });

  it("stops when a repeated job finds the recording already copied", async () => {
    vi.mocked(liveCallHasRecording).mockResolvedValueOnce(true);
    const download = vi.fn();
    await expect(handleJob(recordingJob(1), dependencies(download))).resolves.toEqual({ status: "skipped", entityId: "call_1" });
    expect(download).not.toHaveBeenCalled();
  });
});

describe("live.recoverOrphans", () => {
  const otherBusinessId = randomUUID();
  const open = (sessionId: string, owner = businessId) => ({ businessId: owner, callId: `call_${sessionId}`, sessionId, channel: "voice", intakeOnly: false, startedAt: new Date(Date.now() - 120_000), reservedSeconds: 600, lastActivityAt: new Date(), lastSequence: 0 }) as OpenLiveCall;
  const redis = (status: string) => ({ status }) as never;
  const recoveryJob = (): JobEnvelope => ({ ...job("live.recoverOrphans"), queue: "critical", businessId: null });

  it("hands every open call older than a minute, in every business, to the live call handler", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingBusinessId = randomUUID();
    vi.mocked(listBusinessesWithOpenLiveCalls).mockResolvedValue([businessId, failingBusinessId, otherBusinessId]);
    vi.mocked(listOpenLiveCalls).mockImplementation(async (_context, input) => {
      if (input.businessId === failingBusinessId) throw new Error("connection reset");
      return input.businessId === businessId ? [open("live_a"), open("live_b"), open("live_c")] : [open("live_d", otherBusinessId)];
    });
    const recoverLiveCall = vi.fn(async (call: OpenLiveCall) => {
      if (call.sessionId === "live_b") throw new Error("snapshot missing");
      return call.sessionId === "live_a" || call.sessionId === "live_d" ? "attached" as const : "owned" as const;
    });
    await expect(handleJob(recoveryJob(), { domain: { db: {} as never }, realtime: redis("ready"), recoverLiveCall })).resolves.toEqual({ status: "completed", entityId: "2" });
    // A business whose listing fails doesn't stop the one after it.
    expect(recoverLiveCall.mock.calls.map(([call]) => call.sessionId)).toEqual(["live_a", "live_b", "live_c", "live_d"]);
    expect(vi.mocked(listOpenLiveCalls).mock.calls.map(([, input]) => input.businessId)).toEqual([businessId, failingBusinessId, otherBusinessId]);
    const { startedBefore } = vi.mocked(listBusinessesWithOpenLiveCalls).mock.calls[0]![1];
    expect(Date.now() - startedBefore.getTime()).toBeGreaterThanOrEqual(60_000);
    expect(Date.now() - startedBefore.getTime()).toBeLessThan(65_000);
    expect(vi.mocked(listOpenLiveCalls).mock.calls.every(([, input]) => input.startedBefore === startedBefore)).toBe(true);
    // Each failure is reported with the business or call it belongs to.
    const reports = error.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(reports).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/exception: connection reset$/), operation: "live.list_open_calls", businessId: failingBusinessId, error: "connection reset" }));
    expect(reports).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/exception: snapshot missing$/), operation: "live.recover", businessId, callId: "call_live_b", sessionId: "live_b", error: "snapshot missing" }));
  });

  it("does nothing when GPT-Live is off or Redis is down", async () => {
    const recoverLiveCall = vi.fn();
    await expect(handleJob(recoveryJob(), { domain: { db: {} as never }, realtime: redis("ready"), recoverLiveCall })).resolves.toEqual({ status: "skipped" });
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    await expect(handleJob(recoveryJob(), { domain: { db: {} as never }, realtime: redis("reconnecting"), recoverLiveCall })).resolves.toEqual({ status: "skipped" });
    await expect(handleJob(recoveryJob(), { domain: { db: {} as never }, recoverLiveCall })).resolves.toEqual({ status: "skipped" });
    // A job queued by an old per-business scheduler would run the whole sweep again.
    await expect(handleJob({ ...recoveryJob(), businessId }, { domain: { db: {} as never }, realtime: redis("ready"), recoverLiveCall })).resolves.toEqual({ status: "skipped" });
    expect(listBusinessesWithOpenLiveCalls).not.toHaveBeenCalled();
    expect(recoverLiveCall).not.toHaveBeenCalled();
  });
});

describe("call openings recorded ahead of calls", () => {
  const redis = (status: string) => ({ status }) as never;
  const sweepJob = (): JobEnvelope => ({ ...job("live.recordGreetings"), queue: "maintenance", businessId: null, recurring: true });
  const businessJob = (): JobEnvelope => ({ ...job("live.recordGreetings"), queue: "maintenance" });
  // A business with a phone number, whose calls open with its greeting.
  const phoneBusiness = (greeting: string) => ({ greeting, defaultLocale: "en", recordingNotice: false, contactChannels: { phoneNumber: "+15551234567" } }) as never;
  const recordings = () => ({ load: vi.fn(), record: vi.fn(), keep: vi.fn(async (_greeting: string, _snapshot: BusinessContextSnapshot) => undefined) });
  const receptionist = (id: string, greeting: string, overrides: Record<string, unknown> = {}) => ({
    id, name: id, description: "", isDefault: false, status: "active", listed: true, order: 1, knowledgeScope: "all", greeting,
    voiceInstructions: "", smsInstructions: "", chatInstructions: "", bookingPolicy: "", bookingMode: "instant", transferPolicy: { mode: "never" }, snippetIds: [],
    ...overrides,
  });

  it("keeps the openings of every active business with a phone number recorded, one business at a time", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const [withPhone, browserOnly, dormant, failing, last] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    vi.mocked(getCachedBusinessSnapshot).mockImplementation(async (_context, input) => {
      if (input.businessId === failing) throw new Error("connection reset");
      if (input.businessId === browserOnly) return { greeting: "Hello.", defaultLocale: "en", contactChannels: {} } as never;
      return phoneBusiness(input.businessId === withPhone ? "Thanks for calling." : "Welcome.");
    });
    const greetingRecordings = recordings();
    const listBusinesses = vi.fn(async () => [withPhone, browserOnly, dormant, failing, last].map((id) => ({ id, active: id !== dormant })));
    await expect(handleJob(sweepJob(), { domain: { db: {} as never }, realtime: redis("ready"), greetingRecordings, listBusinesses })).resolves.toEqual({ status: "completed", entityId: "2" });
    // A business without a phone number has only the dashboard's test calls, which ask for their opening.
    expect(greetingRecordings.keep.mock.calls.map(([greeting]) => greeting)).toEqual(["Thanks for calling.", "Welcome."]);
    // A dormant business's next call records its opening, as before.
    expect(vi.mocked(getCachedBusinessSnapshot).mock.calls.map(([, input]) => input.businessId)).toEqual([withPhone, browserOnly, failing, last]);
    // A business that fails to load doesn't stop the ones after it.
    const reports = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(reports).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/warning: connection reset$/), operation: "live.keep_greeting_recording", businessId: failing }));
  });

  // A receptionist only on the website takes browser calls from its page, widget keys and QR links.
  it("keeps every active receptionist's opening in the sweep, not only those that answer a number", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.mocked(getCachedBusinessSnapshot).mockResolvedValue({
      ...(phoneBusiness("Thanks for calling.") as object),
      receptionists: [
        receptionist("downtown", "Thanks for calling Downtown.", { order: 2 }),
        receptionist("front-desk", "Thanks for calling.", { isDefault: true, order: 0 }),
        receptionist("paused", "Thanks for calling the old store.", { status: "paused" }),
        receptionist("website", "Hi, you've reached our website desk."),
      ],
    } as never);
    const greetingRecordings = recordings();
    await expect(handleJob(sweepJob(), { domain: { db: {} as never }, realtime: redis("ready"), greetingRecordings, listBusinesses: vi.fn(async () => [{ id: businessId, active: true }]) })).resolves.toEqual({ status: "completed", entityId: "1" });
    // The default's first, then the Receptionists page's order. A paused one's calls go to the default.
    expect(greetingRecordings.keep.mock.calls.map(([greeting]) => greeting)).toEqual(["Thanks for calling.", "Hi, you've reached our website desk.", "Thanks for calling Downtown."]);
  });

  // The job a snapshot refresh queues: a business without a phone number still has the dashboard's test calls.
  it("keeps every active receptionist's opening for one business, with or without a phone number", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    vi.mocked(getCachedBusinessSnapshot).mockResolvedValue({
      greeting: "Thanks for calling.", defaultLocale: "en", recordingNotice: false, contactChannels: {},
      receptionists: [receptionist("front-desk", "Thanks for calling.", { isDefault: true, order: 0 }), receptionist("second", "Bonjour, ici le deuxième accueil.", { locale: "fr" })],
    } as never);
    const greetingRecordings = recordings();
    const listBusinesses = vi.fn();
    await expect(handleJob(businessJob(), { domain: { db: {} as never }, realtime: redis("ready"), greetingRecordings, listBusinesses })).resolves.toEqual({ status: "completed", entityId: businessId });
    expect(vi.mocked(getCachedBusinessSnapshot)).toHaveBeenCalledWith(expect.anything(), { businessId });
    expect(greetingRecordings.keep.mock.calls.map(([greeting]) => greeting)).toEqual(["Thanks for calling.", "Bonjour, ici le deuxième accueil."]);
    // Each in its receptionist's own view: the second one's calls open in French.
    expect(greetingRecordings.keep.mock.calls[1]![1]).toMatchObject({ defaultLocale: "fr", receptionist: { id: "second" } });
    expect(listBusinesses).not.toHaveBeenCalled();
    // A business whose calls open with nothing to say has nothing to keep.
    vi.mocked(getCachedBusinessSnapshot).mockResolvedValue({ greeting: " ", defaultLocale: "en", recordingNotice: false, contactChannels: {} } as never);
    await expect(handleJob(businessJob(), { domain: { db: {} as never }, realtime: redis("ready"), greetingRecordings })).resolves.toEqual({ status: "skipped", entityId: businessId });
  });

  it("does nothing without recordings ahead, GPT-Live or Redis", async () => {
    const greetingRecordings = recordings();
    const listBusinesses = vi.fn(async () => [{ id: businessId, active: true }]);
    for (const recordJob of [sweepJob(), businessJob()]) {
      vi.unstubAllEnvs();
      await expect(handleJob(recordJob, { domain: { db: {} as never }, realtime: redis("ready"), greetingRecordings, listBusinesses })).resolves.toEqual({ status: "skipped" });
      vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
      await expect(handleJob(recordJob, { domain: { db: {} as never }, realtime: redis("ready"), listBusinesses })).resolves.toEqual({ status: "skipped" });
      await expect(handleJob(recordJob, { domain: { db: {} as never }, realtime: redis("reconnecting"), greetingRecordings, listBusinesses })).resolves.toEqual({ status: "skipped" });
    }
    vi.mocked(getCachedBusinessSnapshot).mockResolvedValue(phoneBusiness("Thanks for calling."));
    await expect(handleJob(sweepJob(), { domain: { db: {} as never }, realtime: redis("ready"), greetingRecordings, listBusinesses: vi.fn(async () => []) })).resolves.toEqual({ status: "skipped", entityId: "0" });
    expect(listBusinesses).not.toHaveBeenCalled();
    expect(greetingRecordings.keep).not.toHaveBeenCalled();
  });

  // Recording each opening takes GPT-Live 10 seconds or more, which the refresh doesn't wait for.
  it("queues the recording of a business's openings once its snapshot is refreshed", async () => {
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const greetingRecordings = recordings();
    const queueOpeningRecordings = vi.fn(async (_input: { businessId: string; version: string }) => undefined);
    const dependencies = { domain: { db: {} as never }, realtime: redis("ready"), greetingRecordings, queueOpeningRecordings };
    await expect(handleJob(job("snapshot.refresh"), dependencies)).resolves.toEqual({ status: "completed", entityId: "version_2" });
    expect(vi.mocked(refreshBusinessSnapshot)).toHaveBeenCalledWith(dependencies.domain, { businessId });
    expect(queueOpeningRecordings).toHaveBeenCalledWith({ businessId, version: "version_2" });
    expect(greetingRecordings.keep).not.toHaveBeenCalled();
    expect(getCachedBusinessSnapshot).not.toHaveBeenCalled();
    // A failure to queue it only means the next call opens with the greeting command.
    queueOpeningRecordings.mockRejectedValueOnce(new Error("Connection is closed."));
    await expect(handleJob(job("snapshot.refresh"), dependencies)).resolves.toEqual({ status: "completed", entityId: "version_2" });
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ operation: "live.queue_greeting_recordings", businessId }));
    // Without recordings ahead, or with Redis down, the refresh is all the job does.
    await expect(handleJob(job("snapshot.refresh"), { domain: { db: {} as never }, realtime: redis("ready"), queueOpeningRecordings })).resolves.toEqual({ status: "completed", entityId: "version_2" });
    await expect(handleJob(job("snapshot.refresh"), { ...dependencies, realtime: redis("reconnecting") })).resolves.toEqual({ status: "completed", entityId: "version_2" });
    expect(queueOpeningRecordings).toHaveBeenCalledTimes(2);
  });
});
