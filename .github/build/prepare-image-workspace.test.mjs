import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";

test("image projection preserves the lockfile and excludes local tooling", () => {
  const directory = mkdtempSync(join(tmpdir(), "lobbystack-image-lock-"));
  try {
    for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "patches"]) {
      cpSync(file, join(directory, file), { recursive: true });
    }
    const prepare = resolve(".github/build/prepare-image-workspace.mjs");
    execFileSync(process.execPath, [prepare, "--lockfile-only"], { cwd: directory });
    assert(!existsSync(join(directory, "package.json")));
    const lock = readFileSync(join(directory, "pnpm-lock.yaml"), "utf8");
    assert(!lock.includes("\n  mintlify:\n"));
    assert(!lock.includes("\n      next-devtools-mcp:\n"));
    assert(!lock.includes("\n      railway:\n"));
    assert(lock.includes("\n  apps/admin:\n"));
    const original = readFileSync("pnpm-lock.yaml", "utf8");
    // pnpm 12 locks pnpm itself in a leading document, which has its own packages section.
    const pnpmDocument = original.startsWith("---\n") ? original.slice(0, original.indexOf("\n---\n", 4) + 5) : "";
    assert(lock.startsWith(pnpmDocument));
    assert.equal(lock.split("\npackages:\n").at(-1), original.split("\npackages:\n").at(-1));
    if (process.env.VERIFY_IMAGE_FETCH === "1") {
      execFileSync("pnpm", ["fetch", "--offline", "--ignore-scripts"], { cwd: directory, stdio: "pipe" });
    }
    cpSync("package.json", join(directory, "package.json"));
    execFileSync(process.execPath, [prepare], { cwd: directory });
    assert.equal(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8"), lock);
    // Frozen validation catches a root importer/manifest mismatch without downloading packages.
    execFileSync("pnpm", ["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"], { cwd: directory, stdio: "pipe" });
    if (process.env.VERIFY_IMAGE_FETCH === "1") {
      for (const parent of ["apps", "packages"]) {
        for (const name of readdirSync(parent)) {
          const manifest = join(parent, name, "package.json");
          if (!existsSync(manifest)) continue;
          mkdirSync(join(directory, parent, name), { recursive: true });
          cpSync(manifest, join(directory, manifest));
        }
      }
      execFileSync("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], { cwd: directory, stdio: "pipe" });
      const packages = readdirSync(join(directory, "node_modules/.pnpm"));
      assert(!packages.some(name => /^(?:@mintlify\+|mintlify@|next-devtools-mcp@|railway@)/.test(name)));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("image projection reads files with Windows line endings", () => {
  // A Windows clone made before .gitattributes keeps CRLF files, and Way B copies them into the image.
  const unix = mkdtempSync(join(tmpdir(), "lobbystack-image-lf-"));
  const windows = mkdtempSync(join(tmpdir(), "lobbystack-image-crlf-"));
  try {
    const files = ["pnpm-lock.yaml", "pnpm-workspace.yaml"];
    for (const file of files) {
      const text = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
      writeFileSync(join(unix, file), text);
      writeFileSync(join(windows, file), text.replaceAll("\n", "\r\n"));
    }
    const prepare = resolve(".github/build/prepare-image-workspace.mjs");
    for (const directory of [unix, windows]) {
      execFileSync(process.execPath, [prepare, "--lockfile-only"], { cwd: directory });
    }
    for (const file of files) {
      assert.equal(readFileSync(join(windows, file), "utf8"), readFileSync(join(unix, file), "utf8"));
    }
  } finally {
    rmSync(unix, { recursive: true, force: true });
    rmSync(windows, { recursive: true, force: true });
  }
});
