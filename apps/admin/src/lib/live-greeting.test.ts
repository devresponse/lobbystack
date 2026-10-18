import { greetingRecordingKey } from "@lobbystack/agent-core/live/greetingRecording";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redis: { exists: vi.fn(async (_key: string) => 1) } as { exists: ReturnType<typeof vi.fn> } | undefined,
  waitForRedis: vi.fn(async (_store: unknown) => undefined),
}));

vi.mock("./redis", () => ({ getRedis: () => mocks.redis, waitForRedis: mocks.waitForRedis }));

import { recordedGreetingFor } from "./live-greeting";

const snapshot = { greeting: " Thanks for calling Northside Plumbing. " };

beforeEach(() => {
  mocks.redis = { exists: vi.fn(async (_key: string) => 1) };
  mocks.waitForRedis.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("LIVE_RECORDED_GREETING", "true");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("recordedGreetingFor", () => {
  it("plays the greeting's recording once the worker has made one", async () => {
    await expect(recordedGreetingFor(snapshot)).resolves.toEqual({ text: "Thanks for calling Northside Plumbing.", play: true });
    expect(mocks.redis!.exists).toHaveBeenCalledWith(greetingRecordingKey("Thanks for calling Northside Plumbing.", "marin"));
  });

  // The worker records it during this call, for the next one.
  it("opens the call as before when there's no recording yet, or Redis can't say", async () => {
    mocks.redis!.exists.mockResolvedValueOnce(0);
    await expect(recordedGreetingFor(snapshot)).resolves.toEqual({ text: "Thanks for calling Northside Plumbing.", play: false });
    mocks.redis!.exists.mockRejectedValueOnce(new Error("Connection is closed."));
    await expect(recordedGreetingFor(snapshot)).resolves.toMatchObject({ play: false });
    mocks.waitForRedis.mockRejectedValueOnce(new Error("Redis readiness timed out."));
    await expect(recordedGreetingFor(snapshot)).resolves.toMatchObject({ play: false });
  });

  it("does nothing unless LIVE_RECORDED_GREETING is true, the business has a greeting and Redis is set up", async () => {
    vi.stubEnv("LIVE_RECORDED_GREETING", "1");
    await expect(recordedGreetingFor(snapshot)).resolves.toBeUndefined();
    vi.stubEnv("LIVE_RECORDED_GREETING", "true");
    await expect(recordedGreetingFor({ greeting: " " })).resolves.toBeUndefined();
    mocks.redis = undefined;
    await expect(recordedGreetingFor(snapshot)).resolves.toBeUndefined();
  });
});
