/**
 * Identifies the running build for telemetry, error tracking, and source maps.
 * Railway sets the commit SHA on every GitHub deploy, at build and at runtime,
 * so it wins over `SERVICE_VERSION`, which can stay unchanged across deploys.
 */
export function releaseVersion(env: Record<string, string | undefined> = process.env): string {
  return env.RAILWAY_GIT_COMMIT_SHA || env.RAILWAY_DEPLOYMENT_ID || env.SERVICE_VERSION || "development";
}

/**
 * The version the dashboard shows under the account menu. Railway passes the
 * deployed commit to the build and image builds pass theirs as
 * `SERVICE_VERSION`; a build from a checkout falls back to its own commit. A
 * full commit SHA is shortened to seven characters, as Git and GitHub show it.
 * Empty when nothing is known, since a deployment ID or the `development`
 * default would not tell anyone which code is running.
 */
export function displayVersion(env: Record<string, string | undefined> = process.env, checkoutCommit: () => string | undefined = () => undefined): string {
  const serviceVersion = env.SERVICE_VERSION === "development" ? "" : env.SERVICE_VERSION;
  const version = (env.RAILWAY_GIT_COMMIT_SHA || serviceVersion || checkoutCommit() || "").trim();
  return /^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 7).toLowerCase() : version;
}
