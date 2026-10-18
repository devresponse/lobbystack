import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ subscribers: [] as EventEmitter[], ping: vi.fn(async () => "PONG") }));
vi.mock("ioredis", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      constructor() { super(); mocks.subscribers.push(this); }
      connect = async () => undefined;
      subscribe = async () => 1;
      ping = () => mocks.ping();
      disconnect() { this.emit("close"); }
    },
  };
});
vi.mock("@/lib/api-helpers", () => ({ withOperatorTransaction: async () => undefined, asApiResponse: (error: unknown) => { throw error; } }));
import { GET } from "./route";

describe("realtime stream", () => {
  it("ends the stream when the Redis subscriber drops so the browser reconnects", async () => {
    vi.stubEnv("REDIS_URL", "redis://fixture");
    const response = await GET(new Request("http://localhost/api/realtime?businessId=biz-1"));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    mocks.subscribers.at(-1)!.emit("close");
    await expect(Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve("open"), 100))])).resolves.toEqual({ done: true, value: undefined });
  });

  it("pings the browser while Redis answers and ends the stream when Redis stops answering", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("REDIS_URL", "redis://fixture");
      const response = await GET(new Request("http://localhost/api/realtime?businessId=biz-1"));
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      expect(decoder.decode((await reader.read()).value)).toContain("event: ready");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(decoder.decode((await reader.read()).value)).toBe("event: ping\ndata: {}\n\n");
      mocks.ping.mockRejectedValueOnce(new Error("Command timed out"));
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });
});
