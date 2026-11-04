#!/usr/bin/env node
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { checkCopies } from "./copyCheck.ts";
import { evaluateQuestions } from "./evaluate.ts";
import { parsers, pickParsers } from "./parsers/index.ts";
import type { PageMarkers } from "./parsers/types.ts";
import { readResults, rescore, writeReport } from "./report.ts";
import { parseAll } from "./run.ts";
import { removeUploads, uploadResults, type UploadSource } from "./upload.ts";

const toolFolder = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const repoFolder = path.resolve(toolFolder, "../../..");

const usage = `pdf-parsing: read a folder of PDFs with today's worker reader or pdfjs-dist, score the text, and upload it to a test business.

Usage: node src/cli.ts <command> [options]   (or npm run pdf-parsing -- <command> [options])

Commands:
  parse        Read every PDF in a folder; each document gets its own output folder.
  report       Score the saved results again, after adding truth files, and rewrite the summaries.
  upload       Upload one reader's text, or the PDFs themselves, to a test business.
  remove       Remove from the business what upload added, as its record lists.
  evaluate     Ask questions through the knowledge search and check each answer is in the evidence.
  check-copy   Check the copied reader and chunkText still match the repository's.
  parsers      List the readers.

parse:
  --input <folder|file>      The PDFs to read (required).
  --output <folder>          Where results go. Default: ./out
  --parser <name>            ${[...parsers.keys()].join(", ")}, a comma-separated list, or all. Default: current
  --truth <folder>           Where <document>.html, .md or .txt hold each document's correct text. Default: the input folder
  --recursive                Also read the PDFs in subfolders.
  --timeout-ms <ms>          Deadline for one document, as the worker's. Default: 300000
  --max-heap-mb <mb>         Heap cap for one document's thread, as the worker's. Default: 512
  --ocr-max-pages <n>        pdfjs: pages without text to read by OCR. Default: 50
  --page-markers <style>     pdfjs: line ([Page 2 of 9]), heading (## Page 2 of 9) or none. Default: line

report:
  --output <folder>          A folder parse wrote. Default: ./out
  --truth <folder>           Score against this truth folder instead of the one parse used.

upload, remove and evaluate run the repository's lobbystack CLI (packages/cli/dist/bin.js; build it once
with pnpm --filter @lobbystack/cli build) with its saved profile or LOBBYSTACK_* variables:
  --business <id>            The test business. Default: the profile's business
  --profile <name>           The lobbystack CLI profile to use.
  --cli <file>               Another lobbystack CLI bin.js to run.

upload:
  --output <folder>          A folder parse wrote. Default: ./out
  --parser <name>            Whose text to upload (required unless --source pdf).
  --source <text|pdf>        text uploads the reader's text as Markdown; pdf uploads the PDF, which the
                             deployment reads with its own reader. Default: text
  --tag <tag>                Extra tags, besides pdf-parsing and parser:<name>. Repeat or separate with commas.
  --dry-run                  List what would be uploaded, and upload nothing.

remove:
  --output <folder>          Default: ./out
  --parser <name>            Only what was uploaded for this reader (or pdf). Default: everything listed
  --dry-run                  List what would be removed, and remove nothing.

evaluate:
  --questions <file>         A .csv or .json of questions with question, answer and optional document columns (required).
  --output <folder>          Default: ./out
  --label <name>             Names the run's folder under <output>/evaluations. Default: search
`;

type Values = Record<string, string | boolean | string[] | undefined>;

function read(args: string[], options: ParseArgsConfig["options"]): Values {
  const { values, positionals } = parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  if (positionals.length) throw new UsageError(`Unexpected argument: ${positionals.join(" ")}`);
  return values as Values;
}

class UsageError extends Error {}

const text = (values: Values, name: string) => (typeof values[name] === "string" ? (values[name] as string) : undefined);
function count(values: Values, name: string, fallback: number): number {
  const value = text(values, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`--${name} takes a whole number above 0, not ${value}.`);
  return parsed;
}
const resolved = (value: string | undefined, fallback: string) => path.resolve(value ?? fallback);
const connection = { business: { type: "string" }, profile: { type: "string" }, cli: { type: "string" } } as const;
const cliOptions = (values: Values) => ({ business: text(values, "business"), profile: text(values, "profile"), cli: text(values, "cli") ? path.resolve(text(values, "cli") ?? "") : path.join(repoFolder, "packages/cli/dist/bin.js") });

/** tesseract.js keeps its language files in the working folder, so OCR runs from the tool's cache folder. */
async function useOcrCache(): Promise<void> {
  const cache = path.join(toolFolder, ".cache", "tesseract");
  await mkdir(cache, { recursive: true });
  process.chdir(cache);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const log = (line: string) => console.log(line);
  switch (command) {
    case "parse": {
      const values = read(args, {
        input: { type: "string" },
        output: { type: "string" },
        parser: { type: "string" },
        truth: { type: "string" },
        recursive: { type: "boolean" },
        "timeout-ms": { type: "string" },
        "max-heap-mb": { type: "string" },
        "ocr-max-pages": { type: "string" },
        "page-markers": { type: "string" },
      });
      if (values.help) return help();
      const inputValue = text(values, "input");
      if (!inputValue) throw new UsageError("parse needs --input <folder|file>.");
      const input = path.resolve(inputValue);
      const markers = text(values, "page-markers") ?? "line";
      if (!["line", "heading", "none"].includes(markers)) throw new UsageError(`--page-markers is line, heading or none, not ${markers}.`);
      const output = resolved(text(values, "output"), "out");
      const truthValue = text(values, "truth");
      const truthFolder = truthValue ? path.resolve(truthValue) : (await isFile(input)) ? path.dirname(input) : input;
      const run = {
        input,
        output,
        parsers: chosenParsers(text(values, "parser")),
        truthFolder,
        recursive: values.recursive === true,
        options: { limits: { timeoutMs: count(values, "timeout-ms", 300_000), maxHeapMb: count(values, "max-heap-mb", 512) }, ocrMaxPages: count(values, "ocr-max-pages", 50), pageMarkers: markers as PageMarkers },
        log,
      };
      await mkdir(output, { recursive: true });
      await useOcrCache();
      const results = await parseAll(run);
      const summary = await writeReport(output, await readResults(output));
      const failed = results.filter((result) => result.error).length;
      log(`\n${results.length} result${results.length === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}. Summary: ${summary}`);
      return 0;
    }
    case "report": {
      const values = read(args, { output: { type: "string" }, truth: { type: "string" } });
      if (values.help) return help();
      const output = resolved(text(values, "output"), "out");
      const results = await readResults(output);
      if (!results.length) throw new UsageError(`There are no results in ${output}. Run parse first.`);
      await rescore(output, results, text(values, "truth") ? path.resolve(text(values, "truth") ?? "") : undefined);
      log(`Summary: ${await writeReport(output, results)}`);
      return 0;
    }
    case "upload": {
      const values = read(args, { ...connection, output: { type: "string" }, parser: { type: "string" }, source: { type: "string" }, tag: { type: "string", multiple: true }, "dry-run": { type: "boolean" } });
      if (values.help) return help();
      const source = (text(values, "source") ?? "text") as UploadSource;
      if (source !== "text" && source !== "pdf") throw new UsageError(`--source is text or pdf, not ${String(source)}.`);
      const parser = text(values, "parser");
      if (source === "text" && !parser) throw new UsageError("upload --source text needs --parser <name>: whose text to upload.");
      const tags = (Array.isArray(values.tag) ? values.tag : []).flatMap((tag) => tag.split(",")).map((tag) => tag.trim()).filter(Boolean);
      return await uploadResults({ output: resolved(text(values, "output"), "out"), parser, source, tags, dryRun: values["dry-run"] === true, lobbystack: cliOptions(values), log });
    }
    case "remove": {
      const values = read(args, { ...connection, output: { type: "string" }, parser: { type: "string" }, "dry-run": { type: "boolean" } });
      if (values.help) return help();
      return await removeUploads({ output: resolved(text(values, "output"), "out"), parser: text(values, "parser"), dryRun: values["dry-run"] === true, lobbystack: cliOptions(values), log });
    }
    case "evaluate": {
      const values = read(args, { ...connection, questions: { type: "string" }, output: { type: "string" }, label: { type: "string" } });
      if (values.help) return help();
      const questions = text(values, "questions");
      if (!questions) throw new UsageError("evaluate needs --questions <file>.");
      const label = text(values, "label") ?? "search";
      if (!/^[\w.-]+$/u.test(label)) throw new UsageError("--label takes letters, digits, dots, dashes and underscores.");
      return await evaluateQuestions({ questions: path.resolve(questions), output: resolved(text(values, "output"), "out"), label, lobbystack: cliOptions(values), log });
    }
    case "check-copy": {
      const values = read(args, { fix: { type: "boolean" } });
      if (values.help) return help();
      return await checkCopies({ repo: repoFolder, tool: toolFolder, fix: values.fix === true, log });
    }
    case "parsers": {
      for (const parser of parsers.values()) log(`${parser.name.padEnd(8)} ${parser.summary}`);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return help();
    default:
      throw new UsageError(`There's no command named ${command}.`);
  }
}

/** pickParsers, with an unknown name reported as a usage error. */
function chosenParsers(value: string | undefined) {
  try {
    return pickParsers(value);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined))?.isFile() === true;
}

function help(): number {
  console.log(usage);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
    console.error(`${(error as Error).message}\n\nRun node src/cli.ts help for the options.`);
    process.exitCode = 2;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
