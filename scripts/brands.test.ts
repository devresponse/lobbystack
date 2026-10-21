import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { brandOutputs, readBrandSources, repositoryRoot } from "./write-brands";

describe("brands", () => {
  it("compiles every folder under brands/ without problems", () => {
    expect(() => brandOutputs(readBrandSources())).not.toThrow();
  });

  it("reads billing.json apart from the images, so the admin never serves it", () => {
    const sources = readBrandSources();
    expect(sources.brands.alloplace!.billing).toMatchObject({ version: 1, currency: "cad" });
    expect(Object.keys(sources.brands.alloplace!.assets)).not.toContain("billing.json");
    expect([...brandOutputs(sources).keys()].filter((path) => path.includes("billing"))).toEqual(["brands/billing.schema.json"]);
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
