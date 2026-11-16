import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(), ids: vi.fn(), update: vi.fn(), withOperatorTransaction: vi.fn(), asApiResponse: vi.fn(), completed: vi.fn(), logEvent: vi.fn(),
  // The error the count throws while no worker reports in, as @lobbystack/jobs declares it.
  Unavailable: class VoicePresenceUnavailableError extends Error {},
}));
vi.mock("@/lib/voice-presence", () => ({ countActiveVoiceCalls: mocks.count, getVoicePresenceCallIds: mocks.ids, removeCompletedVoicePresence: mocks.update, VoicePresenceUnavailableError: mocks.Unavailable }));
vi.mock("@/lib/api-helpers", () => ({ withOperatorTransaction: mocks.withOperatorTransaction, asApiResponse: mocks.asApiResponse }));
vi.mock("@lobbystack/telemetry/node", async (importOriginal) => ({ ...await importOriginal<typeof import("@lobbystack/telemetry/node")>(), logEvent: mocks.logEvent }));

import { GET } from "./route";

afterEach(() => { vi.useRealTimers(); });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.ids.mockResolvedValue([]);
  mocks.withOperatorTransaction.mockImplementation(async (_request, callback) => callback({ businessId: "authorized-business", tx: { select: () => ({ from: () => ({ where: mocks.completed }) }) } }));
});

it("returns an independent live count for the authorized business", async () => {
  mocks.count.mockResolvedValue(2);
  const request = new Request("https://app.example/api/calls/active?businessId=authorized-business");
  const response = await GET(request);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ active: 2 });
  expect(mocks.count).toHaveBeenCalledWith("authorized-business");
});

it("does not return a false zero when live presence is unavailable", async () => {
  mocks.count.mockRejectedValue(new Error("Redis unavailable"));
  mocks.asApiResponse.mockReturnValue(Response.json({ error: "Request failed." }, { status: 503 }));
  const response = await GET(new Request("https://app.example/api/calls/active"));
  expect(response.status).toBe(503);
  expect(await response.json()).not.toEqual({ active: 0 });
});

it("removes only durably completed presence before calculating the summary", async () => {
  mocks.ids.mockResolvedValue(["completed-call", "unresolved-call"]);
  mocks.completed.mockResolvedValue([{ id: "completed-call" }]);
  mocks.count.mockResolvedValue(1);
  const response = await GET(new Request("https://app.example/api/calls/active"));
  expect(response.status).toBe(200);
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ businessId: "authorized-business", callId: "completed-call" });
  expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.count.mock.invocationCallOrder[0]!);
});

// AUDIT-007: the Calls page asks every 5 seconds, and each answer was a 500 reported as a server fault.
it("answers 503 with a code, and reports no fault, while no worker reports in", async () => {
  mocks.count.mockRejectedValue(new mocks.Unavailable("Voice presence is unavailable."));
  const response = await GET(new Request("https://app.example/api/calls/active"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "The count of live calls is unavailable right now.", code: "live_presence_unavailable" });
  expect(mocks.asApiResponse).not.toHaveBeenCalled();
});

it("says so in the log once a minute, not for every request", async () => {
  // Long after anything an earlier test logged: the route remembers its last line for as long as the process lives.
  vi.useFakeTimers({ now: new Date("2100-01-01T00:00:00.000Z") });
  mocks.count.mockRejectedValue(new mocks.Unavailable("Voice presence is unavailable."));
  const ask = async () => await GET(new Request("https://app.example/api/calls/active"));
  await ask();
  vi.advanceTimersByTime(5_000);
  await ask();
  vi.advanceTimersByTime(54_999);
  await ask();
  expect(mocks.logEvent).toHaveBeenCalledExactlyOnceWith("warn", "calls.live_presence_unavailable", { businessId: "authorized-business" });
  vi.advanceTimersByTime(1);
  await ask();
  expect(mocks.logEvent).toHaveBeenCalledTimes(2);
});

it("still treats a failure of Redis itself as a server fault", async () => {
  mocks.count.mockRejectedValue(new Error("connect ECONNREFUSED"));
  mocks.asApiResponse.mockReturnValue(Response.json({ error: "Request failed." }, { status: 500 }));
  const response = await GET(new Request("https://app.example/api/calls/active"));
  expect(response.status).toBe(500);
  expect(mocks.asApiResponse).toHaveBeenCalledOnce();
  expect(mocks.logEvent).not.toHaveBeenCalled();
});
