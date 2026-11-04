import { readFile } from "node:fs/promises";
import path from "node:path";

import { numbersIn } from "./numbers.ts";

/** A document's correct content, written by hand or exported from its source, to score a reader against. */
export type Truth = {
  file: string;
  /** The text, with table cells separated by " | ". */
  text: string;
  /**
   * Table rows with two or more numbers. A reader keeps a row whole when one line of its text
   * holds the row's label (its first two words) and its numbers, in order.
   */
  rows: TruthRow[];
  footnoteMarks: number;
};

export type TruthRow = { label: string; numbers: string[] };

/** A row's label for matching: the first two words of its first cell, when that cell has letters. */
function rowOf(cells: readonly string[]): TruthRow | undefined {
  const numbers = numbersIn(cells.join(" | "));
  if (numbers.length < 2) return undefined;
  const first = cells[0] ?? "";
  return { label: /\p{L}/u.test(first) ? first.trim().split(/\s+/u).slice(0, 2).join(" ") : "", numbers };
}

const truthExtensions = [".html", ".htm", ".md", ".txt"];

const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", minus: "−", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ecirc: "ê", ocirc: "ô", euro: "€" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    if (/^#x/iu.test(entity)) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? whole;
  });
}

// Elements that end a line of text.
const blockElements = new Set(["br", "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "li", "table", "thead", "tbody", "ul", "ol", "section", "header", "footer"]);

/**
 * Reads an HTML page as text: block elements on their own lines, table cells split by " | ",
 * superscripts (footnote marks) left out. A small scanner, not a full HTML parser: enough for
 * pages exported from a spreadsheet or written by hand.
 */
export function htmlTruth(html: string, file = ""): Truth {
  const lines: string[] = [];
  const rows: TruthRow[] = [];
  let line = "";
  let row: string[] | undefined;
  let cell: string | undefined;
  let footnoteMarks = 0;
  let superscript = 0;
  let skipUntil: string | undefined;

  const endLine = () => {
    const text = decodeEntities(line).replace(/\s+/gu, " ").trim();
    if (text) lines.push(text);
    line = "";
  };
  const addText = (text: string) => {
    if (skipUntil || superscript > 0) return;
    line += text;
    if (cell !== undefined) cell += text;
  };

  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) {
      addText(html.slice(at));
      break;
    }
    addText(html.slice(at, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close < 0) break;
    at = close + 1;
    const tag = /^<\s*(\/?)\s*([a-z][a-z0-9]*)/iu.exec(html.slice(open, close + 1));
    if (!tag) continue;
    const ending = tag[1] === "/";
    const name = (tag[2] ?? "").toLowerCase();
    if (skipUntil) {
      if (ending && name === skipUntil) skipUntil = undefined;
      continue;
    }
    if (!ending && (name === "style" || name === "script")) {
      skipUntil = name;
      continue;
    }
    if (name === "sup") {
      if (!ending) {
        footnoteMarks += 1;
        superscript += 1;
      } else superscript = Math.max(0, superscript - 1);
      addText(" ");
      continue;
    }
    if (name === "td" || name === "th") {
      if (ending) {
        if (row && cell !== undefined) row.push(decodeEntities(cell).replace(/\s+/gu, " ").trim());
        cell = undefined;
      } else {
        if (row && row.length > 0) line += " | ";
        cell = "";
      }
      continue;
    }
    if (name === "tr") {
      if (!ending) row = [];
      else if (row) {
        const entry = rowOf(row);
        if (entry) rows.push(entry);
        row = undefined;
      }
    }
    if (blockElements.has(name)) endLine();
    else addText(" ");
  }
  endLine();
  return { file, text: lines.join("\n"), rows, footnoteMarks };
}

/** Reads Markdown or plain text: each line with a "|" is a table row; Markdown footnote marks such as [^2] aren't numbers. */
export function textTruth(text: string, file = ""): Truth {
  const rows: TruthRow[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.includes("|") || /^[\s|:-]+$/u.test(line)) continue;
    const entry = rowOf(line.replace(/^\s*\|/u, "").split("|"));
    if (entry) rows.push(entry);
  }
  return { file, text, rows, footnoteMarks: (text.match(/\[\^[^\]\s]{1,4}\](?!:)/gu) ?? []).length };
}

/** Finds <name>.html, .htm, .md or .txt in the folder and reads it, or returns undefined. */
export async function loadTruth(folder: string, name: string): Promise<Truth | undefined> {
  for (const extension of truthExtensions) {
    const file = path.join(folder, `${name}${extension}`);
    const content = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (content === undefined) continue;
    return extension.startsWith(".htm") ? htmlTruth(content, file) : textTruth(content, file);
  }
  return undefined;
}
