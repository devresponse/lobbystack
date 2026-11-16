import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AUDIT-011: every open stream used to hold its own Redis connection, so
 * connections grew with open dashboard tabs. These say that one connection now
 * carries them all, and that it goes when the last stream does.
 */

const mocks = vi.hoisted(() => ({ created: [] as FakeRedis[] }));

class FakeRedis extends EventEmitter {
  subscribed = new Set<string>();
  disconnected = false;
  connect = vi.fn(async () => undefined);
  ping = vi.fn(async () => "PONG");
  subscribe = vi.fn(async (channel: string) => { this.subscribed.add(channel); return this.subscribed.size; });
  unsubscribe = vi.fn(async (channel: string) => { this.subscribed.delete(channel); return this.subscribed.size; });
  disconnect = vi.fn(() => { this.disconnected = true; });
  constructor() { super(); mocks.created.push(this); }
}

vi.mock("ioredis", () => ({ default: FakeRedis }));

type Subscriber = typeof import("./realtime-subscriber");

/** A fresh module, so one test's connection is never another's. */
async function freshSubscriber(): Promise<Subscriber> {
  vi.resetModules();
  mocks.created.length = 0;
  return await import("./realtime-subscriber");
}

const heard = () => ({ messages: [] as string[], drops: 0 });
const listener = (record: ReturnType<typeof heard>) => ({ message: (raw: string) => { record.messages.push(raw); }, dropped: () => { record.drops += 1; } });

beforeEach(() => { vi.clearAllMocks(); });

describe("the shared realtime subscriber", () => {
  it("opens one connection for every stream, and subscribes once per channel", async () => {
    const { realtimeState, subscribeToRealtime } = await freshSubscriber();
    const first = heard();
    const second = heard();
    const third = heard();

    const stopFirst = await subscribeToRealtime("redis://fixture", "channel:a", listener(first));
    await subscribeToRealtime("redis://fixture", "channel:a", listener(second));
    await subscribeToRealtime("redis://fixture", "channel:b", listener(third));

    expect(mocks.created).toHaveLength(1);
    expect(mocks.created[0]!.subscribe).toHaveBeenCalledTimes(2);
    expect(realtimeState()).toEqual({ connections: 1, channels: 2, listeners: 3 });

    mocks.created[0]!.emit("message", "channel:a", "{\"type\":\"call.started\"}");
    expect(first.messages).toEqual(["{\"type\":\"call.started\"}"]);
    expect(second.messages).toEqual(["{\"type\":\"call.started\"}"]);
    expect(third.messages).toEqual([]);

    stopFirst();
    mocks.created[0]!.emit("message", "channel:a", "second");
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(2);
  });

  it("leaves a channel with its last stream, and closes the connection with the last channel", async () => {
    const { realtimeState, subscribeToRealtime } = await freshSubscriber();
    const stopA = await subscribeToRealtime("redis://fixture", "channel:a", listener(heard()));
    const stopB = await subscribeToRealtime("redis://fixture", "channel:b", listener(heard()));
    const redis = mocks.created[0]!;

    stopA();
    expect(redis.unsubscribe).toHaveBeenCalledWith("channel:a");
    expect(redis.disconnected).toBe(false);

    stopB();
    expect(redis.unsubscribe).toHaveBeenCalledWith("channel:b");
    expect(redis.disconnected).toBe(true);
    expect(realtimeState()).toEqual({ connections: 0, channels: 0, listeners: 0 });

    // The next stream gets a new connection rather than the closed one.
    await subscribeToRealtime("redis://fixture", "channel:a", listener(heard()));
    expect(mocks.created).toHaveLength(2);
  });

  it("tells every stream when the connection drops, so each browser reconnects", async () => {
    const { realtimeState, subscribeToRealtime } = await freshSubscriber();
    const first = heard();
    const second = heard();
    await subscribeToRealtime("redis://fixture", "channel:a", listener(first));
    await subscribeToRealtime("redis://fixture", "channel:b", listener(second));

    mocks.created[0]!.emit("close");

    expect(first.drops).toBe(1);
    expect(second.drops).toBe(1);
    expect(realtimeState()).toEqual({ connections: 0, channels: 0, listeners: 0 });
  });

  it("pings Redis once for the process, however many streams are open", async () => {
    vi.useFakeTimers();
    try {
      const { subscribeToRealtime } = await freshSubscriber();
      for (const channel of ["channel:a", "channel:b", "channel:c"]) {
        await subscribeToRealtime("redis://fixture", channel, listener(heard()));
      }

      await vi.advanceTimersByTimeAsync(15_000);

      expect(mocks.created[0]!.ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends every stream when the ping goes unanswered", async () => {
    vi.useFakeTimers();
    try {
      const { subscribeToRealtime } = await freshSubscriber();
      const record = heard();
      await subscribeToRealtime("redis://fixture", "channel:a", listener(record));
      mocks.created[0]!.ping.mockRejectedValueOnce(new Error("Command timed out"));

      await vi.advanceTimersByTimeAsync(15_000);

      expect(record.drops).toBe(1);
      expect(mocks.created[0]!.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets one account hold a handful of streams and refuses the rest", async () => {
    const { holdStreamForUser, MAX_STREAMS_PER_USER } = await freshSubscriber();
    const held = Array.from({ length: MAX_STREAMS_PER_USER }, () => holdStreamForUser("user_1"));

    expect(held.every(Boolean)).toBe(true);
    expect(holdStreamForUser("user_1")).toBeNull();
    // Another person is unaffected.
    expect(holdStreamForUser("user_2")).not.toBeNull();

    held[0]!();
    expect(holdStreamForUser("user_1")).not.toBeNull();
  });

  it("names the channel a business's events travel on", async () => {
    const { realtimeChannel } = await freshSubscriber();

    expect(realtimeChannel("business_1", {})).toBe("lobbystack:realtime:business_1");
    expect(realtimeChannel("business_1", { REDIS_PREFIX: "demo" })).toBe("demo:realtime:business_1");
  });
});
