import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { chunkText } from "../src/chunkText.ts";
import { checkCopies, chunkTextSource, copies, workerVersions } from "../src/copyCheck.ts";
import { storedForm } from "../src/metrics.ts";

const tool = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repo = path.resolve(tool, "../../..");
const inRepo = existsSync(path.join(repo, copies.reader.repo));
const skip = inRepo ? false : "the tool isn't inside the lobbystack repository";
// As Git stores the files: a Windows checkout may have CRLF line endings.
const lf = (file: string) => readFileSync(file, "utf8").replace(/\r\n/gu, "\n");

test("the current parser is the worker's reader, byte for byte", { skip }, () => {
  assert.equal(lf(path.join(tool, copies.reader.tool)), lf(path.join(repo, copies.reader.repo)));
});

test("chunkText is the repository's function, byte for byte", { skip }, () => {
  const repoSource = chunkTextSource(lf(path.join(repo, copies.chunkText.repo)));
  assert.ok(repoSource, "the repository still has chunkText");
  assert.equal(chunkTextSource(lf(path.join(tool, copies.chunkText.tool))), repoSource);
});

test("the tool pins the library versions the worker runs", { skip }, () => {
  const wanted = workerVersions(lf(path.join(repo, "pnpm-lock.yaml")));
  const declared = (JSON.parse(readFileSync(path.join(tool, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies;
  for (const name of copies.libraries) {
    assert.ok(wanted[name], `pnpm-lock.yaml resolves ${name} for the worker`);
    assert.equal(declared[name], wanted[name], name);
  }
});

test("check-copy passes on the repository as it is", { skip }, async () => {
  const lines: string[] = [];
  assert.equal(await checkCopies({ repo, tool, fix: false, log: (line) => lines.push(line) }), 0, lines.join("\n"));
});

test("storedForm is the whitespace rule chunkText applies before it cuts", () => {
  for (const text of ["Account\t2025 \t2026 Budget\r\nStrata fees \t$412,800\t$441,700\n\n\n\nTotal", "  [Page 1 of 2]\nLot | Unit\n44 | 604  \n", "no change"]) {
    assert.deepEqual(chunkText(text, { maxCharacters: 1_000_000 }), [storedForm(text)]);
  }
});
