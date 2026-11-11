import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ follow: vi.fn(), report: vi.fn(), branding: vi.fn() }));
vi.mock("@lobbystack/domain", () => ({ followEntryLink: mocks.follow }));
vi.mock("@/lib/domain-context", () => ({ createWorkerDomainContext: () => ({ db: "worker" }) }));
vi.mock("@/lib/error-reporting", () => ({ reportServerError: mocks.report }));
vi.mock("@/lib/branding", () => ({ loadBranding: mocks.branding }));

import { GET, HEAD } from "./route";

const destination = { businessId: "b1", entryLinkId: "l1", receptionistId: "r1", path: "/profile/acme-dental/kitsilano" };

function scan(code = "a9fp8b", values: { query?: string; headers?: Record<string, string> } = {}) {
  return [new Request(`https://app.example.com/q/${code}${values.query ?? ""}`, { headers: values.headers ?? {} }), { params: Promise.resolve({ code }) }] as const;
}

beforeEach(() => {
  mocks.follow.mockResolvedValue(destination);
  mocks.branding.mockResolvedValue({ appName: "AlloPlace" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("a scan of a QR link", () => {
  it("counts the scan and opens the receptionist's page on the same domain, never cached", async () => {
    const response = await GET(...scan());
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/profile/acme-dental/kitsilano");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.follow).toHaveBeenCalledExactlyOnceWith({ db: "worker" }, { code: "a9fp8b", count: true });
  });

  it("opens the business page when the link opens the default receptionist", async () => {
    mocks.follow.mockResolvedValue({ ...destination, path: "/profile/acme-dental" });
    expect((await GET(...scan())).headers.get("location")).toBe("/profile/acme-dental");
  });

  it("keeps a language the sign's address chooses", async () => {
    expect((await GET(...scan("a9fp8b", { query: "?lng=fr" }))).headers.get("location")).toBe("/profile/acme-dental/kitsilano?lng=fr");
  });

  it("drops anything else in the address", async () => {
    for (const query of ["?lng=french", "?lng=%2F%2Fevil.example", "?utm_source=window"]) {
      expect((await GET(...scan("a9fp8b", { query }))).headers.get("location")).toBe("/profile/acme-dental/kitsilano");
    }
  });

  it("follows without counting when a link preview or checker only looks", async () => {
    const response = await HEAD(...scan());
    expect(response.status).toBe(307);
    expect(mocks.follow).toHaveBeenCalledExactlyOnceWith({ db: "worker" }, { code: "a9fp8b", count: false });
  });
});

describe("a code that opens nothing", () => {
  beforeEach(() => mocks.follow.mockResolvedValue(null));

  it("says so in the visitor's language, out of search results", async () => {
    const response = await GET(...scan("zzzzzz", { headers: { "x-lobbystack-locale": "en", "x-lobbystack-locale-source": "header" } }));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain("<h1");
    expect(html).toContain("This QR code doesn&#39;t open a page");
  });

  it("speaks French to a French visitor", async () => {
    const html = await (await GET(...scan("zzzzzz", { headers: { "x-lobbystack-locale": "fr", "x-lobbystack-locale-source": "header" } }))).text();
    expect(html).toContain('<html lang="fr');
    expect(html).not.toContain("This QR code");
  });

  it("still answers when the brand can't be read", async () => {
    mocks.branding.mockRejectedValue(new Error("database unavailable"));
    expect((await GET(...scan("zzzzzz"))).status).toBe(404);
  });
});

it("asks the visitor to scan again, and reports why, when the link can't be read", async () => {
  const failure = new Error("connection refused");
  mocks.follow.mockRejectedValue(failure);
  const response = await GET(...scan());
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("5");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toBe("The page couldn't open. Try again in a moment.");
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith(failure, { operation: "entry_link.follow", route: "/q/[code]" });
});
