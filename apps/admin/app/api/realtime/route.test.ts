import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ created: [] as FakeRedis[], session: { user: { id: "user_1" } } }));

class FakeRedis extends EventEmitter {
  connect = vi.fn(async () => undefined);
  ping = vi.fn(async () => "PONG");
  subscribe = vi.fn(async () => 1);
  unsubscribe = vi.fn(async () => 0);
  disconnect = vi.fn(() => { this.emit("close"); });
  constructor() { super(); mocks.created.push(this); }
}

vi.mock("ioredis", () => ({ default: FakeRedis }));
vi.mock("@/lib/api-helpers", () => ({
  withOperatorTransaction: async (_request: Request, callback: (input: { session: unknown }) => unknown) => await callback({ session: mocks.session }),
  asApiResponse: (error: unknown) => { throw error; },
}));

/** A fresh route, so one test's shared subscriber is never another's. */
async function freshRoute() {
  vi.resetModules();
  mocks.created.length = 0;
  return (await import("./route")).GET;
}

const open = (GET: Awaited<ReturnType<typeof freshRoute>>, businessId = "biz-1") =>
  GET(new Request(`http://localhost/api/realtime?businessId=${businessId}`));

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("REDIS_URL", "redis://fixture"); });

describe("realtime stream", () => {
  it("ends the stream when the Redis subscriber drops so the browser reconnects", async () => {
    const GET = await freshRoute();
    const response = await open(GET);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");

    mocks.created.at(-1)!.emit("close");

    await expect(Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve("open"), 100))])).resolves.toEqual({ done: true, value: undefined });
  });

  // AUDIT-011: one connection per process, so two tabs no longer mean two connections.
  it("serves a second tab from the same connection", async () => {
    const GET = await freshRoute();
    const first = (await open(GET)).body!.getReader();
    const second = (await open(GET, "biz-2")).body!.getReader();
    const decoder = new TextDecoder();

    expect(decoder.decode((await first.read()).value)).toContain("event: ready");
    expect(decoder.decode((await second.read()).value)).toContain("event: ready");
    expect(mocks.created).toHaveLength(1);
  });

  it("pings the browser while the stream lives, and ends it when Redis stops answering", async () => {
    vi.useFakeTimers();
    try {
      const GET = await freshRoute();
      const reader = (await open(GET)).body!.getReader();
      const decoder = new TextDecoder();
      expect(decoder.decode((await reader.read()).value)).toContain("event: ready");

      await vi.advanceTimersByTimeAsync(15_000);
      expect(decoder.decode((await reader.read()).value)).toBe("event: ping\ndata: {}\n\n");

      mocks.created.at(-1)!.ping.mockRejectedValueOnce(new Error("Command timed out"));
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an account that already holds too many streams, and takes it back when one closes", async () => {
    const GET = await freshRoute();
    const { MAX_STREAMS_PER_USER } = await import("@/lib/realtime-subscriber");
    const readers = [];
    for (let index = 0; index < MAX_STREAMS_PER_USER; index += 1) readers.push((await open(GET)).body!.getReader());

    const refused = await open(GET);
    expect(refused.status).toBe(429);
    await expect(refused.text()).resolves.toContain("Close a dashboard tab");

    await readers[0]!.cancel();
    await expect(open(GET)).resolves.toHaveProperty("status", 200);
  });

  it("needs a businessId", async () => {
    const GET = await freshRoute();

    await expect(GET(new Request("http://localhost/api/realtime"))).resolves.toHaveProperty("status", 400);
  });
});
