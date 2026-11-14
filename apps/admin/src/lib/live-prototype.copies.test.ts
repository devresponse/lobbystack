import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { attachWorkerToLiveSession, endLiveBrowserSession } from "./live-prototype";

// Two copies of a stand-in worker on one port, at 127.0.0.1 and 127.0.0.2, as Railway's private name lists one
// address for each copy. Real connections, through Node's own fetch, which keeps them open between calls: with one
// name for both, every call went to the first copy (the 2026-11-13 replicas review).
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

type Copy = { host: string; server: Server; attaches: number; refused: number; draining: boolean };

function standInWorker(host: string, port: number): Promise<Copy> {
  const copy: Copy = { host, server: createServer(), attaches: 0, refused: 0, draining: false };
  copy.server.on("request", (request, response) => {
    request.resume();
    request.on("end", () => {
      // As the worker's liveCalls.ts answers: a draining copy refuses a new call and closes the connection.
      if (copy.draining && request.url === "/internal/live/attach") {
        copy.refused += 1;
        response.writeHead(503, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ error: "This worker is shutting down." }));
        return;
      }
      if (request.url === "/internal/live/attach") copy.attaches += 1;
      response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve, reject) => {
    copy.server.once("error", reject);
    copy.server.listen(port, host, () => resolve(copy));
  });
}

let copies: Copy[] = [];
let port = 0;
// macOS answers only at 127.0.0.1 unless told otherwise; Linux and Windows answer at all of 127.0.0.0/8.
let skipReason = "";

beforeAll(async () => {
  const first = await standInWorker("127.0.0.1", 0);
  port = (first.server.address() as AddressInfo).port;
  try {
    copies = [first, await standInWorker("127.0.0.2", port)];
  } catch (error) {
    copies = [first];
    skipReason = `127.0.0.2 isn't available here (${(error as Error).message})`;
  }
});

afterAll(async () => {
  for (const copy of copies) {
    copy.server.closeAllConnections();
    await new Promise((resolve) => copy.server.close(resolve));
  }
});

beforeEach(() => {
  vi.stubEnv("INTERNAL_SERVICE_TOKEN", "token");
  vi.stubEnv("WORKER_INTERNAL_URL", `http://worker.railway.internal:${port}`);
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.2", family: 4 }]);
  for (const copy of copies) Object.assign(copy, { attaches: 0, refused: 0, draining: false });
});
afterEach(() => { vi.unstubAllEnvs(); });

const attach = (call: number) => attachWorkerToLiveSession({ sessionId: `live_${call}`, businessId: "biz_1", callId: `call_${call}`, channel: "voice" });

describe("two copies of the worker over real connections", () => {
  it("shares the calls between both copies", async ({ skip }) => {
    skip(Boolean(skipReason), skipReason);
    for (let call = 0; call < 40; call += 1) await attach(call);
    const [one, two] = copies;
    expect(one!.attaches + two!.attaches).toBe(40);
    expect(one!.attaches).toBeGreaterThan(5);
    expect(two!.attaches).toBeGreaterThan(5);
  });

  it("sends every call to the other copy at once while one is shutting down", async ({ skip }) => {
    skip(Boolean(skipReason), skipReason);
    const [one, two] = copies;
    // Connections to both copies are open from earlier calls, as on a running admin.
    for (let call = 0; call < 10; call += 1) await attach(call);
    one!.draining = true;
    two!.attaches = 0;
    const slowest = { ms: 0 };
    for (let call = 0; call < 20; call += 1) {
      const startedAt = performance.now();
      await attach(100 + call);
      slowest.ms = Math.max(slowest.ms, performance.now() - startedAt);
    }
    expect(two!.attaches).toBe(20);
    // About half the calls asked the draining copy first, and it turned them away.
    expect(one!.refused).toBeGreaterThan(0);
    // None waited the 250 ms a lone copy's refusal costs.
    expect(slowest.ms).toBeLessThan(250);
  });

  it("fails as before when both copies are shutting down, after waiting for a new one", async ({ skip }) => {
    skip(Boolean(skipReason), skipReason);
    for (const copy of copies) copy.draining = true;
    await expect(attach(1)).rejects.toThrow("Worker attach failed with status 503.");
    // Three rounds, each asking both copies.
    expect(copies.reduce((sum, copy) => sum + copy.refused, 0)).toBe(6);
    // A draining copy still ends sessions, so an end goes through.
    await expect(endLiveBrowserSession("live_1")).resolves.toBeUndefined();
  });
});
