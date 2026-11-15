import { defineConfig } from "@playwright/test";

import { ACCESS_GATE_E2E_TOKEN } from "./e2e/fixtures/access-gate";
import journeys from "./playwright.config";

// The same build as the other browser journeys, started with the access gate
// on (PROTECTION_TOKEN, docs/features/access-gate.md). It listens on the next
// port, so it never answers for their server and they never meet a closed one.
const openBaseURL = new URL(journeys.use?.baseURL ?? "http://localhost:13000");
const baseURL = process.env.PLAYWRIGHT_ACCESS_GATE_BASE_URL ?? `${openBaseURL.protocol}//${openBaseURL.hostname}:${Number(openBaseURL.port || "13000") + 1}`;
const server = Array.isArray(journeys.webServer) ? journeys.webServer[0] : journeys.webServer;
if (!server) throw new Error("playwright.config.ts no longer starts a server for the access gate's journey to copy.");

export default defineConfig({
  ...journeys,
  testMatch: "**/access-gate.e2e.ts",
  testIgnore: [],
  use: { ...journeys.use, baseURL },
  webServer: {
    ...server,
    // Behind the gate /login answers 404, which would never count as started. A health check stays open.
    url: `${baseURL}/api/health/live`,
    env: {
      ...server.env,
      PORT: new URL(baseURL).port,
      APP_BASE_URL: baseURL,
      AUTH_TRUSTED_ORIGINS: baseURL,
      PROTECTION_TOKEN: ACCESS_GATE_E2E_TOKEN,
    },
  },
});
