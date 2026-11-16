import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * A size budget for the modules and functions that change often (AUDIT-013).
 *
 * The technical audit found billing, calls and the v1 API living in the
 * hardest files in the repository to read, `operations.ts` at 2,700 lines and
 * `dispatchJob` at 789, and named the cause as there being no budget and no
 * formatter to push back. A budget is what this is.
 *
 * `module-size-budget.json` records a ceiling for each file and function
 * already over the line. Nothing new may cross it, and nothing listed may grow
 * past its ceiling: a feature that would has to take the seam the audit named
 * instead, which is `operations.ts` by resource, `dispatchJob` into a map from
 * job type to handler, and billing reconciliation into one handler per event.
 * When one does shrink, `pnpm module-size:update` writes the smaller ceiling.
 * That is all the update does: it refuses to raise a ceiling or to add an
 * entry, so growth is never one command away.
 */

export const FILE_LINES = 800;
export const FUNCTION_LINES = 150;
/** Ceilings are rounded up to this, so a one-line fix in a long file isn't a failing build. */
export const STEP = 25;

/**
 * Where the budget applies. `apps/landing` is left out: the fork doesn't
 * publish it, and what is long there is the legal texts and the SEO page
 * copy, which are text rather than logic and don't split into anything.
 */
export const BUDGETED_DIRECTORIES = ["apps/admin/app", "apps/admin/src", "apps/worker/src", "packages"];
const skippedDirectories = new Set(["node_modules", "dist", ".next", "coverage", "migrations", "__snapshots__"]);

export type Budget = { files: Record<string, number>; functions: Record<string, number> };
export type Sizes = { files: Record<string, number>; functions: Record<string, number> };

export function ceilingFor(lines: number): number {
  return Math.ceil(lines / STEP) * STEP;
}

/** Every long function in one file, as `name` to its length in lines. */
export function longFunctions(source: string, fileName: string): Record<string, number> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Record<string, number> = {};
  let anonymous = 0;
  function nameOf(node: ts.Node): string {
    const named = node as { name?: ts.Node };
    if (named.name && ts.isIdentifier(named.name)) return named.name.text;
    const parent = node.parent;
    if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && ts.isIdentifier(parent.name)) return parent.name.text;
    anonymous += 1;
    return `(anonymous ${anonymous})`;
  }
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const from = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
      const to = file.getLineAndCharacterOfPosition(node.getEnd()).line;
      const lines = to - from + 1;
      if (lines >= FUNCTION_LINES) found[nameOf(node)] = lines;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

export function sourceFiles(root: string, directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : sourceFiles(root, path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|testing|e2e|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** What the repository holds today: only what is already over a threshold. */
export function measure(root: string): Sizes {
  const sizes: Sizes = { files: {}, functions: {} };
  for (const path of BUDGETED_DIRECTORIES.flatMap((directory) => sourceFiles(root, directory))) {
    const text = readFileSync(join(root, path), "utf8");
    const lines = text.split("\n").length;
    if (lines >= FILE_LINES) sizes.files[path] = lines;
    for (const [name, length] of Object.entries(longFunctions(text, path))) sizes.functions[`${path}#${name}`] = length;
  }
  return sizes;
}

/** What is wrong with the repository against this budget, in the words the author needs. */
export function compare(sizes: Sizes, budget: Budget): string[] {
  const problems: string[] = [];
  for (const kind of ["files", "functions"] as const) {
    const thing = kind === "files" ? "file" : "function";
    const threshold = kind === "files" ? FILE_LINES : FUNCTION_LINES;
    for (const [path, lines] of Object.entries(sizes[kind])) {
      const ceiling = budget[kind][path];
      if (ceiling === undefined) problems.push(`${path}: a new ${thing} of ${lines} lines, over the ${threshold}-line budget. Split it along a seam that already exists rather than adding it here.`);
      else if (lines > ceiling) problems.push(`${path}: ${lines} lines, past its ceiling of ${ceiling}. Take the change somewhere smaller, or split the ${thing}.`);
      else if (lines <= ceiling - STEP) problems.push(`${path}: ${lines} lines, well under its ceiling of ${ceiling}. Run \`pnpm module-size:update\` to bring the ceiling down with it.`);
    }
    for (const path of Object.keys(budget[kind])) {
      if (sizes[kind][path] === undefined) problems.push(`${path}: no longer over the ${threshold}-line budget, or gone. Run \`pnpm module-size:update\` to take it off the list.`);
    }
  }
  return problems;
}

const sorted = <T>(entries: Record<string, T>) => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));

export function budgetFrom(sizes: Sizes): Budget {
  return {
    files: sorted(Object.fromEntries(Object.entries(sizes.files).map(([path, lines]) => [path, ceilingFor(lines)]))),
    functions: sorted(Object.fromEntries(Object.entries(sizes.functions).map(([path, lines]) => [path, ceilingFor(lines)]))),
  };
}

/**
 * The budget an update may write. A ceiling comes down with what it measures,
 * and an entry leaves when its file or function is back under the line.
 * Nothing goes up and nothing joins: whatever has grown or is new is refused,
 * and then nothing is written. A ceiling raised on purpose is a hand edit of
 * the file, which a reviewer sees.
 */
export function lowered(sizes: Sizes, budget: Budget): { budget: Budget; refused: string[] } {
  const next: Budget = { files: {}, functions: {} };
  const refused: string[] = [];
  for (const kind of ["files", "functions"] as const) {
    for (const [path, lines] of Object.entries(sizes[kind])) {
      const ceiling = budget[kind][path];
      if (ceiling === undefined) refused.push(`${path}: ${lines} lines, and not in the budget.`);
      else if (lines > ceiling) refused.push(`${path}: ${lines} lines, past its ceiling of ${ceiling}.`);
      else next[kind][path] = Math.min(ceiling, ceilingFor(lines));
    }
    next[kind] = sorted(next[kind]);
  }
  return { budget: next, refused };
}

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const budgetPath = fileURLToPath(new URL("./module-size-budget.json", import.meta.url));

export function readBudget(): Budget {
  return JSON.parse(readFileSync(budgetPath, "utf8")) as Budget;
}

// Only when run as `pnpm module-size:update`, never when a test imports this.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { budget, refused } = lowered(measure(repositoryRoot), readBudget());
  if (refused.length > 0) {
    console.error(["The update only lowers ceilings, so the budget is left as it was:", ...refused.map((line) => `  ${line}`), "Split along a seam instead: docs/development/README.md, \"Keep a module small enough to read\"."].join("\n"));
    process.exit(1);
  }
  writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(budget.files).length} files and ${Object.keys(budget.functions).length} functions to scripts/module-size-budget.json.`);
}
