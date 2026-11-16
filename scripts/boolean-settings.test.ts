import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { booleanSettings } from "../packages/shared/src/env";

// A true/false setting is read with `envFlag` (@lobbystack/shared): it takes
// true, false, 1, 0, yes, no, on and off in any case, knows what unset means,
// and names a value that is none of those when a service starts. Compared as
// text instead (`process.env.X === "true"`), "1" and "TRUE" silently mean off.
// The first pass over the code was a search by hand and missed three settings,
// so this reads every source file the two services run. It is the technical
// audit's AUDIT-017.
//
// What it cannot see: a value copied into a lower-case variable first and
// compared later, and a home-made list (`["true", "1"].includes(...)`).

const root = fileURLToPath(new URL("../", import.meta.url));
const skippedDirectories = new Set(["node_modules", "dist", ".next", "coverage"]);
const listedSettings = new Set(Object.keys(booleanSettings));
const trueFalseWords = new Set(["true", "false", "1", "0", "yes", "no", "on", "off"]);
const settingName = /^[A-Z][A-Z0-9_]+$/;
const comparisons = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const fallbacks = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]);

/**
 * The setting an expression reads, when it reads one: `x.NAME`, `x["NAME"]` or
 * a bare `NAME`, seen through brackets, `!`, `as`, a `?? ""` fallback and calls
 * that take nothing, such as `?.trim()` and `.toLowerCase()`.
 */
function settingRead(node: ts.Expression): { name: string; node: ts.Node } | undefined {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) current = current.expression;
    else if (ts.isBinaryExpression(current) && fallbacks.has(current.operatorToken.kind)) current = current.left;
    else if (ts.isCallExpression(current) && current.arguments.length === 0 && ts.isPropertyAccessExpression(current.expression)) current = current.expression.expression;
    else break;
  }
  const name = ts.isPropertyAccessExpression(current) ? current.name.text
    : ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression) ? current.argumentExpression.text
    : ts.isIdentifier(current) ? current.text
    : undefined;
  return name !== undefined && settingName.test(name) ? { name, node: current } : undefined;
}

function trueFalseWord(node: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(node) && trueFalseWords.has(node.text.toLowerCase()) ? node.text : undefined;
}

/** Where a file reads a true/false setting some other way than `envFlag`. */
function settingsReadAsText(source: string, fileName = "source.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const compared = new Set<ts.Node>();
  const at = (node: ts.Node, what: string) => found.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${what}`);
  const listed = (node: ts.Node, name: string) => {
    if (listedSettings.has(name) && !compared.has(node)) at(node, `${name} read without envFlag`);
  };
  function visit(node: ts.Node) {
    // Any setting, listed or not, compared with one of the eight words.
    if (ts.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind)) {
      const wordOnRight = trueFalseWord(node.right);
      const word = wordOnRight ?? trueFalseWord(node.left);
      const read = word === undefined ? undefined : settingRead(wordOnRight === undefined ? node.right : node.left);
      if (read) {
        at(node, `${read.name} compared with "${word}"`);
        compared.add(read.node);
      }
    }
    // A listed setting taken from the environment directly, which is how a
    // check for "is it set" (where "false" counts as set) would start.
    if (ts.isPropertyAccessExpression(node)) listed(node, node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) listed(node, node.argumentExpression.text);
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) listed(node, key.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function isSource(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.(test|testing|e2e|d)\.tsx?$/.test(name);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : sourceFiles(path);
    return isSource(entry.name) ? [path] : [];
  });
}

/** Everything the admin and the worker run: their own code and every package's. */
function serviceFiles(): string[] {
  const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "src")))
    .map((entry) => `packages/${entry.name}/src`);
  // The admin's top-level files run in the service too (the proxy, the content
  // security policy, instrumentation); its Playwright and Vitest files do not.
  const adminTopLevel = readdirSync(join(root, "apps/admin"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSource(entry.name) && !/^(playwright|vitest)[.-]/.test(entry.name))
    .map((entry) => `apps/admin/${entry.name}`);
  return [...adminTopLevel, ...["apps/admin/app", "apps/admin/src", "apps/worker/src", ...packages].flatMap(sourceFiles)];
}

describe("true/false settings", () => {
  it("flags a setting compared with a word for true or false", () => {
    expect(settingsReadAsText(`
      const exportOn = process.env.NEW_EXPORT_ENABLED === "true";
      const greeting = source.NEW_GREETING !== "false";
      const pathStyle = env["NEW_PATH_STYLE"]?.trim().toLowerCase() == "1";
      const quiet = "off" != (options.env.NEW_QUIET ?? "");
      const { NEW_SWITCH } = process.env;
      if (NEW_SWITCH === "yes") start();
    `)).toEqual([
      '2: NEW_EXPORT_ENABLED compared with "true"',
      '3: NEW_GREETING compared with "false"',
      '4: NEW_PATH_STYLE compared with "1"',
      '5: NEW_QUIET compared with "off"',
      '7: NEW_SWITCH compared with "yes"',
    ]);
  });

  it("flags a listed setting taken from the environment any other way", () => {
    expect(settingsReadAsText(`
      const exportOn = Boolean(process.env.FINANCE_EXPORT_ENABLED);
      const secure = source["SMTP_SECURE"] ? true : false;
      const { WIDGET_TURNSTILE: challenge, LIVE_PROTOTYPE_ENABLED } = process.env;
      const pathStyle = source.S3_FORCE_PATH_STYLE === "true";
    `)).toEqual([
      "2: FINANCE_EXPORT_ENABLED read without envFlag",
      "3: SMTP_SECURE read without envFlag",
      "4: WIDGET_TURNSTILE read without envFlag",
      "4: LIVE_PROTOTYPE_ENABLED read without envFlag",
      '5: S3_FORCE_PATH_STYLE compared with "true"',
    ]);
  });

  it("allows envFlag, other settings, and comparisons that are not about a setting", () => {
    expect(settingsReadAsText(`
      const exportOn = envFlag(process.env, "FINANCE_EXPORT_ENABLED");
      const production = process.env.NODE_ENV === "production";
      const archived = url.searchParams.get("archived") === "true";
      const handover = variables.transfersOwnership === "true";
      const child = { ...process.env, LIVE_PROTOTYPE_ENABLED: "true" };
      const level = process.env.LOG_LEVEL ?? "info";
    `)).toEqual([]);
  });

  it("names every listed setting in the deployment guide", () => {
    // Operators read the names there, so a setting added to the list without
    // its line in the appendix is one nobody knows they can set.
    const appendix = readFileSync(join(root, "docs/deployment/guide/appendix-a-variables.md"), "utf8");
    expect([...listedSettings].filter((name) => !appendix.includes(`\`${name}\``))).toEqual([]);
  });

  it("reads every true/false setting through envFlag", () => {
    const violations = serviceFiles()
      .flatMap((path) => settingsReadAsText(readFileSync(join(root, path), "utf8"), path).map((entry) => `${path}:${entry}`));
    expect(violations).toEqual([]);
  });
});
