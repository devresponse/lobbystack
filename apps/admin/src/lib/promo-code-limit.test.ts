import { beforeEach, describe, expect, it, vi } from "vitest";

const enforce = vi.hoisted(() => vi.fn());
vi.mock("./fixed-window-limit", async (importOriginal) => ({ ...await importOriginal<typeof import("./fixed-window-limit")>(), enforceFixedWindow: enforce }));

import { clientIpDigest } from "./fixed-window-limit";
import { checkPromoCodeLimit } from "./promo-code-limit";

describe("promo code limits", () => {
  beforeEach(() => enforce.mockReset());

  it("counts the business, the person, the address and the API key, each an hour", async () => {
    enforce.mockResolvedValue({ allowed: true });
    await expect(checkPromoCodeLimit({ businessId: "business-a", userId: "user-a", ip: "203.0.113.10", keyId: "key-a" })).resolves.toEqual({ allowed: true });
    const [limits] = enforce.mock.calls[0]!;
    expect(limits.map((entry: { name: string; limit: number; windowSeconds: number }) => [entry.name, entry.limit, entry.windowSeconds])).toEqual([
      ["business-hour", 10, 3600],
      ["user-hour", 20, 3600],
      ["ip-hour", 20, 3600],
      ["key-hour", 20, 3600],
    ]);
    const [business, user, ip, key] = limits.map((entry: { key: string }) => entry.key);
    expect(business).toContain(":promo-code:business-hour:business-a:");
    expect(user).toContain(":promo-code:user-hour:user-a:");
    expect(ip).toContain(`:promo-code:ip-hour:${clientIpDigest("203.0.113.10")}:`);
    expect(key).toContain(":promo-code:key-hour:key-a:");
    expect(limits.map((entry: { key: string }) => entry.key).join(" ")).not.toContain("203.0.113.10");
  });

  it("counts only the business when nothing else is known", async () => {
    enforce.mockResolvedValue({ allowed: false, status: 429, reason: "rate_limit_business_hour" });
    await expect(checkPromoCodeLimit({ businessId: "business-a" })).resolves.toEqual({ allowed: false, status: 429, reason: "rate_limit_business_hour" });
    expect(enforce.mock.calls[0]![0].map((entry: { name: string }) => entry.name)).toEqual(["business-hour"]);
  });
});
