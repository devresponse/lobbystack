import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({
  resolved: [] as Array<{ business_id: string; widget_key_id: string }>,
  key: [] as unknown[],
  business: [] as unknown[],
}));

vi.mock("./api-helpers", () => ({
  getWorkerDatabase: () => ({ db: { execute: async () => ({ rows: rows.resolved }) } }),
  jsonError: (message: string, status = 400, code?: string) => NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status }),
}));
vi.mock("@lobbystack/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lobbystack/db")>();
  // The key (with its business's profile page) and the business, read through a transaction's select chains.
  const chain = (result: unknown[]) => {
    const query = { leftJoin: () => query, where: () => query, limit: async () => result };
    return query;
  };
  const tx = { select: () => ({ from: (table: unknown) => chain(table === actual.widgetKeys ? rows.key : rows.business) }) };
  return { ...actual, withBusinessTransaction: async (_db: unknown, _context: unknown, run: (tx: unknown) => unknown) => await run(tx) };
});

import { resolveWidgetAccess, resolveWidgetSessionAccess } from "./widget-access";
import { createWidgetSessionToken } from "./widget-keys";

const app = "https://app.alloplace.com";

function keyRow(values: { status?: string; allowedOrigins?: string[]; profilePublished?: boolean | null; profileWidgetKeyId?: string | null } = {}) {
  const now = new Date("2026-10-16T12:00:00Z");
  return {
    key: { id: "key_1", businessId: "biz_1", keyHash: "hash", keyValue: "wk_live_abc", label: null, status: values.status ?? "active", allowedOrigins: values.allowedOrigins ?? ["https://acmedental.example"], config: {}, lastUsedAt: null, createdAt: now, updatedAt: now },
    profilePublished: values.profilePublished ?? null,
    profileWidgetKeyId: values.profileWidgetKeyId ?? null,
  };
}

/** A session request from a page at this origin, as the loader sends it. */
function sessionRequest(origin: string) {
  return new Request(`${app}/api/widget/session`, { method: "POST", headers: { origin } });
}

/** A chat request from the widget's frame, for the page the session was issued to. */
function chatRequest(origin: string) {
  const { token } = createWidgetSessionToken({ widgetKeyId: "key_1", businessId: "biz_1", visitorId: "visitor_1", origin });
  return new Request(`${app}/api/widget/chat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-widget-parent-origin": origin } });
}

async function codeOf(result: Awaited<ReturnType<typeof resolveWidgetAccess>>) {
  return result.ok ? "ok" : ((await result.response.json()) as { code: string }).code;
}

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", app);
  vi.stubEnv("NODE_ENV", "test");
  rows.resolved = [{ business_id: "biz_1", widget_key_id: "key_1" }];
  rows.business = [{ name: "Acme Dental", slug: "acme-dental", defaultLocale: "en" }];
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("where a widget may run", () => {
  it("carries the business's language, or English when calls can't open in the stored one", async () => {
    rows.key = [keyRow()];
    for (const [stored, expected] of [["ja", "ja"], ["fr", "fr"], ["sr", "en"]]) {
      rows.business = [{ name: "Acme Dental", slug: "acme-dental", defaultLocale: stored }];
      const access = await resolveWidgetAccess(sessionRequest("https://acmedental.example"), "wk_live_abc", { requireOrigin: true, strictOrigin: true });
      expect(access.ok && access.session.defaultLocale, stored).toBe(expected);
    }
  });

  it("starts a session on one of the key's websites", async () => {
    rows.key = [keyRow()];
    const access = await resolveWidgetAccess(sessionRequest("https://acmedental.example"), "wk_live_abc", { requireOrigin: true, strictOrigin: true });
    expect(access).toMatchObject({ ok: true, session: { businessId: "biz_1", widgetKeyId: "key_1", businessSlug: "acme-dental", origin: "https://acmedental.example" } });
    expect(access.ok && Object.keys(access.session)).not.toContain("profile");
  });

  it("starts a session on its business's published profile page, which uses this widget", async () => {
    rows.key = [keyRow({ profilePublished: true, profileWidgetKeyId: "key_1" })];
    expect(await codeOf(await resolveWidgetAccess(sessionRequest(app), "wk_live_abc", { requireOrigin: true, strictOrigin: true }))).toBe("ok");
    expect(await codeOf(await resolveWidgetSessionAccess(chatRequest(app)))).toBe("ok");
  });

  it.each([
    ["the page isn't published", { profilePublished: false, profileWidgetKeyId: "key_1" }],
    ["the page shows another widget", { profilePublished: true, profileWidgetKeyId: "key_9" }],
    ["the business has no page", {}],
  ])("refuses the dashboard's domain when %s", async (_case, profile) => {
    rows.key = [keyRow(profile)];
    expect(await codeOf(await resolveWidgetAccess(sessionRequest(app), "wk_live_abc", { requireOrigin: true, strictOrigin: true }))).toBe("widget_origin_denied");
    expect(await codeOf(await resolveWidgetSessionAccess(chatRequest(app)))).toBe("widget_origin_denied");
  });

  it("refuses a paused widget, even on its profile page", async () => {
    rows.key = [keyRow({ status: "disabled", profilePublished: true, profileWidgetKeyId: "key_1" })];
    expect(await codeOf(await resolveWidgetAccess(sessionRequest(app), "wk_live_abc", { requireOrigin: true, strictOrigin: true }))).toBe("widget_disabled");
    expect(await codeOf(await resolveWidgetSessionAccess(chatRequest(app)))).toBe("widget_disabled");
  });

  it("refuses other websites, published profile page or not", async () => {
    rows.key = [keyRow({ profilePublished: true, profileWidgetKeyId: "key_1" })];
    expect(await codeOf(await resolveWidgetAccess(sessionRequest("https://evil.example"), "wk_live_abc", { requireOrigin: true, strictOrigin: true }))).toBe("widget_origin_denied");
    expect(await codeOf(await resolveWidgetSessionAccess(chatRequest("https://evil.example")))).toBe("widget_origin_denied");
  });
});
