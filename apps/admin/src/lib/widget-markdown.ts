// A Markdown link, whose address may hold balanced parentheses one level deep,
// as in .../Mercury_(planet), or a plain http(s) address. Quotes and angle
// brackets are escaped by the time this runs, so they end a plain address.
const LINK = /\[([^\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|https?:\/\/(?:[^\s&<]|&amp;)+/g;

function link(href: string, text: string): string {
  return `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;
}

/**
 * Where a plain address ends: before the punctuation after it, such as a full
 * stop, and before a closing parenthesis it didn't open, as when the address
 * is itself in parentheses. One it did open stays, as in .../Mercury_(planet).
 */
function plainAddressEnd(match: string): number {
  let end = match.length;
  for (;;) {
    const address = match.slice(0, end);
    // An escaped & can end a query string.
    if (address.endsWith("&amp;")) return end;
    const unopened = address.endsWith(")") && address.split(")").length > address.split("(").length;
    if (!unopened && !/[.,:;!?\]]$/.test(address)) return end;
    end -= 1;
  }
}

export function renderSafeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(LINK, (match: string, text?: string, href?: string) => {
      if (text !== undefined && href !== undefined) return link(href, text);
      const end = plainAddressEnd(match);
      const address = match.slice(0, end);
      // Only punctuation after the scheme, as in "https://.", is no address.
      return /^https?:\/\/$/.test(address) ? match : link(address, address) + match.slice(end);
    })
    .replace(/\n/g, "<br />");
}
