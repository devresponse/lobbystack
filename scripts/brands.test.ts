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
      // A Windows checkout with core.autocrlf has CRLF line endings in text files.
      const matches = typeof content === "string" ? committed.toString("utf8").replace(/\r\n/g, "\n") === content : committed.equals(Buffer.from(content));
      expect(matches, `${path} is behind brands/`).toBe(true);
    }
  });
});
