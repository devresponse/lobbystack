import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFleet: vi.fn() }));

vi.mock("@lobbystack/jobs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@lobbystack/jobs")>()), readFleet: mocks.readFleet }));

import { GET } from "./route";

const TOKEN = "fleet-status-token-of-32-characters";

describe("GET /api/internal/fleet", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.readFleet.mockReset();
  });

  it("is absent until FLEET_STATUS_TOKEN is set", async () => {
    const response = await GET(new Request("http://localhost/api/internal/fleet"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(mocks.readFleet).not.toHaveBeenCalled();
  });

  it("refuses a request without the token", async () => {
    vi.stubEnv("FLEET_STATUS_TOKEN", TOKEN);
    const response = await GET(new Request("http://localhost/api/internal/fleet", { headers: { authorization: "Bearer some-internal-service-token" } }));
    expect(response.status).toBe(401);
    expect(mocks.readFleet).not.toHaveBeenCalled();
  });

  it("answers 200 with the copies while all is well, and 503 once a worker went silent", async () => {
    vi.stubEnv("FLEET_STATUS_TOKEN", TOKEN);
    const now = Date.now();
    const beat = { release: "abc1234", startedAt: now - 60_000, draining: false, busy: 0.05, rssBytes: 1, heapUsedBytes: 1 };
    const records = [
      { ...beat, service: "admin", replica: "a1", seenAt: now - 1_000 },
      { ...beat, service: "worker", replica: "w1", ready: true, seenAt: now - 1_000 },
    ];
    mocks.readFleet.mockResolvedValue({ now, records });

    const fine = await GET(new Request(`http://localhost/api/internal/fleet?token=${TOKEN}`));
    expect(fine.status).toBe(200);
    expect(fine.headers.get("content-type")).toContain("application/json");
    await expect(fine.json()).resolves.toMatchObject({ ok: true, problems: [], copies: [{ replica: "a1", state: "running" }, { replica: "w1", state: "running" }] });

    mocks.readFleet.mockResolvedValue({ now, records: [records[0], { ...records[1], seenAt: now - 45_000 }] });
    const down = await GET(new Request("http://localhost/api/internal/fleet", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(down.status).toBe(503);
    await expect(down.json()).resolves.toMatchObject({ ok: false, problems: [expect.stringContaining("worker copy w1 stopped reporting 45 s ago"), "No worker copy is running."] });
  });
});
