import { readFileSync } from "node:fs";
import type { NextConfig } from "next";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
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
    const buildStage = dockerBuildStage();
    const commitArg = buildStage.indexOf("ARG RAILWAY_GIT_COMMIT_SHA\n");
    expect(commitArg).toBeGreaterThan(-1);
    expect(commitArg).toBeLessThan(buildStage.indexOf("RUN pnpm --filter @lobbystack/admin... build"));
  });
});

const BRAND_LINK_VARIABLES = ["NEXT_PUBLIC_LANDING_SITE_URL", "NEXT_PUBLIC_TERMS_URL", "NEXT_PUBLIC_PRIVACY_URL", "NEXT_PUBLIC_DOCS_SITE_URL", "NEXT_PUBLIC_CONTACT_EMAIL"];

describe("admin build links", () => {
  it("writes the deployment's links into the build", async () => {
    const config = await loadConfig({
      NEXT_PUBLIC_LANDING_SITE_URL: "https://alloplace.com",
      NEXT_PUBLIC_TERMS_URL: "https://alloplace.com/legal/terms",
      NEXT_PUBLIC_PRIVACY_URL: "https://alloplace.com/legal/privacy",
      NEXT_PUBLIC_DOCS_SITE_URL: "https://alloplace.com",
      NEXT_PUBLIC_CONTACT_EMAIL: "support@alloplace.com",
    }) as NextConfig;
    expect(config.env).toMatchObject({
      NEXT_PUBLIC_LANDING_SITE_URL: "https://alloplace.com",
      NEXT_PUBLIC_TERMS_URL: "https://alloplace.com/legal/terms",
      NEXT_PUBLIC_PRIVACY_URL: "https://alloplace.com/legal/privacy",
      NEXT_PUBLIC_DOCS_SITE_URL: "https://alloplace.com",
      NEXT_PUBLIC_CONTACT_EMAIL: "support@alloplace.com",
    });
  });

  it("fixes unset links as empty, so a value added at run time can't split the server from the browser", async () => {
    for (const name of BRAND_LINK_VARIABLES) vi.stubEnv(name, undefined);
    const config = await loadConfig({}) as NextConfig;
    for (const name of BRAND_LINK_VARIABLES) expect(config.env?.[name]).toBe("");
  });

});

describe("admin build brand", () => {
  it("writes the address and preset the brand comes from into the build", async () => {
    vi.stubEnv("BRAND_PRESET", undefined);
    const config = await loadConfig({ APP_BASE_URL: "https://demo.alloplace.com" }) as NextConfig;
    expect(config.env).toMatchObject({ NEXT_PUBLIC_BRAND_BASE_URL: "https://demo.alloplace.com", NEXT_PUBLIC_BRAND_PRESET: "" });
  });

  it("gives the Docker build that runs next build the address and preset, and no brand of its own", () => {
    const buildStage = dockerBuildStage();
    const adminBuild = buildStage.indexOf("RUN pnpm --filter @lobbystack/admin... build");
    for (const name of ["APP_BASE_URL", "BRAND_PRESET"]) {
      const arg = buildStage.indexOf(`ARG ${name}\n`);
      expect(arg, name).toBeGreaterThan(-1);
      expect(arg, name).toBeLessThan(adminBuild);
    }
    expect(buildStage).not.toContain("alloplace.com");
    expect(buildStage).not.toContain("BRAND_APP_NAME");
  });
});

describe("admin security headers", () => {
  it("lets a business's public page frame a Google map, and no other page", async () => {
    const config = await loadConfig({}) as NextConfig;
    const policy = async (path: string) => (await unstable_getResponseFromNextConfig({ url: `https://admin.example.com${path}`, nextConfig: config })).headers.get("content-security-policy") ?? "";
    expect(await policy("/profile/acme-dental")).toContain("frame-src 'self' https://challenges.cloudflare.com https://www.google.com;");
    expect(await policy("/profile/acme-dental")).toContain("frame-ancestors 'none'");
    for (const path of ["/settings/profile", "/profiles", "/"]) {
      expect(await policy(path), path).toContain("frame-src 'self' https://challenges.cloudflare.com;");
    }
  });
});

function dockerBuildStage() {
  // A Windows checkout with core.autocrlf has CRLF line endings.
  const dockerfile = readFileSync(new URL("../../Dockerfile.admin", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  return dockerfile.slice(0, dockerfile.indexOf(" AS runtime"));
}
