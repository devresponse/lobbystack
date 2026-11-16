import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductAnalytics } from "./productAnalytics";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const event = { event: "call completed", distinctId: "business:1", properties: { durationSeconds: 42 }, timestamp: "2026-11-16T07:00:00.000Z" };

describe("the worker's product events", () => {
  it("sends nothing without a PostHog key", () => {
    expect(createProductAnalytics({})).toBeUndefined();
  });

  it("sends a batch to PostHog's host, with 15 seconds to answer", async () => {
    const limit = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await createProductAnalytics({ POSTHOG_API_KEY: "phc_fixture", POSTHOG_HOST: "https://eu.i.posthog.com/" })!.capture([event]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://eu.i.posthog.com/batch/");
    expect(JSON.parse(String(init?.body))).toEqual({ api_key: "phc_fixture", batch: [{ event: "call completed", distinct_id: "business:1", properties: { durationSeconds: 42 }, timestamp: "2026-11-16T07:00:00.000Z" }] });
    // telemetry.flush shares the maintenance queue, so a stalled PostHog must not hold its slot for undici's 300 seconds.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(limit).toHaveBeenCalledExactlyOnceWith(15_000);
  });

  it("ends the delivery when PostHog stalls, so the job can try again", async () => {
    // A PostHog that never answers: the request ends only when its signal says so.
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
    })));
    // The 15 seconds, run out after a moment.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const limit = new AbortController();
      setTimeout(() => limit.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), 10);
      return limit.signal;
    });

    await expect(createProductAnalytics({ POSTHOG_API_KEY: "phc_fixture" })!.capture([event])).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("fails the delivery when PostHog refuses it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(createProductAnalytics({ POSTHOG_API_KEY: "phc_fixture" })!.capture([event])).rejects.toThrow("PostHog product event delivery failed with status 503.");
  });
});
