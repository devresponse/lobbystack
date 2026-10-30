import posthog from "posthog-js";

import { sanitizeAnalyticsProperties } from "./analytics-sanitize";
import { sendBrowserErrorsTo } from "./browser-error-reporting";

const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const apiHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

/**
 * Starts PostHog in the browser, once. `ProductAnalytics` calls this as it
 * loads, before any page renders. The website widget never loads either, so a
 * visitor on a business's site doesn't download PostHog. PostHog starts opted
 * out and capture is only enabled for an operator whose workspace has
 * telemetry on, so nothing is collected before that decision is made. Consent,
 * session recording, and identity are controlled by `ProductAnalytics`.
 */
export function initializeClientAnalytics(): void {
  if (typeof window === "undefined" || !projectToken) return;
  if (!posthog.__loaded) {
    posthog.init(projectToken, {
      api_host: apiHost,
      ui_host: "https://us.posthog.com",
      defaults: "2026-05-30",
      autocapture: false,
      capture_exceptions: false,
      // Session recording is masked in the DOM before it leaves the browser, and
      // sensitive routes stop the recorder outright.
      session_recording: { maskTextSelector: ".ph-mask" },
      capture_pageview: "history_change",
      capture_pageleave: "if_capture_pageview",
      capture_performance: { web_vitals: true, network_timing: false, web_vitals_attribution: false },
      opt_out_capturing_by_default: true,
      save_campaign_params: false,
      save_referrer: false,
      before_send: event => {
        if (!event) return null;
        if (posthog.has_opted_out_capturing()) return null;
        sanitizeAnalyticsProperties(event.properties);
        return event;
      },
    });
    // PostHog stores an opt-in and starts opted in from it on the next page
    // load, despite opt_out_capturing_by_default, and captures that page a
    // tick later. Withdraw it first, so a page whose business has telemetry
    // off, or a sign-in page after a business that has it on, sends nothing.
    // ProductAnalytics starts its telemetry opted out, so without this its
    // opt-out would change nothing. It opts in again where consent allows, and
    // PostHog then captures the page once.
    if (!posthog.has_opted_out_capturing()) posthog.opt_out_capturing();
  }
  sendBrowserErrorsTo(posthog);
}
