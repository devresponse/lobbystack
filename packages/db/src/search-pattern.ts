/**
 * The `LIKE` pattern for text somebody typed into a search box.
 *
 * `%` and `_` are wildcards in `LIKE`, so until the technical audit's
 * AUDIT-012 a search for `50%` matched every value starting "50", and `o_t`
 * matched "out" and "oat" alike. A lone trailing backslash was worse: it is
 * `LIKE`'s escape character, and PostgreSQL rejects a pattern that ends in
 * one, so the search failed with an error.
 *
 * Each of the three is escaped with a backslash, which is what PostgreSQL
 * takes `LIKE`'s escape character to be when the pattern arrives as a bind
 * parameter and no `ESCAPE` clause is written. The term is then wrapped so it
 * matches anywhere in the value, which is what every search here wants.
 */
export function searchPattern(term: string): string {
  return `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}
