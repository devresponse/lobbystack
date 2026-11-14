import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnstileError, verifyTurnstile } from "./turnstile";

const originalBaseUrl = process.env.APP_BASE_URL;
const originalSecret = process.env.TURNSTILE_SECRET_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalBaseUrl;
  if (originalSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = originalSecret;
});

describe("replacement Turnstile verification", () => {
  it("allows local development without a secret", async () => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    await expect(verifyTurnstile({})).resolves.toBeUndefined();
  });

  it("requires a token outside local development", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.com");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");

    await expect(verifyTurnstile({})).rejects.toThrow("required");
  });

  it("accepts a successful Cloudflare response", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.com");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyTurnstile({ token: "token", remoteIp: "203.0.113.10" })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("https://challenges.cloudflare.com/turnstile/v0/siteverify", expect.objectContaining({ method: "POST" }));
  });

  // The website chat's check (AUDIT-004) tries again only when Cloudflare couldn't be asked.
  describe("why a token didn't pass", () => {
    async function failure(): Promise<TurnstileError> {
      const error = await verifyTurnstile({ token: "token" }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(TurnstileError);
      return error as TurnstileError;
    }

    it("has no secret to check with", async () => {
      vi.stubEnv("APP_BASE_URL", "https://app.example.com");
      vi.stubEnv("TURNSTILE_SECRET_KEY", "");
      expect((await failure()).reason).toBe("not_configured");
    });

    it("got no token", async () => {
      vi.stubEnv("APP_BASE_URL", "https://app.example.com");
      vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
      const error = await verifyTurnstile({ token: "  " }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason: "missing" });
    });

    it.each([
      ["a token Cloudflare turned down", () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 }), "rejected"],
      ["a token used before", () => new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }), { status: 200 }), "rejected"],
      ["a request Cloudflare refused", () => new Response("Bad request", { status: 400 }), "rejected"],
      ["Cloudflare's own failure", () => new Response(JSON.stringify({ success: false, "error-codes": ["internal-error"] }), { status: 200 }), "unavailable"],
      ["a server error", () => new Response("Unavailable", { status: 503 }), "unavailable"],
      ["too many requests", () => new Response("Slow down", { status: 429 }), "unavailable"],
      ["an answer that isn't JSON", () => new Response("<html>", { status: 200 }), "unavailable"],
    ] as const)("tells %s apart", async (_label, answer, reason) => {
      vi.stubEnv("APP_BASE_URL", "https://app.example.com");
      vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => answer()));
      expect((await failure()).reason).toBe(reason);
    });

    it("counts a request that never reached Cloudflare as unavailable", async () => {
      vi.stubEnv("APP_BASE_URL", "https://app.example.com");
      vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
      expect((await failure()).reason).toBe("unavailable");
    });
  });
});
