import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadWidgetAppearance: vi.fn() }));
vi.mock("@/lib/widget-keys", () => ({ loadWidgetAppearance: mocks.loadWidgetAppearance }));

import { GET } from "./route";

const PRELUDE_PREFIX = 'window["__lobbyStackWidgetAppearance"]=';

afterEach(() => { vi.resetAllMocks(); });

describe("widget loader", () => {
  it("serves the plain loader with a long cache when the URL names no key", async () => {
    const response = await GET(new Request("https://admin.test/embed.js"));
    expect(response.headers.get("cache-control")).toContain("max-age=600");
    expect(await response.text()).not.toContain(PRELUDE_PREFIX);
    expect(mocks.loadWidgetAppearance).not.toHaveBeenCalled();
  });

  it("starts a keyed loader with the look saved in the dashboard and caches it briefly", async () => {
    mocks.loadWidgetAppearance.mockResolvedValue({ color: "#112233", position: "bottom-left" });
    const response = await GET(new Request("https://admin.test/embed.js?key=wk_live_abc-_1"));
    const body = await response.text();
    expect(mocks.loadWidgetAppearance).toHaveBeenCalledWith("wk_live_abc-_1");
    expect(body.startsWith(`${PRELUDE_PREFIX}window["__lobbyStackWidgetAppearance"]||{};window["__lobbyStackWidgetAppearance"]["wk_live_abc-_1"]={"color":"#112233","position":"bottom-left"};\n`)).toBe(true);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    // The prelude runs as script and fills the global the loader reads.
    const scope: Record<string, unknown> = {};
    new Function("window", body.split("\n")[0]!)(scope);
    expect(scope.__lobbyStackWidgetAppearance).toEqual({ "wk_live_abc-_1": { color: "#112233", position: "bottom-left" } });
  });

  it("serves the plain loader for an unknown key, a malformed key, or a failed lookup", async () => {
    mocks.loadWidgetAppearance.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("database down"));
    for (const url of ["https://admin.test/embed.js?key=wk_live_unknown", "https://admin.test/embed.js?key=wk_live_down", "https://admin.test/embed.js?key=%22%3B%20alert(1)"]) {
      const response = await GET(new Request(url));
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(PRELUDE_PREFIX);
    }
    expect(mocks.loadWidgetAppearance).toHaveBeenCalledTimes(2);
  });
});
