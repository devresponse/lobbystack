import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { parseRealtimeMessage } from "./realtime";

type Subscription = { key: QueryKey; events: readonly string[] };
type Connection = { subscriptions: Set<Subscription>; add(subscription: Subscription): void; dispose(): void };
const clients = new WeakMap<QueryClient, Map<string, Connection>>();

// The server pings every 15 seconds. An open stream that stays silent longer
// than this died without the browser noticing, as behind a proxy that lost the
// server, so a new one replaces it.
const SILENT_STREAM_MS = 45_000;
const RETRY_MAX_MS = 30_000;

/** One connection per business and browser QueryClient; never shared across requests. */
export function subscribeRealtimeQuery(client: QueryClient, businessId: string, key: QueryKey, events: readonly string[]): () => void {
  let businesses = clients.get(client);
  if (!businesses) { businesses = new Map(); clients.set(client, businesses); }
  let connection = businesses.get(businessId);
  if (!connection) {
    const url = `/api/realtime?businessId=${encodeURIComponent(businessId)}`;
    const subscriptions = new Set<Subscription>();
    const eventNames = new Set<string>();
    const pending = new Map<string, QueryKey>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let heardAt = Date.now();
    const queue = (event: Event) => {
      heardAt = Date.now();
      if (event.type !== "ready" && !parseRealtimeMessage((event as MessageEvent<string>).data, businessId)) return;
      for (const subscription of subscriptions) {
        if (event.type === "ready" || subscription.events.includes(event.type)) pending.set(JSON.stringify(subscription.key), subscription.key);
      }
      if (!timer && pending.size) timer = setTimeout(() => {
        timer = undefined;
        for (const queryKey of pending.values()) {
          if ([...subscriptions].some(subscription => JSON.stringify(subscription.key) === JSON.stringify(queryKey))) {
            void client.invalidateQueries({ queryKey, refetchType: "active" });
          }
        }
        pending.clear();
      }, 100);
    };
    const connect = () => {
      retry = undefined;
      heardAt = Date.now();
      const next = new EventSource(url);
      source = next;
      // Every server subscription emits ready, including reconnects. Refetch to
      // recover changes missed while Redis Pub/Sub or the browser was disconnected.
      next.addEventListener("ready", (event) => { failures = 0; queue(event); });
      next.addEventListener("ping", () => { heardAt = Date.now(); });
      for (const event of eventNames) next.addEventListener(event, queue);
      // The browser retries a dropped stream by itself, but gives up for good
      // when a retry gets an error response, such as the 502 of a deploy. A new
      // stream takes its place then, a little later after each failure in a row.
      next.addEventListener("error", () => {
        if (source === next && next.readyState === EventSource.CLOSED) reopen(Math.min(RETRY_MAX_MS, 1_000 * 2 ** failures++));
      });
    };
    const reopen = (delayMs: number) => {
      source?.close();
      source = undefined;
      retry = setTimeout(connect, delayMs);
    };
    const replaceSilentStream = () => {
      if (source?.readyState === EventSource.OPEN && Date.now() - heardAt > SILENT_STREAM_MS) reopen(0);
    };
    // Back online, or back on the tab: a stream waiting to retry opens now.
    const wake = () => {
      if (retry === undefined) return replaceSilentStream();
      clearTimeout(retry);
      connect();
    };
    const wakeWhenVisible = () => { if (document.visibilityState === "visible") wake(); };
    const watchdog = setInterval(replaceSilentStream, SILENT_STREAM_MS / 3);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wakeWhenVisible);
    connect();
    connection = {
      subscriptions,
      add(subscription) {
        for (const event of subscription.events) if (!eventNames.has(event)) { eventNames.add(event); source?.addEventListener(event, queue); }
        subscriptions.add(subscription);
      },
      dispose() {
        if (timer) clearTimeout(timer);
        if (retry !== undefined) clearTimeout(retry);
        clearInterval(watchdog);
        window.removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wakeWhenVisible);
        pending.clear();
        source?.close();
        source = undefined;
      },
    };
    businesses.set(businessId, connection);
  }
  const subscription = { key, events };
  connection.add(subscription);
  const current = connection;
  return () => {
    current.subscriptions.delete(subscription);
    if (!current.subscriptions.size) { current.dispose(); businesses!.delete(businessId); }
  };
}
