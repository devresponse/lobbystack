import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// `%` and `_` are wildcards in SQL's LIKE, and `\` is its escape character, so
// text somebody typed into a search box cannot go into a pattern as it stands:
// a search for "50%" would match every value starting "50", and one ending in
// a backslash would fail outright. `searchPattern` (@lobbystack/db) escapes the
// three and wraps the term. This is the technical audit's AUDIT-012.

const root = fileURLToPath(new URL("../", import.meta.url));
const searchedDirectories = ["apps/admin/app", "apps/admin/src", "apps/worker/src", "packages/agent-core/src", "packages/db/src", "packages/domain/src", "packages/jobs/src", "packages/providers/src"];
const skippedDirectories = new Set(["node_modules", "dist", ".next"]);
const patternFunctions = new Set(["ilike", "like", "notIlike", "notLike"]);

/** The lines where a LIKE pattern is built by interpolating into a template. */
function unescapedPatterns(source: string, fileName = "source.ts"): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && patternFunctions.has(node.expression.text)) {
      // A template with nothing interpolated, or a plain string, is a pattern
      // written here; only a substitution carries something from outside.
      const pattern = node.arguments[1];
      if (pattern && ts.isTemplateExpression(pattern)) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return lines;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|testing|e2e|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("text typed into a search box", () => {
  it("flags a pattern built by interpolation", () => {
    expect(unescapedPatterns(`
      const byName = ilike(contacts.name, \`%\${search}%\`);
      const byEmail = notIlike(contacts.email, \`%\${term}\`);
      const byPhone = like(contacts.phone, \`\${prefix}%\`);
    `)).toEqual([2, 3, 4]);
  });

  it("allows searchPattern, a fixed pattern, and other things with these names", () => {
    expect(unescapedPatterns(`
      const byName = ilike(contacts.name, searchPattern(search));
      const draft = ilike(calls.status, "draft%");
      const fixed = ilike(calls.status, \`draft%\`);
      const unrelated = object.ilike(column, \`%\${search}%\`);
    `)).toEqual([]);
  });

  it("escapes every search the code runs", () => {
    const violations = searchedDirectories.flatMap(sourceFiles)
      .flatMap((path) => unescapedPatterns(readFileSync(join(root, path), "utf8"), path).map((line) => `${path}:${line}`));
    expect(violations).toEqual([]);
  });
});
