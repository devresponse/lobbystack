import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({}) }));
vi.mock("better-auth/next-js", () => ({ toNextJsHandler: () => ({ GET: mocks.get, POST: mocks.post }) }));
vi.mock("@lobbystack/telemetry/node", async (original) => ({ ...await original<typeof import("@lobbystack/telemetry/node")>(), logEvent: mocks.log }));

import { GET, POST } from "../../app/api/auth/[...all]/route";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const limited = () => new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), { status: 429, headers: { "X-Retry-After": "30" } });

it("logs Better Auth's rate limit on sign-in and session reads, and passes the answer through", async () => {
  vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
  mocks.post.mockResolvedValue(limited());
  mocks.get.mockResolvedValue(limited());
  const signIn = await POST(new Request("https://app.example.test/api/auth/sign-in/email", { method: "POST", headers: { "x-real-ip": "203.0.113.20" }, body: "{}" }));
  const session = await GET(new Request("https://app.example.test/api/auth/get-session", { headers: { "x-real-ip": "203.0.113.20" } }));

  expect([signIn.status, session.status]).toEqual([429, 429]);
  expect(mocks.log.mock.calls).toEqual([
    ["warn", "auth.rate_limited", { path: "/sign-in/email", limit: "route", ip: "203.0.113.20", retryAfter: 30 }],
    ["warn", "auth.rate_limited", { path: "/get-session", limit: "route", ip: "203.0.113.20", retryAfter: 30 }],
  ]);
});
