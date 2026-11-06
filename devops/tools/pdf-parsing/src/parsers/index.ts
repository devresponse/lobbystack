import { currentParser } from "./current/index.ts";
import { pdfjsParser } from "./pdfjs/index.ts";
import type { Parser } from "./types.ts";

/** Every reader the tool can run, by the name --parser takes. Add a reader here to compare it. */
export const parsers: ReadonlyMap<string, Parser> = new Map([currentParser, pdfjsParser].map((parser) => [parser.name, parser]));

/** Reads --parser: one name, a comma-separated list, or "all". */
export function pickParsers(value: string | undefined): Parser[] {
  const names = !value || value === "all" ? (value === "all" ? [...parsers.keys()] : ["current"]) : value.split(",").map((name) => name.trim()).filter(Boolean);
  return [...new Set(names)].map((name) => {
    const parser = parsers.get(name);
    if (!parser) throw new Error(`There's no parser named ${name}. Use ${[...parsers.keys()].join(", ")} or all.`);
    return parser;
  });
}
