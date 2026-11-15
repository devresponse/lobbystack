export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionSecrets, brandStartupReport, currentBrand, resolveBrand } = await import("@lobbystack/shared");
  assertProductionSecrets(process.env, [
    "BETTER_AUTH_SECRET",
    "INTERNAL_SERVICE_SECRET",
    "INTERNAL_SERVICE_TOKEN",
    "WIDGET_SESSION_SECRET",
    "ENCRYPTION_KEY",
    "OTP_HASH_SECRET",
    ...(process.env.STORAGE_PROVIDER === "s3" ? [] : ["LOCAL_STORAGE_SIGNING_SECRET"]),
  ]);
  // On Railway the limits per IP address always run (AUDIT-004): without the
  // header that names the visitor's address, the admin doesn't start, and
  // Railway keeps the running version until a deploy has it.
  const { trustedClientIpStartupError } = await import("./src/lib/trusted-client-ip");
  const clientIpError = trustedClientIpStartupError(process.env);
  if (clientIpError) throw new Error(clientIpError);
  // A PROTECTION_TOKEN that is short or breaks the access link would close the
  // deployment with a gate nobody can open, or one that can be guessed.
  const { protectionToken, protectionTokenStartupError } = await import("./src/lib/access-gate");
  const accessGateError = protectionTokenStartupError(process.env);
  if (accessGateError) throw new Error(accessGateError);
  // A BILLING_PROVIDER the worker refuses stops the admin too, which would otherwise show Polar's plans.
  const { readBillingProviderId } = await import("@lobbystack/providers/billing/factory");
  readBillingProviderId(process.env);
  // The admin shows the brand its build resolved (NEXT_PUBLIC_BRAND_BASE_URL),
  // so the prerendered pages and the browser agree with the server. Say so when
  // the address it runs with now would pick another: it needs a rebuild.
  const brand = currentBrand();
  const report = brandStartupReport(brand);
  console.info(report.info);
  for (const warning of report.warnings) console.warn(warning);
  if (report.error) throw new Error(report.error);
  const running = resolveBrand({ appBaseUrl: process.env.APP_BASE_URL, preset: process.env.BRAND_PRESET });
  if (running.id !== brand.id || running.appName !== brand.appName) {
    console.error(`[brand] brand.build_mismatch: this build shows ${brand.appName} (${brand.id}), but APP_BASE_URL and BRAND_PRESET now pick ${running.appName} (${running.id}). Rebuild the admin to show it.`);
  }
  const { initializeTelemetry, logEvent } = await import("@lobbystack/telemetry/node");
  await initializeTelemetry({ serviceName: "lobbystack-admin" });
  // Said at every start, so "every page answers 404" has its reason in the log. Never with the token.
  if (protectionToken(process.env) && process.env.NEXT_PHASE !== "phase-production-build") {
    logEvent("info", "access_gate.on", {
      detail: "PROTECTION_TOKEN is set, so every page answers 404 until a browser opens an address with ?access=<the token> once. Webhooks, health checks, the website widget, the API and MCP stay open. Remove the variable and redeploy to open the deployment.",
    });
  }
  const { emailVerificationOffInProduction } = await import("./src/lib/email-verification-setting");
  if (emailVerificationOffInProduction(process.env)) {
    logEvent("warn", "auth.email_verification_off", {
      detail: "REQUIRE_EMAIL_VERIFICATION is false, so anyone can sign up with an email address they don't own. Once email works, remove it or set it to true.",
    });
  }
  const { widgetChallengeOffReason } = await import("./src/lib/widget-challenge");
  const challengeOff = widgetChallengeOffReason(process.env);
  if (challengeOff) {
    logEvent("warn", "widget.turnstile_off", {
      reason: challengeOff,
      detail: challengeOff === "turned_off"
        ? "WIDGET_TURNSTILE is false, so the receptionist answers website chats without Turnstile's check, and a script can spend the businesses' chats. Remove it once the check works."
        : "NEXT_PUBLIC_TURNSTILE_SITE_KEY or TURNSTILE_SECRET_KEY is missing, so the receptionist answers website chats without Turnstile's check, and a script can spend the businesses' chats.",
    });
  }
  const { assertAdminDatabaseRoles } = await import("./src/lib/startup-role-assertion");
  await assertAdminDatabaseRoles();
}

export const onRequestError: import("next").Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportServerError } = await import("./src/lib/error-reporting");
  await reportServerError(error, { operation: context.routeType, route: context.routePath, method: request.method, ...(error instanceof Error && "digest" in error ? { digest: String(error.digest) } : {}) });
}

export async function shutdownTelemetry(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { shutdownTelemetry: shutdown } = await import("@lobbystack/telemetry/node");
  await shutdown();
}
