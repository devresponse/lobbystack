import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({ capture: vi.fn().mockResolvedValue(undefined) }));
vi.mock("posthog-node", () => ({ PostHog: class { captureExceptionImmediate = posthog.capture; } }));

import { addToCallContext, currentCallContext, forceFlushTelemetryLogs, initializeTelemetry, logEvent, reportError, reportWarning, shutdownTelemetry, withCallContext, withOpenSpan, withSpan } from "./node";

// Digit runs like these used to look like phone numbers to the exporter.
const CALL_ID = "12345678-1234-4234-8234-123456789012";
const SESSION_ID = "rtc_u1_20261009123456789";

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  posthog.capture.mockClear();
  await shutdownTelemetry();
});

function lines(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

async function withReceiver(run: (endpoint: string, bodies: { logs: string[]; traces: string[] }) => Promise<void>): Promise<void> {
  const bodies = { logs: [] as string[], traces: [] as string[] };
  const receiver = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (request.url === "/v1/logs") bodies.logs.push(body);
    if (request.url === "/v1/traces") bodies.traces.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(0, "127.0.0.1", resolve);
  });
  const address = receiver.address();
  if (!address || typeof address === "string") throw new Error("OTLP test receiver did not start.");
  try {
    await run(`http://127.0.0.1:${address.port}`, bodies);
  } finally {
    await shutdownTelemetry();
    await new Promise<void>((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve()));
  }
}

type ExportedLog = { severityText: string | undefined; body: string | undefined; attributes: Record<string, unknown> };

/** The log records the receiver got, with each attribute's value unwrapped. */
function exportedLogs(bodies: string[]): ExportedLog[] {
  type Payload = { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: Array<{ severityText?: string; body?: { stringValue?: string }; attributes?: Array<{ key: string; value: Record<string, unknown> }> }> }> }> };
  return bodies
    .flatMap((body) => (JSON.parse(body) as Payload).resourceLogs ?? [])
    .flatMap((resource) => resource.scopeLogs ?? [])
    .flatMap((scope) => scope.logRecords ?? [])
    .map((record) => ({ severityText: record.severityText, body: record.body?.stringValue, attributes: Object.fromEntries((record.attributes ?? []).map(({ key, value }) => [key, Object.values(value)[0]])) }));
}

describe("call context", () => {
  it("prints one JSON line with the call's IDs and a redacted error", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    withCallContext({ sessionId: SESSION_ID, businessId: "biz_1" }, () => {
      logEvent("info", "live.incoming", { routedBy: "to" });
      addToCallContext({ callId: CALL_ID });
      logEvent("error", "live.delegation_failed", { delegationId: "del_1", error: new Error("caller +14165551234 at person@example.com") });
    });
    logEvent("info", "outside");

    expect(lines(info)).toEqual([
      { level: "info", message: "live.incoming", sessionId: SESSION_ID, businessId: "biz_1", routedBy: "to" },
      { level: "info", message: "outside" },
    ]);
    expect(lines(error)).toEqual([
      { level: "error", message: "live.delegation_failed", sessionId: SESSION_ID, businessId: "biz_1", callId: CALL_ID, delegationId: "del_1", error: "caller [redacted-phone] at [redacted-email]" },
    ]);
  });

  it("keeps the IDs in timers and promises the call starts, and nests contexts", async () => {
    await withCallContext({ sessionId: SESSION_ID }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentCallContext()).toEqual({ sessionId: SESSION_ID });
      withCallContext({ callId: CALL_ID }, () => {
        expect(currentCallContext()).toEqual({ sessionId: SESSION_ID, callId: CALL_ID });
      });
      expect(currentCallContext()).toEqual({ sessionId: SESSION_ID });
    });
    expect(currentCallContext()).toEqual({});
  });

  it("tags exported spans and logs with the call's IDs, unredacted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withReceiver(async (endpoint, bodies) => {
      await initializeTelemetry({ endpoint, serviceName: "lobbystack-test" });
      await withCallContext({ sessionId: SESSION_ID, businessId: "biz_1" }, async () => {
        await withOpenSpan("live.call", {}, async (callSpan) => {
          addToCallContext({ callId: CALL_ID });
          await withSpan("db.transaction", {}, async () => {
            logEvent("warn", "live.attach_retry", { closeCode: 1006 });
            console.error("[domain] lookup failed");
          });
          callSpan.end();
        });
      });
      await forceFlushTelemetryLogs();
      await shutdownTelemetry();

      const traces = bodies.traces.join("\n");
      expect(traces).toContain("live.call");
      expect(traces).toContain("db.transaction");
      expect(traces.split(CALL_ID).length - 1).toBeGreaterThanOrEqual(2);
      expect(traces).toContain("lobbystack.session_id");
      expect(traces).toContain(SESSION_ID);
      const logs = bodies.logs.join("\n");
      expect(logs).toContain("live.attach_retry");
      expect(logs).toContain("[domain] lookup failed");
      expect(logs).toContain(CALL_ID);
      expect(logs).toContain(SESSION_ID);
      expect(logs).not.toContain("[redacted-phone]");
      // The JSON line prints once and exports once, not again through the console forwarder.
      expect(logs).not.toContain("\\\"message\\\":\\\"live.attach_retry\\\"");
      const [line] = lines(warn);
      expect(line).toMatchObject({ level: "warn", message: "live.attach_retry", callId: CALL_ID, sessionId: SESSION_ID, closeCode: 1006 });
      expect(line?.traceId).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it("keeps a line's severity and event name when a field is called level or message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // As a provider's error body spread into the fields would arrive.
    const providerBody: Record<string, unknown> = { message: "Mailbox full", level: "fatal", fieldLevel: "taken" };
    await withReceiver(async (endpoint, bodies) => {
      await initializeTelemetry({ endpoint, serviceName: "lobbystack-test" });
      logEvent("warn", "ops.provider.refused", { businessId: "biz_1", ...providerBody });
      // @ts-expect-error A field written as `message` in the call doesn't compile.
      logEvent("warn", "business.cancellation_inbox_missing", { message: "Set the brand's contactEmail." });
      // @ts-expect-error Nor does one written as `level`.
      logEvent("warn", "ops.provider.refused", { level: "fatal" });
      await forceFlushTelemetryLogs();
      await shutdownTelemetry();

      expect(lines(warn)).toEqual([
        { level: "warn", message: "ops.provider.refused", businessId: "biz_1", fieldMessage: "Mailbox full", fieldLevel_: "fatal", fieldLevel: "taken" },
        { level: "warn", message: "business.cancellation_inbox_missing", fieldMessage: "Set the brand's contactEmail." },
        { level: "warn", message: "ops.provider.refused", fieldLevel: "fatal" },
      ]);
      // The export keeps both too, and masks the field as it does any key with "message" in its name.
      expect(exportedLogs(bodies.logs)[0]).toEqual({ severityText: "WARN", body: "ops.provider.refused", attributes: { businessId: "biz_1", fieldMessage: "[redacted]", fieldLevel_: "fatal", fieldLevel: "taken" } });
    });
  });

  it("reports an error once to PostHog with the call's IDs", async () => {
    vi.stubEnv("POSTHOG_KEY", "fixture");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await initializeTelemetry({ endpoint: "", serviceName: "lobbystack-worker" });
    const failure = new Error("Provider refused Bearer private-token for caller@example.com");

    await withCallContext({ callId: CALL_ID, sessionId: SESSION_ID }, async () => {
      await reportError(failure, { operation: "job.call.saveRecording", jobId: "job_1" });
      await reportError(failure, { operation: "job.call.saveRecording" });
    });

    expect(posthog.capture).toHaveBeenCalledTimes(1);
    const [safe, distinctId, properties] = posthog.capture.mock.calls[0]!;
    expect(distinctId).toBe("system:lobbystack-worker");
    expect(safe.message).not.toContain("private-token");
    expect(properties).toMatchObject({ operation: "job.call.saveRecording", jobId: "job_1", callId: CALL_ID, sessionId: SESSION_ID, service: "lobbystack-worker", alertable: true });
    expect(properties).not.toHaveProperty("$exception_level");
    expect(lines(error)).toEqual([expect.objectContaining({ level: "error", message: expect.stringMatching(/exception: Provider refused Bearer \[redacted\] for \[redacted-email\]$/), callId: CALL_ID, exceptionType: "Error", error: "Provider refused Bearer [redacted] for [redacted-email]" })]);
  });

  it("reports a warning to PostHog at warning level, without alerting or failing the span", async () => {
    vi.stubEnv("POSTHOG_KEY", "fixture");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await initializeTelemetry({ endpoint: "", serviceName: "lobbystack-worker" });
    const missing = new Error("Twilio call pricing is incomplete for CA123.");

    await withSpan("job.call.syncPrice", {}, async (span) => {
      const setStatus = vi.spyOn(span, "setStatus");
      await withCallContext({ callId: CALL_ID, sessionId: SESSION_ID }, async () => {
        await reportWarning(missing, { operation: "job.call.syncPrice", rechecks: 10 });
      });
      expect(setStatus).not.toHaveBeenCalled();
    });

    expect(posthog.capture).toHaveBeenCalledTimes(1);
    const [safe, distinctId, properties] = posthog.capture.mock.calls[0]!;
    expect(distinctId).toBe("system:lobbystack-worker");
    expect(safe.message).toBe("Twilio call pricing is incomplete for CA123.");
    expect(properties).toMatchObject({ operation: "job.call.syncPrice", rechecks: 10, callId: CALL_ID, sessionId: SESSION_ID, service: "lobbystack-worker", alertable: false, $exception_level: "warning" });
    expect(lines(warn)).toEqual([expect.objectContaining({ level: "warn", message: "[worker] warning: Twilio call pricing is incomplete for CA123.", callId: CALL_ID, exceptionType: "Error" })]);
    expect(error).not.toHaveBeenCalled();
  });
});
