import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { brandOutputs, readBrandSources, repositoryRoot } from "./write-brands";

describe("brands", () => {
  it("compiles every folder under brands/ without problems", () => {
    expect(() => brandOutputs(readBrandSources())).not.toThrow();
  });

  it("has generated.ts, the schemas and the admin's brand images up to date: run pnpm brands:build", () => {
    for (const [path, content] of brandOutputs(readBrandSources())) {
      const committed = readFileSync(join(repositoryRoot, path));
      expect(committed.equals(Buffer.from(content)), `${path} is behind brands/`).toBe(true);
    }
  });
});
