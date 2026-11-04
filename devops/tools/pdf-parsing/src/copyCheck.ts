import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** What the tool copies from the repository, so its baseline stays today's reader. */
export const copies = {
  reader: { repo: "apps/worker/src/documentExtraction.ts", tool: "src/parsers/current/documentExtraction.ts" },
  chunkText: { repo: "packages/domain/src/server/knowledge.ts", tool: "src/chunkText.ts" },
  libraries: ["pdf-parse", "pdfjs-dist", "tesseract.js", "mammoth"],
} as const;

/** The chunkText function's source, from its signature to its closing brace. */
export function chunkTextSource(file: string): string | undefined {
  const start = file.indexOf("export function chunkText(");
  if (start < 0) return undefined;
  const end = file.indexOf("\n}\n", start);
  return end < 0 ? undefined : file.slice(start, end + 3);
}

/** The versions pnpm-lock.yaml resolves for the worker's libraries. */
export function workerVersions(lockfile: string): Record<string, string> {
  const start = lockfile.indexOf("\n  apps/worker:\n");
  if (start < 0) return {};
  const next = lockfile.slice(start + 1).search(/\n {2}\S/u);
  const block = next < 0 ? lockfile.slice(start) : lockfile.slice(start, start + 1 + next);
  const lines = block.split("\n");
  const versions: Record<string, string> = {};
  for (const name of copies.libraries) {
    // Each dependency is its name, then its specifier and version lines.
    const at = lines.indexOf(`      ${name}:`);
    const version = at < 0 ? undefined : /^ {8}version: ([^\s(]+)/u.exec(lines[at + 2] ?? "")?.[1];
    if (version) versions[name] = version;
  }
  return versions;
}

/** A file as Git stores it, with LF line endings, even in a Windows checkout that has CRLF. */
export const readLf = async (file: string) => (await readFile(file, "utf8")).replace(/\r\n/gu, "\n");

export type CopyCheck = { repo: string; tool: string; fix: boolean; log(line: string): void };

/** Compares the copies with the repository's files; with fix, copies them again. Exits 1 when anything differs. */
export async function checkCopies(run: CopyCheck): Promise<number> {
  const read = (folder: string, file: string) => readLf(path.join(folder, file));
  let differs = 0;

  const repoReader = await read(run.repo, copies.reader.repo).catch(() => undefined);
  if (repoReader === undefined) {
    run.log(`There's no ${copies.reader.repo} under ${run.repo}: run this inside the lobbystack repository.`);
    return 1;
  }
  if (repoReader === (await read(run.tool, copies.reader.tool))) run.log(`Reader: ${copies.reader.tool} is byte for byte ${copies.reader.repo}.`);
  else if (run.fix) {
    await writeFile(path.join(run.tool, copies.reader.tool), repoReader);
    run.log(`Reader: copied ${copies.reader.repo} again.`);
  } else {
    differs += 1;
    run.log(`Reader: ${copies.reader.tool} differs from ${copies.reader.repo}. Run check-copy --fix to copy it again.`);
  }

  const repoChunk = chunkTextSource(await read(run.repo, copies.chunkText.repo));
  const toolFile = await read(run.tool, copies.chunkText.tool);
  const toolChunk = chunkTextSource(toolFile);
  if (!repoChunk) {
    differs += 1;
    run.log(`chunkText: there's no chunkText function in ${copies.chunkText.repo} any more.`);
  } else if (repoChunk === toolChunk) run.log(`chunkText: ${copies.chunkText.tool} holds the repository's function byte for byte.`);
  else if (run.fix && toolChunk) {
    await writeFile(path.join(run.tool, copies.chunkText.tool), toolFile.replace(toolChunk, () => repoChunk));
    run.log(`chunkText: copied the function from ${copies.chunkText.repo} again.`);
  } else {
    differs += 1;
    run.log(`chunkText: the copy differs from ${copies.chunkText.repo}.${toolChunk ? " Run check-copy --fix to copy it again." : ""}`);
  }

  const wanted = workerVersions(await read(run.repo, "pnpm-lock.yaml"));
  const declared = (JSON.parse(await read(run.tool, "package.json")) as { dependencies: Record<string, string> }).dependencies;
  for (const name of copies.libraries) {
    if (!wanted[name]) {
      differs += 1;
      run.log(`${name}: the worker's version isn't in pnpm-lock.yaml.`);
    } else if (declared[name] === wanted[name]) run.log(`${name}: ${wanted[name]}, as the worker's lockfile resolves it.`);
    else {
      differs += 1;
      run.log(`${name}: the tool pins ${declared[name] ?? "nothing"}, the worker runs ${wanted[name]}. Run npm install --save-exact ${name}@${wanted[name]}.`);
    }
  }
  return differs ? 1 : 0;
}
