import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { fetchWithTimeout, OUTBOUND_FETCH_TIMEOUT_MS } from "./index";

let server: Server | undefined;

/** A service that answers each path its own way: at once, never, or headers and then nothing. */
async function service(): Promise<string> {
  server = createServer((request, response) => {
    if (request.url === "/stalled") return;
    if (request.url === "/half") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{\"calendars\":");
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ method: request.method, sent: body, authorization: request.headers.authorization }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test service did not start.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  server = undefined;
});

describe("fetchWithTimeout", () => {
  it("gives a call 15 seconds unless its caller sets another limit", () => {
    expect(OUTBOUND_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("passes the request through and returns the answer", async () => {
    const origin = await service();
    const response = await fetchWithTimeout(`${origin}/token`, { method: "POST", headers: { authorization: "Bearer fixture" }, body: "grant_type=refresh_token" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: "POST", sent: "grant_type=refresh_token", authorization: "Bearer fixture" });
  });

  it("ends a call whose service never answers", async () => {
    const origin = await service();
    const startedAt = Date.now();
    await expect(fetchWithTimeout(`${origin}/stalled`, {}, 50)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("ends a call whose service sends the headers and then stalls on the body", async () => {
    const origin = await service();
    const response = await fetchWithTimeout(`${origin}/half`, {}, 50);
    expect(response.status).toBe(200);
    await expect(response.json()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("still ends the call when the caller's own signal aborts first", async () => {
    const origin = await service();
    const caller = new AbortController();
    const call = fetchWithTimeout(`${origin}/stalled`, { signal: caller.signal }, 5_000);
    caller.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
  });
});
