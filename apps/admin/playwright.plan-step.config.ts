import { defineConfig } from "@playwright/test";

import journeys from "./playwright.config";
import { journeyReporters } from "./playwright-journey-report";

// The same build as the other browser journeys, started as a deployment that
// takes payments: with its billing provider's settings there, onboarding has a
// plan step right after the name (docs/features/onboarding.md). The other
// journeys' server has none of those settings, so it has no plan step. The
// values are stand-ins: the journey picks Free and opens no checkout, so
// nothing is ever sent to the provider. It listens on the port after the
// script nonce's servers, so no server answers for another's journeys.
const openBaseURL = new URL(journeys.use?.baseURL ?? "http://localhost:13000");
const baseURL = process.env.PLAYWRIGHT_PLAN_STEP_BASE_URL ?? `${openBaseURL.protocol}//${openBaseURL.hostname}:${Number(openBaseURL.port || "13000") + 4}`;
const server = Array.isArray(journeys.webServer) ? journeys.webServer[0] : journeys.webServer;
if (!server) throw new Error("playwright.config.ts no longer starts a server for the plan step's journey to copy.");

export default defineConfig({
  ...journeys,
  testMatch: "**/onboarding-plan-step.e2e.ts",
  testIgnore: [],
  reporter: journeyReporters("plan-step"),
  use: { ...journeys.use, baseURL },
  webServer: {
    ...server,
    url: `${baseURL}/login`,
    env: {
      ...server.env,
      PORT: new URL(baseURL).port,
      APP_BASE_URL: baseURL,
      AUTH_TRUSTED_ORIGINS: baseURL,
      POLAR_ACCESS_TOKEN: "plan-step-journey-token",
      POLAR_ORGANIZATION_ID: "plan-step-journey-organization",
    },
  },
});
