import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// A transaction holds one PostgreSQL connection, and a connection runs one
// query at a time. Queries started together on it only queue inside pg, which
// warns that this will stop working in pg 9. Await them one after another.

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceDirectories = ["apps", "packages", "scripts"];
const skippedDirectories = new Set(["node_modules", "dist", ".next", "e2e", "public"]);

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;

function isFunction(node: ts.Node): node is FunctionNode {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

function boundNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((element) => ts.isBindingElement(element) ? boundNames(element.name) : []);
}

/** The callback a `transaction(...)` call runs, such as db.transaction or withBusinessTransaction. */
function isTransactionCallback(node: FunctionNode): boolean {
  const call = node.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(node as ts.Expression)) return false;
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  return ts.isIdentifier(callee) && /transaction$/i.test(callee.text);
}

/** The names a function's parameters give to transactions. */
function transactionParameters(node: FunctionNode, file: ts.SourceFile): string[] {
  return node.parameters.flatMap((parameter, index) => {
    if (ts.isIdentifier(parameter.name)) {
      const typed = parameter.type && /\bDatabaseTransaction\b/.test(parameter.type.getText(file));
      return parameter.name.text === "tx" || typed || (index === 0 && isTransactionCallback(node)) ? [parameter.name.text] : [];
    }
    return boundNames(parameter.name).filter((name) => name === "tx");
  });
}

/** Whether the expression uses one of the transactions, skipping nested functions that reuse a name for their own. */
function usesTransaction(node: ts.Node, names: ReadonlySet<string>): boolean {
  if (!names.size) return false;
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
    return !isPropertyName && names.has(node.text);
  }
  if (isFunction(node)) {
    const shadowed = new Set(node.parameters.flatMap((parameter) => boundNames(parameter.name)));
    const visible = new Set([...names].filter((name) => !shadowed.has(name)));
    return node.body ? usesTransaction(node.body, visible) : false;
  }
  return ts.forEachChild(node, (child) => usesTransaction(child, names) || undefined) ?? false;
}

/** Promise.all-style calls in the source that start two or more queries on one transaction at once. */
function concurrentTransactionQueries(source: string, fileName = "source.ts"): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  function visit(node: ts.Node, names: ReadonlySet<string>) {
    const scope = isFunction(node) ? new Set([...names, ...transactionParameters(node, file)]) : names;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Promise"
      && ["all", "allSettled"].includes(node.expression.name.text)) {
      const [work] = node.arguments;
      // Each array entry starts at once; so does each item of a mapped list.
      const concurrent = work && ts.isArrayLiteralExpression(work)
        ? work.elements.filter((element) => usesTransaction(element, scope)).length > 1
        : Boolean(work && ts.isCallExpression(work) && ts.isPropertyAccessExpression(work.expression)
          && ["map", "flatMap"].includes(work.expression.name.text) && work.arguments[0] && usesTransaction(work.arguments[0], scope));
      if (concurrent) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(file, new Set());
  return lines;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|e2e|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("queries on one transaction", () => {
  it("flags queries started together on one transaction", () => {
    expect(concurrentTransactionQueries(`
      async function load(tx: DatabaseTransaction) {
        return await Promise.all([tx.select().from(a), tx.select().from(b).then((rows) => rows[0])]);
      }
    `)).toEqual([3]);
    expect(concurrentTransactionQueries(`
      await withBusinessTransaction(db, context, async (workerTx) => {
        await Promise.allSettled([loadOptions(workerTx, id), workerTx.execute(statement)]);
      });
    `)).toEqual([3]);
    expect(concurrentTransactionQueries(`
      await withOperatorTransaction(request, async ({ businessId, tx }) => {
        await Promise.all(rows.map((row) => tx.insert(items).values(row)));
      });
    `)).toEqual([3]);
  });

  it("allows one query beside other work, and separate transactions", () => {
    expect(concurrentTransactionQueries(`
      async function load(tx: DatabaseTransaction, context: DomainContext) {
        await Promise.all([tx.select().from(a), fetch(url)]);
        await Promise.all([
          withBusinessTransaction(context.db, first, async (tx) => await tx.select().from(a)),
          withBusinessTransaction(context.db, second, async (tx) => await tx.select().from(b)),
        ]);
        await Promise.all(batch.map((startsAt) => checkAvailability(context, { startsAt })));
        const rows = await tx.select().from(a);
        const more = await tx.select().from(b);
        return { rows, more, other: { tx: 1 }.tx };
      }
    `)).toEqual([]);
  });

  it("keeps every transaction's queries in order", () => {
    const violations = sourceDirectories.flatMap(sourceFiles)
      .flatMap((path) => concurrentTransactionQueries(readFileSync(join(root, path), "utf8"), path).map((line) => `${path}:${line}`));
    expect(violations).toEqual([]);
  });
});
