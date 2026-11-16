import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";
import { parseRealtimeMessage } from "@/lib/realtime";
import { holdStreamForUser, realtimeChannel, subscribeToRealtime, MAX_STREAMS_PER_USER } from "@/lib/realtime-subscriber";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The dashboard's event stream. One Redis subscriber serves every stream this
 * process holds (AUDIT-011), so connections grow with servers, not with tabs.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const businessId = new URL(request.url).searchParams.get("businessId");
    if (!businessId) {
      return new Response("businessId is required", { status: 400 });
    }
    const session = await withOperatorTransaction(request, async ({ session }) => session);
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      return new Response("Realtime is not configured", { status: 503 });
    }
    const release = holdStreamForUser(session.user.id);
    if (!release) {
      // The browser treats this as a failed stream and opens the next one later.
      return new Response(`Too many open streams: ${MAX_STREAMS_PER_USER} at a time. Close a dashboard tab.`, { status: 429 });
    }
    const channel = realtimeChannel(businessId);
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let cleanup: (closeController?: boolean) => Promise<void> = async () => { release(); };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        let unsubscribe: (() => void) | undefined;
        const onAbort = () => { void cleanup(); };
        cleanup = async (closeController = true) => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          request.signal.removeEventListener("abort", onAbort);
          unsubscribe?.();
          release();
          if (closeController) {
            try { controller.close(); } catch { /* client disconnected */ }
          }
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) {
          await cleanup();
          return;
        }
        try {
          unsubscribe = await subscribeToRealtime(redisUrl, channel, {
            message: (raw) => {
              const event = parseRealtimeMessage(raw, businessId);
              if (!event) return;
              try {
                controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
              } catch {
                void cleanup(false);
              }
            },
            // Pub/Sub keeps no backlog, so a drop ends the stream: the browser
            // reconnects and refetches on the next "ready".
            dropped: () => void cleanup(),
          });
          if (closed) {
            unsubscribe();
            return;
          }
          controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({ businessId })}\n\n`));
          // The browser hears a ping while this stream lives, and opens a new one
          // when the pings stop. Redis itself is pinged once per process, not per stream.
          heartbeat = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
            } catch {
              void cleanup(false);
            }
          }, 15_000);
          heartbeat.unref?.();
        } catch (error) {
          if (!closed) {
            await cleanup(false);
            controller.error(error);
          }
        }
      },
      cancel() {
        return cleanup(false);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
  } catch (error) {
    return asApiResponse(error);
  }
}
