import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultWidgetConfig, widgetConfigSchema } from "@lobbystack/shared";

const lookups = vi.hoisted(() => ({
  keys: [] as Array<{ business_id: string; widget_key_id: string }>,
  rows: [] as Array<{ config: unknown }>,
}));

vi.mock("./api-helpers", () => ({
  getWorkerDatabase: () => ({ db: { execute: async () => ({ rows: lookups.keys }) } }),
}));
vi.mock("@lobbystack/db", async (importOriginal) => {
  // The key's row, read through a transaction's select chain.
  const query = { from: () => query, where: () => query, limit: async () => lookups.rows };
  return {
    ...(await importOriginal<typeof import("@lobbystack/db")>()),
    withBusinessTransaction: async (_db: unknown, _context: unknown, run: (tx: unknown) => unknown) => await run({ select: () => query }),
  };
});

import { createReceptionistPageToken, createWidgetSessionToken, hashWidgetKey, isAllowedWidgetOrigin, isPublicProfileWidgetOrigin, loadWidgetAppearance, normalizeOrigin, normalizeAllowedOrigins, requestIpHash, serializeWidgetKeyConfig, verifyReceptionistPageToken, verifyWidgetSessionToken } from "./widget-keys";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("widget key hashing and origin policy", () => {
  it("hashes widget keys deterministically", () => {
    expect(hashWidgetKey("wk_live_abc")).toBe(hashWidgetKey("  wk_live_abc  "));
    expect(hashWidgetKey("wk_live_abc")).not.toBe(hashWidgetKey("wk_live_abd"));
  });

  it("hashes every address in one IPv6 /64 as one client", () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
    const hash = (ip: string) => requestIpHash(new Request("https://app.example.test", { headers: { "x-real-ip": ip } }));
    expect(hash("2001:db8::1")).toBe(hash("2001:db8::abcd:2"));
    expect(hash("2001:db8::1")).not.toBe(hash("2001:db8:0:1::1"));
    expect(hash("203.0.113.10")).not.toBe(hash("203.0.113.11"));
  });

  it("normalizes origins, stripping trailing slashes", () => {
    expect(normalizeOrigin("https://example.com/")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com:8443")).toBe("https://example.com:8443");
    expect(normalizeAllowedOrigins(["https://a.com", "https://a.com/", 42, "https://b.com"])).toEqual(new Set(["https://a.com", "https://b.com"]));
  });

  it("mirrors the static web voice allowlist and trusts the admin origin for the iframe", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_BASE_URL", "https://app.lobbystack.com");
    const allowed = ["https://example.com", "https://www.example.com"];
    expect(isAllowedWidgetOrigin("https://example.com", allowed)).toBe(true);
    expect(isAllowedWidgetOrigin("https://example.com/", allowed)).toBe(true);
    expect(isAllowedWidgetOrigin("https://evil.com", allowed)).toBe(false);
    expect(isAllowedWidgetOrigin("http://localhost:3000", allowed)).toBe(true);
    expect(isAllowedWidgetOrigin("https://app.lobbystack.com", allowed)).toBe(true);
  });

  it("lets a widget run on its business's published profile page, on the deployment's own domain", () => {
    vi.stubEnv("APP_BASE_URL", "https://app.alloplace.com");
    const published = { published: true, widgetKeyId: "key_1" };
    expect(isPublicProfileWidgetOrigin("https://app.alloplace.com", published, "key_1")).toBe(true);
    expect(isPublicProfileWidgetOrigin("https://app.alloplace.com/", published, "key_1")).toBe(true);
    // Another widget, a page that isn't published or doesn't exist, or another site.
    expect(isPublicProfileWidgetOrigin("https://app.alloplace.com", published, "key_2")).toBe(false);
    expect(isPublicProfileWidgetOrigin("https://app.alloplace.com", { published: false, widgetKeyId: "key_1" }, "key_1")).toBe(false);
    expect(isPublicProfileWidgetOrigin("https://app.alloplace.com", { published: null, widgetKeyId: null }, "key_1")).toBe(false);
    expect(isPublicProfileWidgetOrigin("https://app.alloplace.com", null, "key_1")).toBe(false);
    expect(isPublicProfileWidgetOrigin("https://evil.example", published, "key_1")).toBe(false);
    // A sandboxed page sends the origin "null", which must never match.
    vi.stubEnv("APP_BASE_URL", "localhost:3000");
    expect(isPublicProfileWidgetOrigin("null", published, "key_1")).toBe(false);
    vi.stubEnv("APP_BASE_URL", "");
    expect(isPublicProfileWidgetOrigin("", published, "key_1")).toBe(false);
  });

  it("serializes config with defaults and strict schema output", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("APP_BASE_URL", "");
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      status: "active",
      label: "Site",
      allowedOrigins: ["https://example.com/"],
      config: { color: "#123456" },
      lastUsedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const key = serializeWidgetKeyConfig(row);
    expect(key.config.color).toBe("#123456");
    expect(key.config.position).toBe(defaultWidgetConfig.position);
    expect(key.allowedOrigins).toEqual(["https://example.com"]);
    expect(widgetConfigSchema.safeParse(key.config).success).toBe(true);
  });

  it("binds signed sessions to the visitor and normalized parent origin", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WIDGET_SESSION_SECRET", "session-secret");
    const created = createWidgetSessionToken({
      widgetKeyId: "00000000-0000-4000-8000-000000000010",
      businessId: "00000000-0000-4000-8000-000000000011",
      visitorId: "00000000-0000-4000-8000-000000000012",
      origin: "https://example.com/",
    });
    expect(verifyWidgetSessionToken(created.token)).toMatchObject({
      widgetKeyId: "00000000-0000-4000-8000-000000000010",
      businessId: "00000000-0000-4000-8000-000000000011",
      visitorId: "00000000-0000-4000-8000-000000000012",
      origin: "https://example.com",
    });
  });

  it("rejects expired or tampered widget sessions", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WIDGET_SESSION_SECRET", "session-secret");
    const expired = createWidgetSessionToken({
      widgetKeyId: "00000000-0000-4000-8000-000000000010",
      businessId: "00000000-0000-4000-8000-000000000011",
      visitorId: "00000000-0000-4000-8000-000000000012",
      origin: "https://example.com",
      ttlSeconds: -1,
    });
    expect(verifyWidgetSessionToken(expired.token)).toBeNull();
    expect(verifyWidgetSessionToken(`${expired.token.slice(0, -1)}x`)).toBeNull();
  });
});

describe("the receptionist a page names for its chat", () => {
  const BUSINESS = "00000000-0000-4000-8000-000000000011";
  const KEY = "00000000-0000-4000-8000-000000000010";
  const RECEPTIONIST = "00000000-0000-4000-8000-0000000000aa";
  const session = { widgetKeyId: KEY, businessId: BUSINESS, visitorId: "00000000-0000-4000-8000-000000000012", origin: "https://app.example.com" };

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WIDGET_SESSION_SECRET", "session-secret");
  });

  it("carries the receptionist in the chat's session when the page named one", () => {
    const created = createWidgetSessionToken({ ...session, receptionistId: RECEPTIONIST });
    expect(verifyWidgetSessionToken(created.token)).toMatchObject({ ...session, receptionistId: RECEPTIONIST });
    expect(verifyWidgetSessionToken(createWidgetSessionToken(session).token)).not.toHaveProperty("receptionistId");
  });

  it("refuses a session whose receptionist isn't an id, however it was signed", () => {
    const created = createWidgetSessionToken({ ...session, receptionistId: "front-desk" });
    expect(verifyWidgetSessionToken(created.token)).toBeNull();
  });

  it("signs the page's token for one business, widget and receptionist, for 30 days", () => {
    vi.useFakeTimers({ now: new Date("2026-11-03T12:00:00Z"), toFake: ["Date"] });
    try {
      const token = createReceptionistPageToken({ businessId: BUSINESS, widgetKeyId: KEY, receptionistId: RECEPTIONIST.toUpperCase() });
      expect(verifyReceptionistPageToken(token)).toEqual({
        v: 1,
        purpose: "receptionist_page",
        businessId: BUSINESS,
        widgetKeyId: KEY,
        receptionistId: RECEPTIONIST,
        exp: Math.floor(Date.parse("2026-12-03T12:00:00Z") / 1000),
      });
      vi.setSystemTime(new Date("2026-12-03T12:00:01Z"));
      expect(verifyReceptionistPageToken(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a tampered page token, or one signed with another secret", () => {
    const token = createReceptionistPageToken({ businessId: BUSINESS, widgetKeyId: KEY, receptionistId: RECEPTIONIST });
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, purpose: "receptionist_page", businessId: BUSINESS, widgetKeyId: KEY, receptionistId: "00000000-0000-4000-8000-0000000000bb", exp: 4_102_444_800 })).toString("base64url");
    expect(verifyReceptionistPageToken(`${header}.${forged}.${signature}`)).toBeNull();
    expect(verifyReceptionistPageToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(verifyReceptionistPageToken("not-a-token")).toBeNull();
    vi.stubEnv("WIDGET_SESSION_SECRET", "another-secret");
    expect(verifyReceptionistPageToken(token)).toBeNull();
  });

  it("never lets a page token pass for a chat's session, or a session for a page token", () => {
    const pageToken = createReceptionistPageToken({ businessId: BUSINESS, widgetKeyId: KEY, receptionistId: RECEPTIONIST });
    expect(verifyWidgetSessionToken(pageToken)).toBeNull();
    const sessionToken = createWidgetSessionToken({ ...session, receptionistId: RECEPTIONIST }).token;
    expect(verifyReceptionistPageToken(sessionToken)).toBeNull();
  });
});

describe("what the loader takes from the dashboard", () => {
  beforeEach(() => {
    lookups.keys = [{ business_id: "00000000-0000-4000-8000-000000000011", widget_key_id: "00000000-0000-4000-8000-000000000010" }];
  });

  it("sends the bubble look without a language when the key sets none, so the chat follows the visitor's browser", async () => {
    lookups.rows = [{ config: { color: "#112233" } }];
    await expect(loadWidgetAppearance("wk_live_abc")).resolves.toEqual({ color: "#112233" });
    lookups.rows = [{ config: {} }];
    await expect(loadWidgetAppearance("wk_live_abc")).resolves.toEqual({});
  });

  it("sends the language the key sets", async () => {
    lookups.rows = [{ config: { localeOverride: "es", position: "bottom-left" } }];
    await expect(loadWidgetAppearance("wk_live_abc")).resolves.toEqual({ position: "bottom-left", locale: "es" });
  });

  it("sends nothing for an unknown key", async () => {
    lookups.keys = [];
    await expect(loadWidgetAppearance("wk_live_unknown")).resolves.toBeNull();
  });
});
