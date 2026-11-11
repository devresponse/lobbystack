import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ redis: { eval: vi.fn() } as { eval: ReturnType<typeof vi.fn> } | undefined }));
vi.mock("./redis", () => ({ readyRedis: async () => mocks.redis, closeRedis: vi.fn() }));

import { clientIpDigest, enforceFixedWindow, fixedWindowLimit, type FixedWindowLimit } from "./fixed-window-limit";

const limits: FixedWindowLimit[] = [
  { name: "minute", key: "k:minute", limit: 2, windowSeconds: 60, reason: "rate_limit_minute" },
  { name: "day", key: "k:day", limit: 5, windowSeconds: 86_400, reason: "rate_limit_day" },
];

// Mirrors the Lua script: check every counter, then INCR all and EXPIRE on the first increment.
function memoryEval(store: Map<string, number>, ttls: Map<string, number>) {
  return async (_script: string, numKeys: number, ...rest: string[]) => {
    const keys = rest.slice(0, numKeys);
    const argv = rest.slice(numKeys);
    for (const [index, key] of keys.entries()) {
      if ((store.get(key) ?? 0) >= Number(argv[index * 2])) return index + 1;
    }
    for (const [index, key] of keys.entries()) {
      const count = (store.get(key) ?? 0) + 1;
      store.set(key, count);
      if (count === 1) ttls.set(key, Number(argv[index * 2 + 1]));
    }
    return 0;
  };
}

beforeEach(() => {
  mocks.redis = { eval: vi.fn() };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("fixedWindowLimit", () => {
  it("names the counter by its namespace, name, key as it is and current window", () => {
    const now = Date.UTC(2026, 10, 11, 5, 30);
    vi.useFakeTimers({ now });
    vi.stubEnv("REDIS_PREFIX", "test1");
    const id = "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f";
    expect(fixedWindowLimit("promo-code", "user-hour", id, 20, 3_600, "rate_limit_user_hour")).toEqual({
      name: "user-hour",
      key: `test1:promo-code:user-hour:${id}:${Math.floor(now / 3_600_000)}`,
      limit: 20,
      windowSeconds: 3_600,
      reason: "rate_limit_user_hour",
    });
  });

  it("keeps an IP address out of Redis by its plain SHA-256 digest", () => {
    // A plain SHA-256 of the address, so an address's counters made before still count.
    expect(clientIpDigest("203.0.113.10")).toBe("631f08140b24b7274d12df3c37a1a80ce5876dafd7007d772e0114fddf88b682");
    expect(clientIpDigest("203.0.113.11")).not.toBe(clientIpDigest("203.0.113.10"));
    expect(fixedWindowLimit("promo-code", "ip-hour", clientIpDigest("203.0.113.10"), 20, 3_600, "rate_limit_ip_hour").key).not.toContain("203.0.113.10");
  });
});

describe("enforceFixedWindow", () => {
  it("passes keys in order and a [limit, windowSeconds + 1] ARGV pair per key", async () => {
    mocks.redis!.eval.mockResolvedValueOnce(0);
    await expect(enforceFixedWindow(limits)).resolves.toEqual({ allowed: true });
    expect(mocks.redis!.eval).toHaveBeenCalledWith(expect.any(String), 2, "k:minute", "k:day", "2", "61", "5", "86401");
  });

  it("maps the blocked index to that limit's reason", async () => {
    mocks.redis!.eval.mockResolvedValueOnce(2);
    await expect(enforceFixedWindow(limits)).resolves.toEqual({ allowed: false, status: 429, reason: "rate_limit_day" });
  });

  it("counts against every key, sets the TTL once, and charges nothing for a rejected request", async () => {
    const store = new Map<string, number>();
    const ttls = new Map<string, number>();
    mocks.redis!.eval.mockImplementation(memoryEval(store, ttls));
    await enforceFixedWindow(limits);
    await enforceFixedWindow(limits);
    await expect(enforceFixedWindow(limits)).resolves.toEqual({ allowed: false, status: 429, reason: "rate_limit_minute" });
    expect(Object.fromEntries(store)).toEqual({ "k:minute": 2, "k:day": 2 });
    expect(Object.fromEntries(ttls)).toEqual({ "k:minute": 61, "k:day": 86_401 });
  });

  it("rejects with 503 in production when REDIS_URL is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REDIS_URL", "");
    mocks.redis = undefined;
    await expect(enforceFixedWindow(limits)).resolves.toEqual({ allowed: false, status: 503, reason: "rate_limit_unavailable" });
  });

  it("allows requests in development when REDIS_URL is unset", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("REDIS_URL", "");
    mocks.redis = undefined;
    await expect(enforceFixedWindow(limits)).resolves.toEqual({ allowed: true });
  });
});
