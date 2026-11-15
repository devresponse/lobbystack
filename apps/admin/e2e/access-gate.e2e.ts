import { expect, test } from "@playwright/test";

import { ACCESS_GATE_E2E_TOKEN } from "./fixtures/access-gate";

// Runs against a server started with PROTECTION_TOKEN, by
// playwright.access-gate.config.ts (docs/features/access-gate.md).

const NOINDEX = "noindex, nofollow";

test("a stranger gets the same bare 404 at every page", async ({ page }) => {
  for (const path of ["/", "/login", "/en/login", "/en/signup", "/dashboard", "/profile/a-business", "/q/abc123", "/no-such-page", "/api/auth/get-session"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    expect(await response?.text(), path).toBe("Not found");
    expect(response?.headers()["content-type"], path).toBe("text/plain; charset=utf-8");
    expect(response?.headers()["cache-control"], path).toBe("no-store");
    expect(response?.headers()["x-robots-tag"], path).toBe(NOINDEX);
  }
  // A token that isn't this deployment's opens nothing and leaves nothing behind.
  const wrong = await page.goto("/login?access=a-token-from-some-other-deployment-000000");
  expect(wrong?.status()).toBe(404);
  expect(await page.context().cookies()).toEqual([]);
});

test("the image optimizer can't tell a closed page from a made-up one", async ({ request }) => {
  // /_next/image never passes through the proxy itself. It fetches the address it is given
  // through the proxy, with no cookie, so a page that exists answers it the 404 as well.
  const answers: Array<{ status: number; body: string }> = [];
  for (const target of ["/en/login", "/api/auth/get-session", "/no-such-page"]) {
    const response = await request.get(`/_next/image?url=${encodeURIComponent(target)}&w=640&q=75`);
    answers.push({ status: response.status(), body: await response.text() });
  }
  expect(answers[0]!.status).toBe(404);
  expect(answers[0]!.body).not.toContain("<");
  expect(answers[1]).toEqual(answers[0]);
  expect(answers[2]).toEqual(answers[0]);
});

test("the access link opens the sign-in page, and the browser stays in without it", async ({ page }) => {
  // A request a page makes without the browser's cookies gets the gate's 404, so none may.
  const turnedAway: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 404) turnedAway.push(new URL(response.url()).pathname);
  });

  const exchange = await page.request.get(`/login?access=${ACCESS_GATE_E2E_TOKEN}&returnTo=%2Fsettings`, { maxRedirects: 0 });
  expect(exchange.status()).toBe(303);
  // The token leaves the address before any page loads, so it reaches no page, script or Referer.
  expect(exchange.headers().location).toBe("/login?returnTo=%2Fsettings");
  expect(exchange.headers()["cache-control"]).toBe("no-store");
  await page.context().clearCookies();

  await page.goto(`/login?access=${ACCESS_GATE_E2E_TOKEN}&returnTo=%2Fsettings`);
  await expect(page).toHaveURL(/\/en\/login\?returnTo=%2Fsettings$/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();

  const cookie = (await page.context().cookies()).find((entry) => entry.name === "lobbystack-access");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  expect(cookie?.value).not.toContain(ACCESS_GATE_E2E_TOKEN);
  // 30 days, give or take the seconds this test took.
  expect(cookie!.expires - Date.now() / 1000).toBeGreaterThan(30 * 24 * 60 * 60 - 120);
  expect(cookie!.expires - Date.now() / 1000).toBeLessThan(30 * 24 * 60 * 60 + 120);

  // A page built without a brand, as this server's are, asks for the deployment's name and logo by itself.
  const branding = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/branding");
  await page.goto("/en/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  expect((await branding).status()).toBe(200);
  expect(turnedAway).toEqual([]);
  // A page that shared caches store on an open deployment is this browser's alone here.
  // The built server says "private, no-store"; `next dev` says "no-store" for every page.
  const signup = await page.request.get("/en/signup");
  expect(signup.status()).toBe(200);
  expect(signup.headers()["cache-control"]).toMatch(/^(private, )?no-store$/);
  expect(signup.headers()["x-robots-tag"]).toBe(NOINDEX);
  // Signing in needs nothing more than the cookie the browser now sends by itself.
  expect((await page.request.get("/api/auth/get-session")).status()).toBe(200);
});

test("a script gets in with the header instead of the link", async ({ request }) => {
  expect((await request.get("/api/auth/get-session")).status()).toBe(404);
  expect((await request.get("/api/auth/get-session", { headers: { "x-protection-token": "a-token-from-some-other-deployment-000000" } })).status()).toBe(404);
  const session = await request.get("/api/auth/get-session", { headers: { "x-protection-token": ACCESS_GATE_E2E_TOKEN } });
  expect(session.status()).toBe(200);
  expect(session.headers()["set-cookie"] ?? "").not.toContain("lobbystack-access");
});

test("the routes other services and websites call answer as they do on an open deployment", async ({ request }) => {
  const live = await request.get("/api/health/live");
  expect(live.status()).toBe(200);
  expect(live.headers()["x-robots-tag"]).toBe(NOINDEX);

  // The website widget: its loader, its chat's page and the files that page loads.
  const loader = await request.get("/embed.js");
  expect(loader.status()).toBe(200);
  expect(loader.headers()["content-type"]).toContain("javascript");
  expect(loader.headers()["cache-control"]).toContain("max-age=600");
  const chat = await request.get("/embed/wk_no_such_key");
  expect(chat.status()).toBe(200);
  expect(chat.headers()["content-type"]).toContain("text/html");
  expect((await request.get("/locales/en/widget.json")).status()).toBe(200);
  // What the chat calls answers with the widget's own check of the key, as JSON, not the gate's two words.
  const session = await request.post("/api/widget/session", { data: { key: "wk_no_such_key" } });
  expect(session.headers()["content-type"]).toContain("application/json");

  // Twilio's webhook still answers with its own signature check.
  const webhook = await request.post("/api/webhooks/twilio/sms", { form: { From: "+15550100", To: "+15550101", Body: "hello" } });
  expect(webhook.status()).toBe(401);
  expect(await webhook.text()).toBe("Unauthorized");

  // The public API and MCP ask for their own key or token.
  expect((await request.get("/api/v1/businesses")).status()).toBe(401);
  expect((await request.post("/api/mcp", { data: {} })).status()).toBe(401);
  const discovery = await request.get("/.well-known/oauth-protected-resource/api/mcp");
  expect(discovery.status()).toBe(200);
  expect(discovery.headers()["content-type"]).toContain("application/json");

  // The address beside an open one is closed.
  expect((await request.get("/api/widget-keys")).status()).toBe(404);
  expect(await (await request.get("/api/widget-keys")).text()).toBe("Not found");
});
