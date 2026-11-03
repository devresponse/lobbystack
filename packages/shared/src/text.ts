/**
 * text without the characters at its end that drop accepts, by a linear scan.
 * An end-anchored regular expression such as /[\s.;:,]+$/ backtracks over a
 * long run of those characters followed by another one, so it takes
 * quadratic time on text that someone typed.
 */
export function trimEndWhere(text: string, drop: (character: string) => boolean): string {
  let end = text.length;
  while (end > 0 && drop(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}
