import { defineConfig, devices } from "@playwright/test";

import journeys from "./playwright.config";
import { journeyReporters } from "./playwright-journey-report";

// The same build as the other browser journeys, started twice more: once with
// the script nonce reported on (CSP_SCRIPT_NONCE) and once with it enforced
// (CSP_SCRIPT_NONCE_ENFORCED too), the two steps docs/development/README.md
// describes. They listen on the ports after the access gate's server, so no
// server answers for another's journeys. Each is a project, so the one journey
// runs against both and knows which from the project's name.
const openBaseURL = new URL(journeys.use?.baseURL ?? "http://localhost:13000");
const server = Array.isArray(journeys.webServer) ? journeys.webServer[0] : journeys.webServer;
if (!server) throw new Error("playwright.config.ts no longer starts a server for the script nonce's journey to copy.");

const steps = [
  { name: "reporting", settings: { CSP_SCRIPT_NONCE: "true" } },
  { name: "enforced", settings: { CSP_SCRIPT_NONCE: "true", CSP_SCRIPT_NONCE_ENFORCED: "true" } },
].map((step, index) => ({
  ...step,
  baseURL: `${openBaseURL.protocol}//${openBaseURL.hostname}:${Number(openBaseURL.port || "13000") + 2 + index}`,
}));

export default defineConfig({
  ...journeys,
  testMatch: "**/script-nonce.e2e.ts",
  testIgnore: [],
  reporter: journeyReporters("script-nonce"),
  projects: steps.map((step) => ({ name: step.name, use: { ...devices["Desktop Chrome"], baseURL: step.baseURL } })),
  webServer: steps.map((step) => ({
    ...server,
    url: `${step.baseURL}/api/health/live`,
    env: {
      ...server.env,
      PORT: new URL(step.baseURL).port,
      APP_BASE_URL: step.baseURL,
      AUTH_TRUSTED_ORIGINS: step.baseURL,
      ...step.settings,
    },
  })),
});
