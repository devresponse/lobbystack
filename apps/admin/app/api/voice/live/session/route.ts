import { NextResponse } from "next/server";
import { APIError } from "openai";

import { buildBrowserSessionConfig } from "@lobbystack/agent-core/live/session";
import { finishLiveCall, getWebVoiceBillingAllowance, recordAiTrace, recordProspectDemoCallError, recordProspectDemoCallStarted, recordVoiceSnapshotLoaded, startLiveWebCall } from "@lobbystack/domain";
import type { BusinessContextSnapshot } from "@lobbystack/shared";
import { addToCallContext, logEvent, withCallContext } from "@lobbystack/telemetry/node";
import { asApiResponse, readJson } from "@/lib/api-helpers";
import { loadValidBusinessSnapshot } from "@/lib/business-snapshot";
import { createWorkerDomainContext } from "@/lib/domain-context";
import { recordedGreetingFor } from "@/lib/live-greeting";
import { attachWorkerToLiveSession, endLiveBrowserSession, getLiveClient, requireLivePrototype } from "@/lib/live-prototype";
import { LIVE_WEB_CALL_WIDGET_IDS, liveSessionEndToken, publicCallCorsHeaders, resolveLiveWebCallAccess, type LiveWebCallRequest } from "@/lib/live-web-call";
import { requestIpHash } from "@/lib/widget-keys";
import { enforceWebVoiceRateLimits } from "@/lib/web-voice-policy";


const WEBRTC_CREATION_SECONDS = 15;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SDP_BYTES = 64 * 1024;

function parse(body: unknown): LiveWebCallRequest | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = body as Record<string, unknown>;
  const text = (key: string, max = 2_048) => typeof value[key] === "string" && value[key].length <= max && value[key].trim() ? value[key].trim() : undefined;
  // An SDP must keep its trailing line break, so it is never trimmed.
  const sdp = typeof value.sdp === "string" && value.sdp.trim() && value.sdp.length <= MAX_SDP_BYTES ? value.sdp : undefined;
  const widgetId = text("widgetId", 128);
  if (!sdp || !widgetId || !(LIVE_WEB_CALL_WIDGET_IDS as readonly string[]).includes(widgetId)) return undefined;
  const optional = { businessSlug: text("businessSlug", 128), visitorId: text("visitorId", 128), pageUrl: text("pageUrl"), prospectDemoToken: text("prospectDemoToken", 512) };
  return { sdp, widgetId, ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)) };
}

/**
 * Times each stage of the call start for the Server-Timing header, so the
 * browser's network panel shows where the wait before the greeting goes.
 */
function createServerTiming() {
  const entries: Array<[string, number]> = [];
  let last = performance.now();
  return {
    mark(name: string) {
      const now = performance.now();
      entries.push([name, now - last]);
      last = now;
    },
    header: () => entries.map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`).join(", "),
    /** The same stages for the log line, in whole milliseconds. */
    stages: () => Object.fromEntries(entries.map(([name, ms]) => [`${name}Ms`, Math.round(ms)])),
  };
}

// The browser only gets the code, so the log line is where an operator sees
// why a call didn't start. A rate limit's `reason` names the count that ran out.
function denied(status: number, code: string, headers: Record<string, string>, fields: { widgetId?: string; reason?: string } = {}) {
  logEvent("warn", "live.browser_refused", { status, code, ...fields });
  return NextResponse.json({ code, error: "The call couldn't start." }, { status, headers });
}

/**
 * OpenAI refusing the session, such as with 429 when its account is out of
 * credit, is our failure to start the call, not the caller's. It reaches the
 * logs and error tracking with OpenAI's code, and the browser gets 502: passing
 * OpenAI's own status on would read as one of our limits.
 */
class LiveSessionRefusedError extends Error {
  readonly status = 502;

  constructor(cause: APIError) {
    super(`OpenAI refused to create the live session${cause.code ? ` (${cause.code})` : ""}: ${cause.message}`, { cause });
    this.name = "LiveSessionRefusedError";
  }
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: publicCallCorsHeaders(request.headers.get("origin")) });
}

/**
 * Starts a browser call on GPT-Live: dashboard test calls, the website
 * widget, prospect demos and the landing site demo. The browser sends its
 * WebRTC offer; we check access, limits and minutes, record the call, create
 * the session with client delegation, hand it to the worker, and return
 * OpenAI's answer.
 */
export async function POST(request: Request) {
  // Logs and the error report carry the call's IDs as they become known.
  return await withCallContext({}, () => startBrowserCall(request));
}

async function startBrowserCall(request: Request) {
  const cors = publicCallCorsHeaders(request.headers.get("origin"));
  try {
    requireLivePrototype();
    const body = parse(await readJson(request));
    if (!body) return denied(400, "invalid_request", cors);
    const timing = createServerTiming();
    const access = await resolveLiveWebCallAccess(request, body);
    timing.mark("access");
    if (!("businessId" in access)) return denied(access.status, access.code, cors);
    addToCallContext({ businessId: access.businessId });

    const domain = createWorkerDomainContext();
    const ipHash = requestIpHash(request);
    const maxDurationMs = Number(process.env.WEB_CALL_MAX_DURATION_MS) || undefined;
    const limit = await enforceWebVoiceRateLimits({
      businessId: access.businessId,
      origin: access.origin,
      ...(ipHash ? { ipHash } : {}),
      ...(access.visitorId ? { visitorId: access.visitorId } : {}),
      ...(access.prospectDemoId ? { prospectDemoId: access.prospectDemoId } : { dashboardTestCall: access.dashboardTestCall }),
    });
    if (!limit.allowed) return denied(limit.status, limit.code, cors, { widgetId: access.widgetId, reason: limit.reason });
    // The rate limit shields the database, so only allowed callers reach it.
    // The caller hears nothing until this request returns, so these two
    // independent reads run together.
    const [billing, snapshot] = await Promise.all([
      access.prospectDemoId ? undefined : getWebVoiceBillingAllowance(domain, { businessId: access.businessId, ...(maxDurationMs ? { maxDurationMs } : {}) }),
      loadValidBusinessSnapshot(access.businessId) as Promise<BusinessContextSnapshot | null>,
    ]);
    timing.mark("checks");
    if (billing && !billing.allowed) return denied(402, billing.errorCode ?? "voice_limit_reached", cors);
    if (!snapshot) return denied(409, "snapshot_missing", cors);
    // The widget offers voice only to businesses with a phone number.
    if (access.widgetId === "lobbystack-widget" && !snapshot.contactChannels?.phoneNumber) return denied(403, "voice_unavailable", cors);
    // Telemetry only; the call doesn't wait for it.
    void Promise.resolve(recordVoiceSnapshotLoaded(domain, { businessId: access.businessId, channel: "web_voice", provider: "openai_live" })).catch(() => undefined);
    const recordedGreeting = await recordedGreetingFor(snapshot);
    timing.mark("greeting");

    const client = getLiveClient();
    const sessionConfig = buildBrowserSessionConfig(snapshot, { greetingRecorded: recordedGreeting?.play === true });
    const live = await client.live
      .create({ session: sessionConfig, transport: { type: "webrtc", sdp: body.sdp } })
      .catch((error: unknown) => {
        throw error instanceof APIError && typeof error.status === "number" ? new LiveSessionRefusedError(error) : error;
      });
    timing.mark("openai");
    const sessionId = live.session.id;
    addToCallContext({ sessionId });
    let callId: string | undefined;
    try {
      const call = await startLiveWebCall(domain, {
        businessId: access.businessId,
        sessionId,
        widgetId: access.widgetId,
        billable: !access.prospectDemoId,
        ...(maxDurationMs ? { maxDurationMs } : {}),
        ...(access.prospectDemoId ? { sessionPurpose: "prospect_demo", prospectDemoId: access.prospectDemoId } : {}),
        // Prospect demos keep no page URL.
        ...(body.pageUrl && !access.prospectDemoId ? { originUrl: body.pageUrl } : {}),
        ...(request.headers.get("user-agent") ? { userAgent: request.headers.get("user-agent")!.slice(0, 512) } : {}),
      });
      callId = call.callId;
      addToCallContext({ callId });
      timing.mark("record");
      // The instructions the call's voice model starts with, for its AI debug trace (ADR 0009). The call doesn't wait for it.
      void recordAiTrace(domain, { businessId: access.businessId, kind: "voice_session", channel: "web_voice", callId, ...(call.conversationId ? { conversationId: call.conversationId } : {}), model: sessionConfig.model, snapshot, instructions: sessionConfig.instructions ?? undefined }).catch((error: unknown) => logEvent("warn", "live.ai_trace_unsaved", { errorType: error instanceof Error ? error.name : typeof error }));
      await Promise.all([
        access.prospectDemoId ? recordProspectDemoCallStarted(domain, { businessId: access.businessId, prospectDemoId: access.prospectDemoId, callId, channel: "web_voice", provider: "openai_live" }) : undefined,
        attachWorkerToLiveSession({
          sessionId,
          businessId: access.businessId,
          callId,
          ...(call.conversationId ? { conversationId: call.conversationId } : {}),
          channel: "web_voice",
          ...(call.maxDurationMs ? { maxDurationMs: call.maxDurationMs } : {}),
          ...(access.prospectDemoId ? { intakeOnly: true } : {}),
          ...(recordedGreeting ? { recordedGreeting } : {}),
        }),
      ]);
      timing.mark("attach");
      // Where the wait before the call connects went, for the logs.
      logEvent("info", "live.browser_start", { widgetId: access.widgetId, ...timing.stages(), ...(recordedGreeting ? { greetingRecording: recordedGreeting.play } : {}) });
      return NextResponse.json({ sessionId, endToken: liveSessionEndToken(sessionId), sdp: live.transport.sdp, ...(call.maxDurationMs ? { maxDurationMs: call.maxDurationMs } : {}) }, { status: 201, headers: { ...cors, "server-timing": timing.header() } });
    } catch (error) {
      // The session exists at OpenAI; end it so nothing talks or bills without us.
      // The worker may be the reason the start failed, so OpenAI's own hangup
      // is the fallback.
      await endLiveBrowserSession(sessionId)
        .catch(() => client.live.sessions.hangup(sessionId))
        .catch((endError: unknown) => logEvent("error", "live.browser_start_cleanup_failed", { error: endError }));
      // OpenAI bills 15 seconds for creating a WebRTC session, even one that never starts.
      if (callId) await finishLiveCall(domain, { businessId: access.businessId, callId, seconds: WEBRTC_CREATION_SECONDS, measuredSeconds: 0, end: "setup_failed", channel: "web_voice" }).catch(() => undefined);
      if (access.prospectDemoId) await recordProspectDemoCallError(domain, { businessId: access.businessId, prospectDemoId: access.prospectDemoId, ...(callId ? { callId } : {}), reason: "web_call_start_failed" }).catch(() => undefined);
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (code === "voice_limit_reached") return denied(402, code, cors);
      throw error;
    }
  } catch (error) {
    const response = asApiResponse(error);
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  }
}
