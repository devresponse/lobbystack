import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { failureMessage, runLobbystack, whoami, type LobbystackOptions } from "./lobbystack.ts";
import { countNumbers, numbersIn } from "./numbers.ts";

/** One question with the answer the documents give, and optionally the document that gives it. */
export type Question = { question: string; answer: string; document?: string; page?: string };

type Passage = { title?: string; content?: string; sequence?: number; rank?: number };
type SearchAnswer = { outcome?: string; duration_ms?: number; evidence?: Passage[] };

export type QuestionResult = Question & {
  outcome: string;
  /** Whether a passage the search handed over holds the answer: every number in it, or its words. */
  found: boolean;
  /** The first such passage's place among the evidence, from 1. */
  rank: number | null;
  /** Whether one of those passages comes from the document named, when one is. */
  fromDocument: boolean | null;
  passageTitle: string | null;
  passages: number;
  durationMs: number | null;
  error: string | null;
};

/** Splits CSV text into rows, with quoted cells as spreadsheets write them. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length) rows.push([...row, cell]);
  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

export async function readQuestions(file: string): Promise<Question[]> {
  const content = (await readFile(file, "utf8")).replace(/^﻿/u, "");
  let entries: Array<Record<string, unknown>>;
  if (path.extname(file).toLowerCase() === ".json") {
    const parsed = JSON.parse(content) as unknown;
    entries = (Array.isArray(parsed) ? parsed : ((parsed as { questions?: unknown[] }).questions ?? [])) as Array<Record<string, unknown>>;
  } else {
    const [header, ...rows] = parseCsv(content);
    const names = (header ?? []).map((name) => name.trim().toLowerCase());
    entries = rows.map((values) => Object.fromEntries(names.map((name, index) => [name, values[index] ?? ""])));
  }
  return entries.map((entry, index) => {
    const question = String(entry.question ?? "").trim();
    const answer = String(entry.answer ?? "").trim();
    if (!question || !answer) throw new Error(`Question ${index + 1} in ${file} needs both a question and an answer.`);
    const document = String(entry.document ?? "").trim();
    const page = String(entry.page ?? "").trim();
    return { question, answer, ...(document ? { document } : {}), ...(page ? { page } : {}) };
  });
}

const plainWords = (text: string) => text.toLowerCase().replace(/\s+/gu, " ").trim();

/** Whether the passage holds the answer: each of its numbers in canonical form, or else its words. */
export function holdsAnswer(content: string, answer: string): boolean {
  const wanted = countNumbers(numbersIn(answer));
  if (wanted.size === 0) return plainWords(content).includes(plainWords(answer));
  const present = countNumbers(numbersIn(content));
  return [...wanted].every(([value, count]) => (present.get(value) ?? 0) >= count);
}

const fromDocument = (title: string | undefined, document: string) => {
  const name = (title ?? "").toLowerCase();
  const wanted = document.toLowerCase().replace(/\.pdf$/u, "");
  return name === wanted || name.startsWith(`${wanted} (`) || name.startsWith(`${wanted}.`);
};

export type EvaluateRun = { questions: string; output: string; label: string; lobbystack: LobbystackOptions; log(line: string): void };

/**
 * Asks each question through the knowledge search, as the receptionist would, and checks the
 * passages it hands over: the design's "evidence" score, which tells a search miss from a misreading.
 */
export async function evaluateQuestions(run: EvaluateRun): Promise<number> {
  const questions = await readQuestions(run.questions);
  if (!questions.length) throw new Error(`There are no questions in ${run.questions}.`);
  const folder = path.join(run.output, "evaluations", run.label);
  await mkdir(folder, { recursive: true });
  const me = await whoami(run.lobbystack);
  run.log(`Asking ${questions.length} question(s) of ${me.business?.name ?? ""} (${me.business?.id ?? ""}) on ${me.url}.`);
  const results: QuestionResult[] = [];
  for (const question of questions) {
    // The CLI saves the search's whole answer in the folder too, one JSON file per question.
    const cli = await runLobbystack(run.lobbystack, ["knowledge", "search", question.question, "--log-dir", path.join(folder, "searches")]);
    let answer: SearchAnswer = {};
    let error: string | null = null;
    if (cli.code === 0) answer = JSON.parse(cli.stdout) as SearchAnswer;
    else error = failureMessage(cli);
    const evidence = answer.evidence ?? [];
    const holding = evidence.filter((passage) => holdsAnswer(passage.content ?? "", question.answer));
    const passage = holding[0];
    const hit = passage ? evidence.indexOf(passage) : -1;
    const document = question.document;
    results.push({
      ...question,
      outcome: error ? "failed" : (answer.outcome ?? "unknown"),
      found: hit >= 0,
      rank: hit >= 0 ? hit + 1 : null,
      fromDocument: document && passage ? holding.some((entry) => fromDocument(entry.title, document)) : null,
      passageTitle: passage?.title ?? null,
      passages: evidence.length,
      durationMs: answer.duration_ms ?? null,
      error,
    });
    run.log(`  ${hit >= 0 ? "found " : "missed"}  ${question.question}${hit >= 0 ? ` (passage ${hit + 1}, ${passage?.title ?? ""})` : error ? ` (${error})` : ""}`);
  }
  const found = results.filter((result) => result.found).length;
  const withDocument = results.filter((result) => result.document);
  const rightDocument = withDocument.filter((result) => result.fromDocument).length;
  const summary = { label: run.label, askedAt: new Date().toISOString(), url: me.url, business: me.business, questions: results.length, found, foundShare: found / results.length, rightDocument: withDocument.length ? `${rightDocument} of ${withDocument.length}` : null, results };
  await writeFile(path.join(folder, "results.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const cell = (value: unknown) => String(value ?? "-").replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/\s+/gu, " ");
  await writeFile(path.join(folder, "results.md"), [
    `# Knowledge search check: ${run.label}`,
    "",
    `${found} of ${results.length} answers (${Math.round((found / results.length) * 100)}%) were in a passage the search handed over${withDocument.length ? `, ${rightDocument} of ${withDocument.length} from the document named` : ""}. Asked of ${me.business?.name ?? ""} on ${me.url}.`,
    "",
    "| Question | Answer | Found | Passage | Title | Document | Outcome |",
    "|---|---|---|---|---|---|---|",
    ...results.map((result) => `| ${cell(result.question)} | ${cell(result.answer)} | ${result.found ? "yes" : "no"} | ${cell(result.rank)} | ${cell(result.passageTitle)} | ${cell(result.document)} | ${cell(result.error ?? result.outcome)} |`),
    "",
  ].join("\n"));
  run.log(`\n${found} of ${results.length} answers found in the evidence. Results: ${path.join(folder, "results.md")}`);
  return results.some((result) => result.error) ? 1 : 0;
}
