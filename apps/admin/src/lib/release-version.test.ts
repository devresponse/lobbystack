import { expect, it, vi } from "vitest";
import { displayVersion, releaseVersion } from "./release-version";

it("prefers the deployed commit over a pinned SERVICE_VERSION", () => {
  expect(releaseVersion({ RAILWAY_GIT_COMMIT_SHA: "222c638b", RAILWAY_DEPLOYMENT_ID: "028ec219", SERVICE_VERSION: "faac87ba" })).toBe("222c638b");
});

it("falls back through the deployment ID and SERVICE_VERSION, skipping empty values", () => {
  expect(releaseVersion({ RAILWAY_GIT_COMMIT_SHA: "", RAILWAY_DEPLOYMENT_ID: "028ec219", SERVICE_VERSION: "faac87ba" })).toBe("028ec219");
  expect(releaseVersion({ SERVICE_VERSION: "faac87ba" })).toBe("faac87ba");
  expect(releaseVersion({})).toBe("development");
});

it("shows the deployed commit, shortened, without asking the checkout", () => {
  const checkoutCommit = vi.fn(() => "0123456789abcdef0123456789abcdef01234567");
  expect(displayVersion({ RAILWAY_GIT_COMMIT_SHA: "52bcf4583e5b3c2b1f0d6a1e9a7c3d4b5e6f7a8b", SERVICE_VERSION: "faac87ba" }, checkoutCommit)).toBe("52bcf45");
  expect(checkoutCommit).not.toHaveBeenCalled();
});

it("shows an image build's SERVICE_VERSION, shortening only a full commit SHA", () => {
  expect(displayVersion({ SERVICE_VERSION: "52bcf4583e5b3c2b1f0d6a1e9a7c3d4b5e6f7a8b" })).toBe("52bcf45");
  expect(displayVersion({ SERVICE_VERSION: "v1.4.0" })).toBe("v1.4.0");
  expect(displayVersion({ RAILWAY_DEPLOYMENT_ID: "028ec219", SERVICE_VERSION: "20261020" })).toBe("20261020");
});

it("falls back to the checkout's commit, and to nothing when no commit is known", () => {
  expect(displayVersion({ SERVICE_VERSION: "development" }, () => "9BA48071c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7")).toBe("9ba4807");
  expect(displayVersion({ RAILWAY_GIT_COMMIT_SHA: "", RAILWAY_DEPLOYMENT_ID: "028ec219", SERVICE_VERSION: "development" })).toBe("");
  expect(displayVersion({})).toBe("");
});
