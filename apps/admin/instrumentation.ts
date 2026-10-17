export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionSecrets, brandLinkEnvironment, brandStartupReport, currentBrand, invalidBrandLinkVariables, resolveBrand } = await import("@lobbystack/shared");
  assertProductionSecrets(process.env, [
    "BETTER_AUTH_SECRET",
    "INTERNAL_SERVICE_SECRET",
    "INTERNAL_SERVICE_TOKEN",
    "WIDGET_SESSION_SECRET",
    "ENCRYPTION_KEY",
    "OTP_HASH_SECRET",
    ...(process.env.STORAGE_PROVIDER === "s3" ? [] : ["LOCAL_STORAGE_SIGNING_SECRET"]),
  ]);
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
  const invalidLinks = invalidBrandLinkVariables(brandLinkEnvironment());
  if (invalidLinks.length) {
    console.warn(`[branding] Ignoring ${invalidLinks.join(", ")}: a site or page must be an http or https URL and the contact address a plain email address, so the app uses the brand's link instead.`);
  }
  const { initializeTelemetry } = await import("@lobbystack/telemetry/node");
  await initializeTelemetry({ serviceName: "lobbystack-admin" });
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
