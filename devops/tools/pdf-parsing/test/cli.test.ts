import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fake = fileURLToPath(new URL("./fake-lobbystack.mjs", import.meta.url));
let folder = "";
let env: NodeJS.ProcessEnv = {};

const tool = async (...args: string[]) => {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args], { env, cwd: folder });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: `${failure.stdout}${failure.stderr}` };
  }
};
const state = async () => JSON.parse(await readFile(path.join(folder, "state.json"), "utf8")) as { sources: Array<{ id: string; title: string; tags: string[]; content: string }>; calls: string[][] };

before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "pdf-parsing-cli-"));
  env = { ...process.env, FAKE_LOBBYSTACK_STATE: path.join(folder, "state.json") };
  for (const file of ["notes.pdf", "notes.html", "budget.pdf", "budget.html"]) await copyFile(fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url)), path.join(folder, file));
});

after(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
});

test("parse reads a folder with the reader --parser names and writes the summaries", async () => {
  const parsed = await tool("parse", "--input", ".", "--output", "out", "--parser", "current,pdfjs");
  assert.equal(parsed.code, 0, parsed.stdout);
  assert.match(parsed.stdout, /4 results\. Summary: /u);
  const summary = await readFile(path.join(folder, "out", "summary.md"), "utf8");
  assert.match(summary, /\| current \| 2 \| 0 \|/u);
  assert.match(await readFile(path.join(folder, "out", "notes", "compare.md"), "utf8"), /Only in pdfjs: 25000, 50000/u);
  const csv = (await readFile(path.join(folder, "out", "summary.csv"), "utf8")).split("\n");
  assert.equal(csv[0]?.split(",")[0], "document");
  assert.equal(csv.filter(Boolean).length, 5);
});

test("an unknown reader or option is a usage error", async () => {
  const unknown = await tool("parse", "--input", ".", "--parser", "marker");
  assert.equal(unknown.code, 2);
  assert.match(unknown.stdout, /There's no parser named marker\. Use current, pdfjs or all\./u);
  assert.equal((await tool("parse", "--input", ".", "--pages")).code, 2);
  assert.equal((await tool("upload", "--output", "out")).code, 2);
});

test("report scores the saved texts again", async () => {
  await writeFile(path.join(folder, "notes.html"), "<p>Building deductible $25,000 and $99</p>");
  const reported = await tool("report", "--output", "out");
  assert.equal(reported.code, 0, reported.stdout);
  const result = JSON.parse(await readFile(path.join(folder, "out", "notes", "pdfjs", "result.json"), "utf8")) as { score: { numbersExpected: number; missing: Record<string, number> } };
  assert.equal(result.score.numbersExpected, 2);
  assert.deepEqual(result.score.missing, { "99": 1 });
});

test("upload sends one reader's text to the business and records it, once", async () => {
  const dry = await tool("upload", "--output", "out", "--parser", "pdfjs", "--cli", fake, "--business", "biz_test", "--dry-run");
  assert.equal(dry.code, 0, dry.stdout);
  assert.match(dry.stdout, /Would upload 2 file\(s\)/u);
  const uploaded = await tool("upload", "--output", "out", "--parser", "pdfjs", "--cli", fake, "--business", "biz_test", "--tag", "round-1");
  assert.equal(uploaded.code, 0, uploaded.stdout);
  const { sources } = await state();
  assert.deepEqual(sources.map((source) => source.title).sort(), ["budget (pdfjs)", "notes (pdfjs)"]);
  assert.deepEqual(sources[0]?.tags, ["pdf-parsing", "parser:pdfjs", "round-1"]);
  assert.match(sources.find((source) => source.title === "notes (pdfjs)")?.content ?? "", /\$25,000 \[\^2\]/u);
  const again = await tool("upload", "--output", "out", "--parser", "pdfjs", "--cli", fake, "--business", "biz_test");
  assert.match(again.stdout, /already uploaded as src_/u);
  assert.equal((await state()).sources.length, 2);
});

test("evaluate checks each answer is in a passage the search hands over", async () => {
  await writeFile(path.join(folder, "questions.csv"), 'question,answer,document\n"What is the building deductible?","$25,000",notes\nWhat is the 2026 budget for elevator maintenance?,"15,000",budget\nWhat is the pet fee?,$75,\n');
  const evaluated = await tool("evaluate", "--questions", "questions.csv", "--output", "out", "--label", "pdfjs", "--cli", fake, "--business", "biz_test");
  assert.equal(evaluated.code, 0, evaluated.stdout);
  assert.match(evaluated.stdout, /2 of 3 answers found/u);
  const results = JSON.parse(await readFile(path.join(folder, "out", "evaluations", "pdfjs", "results.json"), "utf8")) as { results: Array<{ found: boolean; fromDocument: boolean | null }> };
  assert.deepEqual(results.results.map((result) => [result.found, result.fromDocument]), [[true, true], [true, true], [false, null]]);
  assert.match(await readFile(path.join(folder, "out", "evaluations", "pdfjs", "results.md"), "utf8"), /2 of 3 answers \(67%\)/u);
});

test("remove deletes only the sources upload recorded", async () => {
  const removed = await tool("remove", "--output", "out", "--cli", fake, "--business", "biz_test");
  assert.equal(removed.code, 0, removed.stdout);
  assert.equal((await state()).sources.length, 0);
  const uploads = JSON.parse(await readFile(path.join(folder, "out", "uploads.json"), "utf8")) as { uploads: unknown[] };
  assert.deepEqual(uploads.uploads, []);
});
