// The receptionist's chunking, copied from packages/domain/src/server/knowledge.ts.
// Everything from `export function chunkText` to its closing brace is byte for byte the
// repository's function, and `npm run check-copy` (and the tests) fail when they differ.

export function chunkText(text: string, options: { maxCharacters?: number; overlap?: number } = {}): string[] {
  const maxCharacters = options.maxCharacters ?? 1800;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 2 || (options.overlap ?? 180) < 0) throw new Error("Invalid chunk size or overlap.");
  const overlap = Math.min(options.overlap ?? 180, Math.floor(maxCharacters / 2));
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) {
    return [];
  }
  const chunks: string[] = [];
  // Keep Markdown sections separate, including headings in previously flattened imports.
  for (const section of normalized.split(/(?<=\s)(?=#{1,6} )/)) {
    const sectionText = section.trim();
    let start = 0;
    while (start < sectionText.length) {
      let end = Math.min(sectionText.length, start + maxCharacters);
      if (end < sectionText.length) {
        const boundary = sectionText.lastIndexOf("\n", end);
        const wordBoundary = sectionText.lastIndexOf(" ", end);
        if (boundary > start + maxCharacters / 2) end = boundary;
        else if (wordBoundary > start + maxCharacters / 2) end = wordBoundary;
      }
      const chunk = sectionText.slice(start, end).trim();
      if (chunk) {
        chunks.push(chunk);
      }
      if (end >= sectionText.length) {
        break;
      }
      start = Math.max(start + 1, end - overlap);
    }
  }
  return chunks;
}
