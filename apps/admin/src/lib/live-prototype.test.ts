import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachWorkerToLiveSession, endLiveBrowserSession, requestGreetingRecording } from "./live-prototype";

const fetchMock = vi.fn();
// The worker's name, as the admin looks it up to find the worker's copies.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
const attachInput = { sessionId: "live_1", businessId: "biz_1", callId: "call_1", channel: "voice" as const };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("INTERNAL_SERVICE_TOKEN", "token");
  vi.stubEnv("WORKER_INTERNAL_URL", "http://worker.test");
  // One copy of the worker, unless a test says otherwise.
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("attachWorkerToLiveSession", () => {
  const draining = () => new Response(JSON.stringify({ error: "This worker is shutting down." }), { status: 503 });

  it("waits 250 ms, then 750 ms, before retrying a draining worker's 503, within one timeout", async () => {
    const refusals = [draining(), draining()];
    const sentAt: number[] = [];
    fetchMock.mockImplementation(async () => {
      sentAt.push(performance.now());
      return refusals[sentAt.length - 1] ?? new Response(null, { status: 200 });
    });
    await attachWorkerToLiveSession(attachInput);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(245);
    expect(sentAt[1]! - sentAt[0]!).toBeLessThan(700);
    expect(sentAt[2]! - sentAt[1]!).toBeGreaterThanOrEqual(745);
    expect(fetchMock.mock.calls.every(([url]) => url === "http://worker.test/internal/live/attach")).toBe(true);
    // Every attempt shares the first attempt's abort signal.
    expect(new Set(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).signal)).size).toBe(1);
    // The refusals' bodies were cancelled, not left holding their connections.
    expect(refusals.every((refusal) => refusal.bodyUsed)).toBe(true);
  });

  it("gives up after two retries", async () => {
    fetchMock.mockImplementation(async () => draining());
    await expect(attachWorkerToLiveSession(attachInput)).rejects.toThrow("Worker attach failed with status 503.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops waiting to retry when the shared 10-second budget runs out", async () => {
    // Stands in for the 10-second timeout, which here runs out 50 ms after the first refusal.
    const budget = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
    fetchMock.mockImplementationOnce(async () => {
      setTimeout(() => budget.abort(new DOMException("The operation timed out.", "TimeoutError")), 50);
      return draining();
    });
    const startedAt = performance.now();
    await expect(attachWorkerToLiveSession(attachInput)).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(240);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry other failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(attachWorkerToLiveSession(attachInput)).rejects.toThrow("Worker attach failed with status 500.");
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(attachWorkerToLiveSession(attachInput)).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("endLiveBrowserSession", () => {
  it("doesn't retry a 503", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(endLiveBrowserSession("live_1")).rejects.toThrow("Worker end failed with status 503.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("requestGreetingRecording", () => {
  it("asks the worker to record a receptionist's opening, and says whether it does", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ recording: true }, { status: 202 }));
    await expect(requestGreetingRecording({ businessId: "biz_1", receptionistId: "receptionist_1" })).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://worker.test/internal/live/greeting");
    expect(init).toMatchObject({ method: "POST", headers: { "x-internal-service-token": "token" } });
    expect(JSON.parse(String(init.body))).toEqual({ businessId: "biz_1", receptionistId: "receptionist_1" });
    // A worker with LIVE_RECORDED_GREETING=false, or one that answers without a body, records none.
    fetchMock.mockResolvedValueOnce(Response.json({ recording: false }, { status: 202 }));
    await expect(requestGreetingRecording({ businessId: "biz_1" })).resolves.toBe(false);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await expect(requestGreetingRecording({ businessId: "biz_1" })).resolves.toBe(false);
  });

  it("fails on a worker that refuses, without retrying", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(requestGreetingRecording({ businessId: "biz_1" })).rejects.toThrow("Worker greeting failed with status 503.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("with several copies of the worker", () => {
  const refusal = () => new Response(JSON.stringify({ error: "This worker is shutting down." }), { status: 503 });
  const accepted = () => Response.json({ ok: true }, { status: 202 });
  const urls = () => fetchMock.mock.calls.map(([url]) => url as string);
  const copies = (...addresses: string[]) => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  // With Math.random at 0.99 the shuffle keeps the order the name lists.
  const listedOrder = () => vi.spyOn(Math, "random").mockReturnValue(0.99);

  beforeEach(() => {
    // Railway's private name for the worker, which lists one address for each running copy.
    vi.stubEnv("WORKER_INTERNAL_URL", "http://worker.railway.internal:3002");
  });

  it("looks the worker's name up and picks a copy for each call, in a new random order each time", async () => {
    lookupMock.mockResolvedValue(copies("fd12::a", "fd12::b"));
    fetchMock.mockImplementation(async () => accepted());
    // The first call keeps the listed order, the second swaps it.
    vi.spyOn(Math, "random").mockReturnValueOnce(0.99).mockReturnValueOnce(0.01);
    await attachWorkerToLiveSession(attachInput);
    await attachWorkerToLiveSession({ ...attachInput, sessionId: "live_2" });
    expect(lookupMock).toHaveBeenCalledWith("worker.railway.internal", { all: true });
    // IPv6 addresses go in brackets, and the port stays.
    expect(urls()).toEqual(["http://[fd12::a]:3002/internal/live/attach", "http://[fd12::b]:3002/internal/live/attach"]);
  });

  it("spreads calls over every copy, not only the first one listed", async () => {
    lookupMock.mockResolvedValue(copies("10.0.0.1", "10.0.0.2", "10.0.0.3"));
    fetchMock.mockImplementation(async () => accepted());
    for (let call = 0; call < 60; call += 1) await attachWorkerToLiveSession({ ...attachInput, sessionId: `live_${call}` });
    const perCopy = Object.groupBy(urls(), (url) => new URL(url).hostname);
    expect(Object.keys(perCopy).sort()).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
    // Each gets a fair share; 60 calls with none or nearly none on one copy would mean the order isn't random.
    for (const sent of Object.values(perCopy)) expect(sent!.length).toBeGreaterThan(5);
  });

  it("sends an attach a copy refuses to the next copy at once", async () => {
    lookupMock.mockResolvedValue(copies("10.0.0.1", "10.0.0.2"));
    listedOrder();
    const refused = refusal();
    const sentAt: number[] = [];
    fetchMock.mockImplementation(async () => {
      sentAt.push(performance.now());
      return sentAt.length === 1 ? refused : accepted();
    });
    await attachWorkerToLiveSession(attachInput);
    expect(urls()).toEqual(["http://10.0.0.1:3002/internal/live/attach", "http://10.0.0.2:3002/internal/live/attach"]);
    // No wait: the other copy can take the call now.
    expect(sentAt[1]! - sentAt[0]!).toBeLessThan(200);
    expect(refused.bodyUsed).toBe(true);
    // Both tries share one 10-second budget and send the same request.
    const inits = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
    expect(inits[0]!.signal).toBe(inits[1]!.signal);
    expect(JSON.parse(String(inits[1]!.body))).toEqual(attachInput);
  });

  it("sends the request to the next copy when one can't be reached", async () => {
    lookupMock.mockResolvedValue(copies("10.0.0.1", "10.0.0.2"));
    listedOrder();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(accepted());
    await attachWorkerToLiveSession(attachInput);
    expect(urls()).toEqual(["http://10.0.0.1:3002/internal/live/attach", "http://10.0.0.2:3002/internal/live/attach"]);
  });

  it("waits 250 ms, then 750 ms, when every copy refuses, and looks the copies up again before each round", async () => {
    // The third round finds a copy the release has just started.
    lookupMock
      .mockResolvedValueOnce(copies("10.0.0.1", "10.0.0.2"))
      .mockResolvedValueOnce(copies("10.0.0.1", "10.0.0.2"))
      .mockResolvedValueOnce(copies("10.0.0.1", "10.0.0.2", "10.0.0.3"));
    listedOrder();
    const sentAt: number[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      sentAt.push(performance.now());
      return url.startsWith("http://10.0.0.3:") ? accepted() : refusal();
    });
    await attachWorkerToLiveSession(attachInput);
    expect(lookupMock).toHaveBeenCalledTimes(3);
    expect(urls().map((url) => new URL(url).hostname)).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.1", "10.0.0.2", "10.0.0.1", "10.0.0.2", "10.0.0.3"]);
    expect(sentAt[1]! - sentAt[0]!).toBeLessThan(200);
    expect(sentAt[2]! - sentAt[1]!).toBeGreaterThanOrEqual(245);
    expect(sentAt[4]! - sentAt[3]!).toBeGreaterThanOrEqual(745);
  });

  it("gives up after the third round with the copies' 503", async () => {
    lookupMock.mockResolvedValue(copies("10.0.0.1", "10.0.0.2"));
    fetchMock.mockImplementation(async () => refusal());
    await expect(attachWorkerToLiveSession(attachInput)).rejects.toThrow("Worker attach failed with status 503.");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("doesn't wait for a new copy when every copy is out of reach and none refused", async () => {
    lookupMock.mockResolvedValue(copies("10.0.0.1", "10.0.0.2"));
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(attachWorkerToLiveSession(attachInput)).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't pass on other failures, such as a 500", async () => {
    lookupMock.mockResolvedValue(copies("10.0.0.1", "10.0.0.2"));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(attachWorkerToLiveSession(attachInput)).rejects.toThrow("Worker attach failed with status 500.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at once when the shared budget runs out, without trying the next copy", async () => {
    lookupMock.mockResolvedValue(copies("10.0.0.1", "10.0.0.2"));
    const budget = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
    const timedOut = new DOMException("The operation timed out.", "TimeoutError");
    fetchMock.mockImplementationOnce(async () => {
      budget.abort(timedOut);
      throw timedOut;
    });
    await expect(attachWorkerToLiveSession(attachInput)).rejects.toThrow("The operation timed out.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a lookup that doesn't answer within the budget", async () => {
    lookupMock.mockReturnValue(new Promise(() => {}));
    const budget = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
    setTimeout(() => budget.abort(new DOMException("The operation timed out.", "TimeoutError")), 50);
    await expect(attachWorkerToLiveSession(attachInput)).rejects.toThrow("The operation timed out.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tries the copies in the family fetch would pick first, then the other family's", async () => {
    lookupMock.mockResolvedValue(copies("fd12::a", "10.0.0.1", "fd12::b", "10.0.0.2"));
    listedOrder();
    fetchMock.mockImplementation(async () => refusal());
    await expect(endLiveBrowserSession("live_1")).rejects.toThrow("Worker end failed with status 503.");
    expect(urls().map((url) => new URL(url).host)).toEqual(["[fd12::a]:3002", "[fd12::b]:3002", "10.0.0.1:3002", "10.0.0.2:3002"]);
  });

  it("sends an end or a greeting a copy refuses to another copy, and fails without waiting when every copy refuses", async () => {
    lookupMock.mockResolvedValue(copies("10.0.0.1", "10.0.0.2"));
    listedOrder();
    fetchMock.mockResolvedValueOnce(refusal()).mockResolvedValueOnce(accepted());
    await endLiveBrowserSession("live_1");
    expect(urls()).toEqual(["http://10.0.0.1:3002/internal/live/end", "http://10.0.0.2:3002/internal/live/end"]);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => refusal());
    const startedAt = performance.now();
    await expect(requestGreetingRecording({ businessId: "biz_1" })).rejects.toThrow("Worker greeting failed with status 503.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  it("uses the configured address as it is when the name lists one copy or doesn't resolve", async () => {
    fetchMock.mockImplementation(async () => accepted());
    lookupMock.mockResolvedValueOnce(copies("10.0.0.1"));
    await endLiveBrowserSession("live_1");
    lookupMock.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND worker.railway.internal"), { code: "ENOTFOUND" }));
    await endLiveBrowserSession("live_1");
    // The same address listed twice is one copy.
    lookupMock.mockResolvedValueOnce(copies("10.0.0.1", "10.0.0.1"));
    await endLiveBrowserSession("live_1");
    expect(urls()).toEqual(Array(3).fill("http://worker.railway.internal:3002/internal/live/end"));
  });

  it("doesn't look up an IP, an https address or the local default", async () => {
    fetchMock.mockImplementation(async () => accepted());
    vi.stubEnv("WORKER_INTERNAL_URL", "http://10.1.2.3:3002");
    await endLiveBrowserSession("live_1");
    vi.stubEnv("WORKER_INTERNAL_URL", "http://[fd12::c]:3002");
    await endLiveBrowserSession("live_1");
    // An https address needs its name for the certificate.
    vi.stubEnv("WORKER_INTERNAL_URL", "https://worker.example.com");
    await endLiveBrowserSession("live_1");
    vi.stubEnv("WORKER_INTERNAL_URL", undefined);
    vi.stubEnv("WORKER_PORT", "3005");
    await endLiveBrowserSession("live_1");
    expect(lookupMock).not.toHaveBeenCalled();
    expect(urls()).toEqual([
      "http://10.1.2.3:3002/internal/live/end",
      "http://[fd12::c]:3002/internal/live/end",
      "https://worker.example.com/internal/live/end",
      "http://127.0.0.1:3005/internal/live/end",
    ]);
  });
});
