import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("line endings", () => {
  it("checks shell scripts and .env.example out with LF under Git for Windows' default core.autocrlf", async () => {
    // Postgres runs roles.sh in Linux on its first start, and bash fails on CRLF.
    const files = execFileSync("git", ["ls-files", "--", "*.sh", ".env.example"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(files).toEqual(expect.arrayContaining(["docker/postgres/init/roles.sh", ".env.example"]));
    const checkout = await mkdtemp(join(tmpdir(), "line-endings-"));
    try {
      execFileSync("git", ["-c", "core.autocrlf=true", "checkout-index", `--prefix=${checkout}/`, "--", ...files], { cwd: root });
      for (const file of files) expect(await readFile(join(checkout, file), "utf8"), file).not.toContain("\r");
    } finally {
      await rm(checkout, { force: true, recursive: true });
    }
  });
});
