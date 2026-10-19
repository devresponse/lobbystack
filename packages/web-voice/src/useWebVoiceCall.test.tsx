// @vitest-environment jsdom

import { createElement, useEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendTranscriptDelta, readSessionClosedReason, readTranscriptDelta, useWebVoiceCall } from "./useWebVoiceCall";

type HookControls = ReturnType<typeof useWebVoiceCall>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function createMockMediaStream(trackStop: ReturnType<typeof vi.fn>) {
  const track = { stop: trackStop } as unknown as MediaStreamTrack;
  const tracks = [track];

  return {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

function HookHarness(props: {
  endpoint: string;
  onReady: (controls: HookControls) => void;
}) {
  const { endpoint, onReady } = props;
  const controls = useWebVoiceCall({
    businessSlug: "acme-dental",
    endpoint,
  });

  useEffect(() => {
    onReady(controls);
  }, [controls, onReady]);

  return null;
}

describe("useWebVoiceCall", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops a pending start call when the dialog is dismissed before media access resolves", async () => {
    const getUserMediaDeferred = createDeferred<MediaStream>();
    const getUserMediaMock = vi.fn(() => getUserMediaDeferred.promise);
    const trackStop = vi.fn();
    const localStream = createMockMediaStream(trackStop);
    const peerConnectionInstance = {
      addTrack: vi.fn(),
      close: vi.fn(),
      connectionState: "new",
      createOffer: vi.fn(async () => ({ sdp: "offer-sdp" })),
      onconnectionstatechange: null,
      ontrack: null,
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
    } as unknown as RTCPeerConnection;
    const peerConnectionMock = vi.fn(() => peerConnectionInstance);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ sessionId: "session-123", sdp: "answer-sdp" }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("RTCPeerConnection", peerConnectionMock);
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        getUserMedia: getUserMediaMock,
      },
    });

    let controls: HookControls | null = null;
    render(
      createElement(HookHarness, {
        endpoint: "https://app.example.com/api/voice/live/session",
        onReady: (nextControls) => {
          controls = nextControls;
        },
      }),
    );

    await waitFor(() => {
      expect(controls).not.toBeNull();
    });

    const startPromise = controls!.startCall();

    await waitFor(() => {
      expect(controls?.status).toBe("requesting_microphone");
    });

    await act(async () => {
      await controls!.forceEndCall();
    });

    getUserMediaDeferred.resolve(localStream);

    await act(async () => {
      await startPromise;
    });

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(peerConnectionMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("live captions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds caption turns from the transcript deltas on the data channel", async () => {
    const channel = { readyState: "open", send: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
    const peerConnectionInstance = {
      addTrack: vi.fn(),
      close: vi.fn(),
      connectionState: "new",
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ sdp: "offer-sdp" })),
      iceGatheringState: "complete",
      localDescription: { sdp: "offer-sdp" },
      onconnectionstatechange: null,
      ontrack: null,
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
    } as unknown as RTCPeerConnection;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sessionId: "session-123", endToken: "end", sdp: "answer-sdp" })));
    vi.stubGlobal("RTCPeerConnection", vi.fn(function () { return peerConnectionInstance; }));
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => createMockMediaStream(vi.fn())) } });

    let controls: HookControls | null = null;
    render(createElement(HookHarness, { endpoint: "https://app.example.com/api/voice/live/session", onReady: (next) => { controls = next; } }));
    await waitFor(() => expect(controls).not.toBeNull());
    await act(async () => {
      await controls!.startCall();
    });
    expect(channel.onmessage).toBeTypeOf("function");

    const deliver = (event: Record<string, unknown>) => act(() => channel.onmessage!(new MessageEvent("message", { data: JSON.stringify(event) })));
    deliver({ type: "session.output_transcript.delta", delta: "Hi, how can" });
    deliver({ type: "session.output_transcript.delta", delta: " I help?" });
    deliver({ type: "session.input_transcript.delta", delta: "Are you open" });
    deliver({ type: "session.input_transcript.delta", delta: " Sunday?" });
    deliver({ type: "session.delegation.created" });

    expect(controls!.transcript).toEqual([
      { speaker: "assistant", text: "Hi, how can I help?" },
      { speaker: "caller", text: "Are you open Sunday?" },
    ]);
  });

  // GPT-Live writes no transcript for the greeting's recording.
  it("captions the greeting's recording once the call connects", async () => {
    const channel = { readyState: "open", send: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
    const peerConnectionInstance = {
      addTrack: vi.fn(),
      close: vi.fn(),
      connectionState: "new",
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ sdp: "offer-sdp" })),
      iceGatheringState: "complete",
      localDescription: { sdp: "offer-sdp" },
      onconnectionstatechange: null as (() => void) | null,
      ontrack: null,
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sessionId: "session-123", endToken: "end", sdp: "answer-sdp", greeting: "Thanks for calling Strata. " })));
    vi.stubGlobal("RTCPeerConnection", vi.fn(function () { return peerConnectionInstance; }));
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => createMockMediaStream(vi.fn())) } });

    let controls: HookControls | null = null;
    render(createElement(HookHarness, { endpoint: "https://app.example.com/api/voice/live/session", onReady: (next) => { controls = next; } }));
    await waitFor(() => expect(controls).not.toBeNull());
    await act(async () => {
      await controls!.startCall();
    });
    expect(controls!.transcript).toEqual([]);

    peerConnectionInstance.connectionState = "connected";
    act(() => peerConnectionInstance.onconnectionstatechange!());
    expect(controls!.status).toBe("connected");
    expect(controls!.transcript).toEqual([{ speaker: "assistant", text: "Thanks for calling Strata.", recorded: true }]);

    const deliver = (event: Record<string, unknown>) => act(() => channel.onmessage!(new MessageEvent("message", { data: JSON.stringify(event) })));
    deliver({ type: "session.input_transcript.delta", delta: "Are you open Sunday?" });
    deliver({ type: "session.output_transcript.delta", delta: "We're closed Sundays." });
    expect(controls!.transcript.map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: "assistant", text: "Thanks for calling Strata." },
      { speaker: "caller", text: "Are you open Sunday?" },
      { speaker: "assistant", text: "We're closed Sundays." },
    ]);
  });

  it("replaces the recording's words when the receptionist speaks before the caller", () => {
    const recorded = [{ speaker: "assistant" as const, text: "Thanks for calling Strata.", recorded: true }];
    // A blank delta changes nothing.
    expect(appendTranscriptDelta(recorded, { speaker: "assistant", delta: " " })).toEqual(recorded);
    // The recording didn't play, so GPT-Live said the greeting itself.
    const spoken = appendTranscriptDelta(recorded, { speaker: "assistant", delta: "Thanks for" });
    expect(spoken).toEqual([{ speaker: "assistant", text: "Thanks for" }]);
    expect(appendTranscriptDelta(spoken, { speaker: "assistant", delta: " calling Strata." })).toEqual([{ speaker: "assistant", text: "Thanks for calling Strata." }]);
    expect(appendTranscriptDelta(recorded, { speaker: "caller", delta: "Hi" })).toEqual([...recorded, { speaker: "caller", text: "Hi" }]);
  });

  it("reads only the caller's and the receptionist's transcript deltas", () => {
    expect(readTranscriptDelta(JSON.stringify({ type: "session.input_transcript.delta", delta: "hello" }))).toEqual({ speaker: "caller", delta: "hello" });
    expect(readTranscriptDelta(JSON.stringify({ type: "session.output_transcript.delta", delta: "hi" }))).toEqual({ speaker: "assistant", delta: "hi" });
    expect(readTranscriptDelta(JSON.stringify({ type: "session.output_transcript.delta", delta: "" }))).toBeUndefined();
    expect(readTranscriptDelta(JSON.stringify({ type: "session.commentary.appended", delta: "_transcript.delta" }))).toBeUndefined();
    expect(readTranscriptDelta("session.input_transcript.delta")).toBeUndefined();
    expect(readTranscriptDelta(new ArrayBuffer(8))).toBeUndefined();
  });

  it("grows the current speaker's turn and ignores a blank delta from the other speaker", () => {
    const turns = appendTranscriptDelta([{ speaker: "assistant", text: "We open" }], { speaker: "caller", delta: " " });
    expect(turns).toEqual([{ speaker: "assistant", text: "We open" }]);
    expect(appendTranscriptDelta(turns, { speaker: "assistant", delta: " at nine." })).toEqual([{ speaker: "assistant", text: "We open at nine." }]);
    expect(appendTranscriptDelta(turns, { speaker: "caller", delta: "Thanks" })).toEqual([{ speaker: "assistant", text: "We open" }, { speaker: "caller", text: "Thanks" }]);
  });
});

describe("readSessionClosedReason", () => {
  it("reads the reason from session.closed and ignores every other event", () => {
    expect(readSessionClosedReason(JSON.stringify({ type: "session.closed", reason: "close_requested" }))).toBe("close_requested");
    expect(readSessionClosedReason(JSON.stringify({ type: "session.closed" }))).toBe("unknown");
    expect(readSessionClosedReason(JSON.stringify({ type: "session.input_transcript.delta", delta: "my session.closed question" }))).toBeUndefined();
    expect(readSessionClosedReason("session.closed")).toBeUndefined();
    expect(readSessionClosedReason(new ArrayBuffer(8))).toBeUndefined();
  });
});
