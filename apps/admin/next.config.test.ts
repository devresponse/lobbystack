import { readFileSync } from "node:fs";
import type { NextConfig } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

const withPostHogConfig = vi.hoisted(() => vi.fn((config: NextConfig, options: unknown) => ({ config, options })));
vi.mock("@posthog/nextjs-config", () => ({ withPostHogConfig }));

// What Railway hands a GitHub deploy's Docker build: the commit SHA as a build
// arg, next to a SERVICE_VERSION variable that stayed pinned to an old commit.
const RAILWAY_BUILD = {
  RAILWAY_GIT_COMMIT_SHA: "f7d94058ca01a771f293f9447b9e68f1a939b234",
  SERVICE_VERSION: "faac87ba",
  DEPLOYMENT_MODE: "",
  POSTHOG_SOURCEMAP_API_KEY: "phx_fixture",
};

async function loadConfig(env: Record<string, string>) {
  for (const name of ["RAILWAY_GIT_COMMIT_SHA", "RAILWAY_DEPLOYMENT_ID", "SERVICE_VERSION", "DEPLOYMENT_MODE", "POSTHOG_SOURCEMAP_API_KEY"]) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  return (await import("./next.config")).default as unknown;
}

afterEach(() => {
  vi.unstubAllEnvs();
  withPostHogConfig.mockClear();
});

describe("admin build release", () => {
  it("uses the deployed commit for the bundle, the deployment ID, and the source map upload", async () => {
    const { config, options } = await loadConfig(RAILWAY_BUILD) as { config: NextConfig; options: { sourcemaps: { releaseVersion: string } } };
    expect(config.env?.NEXT_PUBLIC_SERVICE_VERSION).toBe(RAILWAY_BUILD.RAILWAY_GIT_COMMIT_SHA);
    expect(config.deploymentId).toBe(RAILWAY_BUILD.RAILWAY_GIT_COMMIT_SHA);
    expect(options.sourcemaps.releaseVersion).toBe(RAILWAY_BUILD.RAILWAY_GIT_COMMIT_SHA);
  });

  it("leaves the deployment ID unset for a local build without a release", async () => {
    const config = await loadConfig({}) as NextConfig;
    expect(withPostHogConfig).not.toHaveBeenCalled();
    expect(config.env?.NEXT_PUBLIC_SERVICE_VERSION).toBe("development");
    expect(config.deploymentId).toBeUndefined();
  });

  it("does not bake a deployment mode into the browser bundle", async () => {
    const { config } = await loadConfig({ ...RAILWAY_BUILD, DEPLOYMENT_MODE: "cloud" }) as { config: NextConfig };
    expect(config.env).not.toHaveProperty("NEXT_PUBLIC_DEPLOYMENT_MODE");
  });

  it("passes Railway's commit SHA into the Docker build that runs next build", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile.admin", import.meta.url), "utf8");
    const buildStage = dockerfile.slice(0, dockerfile.indexOf(" AS runtime"));
    const commitArg = buildStage.indexOf("ARG RAILWAY_GIT_COMMIT_SHA\n");
    expect(commitArg).toBeGreaterThan(-1);
    expect(commitArg).toBeLessThan(buildStage.indexOf("RUN pnpm --filter @lobbystack/admin... build"));
  });
});
