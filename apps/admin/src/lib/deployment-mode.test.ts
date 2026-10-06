import { expect, it } from "vitest";
import { runtimeDeploymentMode } from "./deployment-mode";

it("returns the deployment mode the server runs with", () => {
  expect(runtimeDeploymentMode({ DEPLOYMENT_MODE: "cloud" })).toBe("cloud");
  expect(runtimeDeploymentMode({ DEPLOYMENT_MODE: " self_hosted_standard " })).toBe("self_hosted_standard");
});

it("falls back to development when the mode is missing or unknown", () => {
  expect(runtimeDeploymentMode({})).toBe("development");
  expect(runtimeDeploymentMode({ DEPLOYMENT_MODE: "production" })).toBe("development");
});
