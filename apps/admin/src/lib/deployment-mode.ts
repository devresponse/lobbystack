import { deploymentModes } from "@lobbystack/shared";
import type { DeploymentMode } from "@lobbystack/telemetry";

/**
 * Reads the deployment mode the server runs with. The browser gets it from the
 * server at runtime instead of from the bundle: Railway passes a service
 * variable to `next build` only when the Dockerfile declares it as an ARG, so a
 * build-time value fell back to "development" in production.
 */
export function runtimeDeploymentMode(env: Record<string, string | undefined> = process.env): DeploymentMode {
  const value = env.DEPLOYMENT_MODE?.trim();
  return deploymentModes.find(mode => mode === value) ?? "development";
}
