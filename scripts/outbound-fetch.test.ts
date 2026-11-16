import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Node's fetch has no time limit of its own short of 300 seconds for the
// headers and 300 more between chunks of the body. A call from a server to
// another service therefore sets one: through fetchWithTimeout
// (@lobbystack/shared), or with a `signal` written in the call, as the calls
// with a budget of their own do. Without it, a service that stalls holds a
// request or a job slot for minutes.

const root = fileURLToPath(new URL("../", import.meta.url));
// Code that only ever runs on a server. The admin's src/ holds browser code
// too, where fetch calls the admin itself, so it isn't read here: its two
// calls to another service (src/lib/turnstile.ts, src/lib/live-prototype.ts)
// each pass a signal.
const serverDirectories = ["apps/worker/src", "apps/admin/app/api", "packages/agent-core/src", "packages/db/src", "packages/domain/src", "packages/jobs/src", "packages/providers/src"];
const skippedDirectories = new Set(["node_modules", "dist", ".next"]);

/** Whether the call's options are written in place and name a `signal`. */
function setsSignal(options: ts.Expression | undefined): boolean {
  return Boolean(options && ts.isObjectLiteralExpression(options) && options.properties.some((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name) && property.name.text === "signal"));
}

/** The lines where the source calls fetch, or globalThis.fetch, with no time limit. */
function untimedFetches(source: string, fileName = "source.ts"): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isFetch = (ts.isIdentifier(callee) && callee.text === "fetch")
        || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "globalThis" && callee.name.text === "fetch");
      if (isFetch && !setsSignal(node.arguments[1])) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
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

describe("calls from a server to another service", () => {
  it("flags a fetch with no time limit", () => {
    expect(untimedFetches(`
      const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
      const account = await fetch(url);
      const batch = await globalThis.fetch(host, init);
      const spread = await fetch(host, { ...init });
    `)).toEqual([2, 3, 4, 5]);
  });

  it("allows fetchWithTimeout, a signal written in the call, and other things named fetch", () => {
    expect(untimedFetches(`
      const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", { method: "POST", body });
      const crawl = await fetch(endpoint, { method: "GET", signal: AbortSignal.timeout(Math.min(30_000, remaining)) });
      const worker = await fetch(address, { ...init, signal });
      const number = await this.client.incomingPhoneNumbers(id).fetch();
      const sent = await this.send(url, { method, signal: AbortSignal.timeout(30_000) });
    `)).toEqual([]);
  });

  it("gives every call a time limit", () => {
    const violations = serverDirectories.flatMap(sourceFiles)
      .flatMap((path) => untimedFetches(readFileSync(join(root, path), "utf8"), path).map((line) => `${path}:${line}`));
    expect(violations).toEqual([]);
  });
});
