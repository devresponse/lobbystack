// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { subscribeRealtimeQuery } from "./realtime-query";

const businessId = "11111111-1111-4111-8111-111111111111";
const sources: Source[] = [];
class Source extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = Source.OPEN;
  close = vi.fn(() => { this.readyState = Source.CLOSED; });
  constructor(readonly url: string) { super(); sources.push(this); }
}
function emit(type: string, tenant = businessId, source = sources[0]!) {
  source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ id: "22222222-2222-4222-8222-222222222222", type, businessId: tenant, entityId: "33333333-3333-4333-8333-333333333333", occurredAt: "2026-08-10T12:00:00Z", payload: {}, trace: {} }) }));
}
/** The browser gave up on the stream, as it does when a retry gets an error response such as a 502. */
function giveUp(source: Source) {
  source.readyState = Source.CLOSED;
  source.dispatchEvent(new Event("error"));
}
beforeEach(() => { sources.length = 0; vi.useFakeTimers(); vi.stubGlobal("EventSource", Source); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shares a connection and coalesces 100 events into one invalidation per query", () => {
  const invalidateQueries = vi.fn();
  const client = { invalidateQueries } as unknown as QueryClient;
  const closeA = subscribeRealtimeQuery(client, businessId, ["calls", businessId], ["call.updated"]);
  const closeB = subscribeRealtimeQuery(client, businessId, ["calls", businessId], ["call.updated"]);
  expect(sources).toHaveLength(1);
  for (let n = 0; n < 100; n++) emit("call.updated");
  expect(invalidateQueries).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(invalidateQueries).toHaveBeenCalledTimes(1);
  closeA(); expect(sources[0]!.close).not.toHaveBeenCalled();
  closeB(); expect(sources[0]!.close).toHaveBeenCalledOnce();
});
it("resynchronizes on ready and drops foreign or disconnected events", () => {
  const invalidateQueries = vi.fn();
  const client = { invalidateQueries } as unknown as QueryClient;
  const close = subscribeRealtimeQuery(client, businessId, ["calls", businessId], ["call.updated"]);
  emit("call.updated", "44444444-4444-4444-8444-444444444444");
  vi.advanceTimersByTime(100); expect(invalidateQueries).not.toHaveBeenCalled();
  sources[0]!.dispatchEvent(new Event("ready")); vi.advanceTimersByTime(100);
  expect(invalidateQueries).toHaveBeenCalledOnce();
  sources[0]!.dispatchEvent(new Event("ready")); vi.advanceTimersByTime(100);
  expect(invalidateQueries).toHaveBeenCalledTimes(2);
  emit("call.updated"); close(); vi.advanceTimersByTime(100);
  expect(invalidateQueries).toHaveBeenCalledTimes(2);
  const closeNext = subscribeRealtimeQuery(client, "next-business", ["calls", "next-business"], ["call.updated"]);
  expect(sources[1]!.url).toContain("next-business"); closeNext();
});
it("opens a new stream when the browser gives up on one, backing off, and refetches once it's ready", () => {
  const invalidateQueries = vi.fn();
  const client = { invalidateQueries } as unknown as QueryClient;
  const close = subscribeRealtimeQuery(client, businessId, ["messages", businessId], ["message.upserted"]);
  giveUp(sources[0]!);
  expect(sources).toHaveLength(1);
  vi.advanceTimersByTime(1_000);
  expect(sources).toHaveLength(2);
  giveUp(sources[1]!);
  vi.advanceTimersByTime(1_999); expect(sources).toHaveLength(2);
  vi.advanceTimersByTime(1); expect(sources).toHaveLength(3);
  // The new stream carries the subscribed events and catches up on what was missed.
  sources[2]!.dispatchEvent(new Event("ready")); vi.advanceTimersByTime(100);
  expect(invalidateQueries).toHaveBeenCalledOnce();
  emit("message.upserted", businessId, sources[2]); vi.advanceTimersByTime(100);
  expect(invalidateQueries).toHaveBeenCalledTimes(2);
  // A stream that got ready starts the back-off over.
  giveUp(sources[2]!);
  vi.advanceTimersByTime(1_000); expect(sources).toHaveLength(4);
  close();
  expect(sources[3]!.close).toHaveBeenCalledOnce();
});
it("leaves a dropped stream the browser is retrying to the browser", () => {
  const client = { invalidateQueries: vi.fn() } as unknown as QueryClient;
  const close = subscribeRealtimeQuery(client, businessId, ["messages", businessId], ["message.upserted"]);
  sources[0]!.readyState = Source.CONNECTING;
  sources[0]!.dispatchEvent(new Event("error"));
  vi.advanceTimersByTime(30_000);
  expect(sources).toHaveLength(1);
  expect(sources[0]!.close).not.toHaveBeenCalled();
  close();
});
it("replaces an open stream that goes silent, but not one that pings", () => {
  const client = { invalidateQueries: vi.fn() } as unknown as QueryClient;
  const close = subscribeRealtimeQuery(client, businessId, ["messages", businessId], ["message.upserted"]);
  for (let n = 0; n < 8; n++) {
    vi.advanceTimersByTime(15_000);
    sources[0]!.dispatchEvent(new MessageEvent("ping", { data: "{}" }));
  }
  expect(sources).toHaveLength(1);
  vi.advanceTimersByTime(61_000);
  expect(sources[0]!.close).toHaveBeenCalledOnce();
  expect(sources).toHaveLength(2);
  close();
});
it("retries at once when the browser is back online or the tab is shown", () => {
  const client = { invalidateQueries: vi.fn() } as unknown as QueryClient;
  const close = subscribeRealtimeQuery(client, businessId, ["messages", businessId], ["message.upserted"]);
  for (let n = 0; n < 5; n++) { giveUp(sources.at(-1)!); vi.advanceTimersByTime(2 ** n * 1_000); }
  expect(sources).toHaveLength(6);
  giveUp(sources[5]!);
  window.dispatchEvent(new Event("online"));
  expect(sources).toHaveLength(7);
  giveUp(sources[6]!);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(sources).toHaveLength(8);
  close();
  // Nothing reopens once the last subscriber leaves.
  giveUp(sources[7]!);
  window.dispatchEvent(new Event("online"));
  vi.advanceTimersByTime(120_000);
  expect(sources).toHaveLength(8);
});
