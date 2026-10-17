import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enforce = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("./fixed-window-limit", async (importOriginal) => ({ ...await importOriginal<typeof import("./fixed-window-limit")>(), enforceFixedWindow: enforce }));

import { assertPhoneNumberSearchAllowed } from "./phone-number-search-limit";

describe("dashboard number search limit", () => {
  beforeEach(() => enforce.mockReset());
  afterEach(() => vi.useRealTimers());

  it("refuses a search over the limit with a 429 the chooser can explain", async () => {
    // Four minutes and a second into a 10-minute window.
    vi.useFakeTimers({ now: new Date("2026-10-17T08:04:01Z") });
    enforce.mockResolvedValue({ allowed: false, status: 429, reason: "rate_limit_user" });
    await expect(assertPhoneNumberSearchAllowed({ userId: "user-a", initial: false })).rejects.toMatchObject({ status: 429, code: "number_search_rate_limited", message: "Too many number searches. Try again in 6 minutes." });
  });

  it("reports a missing limiter as a server failure", async () => {
    enforce.mockResolvedValue({ allowed: false, status: 503, reason: "rate_limit_unavailable" });
    await expect(assertPhoneNumberSearchAllowed({ userId: "user-a", initial: true })).rejects.toMatchObject({ status: 503, code: "number_search_unavailable" });
  });

  it("lets a search within the limit through", async () => {
    enforce.mockResolvedValue({ allowed: true });
    await expect(assertPhoneNumberSearchAllowed({ userId: "user-a", initial: true })).resolves.toBeUndefined();
  });
});
