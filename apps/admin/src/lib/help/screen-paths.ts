import { stripLocalePrefix } from "../locale-path";

/** A help page's app addresses, as its article's screenPaths lists them. */
export type HelpScreenPages = ReadonlyArray<{ slug: string; screenPaths: readonly string[] }>;

type Matcher = { slug: string; parts: readonly string[]; fixed: boolean };

function isParameter(part: string): boolean {
  return part.startsWith("{") && part.endsWith("}");
}

function pathParts(path: string): string[] {
  return path === "/" || path === "" ? [] : path.slice(1).split("/");
}

function matches(matcher: Matcher, parts: readonly string[]): boolean {
  return matcher.parts.length === parts.length && matcher.parts.every((part, index) => isParameter(part) ? parts[index] !== "" : part === parts[index]);
}

/**
 * Finds the help page for an app address, with or without a language prefix,
 * query or hash. A `{name}` part of a screen path stands for any one part of
 * the address, and a fixed address wins over a pattern, so /calls/active could
 * never be taken for /calls/{callId}.
 */
export function createHelpPathMatcher(pages: HelpScreenPages): (pathname: string) => string | null {
  const matchers: readonly Matcher[] = pages
    .flatMap(({ slug, screenPaths }) => screenPaths.map((path) => {
      const parts = pathParts(path);
      return { slug, parts, fixed: !parts.some(isParameter) };
    }))
    .sort((left, right) => Number(right.fixed) - Number(left.fixed));
  return (pathname) => {
    let path = stripLocalePrefix(pathname.split("?")[0]!.split("#")[0]!);
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const parts = pathParts(path);
    return matchers.find((matcher) => matches(matcher, parts))?.slug ?? null;
  };
}
